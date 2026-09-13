// 导入参数预设前起名：校验、同名查找、自动改名、同名三选一、落到列表、画廊默认名
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    PRESET_NAME_EMPTY_HINT, PRESET_NAME_MAX, applyNamedPresetImport, askPresetName, createPresetNameDialogs,
    defaultGalleryPresetName, findPresetByName, normalizePresetName, resolvePresetNameConflict, uniquePresetName, validatePresetName,
} from '../../modules/draw/shared/preset-naming.js';

const presets = [
    { id: 'p1', name: '默认 (V4.5 Full)' },
    { id: 'p2', name: '夜景' },
    { id: 'p3', name: '夜景 (2)' },
    { id: 'p4', name: 'Anime Style' },
];

test('name validation: trim, collapse spaces, max length, empty rejected with hint', () => {
    assert.deepEqual(validatePresetName('  夜景   城市 '), { ok: true, name: '夜景 城市', error: '' });
    assert.deepEqual(validatePresetName('   '), { ok: false, name: '', error: PRESET_NAME_EMPTY_HINT });
    assert.deepEqual(validatePresetName(null), { ok: false, name: '', error: PRESET_NAME_EMPTY_HINT });
    assert.equal(normalizePresetName('x'.repeat(100)).length, PRESET_NAME_MAX);
});

test('same-name lookup ignores case and extra spaces; excludeId skips the preset being overwritten', () => {
    assert.equal(findPresetByName(presets, ' anime   style ')?.id, 'p4');
    assert.equal(findPresetByName(presets, '夜景', { excludeId: 'p2' }), null);
    assert.equal(findPresetByName(presets, ''), null);
});

test('auto-rename: 名称 → 名称 (n) skipping taken numbers; a (n) suffix restarts from the base', () => {
    assert.equal(uniquePresetName(presets, '夜景'), '夜景 (3)');
    assert.equal(uniquePresetName(presets, '夜景 (2)'), '夜景 (3)');
    assert.equal(uniquePresetName(presets, '新名字'), '新名字');
    const long = uniquePresetName([{ id: 'a', name: 'y'.repeat(60) }], 'y'.repeat(60));
    assert.equal(long.length <= PRESET_NAME_MAX && long.endsWith(' (2)'), true);
});

test('duplicate choices: overwrite / rename / back; overwrite hidden when not allowed', async () => {
    const asked = [];
    const choose = value => async (q) => { asked.push(q); return value; };
    assert.deepEqual(await resolvePresetNameConflict(presets, '新名字', { choose: choose('overwrite') }), { name: '新名字', onNameConflict: null, nameConflictOf: null });
    assert.equal(asked.length, 0, 'no conflict → no question');
    assert.deepEqual(await resolvePresetNameConflict(presets, '夜景', { choose: choose('overwrite') }), { name: '夜景', onNameConflict: 'overwrite', nameConflictOf: 'p2' });
    assert.deepEqual(asked[0].renamed, '夜景 (3)');
    assert.deepEqual(await resolvePresetNameConflict(presets, '夜景', { choose: choose('rename') }), { name: '夜景 (3)', onNameConflict: 'rename', nameConflictOf: 'p2' });
    assert.equal(await resolvePresetNameConflict(presets, '夜景', { choose: choose('back') }), 'back');
    assert.equal(await resolvePresetNameConflict(presets, '夜景', { choose: choose(undefined) }), 'back', 'Esc = back to edit');
    assert.equal(await resolvePresetNameConflict(presets, '夜景', { allowOverwrite: false, choose: choose('overwrite') }), 'back', 'overwrite not allowed → treated as back');
});

test('askPresetName: prefilled default, Esc cancels, back re-opens the input with the typed name', async () => {
    const prompts = [];
    const answers = ['夜景', '夜景', null];
    const prompt = async (q) => { prompts.push(q); return answers.shift(); };
    const choices = ['back', 'rename'];
    const result = await askPresetName({ presets, defaultName: ' 云端 预设 ', prompt, choose: async () => choices.shift() });
    assert.equal(prompts[0].value, '云端 预设');
    assert.equal(prompts[1].value, '夜景', 'back keeps what the user typed');
    assert.equal(prompts[0].validate('  '), PRESET_NAME_EMPTY_HINT);
    assert.equal(prompts[0].validate('ok'), '');
    assert.deepEqual(result, { name: '夜景 (3)', onNameConflict: 'rename', nameConflictOf: 'p2' });

    assert.equal(await askPresetName({ presets, defaultName: 'x', prompt: async () => null }), null, 'cancel imports nothing');
    assert.deepEqual(await askPresetName({ presets, defaultName: 'x', prompt: async () => '全新' }), { name: '全新', onNameConflict: null, nameConflictOf: null });
    await assert.rejects(() => askPresetName({ presets }), TypeError);
});

test('applyNamedPresetImport (cloud): imported / name-conflict saves nothing / rename / overwrite keeps the id', () => {
    const incoming = { id: 'new-1', name: '云端名', params: { steps: 23 } };
    const plain = applyNamedPresetImport(presets, incoming, { name: ' 我的云端 ' });
    assert.equal(plain.status, 'imported');
    assert.equal(plain.presets.at(-1).name, '我的云端');
    assert.equal(plain.presetId, 'new-1');
    assert.equal(presets.length, 4, 'input not mutated');

    const conflict = applyNamedPresetImport(presets, incoming, { name: '夜景' });
    assert.deepEqual([conflict.status, conflict.presets.length, conflict.presetId, conflict.nameConflictOf], ['name-conflict', 4, null, 'p2']);

    const renamed = applyNamedPresetImport(presets, incoming, { name: '夜景', onNameConflict: 'rename' });
    assert.deepEqual([renamed.status, renamed.name, renamed.presets.length], ['imported', '夜景 (3)', 5]);

    const over = applyNamedPresetImport(presets, incoming, { name: '夜景', onNameConflict: 'overwrite' });
    assert.deepEqual([over.status, over.presetId, over.presets.length, over.presets[1].params.steps], ['overwritten', 'p2', 4, 23]);

    assert.throws(() => applyNamedPresetImport(presets, incoming, { name: '  ' }), /请输入预设名称/);
});

test('gallery default name: batch (character) or first tags, plus short id', () => {
    assert.equal(defaultGalleryPresetName({ id: 'abcdef0123', meta: { batch: '艾莉丝', prompt: '1girl' } }), '艾莉丝 · abcdef');
    assert.equal(defaultGalleryPresetName({ id: 'abcdef0123', meta: { prompt: '1.2::silver hair::, {night}, city, rain' } }), 'silver hair, night, city · abcdef');
    assert.equal(defaultGalleryPresetName({ id: '', meta: {} }), '画廊预设');
});

test('xb-dialog adapters: prompt passes validate + select-friendly options; choose offers 返回修改 / 自动改名 / 覆盖 with Esc = back', async () => {
    const calls = [];
    const dialogs = createPresetNameDialogs({
        xbPrompt: async (...args) => { calls.push(['prompt', ...args]); return 'n'; },
        xbChoose: async (...args) => { calls.push(['choose', ...args]); return 'rename'; },
    });
    const validate = () => '';
    await dialogs.prompt({ title: 't', message: 'm', value: 'v', validate });
    assert.deepEqual(calls[0].slice(1, 3), ['m', 'v']);
    assert.equal(calls[0][3].validate, validate);
    assert.equal(calls[0][3].maxLength, PRESET_NAME_MAX);
    await dialogs.choose({ conflict: { name: '夜景' }, renamed: '夜景 (3)', allowOverwrite: true });
    const [, message, choices, opts] = calls[1];
    assert.match(message, /夜景/);
    assert.deepEqual(choices.map(c => c.label), ['返回修改', '自动改名', '覆盖']);
    assert.equal(opts.cancelValue, 'back');
    assert.match(opts.detail, /夜景 \(3\)/);
    await dialogs.choose({ conflict: { name: '夜景' }, renamed: '夜景 (3)', allowOverwrite: false });
    assert.deepEqual(calls[2][2].map(c => c.value), ['back', 'rename']);
    assert.doesNotMatch(JSON.stringify(calls), /\p{Extended_Pictographic}/u);
});
