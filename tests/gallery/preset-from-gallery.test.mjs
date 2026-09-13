// 画廊记录 → XBDraw 参数预设：对照表、种子、不支持字段、V5 原样保留、分支、扁平记录、去重、默认值与 novel-draw.js 一致
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { presetFromGallery, findPresetBySource, XB_DEFAULT_PARAMS, normalizeGalleryRecord } from '../../modules/draw/shared/gallery-sync/preset-from-gallery.js';

const v45 = {
    id: 'abc12345ff', meta: {
        name: '雪夜', prompt: '1girl, snow, night, masterpiece', uc: 'lowres', seed: 12345, steps: 28, scale: 5.5, sampler: 'k_euler_ancestral', model: 'V4.5', w: 832, h: 1216,
        nai: {
            noise_schedule: 'karras', cfg_rescale: 0.2, skip_cfg_above_sigma: 58, dynamic_thresholding: false, sm: false, sm_dyn: false,
            uncond_scale: 1, deliberate_euler_ancestral_bug: true, prefer_brownian: false, legacy_uc: false, use_order: true, use_coords: false,
            chars: [{ prompt: 'girl a', uc: 'bad', centers: [{ x: 0.5, y: 0.5 }] }],
        },
    },
};

test('V4.5 record follows the mapping table; seed only with keepSeed; unsupported listed; chars returned separately', () => {
    const r = presetFromGallery(v45, { now: () => 1 });
    const p = r.preset;
    assert.equal(p.name, '画廊·雪夜');
    assert.equal(p.id, 'params-gallery-abc12345-1');
    assert.equal(p.positivePrefix, '1girl, snow, night, masterpiece');
    assert.equal(p.negativePrefix, 'lowres');
    assert.deepEqual(p.params, {
        model: 'nai-diffusion-4-5-full', sampler: 'k_euler_ancestral', scheduler: 'karras', steps: 28, scale: 5.5, width: 832, height: 1216, seed: -1,
        qualityToggle: false, autoSmea: false, ucPreset: 3, cfg_rescale: 0.2, v5QualityPresetId: 'none', v5UcPresetId: 'none', transparentBackground: false,
        variety_boost: true, sm: false, sm_dyn: false, decrisper: false,
    });
    assert.deepEqual(p.source, { kind: 'nai-gallery', id: 'abc12345ff', varIndex: -1, model: 'V4.5' });
    assert.deepEqual(r.unsupported.map(x => x.key), ['deliberate_euler_ancestral_bug', 'legacy_uc', 'prefer_brownian', 'uncond_scale', 'use_order']);
    assert.deepEqual(r.characters, [{ prompt: 'girl a', uc: 'bad', centers: [{ x: 0.5, y: 0.5 }] }]);
    assert.equal(r.useCoords, false);
    assert.equal(JSON.stringify(p).includes('girl a'), false, 'chars are not part of the preset');
    assert.equal(presetFromGallery(v45, { keepSeed: true }).preset.params.seed, 12345);
});

test('V5 record: model id, tag_hint numbers kept raw in source.v5Hints, vibe encodings listed not imported', () => {
    const rec = { id: 'v5img', meta: { prompt: 'a', model: 'V5', nai: { tag_hint_qt: true, tag_hint_uc_preset: 2, quality_boost: 7, skip_cfg_above_sigma: 19, reference_image_multiple: ['x'.repeat(500)], reference_strength_multiple: [0.6] } } };
    const r = presetFromGallery(rec);
    assert.equal(r.preset.params.model, 'nai-diffusion-5-full');
    assert.deepEqual(r.preset.source.v5Hints, { tag_hint_qt: true, tag_hint_uc_preset: 2, quality_boost: 7 });
    const byKey = Object.fromEntries(r.unsupported.map(x => [x.key, x]));
    assert.equal(byKey.tag_hint_uc_preset.value, 2);
    assert.equal(byKey.reference_image_multiple.value, '1 条编码数据');
    assert.match(byKey.reference_strength_multiple.reason, /氛围/);
    assert.ok(r.notes.some(n => /Variety\+ 只对 V4\.5/.test(n)));
});

test('variant selection, flat browser record, unknown model fallback, noimg keeps default size', () => {
    const vars = { list: [{ name: '夜', prompt: 'p1', uc: 'u1' }, { name: '昼', prompt: 'p2', uc: 'u2' }], active: 1 };
    const d = presetFromGallery(v45, { vars });
    assert.deepEqual([d.preset.positivePrefix, d.preset.negativePrefix, d.preset.source.varIndex, d.preset.name], ['p2', 'u2', 1, '画廊·雪夜 · 昼']);
    assert.equal(presetFromGallery(v45, { vars, varIndex: 0 }).preset.positivePrefix, 'p1');
    assert.equal(presetFromGallery(v45, { vars, varIndex: -1 }).preset.positivePrefix, v45.meta.prompt);

    const flat = { id: 'zz', prompt: 'a, b, c, d', model: '手写', noimg: true, w: 832, h: 1216, tags: ['a'], local: true, thumbURL: 'blob:x' };
    assert.deepEqual(Object.keys(normalizeGalleryRecord(flat).meta).sort(), ['h', 'model', 'noimg', 'prompt', 'w']);
    const f = presetFromGallery(flat);
    assert.equal(f.preset.name, '画廊·a, b, c');
    assert.equal(f.preset.params.model, XB_DEFAULT_PARAMS.model);
    assert.ok(f.notes.some(n => n.includes('手写')));
    assert.deepEqual([f.preset.params.width, f.preset.params.height], [XB_DEFAULT_PARAMS.width, XB_DEFAULT_PARAMS.height]);
});

test('findPresetBySource matches kind + id + varIndex only', () => {
    const src = { kind: 'nai-gallery', id: 'abc', varIndex: -1 };
    const presets = [{ id: 'p1', source: { kind: 'nai-gallery', id: 'abc', varIndex: 0 } }, { id: 'p2', source: { ...src, importedAt: 5 } }, { id: 'p3' }];
    assert.equal(findPresetBySource(presets, src).id, 'p2');
    assert.equal(findPresetBySource(presets, { ...src, id: 'other' }), null);
    assert.equal(findPresetBySource(null, src), null);
});

test('XB_DEFAULT_PARAMS mirrors DEFAULT_PARAMS_PRESET in novel-draw.js (read-only check)', (t) => {
    const src = fs.readFileSync(new URL('../../modules/draw/providers/novelai/novel-draw.js', import.meta.url), 'utf8');
    const block = (src.match(/const DEFAULT_PARAMS_PRESET = \{[\s\S]*?\n\};/) || [])[0];
    if (!block) return t.skip('DEFAULT_PARAMS_PRESET 没找到');
    const s = k => (block.match(new RegExp(`\\b${k}:\\s*'([^']+)'`)) || [])[1];
    const n = k => Number((block.match(new RegExp(`\\b${k}:\\s*(-?[\\d.]+)`)) || [])[1]);
    assert.deepEqual(
        { model: s('model'), sampler: s('sampler'), scheduler: s('scheduler'), steps: n('steps'), scale: n('scale'), width: n('width'), height: n('height'), seed: n('seed') },
        { ...XB_DEFAULT_PARAMS },
    );
});
