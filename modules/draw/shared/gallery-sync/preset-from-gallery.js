// 画廊图片记录 → XBDraw 参数预设（纯函数，G1「从画廊导入」用，不碰 DOM、不发请求）。
// 字段对照：docs/plans/gallery-plan-v1.md §4（v2 仍有效）。原则：
//   - 能对上的字段按表映射；对不上的不偷偷丢，全部列进 unsupported 让界面展示。
//   - V5 的 tag_hint_qt / tag_hint_uc_preset / quality_boost / straight_alpha 取值还没核实（decisions 第 5 条：不读 .docu 样本），
//     不猜映射，原样放进 preset.source.v5Hints，并在 unsupported 里标出来。
//   - 角色提示词 nai.chars 不进预设（XBDraw 预设没有角色位置），单独返回 characters 给「存为角色标签」用。
//   - preset.source = {kind:'nai-gallery', id, varIndex} 用来去重（novel-draw.js 的 normalizeParamsPreset 需保留 source，见 G1b 改动清单）。

export const GALLERY_SOURCE_KIND = 'nai-gallery';
export const XB_MODEL_BY_GALLERY_LABEL = Object.freeze({ V5: 'nai-diffusion-5-full', 'V4.5': 'nai-diffusion-4-5-full' });
// 和 novel-draw.js DEFAULT_PARAMS_PRESET.params 一致（测试里有只读对照）
export const XB_DEFAULT_PARAMS = Object.freeze({
    model: 'nai-diffusion-4-5-full', sampler: 'k_euler_ancestral', scheduler: 'karras',
    steps: 28, scale: 6, width: 1216, height: 832, seed: -1,
});
export const V5_HINT_KEYS = Object.freeze(['tag_hint_qt', 'tag_hint_uc_preset', 'quality_boost', 'straight_alpha']);

const MAPPED_NAI = new Set(['noise_schedule', 'cfg_rescale', 'skip_cfg_above_sigma', 'dynamic_thresholding', 'sm', 'sm_dyn']);
const CHAR_NAI = new Set(['chars', 'use_coords']);
const IGNORED_FLAT = new Set(['id', 't', 'on', 'meta', 'local', 'tags', 'facets', 'thumbURL', 'fullURL', 'thumb', 'full', 'syncT', 'fav', 'hasBlob']);
const isVibeKey = k => /^(reference_|director_reference_|normalize_reference)/.test(k);
const err = (message, extra) => Object.assign(new Error(message), extra);

const num = v => ((typeof v === 'number' || (typeof v === 'string' && v.trim() !== '')) && Number.isFinite(Number(v)) ? Number(v) : undefined);
const compact = v => (typeof v === 'string' && v.length > 200 ? `${v.length} 字符的编码数据`
    : Array.isArray(v) && v.some(x => typeof x === 'string' && x.length > 200) ? `${v.length} 条编码数据` : v);
const firstTags = (prompt, n) => String(prompt || '').split(',').map(s => s.trim()).filter(Boolean).slice(0, n).join(', ');

/** 接受 {id, meta}、state 里的 {t, on, meta}（需另给 id）、或画廊页面里的扁平记录 {id, prompt, ...} */
export function normalizeGalleryRecord(input, id) {
    if (!input || typeof input !== 'object') throw err('画廊记录为空', { code: 'input' });
    if (input.meta && typeof input.meta === 'object') return { id: String(input.id || id || ''), meta: input.meta };
    const meta = Object.fromEntries(Object.entries(input).filter(([k]) => !IGNORED_FLAT.has(k)));
    return { id: String(input.id || id || ''), meta };
}

export function galleryModelToXb(label) {
    const m = String(label || '').trim();
    if (XB_MODEL_BY_GALLERY_LABEL[m]) return { model: XB_MODEL_BY_GALLERY_LABEL[m], note: '' };
    if (/^nai-diffusion-/.test(m)) return { model: m, note: '' };
    return { model: XB_DEFAULT_PARAMS.model, note: `画廊里的模型是「${m || '未知'}」，认不出，先用 V4.5 Full，导入后可以改` };
}

/** 选分支：varIndex 不传时用 vars.active；-1 或越界 = 原图提示词 */
export function pickVariant(meta, vars, varIndex) {
    const list = vars && Array.isArray(vars.list) ? vars.list : [];
    const idx = varIndex === undefined || varIndex === null
        ? (vars && Number.isInteger(vars.active) ? vars.active : -1)
        : Number(varIndex);
    if (idx >= 0 && list[idx]) return { varIndex: idx, prompt: String(list[idx].prompt ?? ''), uc: String(list[idx].uc ?? ''), name: String(list[idx].name || '') };
    return { varIndex: -1, prompt: String(meta.prompt || ''), uc: String(meta.uc || ''), name: '' };
}

/**
 * @param {object} record  画廊记录（见 normalizeGalleryRecord）
 * @param {object} [opts]
 * @param {object} [opts.vars]      state.vars[id]：{list:[{name, prompt, uc}], active}
 * @param {number} [opts.varIndex]
 * @param {boolean} [opts.keepSeed=false]  勾「固定种子」才带 seed
 * @param {string} [opts.name]
 * @param {string} [opts.presetId]
 * @returns {{preset:object, unsupported:Array<{key, value, reason}>, characters:Array<{prompt, uc, centers}>, useCoords:boolean|undefined, notes:string[]}}
 */
export function presetFromGallery(record, { vars, varIndex, keepSeed = false, name, presetId, id: recordId, now = () => Date.now() } = {}) {
    const { id, meta } = normalizeGalleryRecord(record, recordId);
    const nai = meta.nai && typeof meta.nai === 'object' && !Array.isArray(meta.nai) ? meta.nai : {};
    const v = pickVariant(meta, vars, varIndex);
    const { model, note } = galleryModelToXb(meta.model);
    const isV5 = /diffusion-5/.test(model);
    const notes = note ? [note] : [];
    const w = num(meta.w), h = num(meta.h), seed = num(meta.seed);
    const hasVariety = 'skip_cfg_above_sigma' in nai && nai.skip_cfg_above_sigma != null;

    const params = {
        model,
        sampler: String(meta.sampler || XB_DEFAULT_PARAMS.sampler),
        scheduler: String(nai.noise_schedule || XB_DEFAULT_PARAMS.scheduler),
        steps: num(meta.steps) > 0 ? num(meta.steps) : XB_DEFAULT_PARAMS.steps,
        scale: num(meta.scale) ?? XB_DEFAULT_PARAMS.scale,
        width: !meta.noimg && w > 0 ? w : XB_DEFAULT_PARAMS.width,
        height: !meta.noimg && h > 0 ? h : XB_DEFAULT_PARAMS.height,
        seed: keepSeed && Number.isInteger(seed) && seed >= 0 ? seed : -1,
        // PNG 里记的多半是已拼好的最终提示词：关掉质量词 / UC 预设，避免叠两遍（待实测核实）
        qualityToggle: false,
        autoSmea: false,
        ucPreset: 3,
        cfg_rescale: num(nai.cfg_rescale) ?? 0,
        v5QualityPresetId: 'none',
        v5UcPresetId: 'none',
        transparentBackground: false,
        variety_boost: hasVariety,
        sm: nai.sm === true,
        sm_dyn: nai.sm_dyn === true,
        decrisper: nai.dynamic_thresholding === true,
    };
    notes.push('质量词和负面预设设成「无」：画廊记录里的提示词通常已经包含它们');
    if (hasVariety && isV5) notes.push('Variety+ 只对 V4.5 生效');
    if (keepSeed && params.seed < 0) notes.push('这张图没有可用的种子，已改为随机');

    const unsupported = [], v5Hints = {};
    for (const k of Object.keys(nai).sort()) {
        if (MAPPED_NAI.has(k) || CHAR_NAI.has(k)) continue;
        if (V5_HINT_KEYS.includes(k)) {
            v5Hints[k] = nai[k];
            unsupported.push({ key: k, value: nai[k], reason: '取值未核实，原样保存在 source.v5Hints' });
        } else if (isVibeKey(k)) {
            unsupported.push({ key: k, value: compact(nai[k]), reason: '氛围编码暂不导入' });
        } else {
            unsupported.push({ key: k, value: compact(nai[k]), reason: 'XBDraw 不支持' });
        }
    }

    const characters = Array.isArray(nai.chars)
        ? nai.chars.map(c => ({ prompt: String((c && c.prompt) || ''), uc: String((c && c.uc) || ''), centers: Array.isArray(c && c.centers) ? c.centers : [] }))
        : [];

    const source = { kind: GALLERY_SOURCE_KIND, id, varIndex: v.varIndex };
    if (meta.model) source.model = String(meta.model);
    if (Object.keys(v5Hints).length) source.v5Hints = v5Hints;

    const baseName = meta.name || firstTags(v.prompt, 3) || id.slice(0, 8) || '未命名';
    const t = now();
    const preset = {
        id: presetId || `params-gallery-${String(id).slice(0, 8) || 'x'}-${t}`,
        name: name || `画廊·${baseName}${v.name ? ` · ${v.name}` : ''}`,
        positivePrefix: v.prompt,
        negativePrefix: v.uc,
        maxImages: 2,
        maxCharactersPerImage: 0,
        params,
        source,
    };
    return { preset, unsupported, characters, useCoords: 'use_coords' in nai ? !!nai.use_coords : undefined, notes };
}

export function sameGallerySource(a, b) {
    return !!a && !!b && a.kind === GALLERY_SOURCE_KIND && b.kind === GALLERY_SOURCE_KIND
        && String(a.id) === String(b.id) && Number(a.varIndex ?? -1) === Number(b.varIndex ?? -1);
}

/** 已有同一来源的预设（用于「覆盖 / 另存 / 取消」） */
export function findPresetBySource(presets, source) {
    return (Array.isArray(presets) ? presets : []).find(p => p && sameGallerySource(p.source, source)) || null;
}
