// 氛围迁移（Vibe Transfer）预设配置：纯函数，不碰 DOM / 网络 / IndexedDB。
// 预设里只存轻量元数据；原图和编码结果在 IndexedDB `xb_novelai_vibes`（novel-vibe-store.js）。
import { NOVEL_VIBE_FREE_COUNT, NOVEL_VIBE_MAX } from './novel-model-capabilities.js';

export const NOVEL_VIBE_DEFAULT_STRENGTH = 0.6;
export const NOVEL_VIBE_DEFAULT_INFORMATION_EXTRACTED = 1;

function clampUnit(value, fallback) {
    const number = Number(value);
    if (!Number.isFinite(number)) return fallback;
    const rounded = Math.round(number * 100) / 100;
    return Math.min(1, Math.max(0.01, rounded));
}

export function normalizeNovelVibeItem(item, index = 0) {
    const source = item && typeof item === 'object' && !Array.isArray(item) ? item : {};
    return {
        id: String(source.id || `vibe-${index + 1}`),
        assetId: String(source.assetId || '').trim(),
        name: String(source.name || ''),
        informationExtracted: clampUnit(source.informationExtracted, NOVEL_VIBE_DEFAULT_INFORMATION_EXTRACTED),
        strength: clampUnit(source.strength, NOVEL_VIBE_DEFAULT_STRENGTH),
        enabled: source.enabled !== false,
    };
}

/**
 * 预设 `vibes` 字段的唯一规范化入口（novel-draw.js normalizeParamsPreset 调用）。
 * 默认：关闭、autoEncode 关、不允许超过 4 个；条目最多 16 个，没有 assetId 的丢弃。
 */
export function normalizeNovelVibeConfig(value) {
    const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    const seen = new Set();
    const items = (Array.isArray(source.items) ? source.items : [])
        .map(normalizeNovelVibeItem)
        .filter((item) => {
            if (!item.assetId || seen.has(item.id)) return false;
            seen.add(item.id);
            return true;
        })
        .slice(0, NOVEL_VIBE_MAX);
    return {
        enabled: source.enabled === true,
        autoEncode: source.autoEncode === true,
        allowOver4: source.allowOver4 === true,
        items,
    };
}

/** 本次生成真正参与的条目：总开关开 + 条目启用；未勾「允许超过 4 个」时只取前 4 个。 */
export function getActiveNovelVibeItems(value) {
    const config = normalizeNovelVibeConfig(value);
    if (!config.enabled) return { items: [], droppedOverLimit: 0, config };
    const enabled = config.items.filter(item => item.enabled);
    const limit = config.allowOver4 ? NOVEL_VIBE_MAX : NOVEL_VIBE_FREE_COUNT;
    return {
        items: enabled.slice(0, limit),
        droppedOverLimit: Math.max(0, enabled.length - limit),
        config,
    };
}
