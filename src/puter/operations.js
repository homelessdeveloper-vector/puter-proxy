/**
 * Operation layer: a small, validated vocabulary that maps onto Puter drivers.
 *
 * The public API never exposes arbitrary driver calls. `generic` exists but is
 * gated behind an allowlist and an admin scope, because a raw driver call can
 * reach the filesystem and the KV store of the backing account.
 */

import { badRequest, ApiError } from '../errors.js';

/** Normalise a chat result into plain JSON. */
function shapeChatResult(result) {
    if (!result || typeof result !== 'object') {
        return { content: String(result ?? ''), raw: null };
    }

    // With `ai.normalize = true` this is the OpenAI shape.
    const message = result.message ?? null;
    const content =
        typeof message?.content === 'string'
            ? message.content
            : Array.isArray(message?.content)
                ? message.content
                    .map((p) => (typeof p === 'string' ? p : p?.text ?? ''))
                    .join('')
                : typeof result.text === 'string'
                    ? result.text
                    : '';

    return {
        content,
        role: message?.role ?? 'assistant',
        model: result.model ?? null,
        usage: result.usage ?? null,
        finish_reason: result.finish_reason ?? null,
        tool_calls: message?.tool_calls ?? undefined,
        _native: content ? undefined : result,
    };
}

const asString = (v, field, { required = true, max = 200_000 } = {}) => {
    if (v === undefined || v === null) {
        if (required) throw badRequest(`"${field}" is required`);
        return undefined;
    }
    if (typeof v !== 'string') throw badRequest(`"${field}" must be a string`);
    if (required && !v.trim()) throw badRequest(`"${field}" must not be empty`);
    if (v.length > max) {
        throw badRequest(`"${field}" exceeds ${max} characters`);
    }
    return v;
};

const asNumber = (v, field, { min, max } = {}) => {
    if (v === undefined || v === null) return undefined;
    const n = typeof v === 'number' ? v : Number(v);
    if (!Number.isFinite(n)) throw badRequest(`"${field}" must be a number`);
    if (min !== undefined && n < min) throw badRequest(`"${field}" must be >= ${min}`);
    if (max !== undefined && n > max) throw badRequest(`"${field}" must be <= ${max}`);
    return n;
};

const asMessages = (input) => {
    if (typeof input === 'string') return [{ role: 'user', content: input }];
    if (!Array.isArray(input) || input.length === 0) {
        throw badRequest('"messages" must be a non-empty array or a string');
    }
    if (input.length > 200) throw badRequest('"messages" cannot exceed 200 entries');

    return input.map((m, i) => {
        if (!m || typeof m !== 'object') {
            throw badRequest(`messages[${i}] must be an object`);
        }
        const role = m.role ?? 'user';
        if (!['system', 'user', 'assistant', 'tool', 'developer'].includes(role)) {
            throw badRequest(`messages[${i}].role "${role}" is not supported`);
        }
        if (typeof m.content !== 'string' && !Array.isArray(m.content)) {
            throw badRequest(`messages[${i}].content must be a string or content-part array`);
        }
        return { role, content: m.content };
    });
};

/**
 * Operation definitions.
 *
 * Each entry validates its input and returns a runner. Keeping validation and
 * execution together makes it impossible to add an op without a guard.
 */
export function buildOperations(config) {
    const defaultModel = config.puter.defaultModel;
    const maxTokensCap = config.puter.maxTokensCap;

    return {
        chat: {
            scopes: ['execute'],
            description: 'Chat completion via any model in the Puter AI gateway.',
            async run(client, input) {
                const messages = asMessages(input.messages ?? input.prompt);
                const model = input.model ? String(input.model) : defaultModel;
                const temperature = asNumber(input.temperature, 'temperature', { min: 0, max: 2 });
                const maxTokens = asNumber(input.max_tokens, 'max_tokens', {
                    min: 1,
                    max: maxTokensCap,
                });

                if (input.stream) {
                    throw badRequest(
                        'Streaming is not supported on this endpoint. Use the non-streaming JSON form.',
                    );
                }

                const options = { model };
                if (temperature !== undefined) options.temperature = temperature;
                if (maxTokens !== undefined) options.max_tokens = maxTokens;
                if (Array.isArray(input.tools)) options.tools = input.tools;
                if (input.response !== undefined) options.response = input.response;

                const started = Date.now();
                const result = await client.puter.ai.chat(messages, options);
                const shaped = shapeChatResult(result);

                return {
                    operation: 'chat',
                    model,
                    ...shaped,
                    latency_ms: Date.now() - started,
                };
            },
        },

        image: {
            scopes: ['execute'],
            description: 'Text-to-image generation. Returns a URL or data URI.',
            async run(client, input) {
                const prompt = asString(input.prompt, 'prompt', { max: 8000 });
                const options = { prompt };
                if (input.model) options.model = String(input.model);

                const result = await client.puter.ai.txt2img(options);
                const url = typeof result === 'string' ? result : result?.src ?? String(result);

                return { operation: 'image', model: input.model ?? null, url };
            },
        },

        speech: {
            scopes: ['execute'],
            description: 'Text-to-speech synthesis.',
            async run(client, input) {
                const text = asString(input.text ?? input.prompt, 'text', { max: 20_000 });
                const options = {};
                if (input.voice) options.voice = String(input.voice);
                if (input.engine) options.engine = String(input.engine);
                if (input.model) options.model = String(input.model);

                const result = await client.puter.ai.txt2speech(text, options);
                const url = typeof result === 'string' ? result : result?.src ?? String(result);

                return { operation: 'speech', url };
            },
        },

        transcribe: {
            scopes: ['execute'],
            description: 'Speech-to-text from an audio URL.',
            async run(client, input) {
                const audio = asString(input.audio_url ?? input.url, 'audio_url');
                const options = {};
                if (input.model) options.model = String(input.model);

                const result = await client.puter.ai.speech2txt(audio, options);
                const text =
                    typeof result === 'string'
                        ? result
                        : result?.text ?? result?.message?.content ?? JSON.stringify(result);

                return { operation: 'transcribe', text };
            },
        },

        ocr: {
            scopes: ['execute'],
            description: 'Extract text from an image URL.',
            async run(client, input) {
                const image = asString(input.image_url ?? input.url, 'image_url');
                const result = await client.puter.ai.img2txt(image);
                const text =
                    typeof result === 'string'
                        ? result
                        : result?.text ?? JSON.stringify(result);

                return { operation: 'ocr', text };
            },
        },

        models: {
            scopes: ['execute'],
            description: 'List models available to this account.',
            async run(client, input) {
                const models = await client.puter.ai.listModels();
                return {
                    operation: 'models',
                    count: Array.isArray(models) ? models.length : null,
                    models,
                };
            },
        },

        'kv:get': {
            scopes: ['execute'],
            description: 'Read a key from the account KV store.',
            async run(client, input) {
                const key = asString(input.key, 'key', { max: 1024 });
                const value = await client.puter.kv.get(key);
                return { operation: 'kv:get', key, value: value ?? null };
            },
        },

        'kv:set': {
            scopes: ['execute'],
            description: 'Write a key to the account KV store.',
            async run(client, input) {
                const key = asString(input.key, 'key', { max: 1024 });
                if (input.value === undefined) throw badRequest('"value" is required');
                await client.puter.kv.set(key, input.value);
                return { operation: 'kv:set', key, ok: true };
            },
        },

        'fs:list': {
            scopes: ['execute'],
            description: 'List a directory in the account cloud filesystem.',
            async run(client, input) {
                const path = input.path ? String(input.path) : '/';
                const items = await client.puter.fs.readdir(path);
                return {
                    operation: 'fs:list',
                    path,
                    items: (items ?? []).map((i) => ({
                        name: i.name,
                        path: i.path,
                        is_dir: i.is_dir,
                        size: i.size,
                    })),
                };
            },
        },

        'fs:write': {
            scopes: ['execute'],
            description: 'Write a text file to the account cloud filesystem.',
            async run(client, input) {
                const path = asString(input.path, 'path', { max: 4096 });
                const content = asString(input.content, 'content', { required: false });
                const file = await client.puter.fs.write(path, content ?? '');
                return {
                    operation: 'fs:write',
                    path: file?.path ?? path,
                    size: file?.size ?? null,
                    ok: true,
                };
            },
        },

        generic: {
            scopes: ['execute', 'admin'],
            description:
                'Raw driver call, restricted to an allowlist. Admin scope required.',
            async run(client, input) {
                const iface = asString(input.iface, 'iface');
                const method = asString(input.method, 'method');

                if (!ALLOWED_INTERFACES.has(iface)) {
                    throw new ApiError(403, 'interface_not_allowed',
                        `Driver interface "${iface}" is not on the allowlist`,
                        { allowed: [...ALLOWED_INTERFACES] });
                }

                const envelope = await client.puter.drivers.call(iface, method, input.args ?? {});
                return { operation: 'generic', iface, method, envelope };
            },
        },
    };
}

/**
 * Interfaces safe to reach through `generic`. Anything that can read or
 * destroy account state (fs, kv, auth, ipc, ui) is deliberately absent.
 */
const ALLOWED_INTERFACES = new Set([
    'puter-chat-completion',
    'puter-image-generation',
    'puter-tts',
    'puter-speech2txt',
    'puter-speech2speech',
    'puter-ocr',
    'puter-video-generation',
]);

export const OPERATION_NAMES = [
    'chat',
    'image',
    'speech',
    'transcribe',
    'ocr',
    'models',
    'kv:get',
    'kv:set',
    'fs:list',
    'fs:write',
    'generic',
];
