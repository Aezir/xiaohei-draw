// 聊天图 → 画廊记录：参数快照为主、PNG 元数据补、批次 = 角色名、webp 两档、id 去重、本机 / 远端目标
import test from 'node:test';
import assert from 'node:assert/strict';
import { seedGallery, fakePng, bytes } from './helpers.mjs';
import { createMemoryKv } from '../../modules/draw/shared/gallery-sync/idb-kv.js';
import { createLocalGallery } from '../../modules/draw/shared/gallery-sync/local-store.js';
import { buildGalleryEntry, exportChatImage, WEBP_TIERS, modelLabel, resolveBatchName } from '../../modules/draw/shared/gallery-sync/chat-image-export.js';
import * as G from '../../modules/draw/shared/gallery-sync/gallery-client.js';

const TD = new TextDecoder();
function makeCodec() {
    const calls = [];
    return {
        calls,
        decodeImage: async () => ({ width: 2432, height: 1664 }),
        encodeWebp: async (img, max, q) => {
            calls.push([max, q]);
            const s = Math.min(1, max / Math.max(img.width, img.height));
            return bytes(`webp ${Math.round(img.width * s)}x${Math.round(img.height * s)} q${q}`);
        },
    };
}
const snap = {
    prompt: '1girl, snow', uc: 'lowres', seed: 99, model: 'nai-diffusion-4-5-full', steps: 28, scale: 6, sampler: 'k_euler_ancestral', noiseSchedule: 'karras',
    width: 1216, height: 832, smea: false, dyn: false, cfgRescale: 0, characterPrompts: [{ prompt: 'girl', uc: 'bad', center: { x: 0.3, y: 0.5 } }], vibes: [{ id: 'v1', strength: 0.6 }],
};
const b64 = u8 => Buffer.from(u8).toString('base64');

test('snapshot-only preview (PNG without metadata) → complete record; batch = character name; tiers 420/q0.74 and 1216/q0.95', async () => {
    const png = fakePng({});
    const codec = makeCodec();
    const preview = { imgId: 'img1', slotId: 's1', base64: `data:image/png;base64,${b64(png)}`, characterName: '林飞凯', timestamp: Date.UTC(2026, 8, 13, 4, 5), params: snap };
    const e = await buildGalleryEntry({ preview, codec });
    assert.equal(e.id, await G.imageIdOf(png));
    assert.deepEqual(e.sources, { snapshot: true, png: false });
    const { name, ...rest } = e.meta;
    assert.match(name, /^林飞凯 · \d\d-\d\d \d\d:\d\d$/);
    assert.deepEqual(rest, {
        prompt: '1girl, snow', uc: 'lowres', seed: 99, steps: 28, scale: 6, sampler: 'k_euler_ancestral', model: 'V4.5',
        at: '2026-09-13T04:05:00.000Z', file: 'img1.png', w: 2432, h: 1664, pngMeta: true,
        nai: { noise_schedule: 'karras', cfg_rescale: 0, sm: false, sm_dyn: false, chars: [{ prompt: 'girl', uc: 'bad', centers: [{ x: 0.3, y: 0.5 }] }] },
        batch: '林飞凯',
    });
    assert.ok(Object.keys(e.meta).every(k => G.IMG_META.includes(k)));
    assert.deepEqual(codec.calls, [[WEBP_TIERS.thumb.max, 0.74], [WEBP_TIERS.full.max, 0.95]]);
    assert.equal(TD.decode(e.thumb), 'webp 420x287 q0.74');
    assert.equal(TD.decode(e.full), 'webp 1216x832 q0.95');
});

test('PNG NAI metadata fills gaps, snapshot wins on conflicts, group chat uses the speaker name', async () => {
    const png = fakePng({
        Comment: JSON.stringify({ prompt: 'png prompt', uc: 'png uc', seed: 1, steps: 23, scale: 5, sampler: 'k_dpmpp_2m', noise_schedule: 'exponential', uncond_scale: 1, skip_cfg_above_sigma: null }),
        Source: 'NovelAI Diffusion V4.5 1229B44F',
    });
    const preview = { base64: b64(png), params: { seed: 7, model: 'nai-diffusion-5-full' }, positive: 'legacy positive', characterName: '卡名' };
    const e = await buildGalleryEntry({ preview, codec: makeCodec(), message: { name: '群聊角色乙', is_user: false }, name2: '卡名' });
    assert.deepEqual(e.sources, { snapshot: true, png: true });
    const m = e.meta;
    assert.deepEqual([m.seed, m.model, m.prompt, m.uc, m.steps, m.sampler, m.batch], [7, 'V5', 'png prompt', 'png uc', 23, 'k_dpmpp_2m', '群聊角色乙']);
    assert.equal(m.nai.noise_schedule, 'exponential');
    assert.equal(m.nai.uncond_scale, 1);
    assert.equal(m.nai.skip_cfg_above_sigma, null);
    assert.equal(resolveBatchName({ message: { name: '我', is_user: true }, name2: '角色' }), '角色');
    assert.equal(resolveBatchName({}), '未知角色');
    assert.equal(modelLabel('nai-diffusion-4-full'), 'nai-diffusion-4-full');
});

test('no snapshot and no PNG metadata → legacy preview fields; bytes from savedUrl; nothing → input error', async () => {
    const png = fakePng({});
    const urls = [];
    const e = await buildGalleryEntry({
        preview: { savedUrl: '/user/images/%E5%8D%A1/xb_1.png?x=1', positive: 'legacy', negativePrompt: 'neg', characterName: '卡' },
        fetchBytes: async (u) => { urls.push(u); return png.buffer; }, codec: makeCodec(),
    });
    assert.equal(urls.length, 1);
    assert.deepEqual([e.meta.file, e.meta.prompt, e.meta.uc, e.meta.batch], ['xb_1.png', 'legacy', 'neg', '卡']);
    assert.deepEqual(e.sources, { snapshot: false, png: false });
    await assert.rejects(buildGalleryEntry({ preview: {}, codec: makeCodec() }), { code: 'input' });
});

test('local target: same image twice is skipped before encoding; deleted needs reAdd', async () => {
    const store = createLocalGallery({ kv: createMemoryKv() });
    const codec = makeCodec();
    const input = { preview: { base64: b64(fakePng({ a: 'x' })), params: snap, characterName: '角色' }, codec };
    const r1 = await exportChatImage(input, { target: { kind: 'local', store } });
    assert.equal(r1.added.length, 1);
    assert.equal(codec.calls.length, 2);
    const r2 = await exportChatImage(input, { target: { kind: 'local', store } });
    assert.deepEqual(r2.skipped, [{ id: r1.id, reason: 'exists' }]);
    assert.equal(codec.calls.length, 2, 'no re-encode for a known id');
    await store.remove(r1.id);
    assert.deepEqual((await exportChatImage(input, { target: { kind: 'local', store } })).skipped, [{ id: r1.id, reason: 'deleted' }]);
    assert.deepEqual((await exportChatImage(input, { target: { kind: 'local', store }, reAdd: true })).added, [r1.id]);
    const { items } = await store.list();
    assert.equal(items[0].meta.batch, '角色');
    await assert.rejects(exportChatImage(input, {}), { code: 'input' });
});

test('remote target goes through addImages; the gallery sees batch = character name and the webp tiers', async () => {
    const { creds } = await seedGallery();
    const input = { preview: { base64: b64(fakePng({ b: 'y' })), params: snap, characterName: '林飞凯' }, codec: makeCodec() };
    const r = await exportChatImage(input, { target: { kind: 'remote', creds } });
    assert.equal(r.target, 'remote');
    assert.equal(r.pushed, true);
    const { state } = await G.readState(creds);
    assert.equal(state.imgs[r.id].meta.batch, '林飞凯');
    assert.equal(TD.decode(await G.loadImage(creds, r.id, 'f')), 'webp 1216x832 q0.95');
    assert.deepEqual((await exportChatImage(input, { target: { kind: 'remote', creds } })).skipped, [{ id: r.id, reason: 'exists' }]);
});
