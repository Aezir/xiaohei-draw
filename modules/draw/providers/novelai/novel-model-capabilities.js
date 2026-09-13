export const NOVEL_MODEL_IDS = Object.freeze({
    V5_FULL: 'nai-diffusion-5-full',
    V5_CURATED: 'nai-diffusion-5-curated',
});

export const NOVEL_PROMPT_GUIDES = Object.freeze({
    V45: 'v4.5',
    V5: 'v5',
});

export const NOVEL_V5_MAX_CHARACTERS = 22;

const LEGACY_CAPABILITY = Object.freeze({
    family: 'legacy',
    transport: 'image',
    promptGuide: NOVEL_PROMPT_GUIDES.V45,
    centerMode: 'grid',
    maxCharactersPerImage: 0,
    supportsV5Presets: false,
    supportsTransparentBackground: false,
});

const V5_CAPABILITY = Object.freeze({
    family: 'v5',
    transport: 'msgpack-stream',
    promptGuide: NOVEL_PROMPT_GUIDES.V5,
    centerMode: 'normalized',
    maxCharactersPerImage: NOVEL_V5_MAX_CHARACTERS,
    supportsV5Presets: true,
    supportsTransparentBackground: true,
});

const V5_MODELS = new Set(Object.values(NOVEL_MODEL_IDS));

/**
 * V5 is an external protocol boundary, so it is enabled only for model IDs
 * confirmed against NovelAI's production client. Custom and older IDs keep
 * the established JSON/ZIP path.
 */
export function getNovelModelCapability(model) {
    return V5_MODELS.has(String(model || '').trim()) ? V5_CAPABILITY : LEGACY_CAPABILITY;
}

export function isNovelV5Model(model) {
    return getNovelModelCapability(model).family === 'v5';
}

// ── 氛围迁移（Vibe Transfer）能力：只支持 V4 / V4.5（full、curated）。
// V5 不支持；V3 走另一套「原图 + information_extracted」协议，不在本期范围。两者都剥掉氛围并提示。
export const NOVEL_VIBE_MAX = 16;
export const NOVEL_VIBE_FREE_COUNT = 4;

export function supportsNovelVibe(model) {
    return /^nai-diffusion-4/.test(String(model || '').trim());
}

export function getNovelVibeSupport(model) {
    const id = String(model || '').trim();
    if (supportsNovelVibe(id)) return { supported: true, reason: '', message: '' };
    if (isNovelV5Model(id) || /^nai-diffusion-5/.test(id)) {
        return { supported: false, reason: 'v5', message: 'V5 不支持氛围迁移，本次已忽略' };
    }
    return { supported: false, reason: 'unsupported', message: '当前模型不支持氛围迁移（仅 V4 / V4.5），本次已忽略' };
}

export function getNovelModelCapabilitiesForUi() {
    return Object.fromEntries(
        Object.values(NOVEL_MODEL_IDS).map(model => [model, { ...getNovelModelCapability(model) }]),
    );
}
