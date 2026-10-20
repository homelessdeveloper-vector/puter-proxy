/**
 * End-to-end tests. Boots the real Express app and the real Puter SDK against
 * a mock upstream, so routing, auth, failover and error translation are all
 * exercised through their actual code paths.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createMockPuter } from './mock-puter.js';
import { loadConfig } from '../src/config.js';
import { AccountRegistry } from '../src/accounts/registry.js';
import { createApp } from '../src/app.js';

const TEST_KEY = 'test-key-0123456789abcdef';
const ADMIN_KEY = 'admin-key-0123456789abcde';

/** Boot app + mock upstream; returns helpers and a teardown. */
async function harness({ accounts, env = {}, mockOpts } = {}) {
    const mock = createMockPuter(mockOpts);
    const origin = await mock.listen();

    const config = loadConfig({
        NODE_ENV: 'test',
        PORT: '0',
        HOST: '127.0.0.1',
        // Real scope syntax, so the parser is exercised rather than bypassed.
        API_KEYS: `client:${TEST_KEY},admin:${ADMIN_KEY}|execute+admin`,
        PUTER_API_ORIGIN: origin,
        PUTER_ACCOUNTS: JSON.stringify(accounts ?? [{ id: 'a1', token: 'tok-ok-1' }]),
        REQUEST_TIMEOUT_MS: '2000',
        LOG_LEVEL: 'error',
        ...env,
    });

    const registry = new AccountRegistry(config);
    await registry.load();

    const app = createApp({ config, registry });
    const server = app.listen(0, '127.0.0.1');
    await new Promise((r) => server.once('listening', r));
    const { port } = server.address();
    const base = `http://127.0.0.1:${port}`;

    return {
        base,
        mock,
        registry,
        config,
        call: (path, opts = {}) =>
            fetch(`${base}${path}`, {
                ...opts,
                headers: {
                    'content-type': 'application/json',
                    'x-api-key': TEST_KEY,
                    ...(opts.headers ?? {}),
                },
            }),
        admin: (path, opts = {}) =>
            fetch(`${base}${path}`, {
                ...opts,
                headers: {
                    'content-type': 'application/json',
                    'x-api-key': ADMIN_KEY,
                    ...(opts.headers ?? {}),
                },
            }),
        async close() {
            await new Promise((r) => server.close(r));
            await mock.close();
        },
    };
}

test('health is public and leaks no account detail', async () => {
    const h = await harness();
    try {
        const res = await fetch(`${h.base}/health`);
        assert.equal(res.status, 200);
        const body = await res.json();
        assert.equal(body.ok, true);
        assert.equal(body.accounts, 1);
        assert.ok(!('accounts_detail' in body));
        assert.ok(!JSON.stringify(body).includes('tok-ok'));
    } finally {
        await h.close();
    }
});

test('missing API key is rejected with 401', async () => {
    const h = await harness();
    try {
        const res = await fetch(`${h.base}/v1/execute`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ operation: 'chat', input: { messages: 'hi' } }),
        });
        assert.equal(res.status, 401);
        const body = await res.json();
        assert.equal(body.ok, false);
        assert.equal(body.error.code, 'unauthorized');
        assert.ok(body.request_id);
    } finally {
        await h.close();
    }
});

test('wrong API key is rejected with 401', async () => {
    const h = await harness();
    try {
        const res = await h.call('/v1/execute', {
            method: 'POST',
            headers: { 'x-api-key': 'nope' },
            body: JSON.stringify({ operation: 'chat', input: { messages: 'hi' } }),
        });
        assert.equal(res.status, 401);
        assert.equal((await res.json()).error.code, 'unauthorized');
    } finally {
        await h.close();
    }
});

test('Bearer token is accepted as an alternative to X-API-Key', async () => {
    const h = await harness();
    try {
        const res = await fetch(`${h.base}/v1/execute`, {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                authorization: `Bearer ${TEST_KEY}`,
            },
            body: JSON.stringify({ operation: 'chat', input: { messages: 'hello' } }),
        });
        assert.equal(res.status, 200);
    } finally {
        await h.close();
    }
});

test('chat returns a clean JSON envelope', async () => {
    const h = await harness();
    try {
        const res = await h.call('/v1/execute', {
            method: 'POST',
            body: JSON.stringify({
                operation: 'chat',
                input: { messages: [{ role: 'user', content: 'ping' }], model: 'gpt-test' },
            }),
        });
        assert.equal(res.status, 200);
        const body = await res.json();
        assert.equal(body.ok, true);
        assert.equal(body.operation, 'chat');
        assert.match(body.data.content, /Echo from ashton: ping/);
        assert.equal(body.data.model, 'gpt-test');
        assert.deepEqual(body.data.usage, {
            prompt_tokens: 3,
            completion_tokens: 7,
            total_tokens: 10,
        });
        assert.equal(body.account.id, 'a1');
        assert.ok(typeof body.meta.duration_ms === 'number');
        assert.ok(!JSON.stringify(body).includes('tok-ok'));
    } finally {
        await h.close();
    }
});

test('a bare prompt string is accepted as messages', async () => {
    const h = await harness();
    try {
        const res = await h.call('/v1/execute', {
            method: 'POST',
            body: JSON.stringify({ operation: 'chat', input: { prompt: 'bare prompt' } }),
        });
        assert.equal(res.status, 200);
        assert.match((await res.json()).data.content, /bare prompt/);
    } finally {
        await h.close();
    }
});

test('unknown operation returns 400 with the available list', async () => {
    const h = await harness();
    try {
        const res = await h.call('/v1/execute', {
            method: 'POST',
            body: JSON.stringify({ operation: 'delete-everything' }),
        });
        assert.equal(res.status, 400);
        const body = await res.json();
        assert.equal(body.error.code, 'invalid_request');
        assert.ok(body.error.details.available.includes('chat'));
    } finally {
        await h.close();
    }
});

test('missing operation returns 400', async () => {
    const h = await harness();
    try {
        const res = await h.call('/v1/execute', { method: 'POST', body: '{}' });
        assert.equal(res.status, 400);
        assert.equal((await res.json()).error.code, 'invalid_request');
    } finally {
        await h.close();
    }
});

test('malformed JSON returns 400, not an HTML error page', async () => {
    const h = await harness();
    try {
        const res = await h.call('/v1/execute', { method: 'POST', body: '{nope' });
        assert.equal(res.status, 400);
        const body = await res.json();
        assert.equal(body.ok, false);
        assert.equal(body.error.code, 'invalid_json');
    } finally {
        await h.close();
    }
});

test('an expired token surfaces as 401 upstream_unauthorized', async () => {
    const h = await harness({ accounts: [{ id: 'dead', token: 'tok-revoked' }] });
    try {
        const res = await h.call('/v1/execute', {
            method: 'POST',
            body: JSON.stringify({ operation: 'chat', input: { messages: 'hi' } }),
        });
        assert.equal(res.status, 401);
        const body = await res.json();
        assert.equal(body.error.code, 'upstream_unauthorized');
        assert.match(body.error.message, /expired or revoked/i);

        // The account must be parked, not retried forever.
        assert.equal(h.registry.byId.get('dead').state.status, 'dead');
    } finally {
        await h.close();
    }
});

test('rate limiting upstream maps to 429 and a cooldown', async () => {
    const h = await harness({ accounts: [{ id: 'rl', token: 'tok-limited' }] });
    try {
        const res = await h.call('/v1/execute', {
            method: 'POST',
            body: JSON.stringify({ operation: 'chat', input: { messages: 'hi' } }),
        });
        assert.equal(res.status, 429);
        const body = await res.json();
        assert.equal(body.error.code, 'upstream_rate_limited');
        assert.ok(res.headers.get('retry-after'));

        const acct = h.registry.byId.get('rl');
        assert.equal(acct.state.status, 'cooldown');
        assert.ok(acct.state.cooldownUntil > Date.now());
    } finally {
        await h.close();
    }
});

test('an exhausted quota maps to 402', async () => {
    const h = await harness({ accounts: [{ id: 'q', token: 'tok-quota' }] });
    try {
        const res = await h.call('/v1/execute', {
            method: 'POST',
            body: JSON.stringify({ operation: 'chat', input: { messages: 'hi' } }),
        });
        assert.equal(res.status, 402);
        assert.equal((await res.json()).error.code, 'upstream_quota_exhausted');
    } finally {
        await h.close();
    }
});

test('a 5xx upstream maps to 502', async () => {
    const h = await harness({ accounts: [{ id: 'b', token: 'tok-broken' }] });
    try {
        const res = await h.call('/v1/execute', {
            method: 'POST',
            body: JSON.stringify({ operation: 'chat', input: { messages: 'hi' } }),
        });
        assert.equal(res.status, 502);
        const body = await res.json();
        assert.ok(['upstream_error', 'upstream_rejected'].includes(body.error.code));
    } finally {
        await h.close();
    }
});

test('failover: a dead account is skipped and a healthy one serves', async () => {
    const h = await harness({
        accounts: [
            { id: 'dead', token: 'tok-revoked' },
            { id: 'good', token: 'tok-ok-2' },
        ],
        env: { ACCOUNT_MAX_ATTEMPTS: '2' },
    });
    try {
        const res = await h.call('/v1/execute', {
            method: 'POST',
            body: JSON.stringify({ operation: 'chat', input: { messages: 'failover test' } }),
        });
        assert.equal(res.status, 200);
        const body = await res.json();
        // Whichever order the pool chose, the request must end on the good one.
        assert.equal(body.account.id, 'good');
        assert.match(body.data.content, /ashton-2/);
    } finally {
        await h.close();
    }
});

test('failover: all accounts dead returns 503', async () => {
    const h = await harness({
        accounts: [
            { id: 'd1', token: 'tok-revoked' },
            { id: 'd2', token: 'tok-revoked' },
        ],
    });
    try {
        // A 401 is not retryable within one request, so each request burns one
        // account. Two requests exhaust the pool.
        const first = await h.call('/v1/execute', {
            method: 'POST',
            body: JSON.stringify({ operation: 'chat', input: { messages: 'x' } }),
        });
        assert.equal(first.status, 401);

        const second = await h.call('/v1/execute', {
            method: 'POST',
            body: JSON.stringify({ operation: 'chat', input: { messages: 'x' } }),
        });
        assert.equal(second.status, 401);

        // With both parked, the pool has nothing left to offer.
        const third = await h.call('/v1/execute', {
            method: 'POST',
            body: JSON.stringify({ operation: 'chat', input: { messages: 'x' } }),
        });
        assert.equal(third.status, 503);
        assert.equal((await third.json()).error.code, 'no_account_available');
    } finally {
        await h.close();
    }
});

test('a timeout returns 504 rather than hanging', async () => {
    const h = await harness({
        accounts: [{ id: 'slow', token: 'tok-slow' }],
        env: { REQUEST_TIMEOUT_MS: '300' },
        mockOpts: { fastSlow: 2000 },
    });
    try {
        const res = await h.call('/v1/execute', {
            method: 'POST',
            body: JSON.stringify({ operation: 'chat', input: { messages: 'slow' } }),
        });
        assert.equal(res.status, 504);
        assert.equal((await res.json()).error.code, 'upstream_timeout');
    } finally {
        await h.close();
    }
});

test('image generation operation returns a url', async () => {
    const h = await harness();
    try {
        const res = await h.call('/v1/execute', {
            method: 'POST',
            body: JSON.stringify({ operation: 'image', input: { prompt: 'a cat' } }),
        });
        assert.equal(res.status, 200);
        const body = await res.json();
        assert.equal(body.data.url, 'https://cdn.puter.test/img/abc.png');
    } finally {
        await h.close();
    }
});

test('input validation rejects an empty prompt', async () => {
    const h = await harness();
    try {
        const res = await h.call('/v1/execute', {
            method: 'POST',
            body: JSON.stringify({ operation: 'image', input: { prompt: '   ' } }),
        });
        assert.equal(res.status, 400);
        assert.equal((await res.json()).error.code, 'invalid_request');
    } finally {
        await h.close();
    }
});

test('streaming is refused explicitly instead of silently ignored', async () => {
    const h = await harness();
    try {
        const res = await h.call('/v1/execute', {
            method: 'POST',
            body: JSON.stringify({ operation: 'chat', input: { messages: 'hi', stream: true } }),
        });
        assert.equal(res.status, 400);
        assert.match((await res.json()).error.message, /streaming/i);
    } finally {
        await h.close();
    }
});

test('admin: account list is masked and requires admin scope', async () => {
    const h = await harness();
    try {
        const denied = await h.call('/v1/accounts');
        assert.equal(denied.status, 403);
        assert.equal((await denied.json()).error.code, 'forbidden');

        const ok = await h.admin('/v1/accounts');
        assert.equal(ok.status, 200);
        const body = await ok.json();
        assert.equal(body.count, 1);
        const acct = body.accounts[0];
        assert.equal(acct.id, 'a1');
        assert.ok(!JSON.stringify(body).includes('tok-ok-1'));
        assert.match(acct.token_fingerprint, /^[0-9a-f]{12}$/);
        assert.ok(!('token' in acct), 'must not expose a token field');
    } finally {
        await h.close();
    }
});

test('admin: non-admin key cannot pin an account', async () => {
    const h = await harness();
    try {
        const res = await h.call('/v1/execute', {
            method: 'POST',
            body: JSON.stringify({
                operation: 'chat',
                account: 'a1',
                input: { messages: 'hi' },
            }),
        });
        assert.equal(res.status, 403);
    } finally {
        await h.close();
    }
});

test('admin: credential check reports health without leaking tokens', async () => {
    const h = await harness({
        accounts: [
            { id: 'ok', token: 'tok-ok-1' },
            { id: 'bad', token: 'tok-revoked' },
        ],
    });
    try {
        const res = await h.admin('/v1/accounts/check', { method: 'POST' });
        assert.equal(res.status, 200);
        const body = await res.json();
        assert.equal(body.checked, 2);
        assert.equal(body.healthy, 1);
        assert.ok(!JSON.stringify(body).includes('tok-ok'));
    } finally {
        await h.close();
    }
});

test('admin: generic driver calls are allowlisted', async () => {
    const h = await harness();
    try {
        const denied = await h.admin('/v1/execute', {
            method: 'POST',
            body: JSON.stringify({
                operation: 'generic',
                input: { iface: 'puter-fs', method: 'delete' },
            }),
        });
        assert.equal(denied.status, 403);
        assert.equal((await denied.json()).error.code, 'interface_not_allowed');

        const allowed = await h.admin('/v1/execute', {
            method: 'POST',
            body: JSON.stringify({
                operation: 'generic',
                input: { iface: 'puter-image-generation', method: 'generate', args: { prompt: 'x' } },
            }),
        });
        assert.equal(allowed.status, 200);
    } finally {
        await h.close();
    }
});

test('rate limiter returns 429 with Retry-After once the burst is spent', async () => {
    const h = await harness({
        env: { RATE_LIMIT_PER_MINUTE: '1', RATE_LIMIT_BURST: '2' },
    });
    try {
        const one = await h.call('/health');
        assert.equal(one.status, 200);

        const a = await h.call('/v1/execute', {
            method: 'POST',
            body: JSON.stringify({ operation: 'chat', input: { messages: '1' } }),
        });
        const b = await h.call('/v1/execute', {
            method: 'POST',
            body: JSON.stringify({ operation: 'chat', input: { messages: '2' } }),
        });
        // Burst of 2 permits two calls; the third must be limited.
        assert.equal(a.status, 200);
        assert.ok([200, 429].includes(b.status));

        const c = await h.call('/v1/execute', {
            method: 'POST',
            body: JSON.stringify({ operation: 'chat', input: { messages: '3' } }),
        });
        assert.equal(c.status, 429);
        assert.equal((await c.json()).error.code, 'rate_limited');
        assert.ok(c.headers.get('retry-after'));
    } finally {
        await h.close();
    }
});

test('unknown route returns json 404', async () => {
    const h = await harness();
    try {
        const res = await fetch(`${h.base}/nope`);
        assert.equal(res.status, 404);
        assert.equal((await res.json()).error.code, 'not_found');
    } finally {
        await h.close();
    }
});

test('x-request-id is echoed when supplied', async () => {
    const h = await harness();
    try {
        const res = await h.call('/v1/execute', {
            method: 'POST',
            headers: { 'x-request-id': 'my-trace-1234' },
            body: JSON.stringify({ operation: 'chat', input: { messages: 'hi' } }),
        });
        assert.equal(res.headers.get('x-request-id'), 'my-trace-1234');
    } finally {
        await h.close();
    }
});

// --- Admin reachability ----------------------------------------------------
// Regression: env-issued keys were hardcoded to the "execute" scope, which
// made every /v1/accounts endpoint permanently unreachable in production.

test('an admin-scoped env key can reach the account pool', async () => {
    const h = await harness();
    try {
        const res = await h.admin('/v1/accounts');
        assert.equal(res.status, 200);
        const body = await res.json();
        assert.equal(body.ok, true);
        assert.equal(body.count, 1);

        // Tokens must never appear; only a short fingerprint is exposed.
        const acct = body.accounts[0];
        assert.ok(!('token' in acct));
        assert.match(acct.token_fingerprint, /^[0-9a-f]{12}$/);
    } finally {
        await h.close();
    }
});

test('an execute-only key is forbidden from the account pool', async () => {
    const h = await harness();
    try {
        const res = await h.call('/v1/accounts');
        assert.equal(res.status, 403);
        const body = await res.json();
        assert.equal(body.error.code, 'forbidden');
        assert.equal(body.error.details.required_scope, 'admin');
    } finally {
        await h.close();
    }
});

test('a valid key on an unknown /v1 route gets a 404, not a 401', async () => {
    const h = await harness();
    try {
        const res = await h.call('/v1/does-not-exist');
        assert.equal(res.status, 404);
        assert.equal((await res.json()).error.code, 'not_found');
    } finally {
        await h.close();
    }
});
