/**
 * Trace every request the SDK makes over Tor.
 *
 * The SDK collapses transport failures into an opaque error object, so the
 * only way to see the real cause is to wrap `globalThis.fetch` before `init()`
 * snapshots it.
 */
import { createRequire } from 'node:module';
import { ProxyAgent, fetch as undiciFetch } from 'undici';

const require = createRequire(import.meta.url);
const { init: initPuter } = require('@heyputer/puter.js/src/init.cjs');

const agent = new ProxyAgent('socks5://127.0.0.1:9050');

const tracedFetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input?.url ?? String(input);
    console.log('--> FETCH', url);
    try {
        const resp = await undiciFetch(url, { ...init, dispatcher: agent });
        console.log('<-- ', resp.status, resp.statusText);
        return resp;
    } catch (err) {
        console.log('<-- THREW', err.constructor?.name, err.message);
        if (err.cause) {
            console.log('    cause:', err.cause.constructor?.name, err.cause.message);
            if (err.cause.code) console.log('    code :', err.cause.code);
        }
        throw err;
    }
};

const previousFetch = globalThis.fetch;
globalThis.fetch = tracedFetch;
globalThis.puter_socket_enabled = false;
let puter;
try {
    puter = initPuter('tok-ok-1');
    puter.setAPIOrigin('https://api.puter.com');
} finally {
    globalThis.fetch = previousFetch;
}

try {
    const user = await puter.auth.getUser();
    console.log('OK:', user);
} catch (err) {
    console.log('FAILED typeof:', typeof err, 'keys:', Object.keys(err ?? {}));
    console.log('stringified:', String(err));
    console.log('own props:', JSON.stringify(err, Object.getOwnPropertyNames(err ?? {})));
}

await agent.close().catch(() => {});
