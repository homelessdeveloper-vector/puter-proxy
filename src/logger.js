/** Structured JSON logging with token redaction. */

const SECRET_KEYS = /^(token|authorization|api[_-]?key|secret|password|auth_token|cookie)$/i;

const redactValue = (value, depth = 0) => {
    if (depth > 4) return '[depth]';
    if (value === null || typeof value !== 'object') return value;
    if (Array.isArray(value)) return value.map((v) => redactValue(v, depth + 1));
    const out = {};
    for (const [k, v] of Object.entries(value)) {
        out[k] = SECRET_KEYS.test(k) ? '[redacted]' : redactValue(v, depth + 1);
    }
    return out;
};

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
let threshold = LEVELS.info;

export const setLogLevel = (level) => {
    threshold = LEVELS[level] ?? LEVELS.info;
};

const emit = (level, msg, fields = {}) => {
    if ((LEVELS[level] ?? 0) < threshold) return;
    const line = {
        ts: new Date().toISOString(),
        level,
        msg,
        ...redactValue(fields),
    };
    const stream = level === 'error' || level === 'warn' ? process.stderr : process.stdout;
    stream.write(`${JSON.stringify(line)}\n`);
};

export const logger = {
    debug: (msg, fields) => emit('debug', msg, fields),
    info: (msg, fields) => emit('info', msg, fields),
    warn: (msg, fields) => emit('warn', msg, fields),
    error: (msg, fields) => emit('error', msg, fields),
};

/** Truncate a token for display: `eyJh…9f2c`. Never log the full value. */
export const maskToken = (token) => {
    if (!token) return null;
    const s = String(token);
    if (s.length <= 10) return '***';
    return `${s.slice(0, 4)}…${s.slice(-4)}`;
};
