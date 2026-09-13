import test from 'node:test';
import assert from 'node:assert/strict';

globalThis.fetch = () => { throw new Error('network access is forbidden in tests'); };

const { resolveVibesForGeneration, estimateVibeCost, NovelVibeResolveError } = await import('../../modules/draw/providers/novelai/novel-vibe-resolve.js');
const { normalizeNovelVibeConfig, getActiveNovelVibeItems } = await import('../../modules/draw/providers/novelai/novel-vibe-config.js');
const { makeVibeEncodingKey } = await import('../../modules/draw/providers/novelai/novel-vibe-format.js');
const { compile } = await import('../../modules/draw/providers/novelai/compiler.js');
const { getNovelVibeSupport, supportsNovelVibe } = await import('../../modules/draw/providers/novelai/novel-model-capabilities.js');

const MODEL = 'nai-diffusion-4-5-full';

function createMemoryStore({ assets = {}, encodings = {} } = {}) {
    const encodingMap = new Map(Object.entries(encodings));
    const calls = { put: 0 };
    return {
        calls,
        async getAsset(assetId) { return assets[assetId] || null; },
        async getEncoding(assetId, model, ie) { return encodingMap.get(makeVibeEncodingKey(assetId, model, ie)) || null; },
        async putEncoding(record) {
            calls.put++;
            encodingMap.set(makeVibeEncodingKey(record.assetId, record.model, record.informationExtracted), record);
            return record;
        },
    };
}

function createEncoder(bytes = [1, 2, 3, 4]) {
    const encoder = async () => {
        encoder.count++;
        return new Uint8Array(bytes).buffer;
    };
    encoder.count = 0;
    return encoder;
}

function vibes(items, extra = {}) {
    return { enabled: true, autoEncode: false, allowOver4: false, items, ...extra };
}

const ITEM_A = { id: 'a', assetId: 'asset-a', name: 'A', informationExtracted: 1, strength: 0.6 };
const ITEM_B = { id: 'b', assetId: 'asset-b', name: 'B', informationExtracted: 0.5, strength: 0.3 };

test('capability gating: V4 / V4.5 only', () => {
    assert.equal(supportsNovelVibe('nai-diffusion-4-5-full'), true);
    assert.equal(supportsNovelVibe('nai-diffusion-4-curated-preview'), true);
    assert.equal(supportsNovelVibe('nai-diffusion-5-full'), false);
    assert.equal(supportsNovelVibe('nai-diffusion-3'), false);
    assert.equal(getNovelVibeSupport('nai-diffusion-5-curated').reason, 'v5');
});

test('preset vibes normalization: defaults, clamping, 16-item cap, drops entries without assetId', () => {
    assert.deepEqual(normalizeNovelVibeConfig(undefined), { enabled: false, autoEncode: false, allowOver4: false, items: [] });
    const config = normalizeNovelVibeConfig({
        enabled: true,
        autoEncode: 'yes',
        items: [
            { id: 'x', assetId: 'a1', informationExtracted: 1.7, strength: -1 },
            { id: 'y' },
            ...Array.from({ length: 20 }, (_, i) => ({ id: `z${i}`, assetId: `z${i}`, strength: 0.123 })),
        ],
    });
    assert.equal(config.autoEncode, false);
    assert.equal(config.items.length, 16);
    assert.equal(config.items[0].informationExtracted, 1);
    assert.equal(config.items[0].strength, 0.01);
    assert.equal(config.items[1].strength, 0.12);
    const active = getActiveNovelVibeItems({ ...config, items: config.items });
    assert.equal(active.items.length, 4);
    assert.equal(active.droppedOverLimit, 12);
});

test('autoEncode off + unencoded item: throws and never calls the encoder', async () => {
    const store = createMemoryStore({ assets: { 'asset-a': { image: 'AAAA' } } });
    const encode = createEncoder();
    await assert.rejects(
        resolveVibesForGeneration({ vibes: vibes([ITEM_A]), model: MODEL, store, encode }),
        (error) => error instanceof NovelVibeResolveError && error.code === 'VIBE_NOT_ENCODED' && /1 个氛围未编码/.test(error.message),
    );
    assert.equal(encode.count, 0);
});

test('cache hit: no encoder call, tokens returned in item order', async () => {
    const store = createMemoryStore({
        encodings: {
            [makeVibeEncodingKey('asset-a', MODEL, 1)]: { token: 'TOKEN_A' },
            [makeVibeEncodingKey('asset-b', MODEL, 0.5)]: { token: 'TOKEN_B' },
        },
    });
    const encode = createEncoder();
    const result = await resolveVibesForGeneration({ vibes: vibes([ITEM_A, ITEM_B]), model: MODEL, store, encode });
    assert.equal(encode.count, 0);
    assert.deepEqual(result.vibes.map(v => [v.token, v.strength]), [['TOKEN_A', 0.6], ['TOKEN_B', 0.3]]);
    assert.equal(result.encodeCost, 0);
    assert.equal(result.perImageExtra, 0);
});

test('cache is keyed by asset + model + IE: a different IE is a miss', async () => {
    const store = createMemoryStore({ encodings: { [makeVibeEncodingKey('asset-a', MODEL, 0.9)]: { token: 'OLD' } } });
    await assert.rejects(resolveVibesForGeneration({ vibes: vibes([ITEM_A]), model: MODEL, store }), /未编码/);
    await assert.rejects(resolveVibesForGeneration({ vibes: vibes([{ ...ITEM_A, informationExtracted: 0.9 }]), model: 'nai-diffusion-4-5-curated', store }), /未编码/);
});

test('3-image batch: resolve once (encode at most one round), compile reuses the result', async () => {
    const store = createMemoryStore({ assets: { 'asset-a': { image: 'data:image/png;base64,QUJD' }, 'asset-b': { image: new Uint8Array([9, 9]) } } });
    const encode = createEncoder([5, 6, 7]);
    const resolved = await resolveVibesForGeneration({ vibes: vibes([ITEM_A, ITEM_B], { autoEncode: true }), model: MODEL, store, encode });
    assert.equal(encode.count, 2);
    assert.equal(store.calls.put, 2);
    assert.equal(resolved.encodeCost, 4);
    assert.equal(resolved.vibes[0].token, Buffer.from([5, 6, 7]).toString('base64'));
    const batch = compile([{ scene: 'a', characterPrompts: [] }, { scene: 'b', characterPrompts: [] }, { scene: 'c', characterPrompts: [] }], {
        apiBaseUrl: '',
        resolveForBackend: false,
        params: { model: MODEL, width: 832, height: 1216, steps: 28, scale: 5, sampler: 'k_euler', scheduler: 'karras' },
        seeds: [1, 2, 3],
        timeout: 1000,
        requestDelay: { min: 0, max: 0 },
        autoLearnEnabled: false,
        autoLearnMode: 'new_only',
        vibes: resolved.vibes,
    });
    assert.equal(batch.items.every(item => item.request.payload.parameters.reference_image_multiple.length === 2), true);
    // A second resolve for the same batch hits the cache.
    await resolveVibesForGeneration({ vibes: vibes([ITEM_A, ITEM_B], { autoEncode: true }), model: MODEL, store, encode });
    assert.equal(encode.count, 2);
});

test('encode failure aborts the whole batch (no partial result)', async () => {
    const store = createMemoryStore({ assets: { 'asset-a': { image: 'AAAA' }, 'asset-b': { image: 'BBBB' } } });
    let calls = 0;
    const encode = async () => {
        calls++;
        if (calls === 2) throw Object.assign(new Error('Anlas 不足'), { code: 'quota' });
        return new Uint8Array([1]).buffer;
    };
    await assert.rejects(
        resolveVibesForGeneration({ vibes: vibes([ITEM_A, ITEM_B], { autoEncode: true }), model: MODEL, store, encode }),
        (error) => error.code === 'VIBE_ENCODE_FAILED' && /本批已中止/.test(error.message),
    );
    assert.equal(calls, 2);
});

test('asset without original image cannot be re-encoded', async () => {
    const store = createMemoryStore({ assets: { 'asset-a': { image: null } } });
    const encode = createEncoder();
    await assert.rejects(resolveVibesForGeneration({ vibes: vibes([ITEM_A], { autoEncode: true }), model: MODEL, store, encode }), /没有原图/);
    assert.equal(encode.count, 0);
});

test('V5 / V3: vibes stripped with a notice, store and encoder untouched', async () => {
    const encode = createEncoder();
    for (const model of ['nai-diffusion-5-full', 'nai-diffusion-3']) {
        const result = await resolveVibesForGeneration({ vibes: vibes([ITEM_A], { autoEncode: true }), model, store: null, encode });
        assert.deepEqual(result.vibes, []);
        assert.equal(result.notices.length, 1);
    }
    assert.equal(encode.count, 0);
});

test('disabled config or all items disabled: nothing to do', async () => {
    const result = await resolveVibesForGeneration({ vibes: { enabled: false, items: [ITEM_A] }, model: MODEL, store: null });
    assert.deepEqual(result.vibes, []);
    const none = await resolveVibesForGeneration({ vibes: vibes([{ ...ITEM_A, enabled: false }]), model: MODEL, store: null });
    assert.deepEqual(none.vibes, []);
});

test('over 4 without allowOver4 uses the first 4 and says so; with allowOver4 charges overflow', async () => {
    const items = Array.from({ length: 6 }, (_, i) => ({ id: `v${i}`, assetId: `a${i}`, strength: 0.1 }));
    const encodings = Object.fromEntries(items.map(item => [makeVibeEncodingKey(item.assetId, MODEL, 1), { token: `T${item.assetId}` }]));
    const store = createMemoryStore({ encodings });
    const limited = await resolveVibesForGeneration({ vibes: vibes(items), model: MODEL, store });
    assert.equal(limited.vibes.length, 4);
    assert.equal(limited.perImageExtra, 0);
    assert.match(limited.notices[0], /2 个氛围超过 4 个/);
    const all = await resolveVibesForGeneration({ vibes: vibes(items, { allowOver4: true }), model: MODEL, store });
    assert.equal(all.vibes.length, 6);
    assert.equal(all.perImageExtra, 4);
});

test('estimateVibeCost counts uncached encodings without encoding', async () => {
    const store = createMemoryStore({ encodings: { [makeVibeEncodingKey('asset-a', MODEL, 1)]: { token: 'T' } } });
    const cost = await estimateVibeCost({ vibes: vibes([ITEM_A, ITEM_B]), model: MODEL, store });
    assert.deepEqual(cost, { supported: true, enabled: 2, unencoded: 1, vibeEncode: 2, vibeOverflow: 0 });
    const v5 = await estimateVibeCost({ vibes: vibes([ITEM_A]), model: 'nai-diffusion-5-full', store });
    assert.equal(v5.vibeEncode, 0);
});
