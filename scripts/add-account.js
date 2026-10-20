#!/usr/bin/env node
/**
 * Add an account to the local manifest.
 *
 *   npm run accounts:add -- --token eyJ... --id alt1 --proxy tor
 *
 * Reads the token from stdin when `--token` is omitted, so it never lands in
 * shell history.
 */

import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { AccountRegistry } from '../src/accounts/registry.js';
import { loadConfig } from '../src/config.js';

const args = process.argv.slice(2);
const flag = (name) => {
    const i = args.indexOf(`--${name}`);
    return i !== -1 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : null;
};

const prompt = async (question) => {
    const rl = createInterface({ input: stdin, output: stdout });
    try {
        return (await rl.question(question)).trim();
    } finally {
        rl.close();
    }
};

async function main() {
    const config = loadConfig();
    const registry = new AccountRegistry(config);
    await registry.load();

    let token = flag('token');
    if (!token) {
        token = await prompt('Puter auth token (input is visible; prefer --token or piping): ');
    }
    if (!token) {
        process.stderr.write('A token is required.\n');
        process.exit(1);
    }

    const proxy = flag('proxy');
    const id = flag('id');
    const label = flag('label');

    const account = await registry.addAccount({ token, id, proxy, label });
    process.stdout.write(
        `Added ${account.id} (proxy: ${account.proxy ?? 'direct'}) to ${config.accounts.file}\n`,
    );
}

main().catch((err) => {
    process.stderr.write(`${err.message}\n`);
    process.exit(1);
});
