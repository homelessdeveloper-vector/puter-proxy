/**
 * POST /v1/execute
 *
 * The single entry point. Body shape:
 *   { "operation": "chat", "input": { ... }, "account": "acct-123" }
 *
 * `account` is optional and only honoured for admin-scoped keys; it pins the
 * request to one identity instead of letting the pool choose.
 *
 * Failover: on a retryable upstream error the request is replayed against a
 * different account, so one exhausted token doesn't take the service down.
 */

import { Router } from 'express';
import { getClient, evictClient, upstreamStatus } from '../puter/client.js';
import { toApiError, ApiError, badRequest, unavailable } from '../errors.js';
import { requireScope } from '../middleware/auth.js';
import { logger } from '../logger.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Codes worth replaying on another account. */
const RETRYABLE = new Set([
    'upstream_rate_limited',
    'upstream_quota_exhausted',
    'upstream_timeout',
    'upstream_unreachable',
    'upstream_error',
]);

export function createExecuteRouter({ config, registry, operations }) {
    const router = Router();

    router.post('/v1/execute', requireScope('execute'), async (req, res, next) => {
        const started = Date.now();
        const body = req.body ?? {};
        const operationName = body.operation;

        if (typeof operationName !== 'string' || !operationName) {
            return next(
                badRequest('"operation" is required', {
                    available: Object.keys(operations),
                }),
            );
        }

        const operation = operations[operationName];
        if (!operation) {
            return next(
                badRequest(`Unknown operation "${operationName}"`, {
                    available: Object.keys(operations),
                }),
            );
        }

        for (const scope of operation.scopes) {
            if (!req.apiKey.scopes.includes(scope)) {
                return next(
                    new ApiError(403, 'forbidden',
                        `Operation "${operationName}" requires the "${scope}" scope`,
                        { required_scopes: operation.scopes }),
                );
            }
        }

        const input = body.input ?? {};
        if (input === null || typeof input !== 'object' || Array.isArray(input)) {
            return next(badRequest('"input" must be an object'));
        }

        // Optional pinning, restricted to admin keys so tenants can't choose
        // which upstream identity their traffic is billed to.
        let pinned = null;
        if (body.account) {
            if (!req.apiKey.scopes.includes('admin')) {
                return next(
                    new ApiError(403, 'forbidden',
                        'Pinning an account requires the "admin" scope'),
                );
            }
            pinned = registry.byId.get(String(body.account));
            if (!pinned) {
                return next(
                    new ApiError(404, 'account_not_found',
                        `No account "${body.account}"`, {
                            available: registry.describe().map((a) => a.id),
                        }),
                );
            }
        }

        const maxAttempts = Math.min(config.accounts.maxAttempts, Math.max(1, registry.size));
        const tried = new Set();
        let lastError = null;

        for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
            let account = pinned;
            if (account) {
                if (tried.has(account.id)) break;
            } else {
                const picked = registry.pick({
                    exclude: tried,
                    // Pinned selection bypasses health gating by design.
                });
                if (!picked.account) {
                    if (lastError) throw lastError;
                    const err = unavailable('No healthy Puter account is available', {
                        reason: picked.reason,
                        retry_after: picked.retryAfter,
                        accounts: registry.size,
                    });
                    return next(err);
                }
                account = picked.account;
            }

            tried.add(account.id);
            registry.begin(account);

            try {
                const client = getClient(account);

                // The SDK drops the HTTP status and reports only the body, so
                // the fetch wrapper records it here for error classification.
                const store = { status: undefined, retryAfter: undefined };
                const result = await upstreamStatus.run(store, () =>
                    withDeadline(
                        operation.run(client, input, { signal: req.signal }),
                        config.limits.requestTimeoutMs,
                    ),
                );

                registry.reportSuccess(account);

                return res.status(200).json({
                    ok: true,
                    request_id: req.id,
                    operation: operationName,
                    account: { id: account.id, label: account.label },
                    data: result,
                    meta: {
                        duration_ms: Date.now() - started,
                        attempts: attempt,
                        via_proxy: client.proxy ?? null,
                    },
                });
            } catch (err) {
                const apiErr = toApiError(err, {
                    accountId: account.id,
                    upstreamStatus: upstreamStatus.getStore()?.status,
                });
                lastError = apiErr;

                // Only failures caused by the upstream may damage this
                // account's health. A client sending a malformed prompt or a
                // 200-item message array is a bad request, not a sick account;
                // penalising it would let any caller disable the whole pool.
                const isUpstreamFault = apiErr.code.startsWith('upstream_');

                if (isUpstreamFault) {
                    registry.reportFailure(
                        account,
                        apiErr.code,
                        apiErr,
                        apiErr.details?.upstream?.retryAfter ?? apiErr.details?.retry_after,
                    );

                    // A dead credential is worth dropping from the SDK cache so
                    // a rotated token takes effect without a restart.
                    if (
                        apiErr.code === 'upstream_unauthorized' ||
                        apiErr.code === 'upstream_forbidden'
                    ) {
                        evictClient(account.id);
                    }
                }

                const retryable = isUpstreamFault && RETRYABLE.has(apiErr.code);
                logger.warn('operation failed', {
                    request_id: req.id,
                    operation: operationName,
                    account: account.id,
                    attempt,
                    code: apiErr.code,
                    retryable,
                });

                // Rate limits are a global signal per account, so failing over
                // is opt-in: a caller hammering one account shouldn't silently
                // drain every other one.
                const isRateLimit = apiErr.code === 'upstream_rate_limited';
                const canRetry =
                    retryable &&
                    attempt < maxAttempts &&
                    (!isRateLimit || config.accounts.failoverOnRateLimit);

                if (!canRetry) throw apiErr;

                // Small jittered backoff before trying a different account.
                await sleep(100 * attempt + Math.random() * 100);
            } finally {
                registry.end(account);
            }
        }

        throw lastError ?? new ApiError(502, 'upstream_error', 'Operation failed');
    });

    return router;
}

/**
 * Race a promise against a deadline so a hung upstream can't pin a request
 * forever. The SDK has no abort hook, so the underlying socket may linger —
 * but the caller gets a clean 504 and the account gets cooled down.
 */
function withDeadline(promise, ms) {
    if (!ms) return promise;
    let timer;
    const deadline = new Promise((_, reject) => {
        timer = setTimeout(
            () => reject(new ApiError(504, 'upstream_timeout',
                `Upstream did not respond within ${ms}ms`)),
            ms,
        );
    });
    return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}
