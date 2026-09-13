// preset-naming.js
// 导入参数预设前给它起名：校验、查同名、自动改名「名称 (2)」、同名时「覆盖 / 自动改名 / 返回修改」。
// 纯逻辑，不碰 DOM、不 import 酒馆模块；对话框由调用方注入（createPresetNameDialogs 包一层 xb-dialog）。
// 用在：画廊「导入为参数预设」（gallery-browser.js → 宿主 gallery-preset-import.js）、云端预设导入（novel-draw.js）。
// 同来源查重（画廊 source）照旧在前面做，这里只管名字。

export const PRESET_NAME_MAX = 60;
export const PRESET_NAME_EMPTY_HINT = '请输入预设名称';

/** 去首尾空白、把连续空白压成一个、截到 60 字。 */
export function normalizePresetName(raw) {
    return String(raw ?? '').replace(/\s+/g, ' ').trim().slice(0, PRESET_NAME_MAX).trim();
}

/** { ok, name, error }：空名字不行。 */
export function validatePresetName(raw) {
    const name = normalizePresetName(raw);
    return name ? { ok: true, name, error: '' } : { ok: false, name: '', error: PRESET_NAME_EMPTY_HINT };
}

const nameKey = value => normalizePresetName(value).toLocaleLowerCase();

/** 找同名预设（忽略大小写和多余空白）；excludeId 那个不算（例如正在被覆盖的同来源预设自己）。 */
export function findPresetByName(presets, name, { excludeId = null } = {}) {
    const key = nameKey(name);
    if (!key) return null;
    return (Array.isArray(presets) ? presets : []).find(p => p && p.id !== excludeId && nameKey(p.name) === key) || null;
}

/** 「名称」已占用 → 「名称 (2)」「名称 (3)」…；原名末尾已有 (n) 的从基名重新数。 */
export function uniquePresetName(presets, name, { excludeId = null } = {}) {
    const clean = normalizePresetName(name) || '参数预设';
    if (!findPresetByName(presets, clean, { excludeId })) return clean;
    const base = clean.replace(/\s*\((\d+)\)$/, '') || clean;
    for (let n = 2; n < 10000; n++) {
        const suffix = ` (${n})`;
        const candidate = `${base.slice(0, PRESET_NAME_MAX - suffix.length).trim()}${suffix}`;
        if (!findPresetByName(presets, candidate, { excludeId })) return candidate;
    }
    return `${base.slice(0, PRESET_NAME_MAX - 14)} (${Date.now()})`;
}

function firstTags(text, count = 3) {
    // 去掉 NAI 权重语法：{} [] () 和 1.2::tag:: 的前缀数字与两端 ::
    return String(text || '').split(',').map(s => s.replace(/[{}[\]()]|-?\d+(\.\d+)?::|::/g, '').trim()).filter(Boolean).slice(0, count).join(', ');
}

/** 画廊导入的默认名：批次（角色名）或前几个 tag + 短 id。 */
export function defaultGalleryPresetName(record, preset) {
    const meta = (record && record.meta) || {};
    const shortId = String((record && record.id) || '').slice(0, 6);
    const label = normalizePresetName(meta.batch) || normalizePresetName(firstTags(preset?.positivePrefix || meta.prompt, 3)) || '画廊预设';
    const tail = shortId ? ` · ${shortId}` : '';
    return normalizePresetName(`${label.slice(0, PRESET_NAME_MAX - tail.length).trim()}${tail}`);
}

/**
 * 名字确定后查同名。没冲突 → { name, onNameConflict: null }；
 * 有冲突 → 调 choose({ name, conflict, renamed, allowOverwrite }) 问用户：
 *   'overwrite' → { name, onNameConflict: 'overwrite', nameConflictOf }（allowOverwrite 为假时不给这个选项）
 *   'rename'    → { name: 自动改好的名字, onNameConflict: 'rename', nameConflictOf }
 *   其他 / Esc  → 'back'（回去改名字）
 */
export async function resolvePresetNameConflict(presets, name, { excludeId = null, allowOverwrite = true, choose } = {}) {
    const clean = normalizePresetName(name);
    const conflict = findPresetByName(presets, clean, { excludeId });
    if (!conflict) return { name: clean, onNameConflict: null, nameConflictOf: null };
    const renamed = uniquePresetName(presets, clean, { excludeId });
    const choice = typeof choose === 'function' ? await choose({ name: clean, conflict, renamed, allowOverwrite }) : 'back';
    if (choice === 'overwrite' && allowOverwrite) return { name: clean, onNameConflict: 'overwrite', nameConflictOf: conflict.id };
    if (choice === 'rename') return { name: renamed, onNameConflict: 'rename', nameConflictOf: conflict.id };
    return 'back';
}

/**
 * 完整流程：输入框（预填 defaultName，全选；Enter 确认；Esc 取消）→ 查同名 → 需要时回到输入框。
 * prompt({ title, message, value, validate }) → 字符串 | null；choose 同上。取消返回 null。
 */
export async function askPresetName({ presets, defaultName = '', title = '给预设起个名字', message = '预设名称：', excludeId = null, allowOverwrite = true, prompt, choose } = {}) {
    if (typeof prompt !== 'function') throw new TypeError('askPresetName 需要 prompt');
    let value = normalizePresetName(defaultName);
    for (let round = 0; round < 50; round++) {
        const raw = await prompt({ title, message, value, validate: v => validatePresetName(v).error });
        if (raw == null) return null;
        const checked = validatePresetName(raw);
        if (!checked.ok) { value = ''; continue; }
        value = checked.name;
        const resolved = await resolvePresetNameConflict(presets, checked.name, { excludeId, allowOverwrite, choose });
        if (resolved !== 'back') return resolved;
    }
    return null;
}

/**
 * 把命名结果落到预设列表上（云端导入用；画廊导入在 gallery-preset-import.js 里做同样的事）。
 * 不修改传入数组。onNameConflict 缺省且有同名 → status 'name-conflict'，什么都不存。
 */
export function applyNamedPresetImport(presets, preset, { name, onNameConflict = null } = {}) {
    const list = Array.isArray(presets) ? presets.slice() : [];
    const checked = validatePresetName(name ?? preset?.name);
    if (!checked.ok) throw Object.assign(new Error(PRESET_NAME_EMPTY_HINT), { code: 'name' });
    const conflict = findPresetByName(list, checked.name);
    if (conflict && onNameConflict === 'overwrite') {
        const index = list.indexOf(conflict);
        list[index] = { ...preset, id: conflict.id, name: checked.name };
        return { status: 'overwritten', presets: list, presetId: conflict.id, name: checked.name, nameConflictOf: conflict.id };
    }
    if (conflict && onNameConflict !== 'rename') {
        return { status: 'name-conflict', presets: list, presetId: null, name: checked.name, nameConflictOf: conflict.id };
    }
    const finalName = conflict ? uniquePresetName(list, checked.name) : checked.name;
    list.push({ ...preset, name: finalName });
    return { status: 'imported', presets: list, presetId: preset.id, name: finalName, nameConflictOf: conflict ? conflict.id : null };
}

/** 用 xb-dialog 的 xbPrompt / xbChoose 生成 askPresetName 需要的两个对话框。 */
export function createPresetNameDialogs({ xbPrompt, xbChoose, okLabel = '导入', icon = 'ri-edit-line' } = {}) {
    return {
        prompt: ({ title, message, value, validate }) => xbPrompt(message, value, { title, placeholder: '预设名称', maxLength: PRESET_NAME_MAX, okLabel, icon, validate }),
        choose: ({ conflict, renamed, allowOverwrite }) => xbChoose(`已经有叫「${conflict.name}」的参数预设。`, [
            { value: 'back', label: '返回修改' },
            { value: 'rename', label: '自动改名', kind: allowOverwrite ? 'plain' : 'primary' },
            ...(allowOverwrite ? [{ value: 'overwrite', label: '覆盖', kind: 'danger' }] : []),
        ], {
            title: '名称重复',
            icon: 'ri-file-copy-2-line',
            detail: `自动改名会存为「${renamed}」${allowOverwrite ? '；覆盖会用导入的参数替换原来那个预设' : ''}。`,
            cancelValue: 'back',
        }),
    };
}
