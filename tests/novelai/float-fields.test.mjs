import test from 'node:test';
import assert from 'node:assert/strict';

import {
    DEFAULT_FLOAT_FIELDS,
    FLOAT_FIELD_IDS,
    applyFloatFieldValue,
    coerceFloatFieldValue,
    getFloatFieldChoices,
    getFloatFieldOptions,
    normalizeFloatFields,
    readFloatFieldValue,
} from '../../modules/draw/providers/novelai/float-fields.js';
import { mergeNovelDrawProviderSettingsIntoStorageRoot } from '../../modules/draw/shared/draw-settings.js';

function makeSettings() {
    return {
        selectedParamsPresetId: 'b',
        overrideSize: 'default',
        paramsPresets: [
            { id: 'a', name: 'A', params: { model: 'nai-diffusion-4-5-full', sampler: 'k_euler', steps: 28, scale: 6, seed: -1 } },
            { id: 'b', name: 'B', params: { model: 'custom-model', sampler: 'k_euler_ancestral', steps: 23, scale: 5, seed: 42 } },
        ],
    };
}

test('floatFields 缺省时是「预设 + 尺寸 + 增补开关」', () => {
    assert.deepEqual(DEFAULT_FLOAT_FIELDS, ['preset', 'size', 'supplement']);
    assert.deepEqual(normalizeFloatFields(undefined), ['preset', 'size', 'supplement']);
    assert.deepEqual(normalizeFloatFields(null), ['preset', 'size', 'supplement']);
    assert.deepEqual(normalizeFloatFields('preset'), ['preset', 'size', 'supplement']);
});

test('floatFields 只留已知字段、去重、按注册表顺序，允许全部取消', () => {
    assert.deepEqual(normalizeFloatFields([]), []);
    assert.deepEqual(normalizeFloatFields(['seed', 'preset', 'bogus', 'preset']), ['preset', 'seed']);
    assert.deepEqual(normalizeFloatFields(FLOAT_FIELD_IDS.slice().reverse()), [...FLOAT_FIELD_IDS]);
});

test('设置页勾选清单与注册表一致', () => {
    const options = getFloatFieldOptions();
    assert.deepEqual(options.map(o => o.id), [...FLOAT_FIELD_IDS]);
    assert.ok(options.every(o => typeof o.label === 'string' && o.label.length > 0));
});

test('预设/尺寸改全局快捷设置，其余字段改当前选中的参数预设', () => {
    const s = makeSettings();
    assert.equal(applyFloatFieldValue(s, 'size', '832x1216'), true);
    assert.equal(s.overrideSize, '832x1216');
    assert.equal(applyFloatFieldValue(s, 'steps', '30'), true);
    assert.equal(s.paramsPresets[1].params.steps, 30);
    assert.equal(s.paramsPresets[0].params.steps, 28);
    assert.equal(applyFloatFieldValue(s, 'preset', 'a'), true);
    assert.equal(s.selectedParamsPresetId, 'a');
    assert.equal(applyFloatFieldValue(s, 'model', 'nai-diffusion-5-full'), true);
    assert.equal(s.paramsPresets[0].params.model, 'nai-diffusion-5-full');
    assert.equal(readFloatFieldValue('model', s), 'nai-diffusion-5-full');
});

test('无效输入不写入，数值会夹到范围内', () => {
    const s = makeSettings();
    assert.equal(applyFloatFieldValue(s, 'preset', 'missing'), false);
    assert.equal(applyFloatFieldValue(s, 'size', '999x999'), false);
    assert.equal(applyFloatFieldValue(s, 'steps', 'abc'), false);
    assert.equal(applyFloatFieldValue(s, 'unknown', '1'), false);
    assert.deepEqual(coerceFloatFieldValue('steps', '99', s), { ok: true, value: 50 });
    assert.deepEqual(coerceFloatFieldValue('steps', '0', s), { ok: true, value: 1 });
    assert.deepEqual(coerceFloatFieldValue('scale', '12.3', s), { ok: true, value: 10 });
    assert.deepEqual(coerceFloatFieldValue('scale', '5.26', s), { ok: true, value: 5.3 });
    assert.deepEqual(coerceFloatFieldValue('seed', '', s), { ok: true, value: -1 });
    assert.deepEqual(coerceFloatFieldValue('seed', '-5', s), { ok: true, value: -1 });
    assert.deepEqual(coerceFloatFieldValue('seed', '3.9', s), { ok: true, value: 3 });
});

test('模型下拉带上预设里的自定义模型，不会把它丢掉', () => {
    const s = makeSettings();
    const models = getFloatFieldChoices('model', s).map(c => c.value);
    assert.ok(models.includes('custom-model'));
    assert.ok(models.includes('nai-diffusion-5-full'));
    assert.deepEqual(getFloatFieldChoices('preset', s).map(c => c.value), ['a', 'b']);
});

test('floatFields 会随 NovelAI 设置写进存储根对象（不被白名单过滤掉）', () => {
    const merged = mergeNovelDrawProviderSettingsIntoStorageRoot({ cacheDays: 3 }, { floatFields: ['model', 'steps'], mode: 'manual', notAllowed: 1 });
    assert.deepEqual(merged.floatFields, ['model', 'steps']);
    assert.equal('notAllowed' in merged, false);
});
