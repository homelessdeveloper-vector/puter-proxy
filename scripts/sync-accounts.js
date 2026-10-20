#!/usr/bin/env node
/**
 * Sync account manifests from one or more GitHub repositories into the local
 * cache, then print what would be loaded.
 *
 *   npm run accounts:sync
 *   npm run accounts:sync -- --json
 *
 * Useful for cron: a shared repo of account manifests becomes the source of
 * truth, and the proxy picks up new accounts on reload.
 */

import { loadConfig } from '../src/config.js';
import { AccountRegistry } from '../src/accounts/registry.js';
import { writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';

async function main() {
    const asJson = process.argv.includes('--json');
    const config = loadConfig();
    const registry = new AccountRegistry(config);
    const summary = await registry.load();

    // Dump the merged, de-duplicated result for inspection (never tokens).
    await mkdir(config.accounts.cacheDir, { recursive: true });
    const snapshot = {
        synced_at: new Date().toISOString(),
        sources: summary.sources,
        accounts: registry.describe(),
    };
    const outPath = resolve(config.accounts.cacheDir, 'snapshot.json');
    await writeFile(outPath, `${JSON.stringify(snapshot, null, 2)}\n`, { mode: 0o600 });

    if (asJson) {
        process.stdout.write(`${JSON.stringify(snapshot, null, 2)}\n`);
    } else {
        process.stdout.write(`Sources: ${summary.sources.join(', ') || '(none)'}\n`);
        process.stdout.write(`Accounts: ${summary.accounts}\n\n`);
        for (const a of snapshot.accounts) {
            process.stdout.write(
                `  ${a.id.padEnd(20)} ${String(a.proxy).padEnd(24)} ${a.status}\n`,
            );
        }
        if (summary.errors.length) {
            process.stdout.write(`\nWarnings:\n`);
            for (const e of summary.errors) process.stdout.write(`  - ${e}\n`);
        }
        process.stdout.write(`\nSnapshot: ${outPath}\n`);
    }
}

main().catch((err) => {
    process.stderr.write(`${err.stack ?? err.message}\n`);
    process.exit(1);
});
