import test from 'node:test';
import assert from 'node:assert/strict';

globalThis.fetch = () => { throw new Error('network access is forbidden in tests'); };

const {
    estimateAnlasCost,
    toFreeConfig,
    isFreeOption,
    computePerImageAnlas,
    OPUS_FREE_MAX_AREA,
} = await import('../../modules/draw/providers/novelai/novel-anlas-pricing.js');

const V45 = 'nai-diffusion-4-5-full';
const V5 = 'nai-diffusion-5-full';
const V3 = 'nai-diffusion-3';
const OPUS = { tier: 3, active: true, usage: { isNegative: false } };
const OPUS_V5_EMPTY = { tier: 3, active: true, usage: { isNegative: true } };
const OPUS_NO_USAGE = { tier: 3, active: true };
const TABLET = { tier: 1, active: true };

const cfg = (overrides = {}) => ({ model: V45, width: 832, height: 1216, steps: 28, n_samples: 1, ...overrides });

test('verified examples: V4.5 832x1216/28 = 20, V5 = 30, V5 1024x1536/28 = 45 per image', () => {
    assert.equal(computePerImageAnlas(cfg()).perImage, 20);
    assert.equal(computePerImageAnlas(cfg({ model: V5 })).perImage, 30);
    assert.equal(computePerImageAnlas(cfg({ model: V5, width: 1024, height: 1536 })).perImage, 45);
    const est = estimateAnlasCost(cfg({ model: V5, width: 1024, height: 1536 }), { subscription: TABLET });
    assert.equal(est.total, 45);
    assert.equal(est.confidence, 'exact');
});

test('minimum 2 Anlas per image', () => {
    assert.equal(computePerImageAnlas(cfg({ width: 64, height: 64, steps: 1 })).perImage, 2);
});

test('SMEA multipliers apply to V3 only: sm x1.2, sm+dyn x1.4, dyn alone x1', () => {
    assert.equal(computePerImageAnlas(cfg({ model: V3 })).perImage, 20);
    assert.equal(computePerImageAnlas(cfg({ model: V3, sm: true })).perImage, 24);
    assert.equal(computePerImageAnlas(cfg({ model: V3, sm: true, sm_dyn: true })).perImage, 28);
    assert.equal(computePerImageAnlas(cfg({ model: V3, sm_dyn: true })).perImage, 20);
    assert.equal(computePerImageAnlas(cfg({ sm: true, sm_dyn: true })).perImage, 20);
});

test('img2img multiplies by strength; inpaint uses its own strength (default 1)', () => {
    assert.equal(computePerImageAnlas(cfg({ image: 'x', strength: 0.5 })).perImage, 10);
    assert.equal(computePerImageAnlas(cfg({ mask: 'm', image: 'x', strength: 0.5 })).perImage, 20);
    assert.equal(computePerImageAnlas(cfg({ mask: 'm', inpaintImg2ImgStrength: 0.5 })).perImage, 10);
});

test('over 140 per image is invalid', () => {
    const big = computePerImageAnlas(cfg({ model: V5, width: 1600, height: 1600, steps: 60 }));
    assert.equal(big.perImage, 144);
    assert.equal(big.invalid, true);
    assert.equal(estimateAnlasCost(cfg({ model: V5, width: 1600, height: 1600, steps: 60 }), { subscription: OPUS }).invalid, true);
    assert.equal(computePerImageAnlas(cfg({ model: V5, width: 1024, height: 1536 })).invalid, false);
});

test('multiplies by n_samples; Opus free deducts exactly one image', () => {
    assert.equal(estimateAnlasCost(cfg({ n_samples: 4 }), { subscription: TABLET }).total, 80);
    const opus = estimateAnlasCost(cfg({ n_samples: 4 }), { subscription: OPUS });
    assert.equal(opus.total, 60);
    assert.equal(opus.freeImages, 1);
    assert.equal(opus.billableImages, 3);
    assert.ok(opus.freeReasons.includes('n_samples>1'));
});

test('Opus free condition: area <= 1048576, steps <= 28, tier >= 3, active', () => {
    const free = estimateAnlasCost(cfg(), { subscription: OPUS });
    assert.equal(free.total, 0);
    assert.equal(free.isFree, true);
    assert.equal(free.confidence, 'exact');
    assert.equal(estimateAnlasCost(cfg({ width: 1024, height: 1024 }), { subscription: OPUS }).total, 0);
    assert.equal(1024 * 1024, OPUS_FREE_MAX_AREA);
    const tooBig = estimateAnlasCost(cfg({ width: 1024, height: 1088 }), { subscription: OPUS });
    assert.ok(tooBig.total > 0);
    assert.ok(tooBig.freeReasons.some(r => r.startsWith('面积')));
    const tooManySteps = estimateAnlasCost(cfg({ steps: 29 }), { subscription: OPUS });
    assert.ok(tooManySteps.total > 0);
    assert.ok(tooManySteps.freeReasons.some(r => r.startsWith('步数')));
    assert.equal(estimateAnlasCost(cfg(), { subscription: TABLET }).total, 20);
    assert.equal(estimateAnlasCost(cfg(), { subscription: { tier: 3, active: false } }).total, 20);
    assert.ok(estimateAnlasCost(cfg({ characterRefs: 1 }), { subscription: OPUS }).total > 0);
    assert.ok(estimateAnlasCost(cfg({ image: 'x', strength: 1 }), { subscription: OPUS }).total > 0);
});

test('V5 usage.isNegative disables the Opus deduction; unknown usage is approx and never free', () => {
    assert.equal(estimateAnlasCost(cfg({ model: V5 }), { subscription: OPUS }).total, 0);
    const negative = estimateAnlasCost(cfg({ model: V5 }), { subscription: OPUS_V5_EMPTY });
    assert.equal(negative.total, 30);
    assert.equal(negative.confidence, 'exact');
    assert.ok(negative.freeReasons.includes('V5额度已用完'));
    const unknown = estimateAnlasCost(cfg({ model: V5 }), { subscription: OPUS_NO_USAGE });
    assert.equal(unknown.total, 30);
    assert.equal(unknown.confidence, 'approx');
    assert.equal(estimateAnlasCost(cfg(), { subscription: OPUS_V5_EMPTY }).total, 0, 'V4.5 is not limited by V5 usage');
});

test('unknown tier (or manual tier) is approx and never free', () => {
    const unknown = estimateAnlasCost(cfg(), { subscription: null });
    assert.equal(unknown.total, 20);
    assert.equal(unknown.freeImages, 0);
    assert.equal(unknown.confidence, 'approx');
    assert.ok(unknown.freeReasons.includes('未知档位'));
    const manual = estimateAnlasCost(cfg(), { subscription: { tier: 3, active: true, source: 'manual' } });
    assert.equal(manual.total, 20);
    assert.equal(manual.confidence, 'approx');
});

test('vibe and character-reference extras are never free', () => {
    const encoded = [{ enabled: true, encoded: true }, { enabled: true, encoded: true }];
    assert.equal(estimateAnlasCost(cfg(), { subscription: OPUS, vibes: encoded }).total, 0);
    const oneNew = estimateAnlasCost(cfg(), { subscription: OPUS, vibes: [{ encoded: true }, { encoded: false }] });
    assert.equal(oneNew.total, 2);
    assert.equal(oneNew.extra.vibeEncode, 2);
    const five = Array.from({ length: 5 }, () => ({ enabled: true, encoded: true }));
    const overflow = estimateAnlasCost(cfg({ n_samples: 3 }), { subscription: OPUS, vibes: five });
    assert.equal(overflow.extra.vibeOverflow, 2);
    assert.equal(overflow.total, 20 * 2 + 2);
    assert.equal(estimateAnlasCost(cfg({ model: V5 }), { subscription: OPUS, vibes: [{ encoded: false }] }).extra.vibeEncode, 0, 'V5 strips vibes');
    assert.equal(estimateAnlasCost(cfg(), { subscription: OPUS, vibes: [{ enabled: true }] }).confidence, 'approx');
    const refs = estimateAnlasCost(cfg({ n_samples: 2, characterRefs: 2 }), { subscription: OPUS });
    assert.equal(refs.extra.charRef, 5 * 2 * 2);
    assert.equal(refs.extra.vibeEncode, 0);
    assert.equal(refs.total, 20 * 2 + 20);
});

test('preset-style vibe config: disabled config costs nothing, over-4 capped unless allowOver4', () => {
    const items = Array.from({ length: 6 }, () => ({ enabled: true, encoded: true }));
    assert.equal(estimateAnlasCost(cfg(), { subscription: OPUS, vibes: { enabled: false, items } }).total, 0);
    assert.equal(estimateAnlasCost(cfg(), { subscription: OPUS, vibes: { enabled: true, items } }).total, 0);
    assert.equal(estimateAnlasCost(cfg(), { subscription: OPUS, vibes: { enabled: true, allowOver4: true, items } }).total, 4);
});

test('toFreeConfig: result re-estimates to 0, input untouched, prompt/seed/sampler/scale untouched', () => {
    const input = cfg({ width: 1024, height: 1536, steps: 40, n_samples: 3, characterRefs: 1, prompt: '1girl', seed: 123, sampler: 'k_euler', scale: 6 });
    const snapshot = structuredClone(input);
    const result = toFreeConfig(input, OPUS);
    assert.deepEqual(input, snapshot);
    assert.equal(result.possible, true);
    assert.deepEqual({ w: result.config.width, h: result.config.height }, { w: 832, h: 1216 });
    assert.equal(result.config.steps, 28);
    assert.equal(result.config.n_samples, 1);
    assert.equal(result.config.characterRefs, 0);
    for (const key of ['prompt', 'seed', 'sampler', 'scale', 'model']) assert.equal(result.config[key], input[key]);
    assert.deepEqual(result.changes.map(c => c.field).sort(), ['characterRefs', 'height', 'n_samples', 'steps', 'width']);
    assert.equal(estimateAnlasCost(result.config, { subscription: OPUS }).total, 0);
});

test('toFreeConfig: custom sizes scale down to 64 multiples within the free area', () => {
    const result = toFreeConfig(cfg({ width: 1920, height: 1080 }), OPUS);
    assert.equal(result.config.width % 64, 0);
    assert.equal(result.config.height % 64, 0);
    assert.ok(result.config.width * result.config.height <= OPUS_FREE_MAX_AREA);
    assert.equal(estimateAnlasCost(result.config, { subscription: OPUS }).total, 0);
    const square = toFreeConfig(cfg({ width: 1472, height: 1472 }), OPUS);
    assert.deepEqual([square.config.width, square.config.height], [1024, 1024]);
});

test('toFreeConfig: disables vibes beyond 4 and notes unencoded ones; V5 works when usage is known', () => {
    const vibes = Array.from({ length: 6 }, (_, i) => ({ enabled: true, encoded: true, name: `v${i}` }));
    const result = toFreeConfig(cfg({ vibes: { enabled: true, allowOver4: true, items: vibes } }), OPUS);
    assert.equal(result.config.vibes.items.filter(v => v.enabled).length, 4);
    assert.equal(estimateAnlasCost(result.config, { subscription: OPUS }).total, 0);
    const unencoded = toFreeConfig(cfg({ vibes: [{ enabled: true, encoded: false, name: 'x' }] }), OPUS);
    assert.match(unencoded.notices[0], /2 Anlas/);
    const v5 = toFreeConfig(cfg({ model: V5, width: 1024, height: 1536 }), OPUS);
    assert.equal(estimateAnlasCost(v5.config, { subscription: OPUS }).total, 0);
});

test('toFreeConfig refuses when free is impossible or uncertain', () => {
    for (const sub of [null, TABLET, { tier: 3, active: true, source: 'manual' }]) {
        const r = toFreeConfig(cfg({ steps: 50 }), sub);
        assert.equal(r.possible, false);
        assert.equal(r.config.steps, 50);
        assert.deepEqual(r.changes, []);
    }
    assert.equal(toFreeConfig(cfg({ model: V5 }), OPUS_V5_EMPTY).possible, false);
    assert.equal(toFreeConfig(cfg({ model: V5 }), OPUS_NO_USAGE).possible, false);
});

test('isFreeOption follows the green-highlight table and the Opus gate', () => {
    const base = cfg();
    assert.equal(isFreeOption('size', '1024x1024', base, OPUS), true);
    assert.equal(isFreeOption('size', { width: 1024, height: 1536 }, base, OPUS), false);
    assert.equal(isFreeOption('width', 832, base, OPUS), true);
    assert.equal(isFreeOption('steps', 28, base, OPUS), true);
    assert.equal(isFreeOption('steps', 29, base, OPUS), false);
    assert.equal(isFreeOption('n_samples', 1, base, OPUS), true);
    assert.equal(isFreeOption('n_samples', 2, base, OPUS), false);
    for (const field of ['sampler', 'noise_schedule', 'scale', 'cfg_rescale', 'seed']) assert.equal(isFreeOption(field, 'x', base, OPUS), true);
    assert.equal(isFreeOption('sm', true, base, OPUS), true);
    assert.equal(isFreeOption('sm', true, cfg({ width: 1216, height: 1216 }), OPUS), false);
    assert.equal(isFreeOption('characterRef', 1, base, OPUS), false);
    assert.equal(isFreeOption('vibe', { encoded: true, enabledCount: 4 }, base, OPUS), true);
    assert.equal(isFreeOption('vibe', { encoded: false, enabledCount: 1 }, base, OPUS), false);
    assert.equal(isFreeOption('vibe', { encoded: true, enabledCount: 5 }, base, OPUS), false);
    assert.equal(isFreeOption('model', V45, base, OPUS_NO_USAGE), true);
    assert.equal(isFreeOption('model', V5, base, OPUS), true);
    assert.equal(isFreeOption('model', V5, base, OPUS_NO_USAGE), false);
    assert.equal(isFreeOption('steps', 28, cfg({ model: V5 }), OPUS_V5_EMPTY), false);
    for (const sub of [null, TABLET, { tier: 3, active: true, source: 'manual' }]) {
        assert.equal(isFreeOption('sampler', 'x', base, sub), false);
        assert.equal(isFreeOption('steps', 1, base, sub), false);
    }
});

test('every field changed by toFreeConfig passes isFreeOption', () => {
    const result = toFreeConfig(cfg({ width: 1216, height: 1600, steps: 50, n_samples: 4 }), OPUS);
    const c = result.config;
    assert.equal(isFreeOption('size', { width: c.width, height: c.height }, c, OPUS), true);
    assert.equal(isFreeOption('steps', c.steps, c, OPUS), true);
    assert.equal(isFreeOption('n_samples', c.n_samples, c, OPUS), true);
});
