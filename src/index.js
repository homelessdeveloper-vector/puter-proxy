/**
 * Process entry point: load config, resolve accounts, serve, shut down cleanly.
 */

import { loadConfig, ConfigError } from './config.js';
import { AccountRegistry } from './accounts/registry.js';
import { createApp } from './app.js';
import { logger, setLogLevel } from './logger.js';
import { evictAll } from './puter/client.js';

async function main() {
    let config;
    try {
        config = loadConfig();
    } catch (err) {
        if (err instanceof ConfigError) {
            process.stderr.write(`\nConfiguration error: ${err.message}\n\n`);
            process.exit(1);
        }
        throw err;
    }

    setLogLevel(config.logLevel);

    const registry = new AccountRegistry(config);
    const summary = await registry.load();

    if (registry.size === 0) {
        process.stderr.write(
            `\nNo usable Puter accounts found.\n` +
                `Checked: ${summary.sources.join(', ') || 'nothing configured'}\n` +
                `Set PUTER_AUTH_TOKEN, or create accounts.json / ACCOUNT_MANIFEST_REPO.\n\n`,
        );
        process.exit(1);
    }

    const app = createApp({ config, registry });

    const server = app.listen(config.port, config.host, () => {
        logger.info('puter-proxy listening', {
            url: `http://${config.host}:${config.port}`,
            env: config.nodeEnv,
            accounts: registry.size,
            api_keys: config.apiKeys.map((k) => `${k.name}(${k.mode})`),
            proxies: registry.describe().filter((a) => a.proxy !== 'direct').length,
        });

        // Local dev convenience: print the generated key exactly once.
        if (process.env.__DEV_BOOTSTRAP_KEY) {
            process.stderr.write(
                `\n  Dev API key (set API_KEYS to keep it stable):\n` +
                    `  ${process.env.__DEV_BOOTSTRAP_KEY}\n\n`,
            );
        }
    });

    server.headersTimeout = 65_000;
    server.requestTimeout = config.limits.requestTimeoutMs + 5_000;

    const shutdown = (signal) => {
        logger.info('shutting down', { signal });
        server.close(() => {
            evictAll();
            process.exit(0);
        });
        // Don't hang on keep-alive sockets.
        setTimeout(() => process.exit(0), 10_000).unref();
    };

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));

    process.on('unhandledRejection', (reason) => {
        logger.error('unhandled rejection', { reason: String(reason) });
    });
}

main().catch((err) => {
    process.stderr.write(`Fatal: ${err?.stack ?? err}\n`);
    process.exit(1);
});
