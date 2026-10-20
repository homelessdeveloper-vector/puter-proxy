/**
 * Diagnose why a Puter call fails over Tor.
 *
 * The SDK discards the underlying transport error and reports a generic
 * "Upstream request failed", which hides the cause. This exercises the same
 * code path and prints the original exception.
 */
import { loadConfig } from '../src/config.js';
import { AccountRegistry } from '../src/accounts/registry.js';
import { getClient } from '../src/puter/client.js';

const config = loadConfig({
    NODE_ENV: 'test',
    API_KEYS: 't:k',
    PUTER_AUTH_TOKEN: 'tok-ok-1',
    PUTER_PROXY: 'tor',
    LOG_LEVEL: 'error',
});

const registry = new AccountRegistry(config);
await registry.load();
const account = registry.byId.get('primary');
console.log('account.proxy   :', account.proxy);

const client = getClient(account);
console.log('client.proxy    :', client.proxy);
console.log('api origin      :', client.puter.APIOrigin ?? '(default)');

try {
    const user = await client.puter.auth.getUser();
    console.log('getUser OK      :', user?.username ?? user);
} catch (err) {
    console.log('getUser FAILED  :', err);
    if (err?.cause) console.log('  cause         :', err.cause);
    if (err?.code) console.log('  code          :', err.code);
}
