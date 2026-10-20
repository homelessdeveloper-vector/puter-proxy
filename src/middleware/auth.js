/**
 * Client authentication.
 *
 * Two independent keys protect this service:
 *   1. X-API-Key  — proves the caller is allowed to use the proxy.
 *   2. PUTER_AUTH_TOKEN / accounts — proves the proxy may use Puter.
 *
 * Comparisons are constant-time over fixed-length digests so neither timing
 * nor key length leaks information.
 */

import { timingSafeEqual } from 'node:crypto';
import { digestKey } from '../config.js';
import { unauthorized, forbidden } from '../errors.js';

const HEADER = 'x-api-key';
const BEARER = /^Bearer\s+(.+)$/i;

const extractKey = (req) => {
    const header = req.get(HEADER);
    if (header) return header.trim();

    // Convenience: also accept `Authorization: Bearer <key>`.
    const auth = req.get('authorization');
    if (auth) {
        const m = BEARER.exec(auth);
        if (m) return m[1].trim();
    }
    return null;
};

export function createApiKeyAuth(config) {
    const keys = config.apiKeys;

    return function apiKeyAuth(req, _res, next) {
        const provided = extractKey(req);
        if (!provided) {
            return next(
                unauthorized('Missing X-API-Key header', {
                    hint: 'Send the key as the X-API-Key header.',
                }),
            );
        }

        const digest = digestKey(provided);
        let match = null;
        for (const k of keys) {
            // Lengths are equal (sha256 = 32 bytes) but guard anyway.
            if (k.digest.length === digest.length && timingSafeEqual(k.digest, digest)) {
                match = k;
            }
        }

        if (!match) {
            return next(unauthorized('Invalid API key'));
        }

        req.apiKey = { name: match.name, scopes: match.scopes };
        next();
    };
}

/** Require a scope on the authenticated key. */
export const requireScope = (scope) => (req, _res, next) => {
    if (!req.apiKey?.scopes?.includes(scope)) {
        return next(
            forbidden(`This endpoint requires the "${scope}" scope`, {
                required_scope: scope,
                granted_scopes: req.apiKey?.scopes ?? [],
            }),
        );
    }
    next();
};
