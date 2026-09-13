// V2：生成前的「确保氛围已编码」+ 生成参数快照。纯逻辑（不碰 DOM），宿主 novel-draw.js 调用，node 可测。
//
// 规则（execution-plan v2 §V2）：
// - 单张、批量/自动、前端发送、后端发送都先走这里；发给 NovelAI 的永远是编码后的 token，不是原图。
// - 自动编码默认关：任何启用的氛围在「当前模型 + 信息提取」下没有编码 → 直接停下并说明原因（不扣费）。
// - 编码失败 → 整批中止，不重试。
// - V3 / V5 不支持氛围：剥掉氛围继续生成，并返回提示。
import { getNovelVibeSupport } from './novel-model-capabilities.js';
import { getActiveNovelVibeItems } from './novel-vibe-config.js';
import { formatInformationExtracted } from './novel-vibe-format.js';
import { NovelVibeResolveError, resolveVibesForGeneration } from './novel-vibe-resolve.js';

const MODEL_LABELS = Object.freeze({
    'nai-diffusion-4-5-full': 'V4.5 Full',
    'nai-diffusion-4-5-curated': 'V4.5 Curated',
    'nai-diffusion-4-full': 'V4 Full',
    'nai-diffusion-4-curated-preview': 'V4 Curated',
    'nai-diffusion-5-full': 'V5 Full',
    'nai-diffusion-5-curated': 'V5 Curated',
    'nai-diffusion-3': 'V3',
    'nai-diffusion-furry-3': 'Furry V3',
});

export function getNovelModelLabel(model) {
    const id = String(model || '').trim();
    return MODEL_LABELS[id] || id || '未知模型';
}

/** 快照里只存氛围摘要：不存 token、不存原图。 */
export function summarizeVibesForSnapshot(items = []) {
    return (Array.isArray(items) ? items : []).map(item => ({
        id: String(item?.id || ''),
        assetId: String(item?.assetId || ''),
        name: String(item?.name || ''),
        strength: Number(item?.strength),
        informationExtracted: Number(item?.informationExtracted),
    }));
}

/**
 * @returns {Promise<{vibes: {token, strength, informationExtracted, assetId}[], notices: string[], summary: object[], stripped: boolean, encodedCount: number}>}
 * 抛出 NovelVibeResolveError（code: VIBE_NOT_ENCODED / VIBE_ENCODE_FAILED / ABORTED / VIBE_STORE_UNAVAILABLE）时调用方必须整批中止。
 */
export async function ensureNovelVibesEncoded({
    preset,
    vibes = preset?.vibes,
    model = preset?.params?.model,
    store,
    encode,
    allowEncode = false,
    signal,
    resolve = resolveVibesForGeneration,
} = {}) {
    const { items } = getActiveNovelVibeItems(vibes);
    const support = getNovelVibeSupport(model);
    if (items.length > 0 && !support.supported) {
        return { vibes: [], notices: [support.message], summary: [], stripped: true, encodedCount: 0 };
    }
    let result;
    try {
        result = await resolve({ vibes, model, store, encode, allowEncode: allowEncode === true, signal });
    } catch (error) {
        if (error instanceof NovelVibeResolveError && error.code === 'VIBE_NOT_ENCODED') {
            const detail = (error.missing || [])
                .map(entry => `「${entry.name || entry.assetId}」信息提取 ${formatInformationExtracted(entry.informationExtracted)}`)
                .join('、');
            throw new NovelVibeResolveError(
                `已停止生成：${error.missing?.length || 0} 个氛围在 ${getNovelModelLabel(model)} 下没有编码（${detail}）。`
                + '请在绘图参数的「氛围迁移」里点「编码」（2 Anlas/个）后再生成。',
                { code: error.code, missing: error.missing, cause: error },
            );
        }
        throw error;
    }
    const used = items.slice(0, result.vibes.length);
    return {
        vibes: result.vibes,
        notices: result.notices || [],
        summary: summarizeVibesForSnapshot(used),
        stripped: false,
        encodedCount: result.encodedCount || 0,
    };
}

function pickNumber(...values) {
    for (const value of values) {
        const number = Number(value);
        if (value !== null && value !== undefined && value !== '' && Number.isFinite(number)) return number;
    }
    return null;
}

/**
 * 生成成功后写进预览缓存的参数快照（给画廊导出用）。
 * 以实际发出的 payload 为准（尺寸覆盖、随机种子都已落定），缺的再从 request.params 补。
 * 绝不包含 API Key、端点 URL、token。
 */
export function buildNovelGenerationSnapshot({ prepared, request = {}, vibeSummary = [] } = {}) {
    const payload = prepared?.payload && typeof prepared.payload === 'object' ? prepared.payload : {};
    const p = payload.parameters && typeof payload.parameters === 'object' ? payload.parameters : {};
    const params = request?.params && typeof request.params === 'object' ? request.params : {};
    const characterPrompts = (Array.isArray(request?.characterPrompts) ? request.characterPrompts : [])
        .filter(Boolean)
        .map(item => ({
            prompt: String(item.prompt || ''),
            uc: String(item.uc || ''),
            center: item.center && typeof item.center === 'object'
                ? { x: Number(item.center.x), y: Number(item.center.y) }
                : { x: 0.5, y: 0.5 },
        }));
    return {
        version: 1,
        prompt: String(request?.scene ?? payload.input ?? ''),
        uc: String(request?.negativePrompt ?? p.negative_prompt ?? ''),
        seed: pickNumber(p.seed, params.seed),
        model: String(payload.model || params.model || ''),
        steps: pickNumber(p.steps, params.steps),
        scale: pickNumber(p.scale, params.scale),
        sampler: String(p.sampler || params.sampler || ''),
        noiseSchedule: String(p.noise_schedule || params.scheduler || ''),
        width: pickNumber(p.width, params.width),
        height: pickNumber(p.height, params.height),
        smea: (p.sm ?? params.sm) === true,
        dyn: (p.sm_dyn ?? params.sm_dyn) === true,
        cfgRescale: pickNumber(p.cfg_rescale, params.cfg_rescale, 0),
        characterPrompts,
        vibes: summarizeVibesForSnapshot(vibeSummary),
    };
}
