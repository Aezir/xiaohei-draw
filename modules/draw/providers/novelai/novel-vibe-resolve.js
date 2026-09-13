// 生成前把预设里的氛围条目解析成 compiler 需要的 [{token, strength}]。
// 异步（读 IndexedDB、可能编码）；compiler.js 保持同步，只接收这里算好的结果。
// 前端发送、后端发送都走这里：发给 NovelAI 的永远是编码后的 token，不是原图。
import { getNovelVibeSupport } from './novel-model-capabilities.js';
import { getActiveNovelVibeItems } from './novel-vibe-config.js';
import { bytesToBase64, stripDataUrl } from './novel-vibe-format.js';
import { estimateVibeExtraCost } from './novel-anlas-pricing.js';

export class NovelVibeResolveError extends Error {
    constructor(message, { code, missing = [], cause } = {}) {
        super(message);
        this.name = 'NovelVibeResolveError';
        this.code = code;
        this.missing = missing;
        if (cause) this.cause = cause;
    }
}

export async function readVibeAssetImageBase64(asset) {
    const image = asset?.image;
    if (!image) return null;
    if (typeof image === 'string') return stripDataUrl(image);
    if (image instanceof Uint8Array) return bytesToBase64(image);
    if (image instanceof ArrayBuffer) return bytesToBase64(new Uint8Array(image));
    if (typeof image.arrayBuffer === 'function') return bytesToBase64(new Uint8Array(await image.arrayBuffer()));
    return null;
}

function emptyResult(notices = []) {
    return { vibes: [], missing: [], notices, encodeCost: 0, perImageExtra: 0, encodedCount: 0 };
}

/**
 * @param {object} options
 * @param {object} [options.vibes]      预设的 vibes 配置（默认取 preset.vibes）
 * @param {string} [options.model]      模型 id（默认取 preset.params.model）
 * @param {boolean} [options.allowEncode] 是否允许本次编码（默认 = vibes.autoEncode）
 * @param {object} options.store        { getEncoding, getAsset, putEncoding }
 * @param {Function} [options.encode]   ({image, informationExtracted, model, signal}) => ArrayBuffer
 * 编码失败或有未编码项且不允许编码时抛 NovelVibeResolveError —— 调用方必须中止整批。
 */
export async function resolveVibesForGeneration({
    preset,
    vibes = preset?.vibes,
    model = preset?.params?.model,
    allowEncode,
    store,
    encode,
    readAssetImage = readVibeAssetImageBase64,
    signal,
} = {}) {
    const { items, droppedOverLimit, config } = getActiveNovelVibeItems(vibes);
    if (items.length === 0) return emptyResult();

    const support = getNovelVibeSupport(model);
    if (!support.supported) return emptyResult([support.message]);

    const notices = [];
    if (droppedOverLimit > 0) {
        notices.push(`有 ${droppedOverLimit} 个氛围超过 4 个上限，本次未使用（勾选「允许超过 4 个」才会发送）`);
    }
    if (!store?.getEncoding) throw new NovelVibeResolveError('氛围存储不可用', { code: 'VIBE_STORE_UNAVAILABLE' });

    const slots = new Array(items.length);
    const missing = [];
    for (let index = 0; index < items.length; index++) {
        const item = items[index];
        const cached = await store.getEncoding(item.assetId, model, item.informationExtracted);
        if (cached?.token) {
            slots[index] = { token: cached.token, strength: item.strength, informationExtracted: item.informationExtracted, assetId: item.assetId };
        } else {
            missing.push({ index, id: item.id, assetId: item.assetId, name: item.name, informationExtracted: item.informationExtracted });
        }
    }

    const mayEncode = allowEncode ?? config.autoEncode === true;
    if (missing.length > 0 && !mayEncode) {
        throw new NovelVibeResolveError(
            `有 ${missing.length} 个氛围未编码，请先在绘图参数里点编码（2 Anlas/个）`,
            { code: 'VIBE_NOT_ENCODED', missing },
        );
    }

    let encodedCount = 0;
    for (const entry of missing) {
        if (signal?.aborted) throw new NovelVibeResolveError('已取消', { code: 'ABORTED', missing });
        const item = items[entry.index];
        try {
            if (typeof encode !== 'function') throw new Error('没有可用的编码通道');
            const asset = await store.getAsset(item.assetId);
            const image = await readAssetImage(asset);
            if (!image) throw new Error(`氛围「${item.name || item.assetId}」没有原图，无法重新编码`);
            const buffer = await encode({ image, informationExtracted: item.informationExtracted, model, signal });
            const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
            const token = bytesToBase64(bytes);
            encodedCount++;
            await store.putEncoding({
                assetId: item.assetId,
                model,
                informationExtracted: item.informationExtracted,
                token,
                bytes: bytes.byteLength,
                origin: 'api',
            });
            slots[entry.index] = { token, strength: item.strength, informationExtracted: item.informationExtracted, assetId: item.assetId };
        } catch (error) {
            throw new NovelVibeResolveError(
                `氛围编码失败，本批已中止：${error?.message || error}`,
                { code: error?.name === 'AbortError' ? 'ABORTED' : 'VIBE_ENCODE_FAILED', missing, cause: error },
            );
        }
    }

    const cost = estimateVibeExtraCost({ enabledCount: items.length, unencodedCount: encodedCount });
    return {
        vibes: slots,
        missing: [],
        notices,
        encodeCost: cost.vibeEncode,
        perImageExtra: cost.vibeOverflow,
        encodedCount,
    };
}

/** 生成前 / 卡片里的费用预估（不编码、不发请求）。 */
export async function estimateVibeCost({ preset, vibes = preset?.vibes, model = preset?.params?.model, store } = {}) {
    const { items } = getActiveNovelVibeItems(vibes);
    const support = getNovelVibeSupport(model);
    if (items.length === 0 || !support.supported) {
        return { supported: support.supported, enabled: 0, unencoded: 0, vibeEncode: 0, vibeOverflow: 0 };
    }
    let unencoded = 0;
    for (const item of items) {
        const cached = await store?.getEncoding?.(item.assetId, model, item.informationExtracted);
        if (!cached?.token) unencoded++;
    }
    const cost = estimateVibeExtraCost({ enabledCount: items.length, unencodedCount: unencoded });
    return { supported: true, enabled: items.length, unencoded, ...cost };
}
