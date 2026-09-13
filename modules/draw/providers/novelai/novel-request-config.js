import { getNovelModelCapability } from './novel-model-capabilities.js';
import { buildNovelV5ProbeRequest } from './novel-v5-request.js';

// 后端发送走 SillyTavern server plugin `xbdraw-image-proxy`（插件目录 server-plugin/xbdraw-image-proxy）。
// 所有插件路由（status、generate、stream、test、encode-vibe、subscription）都从这个常量拼接。
export const NAI_BACKEND_PLUGIN_ID = 'xbdraw-image-proxy';
export const NAI_BACKEND_BASE = `/api/plugins/${NAI_BACKEND_PLUGIN_ID}`;
export const NAI_BACKEND_MIN_VERSION = '3.0.0';

export function snapshotNovelRequestConfig(settings, generationConfig, defaultTimeout) {
    const timeout = Number(settings?.timeout);
    return Object.freeze({
        apiBaseUrl: String(settings?.apiBaseUrl || '').trim(),
        apiKey: String(settings?.apiKey || '').trim(),
        sendMode: settings?.sendMode === 'backend' ? 'backend' : 'frontend',
        insecureTLS: settings?.insecureTLS === true,
        timeout: Number.isFinite(timeout) && timeout > 0 ? timeout : defaultTimeout,
        overrideSize: String(generationConfig?.overrideSize ?? settings?.overrideSize ?? 'default'),
    });
}

export function resolveNovelImageTransport({ sendMode } = {}) {
    return sendMode === 'backend' ? 'backend' : 'frontend';
}

const DEFAULT_IMAGE_ORIGIN = 'https://image.novelai.net';

export function resolveNovelAIImageApi(baseUrl, transport = 'image') {
    const endpoint = transport === 'msgpack-stream' ? 'generate-image-stream' : 'generate-image';
    const raw = String(baseUrl || '').trim();
    if (!raw) return `${DEFAULT_IMAGE_ORIGIN}/ai/${endpoint}`;
    const suffixIndex = raw.search(/[?#]/);
    const path = (suffixIndex < 0 ? raw : raw.slice(0, suffixIndex)).replace(/\/+$/, '');
    const suffix = suffixIndex < 0 ? '' : raw.slice(suffixIndex);
    const resolvedPath = /\/ai\/generate-image(?:-stream)?$/i.test(path)
        ? path.replace(/\/ai\/generate-image(?:-stream)?$/i, `/ai/${endpoint}`)
        : `${path}/ai/${endpoint}`;
    return `${resolvedPath}${suffix}`;
}

export function resolveNovelAIBackendImageApi(baseUrl, transport = 'image', baseHref) {
    const resolved = resolveNovelAIImageApi(baseUrl, transport);
    try {
        const url = baseHref ? new URL(resolved, baseHref) : new URL(resolved);
        if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new TypeError();
        return url.href;
    } catch {
        throw new TypeError('NovelAI 后端发送需要可解析的完整 HTTP(S) 图片端点');
    }
}

export function buildNovelAIConnectionProbe(baseUrl, model) {
    const normalizedModel = String(model || '').trim();
    const capability = getNovelModelCapability(normalizedModel);
    const isV5 = capability.transport === 'msgpack-stream';
    return Object.freeze({
        url: resolveNovelAIImageApi(baseUrl, capability.transport),
        transport: capability.transport,
        multipart: isV5,
        payload: isV5
            ? buildNovelV5ProbeRequest(normalizedModel)
            : {
                input: 'test',
                model: 'nai-diffusion-3',
                action: 'generate',
                parameters: { width: 64, height: 64, steps: 1, n_samples: 1 },
            },
    });
}
