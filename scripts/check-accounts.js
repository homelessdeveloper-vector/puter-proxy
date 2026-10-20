#!/usr/bin/env node
/**
 * Probe every configured account and print a health table.
 *
 *   npm run accounts:check
 *
 * Exit code is 1 if no account is healthy, so this works as a CI gate or a
 * container readiness probe.
 */

import { loadConfig } from '../src/config.js';
import { AccountRegistry } from '../src/accounts/registry.js';
import { getClient } from '../src/puter/client.js';

const pad = (s, n) => String(s).padEnd(n).slice(0, n);

async function main() {
    const config = loadConfig();
    const registry = new AccountRegistry(config);
    await registry.load();

    if (registry.size === 0) {
        process.stderr.write('No accounts configured.\n');
        process.exit(1);
    }

    process.stdout.write(
        `${pad('ACCOUNT', 22)}${pad('PROXY', 26)}${pad('RESULT', 12)}DETAIL\n`,
    );
    process.stdout.write(`${'-'.repeat(78)}\n`);

    const results = await registry.checkAll(async (account) => {
        const client = getClient(account);
        const user = await client.puter.auth.getUser();
        if (!user) throw new Error('whoami returned no user');
        return { username: user.username ?? '(no username)' };
    });

    let healthy = 0;
    for (const r of results) {
        const acct = registry.byId.get(r.id);
        if (r.ok) {
            healthy += 1;
            process.stdout.write(
                `${pad(r.id, 22)}${pad(acct.proxy ?? 'direct', 26)}${pad('OK', 12)}${
                    r.user?.username ?? ''
                }\n`,
            );
        } else {
            process.stdout.write(
                `${pad(r.id, 22)}${pad(acct.proxy ?? 'direct', 26)}${pad('FAIL', 12)}${r.error}\n`,
            );
        }
    }

    process.stdout.write(`\n${healthy}/${results.length} healthy\n`);
    process.exit(healthy === 0 ? 1 : 0);
}

main().catch((err) => {
    process.stderr.write(`${err.stack ?? err.message}\n`);
    process.exit(1);
});
