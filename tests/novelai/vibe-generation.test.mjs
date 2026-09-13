import test from 'node:test';
import assert from 'node:assert/strict';

// 禁止真实网络：任何未 mock 的 fetch 调用都会让测试失败。
globalThis.fetch = () => { throw new Error('network access is forbidden in tests'); };

const { ensureNovelVibesEncoded, buildNovelGenerationSnapshot } = await import('../../modules/draw/providers/novelai/novel-vibe-generation.js');
const { makeVibeEncodingKey } = await import('../../modules/draw/providers/novelai/novel-vibe-format.js');
const { compileNovelImageRequest, compile } = await import('../../modules/draw/providers/novelai/compiler.js');

const V45 = 'nai-diffusion-4-5-full';
const ITEM_A = { id: 'a', assetId: 'asset-a', name: 'A', informationExtracted: 1, strength: 0.6 };
const ITEM_B = { id: 'b', assetId: 'asset-b', name: 'B', informationExtracted: 0.5, strength: 0.3 };
const vibes = (items, extra = {}) => ({ enabled: true, autoEncode: false, allowOver4: false, items, ...extra });

function memoryStore({ assets = {}, encodings = {} } = {}) {
    const map = new Map(Object.entries(encodings));
    return {
        async getAsset(id) { return assets[id] || null; },
        async getEncoding(id, model, ie) { return map.get(makeVibeEncodingKey(id, model, ie)) || null; },
        async putEncoding(record) { map.set(makeVibeEncodingKey(record.assetId, record.model, record.informationExtracted), record); return record; },
    };
}

function countingEncoder(fail = false) {
    const encode = async () => {
        encode.count++;
        if (fail) throw Object.assign(new Error('HTTP 402'), { code: 'quota' });
        return new Uint8Array([1, 2, 3]).buffer;
    };
    encode.count = 0;
    return encode;
}

test('ensure: missing encoding stops with model + IE in the message; encoder never called', async () => {
    const store = memoryStore({ assets: { 'asset-a': { image: 'AAAA' } } });
    const encode = countingEncoder();
    await assert.rejects(
        ensureNovelVibesEncoded({ vibes: vibes([ITEM_A]), model: V45, store, encode }),
        error => error.code === 'VIBE_NOT_ENCODED' && /已停止生成/.test(error.message) && /V4\.5 Full/.test(error.message) && /1\.00/.test(error.message),
    );
    assert.equal(encode.count, 0);
});

test('ensure: autoEncode in the preset is ignored unless the caller allows encoding (host always passes false)', async () => {
    const store = memoryStore({ assets: { 'asset-a': { image: 'AAAA' } } });
    const encode = countingEncoder();
    await assert.rejects(ensureNovelVibesEncoded({ vibes: vibes([ITEM_A], { autoEncode: true }), model: V45, store, encode }), /没有编码/);
    assert.equal(encode.count, 0);
});

test('ensure: encode error aborts the whole batch (no partial vibes, no retry)', async () => {
    const store = memoryStore({ assets: { 'asset-a': { image: 'AAAA' }, 'asset-b': { image: 'BBBB' } } });
    const encode = countingEncoder(true);
    await assert.rejects(
        ensureNovelVibesEncoded({ vibes: vibes([ITEM_A, ITEM_B]), model: V45, store, encode, allowEncode: true }),
        error => error.code === 'VIBE_ENCODE_FAILED' && /本批已中止/.test(error.message),
    );
    assert.equal(encode.count, 1);
});

test('ensure: V5 and V3 strip vibes with a notice and never touch store or encoder', async () => {
    const encode = countingEncoder();
    const store = { getEncoding() { throw new Error('store must not be touched'); } };
    for (const model of ['nai-diffusion-5-full', 'nai-diffusion-5-curated', 'nai-diffusion-3', 'nai-diffusion-furry-3']) {
        const result = await ensureNovelVibesEncoded({ vibes: vibes([ITEM_A]), model, store, encode });
        assert.deepEqual(result.vibes, []);
        assert.equal(result.stripped, true);
        assert.equal(result.notices.length, 1);
    }
    assert.equal(encode.count, 0);
});

test('ensure: cached encodings are sent as tokens and summarized without tokens', async () => {
    const store = memoryStore({
        encodings: {
            [makeVibeEncodingKey('asset-a', V45, 1)]: { token: 'TOKEN_A' },
            [makeVibeEncodingKey('asset-b', V45, 0.5)]: { token: 'TOKEN_B' },
        },
    });
    const result = await ensureNovelVibesEncoded({ vibes: vibes([ITEM_A, ITEM_B]), model: V45, store });
    assert.deepEqual(result.vibes.map(v => v.token), ['TOKEN_A', 'TOKEN_B']);
    assert.equal(JSON.stringify(result.summary).includes('TOKEN'), false);
    assert.deepEqual(result.summary.map(v => [v.id, v.strength]), [['a', 0.6], ['b', 0.3]]);
    // 前端发送与后端发送编出来的 payload 都带 token（后端只是换了 URL）。
    for (const resolveForBackend of [false, true]) {
        const prepared = compileNovelImageRequest(
            { scene: 's', characterPrompts: [], negativePrompt: '', params: { model: V45, width: 832, height: 1216, steps: 23, scale: 5, sampler: 'k_euler' }, vibes: result.vibes },
            { apiBaseUrl: '', resolveForBackend, baseHref: 'http://localhost:8000/' },
            7,
        );
        assert.deepEqual(prepared.payload.parameters.reference_image_multiple, ['TOKEN_A', 'TOKEN_B']);
    }
});

test('ensure: nothing enabled → empty, no store needed', async () => {
    const result = await ensureNovelVibesEncoded({ vibes: { enabled: false, items: [ITEM_A] }, model: V45, store: null });
    assert.deepEqual(result, { vibes: [], notices: [], summary: [], stripped: false, encodedCount: 0 });
});

test('snapshot: taken from the compiled payload (seed, size override), never contains key/url/token', () => {
    const request = {
        scene: 'best quality, 1girl',
        negativePrompt: 'lowres',
        characterPrompts: [{ prompt: 'girl, red hair', uc: 'bad hands', center: { x: 0.3, y: 0.5 } }],
        params: { model: V45, width: 1216, height: 832, steps: 23, scale: 5, sampler: 'k_euler_ancestral', scheduler: 'karras', cfg_rescale: 0.2, seed: -1 },
        vibes: [{ token: 'SECRET_TOKEN', strength: 0.6 }],
    };
    const prepared = compileNovelImageRequest(request, { apiBaseUrl: '', resolveForBackend: false, overrideSize: '832x1216', apiKey: 'pst-SECRET' }, 12345);
    const snapshot = buildNovelGenerationSnapshot({ prepared, request, vibeSummary: [{ ...ITEM_A, token: 'SECRET_TOKEN' }] });
    assert.equal(snapshot.prompt, 'best quality, 1girl');
    assert.equal(snapshot.uc, 'lowres');
    assert.equal(snapshot.seed, 12345);
    assert.equal(snapshot.model, V45);
    assert.deepEqual([snapshot.width, snapshot.height], [832, 1216]);
    assert.equal(snapshot.steps, 23);
    assert.equal(snapshot.scale, 5);
    assert.equal(snapshot.sampler, 'k_euler_ancestral');
    assert.equal(snapshot.noiseSchedule, 'karras');
    assert.equal(snapshot.cfgRescale, 0.2);
    assert.equal(snapshot.smea, false);
    assert.deepEqual(snapshot.characterPrompts, [{ prompt: 'girl, red hair', uc: 'bad hands', center: { x: 0.3, y: 0.5 } }]);
    assert.deepEqual(snapshot.vibes, [{ id: 'a', assetId: 'asset-a', name: 'A', strength: 0.6, informationExtracted: 1 }]);
    const text = JSON.stringify(snapshot);
    for (const secret of ['pst-SECRET', 'SECRET_TOKEN', 'novelai.net', 'http']) assert.equal(text.includes(secret), false, secret);
});

test('snapshot: batch compile keeps each item seed; V3 records smea/dyn', () => {
    const recipe = {
        apiBaseUrl: '', resolveForBackend: false,
        params: { model: 'nai-diffusion-3', width: 832, height: 1216, steps: 28, scale: 5, sampler: 'k_euler', scheduler: 'native', sm: true, sm_dyn: true },
        seeds: [11, 22], timeout: 1000, requestDelay: { min: 0, max: 0 }, autoLearnEnabled: false, autoLearnMode: 'new_only',
    };
    const batch = compile([{ scene: 'a', characterPrompts: [] }, { scene: 'b', characterPrompts: [] }], recipe);
    const snaps = batch.items.map((item, index) => buildNovelGenerationSnapshot({
        prepared: { payload: item.request.payload },
        request: { ...batch.artifacts[index].promptData, params: recipe.params },
    }));
    assert.deepEqual(snaps.map(s => s.seed), [11, 22]);
    assert.equal(snaps[0].smea, true);
    assert.equal(snaps[0].dyn, true);
    assert.equal(snaps[1].prompt, 'b');
});
