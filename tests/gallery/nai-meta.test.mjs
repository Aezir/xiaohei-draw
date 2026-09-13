// 拷贝来的 PNG 元数据函数：G2 用它把聊天图 PNG 解析成和画廊导入时同构的记录
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { pngText, metaFromPng, sha256 } from '../../modules/draw/shared/gallery-sync/vendor/nai-meta.js';
import { imageIdOf } from '../../modules/draw/shared/gallery-sync/gallery-client.js';
import { fakePng } from './helpers.mjs';

const comment = {
    prompt: '1girl, snow', uc: 'lowres', seed: 42, steps: 28, scale: 5, sampler: 'k_euler_ancestral', width: 832, height: 1216,
    noise_schedule: 'karras', cfg_rescale: 0, skip_cfg_above_sigma: null, signed_hash: 'drop-me', n_samples: 1,
    v4_prompt: { caption: { char_captions: [{ char_caption: 'girl A', centers: [{ x: 0.5, y: 0.5 }] }] }, use_coords: false, use_order: true },
    v4_negative_prompt: { caption: { char_captions: [{ char_caption: 'bad A' }] }, legacy_uc: false },
};

test('pngText + metaFromPng build a gallery-shaped record', () => {
    const png = fakePng({ Comment: JSON.stringify(comment), Source: 'NovelAI Diffusion V4.5 4BDE2A90' });
    const text = pngText(png.buffer);
    assert.equal(text.Source, 'NovelAI Diffusion V4.5 4BDE2A90');
    const m = metaFromPng(text, { name: 'a.png', lastModified: 0 });
    assert.equal(m.prompt, '1girl, snow');
    assert.equal(m.uc, 'lowres');
    assert.equal(m.model, 'V4.5');
    assert.equal(m.at, '1970-01-01T00:00:00.000Z');
    assert.equal(m.nai.noise_schedule, 'karras');
    assert.ok('skip_cfg_above_sigma' in m.nai, 'null Variety+ is kept');
    assert.ok(!('signed_hash' in m.nai) && !('width' in m.nai));
    assert.deepEqual(m.nai.chars, [{ prompt: 'girl A', uc: 'bad A', centers: [{ x: 0.5, y: 0.5 }] }]);
    assert.equal(m.nai.use_order, true);
});

test('non-PNG returns null; V5 source label', () => {
    assert.equal(pngText(new Uint8Array(16).buffer), null);
    const m = metaFromPng({ Comment: JSON.stringify({ prompt: 'x', sampler: 'k_euler' }), Source: 'NovelAI Diffusion V5' }, { name: 'b', lastModified: 0 });
    assert.equal(m.model, 'V5');
});

test('image id = first 16 bytes of SHA-256, identical to the gallery', async () => {
    const png = fakePng({ Comment: '{}' });
    const want = createHash('sha256').update(png).digest('hex').slice(0, 32);
    assert.equal(await sha256(png.buffer), want);
    assert.equal(await imageIdOf(png), want);
    assert.equal(await imageIdOf(png.subarray(0)), want);
});
