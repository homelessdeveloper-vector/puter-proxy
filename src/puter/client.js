/**
 * Per-account Puter SDK clients.
 *
 * Why a factory instead of one global `puter`: the SDK resolves Puter's
 * user-scoped resources (KV, filesystem, usage limits) from the auth token on
 * each instance. One shared instance can only ever represent one identity.
 *
 * The SDK's Node bootstrap (`src/init.cjs`) builds a `vm` context by copying
 * `globalThis` and evaluating the browser bundle inside it. Because that copy
 * happens synchronously during `init()`, we can swap `globalThis.fetch` for a
 * per-account fetch — one that attaches that account's proxy dispatcher —
 * and restore it before returning. No `await` occurs inside the swap, so no
 * other request can observe the temporary global.
 *
 * The result: each instance permanently keeps its own captured fetch, and
 * therefore its own egress route (direct, HTTP proxy, or SOCKS5/Tor).
 */

import { createRequire } from 'node:module';
import { AsyncLocalStorage } from 'node:async_hooks';
import { ProxyAgent } from 'undici';
import { logger, maskToken } from '../logger.js';

const require = createRequire(import.meta.url);
const { init: initPuter } = require('@heyputer/puter.js/src/init.cjs');

/**
 * Carries the last upstream HTTP status into the operation's async context.
 *
 * The SDK collapses every failure into the response *body* and discards the
 * status code — a 429 arrives as `{success:false, message:'Rate limit
 * exceeded'}`. We can't classify limits vs. auth failures from that alone, so
 * the fetch wrapper records the status here and the router reads it.
 *
 * AsyncLocalStorage propagates through the SDK's promise chains even though
 * they run inside a `vm` context, so this stays correct under concurrency.
 */
export const upstreamStatus = new AsyncLocalStorage();

/** Last observed status for the current request context. */
export const lastStatus = () => upstreamStatus.getStore()?.status;

/** @type {Map<string, ReturnType<typeof buildClient>>} */
const cache = new Map();

/**
 * Cache key must cover everything the instance captures at construction:
 * the credential, the egress route, and the API origin. Keying on `id` alone
 * would silently serve a client still pointing at a previous origin.
 */
const cacheKey = (account) =>
    [
        account.id,
        account.token,
        account.proxy ?? 'direct',
        account.apiOrigin ?? 'default',
        account.normalize === false ? 'raw' : 'norm',
    ].join('\u0000');

export const normalizeProxyUrl = (raw) => {
    if (!raw) return null;
    let url = String(raw).trim();
    // Accept the shorthand people actually type: "tor", "9050", "127.0.0.1:9050".
    if (url === 'tor') return 'socks5h://127.0.0.1:9050';
    if (/^\d+$/.test(url)) return `socks5h://127.0.0.1:${url}`;
    if (/^[\w.-]+:\d+$/.test(url)) return `socks5h://${url}`;
    if (!/^[a-z0-9+]+:\/\//i.test(url)) return `socks5h://${url}`;
    if (url.startsWith('socks5h://')) return url;
    return url;
};

/**
 * `socks5h` means "resolve DNS at the proxy". undici's ProxyAgent only
 * understands `socks5://`, so map the scheme across; undici's SOCKS5
 * implementation already forwards the hostname rather than resolving locally.
 */
export const toDispatcherUrl = (url) => url.replace(/^socks5h:\/\//i, 'socks5://');

/**
 * Build a fetch implementation bound to an optional proxy.
 *
 * Every response is inspected before it is returned, in both modes: we record
 * the status for error classification and, by default, suppress the SDK's own
 * retry loop. The SDK replays a 429 up to nine times over roughly 14 seconds,
 * which would silently defeat account failover — one rate-limited account
 * would hold the request instead of letting the pool move on. Retries are the
 * pool's job here, so the first answer is the real one.
 *
 * Passing the response through untouched (rather than cloning or rebuilding
 * it) preserves streaming, `arrayBuffer()`, and blob semantics exactly.
 *
 * @param {string | null} proxyUrl
 * @param {{ disableSdkRetry: boolean }} opts
 */
function buildFetch(proxyUrl, { disableSdkRetry }) {
    const base = globalThis.fetch;

    let dispatcher;
    if (proxyUrl) {
        try {
            dispatcher = new ProxyAgent(toDispatcherUrl(proxyUrl));
        } catch (err) {
            throw new Error(
                `Invalid proxy "${proxyUrl}": ${err instanceof Error ? err.message : String(err)}`,
            );
        }
    }

    const wrapped = async (input, init = {}) => {
        const options = dispatcher ? { ...init, dispatcher } : init;
        const resp = await base(input, options);

        const store = upstreamStatus.getStore();
        if (store) {
            store.status = resp.status;
            const retryAfter = resp.headers.get('retry-after');
            if (retryAfter) store.retryAfter = retryAfter;
        }

        if (disableSdkRetry && resp.status === 429) {
            // Returning 429 would make the SDK replay this up to nine more
            // times. Mask it as a terminal 4xx *after* recording the real
            // status, so the pool — not the SDK — decides whether to retry.
            const body = await resp.text();
            let parsed;
            try {
                parsed = JSON.parse(body);
            } catch {
                parsed = { message: body || 'Rate limit exceeded' };
            }
            return new Response(
                JSON.stringify({
                    success: false,
                    code: parsed?.code ?? 'rate_limited',
                    message: parsed?.message ?? 'Rate limit exceeded',
                    retry_after: store?.retryAfter ? Number(store.retryAfter) : undefined,
                }),
                { status: 400, headers: { 'content-type': 'application/json' } },
            );
        }

        return resp;
    };

    if (proxyUrl) wrapped.__proxy = proxyUrl;
    return wrapped;
}

/**
 * Create (or reuse) an SDK instance for one account.
 *
 * @param {{ id: string, token: string, proxy?: string|null, apiOrigin?: string|null }} account
 * @returns {{ id: string, puter: any, proxy: string|null, createdAt: number, lastUsed: number }}
 */
export function getClient(account) {
    const key = cacheKey(account);
    const existing = cache.get(key);
    if (existing) {
        existing.lastUsed = Date.now();
        return existing;
    }

    // Drop any instance previously built for this account id under a different
    // token, proxy, or origin so we don't accumulate dead clients.
    for (const [k, v] of cache) {
        if (v.id === account.id) cache.delete(k);
    }

    const proxy = normalizeProxyUrl(account.proxy);
    const proxiedFetch = buildFetch(proxy, { disableSdkRetry: true });

    // The SDK treats every instance as a browser page and opens a persistent
    // socket.io connection (plus a `/rao` "app open" beacon) as soon as it has
    // a token. For a server that is pure waste: it holds a socket open per
    // account, keeps the process alive after shutdown, and phones home on
    // every credential. The SDK honours this flag to opt out.
    //
    // Set synchronously around `init()` — the same window the fetch swap uses
    // — so no concurrent request can observe the temporary global.
    const previousFetch = globalThis.fetch;
    const previousSocketFlag = globalThis.puter_socket_enabled;
    let puter;
    try {
        globalThis.fetch = proxiedFetch;
        globalThis.puter_socket_enabled = false;
        puter = initPuter(account.token);
    } finally {
        globalThis.fetch = previousFetch;
        globalThis.puter_socket_enabled = previousSocketFlag;
    }

    if (account.apiOrigin) {
        puter.setAPIOrigin(account.apiOrigin);
    }

    // The SDK leaves `normalize` unset, which makes the response shape depend
    // on the model's release date. A stable API needs one shape, so force the
    // OpenAI-style envelope unless the operator opts out.
    if (typeof puter.ai === 'object' && puter.ai) {
        puter.ai.normalize = account.normalize === false ? undefined : true;
    }

    const client = {
        id: account.id,
        puter,
        proxy,
        tokenFingerprint: account.token,
        createdAt: Date.now(),
        lastUsed: Date.now(),
    };

    cache.set(key, client);
    logger.debug('puter client initialised', {
        account: account.id,
        token: maskToken(account.token),
        proxy: proxy ?? 'direct',
    });

    return client;
}

/** Drop cached instances for an account id, e.g. after a credential failure. */
export function evictClient(accountId) {
    let removed = 0;
    for (const [k, v] of cache) {
        if (v.id === accountId) {
            cache.delete(k);
            removed += 1;
        }
    }
    return removed > 0;
}

/** Drop everything (used by account reloads). */
export function evictAll() {
    cache.clear();
}

export const clientCount = () => cache.size;
