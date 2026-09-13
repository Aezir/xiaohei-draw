// 氛围编码接口。所有「没核实」的协议细节都关在 encodeVibeRaw() 里（vibe-plan §1）。
// 编码每次扣 2 Anlas：这里的函数只发一次请求，失败不自动重试；只在用户亲手点「编码」
// 或预设开了 autoEncode 时才会被调用。
import { NAI_BACKEND_BASE } from './novel-request-config.js';
import { base64ToBytes, stripDataUrl } from './novel-vibe-format.js';
import { supportsNovelVibe } from './novel-model-capabilities.js';

export const NOVEL_VIBE_ENCODE_CAPABILITY = 'novelai-encode-vibe-v1';
export const NOVEL_VIBE_BACKEND_ENCODE = `${NAI_BACKEND_BASE}/v1/encode-vibe`;
const DEFAULT_IMAGE_ORIGIN = 'https://image.novelai.net';

export class NovelVibeEncodeError extends Error {
    constructor(message, { code = 'unknown', status = 0, cause } = {}) {
        super(message);
        this.name = 'NovelVibeEncodeError';
        this.code = code;
        this.status = status;
        if (cause) this.cause = cause;
    }
}

function createAbortError() {
    const error = new Error('已取消');
    error.name = 'AbortError';
    return error;
}

export function resolveNovelVibeEncodeUrl(baseUrl) {
    const raw = String(baseUrl || '').trim();
    if (!raw) return `${DEFAULT_IMAGE_ORIGIN}/ai/encode-vibe`;
    const suffixIndex = raw.search(/[?#]/);
    const path = (suffixIndex < 0 ? raw : raw.slice(0, suffixIndex))
        .replace(/\/+$/, '')
        .replace(/\/ai\/(generate-image(-stream)?|encode-vibe)$/i, '');
    return `${path}/ai/encode-vibe`;
}

export function buildEncodeVibeBody({ image, informationExtracted, model } = {}) {
    const cleanImage = stripDataUrl(image);
    if (!cleanImage) throw new NovelVibeEncodeError('氛围图为空，无法编码', { code: 'input' });
    const ie = Number(informationExtracted);
    if (!Number.isFinite(ie) || ie <= 0 || ie > 1) {
        throw new NovelVibeEncodeError('信息提取（IE）必须在 0.01～1 之间', { code: 'input' });
    }
    const modelId = String(model || '').trim();
    if (!supportsNovelVibe(modelId)) {
        throw new NovelVibeEncodeError('氛围编码只支持 NovelAI V4 / V4.5 模型', { code: 'unsupported_model' });
    }
    return { image: cleanImage, information_extracted: Math.round(ie * 100) / 100, model: modelId };
}

function errorFromStatus(status, detail = '') {
    const suffix = detail ? `：${String(detail).slice(0, 200)}` : '';
    if (status === 401) return new NovelVibeEncodeError('API Key 无效（编码失败）', { code: 'auth', status });
    if (status === 402 || status === 403) {
        return new NovelVibeEncodeError(`Anlas 不足或没有权限（编码失败）${suffix}`, { code: 'quota', status });
    }
    return new NovelVibeEncodeError(`氛围编码失败（HTTP ${status}）${suffix}`, { code: 'http', status });
}

/**
 * 浏览器直连 NovelAI 编码。返回 ArrayBuffer（原始 vibe token）。
 * 网络 / CORS 失败抛 code === 'network'，调用方据此决定是否改走插件。
 */
export async function encodeVibeRaw({
    image,
    informationExtracted,
    model,
    apiBaseUrl,
    apiKey,
    signal,
    fetchImpl = globalThis.fetch,
} = {}) {
    const key = String(apiKey || '').trim();
    if (!key) throw new NovelVibeEncodeError('请先配置 API Key', { code: 'auth' });
    const body = buildEncodeVibeBody({ image, informationExtracted, model });
    if (signal?.aborted) throw createAbortError();
    let response;
    try {
        response = await fetchImpl(resolveNovelVibeEncodeUrl(apiBaseUrl), {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${key}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(body),
            signal,
        });
    } catch (error) {
        if (signal?.aborted || error?.name === 'AbortError') throw createAbortError();
        throw new NovelVibeEncodeError('浏览器直连编码失败（网络或 CORS）', { code: 'network', cause: error });
    }
    if (!response.ok) {
        throw errorFromStatus(response.status, await response.text().catch(() => ''));
    }
    const buffer = await response.arrayBuffer();
    if (!buffer || buffer.byteLength === 0) {
        throw new NovelVibeEncodeError('NovelAI 返回了空的编码结果', { code: 'empty' });
    }
    return buffer;
}

/** 通过 xbdraw-image-proxy 插件编码。返回 ArrayBuffer。 */
export async function encodeVibeViaBackend({
    image,
    informationExtracted,
    model,
    apiBaseUrl,
    apiKey,
    insecure = false,
    timeout = 60000,
    signal,
    fetchImpl = globalThis.fetch,
    getHeaders = () => ({ 'Content-Type': 'application/json' }),
} = {}) {
    const key = String(apiKey || '').trim();
    if (!key) throw new NovelVibeEncodeError('请先配置 API Key', { code: 'auth' });
    const payload = buildEncodeVibeBody({ image, informationExtracted, model });
    if (signal?.aborted) throw createAbortError();
    let response;
    try {
        response = await fetchImpl(NOVEL_VIBE_BACKEND_ENCODE, {
            method: 'POST',
            headers: getHeaders(),
            body: JSON.stringify({
                url: resolveNovelVibeEncodeUrl(apiBaseUrl),
                key,
                insecure: insecure === true,
                timeout,
                payload,
            }),
            signal,
        });
    } catch (error) {
        if (signal?.aborted || error?.name === 'AbortError') throw createAbortError();
        throw new NovelVibeEncodeError('插件编码请求失败（酒馆服务器不可达）', { code: 'plugin_unreachable', cause: error });
    }
    if (response.status === 404) {
        throw new NovelVibeEncodeError('插件没有编码路由：请安装 xbdraw-image-proxy 3.0.0 并开启 enableServerPlugins', { code: 'plugin_missing', status: 404 });
    }
    const data = await response.json().catch(() => null);
    if (!response.ok || data?.ok !== true) {
        if (Number.isInteger(data?.status)) throw errorFromStatus(data.status, data.error);
        if (data?.code === 'timeout') throw new NovelVibeEncodeError('编码请求超时', { code: 'timeout' });
        throw new NovelVibeEncodeError(data?.error || `插件编码失败（HTTP ${response.status}）`, { code: 'plugin_error', status: response.status });
    }
    if (typeof data.base64 !== 'string' || !data.base64) {
        throw new NovelVibeEncodeError('插件返回了空的编码结果', { code: 'empty' });
    }
    const bytes = base64ToBytes(data.base64);
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

/**
 * 按发送模式选择编码通道：
 * - sendMode 'backend'：直接走插件。
 * - 其它：浏览器直连；只有网络/CORS 失败且插件声明了 novelai-encode-vibe-v1 才改走插件。
 *   HTTP 错误（401/402/…）不换通道、不重试，避免重复扣费。
 * 返回 { buffer, via: 'direct' | 'plugin' }。
 */
export async function encodeVibe({ sendMode = 'frontend', hasBackendCapability = async () => false, ...options } = {}) {
    if (sendMode === 'backend') {
        return { buffer: await encodeVibeViaBackend(options), via: 'plugin' };
    }
    try {
        return { buffer: await encodeVibeRaw(options), via: 'direct' };
    } catch (error) {
        if (error?.code !== 'network' || options.signal?.aborted) throw error;
        let capable = false;
        try {
            capable = await hasBackendCapability(NOVEL_VIBE_ENCODE_CAPABILITY);
        } catch {
            capable = false;
        }
        if (!capable) {
            throw new NovelVibeEncodeError('浏览器直连编码失败（网络或 CORS），请安装 xbdraw-image-proxy 插件后改用后端发送', { code: 'network', cause: error });
        }
        return { buffer: await encodeVibeViaBackend(options), via: 'plugin' };
    }
}
