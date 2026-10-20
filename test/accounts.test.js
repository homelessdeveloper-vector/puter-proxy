/**
 * Tests for the parts most likely to break quietly: per-account isolation,
 * manifest parsing, and pool selection.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createMockPuter } from './mock-puter.js';
import { loadConfig, digestKey } from '../src/config.js';
import { AccountRegistry } from '../src/accounts/registry.js';
import { createApp } from '../src/app.js';
import { maskToken } from '../src/logger.js';
import { normalizeProxyUrl, toDispatcherUrl, buildFetch } from '../src/puter/client.js';

const KEY = 'k'.repeat(40);

async function boot(accounts, env = {}) {
    const mock = createMockPuter();
    const origin = await mock.listen();
    const config = loadConfig({
        NODE_ENV: 'test',
        API_KEYS: `test:${KEY}`,
        PUTER_API_ORIGIN: origin,
        PUTER_ACCOUNTS: JSON.stringify(accounts),
        LOG_LEVEL: 'error',
        ...env,
    });
    const registry = new AccountRegistry(config);
    await registry.load();
    const app = createApp({ config, registry });
    const server = app.listen(0, '127.0.0.1');
    await new Promise((r) => server.once('listening', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    return {
        base,
        mock,
        registry,
        config,
        close: async () => {
            await new Promise((r) => server.close(r));
            await mock.close();
        },
    };
}

test('concurrent requests keep their accounts isolated', async () => {
    // The SDK swaps a global during init(). If that window leaked across
    // requests, tokens would cross over between accounts.
    const h = await boot(
        [
            { id: 'one', token: 'tok-ok-1' },
            { id: 'two', token: 'tok-ok-2' },
        ],
        // The default burst would throttle 40 concurrent calls before they
        // ever reach the code under test.
        { RATE_LIMIT_PER_MINUTE: '10000', RATE_LIMIT_BURST: '100' },
    );
    try {
        const calls = Array.from({ length: 40 }, (_, i) =>
            fetch(`${h.base}/v1/execute`, {
                method: 'POST',
                headers: { 'content-type': 'application/json', 'x-api-key': KEY },
                body: JSON.stringify({
                    operation: 'chat',
                    input: { messages: `req-${i}` },
                }),
            }).then((r) => r.json()),
        );

        const results = await Promise.all(calls);
        for (const body of results) {
            assert.equal(body.ok, true);

            // The mock echoes the authenticated user, so a crossed token
            // would show up as a mismatched user/account pairing.
            const expectedUser = body.account.id === 'one' ? 'ashton' : 'ashton-2';
            assert.match(
                body.data.content,
                new RegExp(`Echo from ${expectedUser}:`),
                `account ${body.account.id} used the wrong token`,
            );
        }

        // Both accounts should have served traffic.
        const ids = new Set(results.map((r) => r.account.id));
        assert.equal(ids.size, 2, 'load should spread across both accounts');
    } finally {
        await h.close();
    }
});

test('a pinned account is honoured for an admin key', async () => {
    const mock = createMockPuter();
    const origin = await mock.listen();
    const config = loadConfig({
        NODE_ENV: 'test',
        API_KEYS: `admin:${KEY}`,
        PUTER_API_ORIGIN: origin,
        PUTER_ACCOUNTS: JSON.stringify([
            { id: 'one', token: 'tok-ok-1' },
            { id: 'two', token: 'tok-ok-2' },
        ]),
        LOG_LEVEL: 'error',
    });
    config.apiKeys = config.apiKeys.map((k) => ({ ...k, scopes: ['execute', 'admin'] }));
    const registry = new AccountRegistry(config);
    await registry.load();
    const app = createApp({ config, registry });
    const server = app.listen(0, '127.0.0.1');
    await new Promise((r) => server.once('listening', r));
    const base = `http://127.0.0.1:${server.address().port}`;

    try {
        const res = await fetch(`${base}/v1/execute`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-api-key': KEY },
            body: JSON.stringify({
                operation: 'chat',
                account: 'two',
                input: { messages: 'pinned' },
            }),
        });
        const body = await res.json();
        assert.equal(body.account.id, 'two');
        assert.match(body.data.content, /ashton-2/);
    } finally {
        await new Promise((r) => server.close(r));
        await mock.close();
    }
});

test('the pool prefers the least busy account', async () => {
    const h = await boot([
        { id: 'busy', token: 'tok-ok-1' },
        { id: 'idle', token: 'tok-ok-2' },
    ]);
    try {
        h.registry.byId.get('busy').state.inFlight = 5;
        const picked = h.registry.pick();
        assert.equal(picked.account.id, 'idle');
    } finally {
        await h.close();
    }
});

test('a cooling-down account is skipped', async () => {
    const h = await boot([
        { id: 'hot', token: 'tok-ok-1' },
        { id: 'cold', token: 'tok-ok-2' },
    ]);
    try {
        const hot = h.registry.byId.get('hot');
        hot.state.cooldownUntil = Date.now() + 60_000;
        hot.state.status = 'cooldown';

        const picked = h.registry.pick();
        assert.equal(picked.account.id, 'cold');
    } finally {
        await h.close();
    }
});

test('when every account is cooling down, pick explains and gives a delay', async () => {
    const h = await boot([{ id: 'only', token: 'tok-ok-1' }]);
    try {
        const a = h.registry.byId.get('only');
        a.state.cooldownUntil = Date.now() + 30_000;
        a.state.status = 'cooldown';

        const picked = h.registry.pick();
        assert.equal(picked.account, null);
        assert.equal(picked.reason, 'all_cooling_down');
        assert.ok(picked.retryAfter > 0);
    } finally {
        await h.close();
    }
});

test('a bad request does not damage account health', async () => {
    // Reproduces a real bug: validation failures were reported as upstream
    // faults, so any caller could cool down the whole pool for free.
    const h = await boot([{ id: 'ok', token: 'tok-ok-1' }]);
    try {
        for (let i = 0; i < 5; i += 1) {
            const res = await fetch(`${h.base}/v1/execute`, {
                method: 'POST',
                headers: { 'content-type': 'application/json', 'x-api-key': KEY },
                body: JSON.stringify({ operation: 'image', input: { prompt: '' } }),
            });
            assert.equal(res.status, 400);
        }

        const acct = h.registry.byId.get('ok');
        assert.equal(acct.state.failures, 0, 'validation errors must not count as failures');
        assert.equal(acct.state.cooldownUntil, 0);

        // The account must still be usable.
        const ok = await fetch(`${h.base}/v1/execute`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-api-key': KEY },
            body: JSON.stringify({ operation: 'chat', input: { messages: 'still alive' } }),
        });
        assert.equal(ok.status, 200);
    } finally {
        await h.close();
    }
});

test('rate limits surface immediately instead of being retried by the SDK', async () => {
    // The SDK replays a 429 up to nine times over ~14s. That would defeat
    // failover and make a rate-limited account look like a hang.
    const h = await boot([{ id: 'rl', token: 'tok-limited' }]);
    try {
        const started = Date.now();
        const res = await fetch(`${h.base}/v1/execute`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-api-key': KEY },
            body: JSON.stringify({ operation: 'chat', input: { messages: 'hi' } }),
        });
        const elapsed = Date.now() - started;

        assert.equal(res.status, 429);
        assert.ok(elapsed < 2000, `took ${elapsed}ms; the SDK retry loop is still active`);
        assert.equal(h.mock.recorded.length, 1, 'upstream should be called exactly once');
    } finally {
        await h.close();
    }
});

test('manifest: tokenEnv indirection resolves from the environment', async () => {
    const config = loadConfig({
        NODE_ENV: 'test',
        API_KEYS: `test:${KEY}`,
        PUTER_ACCOUNTS: JSON.stringify([{ id: 'via-env', tokenEnv: 'MY_PUTER_TOKEN' }]),
        LOG_LEVEL: 'error',
    });
    process.env.MY_PUTER_TOKEN = 'tok-ok-1';
    try {
        const registry = new AccountRegistry(config);
        await registry.load();
        assert.equal(registry.size, 1);
        assert.equal(registry.byId.get('via-env').token, 'tok-ok-1');
    } finally {
        delete process.env.MY_PUTER_TOKEN;
    }
});

test('manifest: an unresolvable tokenEnv is skipped, not fatal', async () => {
    const config = loadConfig({
        NODE_ENV: 'test',
        API_KEYS: `test:${KEY}`,
        PUTER_ACCOUNTS: JSON.stringify([
            { id: 'broken', tokenEnv: 'DEFINITELY_NOT_SET' },
            { id: 'fine', token: 'tok-ok-1' },
        ]),
        LOG_LEVEL: 'error',
    });
    const registry = new AccountRegistry(config);
    await registry.load();
    assert.equal(registry.size, 1);
    assert.ok(registry.byId.has('fine'));
});

test('PROXY shorthand expands to a SOCKS5 Tor endpoint', async () => {
    const h = await boot([
        { id: 'tor', token: 'tok-ok-1', proxy: 'tor' },
        { id: 'bare', token: 'tok-ok-2', proxy: '127.0.0.1:9050' },
    ]);
    try {
        const { getClient } = await import('../src/puter/client.js');
        assert.equal(getClient(h.registry.byId.get('tor')).proxy, 'socks5h://127.0.0.1:9050');
        assert.equal(getClient(h.registry.byId.get('bare')).proxy, 'socks5h://127.0.0.1:9050');
    } finally {
        await h.close();
    }
});

test('an unreachable proxy fails the account without crashing the server', async () => {
    const h = await boot([
        { id: 'proxied', token: 'tok-ok-1', proxy: 'socks5://127.0.0.1:1' },
        { id: 'direct', token: 'tok-ok-2' },
    ]);
    try {
        // The pool prefers the least busy account, so park the direct one to
        // force the request onto the broken proxy first.
        h.registry.byId.get('direct').state.inFlight = 1;

        const res = await fetch(`${h.base}/v1/execute`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-api-key': KEY },
            body: JSON.stringify({ operation: 'chat', input: { messages: 'x' } }),
        });

        // Failover should land the request on the working account.
        assert.equal(res.status, 200);
        const body = await res.json();
        assert.equal(body.account.id, 'direct');

        const proxied = h.registry.byId.get('proxied');
        assert.ok(proxied.state.failures >= 1, 'the failed proxy attempt must be recorded');
        assert.ok(proxied.state.cooldownUntil > Date.now(), 'it should be cooling down');

        // The server must still be healthy after the transport failure.
        const health = await fetch(`${h.base}/health`);
        assert.equal(health.status, 200);
    } finally {
        await h.close();
    }
});

test('token masking never reveals the middle of a secret', () => {
    const token = 'eyJhbGciOiJIUzI1NiJ9.payload.signature';
    const masked = maskToken(token);
    assert.ok(masked.startsWith('eyJh'));
    assert.ok(masked.endsWith('ture'));
    assert.ok(!masked.includes('payload'));
    assert.equal(maskToken('short'), '***');
    assert.equal(maskToken(null), null);
});

// --- API key parsing -------------------------------------------------------
// These guard two footguns that silently produced a 401 for a correct key.

const keyConfig = (raw) =>
    loadConfig({ NODE_ENV: 'test', API_KEYS: raw, PUTER_AUTH_TOKEN: 'tok' });

test('a comma inside a scope list would split one key into two', () => {
    // The scope separator is "+", precisely because "," already delimits keys.
    // If this regressed, "admin" would become a key whose secret is "admin".
    const { apiKeys } = keyConfig('ops:secret1|execute+admin,ro:secret2');
    assert.equal(apiKeys.length, 2);
    assert.deepEqual(apiKeys[0].scopes, ['execute', 'admin']);
    assert.deepEqual(apiKeys[1].scopes, ['execute']);
    assert.deepEqual(
        apiKeys.map((k) => k.name),
        ['ops', 'ro'],
    );
});

test('keys default to execute only, so admin needs an explicit opt-in', () => {
    const { apiKeys } = keyConfig('plain:secret');
    assert.deepEqual(apiKeys[0].scopes, ['execute']);
});

test('an unknown scope is a boot-time error, not a silent downgrade', () => {
    assert.throws(() => keyConfig('k:secret|superuser'), /unknown scope/i);
});

test('a malformed sha256 digest is rejected at boot', () => {
    assert.throws(() => keyConfig('k:sha256:nothex'), /malformed digest/i);
    assert.throws(() => keyConfig(`k:sha256:${'a'.repeat(63)}`), /malformed digest/i);
});

test('a raw key that looks like a digest is still treated as raw', () => {
    // openssl rand -hex 32 and a sha256 digest are both 64 hex chars, so the
    // two are indistinguishable without the prefix. The raw interpretation
    // must win; the client sends the hex string itself.
    const hex = 'a'.repeat(64);
    const { apiKeys } = keyConfig(`k:${hex}`);
    assert.equal(apiKeys[0].mode, 'raw');
    assert.equal(apiKeys[0].digest.toString('hex'), digestKey(hex).toString('hex'));
});

test('the sha256: prefix stores the digest of the key, not the key itself', () => {
    const raw = 'my-secret-key';
    const hex = digestKey(raw).toString('hex');
    const { apiKeys } = keyConfig(`k:sha256:${hex}`);
    assert.equal(apiKeys[0].mode, 'sha256');
    assert.equal(apiKeys[0].digest.toString('hex'), hex);
});

// --- GitHub manifest loading ----------------------------------------------
// Stubs global fetch so the API path, the public raw fallback, and multi-repo
// composition are all exercised without network access.

const withStubbedFetch = async (handler, fn) => {
    const original = globalThis.fetch;
    globalThis.fetch = handler;
    try {
        return await fn();
    } finally {
        globalThis.fetch = original;
    }
};

const jsonResponse = (body, status = 200) =>
    new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
    });

test('accounts load from a GitHub repo via the contents API', async () => {
    const seen = [];
    const manifest = { accounts: [{ id: 'gh-1', token: 'tok-ok-1' }] };

    await withStubbedFetch(
        async (url) => {
            seen.push(String(url));
            return jsonResponse(manifest);
        },
        async () => {
            const config = loadConfig({
                NODE_ENV: 'test',
                API_KEYS: 't:k',
                ACCOUNT_MANIFEST_REPO: 'owner/repo@main',
            });
            const registry = new AccountRegistry(config);
            const summary = await registry.load();

            assert.equal(summary.errors.length, 0);
            assert.equal(registry.size, 1);
            assert.deepEqual(summary.sources, ['repo:owner/repo@main']);
            assert.ok(seen[0].includes('/repos/owner/repo/contents/accounts.json'));
            assert.ok(seen[0].includes('ref=main'));
        },
    );
});

test('a 404 on the API falls back to raw.githubusercontent.com', async () => {
    const seen = [];

    await withStubbedFetch(
        async (url) => {
            seen.push(String(url));
            if (String(url).includes('api.github.com')) {
                return new Response('not found', { status: 404 });
            }
            return jsonResponse({ accounts: [{ id: 'raw-1', token: 'tok-ok-2' }] });
        },
        async () => {
            const config = loadConfig({
                NODE_ENV: 'test',
                API_KEYS: 't:k',
                ACCOUNT_MANIFEST_REPO: 'owner/repo@dev:config/accounts.json',
            });
            const registry = new AccountRegistry(config);
            const summary = await registry.load();

            assert.equal(summary.errors.length, 0);
            assert.equal(registry.size, 1);
            assert.ok(seen.some((u) => u.includes('raw.githubusercontent.com/owner/repo/dev/config/accounts.json')));
        },
    );
});

test('a custom path and pinned ref are honoured in the built URL', async () => {
    let requested = '';
    await withStubbedFetch(
        async (url) => {
            requested = String(url);
            return jsonResponse([{ id: 'p1', token: 'tok-ok-1' }]);
        },
        async () => {
            const config = loadConfig({
                NODE_ENV: 'test',
                API_KEYS: 't:k',
                ACCOUNT_MANIFEST_REPO: 'https://github.com/me/pool/blob/prod/secrets/accounts.json',
            });
            const registry = new AccountRegistry(config);
            await registry.load();

            assert.ok(requested.includes('/repos/me/pool/contents/secrets/accounts.json'));
            assert.ok(requested.includes('ref=prod'));
        },
    );
});

test('repo accounts override env accounts that share an id', async () => {
    await withStubbedFetch(
        async () => jsonResponse({ accounts: [{ id: 'shared', token: 'tok-ok-2' }] }),
        async () => {
            const config = loadConfig({
                NODE_ENV: 'test',
                API_KEYS: 't:k',
                PUTER_AUTH_TOKEN: 'tok-ok-1',
                ACCOUNT_MANIFEST_REPO: 'owner/repo',
            });
            const registry = new AccountRegistry(config);
            await registry.load();

            // PUTER_AUTH_TOKEN seeds id "primary", so the repo entry is additive.
            assert.equal(registry.size, 2);
            assert.ok(registry.byId.has('shared'));
        },
    );
});

test('an unparseable repo spec is reported, not thrown', async () => {
    const config = loadConfig({
        NODE_ENV: 'test',
        API_KEYS: 't:k',
        ACCOUNT_MANIFEST_REPO: 'not-a-repo-spec',
    });
    const registry = new AccountRegistry(config);
    const summary = await registry.load();
    assert.equal(registry.size, 0);
    assert.equal(summary.errors.length, 1);
    assert.match(summary.errors[0], /Invalid ACCOUNT_MANIFEST_REPO/i);
});

// --- Global egress default ------------------------------------------------
// PUTER_PROXY exists so "send everything over Tor" is one line, but an
// account must still be able to opt out or point somewhere else.

test('PUTER_PROXY applies to accounts that declare no proxy', async () => {
    const config = loadConfig({
        NODE_ENV: 'test',
        API_KEYS: 't:k',
        PUTER_PROXY: 'tor',
        PUTER_ACCOUNTS: JSON.stringify([{ id: 'a1', token: 'tok-ok-1' }]),
        LOG_LEVEL: 'error',
    });
    const registry = new AccountRegistry(config);
    await registry.load();
    assert.equal(registry.byId.get('a1').proxy, 'tor');
});

test('an account-level proxy overrides the global default', async () => {
    const config = loadConfig({
        NODE_ENV: 'test',
        API_KEYS: 't:k',
        PUTER_PROXY: 'tor',
        PUTER_ACCOUNTS: JSON.stringify([
            { id: 'own', token: 'tok-ok-1', proxy: 'socks5h://10.0.0.9:1080' },
        ]),
        LOG_LEVEL: 'error',
    });
    const registry = new AccountRegistry(config);
    await registry.load();
    assert.equal(registry.byId.get('own').proxy, 'socks5h://10.0.0.9:1080');
});

test('an explicit null proxy opts an account out of the global default', async () => {
    const config = loadConfig({
        NODE_ENV: 'test',
        API_KEYS: 't:k',
        PUTER_PROXY: 'tor',
        PUTER_ACCOUNTS: JSON.stringify([{ id: 'direct', token: 'tok-ok-1', proxy: null }]),
        LOG_LEVEL: 'error',
    });
    const registry = new AccountRegistry(config);
    await registry.load();
    assert.equal(registry.byId.get('direct').proxy, null);
});

test('with no PUTER_PROXY, accounts stay direct', async () => {
    const config = loadConfig({
        NODE_ENV: 'test',
        API_KEYS: 't:k',
        PUTER_ACCOUNTS: JSON.stringify([{ id: 'a1', token: 'tok-ok-1' }]),
        LOG_LEVEL: 'error',
    });
    const registry = new AccountRegistry(config);
    await registry.load();
    assert.equal(registry.byId.get('a1').proxy, null);
});

// --- Proxy URL normalisation ----------------------------------------------
// The egress endpoint and the SDK transport must agree on what "tor" means.
// A mismatch here is invisible until someone inspects the wire.

test('proxy shorthand expands to a usable SOCKS URL', () => {
    assert.equal(normalizeProxyUrl('tor'), 'socks5h://127.0.0.1:9050');
    assert.equal(normalizeProxyUrl('9051'), 'socks5h://127.0.0.1:9051');
    assert.equal(normalizeProxyUrl('10.0.0.5:1080'), 'socks5h://10.0.0.5:1080');
    assert.equal(normalizeProxyUrl('myhost'), 'socks5h://myhost');
    assert.equal(normalizeProxyUrl(null), null);
});

test('an explicit scheme is preserved', () => {
    assert.equal(normalizeProxyUrl('http://proxy:3128'), 'http://proxy:3128');
    assert.equal(normalizeProxyUrl('socks5h://127.0.0.1:9050'), 'socks5h://127.0.0.1:9050');
});

test('socks5h is rewritten to socks5 for undici, keeping remote DNS', () => {
    // undici rejects the socks5h scheme outright, so it must be mapped — but
    // the hostname must still be forwarded, which undici does by default.
    assert.equal(toDispatcherUrl('socks5h://127.0.0.1:9050'), 'socks5://127.0.0.1:9050');
    assert.equal(toDispatcherUrl('socks5://127.0.0.1:9050'), 'socks5://127.0.0.1:9050');
    assert.equal(toDispatcherUrl('http://proxy:3128'), 'http://proxy:3128');
});

// --- Proxied transport ----------------------------------------------------
// Regression: Node's built-in fetch and the installed undici package are
// separate module instances, so a ProxyAgent built by one is rejected by the
// other with UND_ERR_INVALID_ARG. The SDK reported that as a generic
// "Upstream request failed", which looked exactly like a dead proxy — Tor was
// silently non-functional while every test still passed.

test('a proxied fetch uses the undici instance that built the dispatcher', async () => {
    // A dead port is fine: the point is that the error is a connection
    // failure, not a dispatcher/instance mismatch.
    const proxied = buildFetch('socks5h://127.0.0.1:1', { disableSdkRetry: true });
    await assert.rejects(
        () => proxied('http://127.0.0.1:1/never'),
        (err) => {
            const cause = err?.cause?.code ?? err?.code ?? '';
            assert.ok(
                !String(cause).includes('UND_ERR_INVALID_ARG'),
                `dispatcher was rejected by the wrong undici instance (${cause})`,
            );
            return true;
        },
    );
});

test('buildFetch reports an invalid proxy instead of failing at request time', () => {
    // undici validates lazily: "socks5://" is accepted, but an out-of-range
    // port throws at construction. Either way the operator must see this at
    // boot rather than as a per-request "Upstream request failed".
    assert.throws(
        () => buildFetch('socks5h://host:99999', { disableSdkRetry: true }),
        /Invalid proxy/i,
    );
});
