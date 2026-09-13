'use strict';

/**
 * XBDraw image proxy — SillyTavern server plugin for 小黑生图 (XBDraw).
 *
 * 安装：把本文件夹整个复制到 SillyTavern/plugins/xbdraw-image-proxy/ ，
 *       在 config.yaml 中开启 enableServerPlugins: true ，然后重启 SillyTavern。
 *
 * 只做「代理转发」：浏览器把完整的 NovelAI 请求（url + key + payload）交给本插件，
 * 插件原样转发并把结果交回，用来绕过 CORS / 自签证书。不保存任务、不保存密钥。
 * 插件 id 以 xbdraw- 开头，和 LittleWhiteBox 的插件互不冲突，可以同时安装。
 */

const { pipeline } = require('node:stream/promises');
const {
    encodeVibe,
    fetchSubscription,
    generateImage,
    openImageStream,
    testConnection,
} = require('./providers/novelai/client.js');
const { parseTimeout } = require('./providers/upstream.js');
const pluginManifest = require('./manifest.json');

const PLUGIN_ID = 'xbdraw-image-proxy';
const PLUGIN_VERSION = pluginManifest.version;
const PLUGIN_CAPABILITIES = Object.freeze([
    'v5-msgpack-stream',
    'novelai-encode-vibe-v1',
    'novelai-subscription-v1',
]);
const LOG_PREFIX = `[${PLUGIN_ID}]`;
const DEFAULT_TIMEOUT_MS = 60000;
const NOVELAI_ENCODE_VIBE_URL = 'https://image.novelai.net/ai/encode-vibe';
const NOVELAI_SUBSCRIPTION_URL = 'https://image.novelai.net/user/subscription';
// 氛围迁移只支持 V4 / V4.5（full、curated）；V3 走原图协议，V5 不支持。
const VIBE_MODEL_PATTERN = /^nai-diffusion-4/;

const info = {
    id: PLUGIN_ID,
    name: 'XBDraw Image Proxy',
    version: PLUGIN_VERSION,
    description: 'NovelAI request proxy for XBDraw (generate, V5 stream, connection test, vibe encoding, subscription lookup).',
};

function parseUpstreamUrl(value) {
    try {
        const url = new URL(String(value || '').trim());
        return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
    } catch {
        return null;
    }
}

function parseOptionalUpstreamUrl(value, fallback) {
    if (value === undefined || value === null || String(value).trim() === '') return fallback;
    return parseUpstreamUrl(value);
}

function createRequestAbortScope(req, res) {
    const controller = new AbortController();
    let cause = null;
    let timeoutId = null;
    const abort = (nextCause) => {
        if (nextCause === 'client' || cause === null) cause = nextCause;
        if (controller.signal.aborted) return;
        controller.abort();
    };
    const abortForClient = () => abort('client');
    const abortIfIncomplete = () => {
        if (!res.writableEnded) abortForClient();
    };

    req.once('aborted', abortForClient);
    res.once('close', abortIfIncomplete);
    // SillyTavern's global middleware may finish and destroy an already complete
    // request body while the response socket is still alive. That is not a
    // client disconnect and must not suppress the route response.
    if (req.aborted || (!req.complete && req.destroyed) || res.destroyed) abortForClient();

    return {
        signal: controller.signal,
        get cause() {
            return cause;
        },
        setDeadline(timeout) {
            timeoutId = setTimeout(() => abort('timeout'), timeout);
            timeoutId.unref?.();
        },
        dispose() {
            if (timeoutId !== null) clearTimeout(timeoutId);
            req.off('aborted', abortForClient);
            res.off('close', abortIfIncomplete);
        },
    };
}

function errorMessage(error) {
    return String(error?.message || error);
}

function sendRequestError(scope, res, error, label) {
    if (scope.cause === 'client') return;
    if (scope.cause === 'timeout') {
        return res.status(200).send({ ok: false, code: 'timeout', error: 'NovelAI request timed out' });
    }
    console.error(`${LOG_PREFIX} ${label} error:`, errorMessage(error));
    return res.status(200).send({ ok: false, error: errorMessage(error) });
}

function registerGenerateRoute(router, path) {
    router.post(path, async (req, res) => {
        const scope = createRequestAbortScope(req, res);
        try {
            if (scope.signal.aborted) return;
            const body = req.body || {};
            const key = String(body.key || '').trim();
            const url = parseUpstreamUrl(body.url);
            const payload = body.payload;
            const timeout = parseTimeout(body.timeout);
            if (!key) return res.status(400).send({ ok: false, error: 'API key is required' });
            if (!url) return res.status(400).send({ ok: false, error: 'A complete HTTP(S) url is required' });
            if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
                return res.status(400).send({ ok: false, error: 'payload is required' });
            }
            if (timeout === null) return res.status(400).send({ ok: false, error: 'timeout must be a positive number' });
            scope.setDeadline(timeout);

            const result = await generateImage({
                url,
                key,
                payload,
                insecure: body.insecure === true,
                signal: scope.signal,
            });

            if (!result.ok) {
                console.warn(`${LOG_PREFIX} upstream ${result.status}: ${result.error.slice(0, 300)}`);
            }
            return res.status(200).send(result);
        } catch (error) {
            return sendRequestError(scope, res, error, path);
        } finally {
            scope.dispose();
        }
    });
}

function registerTestRoute(router, path) {
    router.post(path, async (req, res) => {
        const scope = createRequestAbortScope(req, res);
        try {
            if (scope.signal.aborted) return;
            const body = req.body || {};
            const key = String(body.key || '').trim();
            const url = parseUpstreamUrl(body.url);
            const payload = body.payload;
            const timeout = parseTimeout(body.timeout);
            if (!key) return res.status(400).send({ ok: false, error: 'API key is required' });
            if (!url) return res.status(400).send({ ok: false, error: 'A complete HTTP(S) url is required' });
            if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
                return res.status(400).send({ ok: false, error: 'payload is required' });
            }
            if (timeout === null) return res.status(400).send({ ok: false, error: 'timeout must be a positive number' });
            scope.setDeadline(timeout);

            const result = await testConnection({
                url,
                key,
                payload,
                multipart: body.multipart === true,
                insecure: body.insecure === true,
                signal: scope.signal,
            });
            return res.status(200).send(result);
        } catch (error) {
            return sendRequestError(scope, res, error, path);
        } finally {
            scope.dispose();
        }
    });
}

function normalizeVibePayload(payload) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        return { error: 'payload is required' };
    }
    const image = typeof payload.image === 'string' ? payload.image.replace(/^data:[^,]*,/, '').trim() : '';
    if (!image) return { error: 'payload.image (base64) is required' };
    const informationExtracted = Number(payload.information_extracted);
    if (!Number.isFinite(informationExtracted) || informationExtracted <= 0 || informationExtracted > 1) {
        return { error: 'payload.information_extracted must be a number in (0, 1]' };
    }
    const model = String(payload.model || '').trim();
    if (!VIBE_MODEL_PATTERN.test(model)) {
        return { error: 'Vibe encoding supports NovelAI V4 / V4.5 models only' };
    }
    return {
        payload: {
            image,
            information_extracted: Math.round(informationExtracted * 100) / 100,
            model,
        },
    };
}

function registerEncodeVibeRoute(router) {
    // 编码会扣 Anlas（每次 2）：本路由只转发一次，失败不重试。
    router.post('/v1/encode-vibe', async (req, res) => {
        const scope = createRequestAbortScope(req, res);
        try {
            if (scope.signal.aborted) return;
            const body = req.body || {};
            const key = String(body.key || '').trim();
            const url = parseOptionalUpstreamUrl(body.url, NOVELAI_ENCODE_VIBE_URL);
            const timeout = parseTimeout(body.timeout ?? DEFAULT_TIMEOUT_MS);
            if (!key) return res.status(400).send({ ok: false, error: 'API key is required' });
            if (!url) return res.status(400).send({ ok: false, error: 'A complete HTTP(S) url is required' });
            const normalized = normalizeVibePayload(body.payload);
            if (normalized.error) return res.status(400).send({ ok: false, error: normalized.error });
            if (timeout === null) return res.status(400).send({ ok: false, error: 'timeout must be a positive number' });
            scope.setDeadline(timeout);

            const result = await encodeVibe({
                url,
                key,
                payload: normalized.payload,
                insecure: body.insecure === true,
                signal: scope.signal,
            });
            if (!result.ok) {
                console.warn(`${LOG_PREFIX} encode-vibe upstream ${result.status}: ${String(result.error).slice(0, 300)}`);
            }
            return res.status(200).send(result);
        } catch (error) {
            return sendRequestError(scope, res, error, '/v1/encode-vibe');
        } finally {
            scope.dispose();
        }
    });
}

function registerSubscriptionRoute(router) {
    // 只读查询订阅档位（不扣 Anlas）。Key 走请求体，不进 URL。
    router.post('/v1/subscription', async (req, res) => {
        const scope = createRequestAbortScope(req, res);
        try {
            if (scope.signal.aborted) return;
            const body = req.body || {};
            const key = String(body.key || '').trim();
            const url = parseOptionalUpstreamUrl(body.url, NOVELAI_SUBSCRIPTION_URL);
            const timeout = parseTimeout(body.timeout ?? DEFAULT_TIMEOUT_MS);
            if (!key) return res.status(400).send({ ok: false, error: 'API key is required' });
            if (!url) return res.status(400).send({ ok: false, error: 'A complete HTTP(S) url is required' });
            if (timeout === null) return res.status(400).send({ ok: false, error: 'timeout must be a positive number' });
            scope.setDeadline(timeout);

            const result = await fetchSubscription({
                url,
                key,
                insecure: body.insecure === true,
                signal: scope.signal,
            });
            return res.status(200).send(result);
        } catch (error) {
            return sendRequestError(scope, res, error, '/v1/subscription');
        } finally {
            scope.dispose();
        }
    });
}

/**
 * @param {import('express').Router} router
 */
async function init(router) {
    router.get('/status', (_req, res) => {
        res.status(200).send({
            ok: true,
            id: info.id,
            version: PLUGIN_VERSION,
            capabilities: [...PLUGIN_CAPABILITIES],
        });
    });

    // v1 is the frozen upstream 1.0.1 contract; URL resolution deliberately
    // stays inside the client so input validation runs in its original order.
    router.post('/v1/generate-image', async (req, res) => {
        const scope = createRequestAbortScope(req, res);
        try {
            if (scope.signal.aborted) return;
            const body = req.body || {};
            const key = String(body.key || '').trim();
            const payload = body.payload;
            const timeout = parseTimeout(body.timeout);
            if (!key) return res.status(400).send({ ok: false, error: 'API key is required' });
            if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
                return res.status(400).send({ ok: false, error: 'payload is required' });
            }
            if (timeout === null) return res.status(400).send({ ok: false, error: 'timeout must be a positive number' });
            scope.setDeadline(timeout);

            const result = await generateImage({
                baseUrl: body.url,
                key,
                payload,
                insecure: body.insecure === true,
                signal: scope.signal,
            });
            if (!result.ok) {
                console.warn(`${LOG_PREFIX} upstream ${result.status}: ${result.error.slice(0, 300)}`);
            }
            return res.status(200).send(result);
        } catch (error) {
            return sendRequestError(scope, res, error, 'generate-image');
        } finally {
            scope.dispose();
        }
    });

    registerGenerateRoute(router, '/v2/generate-image');

    router.post('/v1/generate-image-stream', async (req, res) => {
        const scope = createRequestAbortScope(req, res);
        try {
            if (scope.signal.aborted) return;
            const body = req.body || {};
            const key = String(body.key || '').trim();
            const url = parseUpstreamUrl(body.url);
            const payload = body.payload;
            const timeout = parseTimeout(body.timeout);
            if (!key) return res.status(400).send('API key is required');
            if (!url) return res.status(400).send('A complete HTTP(S) url is required');
            if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
                return res.status(400).send('payload is required');
            }
            if (timeout === null) return res.status(400).send('timeout must be a positive number');
            scope.setDeadline(timeout);

            const result = await openImageStream({
                url,
                key,
                payload,
                insecure: body.insecure === true,
                signal: scope.signal,
            });
            if (!result.ok) {
                return res.status(result.status || 502).type('text/plain').send(result.error || 'NovelAI V5 request failed');
            }

            res.status(200);
            res.setHeader('Content-Type', 'application/octet-stream');
            res.setHeader('Cache-Control', 'no-store');
            await pipeline(result.response, res, { signal: scope.signal });
        } catch (error) {
            if (scope.cause === 'client') return;
            if (scope.cause === 'timeout') {
                if (!res.headersSent) res.status(504).type('text/plain').send('NovelAI request timed out');
                else res.destroy();
                return;
            }
            console.error(`${LOG_PREFIX} generate-image-stream error:`, errorMessage(error));
            if (!res.headersSent) res.status(502).type('text/plain').send(errorMessage(error));
            else res.destroy(error);
        } finally {
            scope.dispose();
        }
    });

    router.post('/v1/test', async (req, res) => {
        const scope = createRequestAbortScope(req, res);
        try {
            if (scope.signal.aborted) return;
            const body = req.body || {};
            const key = String(body.key || '').trim();
            const timeout = parseTimeout(body.timeout);
            if (!key) return res.status(400).send({ ok: false, error: 'API key is required' });
            if (timeout === null) return res.status(400).send({ ok: false, error: 'timeout must be a positive number' });
            scope.setDeadline(timeout);

            const result = await testConnection({
                baseUrl: body.url,
                key,
                insecure: body.insecure === true,
                signal: scope.signal,
            });
            return res.status(200).send(result);
        } catch (error) {
            return sendRequestError(scope, res, error, 'test');
        } finally {
            scope.dispose();
        }
    });

    registerTestRoute(router, '/v2/test');
    registerEncodeVibeRoute(router);
    registerSubscriptionRoute(router);

    console.log(`${LOG_PREFIX} server plugin initialized (v${PLUGIN_VERSION})`);
}

async function exit() {}

module.exports = { exit, info, init };
