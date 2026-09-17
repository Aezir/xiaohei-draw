// 增补提示词：开关、正负向接的位置、不重复加；compile() 带上；悬浮球「增补」开关读写。
import test from 'node:test';
import assert from 'node:assert/strict';

globalThis.fetch = () => { throw new Error('network access is forbidden in tests'); };

const { applySupplementPrompt, normalizeSupplementPrompt } = await import('../../modules/draw/shared/supplement-prompt.js');
const { compile } = await import('../../modules/draw/providers/novelai/compiler.js');
const floatFields = await import('../../modules/draw/providers/novelai/float-fields.js');

test('关着不加；开着正向接在最后、负向接在负向固定后；已包含不重复', () => {
    const supp = { enabled: true, prompt: 'rim lighting', uc: 'extra fingers' };
    assert.deepEqual(applySupplementPrompt('best, 1girl', 'lowres', { ...supp, enabled: false }), { scene: 'best, 1girl', negativePrompt: 'lowres' });
    const once = applySupplementPrompt('best, 1girl', 'lowres', supp);
    assert.match(once.scene, /^best, 1girl.*rim lighting$/);
    assert.match(once.negativePrompt, /^lowres.*extra fingers$/);
    assert.deepEqual(applySupplementPrompt(once.scene, once.negativePrompt, supp), once, '编辑重生成读回旧提示词时不重复');
    assert.deepEqual(normalizeSupplementPrompt(null), { enabled: false, prompt: '', uc: '' });
});

test('compile：开着时每张图的场景和负面都带上增补', () => {
    const recipe = {
        apiBaseUrl: '',
        resolveForBackend: false,
        params: { model: 'nai-diffusion-4-5-full', width: 832, height: 1216, steps: 28, scale: 5, sampler: 'k_euler', scheduler: 'karras' },
        positivePrefix: 'masterpiece',
        negativePrefix: 'lowres',
        seeds: [1, 2],
        timeout: 1000,
        requestDelay: { min: 0, max: 0 },
        autoLearnEnabled: false,
        autoLearnMode: 'new_only',
        supplementPrompt: { enabled: true, prompt: 'rim lighting', uc: 'extra fingers' },
    };
    const batch = compile([{ scene: '1girl', characterPrompts: [] }, { scene: '1boy', characterPrompts: [] }], recipe);
    for (const item of batch.items) {
        const p = item.request.payload.parameters;
        assert.match(p.v4_prompt.caption.base_caption, /^masterpiece.*rim lighting$/);
        assert.match(p.negative_prompt, /^lowres.*extra fingers$/);
    }
    const off = compile([{ scene: '1girl', characterPrompts: [] }], { ...recipe, seeds: [1], supplementPrompt: { enabled: false, prompt: 'rim lighting' } });
    assert.doesNotMatch(off.items[0].request.payload.parameters.v4_prompt.caption.base_caption, /rim lighting/);
});

test('悬浮球「增补」开关：默认显示、读写 settings.supplementPrompt.enabled、保留内容', () => {
    assert.ok(floatFields.DEFAULT_FLOAT_FIELDS.includes('supplement'));
    assert.ok(floatFields.normalizeFloatFields(['preset', 'supplement']).includes('supplement'));
    const settings = { supplementPrompt: { enabled: false, prompt: 'a', uc: 'b' } };
    assert.equal(floatFields.readFloatFieldValue('supplement', settings), 'false');
    assert.equal(floatFields.applyFloatFieldValue(settings, 'supplement', true), true);
    assert.deepEqual(settings.supplementPrompt, { enabled: true, prompt: 'a', uc: 'b' });
    assert.equal(floatFields.readFloatFieldValue('supplement', settings), 'true');
    assert.equal(floatFields.applyFloatFieldValue(settings, 'supplement', 'false'), true);
    assert.equal(settings.supplementPrompt.enabled, false);
});
