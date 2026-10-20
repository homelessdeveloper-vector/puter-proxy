/**
 * Central configuration. Fails fast: a proxy that starts with a half-valid
 * config is worse than one that refuses to boot.
 */

import dotenv from 'dotenv';
import { randomBytes, createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

// The desktop app keeps its config outside the install directory so a bundle
// update cannot clobber it. Honour an explicit path before falling back to the
// conventional CWD-relative `.env` that CLI use expects.
dotenv.config(
    process.env.PUTER_PROXY_CONFIG
        ? { path: process.env.PUTER_PROXY_CONFIG, override: true }
        : {},
);

const bool = (v, fallback) => {
    if (v === undefined || v === '') return fallback;
    return ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase());
};

const int = (v, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) => {
    if (v === undefined || v === '') return fallback;
    const n = Number.parseInt(String(v), 10);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, n));
};

const list = (v) =>
    String(v ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);

/** Scopes a client key may hold. `generic` additionally needs `admin`. */
export const KNOWN_SCOPES = ['execute', 'admin'];

/**
 * Normalise an API key into a comparable digest.
 *
 * Keys in config may be given raw, or already hashed as `sha256:<hex>`. We
 * always compare digests so the comparison is fixed-length and constant-time
 * regardless of what the client sends.
 */
export const digestKey = (key) =>
    createHash('sha256').update(String(key), 'utf8').digest();

const parseApiKeys = (raw) => {
    // Format: `name:key`, `name:sha256:<hex>`, comma separated.
    // A bare key with no colon is accepted and gets a generated label.
    //
    // Scopes are opted into with a trailing `|scope+scope`, e.g.
    //   ops:sha256:<hex>|execute+admin
    // Default is `execute` only, so an ordinary key cannot reach /v1/accounts.
    //
    // Note `+`, not `,`: a comma already separates whole entries above, so
    // using it for scopes too would split one entry into two.
    const out = [];
    for (const entry of list(raw)) {
        let rest = entry;
        let scopes = ['execute'];

        // `|` never appears in a key, a hex digest, or a scope name, so the
        // rightmost one always begins the scope suffix.
        const pipe = rest.lastIndexOf('|');
        if (pipe !== -1) {
            const declared = rest
                .slice(pipe + 1)
                .toLowerCase()
                .split('+')
                .map((s) => s.trim())
                .filter(Boolean);
            rest = rest.slice(0, pipe);
            if (declared.length === 0) {
                throw new ConfigError(`API key "${rest}" has an empty scope list after "|".`);
            }
            const unknown = declared.filter((s) => !KNOWN_SCOPES.includes(s));
            if (unknown.length > 0) {
                throw new ConfigError(
                    `API key "${rest}" declares unknown scope(s): ${unknown.join(', ')}. ` +
                        `Valid scopes: ${KNOWN_SCOPES.join(', ')}.`,
                );
            }
            scopes = [...new Set(declared)];
        }

        const idx = rest.indexOf(':');
        let name;
        let secret;
        if (idx === -1) {
            name = `key${out.length + 1}`;
            secret = rest;
        } else {
            name = rest.slice(0, idx);
            secret = rest.slice(idx + 1);
        }
        if (!secret) {
            throw new ConfigError(`API key "${name}" has an empty secret.`);
        }
        const hashed = secret.startsWith('sha256:');
        let digest;
        if (hashed) {
            const hex = secret.slice(7);
            if (!/^[0-9a-f]{64}$/i.test(hex)) {
                throw new ConfigError(
                    `API key "${name}" has a malformed digest. Expected 64 hex ` +
                        `characters after "sha256:".`,
                );
            }
            digest = Buffer.from(hex, 'hex');
        } else {
            digest = digestKey(secret);
            // `openssl rand -hex 32` and a SHA-256 digest are both exactly 64
            // hex characters, so a forgotten prefix looks perfectly valid and
            // fails at request time with a bare 401. Warn loudly instead.
            if (/^[0-9a-f]{64}$/i.test(secret)) {
                process.stderr.write(
                    `\nWarning: API key "${name}" looks like a SHA-256 digest but ` +
                        `has no "sha256:" prefix, so it is being used as a RAW key. ` +
                        `Clients must send the 64-character hex string itself. To ` +
                        `store the hash instead, write "name:sha256:<hex>".\n\n`,
                );
            }
        }
        out.push({
            name,
            digest,
            mode: hashed ? 'sha256' : 'raw',
            scopes,
        });
    }
    return out;
};

export class ConfigError extends Error {
    constructor(message) {
        super(message);
        this.name = 'ConfigError';
    }
}

export function loadConfig(env = process.env) {
    const nodeEnv = env.NODE_ENV || 'development';
    const isProd = nodeEnv === 'production';

    // --- client-facing auth ------------------------------------------------
    const apiKeys = parseApiKeys(env.API_KEYS);
    if (apiKeys.length === 0) {
        if (isProd) {
            throw new ConfigError(
                'API_KEYS is required in production. Generate one with: openssl rand -hex 32',
            );
        }
        const bootstrap = randomBytes(24).toString('hex');
        apiKeys.push({
            name: 'dev-bootstrap',
            digest: digestKey(bootstrap),
            mode: 'raw',
            scopes: ['execute', 'admin'],
        });
        // Surfaced once at boot so local dev is usable without env fiddling.
        env.__DEV_BOOTSTRAP_KEY = bootstrap;
    }

    // --- upstream accounts -------------------------------------------------
    const accountsFile = env.ACCOUNTS_FILE
        ? resolve(env.ACCOUNTS_FILE)
        : resolve(process.cwd(), 'accounts.json');

    const config = {
        nodeEnv,
        isProd,
        port: int(env.PORT, 8080, { min: 1, max: 65535 }),
        host: env.HOST || '127.0.0.1',
        trustProxy: bool(env.TRUST_PROXY, false),

        apiKeys,

        // Single-account fallback. Kept for parity with the original spec.
        puterAuthToken: env.PUTER_AUTH_TOKEN?.trim() || null,
        puterApiOrigin: env.PUTER_API_ORIGIN?.trim() || null,

        accounts: {
            file: accountsFile,
            fileExists: existsSync(accountsFile),
            inline: env.PUTER_ACCOUNTS?.trim() || null,
            repo: env.ACCOUNT_MANIFEST_REPO?.trim() || null,
            repoPath: env.ACCOUNT_MANIFEST_PATH?.trim() || 'accounts.json',
            repoToken: env.ACCOUNT_MANIFEST_TOKEN?.trim() || null,
            cacheDir: resolve(env.ACCOUNT_MANIFEST_CACHE || '.cache/accounts'),
            // Egress applied to every account that doesn't declare its own.
            // `PUTER_PROXY=tor` is the one-liner for "send everything over Tor".
            proxy: env.PUTER_PROXY?.trim() || null,
            maxAttempts: int(env.ACCOUNT_MAX_ATTEMPTS, 2, { min: 1, max: 5 }),
            failoverOnRateLimit: bool(env.ACCOUNT_FAILOVER_ON_429, false),
        },

        limits: {
            jsonBytes: env.BODY_LIMIT || '1mb',
            requestTimeoutMs: int(env.REQUEST_TIMEOUT_MS, 120_000, {
                min: 1_000,
                max: 600_000,
            }),
            rateLimitPerMinute: int(env.RATE_LIMIT_PER_MINUTE, 60, { min: 0 }),
            rateLimitBurst: int(env.RATE_LIMIT_BURST, 10, { min: 1 }),
        },

        puter: {
            normalize: bool(env.PUTER_NORMALIZE, true),
            defaultModel: env.PUTER_DEFAULT_MODEL || 'gpt-5.1',
            maxTokensCap: int(env.PUTER_MAX_TOKENS_CAP, 8192, { min: 1 }),
        },

        cors: {
            origins: list(env.CORS_ORIGINS),
        },

        logLevel: env.LOG_LEVEL || (isProd ? 'info' : 'debug'),
    };

    if (!config.puterAuthToken && !config.accounts.inline && !config.accounts.fileExists && !config.accounts.repo) {
        throw new ConfigError(
            'No Puter credentials configured. Set PUTER_AUTH_TOKEN, PUTER_ACCOUNTS, ACCOUNTS_FILE, or ACCOUNT_MANIFEST_REPO.',
        );
    }

    return config;
}
