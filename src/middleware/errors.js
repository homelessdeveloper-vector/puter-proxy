/**
 * Uniform error responses.
 *
 * Every response body is JSON with the same envelope, whether the failure came
 * from validation, auth, or Puter itself. Clients can switch on `error.code`
 * without parsing prose.
 */

import { ApiError, toApiError } from '../errors.js';
import { logger } from '../logger.js';

export const notFoundHandler = (req, _res, next) => {
    next(new ApiError(404, 'not_found', `No route for ${req.method} ${req.path}`));
};

// eslint-disable-next-line no-unused-vars -- Express identifies error handlers by arity
export const errorHandler = (err, req, res, _next) => {
    const apiErr = err instanceof ApiError ? err : toApiError(err);

    // 5xx is our fault or the upstream's: log with context. 4xx is the
    // client's problem and would only add noise.
    if (apiErr.status >= 500) {
        logger.error('request failed', {
            request_id: req.id,
            route: req.route?.path,
            status: apiErr.status,
            code: apiErr.code,
            message: apiErr.message,
            details: apiErr.details,
        });
    } else {
        logger.debug('request rejected', {
            request_id: req.id,
            status: apiErr.status,
            code: apiErr.code,
            message: apiErr.message,
        });
    }

    if (res.headersSent) return;

    if (apiErr.details?.retry_after) {
        res.setHeader('Retry-After', String(apiErr.details.retry_after));
    }

    res.status(apiErr.status).json({
        ok: false,
        request_id: req.id,
        error: {
            code: apiErr.code,
            message: apiErr.message,
            ...(apiErr.details ? { details: apiErr.details } : {}),
        },
    });
};
