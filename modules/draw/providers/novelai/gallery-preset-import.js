// 「从画廊导入」宿主侧（novel-draw.js 的 IMPORT_GALLERY_PRESET / SAVE_GALLERY_CHARACTER_TAG）用的纯函数。
// 不 import 酒馆模块，Node 测试直接跑。
// 规则（docs/plans/gallery-G1b-G2-edits.md）：
//   - 只收预设该有的字段；消息里夹带的其他东西（令牌、密钥之类）一律不进设置文件。
//   - source = {kind:'nai-gallery', id, varIndex, model?, v5Hints?} 原样保留，用来查重。
//   - 已有同来源的预设：没给 onDuplicate → 回 duplicate，不保存；'overwrite' = 同 id 替换；'copy' = 新 id；'cancel' = 不动。
//   - 名字：消息带 name（导入前用户起的名）就用它；和别的预设同名时看 onNameConflict：
//     'overwrite' = 替换那个同名预设（保留它的 id 和氛围）；'rename' = 自动改成「名称 (2)」；没给 → 回 name-conflict，不保存。
import { GALLERY_SOURCE_KIND, sameGallerySource } from '../../shared/gallery-sync/preset-from-gallery.js';
import { PRESET_NAME_EMPTY_HINT, findPresetByName, uniquePresetName, validatePresetName } from '../../shared/preset-naming.js';

export const GALLERY_HOST_REPLIES = Object.freeze({
    IMPORTED: 'GALLERY_PRESET_IMPORTED',
    DUPLICATE: 'GALLERY_PRESET_DUPLICATE',
    NAME_CONFLICT: 'GALLERY_PRESET_NAME_CONFLICT',
    CHARACTER_SAVED: 'GALLERY_CHARACTER_TAG_SAVED',
    BATCH_PROGRESS: 'GALLERY_BATCH_PROGRESS',
    BATCH_DONE: 'GALLERY_BATCH_DONE',
});

const PRESET_KEYS = ['id', 'name', 'positivePrefix', 'negativePrefix', 'maxImages', 'maxCharactersPerImage', 'params'];
const PARAM_KEYS = ['model', 'sampler', 'scheduler', 'steps', 'scale', 'width', 'height', 'seed', 'qualityToggle', 'autoSmea', 'ucPreset',
    'cfg_rescale', 'v5QualityPresetId', 'v5UcPresetId', 'transparentBackground', 'variety_boost', 'sm', 'sm_dyn', 'decrisper'];
const isPlainObject = v => !!v && typeof v === 'object' && !Array.isArray(v);
const err = (message, extra) => Object.assign(new Error(message), extra);

/** 只留 JSON 基本类型（v5Hints 的值原样保存，但不允许函数 / 循环 / 超大内容） */
function jsonSafe(value, depth = 0) {
    if (value === null || typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string') {
        return typeof value === 'string' && value.length > 4000 ? value.slice(0, 4000) : value;
    }
    if (depth > 4) return undefined;
    if (Array.isArray(value)) return value.slice(0, 64).map(v => jsonSafe(v, depth + 1)).filter(v => v !== undefined);
    if (isPlainObject(value)) {
        const out = {};
        for (const [k, v] of Object.entries(value).slice(0, 64)) { const s = jsonSafe(v, depth + 1); if (s !== undefined) out[k] = s; }
        return out;
    }
    return undefined;
}

export function sanitizeGallerySource(src) {
    if (!isPlainObject(src) || src.kind !== GALLERY_SOURCE_KIND || !String(src.id || '').trim()) return undefined;
    const out = { kind: GALLERY_SOURCE_KIND, id: String(src.id).slice(0, 128), varIndex: Number.isInteger(Number(src.varIndex)) ? Number(src.varIndex) : -1 };
    if (typeof src.model === 'string' && src.model) out.model = src.model.slice(0, 64);
    if (isPlainObject(src.v5Hints)) { const h = jsonSafe(src.v5Hints); if (h && Object.keys(h).length) out.v5Hints = h; }
    return out;
}

function pickPreset(raw) {
    const out = {};
    for (const k of PRESET_KEYS) if (raw[k] !== undefined) out[k] = raw[k];
    out.params = {};
    if (isPlainObject(raw.params)) for (const k of PARAM_KEYS) if (raw.params[k] !== undefined) out.params[k] = raw.params[k];
    return out;
}

/**
 * @param {Array} presets              当前 settings.paramsPresets（不会被修改）
 * @param {object} msg                 IMPORT_GALLERY_PRESET 消息：{preset, duplicateOf?, onDuplicate?: 'overwrite'|'copy'|'cancel', name?, onNameConflict?: 'overwrite'|'rename'}
 * @param {object} deps
 * @param {(preset, index) => object} deps.normalize   novel-draw.js 的 normalizeParamsPreset
 * @param {() => string} deps.makeId
 * @returns {{status: 'imported'|'overwritten'|'duplicate'|'name-conflict'|'cancelled', presets: Array, presetId: string|null, duplicateOf: string|null, name?: string, nameConflictOf?: string}}
 */
export function applyGalleryPresetImport(presets, msg, { normalize = p => p, makeId = () => `params-${Date.now()}` } = {}) {
    const list = Array.isArray(presets) ? presets.slice() : [];
    if (!isPlainObject(msg) || !isPlainObject(msg.preset)) throw err('导入消息里没有预设', { code: 'input' });
    const source = sanitizeGallerySource(msg.preset.source);
    if (!source) throw err('导入的预设缺少画廊来源，已拒绝', { code: 'input' });
    const dupIndex = list.findIndex(p => p && sameGallerySource(p.source, source));
    const dup = dupIndex >= 0 ? list[dupIndex] : null;
    const decision = String(msg.onDuplicate || '');

    if (dup && decision === 'cancel') return { status: 'cancelled', presets: list, presetId: null, duplicateOf: dup.id };
    if (dup && decision !== 'overwrite' && decision !== 'copy') return { status: 'duplicate', presets: list, presetId: null, duplicateOf: dup.id };

    const picked = pickPreset(msg.preset);

    // 用户在导入前起的名字（msg.name）。没带 name 的旧消息照旧用预设自带名字、不查同名。
    let name = dup && decision === 'copy' ? `${String(picked.name || '画廊预设')} · 副本` : picked.name;
    let nameTarget = null;   // 同名覆盖的目标
    if (msg.name !== undefined) {
        const checked = validatePresetName(msg.name);
        if (!checked.ok) throw err(PRESET_NAME_EMPTY_HINT, { code: 'name' });
        name = checked.name;
        const excludeId = dup && decision === 'overwrite' ? dup.id : null;
        const conflict = findPresetByName(list, name, { excludeId });
        const nameDecision = String(msg.onNameConflict || '');
        if (conflict) {
            // 同来源已经在覆盖别的预设时，同名不再允许覆盖（否则会一次动两个预设），按自动改名处理
            if (nameDecision === 'overwrite' && !excludeId) nameTarget = conflict;
            else if (nameDecision === 'rename' || nameDecision === 'overwrite') name = uniquePresetName(list, name, { excludeId });
            else return { status: 'name-conflict', presets: list, presetId: null, duplicateOf: dup ? dup.id : null, name, nameConflictOf: conflict.id };
        }
    }

    if (dup && decision === 'overwrite') {
        const next = normalize({ ...picked, name, id: dup.id, vibes: dup.vibes }, dupIndex);
        next.source = source;
        list[dupIndex] = next;
        return { status: 'overwritten', presets: list, presetId: next.id, duplicateOf: dup.id, name: next.name };
    }
    if (nameTarget) {
        const index = list.indexOf(nameTarget);
        const next = normalize({ ...picked, name, id: nameTarget.id, vibes: nameTarget.vibes }, index);
        next.source = source;
        list[index] = next;
        return { status: 'overwritten', presets: list, presetId: next.id, duplicateOf: dup ? dup.id : null, name: next.name, nameConflictOf: nameTarget.id };
    }
    const id = makeId();
    const next = normalize({ ...picked, id, name }, list.length);
    next.source = source;
    list.push(next);
    return { status: 'imported', presets: list, presetId: next.id, duplicateOf: dup ? dup.id : null, name: next.name };
}

const TYPE_RULES = [
    [/\b(\d+\s*)?girls?\b/i, 'girl'],
    [/\b(\d+\s*)?boys?\b/i, 'boy'],
    [/\bwom[ae]n\b/i, 'woman'],
    [/\bm[ae]n\b/i, 'man'],
    [/\bno[_ ]humans\b/i, 'no_humans'],
];

/** 画廊角色提示词 → 角色标签（centers 丢弃；名字由用户填） */
export function characterTagFromGallery({ name, prompt, uc } = {}, { makeId = () => `char-${Date.now()}-${Math.random().toString(36).slice(2, 6)}` } = {}) {
    const n = String(name || '').trim();
    if (!n) throw err('请输入角色名称', { code: 'input' });
    const appearance = String(prompt || '').trim();
    if (!appearance) throw err('这个角色提示词是空的', { code: 'input' });
    const type = (TYPE_RULES.find(([re]) => re.test(appearance)) || [null, 'other'])[1];
    return {
        id: makeId(), enabled: true, name: n.slice(0, 80), aliases: [], type,
        appearance, negativeTags: String(uc || '').trim(), outfits: [], dynamicStates: [],
    };
}
