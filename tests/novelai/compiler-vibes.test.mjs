// node --test tests/novelai/  — no network: fetch is replaced by a thrower.
import test from 'node:test';
import assert from 'node:assert/strict';

globalThis.fetch = () => { throw new Error('network access is forbidden in tests'); };

const {
    buildNovelAIRequestBody,
    compile,
    compileNovelImageRequest,
    NOVEL_VIBE_SEND_INFORMATION_EXTRACTED,
} = await import('../../modules/draw/providers/novelai/compiler.js');

const VIBES = [
    { token: 'AAAA', strength: 0.6, informationExtracted: 1 },
    { token: 'BBBB', strength: 0.3, informationExtracted: 0.5 },
    { token: 'CCCC', strength: 0.1, informationExtracted: 0.25 },
];
const DEFAULT_PARAMS = {
    width: 832,
    height: 1216,
    steps: 28,
    scale: 5,
    sampler: 'k_euler_ancestral',
    scheduler: 'karras',
    seed: -1,
    qualityToggle: true,
    ucPreset: 0,
    cfg_rescale: 0,
    v5QualityPresetId: 'default',
    v5UcPresetId: 'heavy',
};

function request(model, extra = {}) {
    return {
        scene: '1girl, smile',
        characterPrompts: [],
        negativePrompt: 'lowres',
        params: { ...DEFAULT_PARAMS, model },
        ...extra,
    };
}

function referenceKeys(value) {
    return [...new Set(JSON.stringify(value).match(/"reference_[a-z_]+"/g) || [])].map(key => key.slice(1, -1)).sort();
}

test('V4.5 with mocked encodings: token + strength arrays of equal length, IE array off by default', () => {
    for (const model of ['nai-diffusion-4-5-full', 'nai-diffusion-4-5-curated', 'nai-diffusion-4-full']) {
        const body = buildNovelAIRequestBody({ ...request(model), seed: 7, vibes: VIBES });
        const p = body.parameters;
        assert.equal(NOVEL_VIBE_SEND_INFORMATION_EXTRACTED, false);
        assert.deepEqual(p.reference_image_multiple, ['AAAA', 'BBBB', 'CCCC']);
        assert.deepEqual(p.reference_strength_multiple, [0.6, 0.3, 0.1]);
        assert.equal(p.reference_image_multiple.length, p.reference_strength_multiple.length);
        assert.equal('reference_information_extracted_multiple' in p, false);
        assert.equal(p.normalize_reference_strength_multiple, true);
    }
});

test('V4.5 with the IE switch on: all three reference arrays have equal lengths', () => {
    const body = buildNovelAIRequestBody({ ...request('nai-diffusion-4-5-full'), seed: 7, vibes: VIBES, sendVibeInformationExtracted: true });
    const p = body.parameters;
    assert.deepEqual(referenceKeys(body), [
        'reference_image_multiple',
        'reference_information_extracted_multiple',
        'reference_strength_multiple',
    ]);
    assert.equal(p.reference_image_multiple.length, 3);
    assert.equal(p.reference_strength_multiple.length, 3);
    assert.equal(p.reference_information_extracted_multiple.length, 3);
    assert.deepEqual(p.reference_information_extracted_multiple, [1, 0.5, 0.25]);
});

test('V5 and V3 compiled requests contain no reference_* fields even when vibes are passed', () => {
    for (const model of ['nai-diffusion-5-full', 'nai-diffusion-5-curated', 'nai-diffusion-3', 'nai-diffusion-furry-3']) {
        const prepared = compileNovelImageRequest(request(model), {
            apiBaseUrl: '',
            defaultParams: {},
            resolveForBackend: false,
            vibes: VIBES,
        }, 42);
        assert.deepEqual(referenceKeys(prepared.payload), [], model);
    }
});

test('empty or missing vibes produce no reference_* fields', () => {
    assert.deepEqual(referenceKeys(buildNovelAIRequestBody({ ...request('nai-diffusion-4-5-full'), seed: 1 })), []);
    assert.deepEqual(referenceKeys(buildNovelAIRequestBody({ ...request('nai-diffusion-4-5-full'), seed: 1, vibes: [] })), []);
});

test('compileNovelImageRequest stays synchronous and passes recipe vibes through', () => {
    const prepared = compileNovelImageRequest(request('nai-diffusion-4-5-full'), {
        apiBaseUrl: '',
        defaultParams: {},
        resolveForBackend: false,
        vibes: VIBES.slice(0, 2),
    }, 3);
    assert.equal(typeof prepared.then, 'undefined');
    assert.equal(prepared.payload instanceof Promise, false);
    assert.deepEqual(prepared.payload.parameters.reference_image_multiple, ['AAAA', 'BBBB']);
});

test('request-level vibes override recipe vibes', () => {
    const prepared = compileNovelImageRequest(request('nai-diffusion-4-5-full', { vibes: [VIBES[2]] }), {
        apiBaseUrl: '',
        defaultParams: {},
        resolveForBackend: false,
        vibes: VIBES,
    }, 3);
    assert.deepEqual(prepared.payload.parameters.reference_image_multiple, ['CCCC']);
});

test('batch compile: every item of a 3-image batch carries the same resolved vibes (resolve once, reuse)', () => {
    const batch = compile([
        { scene: 'a', characterPrompts: [] },
        { scene: 'b', characterPrompts: [] },
        { scene: 'c', characterPrompts: [] },
    ], {
        apiBaseUrl: '',
        resolveForBackend: true,
        baseHref: 'http://localhost:8000/',
        params: { ...DEFAULT_PARAMS, model: 'nai-diffusion-4-5-full' },
        seeds: [1, 2, 3],
        timeout: 60000,
        requestDelay: { min: 0, max: 0 },
        autoLearnEnabled: false,
        autoLearnMode: 'new_only',
        vibes: VIBES.slice(0, 2),
    });
    assert.equal(batch.items.length, 3);
    for (const item of batch.items) {
        assert.deepEqual(item.request.payload.parameters.reference_image_multiple, ['AAAA', 'BBBB']);
        assert.equal(item.request.url, 'https://image.novelai.net/ai/generate-image');
    }
});

test('backend send path: the {key,url,payload} body posted to /v2/generate-image carries encodings, not raw images', () => {
    const prepared = compileNovelImageRequest(request('nai-diffusion-4-5-full'), {
        apiBaseUrl: '',
        defaultParams: {},
        resolveForBackend: true,
        baseHref: 'http://localhost:8000/',
        vibes: VIBES.slice(0, 1),
    }, 9);
    // Same shape as generateViaBackend() in novel-draw.js.
    const posted = JSON.parse(JSON.stringify({ url: prepared.apiUrl, key: 'k', insecure: false, payload: prepared.payload, timeout: 60000 }));
    assert.deepEqual(posted.payload.parameters.reference_image_multiple, ['AAAA']);
    assert.deepEqual(posted.payload.parameters.reference_strength_multiple, [0.6]);
});

test('invalid vibes are rejected instead of silently sent', () => {
    assert.throws(() => buildNovelAIRequestBody({ ...request('nai-diffusion-4-5-full'), seed: 1, vibes: [{ token: '', strength: 0.5 }] }), /token/);
    assert.throws(() => buildNovelAIRequestBody({ ...request('nai-diffusion-4-5-full'), seed: 1, vibes: [{ token: 'A', strength: 2 }] }), /强度/);
    assert.throws(() => buildNovelAIRequestBody({ ...request('nai-diffusion-4-5-full'), seed: 1, vibes: Array.from({ length: 17 }, () => ({ token: 'A', strength: 0.1 })) }), /16/);
});
