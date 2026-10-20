/**
 * Account registry and pool.
 *
 * A "account" is one Puter identity — one token, optionally one egress route.
 * The pool is responsible for picking a healthy account per request, marking
 * failures, and backing off. It knows nothing about Express or HTTP.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { logger } from '../logger.js';
import { ApiError } from '../errors.js';

const COOLDOWN = {
    rateLimit: 60_000,
    quota: 15 * 60_000,
    server: 15_000,
    network: 30_000,
};

/** Short, stable, non-reversible identifier for a credential. */
const fingerprint = (token) =>
    createHash('sha256').update(String(token)).digest('hex').slice(0, 12);

/**
 * Normalise one raw manifest entry into an account record.
 * Accepts a bare token string for convenience.
 */
function normaliseAccount(raw, index, source, defaults = {}) {
    const entry = typeof raw === 'string' ? { token: raw } : raw;
    if (!entry || typeof entry !== 'object') {
        throw new Error(`Account #${index} in ${source} is not an object`);
    }

    // Tokens may be inlined or referenced by env var name, so a manifest can
    // live in a git repo without carrying live credentials.
    let token = entry.token;
    if (!token && entry.tokenEnv) {
        token = process.env[entry.tokenEnv];
        if (!token) {
            throw new Error(
                `Account #${index} references tokenEnv "${entry.tokenEnv}", which is not set`,
            );
        }
    }
    if (typeof token !== 'string' || !token.trim()) {
        throw new Error(`Account #${index} in ${source} has no usable token`);
    }

    const id = entry.id ? String(entry.id) : `acct-${fingerprint(token)}`;

    return {
        id,
        label: entry.label ? String(entry.label) : id,
        token: token.trim(),
        // An entry-level proxy wins; otherwise fall back to the global default
        // so `PUTER_PROXY=tor` routes every account without editing manifests.
        proxy: entry.proxy !== undefined ? entry.proxy : (defaults.proxy ?? null),
        apiOrigin: entry.apiOrigin ?? defaults.apiOrigin ?? null,
        normalize: entry.normalize ?? defaults.normalize,
        tags: Array.isArray(entry.tags) ? entry.tags.map(String) : [],
        enabled: entry.enabled !== false,
        source,
        // Mutable runtime state lives alongside, never persisted.
        state: {
            status: 'unknown',
            inFlight: 0,
            successes: 0,
            failures: 0,
            consecutiveFailures: 0,
            cooldownUntil: 0,
            lastUsed: 0,
            lastError: null,
            lastChecked: null,
        },
    };
}

/** Read a manifest from disk. Accepts `{accounts:[...]}`, `[...]`, or `{token: ...}`. */
async function readManifestFile(path) {
    const text = await readFile(path, 'utf8');
    return parseManifest(text, path);
}

function parseManifest(text, source) {
    let parsed;
    try {
        parsed = JSON.parse(text);
    } catch (err) {
        throw new Error(`Manifest ${source} is not valid JSON: ${err.message}`);
    }

    if (Array.isArray(parsed)) return parsed;
    if (Array.isArray(parsed?.accounts)) return parsed.accounts;
    if (parsed?.token) return [parsed];
    throw new Error(`Manifest ${source} has no "accounts" array`);
}

/**
 * Parse a repo spec: `owner/repo`, `owner/repo@ref`, `owner/repo@ref:path`,
 * or a full https://github.com/... URL.
 */
function parseRepoSpec(spec) {
    let s = spec.trim();
    if (!s) return null;

    const urlMatch = s.match(
        /^https?:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?(?:\/(?:blob|raw)\/([^/]+)\/(.+))?$/,
    );
    if (urlMatch) {
        const [, owner, repo, ref, path] = urlMatch;
        return {
            owner,
            repo,
            ref: ref || 'HEAD',
            path: path || 'accounts.json',
            raw: spec,
        };
    }

    let path = 'accounts.json';
    let ref = null;

    const colon = s.lastIndexOf(':');
    // Only treat a trailing ":path" as a path when it looks like one; a bare
    // "owner/repo@main" has no path segment.
    if (colon > s.indexOf('@') && colon !== -1 && !s.slice(colon + 1).includes('@')) {
        path = s.slice(colon + 1);
        s = s.slice(0, colon);
    }

    const at = s.indexOf('@');
    if (at !== -1) {
        ref = s.slice(at + 1);
        s = s.slice(0, at);
    }

    const [owner, repo] = s.split('/');
    if (!owner || !repo) {
        throw new Error(
            `Invalid ACCOUNT_MANIFEST_REPO entry "${spec}". Use owner/repo, owner/repo@ref, or owner/repo@ref:path`,
        );
    }
    return { owner, repo, ref, path, raw: spec };
}

/**
 * Fetch a manifest from a GitHub repository.
 *
 * Uses the contents API so private repositories work with a token, and falls
 * back to raw.githubusercontent.com (no auth) for public repos.
 */
async function fetchRepoManifest(spec, { token, timeoutMs = 10_000 } = {}) {
    const { owner, repo, ref, path, raw } = spec;

    const headers = {
        accept: 'application/vnd.github.raw+json',
        'user-agent': 'puter-proxy/1.0',
    };
    if (token) headers.authorization = `Bearer ${token}`;

    const query = ref ? `?ref=${encodeURIComponent(ref)}` : '';
    const apiUrl = `https://api.github.com/repos/${owner}/${repo}/contents/${path}${query}`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        let resp = await fetch(apiUrl, { headers, signal: controller.signal });
        let text;

        if (resp.ok) {
            text = await resp.text();
        } else if (!token && (resp.status === 404 || resp.status === 403)) {
            // Public fallback: raw host avoids anonymous rate limits on the API.
            const rawRef = ref || 'HEAD';
            const rawUrl = `https://raw.githubusercontent.com/${owner}/${repo}/${rawRef}/${path}`;
            resp = await fetch(rawUrl, {
                headers: { 'user-agent': 'puter-proxy/1.0' },
                signal: controller.signal,
            });
            if (!resp.ok) {
                throw new Error(`HTTP ${resp.status} fetching ${rawUrl}`);
            }
            text = await resp.text();
        } else {
            const body = (await resp.text()).slice(0, 200);
            throw new Error(`HTTP ${resp.status} fetching ${apiUrl}: ${body}`);
        }

        return parseManifest(text, `github:${raw}`);
    } catch (err) {
        if (err.name === 'AbortError') {
            throw new Error(`Timed out fetching ${raw}`);
        }
        throw err;
    } finally {
        clearTimeout(timer);
    }
}

export class AccountRegistry {
    /**
     * @param {ReturnType<import('../config.js').loadConfig>} config
     */
    constructor(config) {
        this.config = config;
        this.accounts = [];
        this.byId = new Map();
        this.cursor = 0;
        this.loadedAt = 0;
        this.sources = [];
    }

    async load() {
        /** @type {Map<string, any>} */
        const collected = new Map();
        const sources = [];
        const errors = [];

        const addAll = (list, source) => {
            list.forEach((raw, i) => {
                try {
                    const acct = normaliseAccount(raw, i, source, {
                        apiOrigin: this.config.puterApiOrigin,
                        normalize: this.config.puter.normalize,
                        proxy: this.config.accounts.proxy,
                    });
                    if (collected.has(acct.id)) {
                        // Later sources win, so an operator can override a
                        // repo-provided account locally.
                        logger.warn('duplicate account id, overriding', {
                            id: acct.id,
                            source,
                        });
                        collected.delete(acct.id);
                    }
                    collected.set(acct.id, acct);
                } catch (err) {
                    errors.push(err.message);
                    logger.warn('skipping invalid account', {
                        source,
                        index: i,
                        error: err.message,
                    });
                }
            });
        };

        // 1. Single-account fallback from the original spec.
        if (this.config.puterAuthToken) {
            addAll(
                [{ id: 'primary', token: this.config.puterAuthToken, label: 'PUTER_AUTH_TOKEN' }],
                'env:PUTER_AUTH_TOKEN',
            );
            sources.push('env:PUTER_AUTH_TOKEN');
        }

        // 2. Inline JSON in env (handy for containers).
        if (this.config.accounts.inline) {
            try {
                addAll(parseManifest(this.config.accounts.inline, 'PUTER_ACCOUNTS'), 'env:PUTER_ACCOUNTS');
                sources.push('env:PUTER_ACCOUNTS');
            } catch (err) {
                errors.push(err.message);
                logger.error('could not parse PUTER_ACCOUNTS', { error: err.message });
            }
        }

        // 3. Local manifest file.
        if (this.config.accounts.fileExists) {
            try {
                const list = await readManifestFile(this.config.accounts.file);
                addAll(list, `file:${this.config.accounts.file}`);
                sources.push(`file:${this.config.accounts.file}`);
            } catch (err) {
                errors.push(err.message);
                logger.error('could not read accounts file', {
                    file: this.config.accounts.file,
                    error: err.message,
                });
            }
        }

        // 4. One or more GitHub repositories.
        const repoSepcs = String(this.config.accounts.repo ?? '')
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean);

        for (const spec of repoSepcs) {
            try {
                const parsed = parseRepoSpec(spec);
                if (!parsed) continue;
                if (!this.config.accounts.repoPath) parsed.path = parsed.path || 'accounts.json';
                const list = await fetchRepoManifest(parsed, {
                    token: this.config.accounts.repoToken,
                });
                addAll(list, `repo:${parsed.raw}`);
                sources.push(`repo:${parsed.raw}`);
            } catch (err) {
                errors.push(err.message);
                logger.error('could not load account manifest from repo', {
                    spec,
                    error: err.message,
                });
            }
        }

        this.accounts = [...collected.values()];
        this.byId = new Map(this.accounts.map((a) => [a.id, a]));
        this.loadedAt = Date.now();
        this.sources = sources;

        logger.info('account registry loaded', {
            accounts: this.accounts.length,
            sources,
            errors: errors.length || undefined,
        });

        return { accounts: this.accounts.length, sources, errors };
    }

    get size() {
        return this.accounts.length;
    }

    /** Public, secret-free view of the pool. */
    describe() {
        return this.accounts.map((a) => ({
            id: a.id,
            label: a.label,
            enabled: a.enabled,
            proxy: a.proxy ?? 'direct',
            tags: a.tags,
            source: a.source,
            // A truncated hash identifies which credential is loaded without
            // revealing any of it — and stays stable across restarts, unlike a
            // mask of the raw bytes.
            token_fingerprint: fingerprint(a.token),
            status: a.state.status,
            in_flight: a.state.inFlight,
            successes: a.state.successes,
            failures: a.state.failures,
            cooldown_until: a.state.cooldownUntil
                ? new Date(a.state.cooldownUntil).toISOString()
                : null,
            last_used: a.state.lastUsed
                ? new Date(a.state.lastUsed).toISOString()
                : null,
            last_error: a.state.lastError,
        }));
    }

    isUsable(account, now = Date.now()) {
        return account.enabled && account.state.status !== 'dead' && account.state.cooldownUntil <= now;
    }

    /**
     * Pick the best available account.
     *
     * Least-in-flight first (so a slow request doesn't starve fast ones), then
     * weighted round-robin to spread load. `exclude` prevents retrying the
     * same account within one request.
     *
     * @param {{ exclude?: Set<string>, requireTags?: string[] }} [opts]
     */
    pick({ exclude = new Set(), requireTags = [] } = {}) {
        const now = Date.now();
        const candidates = this.accounts.filter(
            (a) =>
                !exclude.has(a.id) &&
                this.isUsable(a, now) &&
                requireTags.every((t) => a.tags.includes(t)),
        );

        if (candidates.length === 0) {
            const cooling = this.accounts.filter((a) => a.state.cooldownUntil > now);
            return {
                account: null,
                reason: this.accounts.length === 0 ? 'no_accounts' : cooling.length ? 'all_cooling_down' : 'all_excluded',
                retryAfter: cooling.length
                    ? Math.ceil(
                        Math.min(...cooling.map((a) => a.state.cooldownUntil - now)) / 1000,
                    )
                    : undefined,
            };
        }

        candidates.sort((a, b) => {
            if (a.state.inFlight !== b.state.inFlight) {
                return a.state.inFlight - b.state.inFlight;
            }
            return a.state.lastUsed - b.state.lastUsed;
        });

        const best = candidates[0];
        // Round-robin the start position among equally-idle accounts so a
        // single hot account isn't always chosen.
        const idle = candidates.filter((c) => c.state.inFlight === best.state.inFlight);
        if (idle.length > 1) {
            this.cursor = (this.cursor + 1) % idle.length;
            return { account: idle[this.cursor] };
        }
        return { account: best };
    }

    begin(account) {
        account.state.inFlight += 1;
        account.state.lastUsed = Date.now();
        account.state.status = 'ok';
    }

    end(account) {
        account.state.inFlight = Math.max(0, account.state.inFlight - 1);
    }

    reportSuccess(account) {
        account.state.successes += 1;
        account.state.consecutiveFailures = 0;
        account.state.status = 'ok';
        account.state.lastError = null;
        account.state.lastChecked = Date.now();
    }

    /**
     * Record a failure and apply the right backoff.
     * `kind` comes from the translated ApiError code.
     */
    reportFailure(account, kind, error, retryAfterSeconds) {
        account.state.failures += 1;
        account.state.consecutiveFailures += 1;
        account.state.lastError = error?.message ?? String(error);
        account.state.lastChecked = Date.now();

        const now = Date.now();
        const cooldown = (ms) => {
            account.state.cooldownUntil = now + ms;
            account.state.status = 'cooldown';
        };

        switch (kind) {
            case 'upstream_unauthorized':
            case 'upstream_forbidden':
                // A bad credential will not fix itself. Park the account until
                // an operator rotates the token (or the registry reloads).
                account.state.status = 'dead';
                logger.error('account marked dead', {
                    account: account.id,
                    error: account.state.lastError,
                });
                return;

            case 'upstream_rate_limited': {
                const fromHeader = retryAfterSeconds
                    ? retryAfterSeconds * 1000
                    : COOLDOWN.rateLimit;
                cooldown(Math.min(fromHeader, 30 * 60_000));
                return;
            }

            case 'upstream_quota_exhausted':
                cooldown(COOLDOWN.quota);
                return;

            case 'upstream_unreachable':
                cooldown(COOLDOWN.network);
                return;

            case 'upstream_timeout':
                cooldown(COOLDOWN.server);
                return;

            default:
                // Exponential backoff for everything else, capped at 2 minutes.
                cooldown(
                    Math.min(COOLDOWN.server * 2 ** (account.state.consecutiveFailures - 1), 120_000),
                );
        }
    }

    /** Manual reset, e.g. after rotating a token. */
    revive(accountId) {
        const a = this.byId.get(accountId);
        if (!a) return false;
        a.state.status = 'ok';
        a.state.cooldownUntil = 0;
        a.state.consecutiveFailures = 0;
        a.state.lastError = null;
        return true;
    }

    /** Persist a new account into the local manifest file. */
    async addAccount({ token, id, proxy, tags, label }, { persist = true } = {}) {
        const acct = normaliseAccount(
            { token, id, proxy, tags, label },
            this.accounts.length,
            'runtime',
        );
        if (this.byId.has(acct.id)) {
            throw new ApiError(409, 'account_exists', `Account "${acct.id}" already exists`);
        }
        this.accounts.push(acct);
        this.byId.set(acct.id, acct);

        if (persist) await this.persist(acct);
        return acct;
    }

    async removeAccount(accountId) {
        const acct = this.byId.get(accountId);
        if (!acct) {
            throw new ApiError(404, 'account_not_found', `No account "${accountId}"`);
        }
        this.accounts = this.accounts.filter((a) => a.id !== accountId);
        this.byId.delete(accountId);
        await this.persist();
        return acct;
    }

    /**
     * Write accounts whose source is the local file back to it.
     * Repo-sourced and env-sourced accounts are read-only and never written.
     */
    async persist() {
        const file = this.config.accounts.file;
        const managed = this.accounts.filter((a) => a.source.startsWith('file:') || a.source === 'runtime');
        const payload = {
            version: 1,
            updated_at: new Date().toISOString(),
            accounts: managed.map((a) => ({
                id: a.id,
                label: a.label,
                token: a.token,
                proxy: a.proxy ?? undefined,
                tags: a.tags.length ? a.tags : undefined,
                enabled: a.enabled ? undefined : false,
            })),
        };

        await mkdir(dirname(resolve(file)), { recursive: true });
        await writeFile(file, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
        logger.info('account manifest written', { file, accounts: managed.length });
        return file;
    }

    /** Probe every account's credential. Read-only and cheap. */
    async checkAll(probe) {
        const results = await Promise.all(
            this.accounts.map(async (a) => {
                try {
                    const info = await probe(a);
                    this.reportSuccess(a);
                    a.state.lastChecked = Date.now();
                    return { id: a.id, ok: true, user: info };
                } catch (err) {
                    const code = err?.code ?? 'upstream_error';
                    this.reportFailure(a, code, err, err?.details?.retry_after);
                    return { id: a.id, ok: false, error: err?.message ?? String(err), code };
                }
            }),
        );
        return results;
    }
}
