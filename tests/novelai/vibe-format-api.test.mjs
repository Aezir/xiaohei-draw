import test from 'node:test';
import assert from 'node:assert/strict';

globalThis.fetch = () => { throw new Error('network access is forbidden in tests'); };

const format = await import('../../modules/draw/providers/novelai/novel-vibe-format.js');
const api = await import('../../modules/draw/providers/novelai/novel-vibe-api.js');

test('.naiv4vibe round trip keeps structure; unknown model keys are kept but unmapped', () => {
    const sample = {
        identifier: 'novelai-vibe-transfer',
        version: 1,
        type: 'image',
        id: 'abc123',
        name: 'sample',
        createdAt: 1700000000000,
        image: 'QUJD',
        thumbnail: 'data:image/jpeg;base64,AAAA',
        encodings: {
            'v4-5full': { '1.00': { encoding: 'VE9LRU4x', params: { information_extracted: 1 } } },
            'v4-5curated': { '0.50': { encoding: 'VE9LRU4y', params: { information_extracted: 0.5 } } },
            'v9mystery': { '1.00': { encoding: 'VE9LRU4z', params: { information_extracted: 1 } } },
        },
        importInfo: { model: 'v4-5full', information_extracted: 1, strength: 0.7 },
    };
    const parsed = format.parseNaiv4Vibe(JSON.stringify(sample));
    assert.equal(parsed.asset.assetId, 'abc123');
    assert.equal(parsed.asset.imageBase64, 'QUJD');
    assert.deepEqual(parsed.unknownModelKeys, ['v9mystery']);
    assert.deepEqual(parsed.encodings.map(e => [e.modelKey, e.model, e.informationExtracted, e.token]), [
        ['v4-5full', 'nai-diffusion-4-5-full', 1, 'VE9LRU4x'],
        ['v4-5curated', 'nai-diffusion-4-5-curated', 0.5, 'VE9LRU4y'],
        ['v9mystery', null, 1, 'VE9LRU4z'],
    ]);
    assert.equal(parsed.defaults.strength, 0.7);
    const rebuilt = format.buildNaiv4Vibe(parsed);
    assert.deepEqual(rebuilt, sample);
    assert.deepEqual(format.parseNaiv4Vibe(rebuilt), parsed);
});

test('.naiv4vibe rejects foreign identifiers and bad JSON', () => {
    assert.throws(() => format.parseNaiv4Vibe('{'), /JSON/);
    assert.throws(() => format.parseNaiv4Vibe({ identifier: 'something-else' }), /标识/);
});

test('encoding cache key and base64 helpers', async () => {
    assert.equal(format.makeVibeEncodingKey('a', 'nai-diffusion-4-5-full', 0.5), 'a|nai-diffusion-4-5-full|0.50');
    assert.deepEqual([...format.base64ToBytes(format.bytesToBase64(new Uint8Array([0, 255, 7])))], [0, 255, 7]);
    assert.equal(format.stripDataUrl('data:image/png;base64,QQ=='), 'QQ==');
    assert.equal((await format.sha256Hex('abc')).slice(0, 8), 'ba7816bf');
});

function mockFetch(handler) {
    const calls = [];
    const fn = async (url, init = {}) => {
        calls.push({ url: String(url), init });
        return handler(String(url), init, calls.length);
    };
    fn.calls = calls;
    return fn;
}

function binaryResponse(bytes, status = 200) {
    return new Response(new Uint8Array(bytes), { status });
}

test('encodeVibeRaw: JSON {image, information_extracted, model} with Bearer auth -> ArrayBuffer', async () => {
    const fetchImpl = mockFetch(() => binaryResponse([1, 2, 3]));
    const buffer = await api.encodeVibeRaw({
        image: 'data:image/png;base64,QUJD',
        informationExtracted: 0.333,
        model: 'nai-diffusion-4-5-full',
        apiKey: 'pst-test',
        fetchImpl,
    });
    assert.deepEqual([...new Uint8Array(buffer)], [1, 2, 3]);
    assert.equal(fetchImpl.calls.length, 1);
    const [{ url, init }] = fetchImpl.calls;
    assert.equal(url, 'https://image.novelai.net/ai/encode-vibe');
    assert.equal(init.method, 'POST');
    assert.equal(init.headers.Authorization, 'Bearer pst-test');
    assert.deepEqual(JSON.parse(init.body), { image: 'QUJD', information_extracted: 0.33, model: 'nai-diffusion-4-5-full' });
});

test('encode URL follows a custom base URL', () => {
    assert.equal(api.resolveNovelVibeEncodeUrl('https://proxy.example/ai/generate-image'), 'https://proxy.example/ai/encode-vibe');
    assert.equal(api.resolveNovelVibeEncodeUrl('https://proxy.example/'), 'https://proxy.example/ai/encode-vibe');
});

test('encodeVibeRaw validates before any request (V5 model, empty image, no key)', async () => {
    const fetchImpl = mockFetch(() => binaryResponse([1]));
    await assert.rejects(api.encodeVibeRaw({ image: 'A', informationExtracted: 1, model: 'nai-diffusion-5-full', apiKey: 'k', fetchImpl }), /V4/);
    await assert.rejects(api.encodeVibeRaw({ image: '', informationExtracted: 1, model: 'nai-diffusion-4-5-full', apiKey: 'k', fetchImpl }), /为空/);
    await assert.rejects(api.encodeVibeRaw({ image: 'A', informationExtracted: 1, model: 'nai-diffusion-4-5-full', apiKey: '', fetchImpl }), /API Key/);
    assert.equal(fetchImpl.calls.length, 0);
});

test('encodeVibeRaw maps 401 / 402 and network errors', async () => {
    const opts = { image: 'A', informationExtracted: 1, model: 'nai-diffusion-4-5-full', apiKey: 'k' };
    await assert.rejects(api.encodeVibeRaw({ ...opts, fetchImpl: mockFetch(() => new Response('no', { status: 401 })) }), e => e.code === 'auth');
    await assert.rejects(api.encodeVibeRaw({ ...opts, fetchImpl: mockFetch(() => new Response('no', { status: 402 })) }), e => e.code === 'quota');
    await assert.rejects(api.encodeVibeRaw({ ...opts, fetchImpl: mockFetch(() => { throw new TypeError('Failed to fetch'); }) }), e => e.code === 'network');
});

test('encodeVibe: direct CORS failure falls back to the plugin only when it advertises the capability', async () => {
    const opts = { image: 'A', informationExtracted: 1, model: 'nai-diffusion-4-5-full', apiKey: 'k', apiBaseUrl: '' };
    const fetchImpl = mockFetch((url) => {
        if (url.startsWith('https://image.novelai.net')) throw new TypeError('Failed to fetch');
        return Response.json({ ok: true, base64: Buffer.from([8, 9]).toString('base64'), bytes: 2 });
    });
    const capabilityChecks = [];
    const result = await api.encodeVibe({
        ...opts,
        fetchImpl,
        hasBackendCapability: async (name) => { capabilityChecks.push(name); return true; },
    });
    assert.equal(result.via, 'plugin');
    assert.deepEqual([...new Uint8Array(result.buffer)], [8, 9]);
    assert.deepEqual(capabilityChecks, ['novelai-encode-vibe-v1']);
    assert.equal(fetchImpl.calls.length, 2);
    assert.equal(fetchImpl.calls[1].url, '/api/plugins/xbdraw-image-proxy/v1/encode-vibe');
    const pluginBody = JSON.parse(fetchImpl.calls[1].init.body);
    assert.equal(pluginBody.key, 'k');
    assert.equal(pluginBody.url, 'https://image.novelai.net/ai/encode-vibe');
    assert.equal(fetchImpl.calls[1].url.includes('k'), false);

    const noPlugin = mockFetch(() => { throw new TypeError('Failed to fetch'); });
    await assert.rejects(api.encodeVibe({ ...opts, fetchImpl: noPlugin, hasBackendCapability: async () => false }), e => e.code === 'network');
    assert.equal(noPlugin.calls.length, 1);
});

test('encodeVibe: HTTP errors never retry or switch channel (no double charge)', async () => {
    const fetchImpl = mockFetch(() => new Response('Not enough Anlas', { status: 402 }));
    await assert.rejects(api.encodeVibe({
        image: 'A', informationExtracted: 1, model: 'nai-diffusion-4-5-full', apiKey: 'k', fetchImpl,
        hasBackendCapability: async () => true,
    }), e => e.code === 'quota');
    assert.equal(fetchImpl.calls.length, 1);
});

test('encodeVibe: sendMode backend goes straight to the plugin and surfaces upstream status', async () => {
    const fetchImpl = mockFetch(() => Response.json({ ok: false, status: 401, error: 'Unauthorized' }));
    await assert.rejects(api.encodeVibe({
        sendMode: 'backend', image: 'A', informationExtracted: 1, model: 'nai-diffusion-4-full', apiKey: 'k', fetchImpl,
    }), e => e.code === 'auth');
    assert.equal(fetchImpl.calls.length, 1);
    assert.equal(fetchImpl.calls[0].url, '/api/plugins/xbdraw-image-proxy/v1/encode-vibe');
    const missing = mockFetch(() => new Response('', { status: 404 }));
    await assert.rejects(api.encodeVibeViaBackend({ image: 'A', informationExtracted: 1, model: 'nai-diffusion-4-full', apiKey: 'k', fetchImpl: missing }), e => e.code === 'plugin_missing');
});
