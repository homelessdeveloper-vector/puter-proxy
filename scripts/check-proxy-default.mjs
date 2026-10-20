/**
 * Verify the global `PUTER_PROXY` route reaches the account records, and that
 * an entry-level proxy still overrides it.
 */
import { loadConfig } from '../src/config.js';
import { AccountRegistry } from '../src/accounts/registry.js';

const base = {
    NODE_ENV: 'test',
    API_KEYS: 't:k',
    LOG_LEVEL: 'error',
};

const accounts = [
    { id: 'inherits', token: 'tok-ok-1' },
    { id: 'overrides', token: 'tok-ok-2', proxy: 'socks5h://10.0.0.9:1080' },
    { id: 'direct', token: 'tok-ok-1', proxy: null },
];

const withGlobal = loadConfig({
    ...base,
    PUTER_PROXY: 'tor',
    PUTER_ACCOUNTS: JSON.stringify(accounts),
});

const registry = new AccountRegistry(withGlobal);
await registry.load();

for (const id of ['inherits', 'overrides', 'direct']) {
    const a = registry.byId.get(id);
    console.log(`${id.padEnd(10)} -> ${JSON.stringify(a.proxy)}`);
}

const noGlobal = loadConfig({ ...base, PUTER_ACCOUNTS: JSON.stringify(accounts) });
const reg2 = new AccountRegistry(noGlobal);
await reg2.load();
console.log('no PUTER_PROXY, inherits ->', JSON.stringify(reg2.byId.get('inherits').proxy));
