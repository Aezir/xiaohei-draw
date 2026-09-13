// 本机画廊：同构记录、去重、墓碑与加回、合并到同步仓库（走 SyncCore.sync）、分批、远端墓碑、换仓库、格式太新
import test from 'node:test';
import assert from 'node:assert/strict';
import { seedGallery, bytes } from './helpers.mjs';
import { createFakeIndexedDB } from './fake-indexeddb.mjs';
import { createMemoryKv } from '../../modules/draw/shared/gallery-sync/idb-kv.js';
import { createLocalGallery } from '../../modules/draw/shared/gallery-sync/local-store.js';
import * as G from '../../modules/draw/shared/gallery-sync/gallery-client.js';

const { SyncCore } = G;
const T0 = 1_700_000_000_000;
const entry = (i, extra = {}) => ({ id: `L${i}`, meta: { name: `n${i}`, prompt: `local ${i}`, model: 'V4.5', at: `2026-09-1${i % 10}T00:00:00.000Z`, batch: '角色A', bogus: 1, ...extra }, thumb: bytes(`lt${i}`), full: bytes(`lf${i}`) });

test('add, dedupe, list (hasBlob = local file), load, persists through IndexedDB, blobs never claimed', async () => {
    const idb = createFakeIndexedDB();
    let t = T0;
    const g = createLocalGallery({ indexedDB: idb, now: () => ++t });
    const r = await g.addImages([entry(1), entry(1), entry(2)]);
    assert.deepEqual(r, { added: ['L1', 'L2'], skipped: [] });
    assert.deepEqual((await g.addImages([entry(1)])).skipped, [{ id: 'L1', reason: 'exists' }]);
    assert.equal(await g.has('L1'), 'exists');
    assert.equal(await g.has('zz'), null);

    const g2 = createLocalGallery({ indexedDB: idb });
    const list = await g2.list();
    assert.equal(list.total, 2);
    assert.deepEqual(list.items.map(x => x.id), ['L2', 'L1']);
    assert.ok(list.items.every(x => x.hasBlob && x.local));
    assert.equal(list.items[0].meta.batch, '角色A');
    assert.equal('bogus' in list.items[0].meta, false);
    assert.deepEqual(await g2.loadImage('L1', 'f'), bytes('lf1'));
    assert.equal(await g2.loadImage('nope', 't'), null);
    const { state, local } = await g2.readState();
    assert.equal(local, true);
    assert.deepEqual(state.blobs, {});
    assert.equal(G.listImages(state).total, 2, 'gallery-client.listImages reads the local state as-is');
});

test('remove leaves a tombstone; re-add needs reAdd and beats the tombstone time even with a frozen clock', async () => {
    const g = createLocalGallery({ kv: createMemoryKv(), now: () => T0 });
    await g.addImages([entry(1)]);
    assert.equal(await g.remove('L1'), true);
    assert.equal((await g.list()).total, 0);
    assert.equal(await g.loadImage('L1', 't'), null);
    assert.equal(await g.has('L1'), 'deleted');
    assert.deepEqual((await g.addImages([entry(1)])).skipped, [{ id: 'L1', reason: 'deleted' }]);
    const tomb = (await g.readState()).state.imgs.L1.t;
    assert.deepEqual((await g.addImages([entry(1)], { reAdd: true })).added, ['L1']);
    const { state } = await g.readState();
    assert.ok(state.imgs.L1.t > tomb && state.imgs.L1.on);
    assert.equal(state.dels.L1.on, false);
    const fav = await g.setFav('L1', true);
    assert.deepEqual(fav, { t: T0, on: true, cols: [] });
});

test('mergeToRemote uploads local images, keeps remote records, readable by core + client; second merge is a no-op', async () => {
    const { fake, creds } = await seedGallery({ images: { old: { meta: { prompt: 'old', at: '2026-01-01' }, thumb: bytes('ot'), full: bytes('of') } } });
    const g = createLocalGallery({ kv: createMemoryKv(), now: () => T0 + 10 });
    await g.addImages([entry(1), entry(2)]);
    const res = await g.mergeToRemote(creds);
    assert.deepEqual(res.uploaded.sort(), ['L1', 'L2']);
    assert.equal(res.commits, 1);
    assert.match(fake.messages()[0], /XBDraw · 合并本机画廊 2 张/);

    const { state } = await G.readState(creds);
    assert.deepEqual(Object.keys(state.imgs).sort(), ['L1', 'L2', 'old']);
    assert.equal(state.blobs.L1.on, true);
    assert.equal(state.imgs.L2.meta.batch, '角色A');
    assert.deepEqual(await G.loadImage(creds, 'L1', 'f'), bytes('lf1'));
    const opened = await SyncCore.openState(creds.key, (await SyncCore.snapshot(creds)).state);
    assert.equal(opened.imgs.L1.on, true);

    assert.deepEqual(Object.keys(res.state.imgs).sort(), ['L1', 'L2'], 'remote-only records are not pulled into the local store');
    const n = fake.commitCount();
    const res2 = await g.mergeToRemote(creds);
    assert.equal(res2.pushed, false);
    assert.deepEqual(res2.uploaded, []);
    assert.equal(fake.commitCount(), n);
});

test('more than IMG_BATCH → several commits; remote tombstone wins; id already uploaded by the gallery is not re-uploaded', async () => {
    const { fake, creds } = await seedGallery({
        images: { dup: { meta: { prompt: 'dup' }, thumb: bytes('gt'), full: bytes('gf') }, gone: { rec: { t: T0 + 5000, on: false } } },
        state: { dels: { gone: { t: T0 + 5000, on: true } } },
    });
    const dupBefore = fake.files().get('imgs/dup.t');
    const g = createLocalGallery({ kv: createMemoryKv(), now: () => T0 });
    const many = Array.from({ length: G.IMG_BATCH + 1 }, (_, i) => entry(100 + i));
    await g.addImages([...many, { ...entry(0), id: 'dup' }, { ...entry(0), id: 'gone' }]);
    const res = await g.mergeToRemote(creds);
    assert.equal(res.uploaded.length, G.IMG_BATCH + 1);
    assert.equal(res.commits, 2);
    assert.equal(fake.files().get('imgs/dup.t'), dupBefore);
    assert.equal(fake.files().has('imgs/gone.t'), false);
    assert.equal(res.state.imgs.gone.on, false);
    assert.equal(G.listImages((await G.readState(creds)).state).total, G.IMG_BATCH + 2);
});

test('merging into a second repo re-uploads files (upload bookkeeping is per repo, outside synced state)', async () => {
    const A = await seedGallery();
    const B = await seedGallery();
    const g = createLocalGallery({ kv: createMemoryKv(), now: () => T0 });
    await g.addImages([entry(1)]);
    assert.deepEqual((await g.mergeToRemote(A.creds)).uploaded, ['L1']);
    assert.deepEqual((await g.mergeToRemote(B.creds)).uploaded, ['L1']);
    assert.ok(B.fake.files().has('imgs/L1.f'));
});

test('mergeToRemote refuses a newer-format repo with ver and makes no commit', async () => {
    const { fake, creds } = await seedGallery();
    fake.putFiles({ 'state.bin': await SyncCore._t.pack(await SyncCore._t.keyOf(creds.key), { ...SyncCore.blank(), v: SyncCore.SCHEMA + 1 }) });
    const g = createLocalGallery({ kv: createMemoryKv(), now: () => T0 });
    await g.addImages([entry(1)]);
    const n = fake.commitCount();
    await assert.rejects(g.mergeToRemote(creds), { code: 'ver' });
    assert.equal(fake.commitCount(), n);
    assert.equal((await g.list()).total, 1, 'local store untouched');
});
