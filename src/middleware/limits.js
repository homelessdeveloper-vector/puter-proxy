/**
 * Request correlation + a token-bucket rate limiter.
 *
 * In-process only: correct for a single node, and deliberately not pretending
 * to be distributed. If you run several replicas, move the bucket to Redis.
 */

import { randomUUID } from 'node:crypto';
import { tooManyRequests } from '../errors.js';

export const requestId = (req, res, next) => {
    const incoming = req.get('x-request-id');
    const id = incoming && /^[\w.:-]{8,128}$/.test(incoming) ? incoming : randomUUID();
    req.id = id;
    res.setHeader('X-Request-Id', id);
    next();
};

/**
 * Token bucket per API key (falling back to IP). Refill is continuous.
 *
 * @param {{ rateLimitPerMinute: number, rateLimitBurst: number }} opts
 */
export function createRateLimiter({ rateLimitPerMinute, rateLimitBurst }) {
    if (!rateLimitPerMinute) {
        return (_req, _res, next) => next();
    }

    const capacity = rateLimitBurst;
    const refillPerMs = rateLimitPerMinute / 60_000;
    /** @type {Map<string, { tokens: number, updated: number }>} */
    const buckets = new Map();

    // Evict idle buckets so memory stays flat under many distinct clients.
    const sweep = setInterval(() => {
        const cutoff = Date.now() - 10 * 60_000;
        for (const [key, b] of buckets) {
            if (b.updated < cutoff) buckets.delete(key);
        }
    }, 60_000);
    sweep.unref?.();

    return function rateLimit(req, res, next) {
        const identity = req.apiKey?.name ?? req.ip ?? 'anonymous';
        const now = Date.now();

        let bucket = buckets.get(identity);
        if (!bucket) {
            bucket = { tokens: capacity, updated: now };
            buckets.set(identity, bucket);
        }

        const elapsed = now - bucket.updated;
        bucket.tokens = Math.min(capacity, bucket.tokens + elapsed * refillPerMs);
        bucket.updated = now;

        if (bucket.tokens < 1) {
            const waitMs = Math.ceil((1 - bucket.tokens) / refillPerMs);
            res.setHeader('Retry-After', Math.ceil(waitMs / 1000));
            return next(
                tooManyRequests('Client rate limit exceeded. Slow down.', {
                    retry_after: Math.ceil(waitMs / 1000),
                    limit_per_minute: rateLimitPerMinute,
                    burst: capacity,
                }),
            );
        }

        bucket.tokens -= 1;
        res.setHeader('X-RateLimit-Limit', rateLimitPerMinute);
        res.setHeader('X-RateLimit-Remaining', Math.floor(bucket.tokens));
        next();
    };
}

/** Per-request timeout that aborts the handler if it overruns. */
export const createTimeout = (ms) => (req, res, next) => {
    const controller = new AbortController();
    req.signal = controller.signal;

    const timer = setTimeout(() => controller.abort(), ms);
    res.on('finish', () => clearTimeout(timer));
    res.on('close', () => clearTimeout(timer));

    next();
};
