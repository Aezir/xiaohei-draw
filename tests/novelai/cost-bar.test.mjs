import test from 'node:test';
import assert from 'node:assert/strict';

globalThis.fetch = () => { throw new Error('network access is forbidden in tests'); };

const { resolveSubscriptionView, describeCost, planFreeReset, needsGenerateConfirm } = await import('../../modules/draw/providers/novelai/ui/nd-cost-bar.js');
const { estimateAnlasCost, isFreeOption } = await import('../../modules/draw/providers/novelai/novel-anlas-pricing.js');

const V45 = 'nai-diffusion-4-5-full';
const OPUS_DATA = { source: 'direct', subscription: { tier: 3, active: true, usage: { isNegative: false } } };
const TABLET_DATA = { source: 'plugin', subscription: { tier: 1, active: true } };
const cfg = (o = {}) => ({ model: V45, width: 832, height: 1216, steps: 23, n_samples: 1, ...o });
const cost = (config, data, manual = 'auto') => describeCost(estimateAnlasCost(config, { subscription: resolveSubscriptionView(data, manual).subscription }));

test('V4.5 832x1216 23 steps: Opus → 0 (free, exact); Tablet → 17; unknown → 约 17; manual Opus → 约 17', () => {
    assert.deepEqual(cost(cfg(), OPUS_DATA), { text: '0', free: true, approx: false, invalid: false });
    assert.deepEqual(cost(cfg(), TABLET_DATA), { text: '17', free: false, approx: false, invalid: false });
    assert.equal(cost(cfg(), { source: 'unknown' }).text, '约 17');
    assert.equal(cost(cfg(), null).text, '约 17');
    const manual = cost(cfg(), { source: 'unknown' }, 'opus');
    assert.equal(manual.text, '约 17');
    assert.equal(manual.free, false);
});

test('V5 Opus with exhausted usage pays; over-limit is invalid', () => {
    assert.equal(cost(cfg({ model: 'nai-diffusion-5-full', steps: 28 }), { source: 'direct', subscription: { tier: 3, active: true, usage: { isNegative: true } } }).text, '30');
    assert.equal(cost(cfg({ model: 'nai-diffusion-5-full', width: 1600, height: 1600, steps: 60 }), TABLET_DATA).text, '参数超出上限');
});

test('subscription view: only direct/plugin are verified', () => {
    assert.equal(resolveSubscriptionView(OPUS_DATA).verified, true);
    assert.equal(resolveSubscriptionView(OPUS_DATA).label, 'Opus');
    assert.equal(resolveSubscriptionView({ source: 'manual', subscription: { tier: 3 } }, 'opus').verified, false);
    assert.equal(resolveSubscriptionView(null).label, '查询中');
    assert.equal(resolveSubscriptionView({ source: 'unknown' }).label, '档位未知');
});

test('复位: unknown tier refuses; Opus transforms paid config to free without touching prompt/seed/sampler', () => {
    assert.equal(planFreeReset(cfg({ steps: 40 }), resolveSubscriptionView({ source: 'unknown' }, 'opus')).ok, false);
    const input = cfg({ width: 1216, height: 1600, steps: 40, prompt: '1girl', seed: 5, sampler: 'k_euler' });
    const view = resolveSubscriptionView(OPUS_DATA);
    const plan = planFreeReset(input, view);
    assert.equal(plan.ok, true);
    assert.equal(plan.apply.steps, 28);
    assert.ok(plan.apply.width * plan.apply.height <= 1048576);
    assert.match(plan.message, /步数 40→28/);
    assert.equal(plan.config.prompt, '1girl');
    assert.equal(plan.config.seed, 5);
    assert.equal(estimateAnlasCost(plan.config, { subscription: view.subscription }).total, 0);
    assert.equal(input.steps, 40, 'input not mutated');
    assert.equal(planFreeReset(cfg(), view).message, '当前参数已经满足免费条件');
});

test('复位: vibes beyond 4 are disabled by index', () => {
    const items = Array.from({ length: 6 }, (_, i) => ({ id: `v${i}`, enabled: true, encoded: true }));
    const plan = planFreeReset(cfg({ vibes: { enabled: true, allowOver4: true, items } }), resolveSubscriptionView(OPUS_DATA));
    assert.deepEqual(plan.apply.disableVibeIndexes, [4, 5]);
});

test('生成确认: required for approx or paid; not for verified free V4.5; V5 by itself is no longer a reason', () => {
    const view = resolveSubscriptionView(OPUS_DATA);
    const est = c => estimateAnlasCost(c, { subscription: view.subscription });
    assert.equal(needsGenerateConfirm({ estimates: [est(cfg())], models: [V45] }).confirm, false);
    const v5 = needsGenerateConfirm({ estimates: [est(cfg({ model: 'nai-diffusion-5-full' }))], models: ['nai-diffusion-5-full'] });
    assert.equal(v5.reasons.some(reason => reason.includes('V5')), false);
    assert.equal(needsGenerateConfirm({ estimates: [{ total: 0, isFree: true, confidence: 'exact' }], models: ['nai-diffusion-5-full'] }).confirm, false);
    assert.equal(needsGenerateConfirm({ estimates: [est(cfg({ steps: 40 }))], models: [V45] }).confirm, true);
    assert.equal(needsGenerateConfirm({ estimates: [estimateAnlasCost(cfg(), { subscription: null })], models: [V45] }).confirm, true);
});

test('green marks: free options per isFreeOption with verified Opus; none when unverified', () => {
    const sub = resolveSubscriptionView(OPUS_DATA).subscription;
    assert.equal(isFreeOption('size', '832x1216', cfg(), sub), true);
    assert.equal(isFreeOption('size', '1280x768', cfg(), sub), true);
    assert.equal(isFreeOption('steps', 23, cfg(), sub), true);
    assert.equal(isFreeOption('sampler', 'k_euler', cfg(), sub), true);
    const unverified = resolveSubscriptionView({ source: 'unknown' }, 'opus');
    assert.equal(isFreeOption('size', '832x1216', cfg(), unverified.verified ? unverified.subscription : null), false);
});
