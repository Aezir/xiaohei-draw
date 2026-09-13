// float-fields.js
// 楼层按钮 / 悬浮球下拉菜单里显示哪些「绘图参数」。纯数据 + 少量 DOM 构建，不 import 酒馆模块。
// 设置项：settings.floatFields = ['preset', 'size', ...]（存 XBDraw_NovelDraw.json），缺省为 ['preset', 'size']。
// 预设、尺寸改的是全局快捷设置；模型、采样、步数、引导、种子改的是当前选中的参数预设。

export const FLOAT_SIZE_OPTIONS = Object.freeze([
    { value: 'default', label: '跟随预设' },
    { value: '832x1216', label: '832 × 1216  竖图' },
    { value: '1216x832', label: '1216 × 832  横图' },
    { value: '1024x1024', label: '1024 × 1024  方图' },
    { value: '768x1280', label: '768 × 1280  大竖' },
    { value: '1280x768', label: '1280 × 768  大横' },
]);

export const FLOAT_MODEL_OPTIONS = Object.freeze([
    { value: 'nai-diffusion-5-full', label: 'NAI V5 Full' },
    { value: 'nai-diffusion-5-curated', label: 'NAI V5 Curated' },
    { value: 'nai-diffusion-4-5-full', label: 'NAI V4.5 Full' },
    { value: 'nai-diffusion-4-5-curated', label: 'NAI V4.5 Curated' },
    { value: 'nai-diffusion-4-full', label: 'NAI V4 Full' },
    { value: 'nai-diffusion-3', label: 'NAI V3' },
    { value: 'nai-diffusion-furry-3', label: 'Furry V3' },
]);

export const FLOAT_SAMPLER_OPTIONS = Object.freeze([
    { value: 'k_euler_ancestral', label: 'Euler Ancestral' },
    { value: 'k_euler', label: 'Euler' },
    { value: 'k_dpmpp_2m', label: 'DPM++ 2M' },
    { value: 'k_dpmpp_sde', label: 'DPM++ SDE' },
    { value: 'ddim', label: 'DDIM' },
]);

export const FLOAT_FIELD_DEFS = Object.freeze([
    { id: 'preset', label: '预设', kind: 'select' },
    { id: 'size', label: '尺寸', kind: 'select' },
    { id: 'model', label: '模型', kind: 'select' },
    { id: 'sampler', label: '采样', kind: 'select' },
    { id: 'steps', label: '步数', kind: 'number', min: 1, max: 50, step: 1 },
    { id: 'scale', label: '引导', kind: 'number', min: 0, max: 10, step: 0.1 },
    { id: 'seed', label: '种子', kind: 'number', min: -1, max: 4294967295, step: 1 },
]);

export const FLOAT_FIELD_IDS = Object.freeze(FLOAT_FIELD_DEFS.map(def => def.id));
export const DEFAULT_FLOAT_FIELDS = Object.freeze(['preset', 'size']);

const DEF_BY_ID = new Map(FLOAT_FIELD_DEFS.map(def => [def.id, def]));

/** 缺省（不是数组）时用默认两项；是数组时只留已知 id，去重，按注册表顺序。允许空数组（全部不显示）。 */
export function normalizeFloatFields(value) {
    if (!Array.isArray(value)) return [...DEFAULT_FLOAT_FIELDS];
    const wanted = new Set(value.map(item => String(item)));
    return FLOAT_FIELD_IDS.filter(id => wanted.has(id));
}

/** 给设置页渲染勾选框用。 */
export function getFloatFieldOptions() {
    return FLOAT_FIELD_DEFS.map(({ id, label }) => ({ id, label }));
}

export function getActiveParamsPresetFrom(settings) {
    const list = Array.isArray(settings?.paramsPresets) ? settings.paramsPresets : [];
    return list.find(p => p?.id === settings?.selectedParamsPresetId) || list[0] || null;
}

export function readFloatFieldValue(id, settings) {
    if (id === 'preset') return String(settings?.selectedParamsPresetId ?? getActiveParamsPresetFrom(settings)?.id ?? '');
    if (id === 'size') return String(settings?.overrideSize || 'default');
    const value = getActiveParamsPresetFrom(settings)?.params?.[id];
    return value == null ? '' : value;
}

function withCurrent(options, current) {
    const value = String(current ?? '');
    if (!value || options.some(opt => opt.value === value)) return options.map(opt => ({ ...opt }));
    return [...options.map(opt => ({ ...opt })), { value, label: value }];
}

export function getFloatFieldChoices(id, settings) {
    switch (id) {
        case 'preset':
            return (Array.isArray(settings?.paramsPresets) ? settings.paramsPresets : [])
                .map(p => ({ value: String(p.id), label: String(p.name || '未命名') }));
        case 'size':
            return FLOAT_SIZE_OPTIONS.map(opt => ({ ...opt }));
        case 'model':
            return withCurrent(FLOAT_MODEL_OPTIONS, readFloatFieldValue('model', settings));
        case 'sampler':
            return withCurrent(FLOAT_SAMPLER_OPTIONS, readFloatFieldValue('sampler', settings));
        default:
            return [];
    }
}

/** 校验并换算输入值：{ ok, value }。 */
export function coerceFloatFieldValue(id, raw, settings) {
    const def = DEF_BY_ID.get(id);
    if (!def) return { ok: false };
    const text = String(raw ?? '').trim();
    switch (id) {
        case 'preset': {
            const ok = (settings?.paramsPresets || []).some(p => String(p.id) === text);
            return ok ? { ok: true, value: text } : { ok: false };
        }
        case 'size':
            return FLOAT_SIZE_OPTIONS.some(opt => opt.value === text) ? { ok: true, value: text } : { ok: false };
        case 'model':
        case 'sampler':
            return text ? { ok: true, value: text } : { ok: false };
        case 'steps': {
            const n = Math.round(Number(text));
            return Number.isFinite(n) && text !== '' ? { ok: true, value: Math.min(def.max, Math.max(def.min, n)) } : { ok: false };
        }
        case 'scale': {
            const n = Number(text);
            return Number.isFinite(n) && text !== '' ? { ok: true, value: Math.min(def.max, Math.max(def.min, Math.round(n * 10) / 10)) } : { ok: false };
        }
        case 'seed': {
            if (text === '') return { ok: true, value: -1 };
            const n = Math.trunc(Number(text));
            if (!Number.isFinite(n)) return { ok: false };
            return { ok: true, value: n < 0 ? -1 : Math.min(def.max, n) };
        }
        default:
            return { ok: false };
    }
}

/** 把一次改动写进 settings 草稿（给 updateSettingsPersistent 的 mutator 用）。成功返回 true。 */
export function applyFloatFieldValue(settings, id, raw) {
    const result = coerceFloatFieldValue(id, raw, settings);
    if (!result.ok || !settings) return false;
    if (id === 'preset') {
        settings.selectedParamsPresetId = result.value;
        return true;
    }
    if (id === 'size') {
        settings.overrideSize = result.value;
        return true;
    }
    const preset = getActiveParamsPresetFrom(settings);
    if (!preset) return false;
    preset.params = preset.params && typeof preset.params === 'object' ? preset.params : {};
    preset.params[id] = result.value;
    return true;
}

// ── DOM ────────────────────────────────────────────────────────────────

/** 生成菜单行。每行：<div class="nd-row" data-float-field="id"><span class="nd-label">…</span><控件 class="nd-field-control"></div> */
export function buildFloatFieldRows(doc, fieldIds, settings) {
    const fragment = doc.createDocumentFragment();
    for (const id of normalizeFloatFields(fieldIds)) {
        const def = DEF_BY_ID.get(id);
        const row = doc.createElement('div');
        row.className = 'nd-row';
        row.dataset.floatField = id;
        const label = doc.createElement('span');
        label.className = 'nd-label';
        label.textContent = def.label;
        let control;
        if (def.kind === 'select') {
            control = doc.createElement('select');
            control.className = `nd-select nd-field-control${id === 'size' ? ' size' : ''}`;
        } else {
            control = doc.createElement('input');
            control.type = 'number';
            control.className = 'nd-input nd-field-control';
            control.min = String(def.min);
            control.max = String(def.max);
            control.step = String(def.step);
            control.inputMode = def.step < 1 ? 'decimal' : 'numeric';
        }
        control.setAttribute('aria-label', def.label);
        row.append(label, control);
        fragment.appendChild(row);
    }
    syncFloatFieldControls(fragment, settings);
    return fragment;
}

/** 按当前设置刷新控件的选项和取值（正在输入的数字框不打断）。 */
export function syncFloatFieldControls(root, settings) {
    if (!root?.querySelectorAll) return;
    root.querySelectorAll('[data-float-field]').forEach((row) => {
        const id = row.dataset.floatField;
        const control = row.querySelector('.nd-field-control');
        if (!control) return;
        const value = String(readFloatFieldValue(id, settings));
        if (control.tagName === 'SELECT') {
            const choices = getFloatFieldChoices(id, settings);
            const signature = JSON.stringify(choices);
            if (control.dataset.choices !== signature) {
                control.replaceChildren(...choices.map((choice) => {
                    const option = control.ownerDocument.createElement('option');
                    option.value = choice.value;
                    option.textContent = choice.label;
                    return option;
                }));
                control.dataset.choices = signature;
            }
            if (control.value !== value) control.value = value;
        } else if (control.ownerDocument.activeElement !== control) {
            control.value = value;
        }
    });
}

/** 事件委托：控件 change 时回调 onChange(id, rawValue, control)。返回解绑函数。 */
export function bindFloatFieldControls(root, onChange) {
    const handler = (event) => {
        const control = event.target?.closest?.('.nd-field-control');
        const row = control?.closest('[data-float-field]');
        if (!row || !root.contains(row)) return;
        onChange?.(row.dataset.floatField, control.value, control);
    };
    root.addEventListener('change', handler);
    return () => root.removeEventListener('change', handler);
}
