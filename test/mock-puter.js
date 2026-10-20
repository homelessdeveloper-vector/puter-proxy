/**
 * Mock Puter API for end-to-end tests.
 *
 * Replicates the wire contract the real SDK depends on:
 *   POST /drivers/call   { interface, driver, method, args, auth_token }
 *   GET  /whoami
 *
 * Each token maps to a scripted behaviour so tests can drive 200/401/429/500
 * paths deterministically.
 */

import http from 'node:http';

export const BEHAVIOURS = {
    'tok-ok-1': { kind: 'ok', user: 'ashton' },
    'tok-ok-2': { kind: 'ok', user: 'ashton-2' },
    'tok-revoked': { kind: '401' },
    'tok-limited': { kind: '429', retryAfter: 7 },
    'tok-quota': { kind: '402' },
    'tok-broken': { kind: '500' },
    'tok-slow': { kind: 'slow', delayMs: 3000 },
};

export function createMockPuter({ fastSlow = 300 } = {}) {
    // Per-instance: a module-level array would leak counts between tests.
    const recorded = [];
    const server = http.createServer((req, res) => {
        let raw = '';
        req.on('data', (c) => {
            raw += c;
        });
        req.on('end', () => {
            const url = new URL(req.url, 'http://localhost');

            if (url.pathname === '/whoami') {
                return respondWhoami(req, res);
            }

            if (url.pathname === '/drivers/call' && req.method === 'POST') {
                return respondDriver(req, res, raw);
            }

            res.writeHead(404, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ success: false, message: 'not found' }));
        });
    });

    function authOf(req, raw) {
        // The driver path carries the token in the body; /whoami in a header.
        if (raw) {
            try {
                return JSON.parse(raw).auth_token;
            } catch {
                /* fallthrough */
            }
        }
        const h = req.headers.authorization ?? '';
        return h.replace(/^Bearer\s+/i, '');
    }

    function respondWhoami(req, res) {
        const token = authOf(req, '');
        const b = BEHAVIOURS[token];
        if (!b || b.kind === '401') {
            res.writeHead(401, { 'content-type': 'application/json' });
            return res.end(JSON.stringify({ code: 'token_auth_failed', reason: 'session_expired' }));
        }
        if (b.kind === '429') {
            res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '7' });
            return res.end(JSON.stringify({ message: 'Rate limited' }));
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ user: { username: b.user, uuid: `uuid-${b.user}` } }));
    }

    function respondDriver(req, res, raw) {
        let body = {};
        try {
            body = JSON.parse(raw);
        } catch {
            res.writeHead(400, { 'content-type': 'application/json' });
            return res.end(JSON.stringify({ success: false, message: 'bad json' }));
        }

        const token = body.auth_token;
        const b = BEHAVIOURS[token];

        recorded.push({
            token,
            iface: body.interface,
            method: body.method,
            args: body.args,
            // The header a proxy would inject is not visible here, so tests
            // assert routing via the token→behaviour mapping instead.
            proxyHeader: req.headers['x-route-hint'] ?? null,
        });

        if (!b || b.kind === '401') {
            res.writeHead(401, { 'content-type': 'application/json' });
            return res.end(
                JSON.stringify({ success: false, code: 'token_auth_failed', message: 'Unauthorized' }),
            );
        }

        if (b.kind === '429') {
            res.writeHead(429, { 'content-type': 'application/json', 'retry-after': String(b.retryAfter) });
            return res.end(JSON.stringify({ success: false, message: 'Rate limit exceeded' }));
        }

        if (b.kind === '402') {
            res.writeHead(402, { 'content-type': 'application/json' });
            return res.end(JSON.stringify({ success: false, code: 'insufficient_funds', message: 'Please upgrade' }));
        }

        if (b.kind === '500') {
            res.writeHead(500, { 'content-type': 'application/json' });
            return res.end(JSON.stringify({ success: false, message: 'internal error' }));
        }

        if (b.kind === 'slow') {
            const delay = fastSlow;
            return setTimeout(() => {
                if (res.writableEnded) return;
                res.writeHead(200, { 'content-type': 'application/json' });
                res.end(JSON.stringify(okPayload(body, b)));
            }, delay);
        }

        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(okPayload(body, b)));
    }

    return {
        server,
        recorded,
        reset() {
            recorded.length = 0;
        },
        async listen() {
            await new Promise((r) => server.listen(0, '127.0.0.1', r));
            const { port } = server.address();
            return `http://127.0.0.1:${port}`;
        },
        async close() {
            await new Promise((r) => server.close(r));
        },
    };
}

/** Build a realistic driver success envelope for each interface. */
function okPayload(body, behaviour) {
    const iface = body.interface;

    if (iface === 'puter-chat-completion') {
        return {
            success: true,
            result: {
                message: {
                    role: 'assistant',
                    content: `Echo from ${behaviour.user}: ${summarise(body.args)}`,
                },
                model: body.args?.model ?? 'test-model',
                usage: { prompt_tokens: 3, completion_tokens: 7, total_tokens: 10 },
            },
        };
    }

    if (iface === 'puter-image-generation') {
        return { success: true, result: { url: 'https://cdn.puter.test/img/abc.png' } };
    }

    if (iface === 'puter-tts') {
        return { success: true, result: { url: 'https://cdn.puter.test/audio/abc.mp3' } };
    }

    if (iface === 'puter-ocr') {
        return { success: true, result: { text: 'recognised text' } };
    }

    return { success: true, result: { ok: true, echo: body.args ?? null } };
}

function summarise(args) {
    if (!args) return '(no args)';
    const msgs = args.messages;
    if (Array.isArray(msgs) && msgs.length) {
        const last = msgs[msgs.length - 1];
        return typeof last.content === 'string' ? last.content : JSON.stringify(last.content);
    }
    return JSON.stringify(args).slice(0, 120);
}
