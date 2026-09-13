// 「从画廊导入」消息路径：iframe 的 buildImportGalleryPresetMessage → postMessage（结构化克隆）→ 宿主 applyGalleryPresetImport
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildImportGalleryPresetMessage } from '../../modules/draw/shared/gallery-sync/gallery-actions.js';
import {
    applyGalleryPresetImport, characterTagFromGallery, sanitizeGallerySource,
} from '../../modules/draw/providers/novelai/gallery-preset-import.js';

const record = {
    id: 'abcdef0123456789',
    meta: {
        prompt: '1girl, silver hair, night', uc: 'lowres', model: 'V5', seed: 42, steps: 28, scale: 5, sampler: 'k_euler', w: 832, h: 1216,
        nai: { noise_schedule: 'karras', tag_hint_qt: 2, quality_boost: true, chars: [{ prompt: '1girl, silver hair', uc: 'bad hands', centers: [{ x: 0.5, y: 0.5 }] }] },
    },
};
// 模拟 normalizeParamsPreset 的形状（真实函数在 novel-draw.js，依赖酒馆模块，Node 里 import 不了）
const normalize = (p, i) => ({
    id: String(p.id || `params-${i}`), name: String(p.name || `配置-${i + 1}`), positivePrefix: String(p.positivePrefix || ''),
    negativePrefix: String(p.negativePrefix || ''), maxImages: p.maxImages ?? 2, maxCharactersPerImage: p.maxCharactersPerImage || 0,
    params: { ...p.params }, vibes: p.vibes || { items: [] },
});
let seq = 0;
const makeId = () => `params-new-${++seq}`;
const viaPostMessage = msg => structuredClone(msg);

test('first import saves a preset with source kept (v5Hints included) and only preset fields', () => {
    const msg = viaPostMessage(buildImportGalleryPresetMessage(record, { presets: [] }));
    msg.preset.tok = 'ghp_should_not_be_saved';
    msg.preset.params.apiKey = 'pst-should-not-be-saved';
    msg.apiKey = 'pst-top-level';
    const r = applyGalleryPresetImport([{ id: 'p0', name: '默认', params: {} }], msg, { normalize, makeId });
    assert.equal(r.status, 'imported');
    assert.equal(r.presets.length, 2);
    const saved = r.presets[1];
    assert.equal(saved.id, r.presetId);
    assert.deepEqual(saved.source, { kind: 'nai-gallery', id: record.id, varIndex: -1, model: 'V5', v5Hints: { quality_boost: true, tag_hint_qt: 2 } });
    assert.equal(saved.params.model, 'nai-diffusion-5-full');
    assert.equal(saved.params.ucPreset, 3);
    assert.equal(saved.params.seed, -1, 'seed is random unless keepSeed');
    const text = JSON.stringify(r.presets);
    assert.doesNotMatch(text, /ghp_|pst-/);
});

test('same source again: duplicate without decision (nothing saved), overwrite keeps id and vibes, copy adds new id, cancel is a no-op', () => {
    const first = applyGalleryPresetImport([], viaPostMessage(buildImportGalleryPresetMessage(record, { presets: [] })), { normalize, makeId });
    const presets = first.presets.map(p => (p.id === first.presetId ? { ...p, vibes: { items: [{ id: 'v1' }] }, name: '我改过名' } : p));

    const msg = viaPostMessage(buildImportGalleryPresetMessage(record, { presets, keepSeed: true }));
    assert.equal(msg.duplicateOf, first.presetId);
    const dup = applyGalleryPresetImport(presets, msg, { normalize, makeId });
    assert.equal(dup.status, 'duplicate');
    assert.equal(dup.duplicateOf, first.presetId);
    assert.equal(dup.presets.length, 1);

    const over = applyGalleryPresetImport(presets, { ...msg, onDuplicate: 'overwrite' }, { normalize, makeId });
    assert.equal(over.status, 'overwritten');
    assert.equal(over.presets.length, 1);
    assert.equal(over.presetId, first.presetId);
    assert.equal(over.presets[0].params.seed, 42);
    assert.deepEqual(over.presets[0].vibes, { items: [{ id: 'v1' }] });

    const copy = applyGalleryPresetImport(presets, { ...msg, onDuplicate: 'copy' }, { normalize, makeId });
    assert.equal(copy.status, 'imported');
    assert.equal(copy.presets.length, 2);
    assert.notEqual(copy.presetId, first.presetId);
    assert.match(copy.presets[1].name, /副本$/);

    const cancel = applyGalleryPresetImport(presets, { ...msg, onDuplicate: 'cancel' }, { normalize, makeId });
    assert.equal(cancel.status, 'cancelled');
    assert.equal(cancel.presets.length, 1);
    assert.equal(presets.length, 1, 'input array is not mutated');
});

test('chosen name travels in the message (structured clone) and is what the host saves', () => {
    const msg = viaPostMessage({ ...buildImportGalleryPresetMessage(record, { presets: [] }), name: '  银发 夜景  ' });
    assert.equal(msg.name, '  银发 夜景  ');
    const r = applyGalleryPresetImport([{ id: 'p0', name: '默认', params: {} }], msg, { normalize, makeId });
    assert.deepEqual([r.status, r.name, r.presets[1].name], ['imported', '银发 夜景', '银发 夜景']);
    assert.throws(() => applyGalleryPresetImport([], { ...msg, name: '   ' }, { normalize, makeId }), /请输入预设名称/);
});

test('same name as another preset: name-conflict saves nothing; rename → 名称 (2); overwrite replaces that preset keeping id and vibes', () => {
    const existing = [{ id: 'p0', name: '默认', params: {} }, { id: 'p9', name: '夜景', params: { steps: 1 }, vibes: { items: [{ id: 'keep' }] } }];
    const msg = viaPostMessage({ ...buildImportGalleryPresetMessage(record, { presets: existing }), name: '夜景' });
    const conflict = applyGalleryPresetImport(existing, msg, { normalize, makeId });
    assert.deepEqual([conflict.status, conflict.nameConflictOf, conflict.presets.length, conflict.presetId], ['name-conflict', 'p9', 2, null]);

    const renamed = applyGalleryPresetImport(existing, { ...msg, onNameConflict: 'rename' }, { normalize, makeId });
    assert.deepEqual([renamed.status, renamed.name, renamed.presets.length], ['imported', '夜景 (2)', 3]);
    assert.equal(renamed.presets[2].source.kind, 'nai-gallery');

    const over = applyGalleryPresetImport(existing, { ...msg, onNameConflict: 'overwrite' }, { normalize, makeId });
    assert.deepEqual([over.status, over.presetId, over.presets.length, over.nameConflictOf], ['overwritten', 'p9', 2, 'p9']);
    assert.deepEqual(over.presets[1].vibes, { items: [{ id: 'keep' }] });
    assert.equal(over.presets[1].params.model, 'nai-diffusion-5-full');
    assert.equal(over.presets[1].source.id, record.id);
    assert.equal(existing[1].params.steps, 1, 'input not mutated');
});

test('source dedupe still comes first: overwriting the same-source preset may keep its own name; name overwrite of a third preset falls back to rename', () => {
    const first = applyGalleryPresetImport([], { ...buildImportGalleryPresetMessage(record, { presets: [] }), name: '画廊一号' }, { normalize, makeId });
    const presets = [...first.presets, { id: 'other', name: '别的', params: {} }];
    const again = buildImportGalleryPresetMessage(record, { presets });
    const sameName = applyGalleryPresetImport(presets, { ...again, onDuplicate: 'overwrite', name: '画廊一号' }, { normalize, makeId });
    assert.deepEqual([sameName.status, sameName.presetId, sameName.presets.length], ['overwritten', first.presetId, 2]);
    const asOther = applyGalleryPresetImport(presets, { ...again, onDuplicate: 'overwrite', name: '别的', onNameConflict: 'overwrite' }, { normalize, makeId });
    assert.deepEqual([asOther.status, asOther.presetId, asOther.name, asOther.presets[1].name], ['overwritten', first.presetId, '别的 (2)', '别的']);
    const copyConflict = applyGalleryPresetImport(presets, { ...again, onDuplicate: 'copy', name: '画廊一号' }, { normalize, makeId });
    assert.equal(copyConflict.status, 'name-conflict');
});

test('a different prompt variant is a different source', () => {
    const vars = { list: [{ name: '夜景', prompt: 'night city', uc: '' }], active: 0 };
    const base = applyGalleryPresetImport([], buildImportGalleryPresetMessage(record, { presets: [] , varIndex: -1 }), { normalize, makeId });
    const variant = buildImportGalleryPresetMessage(record, { presets: base.presets, vars, varIndex: 0 });
    assert.equal(variant.duplicateOf, null);
    const r = applyGalleryPresetImport(base.presets, variant, { normalize, makeId });
    assert.equal(r.status, 'imported');
    assert.equal(r.presets[1].positivePrefix, 'night city');
});

test('rejects messages without a gallery source; sanitizeGallerySource drops junk', () => {
    assert.throws(() => applyGalleryPresetImport([], { preset: { name: 'x', params: {} } }, { normalize, makeId }), /来源/);
    assert.throws(() => applyGalleryPresetImport([], null, { normalize, makeId }), /没有预设/);
    assert.equal(sanitizeGallerySource({ kind: 'other', id: 'a' }), undefined);
    const s = sanitizeGallerySource({ kind: 'nai-gallery', id: 'a', varIndex: '2', v5Hints: { fn: () => 1, ok: 1 }, extra: 'x' });
    assert.deepEqual(s, { kind: 'nai-gallery', id: 'a', varIndex: 2, v5Hints: { ok: 1 } });
});

test('character prompt → character tag: name required, type guessed, centers dropped', () => {
    const [c] = buildImportGalleryPresetMessage(record).characters;
    const tag = characterTagFromGallery({ name: ' 银发少女 ', prompt: c.prompt, uc: c.uc }, { makeId: () => 'char-1' });
    assert.deepEqual(tag, { id: 'char-1', enabled: true, name: '银发少女', aliases: [], type: 'girl', appearance: '1girl, silver hair', negativeTags: 'bad hands', outfits: [], dynamicStates: [] });
    assert.equal(characterTagFromGallery({ name: 'a', prompt: '1boy, armor' }).type, 'boy');
    assert.equal(characterTagFromGallery({ name: 'a', prompt: 'dragon' }).type, 'other');
    assert.throws(() => characterTagFromGallery({ name: '', prompt: 'x' }), /名称/);
    assert.throws(() => characterTagFromGallery({ name: 'a', prompt: '' }), /空/);
});
