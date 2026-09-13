// NovelAI Anlas 计价（纯函数：不碰 DOM、不发网络请求，iframe 和宿主都能 import）。
// 公式与免费规则照 docs/plans/anlas-pricing.md：从 NovelAI 官网客户端 JS 包扒出，抓取日期 2026-09-13。
// NAI 更新后可能变化；客户端算价不代表服务器实际扣费，界面应显示「约」。
import { isNovelV5Model } from './novel-model-capabilities.js';

export const ANLAS_PRICING_SOURCE_DATE = '2026-09-13';
export const OPUS_FREE_MAX_AREA = 1048576;
export const OPUS_FREE_MAX_STEPS = 28;
export const ANLAS_MAX_PER_IMAGE = 140;
export const ANLAS_MIN_PER_IMAGE = 2;
export const VIBE_ENCODE_COST = 2;
export const VIBE_OVERFLOW_COST = 2;
export const VIBE_FREE_COUNT = 4;
export const CHARACTER_REFERENCE_COST = 5;
export const OPUS_TIER = 3;
export const FREE_SIZE_PRESETS = Object.freeze([
    Object.freeze({ width: 832, height: 1216 }),
    Object.freeze({ width: 1216, height: 832 }),
    Object.freeze({ width: 1024, height: 1024 }),
]);

const AREA_COEFFICIENT = 2.951823174884865e-6;
const STEP_COEFFICIENT = 5.753298233447344e-7;

export function getNovelPricingFamily(model) {
    const id = String(model || '').trim();
    if (isNovelV5Model(id) || /^nai-diffusion-5/.test(id)) return 'v5';
    if (/^nai-diffusion-4/.test(id)) return 'v4';
    if (/^nai-diffusion-(furry-)?3/.test(id)) return 'v3';
    return 'unknown';
}

/**
 * subscription：GET /user/subscription 的结果（或 novel-subscription.js 的摘要）。
 * source === 'manual' 表示用户手动选的档位：计价可以参考，但置信度为 approx，永远不判定免费。
 */
export function normalizeSubscription(subscription) {
    if (!subscription || typeof subscription !== 'object') {
        return { known: false, manual: false, tier: null, active: false, usageNegative: null };
    }
    const tier = Number(subscription.tier);
    const known = Number.isFinite(tier);
    const negative = subscription.usage?.isNegative;
    return {
        known,
        manual: subscription.source === 'manual',
        tier: known ? tier : null,
        active: subscription.active === true,
        usageNegative: typeof negative === 'boolean' ? negative : null,
    };
}

function countCharacterRefs(value) {
    if (Array.isArray(value)) return value.length;
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? Math.floor(number) : 0;
}

function resolveSampleCount(config) {
    const raw = config.n_samples ?? config.imageCount ?? 1;
    const number = Math.floor(Number(raw));
    return Number.isFinite(number) && number > 0 ? number : 1;
}

/** 输入可以是 [{enabled, encoded}] 数组，也可以是预设 vibes 配置 {enabled, allowOver4, items}。 */
function normalizePricingVibes(vibes) {
    if (!vibes) return [];
    if (Array.isArray(vibes)) return vibes.filter(item => item && item.enabled !== false);
    if (typeof vibes === 'object') {
        if (vibes.enabled !== true) return [];
        const enabled = (Array.isArray(vibes.items) ? vibes.items : []).filter(item => item && item.enabled !== false);
        return vibes.allowOver4 === true ? enabled : enabled.slice(0, VIBE_FREE_COUNT);
    }
    return [];
}

/** Vibe 附加价（永远收费）：未编码每个 2；启用数超过 4 的部分每个 2。不乘张数。 */
export function estimateVibeExtraCost({ enabledCount = 0, unencodedCount = 0 } = {}) {
    const enabled = Math.max(0, Math.floor(Number(enabledCount) || 0));
    const unencoded = Math.min(enabled, Math.max(0, Math.floor(Number(unencodedCount) || 0)));
    return {
        vibeEncode: VIBE_ENCODE_COST * unencoded,
        vibeOverflow: VIBE_OVERFLOW_COST * Math.max(0, enabled - VIBE_FREE_COUNT),
    };
}

/** 每张图的基础价（未扣免费），以及是否超过上限。 */
export function computePerImageAnlas(config = {}) {
    const family = getNovelPricingFamily(config.model);
    const width = Number(config.width) || 0;
    const height = Number(config.height) || 0;
    const steps = Number(config.steps) || 0;
    const px = width * height;
    // XBDraw 只在 V3 请求里发送 sm / sm_dyn，所以乘数只对 V3 生效。
    const mult = family === 'v3'
        ? (config.sm && config.sm_dyn ? 1.4 : config.sm ? 1.2 : 1)
        : 1;
    let base = Math.ceil(AREA_COEFFICIENT * px + STEP_COEFFICIENT * px * steps) * mult;
    if (family === 'v5') base *= 1.5;
    const strength = config.mask
        ? (config.inpaintImg2ImgStrength ?? 1)
        : config.image ? Number(config.strength ?? 1) : 1;
    const perImage = Math.max(Math.ceil(base * strength), ANLAS_MIN_PER_IMAGE);
    return { family, perImage, invalid: perImage > ANLAS_MAX_PER_IMAGE };
}

function evaluateFreeDeduction(config, sub, family) {
    const reasons = [];
    let uncertain = false;
    const px = (Number(config.width) || 0) * (Number(config.height) || 0);
    if (!sub.known) { reasons.push('未知档位'); uncertain = true; }
    else if (sub.manual) { reasons.push('手动档位无法确认免费条件'); uncertain = true; }
    else {
        if (sub.tier < OPUS_TIER) reasons.push('不是 Opus 档位');
        if (!sub.active) reasons.push('订阅未生效');
    }
    if (px > OPUS_FREE_MAX_AREA) reasons.push(`面积>${OPUS_FREE_MAX_AREA}`);
    if ((Number(config.steps) || 0) > OPUS_FREE_MAX_STEPS) reasons.push(`步数>${OPUS_FREE_MAX_STEPS}`);
    if (countCharacterRefs(config.characterRefs) > 0) reasons.push('使用了角色参考');
    if (config.image || config.mask) reasons.push('图生图/局部重绘不免费');
    if (family === 'v5') {
        if (sub.usageNegative === true) reasons.push('V5额度已用完');
        // 额度状态未知只在「其它条件都满足、本来会免费」时才让结果变成 approx；
        // 例如 Tablet 用 V5 反正要全价，不必显示「约」。
        else if (sub.usageNegative === null) {
            if (reasons.length === 0) uncertain = true;
            reasons.push('V5额度状态未知');
        }
    }
    return { eligible: reasons.length === 0, reasons, uncertain };
}

/**
 * @param {object} config  {model, width, height, steps, n_samples|imageCount, sm, sm_dyn, image?, strength?, mask?, characterRefs?}
 * @param {object} options {subscription, vibes: [{enabled, encoded}] | 预设 vibes 配置}
 * @returns {{total, perImage, billableImages, freeImages, extra, isFree, freeReasons, confidence, invalid, family}}
 *   confidence 为 'approx'（档位未知 / 手动档位 / V5 额度未知 / 氛围编码状态未知）时永远不扣免费。
 */
export function estimateAnlasCost(config = {}, { subscription = null, vibes = null } = {}) {
    const source = config && typeof config === 'object' ? config : {};
    const sub = normalizeSubscription(subscription);
    const { family, perImage, invalid } = computePerImageAnlas(source);
    const n = resolveSampleCount(source);
    const characterRefs = countCharacterRefs(source.characterRefs);

    const free = evaluateFreeDeduction(source, sub, family);
    let confidence = free.uncertain || family === 'unknown' ? 'approx' : 'exact';
    const freeImages = free.eligible && confidence === 'exact' ? 1 : 0;
    const billableImages = Math.max(0, n - freeImages);

    const activeVibes = normalizePricingVibes(vibes ?? source.vibes);
    let vibeEncode = 0;
    let vibeOverflow = 0;
    if (family === 'v4' && characterRefs === 0 && !source.mask && activeVibes.length > 0) {
        if (activeVibes.some(item => typeof item.encoded !== 'boolean')) confidence = 'approx';
        const cost = estimateVibeExtraCost({
            enabledCount: activeVibes.length,
            unencodedCount: activeVibes.filter(item => item.encoded !== true).length,
        });
        vibeEncode = cost.vibeEncode;
        vibeOverflow = cost.vibeOverflow;
    }
    const charRef = characterRefs > 0 ? CHARACTER_REFERENCE_COST * characterRefs * n : 0;
    const total = perImage * billableImages + vibeEncode + vibeOverflow + charRef;
    const freeReasons = [...free.reasons];
    if (n > 1) freeReasons.push('n_samples>1');
    if (vibeEncode > 0) freeReasons.push('氛围需要编码');
    if (vibeOverflow > 0) freeReasons.push('氛围超过4个');

    return {
        total,
        perImage,
        billableImages,
        freeImages,
        extra: { vibeEncode, vibeOverflow, charRef },
        isFree: total === 0 && !invalid,
        freeReasons: total === 0 ? [] : freeReasons,
        confidence,
        invalid,
        family,
    };
}

function cloneConfig(config) {
    if (typeof structuredClone === 'function') return structuredClone(config);
    return JSON.parse(JSON.stringify(config));
}

function pickFreeSize(width, height) {
    const ratio = width / height;
    let best = null;
    for (const preset of FREE_SIZE_PRESETS) {
        const diff = Math.abs(Math.log(ratio / (preset.width / preset.height)));
        if (!best || diff < best.diff) best = { ...preset, diff };
    }
    if (best && best.diff <= 0.05) return { width: best.width, height: best.height };
    const scale = Math.sqrt(OPUS_FREE_MAX_AREA / (width * height));
    return {
        width: Math.max(64, Math.floor((width * scale) / 64) * 64),
        height: Math.max(64, Math.floor((height * scale) / 64) * 64),
    };
}

/**
 * 「复位」：返回一份免费配置（不改传入对象）。
 * 只动步数、尺寸、张数、角色参考、超过 4 个的氛围；绝不动 prompt / 负面词 / 角色提示词 / seed / sampler / scale。
 * possible === false 时（档位未知、手动档位、非 Opus、V5 额度用完或未知）config 原样返回、changes 为空。
 */
export function toFreeConfig(config = {}, subscription = null) {
    const next = cloneConfig(config && typeof config === 'object' ? config : {});
    const changes = [];
    const notices = [];
    const sub = normalizeSubscription(subscription);
    const family = getNovelPricingFamily(next.model);
    const blockers = [];
    if (!sub.known) blockers.push('未知档位');
    else if (sub.manual) blockers.push('手动档位无法确认免费条件');
    else if (sub.tier < OPUS_TIER || !sub.active) blockers.push('不是有效的 Opus 订阅');
    if (family === 'v5' && sub.usageNegative !== false) {
        blockers.push(sub.usageNegative === true ? 'V5额度已用完' : 'V5额度状态未知');
    }
    if (blockers.length > 0) return { config: next, changes: [], notices: blockers, possible: false };

    const change = (field, from, to) => {
        if (from !== to) changes.push({ field, from, to });
    };

    const steps = Number(next.steps) || 0;
    if (steps > OPUS_FREE_MAX_STEPS) {
        change('steps', next.steps, OPUS_FREE_MAX_STEPS);
        next.steps = OPUS_FREE_MAX_STEPS;
    }

    const width = Number(next.width) || 0;
    const height = Number(next.height) || 0;
    if (width > 0 && height > 0 && width * height > OPUS_FREE_MAX_AREA) {
        const size = pickFreeSize(width, height);
        change('width', next.width, size.width);
        change('height', next.height, size.height);
        next.width = size.width;
        next.height = size.height;
    }

    for (const field of ['n_samples', 'imageCount']) {
        if (next[field] !== undefined && Number(next[field]) !== 1) {
            change(field, next[field], 1);
            next[field] = 1;
        }
    }

    if (countCharacterRefs(next.characterRefs) > 0) {
        const empty = Array.isArray(next.characterRefs) ? [] : 0;
        change('characterRefs', countCharacterRefs(next.characterRefs), 0);
        next.characterRefs = empty;
    }

    const vibeItems = Array.isArray(next.vibes) ? next.vibes : next.vibes?.items;
    if (Array.isArray(vibeItems)) {
        let enabledSeen = 0;
        vibeItems.forEach((item, index) => {
            if (!item || item.enabled === false) return;
            enabledSeen++;
            if (enabledSeen > VIBE_FREE_COUNT) {
                change(`vibes[${index}].enabled`, true, false);
                item.enabled = false;
            } else if (item.encoded !== true) {
                notices.push(`氛围「${item.name || item.assetId || index + 1}」需要花 ${VIBE_ENCODE_COST} Anlas 编码`);
            }
        });
    }
    if (next.image || next.mask) notices.push('当前使用了图生图/局部重绘，这类生成不免费，请手动移除底图');

    return { config: next, changes, notices, possible: true };
}

function parseSizeValue(value, config) {
    if (typeof value === 'string') {
        const match = value.match(/^(\d+)\s*[x×]\s*(\d+)$/i);
        if (match) return { width: Number(match[1]), height: Number(match[2]) };
    }
    if (value && typeof value === 'object') return { width: Number(value.width), height: Number(value.height) };
    return { width: Number(config.width), height: Number(config.height) };
}

const ALWAYS_FREE_FIELDS = new Set(['sampler', 'scheduler', 'noise_schedule', 'scale', 'cfg_rescale', 'seed']);

/**
 * 某个选项取这个值时是否「免费」（给 F5 的绿色标记用）。
 * 前提：档位来自接口、tier >= 3、订阅有效；不满足一律 false（档位未知 / 手动档位不标绿）。
 */
export function isFreeOption(field, value, config = {}, subscription = null) {
    const sub = normalizeSubscription(subscription);
    if (!sub.known || sub.manual || sub.tier < OPUS_TIER || !sub.active) return false;
    const source = config && typeof config === 'object' ? config : {};
    const configFamily = getNovelPricingFamily(source.model);
    const v5Blocked = configFamily === 'v5' && sub.usageNegative !== false;

    switch (field) {
        case 'model':
            return getNovelPricingFamily(value) === 'v5' ? sub.usageNegative === false : true;
        case 'characterRef':
        case 'characterRefs':
            return false;
        default:
            break;
    }
    if (v5Blocked) return false;

    switch (field) {
        case 'size': {
            const size = parseSizeValue(value, source);
            return size.width * size.height <= OPUS_FREE_MAX_AREA;
        }
        case 'width':
            return Number(value) * (Number(source.height) || 0) <= OPUS_FREE_MAX_AREA;
        case 'height':
            return (Number(source.width) || 0) * Number(value) <= OPUS_FREE_MAX_AREA;
        case 'steps':
            return Number(value) <= OPUS_FREE_MAX_STEPS;
        case 'n_samples':
        case 'imageCount':
            return Number(value) === 1;
        case 'sm':
        case 'sm_dyn':
            return (Number(source.width) || 0) * (Number(source.height) || 0) <= OPUS_FREE_MAX_AREA;
        case 'vibe': {
            const enabledCount = Number(value?.enabledCount ?? normalizePricingVibes(source.vibes).length);
            return value?.encoded === true && enabledCount <= VIBE_FREE_COUNT;
        }
        default:
            return ALWAYS_FREE_FIELDS.has(field);
    }
}
