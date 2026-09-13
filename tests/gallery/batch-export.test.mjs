// G2 批量存入：本机 / 远端目标；同批重复、已存在不转码；远端每 30 张一提交；单张失败继续；远端写入出错整批停
import test from 'node:test';
import assert from 'node:assert/strict';
import { seedGallery, fakePng } from './helpers.mjs';
import { createMemoryKv } from '../../modules/draw/shared/gallery-sync/idb-kv.js';
import { createLocalGallery } from '../../modules/draw/shared/gallery-sync/local-store.js';
import { buildGalleryEntry } from '../../modules/draw/shared/gallery-sync/chat-image-export.js';
import { exportChatImagesBatch, describeBatchResult } from '../../modules/draw/shared/gallery-sync/batch-export.js';

const codec = { decodeImage: async () => ({ width: 64, height: 48 }), encodeWebp: async (_i, max) => new TextEncoder().encode(`w${max}`) };
const item = (tag, extra = {}) => ({
    preview: { imgId: `img-${tag}`, base64: Buffer.from(fakePng({ tag })).toString('base64'), characterName: '角色卡', params: { prompt: `p ${tag}`, seed: 7, model: 'nai-diffusion-4-5-full' }, ...extra },
    name2: '角色卡',
});
function countingBuild() {
    const calls = [];
    return { calls, build: async (input) => { calls.push(input.preview.imgId); return buildGalleryEntry(input); } };
}

test('local target: repeats in one batch count once, missing image is an error, second run skips without re-encoding', async () => {
    const store = createLocalGallery({ kv: createMemoryKv() });
    const progress = [];
    const b = countingBuild();
    const items = [item('a'), item('b'), item('a'), { preview: { imgId: 'broken' } }];
    const r = await exportChatImagesBatch(items, { target: { kind: 'local', store }, codec, buildEntry: b.build, onProgress: p => progress.push(p) });
    assert.equal(r.added.length, 2);
    assert.deepEqual(r.skipped.map(s => s.reason), ['repeat']);
    assert.equal(r.errors.length, 1);
    assert.equal(r.errors[0].imgId, 'broken');
    assert.equal(progress.at(-1).phase, 'done');
    assert.equal(progress.filter(p => p.phase === 'encode').at(-1).done, 4);
    const listed = await store.list();
    assert.equal(listed.total, 2);
    assert.equal(listed.items[0].meta.batch, '角色卡');

    const again = await exportChatImagesBatch([item('a'), item('b')], { target: { kind: 'local', store }, codec, buildEntry: b.build });
    assert.deepEqual(again.skipped.map(s => s.reason), ['exists', 'exists']);
    assert.equal(b.calls.length, 2, 'already stored images must not be re-encoded');
    assert.match(describeBatchResult(again).text, /已存在 2 张/);
});

test('remote target: 31 images → 2 commits, files uploaded; second run reads state once and skips all without encoding', async () => {
    const { fake, creds } = await seedGallery();
    const items = Array.from({ length: 31 }, (_, i) => item(`r${i}`));
    const before = fake.commitCount();
    const r = await exportChatImagesBatch(items, { target: { kind: 'remote', creds }, codec });
    assert.equal(r.fatal, '');
    assert.equal(r.added.length, 31);
    assert.equal(r.commits, 2);
    assert.equal(fake.commitCount() - before, 2);
    assert.ok(fake.files().has(`imgs/${r.added[30]}.t`));
    assert.equal(describeBatchResult(r).kind, 'success');

    const b = countingBuild();
    const again = await exportChatImagesBatch(items.slice(0, 3), { target: { kind: 'remote', creds }, codec, buildEntry: b.build });
    assert.deepEqual(again.skipped.map(s => s.reason), ['exists', 'exists', 'exists']);
    assert.equal(b.calls.length, 0);
    assert.equal(fake.commitCount() - before, 2, 'nothing new pushed');
});

test('remote write error stops the batch and keeps the message; unreadable repo stops before encoding', async () => {
    const store = createLocalGallery({ kv: createMemoryKv() });
    let calls = 0;
    const failing = {
        kind: 'remote', creds: {},
        addImages: async () => { calls++; throw Object.assign(new Error('删除保护：这次同步会删掉太多东西，已停止'), { code: 'guard' }); },
    };
    const items = Array.from({ length: 5 }, (_, i) => item(`g${i}`));
    const r = await exportChatImagesBatch(items, { target: failing, codec, batchSize: 2, readRemoteState: async () => ({ state: { imgs: {}, dels: {} } }) });
    assert.equal(calls, 1);
    assert.match(r.fatal, /删除保护/);
    assert.equal(describeBatchResult(r).kind, 'error');

    const b = countingBuild();
    const r2 = await exportChatImagesBatch(items, {
        target: { kind: 'remote', creds: {} }, codec, buildEntry: b.build,
        readRemoteState: async () => { throw Object.assign(new Error('解不开仓库里的数据'), { code: 'pw' }); },
    });
    assert.equal(r2.fatal, '解不开仓库里的数据');
    assert.equal(b.calls.length, 0);
    await assert.rejects(() => exportChatImagesBatch(items, { target: { kind: 'x' } }), /target/);
    assert.equal((await store.list()).total, 0);
});

test('previously deleted in the remote repo: skipped unless reAdd', async () => {
    const { creds } = await seedGallery();
    const one = [item('del')];
    const first = await exportChatImagesBatch(one, { target: { kind: 'remote', creds }, codec });
    const id = first.added[0];
    const state = { imgs: { [id]: { t: 1, on: false } }, dels: { [id]: { t: 1, on: true } } };
    const skipped = await exportChatImagesBatch(one, { target: { kind: 'remote', creds, addImages: async () => { throw new Error('should not write'); } }, codec, readRemoteState: async () => ({ state }) });
    assert.deepEqual(skipped.skipped.map(s => s.reason), ['deleted']);
    let wrote = 0;
    const readd = await exportChatImagesBatch(one, {
        target: { kind: 'remote', creds, addImages: async (_c, entries, opts) => { wrote++; assert.equal(opts.reAdd, true); return { added: entries.map(e => e.id), skipped: [], pushed: true, commits: 1 }; } },
        codec, reAdd: true, readRemoteState: async () => ({ state }),
    });
    assert.equal(wrote, 1);
    assert.deepEqual(readd.added, [id]);
});
