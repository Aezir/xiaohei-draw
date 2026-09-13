import test from 'node:test';
import assert from 'node:assert/strict';

globalThis.fetch = () => { throw new Error('network access is forbidden in tests'); };

const sub = await import('../../modules/draw/providers/novelai/novel-subscription.js');
const { estimateAnlasCost } = await import('../../modules/draw/providers/novelai/novel-anlas-pricing.js');

const RAW = {
    tier: 3,
    active: true,
    expiresAt: 1800000000,
    accountType: 0,
    perks: { maxPriorityActions: 1000, unlimitedMaxPriority: true },
    trainingStepsLeft: { fixedTrainingStepsLeft: 0 },
    usage: { percent: 100, isNegative: false, timeUntilNextPercent: 6048 },
};

function mockFetch(handler) {
    const calls = [];
    const fn = async (url, init = {}) => {
        calls.push({ url: String(url), init });
        return handler(String(url), init, calls.length);
    };
    fn.calls = calls;
    return fn;
}

test('path 1: direct GET succeeds (mocked); key only in Authorization header', async () => {
    const fetchImpl = mockFetch(() => Response.json(RAW));
    const result = await sub.resolveNovelSubscription({ apiKey: 'pst-secret', fetchImpl });
    assert.equal(result.source, 'direct');
    assert.deepEqual(result.subscription, { tier: 3, active: true, expiresAt: 1800000000, usage: { isNegative: false, percent: 100 } });
    assert.equal(fetchImpl.calls.length, 1);
    assert.equal(fetchImpl.calls[0].url, 'https://image.novelai.net/user/subscription');
    assert.equal(fetchImpl.calls[0].init.method, 'GET');
    assert.equal(fetchImpl.calls[0].init.headers.Authorization, 'Bearer pst-secret');
    assert.equal(fetchImpl.calls[0].url.includes('pst-secret'), false);
    assert.equal(estimateAnlasCost({ model: 'nai-diffusion-4-5-full', width: 832, height: 1216, steps: 28 }, { subscription: result.subscription }).total, 0);
});

test('path 2: direct CORS/network failure -> plugin /v1/subscription (key in body, not URL)', async () => {
    const fetchImpl = mockFetch((url) => {
        if (url.startsWith('https://')) throw new TypeError('Failed to fetch');
        return Response.json({ ok: true, subscription: RAW });
    });
    const result = await sub.resolveNovelSubscription({ apiKey: 'pst-secret', fetchImpl, getHeaders: () => ({ 'X-CSRF-Token': 't' }) });
    assert.equal(result.source, 'plugin');
    assert.equal(result.subscription.tier, 3);
    assert.equal(fetchImpl.calls.length, 2);
    assert.equal(fetchImpl.calls[1].url, '/api/plugins/xbdraw-image-proxy/v1/subscription');
    assert.equal(fetchImpl.calls[1].init.headers['X-CSRF-Token'], 't');
    assert.equal(JSON.parse(fetchImpl.calls[1].init.body).key, 'pst-secret');
    assert.equal(result.errors[0].code, 'network');
});

test('path 3: both fail -> manual tier (approx) or unknown', async () => {
    const fetchImpl = mockFetch((url) => {
        if (url.startsWith('https://')) throw new TypeError('Failed to fetch');
        return new Response('', { status: 404 });
    });
    const manual = await sub.resolveNovelSubscription({ apiKey: 'k', manualTier: 'opus', fetchImpl });
    assert.equal(manual.source, 'manual');
    assert.deepEqual(manual.subscription, { tier: 3, active: true, source: 'manual' });
    assert.deepEqual(manual.errors.map(e => e.code), ['network', 'plugin_missing']);
    const est = estimateAnlasCost({ model: 'nai-diffusion-4-5-full', width: 832, height: 1216, steps: 28 }, { subscription: manual.subscription });
    assert.equal(est.confidence, 'approx');
    assert.equal(est.total, 20);
    const unknown = await sub.resolveNovelSubscription({ apiKey: 'k', manualTier: 'auto', fetchImpl });
    assert.equal(unknown.source, 'unknown');
    assert.equal(unknown.subscription, null);
});

test('401 on direct call does not try the plugin', async () => {
    const fetchImpl = mockFetch(() => new Response('Unauthorized', { status: 401 }));
    const result = await sub.resolveNovelSubscription({ apiKey: 'bad', manualTier: 'none', fetchImpl });
    assert.equal(result.source, 'manual');
    assert.equal(result.subscription.tier, 0);
    assert.equal(fetchImpl.calls.length, 1);
    assert.equal(result.errors[0].code, 'auth');
});

test('plugin reporting upstream 401 falls back to manual', async () => {
    const fetchImpl = mockFetch((url) => {
        if (url.startsWith('https://')) throw new TypeError('Failed to fetch');
        return Response.json({ ok: false, status: 401, error: 'Unauthorized' });
    });
    const result = await sub.resolveNovelSubscription({ apiKey: 'bad', manualTier: 'scroll', fetchImpl });
    assert.equal(result.source, 'manual');
    assert.deepEqual(result.errors.map(e => e.code), ['network', 'auth']);
});

test('no API key: no request at all', async () => {
    const fetchImpl = mockFetch(() => Response.json(RAW));
    const result = await sub.resolveNovelSubscription({ apiKey: '  ', manualTier: 'tablet', fetchImpl });
    assert.equal(result.source, 'manual');
    assert.equal(fetchImpl.calls.length, 0);
});

test('manual tier mapping and summarizer', () => {
    assert.equal(sub.subscriptionFromManualTier('auto'), null);
    assert.equal(sub.subscriptionFromManualTier(''), null);
    assert.deepEqual(sub.subscriptionFromManualTier('none'), { tier: 0, active: false, source: 'manual' });
    assert.equal(sub.subscriptionFromManualTier('Scroll').tier, 2);
    assert.equal(sub.summarizeSubscription({ active: true }), null);
    assert.equal('perks' in sub.summarizeSubscription(RAW), false);
});
