/**
 * Error taxonomy.
 *
 * Every failure leaving this server is an `ApiError` with a stable machine
 * `code`, an HTTP status, and extra JSON-safe detail. Upstream (Puter) errors
 * are translated here rather than leaking raw SDK shapes to clients.
 */

export class ApiError extends Error {
    /**
     * @param {number} status HTTP status
     * @param {string} code stable machine-readable code
     * @param {string} message human-readable message
     * @param {Record<string, unknown>} [details] extra JSON-safe fields
     */
    constructor(status, code, message, details = {}) {
        super(message);
        this.name = 'ApiError';
        this.status = status;
        this.code = code;
        this.details = details;
        this.expose = true;
    }
}

export const badRequest = (message, details) =>
    new ApiError(400, 'invalid_request', message, details);

export const unauthorized = (message = 'Missing or invalid API key', details) =>
    new ApiError(401, 'unauthorized', message, details);

export const forbidden = (message = 'Insufficient scope', details) =>
    new ApiError(403, 'forbidden', message, details);

export const notFound = (message = 'Not found', details) =>
    new ApiError(404, 'not_found', message, details);

export const tooManyRequests = (message = 'Rate limit exceeded', details) =>
    new ApiError(429, 'rate_limited', message, details);

export const upstreamError = (message, details) =>
    new ApiError(502, 'upstream_error', message, details);

export const timeout = (message = 'Upstream request timed out', details) =>
    new ApiError(504, 'upstream_timeout', message, details);

export const unavailable = (message = 'No healthy upstream account available', details) =>
    new ApiError(503, 'no_account_available', message, details);

/**
 * Puter surfaces failures as plain objects (`{ status, message }`,
 * `{ code, message }`, or the raw response envelope), not Error instances.
 * Normalise whatever arrives on `catch` into a predictable descriptor.
 *
 * @param {unknown} err
 * @returns {{ status?: number, code?: string, message: string, retryAfter?: number }}
 */
export function describeUpstreamError(err) {
    if (!err || typeof err !== 'object') {
        return { message: typeof err === 'string' ? err : 'Unknown upstream error' };
    }

    const e = /** @type {Record<string, any>} */ (err);

    // Nested envelope: { error: { message, code } }
    const nested = e.error && typeof e.error === 'object' ? e.error : null;
    const source = nested ?? e;

    const status =
        numberOrUndefined(e.status) ??
        numberOrUndefined(e.statusCode) ??
        numberOrUndefined(source.status) ??
        numberOrUndefined(source.status_code);

    const code =
        stringOrUndefined(source.code) ?? stringOrUndefined(e.code) ?? undefined;

    let message =
        stringOrUndefined(source.message) ??
        stringOrUndefined(e.message) ??
        (typeof err === 'string' ? err : 'Upstream request failed');

    // The SDK's 401 carries a deliberately generic "Unauthorized"; the body's
    // `reason` is far more actionable ("session_expired", "token_revoked").
    const reason = stringOrUndefined(source.reason);
    if (reason && status === 401) {
        message = `Unauthorized (${reason})`;
    }

    const retryAfter = parseRetryAfter(
        e.retry_after ?? source.retry_after ?? source.retryAfter,
    );

    return { status, code, message, retryAfter };
}

const numberOrUndefined = (v) =>
    typeof v === 'number' && Number.isFinite(v) ? v : undefined;

const stringOrUndefined = (v) => (typeof v === 'string' && v ? v : undefined);

const parseRetryAfter = (v) => {
    if (typeof v === 'number' && Number.isFinite(v)) return Math.max(0, Math.ceil(v));
    if (typeof v === 'string') {
        const asNumber = Number(v);
        if (Number.isFinite(asNumber)) return Math.max(0, Math.ceil(asNumber));
        const asDate = Date.parse(v);
        if (Number.isFinite(asDate)) {
            return Math.max(0, Math.ceil((asDate - Date.now()) / 1000));
        }
    }
    return undefined;
};

/**
 * Translate an upstream failure into a client-facing `ApiError`.
 *
 * @param {unknown} err
 * @param {{ accountId?: string, upstreamStatus?: number }} [context]
 * @returns {ApiError}
 */
export function toApiError(err, context = {}) {
    if (err instanceof ApiError) return err;

    const d = describeUpstreamError(err);
    const accountId = context.accountId;

    // The SDK reports failures as a body and discards the status, so the real
    // code is captured out-of-band by the fetch wrapper. Without it a 429 is
    // indistinguishable from a generic 400 and would be misclassified.
    const status = d.status ?? context.upstreamStatus;

    // Message text is a fallback signal when neither source gives a status.
    const lower = d.message.toLowerCase();

    if (status === 401) {
        return new ApiError(401, 'upstream_unauthorized',
            'Puter rejected the credential for this account. The token is expired or revoked; rotate it.',
            { upstream: { ...d, status, message: d.message }, account: accountId });
    }

    if (status === 402 || lower.includes('upgrade') || lower.includes('insufficient')) {
        return new ApiError(402, 'upstream_quota_exhausted',
            'The Puter account backing this request is out of credits or requires an upgrade.',
            { upstream: { ...d, status }, account: accountId });
    }

    if (status === 403) {
        return new ApiError(403, 'upstream_forbidden',
            'Puter refused the operation for this account (permission or policy).',
            { upstream: { ...d, status }, account: accountId });
    }

    if (status === 429 || lower.includes('rate limit') || lower.includes('too many')) {
        return new ApiError(429, 'upstream_rate_limited',
            'Puter rate-limited this account. Retry after the indicated delay.',
            { upstream: { ...d, status }, account: accountId, retry_after: d.retryAfter ?? 5 });
    }

    if (status === 404) {
        return new ApiError(404, 'upstream_not_found',
            'The requested upstream resource or model was not found.',
            { upstream: { ...d, status }, account: accountId });
    }

    if (status && status >= 400 && status < 500) {
        return new ApiError(400, 'upstream_rejected',
            d.message, { upstream: { ...d, status }, account: accountId });
    }

    if (status && status >= 500) {
        return new ApiError(502, 'upstream_error',
            'Puter returned a server error. The operation may be retried.',
            { upstream: { ...d, status }, account: accountId });
    }

    if (lower.includes('timed out') || lower.includes('aborted')) {
        return new ApiError(504, 'upstream_timeout',
            'The upstream request timed out.',
            { upstream: d, account: accountId });
    }

    if (lower.includes('fetch failed') || lower.includes('network')) {
        return new ApiError(502, 'upstream_unreachable',
            'Could not reach the Puter API. Check outbound connectivity or the account proxy.',
            { upstream: d, account: accountId });
    }

    return new ApiError(502, 'upstream_error', d.message,
        { upstream: d, account: accountId });
}
