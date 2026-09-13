import test from 'node:test';
import assert from 'node:assert/strict';

globalThis.fetch = () => { throw new Error('network access is forbidden in tests'); };

const {
    parseOverrideSize, isSizeOverridden, resolveEffectiveSize, applyEffectiveSize, sizeOverrideNotice, OVERRIDE_SIZE_VALUES,
} = await import('../../modules/draw/providers/novelai/novel-effective-size.js');
const { planFreeReset, resolveSubscriptionView, effectivePricingConfig, describeCost } = await import('../../modules/draw/providers/novelai/ui/nd-cost-bar.js');
const { presetPricingConfig, presetGenerateConfirm } = await import('../../modules/draw/providers/novelai/novel-cost-rule.js');
const { estimateAnlasCost } = await import('../../modules/draw/providers/novelai/novel-anlas-pricing.js');
const { FLOAT_SIZE_OPTIONS } = await import('../../modules/draw/providers/novelai/float-fields.js');
const { compileNovelImageRequest } = await import('../../modules/draw/providers/novelai/compiler.js');
const { buildNovelGenerationSnapshot } = await import('../../modules/draw/providers/novelai/novel-vibe-generation.js');

const V45 = 'nai-diffusion-4-5-full';
const OPUS = resolveSubscriptionView({ source: 'direct', subscription: { tier: 3, active: true, usage: { isNegative: false } } });
const TABLET = resolveSubscriptionView({ source: 'plugin', subscription: { tier: 1, active: true } });
const form = (o = {}) => ({ model: V45, width: 1216, height: 832, steps: 23, n_samples: 1, ...o });

test('parse: only the floating-ball whitelist counts as an override', () => {
    assert.deepEqual(parseOverrideSize('768x1280'), { width: 768, height: 1280 });
    assert.deepEqual(parseOverrideSize(' 1280X768 '), { width: 1280, height: 768 });
    for (const bad of ['default', '', null, undefined, '999x999', '768x1280x1']) assert.equal(parseOverrideSize(bad), null);
    assert.equal(isSizeOverridden('default'), false);
    // 悬浮球菜单里除「跟随预设」外的每一项都能被识别
    assert.deepEqual(FLOAT_SIZE_OPTIONS.map(o => o.value).filter(v => v !== 'default'), [...OVERRIDE_SIZE_VALUES]);
});

test('effective size: override wins, default follows preset/form', () => {
    assert.deepEqual(resolveEffectiveSize({ width: 1216, height: 832 }, '768x1280'), { width: 768, height: 1280, overridden: true });
    assert.deepEqual(resolveEffectiveSize({ width: 1216, height: 832 }, 'default'), { width: 1216, height: 832, overridden: false });
    const base = form();
    assert.deepEqual(applyEffectiveSize(base, '768x1280'), { ...base, width: 768, height: 1280 });
    assert.equal(base.width, 1216, 'input not mutated');
});

test('effective size matches what the compiler actually sends', () => {
    const request = {
        scene: 'best quality, 1girl',
        negativePrompt: 'lowres',
        params: { model: V45, width: 1216, height: 832, steps: 23, scale: 5, sampler: 'k_euler_ancestral', scheduler: 'karras', cfg_rescale: 0.2, seed: -1 },
    };
    for (const [overrideSize, expected] of [['768x1280', [768, 1280]], ['default', [1216, 832]]]) {
        const prepared = compileNovelImageRequest(request, { apiBaseUrl: '', resolveForBackend: false, overrideSize, apiKey: 'pst-TEST' }, 1);
        const snapshot = buildNovelGenerationSnapshot({ prepared, request, vibeSummary: [] });
        const eff = resolveEffectiveSize(request.params, overrideSize);
        assert.deepEqual([snapshot.width, snapshot.height], expected);
        assert.deepEqual([eff.width, eff.height], expected);
    }
});

test('notice: visible only while overriding, with the real size', () => {
    assert.deepEqual(sizeOverrideNotice('768x1280'), { visible: true, text: '悬浮球尺寸覆盖中：768 × 1280', width: 768, height: 1280 });
    assert.equal(sizeOverrideNotice('default').visible, false);
    assert.equal(sizeOverrideNotice(undefined).visible, false);
    assert.equal(sizeOverrideNotice('bogus').visible, false);
});

test('cost with override: priced at 768x1280, not the preset 1216x832', () => {
    const eff = effectivePricingConfig(form(), '768x1280');
    assert.equal(eff.overridden, true);
    assert.equal(eff.width * eff.height, 768 * 1280);
    const sub = TABLET.subscription;
    const withOverride = estimateAnlasCost(eff, { subscription: sub });
    const direct = estimateAnlasCost(form({ width: 768, height: 1280 }), { subscription: sub });
    const preset = estimateAnlasCost(form(), { subscription: sub });
    assert.equal(withOverride.total, direct.total);
    assert.notEqual(withOverride.total, preset.total);
    assert.equal(effectivePricingConfig(form(), 'default').width, 1216);
});

test('saved preset pricing / host confirm rule use the effective size', () => {
    const preset = { params: { model: V45, width: 1216, height: 832, steps: 23 } };
    const priced = presetPricingConfig(preset, '768x1280');
    assert.equal(priced.width, 768);
    assert.equal(priced.height, 1280);
    assert.equal(presetPricingConfig(preset).width, 1216);
    const check = presetGenerateConfirm(preset, TABLET.subscription, '768x1280');
    assert.equal(check.estimate.total, estimateAnlasCost(form({ width: 768, height: 1280 }), { subscription: TABLET.subscription }).total);
    assert.equal(presetGenerateConfirm(preset, OPUS.subscription, '768x1280').confirm, false);
});

test('复位: free override is kept and form size untouched', () => {
    const plan = planFreeReset(form({ width: 1600, height: 1600, steps: 40 }), OPUS, { overrideSize: '768x1280' });
    assert.equal(plan.ok, true);
    assert.equal(plan.apply.clearOverride, false);
    assert.equal(plan.apply.width, undefined, 'form size is not in effect, leave it');
    assert.equal(plan.apply.steps, 28);
    assert.equal(plan.config.width, 768);
    assert.equal(estimateAnlasCost(plan.config, { subscription: OPUS.subscription }).total, 0);
});

test('复位: non-free override is cleared, then form size fixed if needed', () => {
    const big = { width: 1280, height: 1280 };
    const keepForm = planFreeReset(form(), OPUS, { overrideSize: big });
    assert.equal(keepForm.apply.clearOverride, true);
    assert.equal(keepForm.apply.width, undefined, 'form 1216x832 is already free');
    assert.match(keepForm.message, /取消悬浮球尺寸覆盖 1280×1280/);
    assert.deepEqual([keepForm.config.width, keepForm.config.height], [1216, 832]);

    const fixForm = planFreeReset(form({ width: 1600, height: 1600 }), OPUS, { overrideSize: big });
    assert.equal(fixForm.apply.clearOverride, true);
    assert.ok(fixForm.apply.width * fixForm.apply.height <= 1048576);
    assert.equal(estimateAnlasCost(fixForm.config, { subscription: OPUS.subscription }).total, 0);
    assert.equal(describeCost(estimateAnlasCost(fixForm.config, { subscription: OPUS.subscription })).free, true);
});

test('复位 without override behaves as before', () => {
    const plan = planFreeReset(form({ width: 1600, height: 1600 }), OPUS);
    assert.equal(plan.apply.clearOverride, false);
    assert.ok(plan.apply.width * plan.apply.height <= 1048576);
    assert.match(plan.message, /只改了表单/);
});
