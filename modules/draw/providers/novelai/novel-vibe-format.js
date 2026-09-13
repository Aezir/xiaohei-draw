// .naiv4vibe 解析/生成 + base64 / sha256 小工具。纯函数，浏览器和 node 都能用。
//
// 未核实（vibe-plan §1 第 8 条）：`encodings` 下的模型键名和模型 id 的对应关系。
// 下面的映射表来自社区样本推断；认不出的键原样保留，但不参与生成。

export const NAIV4VIBE_IDENTIFIER = 'novelai-vibe-transfer';

export const NAIV4VIBE_MODEL_KEYS = Object.freeze({
    'v4full': 'nai-diffusion-4-full',
    'v4curated': 'nai-diffusion-4-curated-preview',
    'v4-5full': 'nai-diffusion-4-5-full',
    'v4-5curated': 'nai-diffusion-4-5-curated',
});

export function modelFromVibeKey(key) {
    return NAIV4VIBE_MODEL_KEYS[String(key || '').trim()] || null;
}

export function vibeKeyFromModel(model) {
    const target = String(model || '').trim();
    return Object.keys(NAIV4VIBE_MODEL_KEYS).find(key => NAIV4VIBE_MODEL_KEYS[key] === target) || null;
}

export function stripDataUrl(value) {
    return String(value || '').replace(/^data:[^,]*,/, '').trim();
}

export function bytesToBase64(input) {
    const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
    if (typeof Buffer !== 'undefined') return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64');
    let binary = '';
    const chunk = 0x8000;
    for (let offset = 0; offset < bytes.length; offset += chunk) {
        binary += String.fromCharCode(...bytes.subarray(offset, offset + chunk));
    }
    return btoa(binary);
}

export function base64ToBytes(base64) {
    const clean = stripDataUrl(base64);
    if (typeof Buffer !== 'undefined') return new Uint8Array(Buffer.from(clean, 'base64'));
    const binary = atob(clean);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
}

export async function sha256Hex(input) {
    const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : input;
    const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
    return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
}

export function formatInformationExtracted(value) {
    return (Math.round(Number(value) * 100) / 100).toFixed(2);
}

/** 编码缓存键：原图 + 模型 + IE 三者完全一致才算命中。 */
export function makeVibeEncodingKey(assetId, model, informationExtracted) {
    return `${String(assetId)}|${String(model)}|${formatInformationExtracted(informationExtracted)}`;
}

function toNumberOr(value, fallback) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
}

/**
 * 解析 .naiv4vibe（JSON 文本或对象）。
 * 返回 { asset, encodings: [{modelKey, model|null, informationExtracted, token}], unknownModelKeys, defaults }。
 */
export function parseNaiv4Vibe(input) {
    let data = input;
    if (typeof input === 'string') {
        try {
            data = JSON.parse(input);
        } catch {
            throw new TypeError('.naiv4vibe 不是有效的 JSON');
        }
    }
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new TypeError('.naiv4vibe 内容无效');
    if (data.identifier && data.identifier !== NAIV4VIBE_IDENTIFIER) {
        throw new TypeError(`不认识的 .naiv4vibe 标识：${data.identifier}`);
    }
    const encodings = [];
    const unknownModelKeys = [];
    const rawEncodings = data.encodings && typeof data.encodings === 'object' ? data.encodings : {};
    for (const [modelKey, entries] of Object.entries(rawEncodings)) {
        const model = modelFromVibeKey(modelKey);
        if (!model && !unknownModelKeys.includes(modelKey)) unknownModelKeys.push(modelKey);
        const list = entries && typeof entries === 'object'
            ? (Array.isArray(entries) ? entries : Object.values(entries))
            : [];
        for (const entry of list) {
            const token = typeof entry?.encoding === 'string' ? entry.encoding : '';
            if (!token) continue;
            encodings.push({
                modelKey,
                model,
                informationExtracted: toNumberOr(entry?.params?.information_extracted, 1),
                token,
            });
        }
    }
    const importInfo = data.importInfo && typeof data.importInfo === 'object' ? data.importInfo : {};
    return {
        asset: {
            assetId: typeof data.id === 'string' && data.id ? data.id : null,
            name: String(data.name || ''),
            imageBase64: typeof data.image === 'string' && data.image ? stripDataUrl(data.image) : null,
            thumbnail: typeof data.thumbnail === 'string' && data.thumbnail ? data.thumbnail : null,
            source: 'naiv4vibe',
            createdAt: toNumberOr(data.createdAt, 0),
        },
        encodings,
        unknownModelKeys,
        defaults: {
            strength: toNumberOr(importInfo.strength, 0.6),
            informationExtracted: toNumberOr(importInfo.information_extracted, 1),
            modelKey: importInfo.model ? String(importInfo.model) : null,
        },
    };
}

/** 生成 .naiv4vibe 对象（与 parseNaiv4Vibe 往返一致）。 */
export function buildNaiv4Vibe({ asset = {}, encodings = [], defaults = {} } = {}) {
    const grouped = {};
    for (const encoding of encodings) {
        const modelKey = encoding.modelKey || vibeKeyFromModel(encoding.model);
        if (!modelKey || !encoding.token) continue;
        const ie = formatInformationExtracted(encoding.informationExtracted ?? 1);
        grouped[modelKey] ||= {};
        grouped[modelKey][ie] = {
            encoding: encoding.token,
            params: { information_extracted: Number(ie) },
        };
    }
    const result = {
        identifier: NAIV4VIBE_IDENTIFIER,
        version: 1,
        type: 'image',
        id: asset.assetId || undefined,
        name: asset.name || '',
        createdAt: asset.createdAt || 0,
        encodings: grouped,
        importInfo: {
            model: defaults.modelKey || null,
            information_extracted: Number(defaults.informationExtracted ?? 1),
            strength: Number(defaults.strength ?? 0.6),
        },
    };
    if (asset.imageBase64) result.image = asset.imageBase64;
    if (asset.thumbnail) result.thumbnail = asset.thumbnail;
    return result;
}
