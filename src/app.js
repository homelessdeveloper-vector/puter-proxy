/**
 * Express application factory.
 *
 * Kept separate from the listener so tests can mount the app without binding
 * a port.
 */

import express from 'express';
import helmet from 'helmet';
import { createApiKeyAuth } from './middleware/auth.js';
import { createRateLimiter, requestId } from './middleware/limits.js';
import { errorHandler, notFoundHandler } from './middleware/errors.js';
import { createExecuteRouter } from './routes/execute.js';
import { createAdminRouter } from './routes/admin.js';
import { buildOperations } from './puter/operations.js';
import { ApiError } from './errors.js';
import { logger } from './logger.js';

export function createApp({ config, registry }) {
    const app = express();

    // Behind a reverse proxy, so req.ip and rate limiting key off the real
    // client rather than the load balancer.
    if (config.trustProxy) app.set('trust proxy', 1);
    app.disable('x-powered-by');
    app.disable('etag');

    app.use(
        helmet({
            contentSecurityPolicy: false, // JSON-only API; no document to protect
            crossOriginResourcePolicy: { policy: 'same-site' },
        }),
    );

    app.use(requestId);
    app.use(express.json({ limit: config.limits.jsonBytes }));

    // Reject malformed JSON with our envelope rather than Express's HTML page.
    // Wrapping it in ApiError matters: the generic error path would otherwise
    // mistake a body-parser SyntaxError for an upstream failure.
    app.use((err, _req, _res, next) => {
        if (err instanceof SyntaxError && 'body' in err) {
            return next(
                new ApiError(400, 'invalid_json', 'Request body is not valid JSON', {
                    hint: 'Ensure Content-Type is application/json and the body is well-formed.',
                }),
            );
        }
        if (err?.type === 'entity.too.large') {
            return next(
                new ApiError(413, 'payload_too_large', 'Request body exceeds the configured limit', {
                    limit: config.limits.jsonBytes,
                }),
            );
        }
        next(err);
    });

    // CORS is opt-in and explicit: an allowlist, never `*`, because a browser
    // origin holding a key should still be a deliberate decision.
    if (config.cors.origins.length > 0) {
        app.use((req, res, next) => {
            const origin = req.get('origin');
            if (origin && config.cors.origins.includes(origin)) {
                res.setHeader('Access-Control-Allow-Origin', origin);
                res.setHeader('Vary', 'Origin');
                res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-API-Key, X-Request-Id');
                res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
                res.setHeader('Access-Control-Max-Age', '600');
            }
            if (req.method === 'OPTIONS') return res.status(204).end();
            next();
        });
    }

    // Unauthenticated liveness endpoint. No account detail leaks here.
    app.get('/health', (_req, res) => {
        res.json({
            ok: true,
            service: 'puter-proxy',
            version: registry.version ?? undefined,
            accounts: registry.size,
            uptime_s: Math.round(process.uptime()),
        });
    });

    const apiKeyAuth = createApiKeyAuth(config);
    const rateLimit = createRateLimiter(config.limits);

    const operations = buildOperations(config);

    app.use('/v1', apiKeyAuth, rateLimit);
    app.use(createExecuteRouter({ config, registry, operations }));
    app.use(createAdminRouter({ config, registry }));

    app.use(notFoundHandler);
    app.use(errorHandler);

    logger.debug('app configured', {
        operations: Object.keys(operations),
        accounts: registry.size,
        admin_endpoints: true,
    });

    return app;
}
