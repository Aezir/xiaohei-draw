// gallery-client 对假 GitHub 的端到端测试：连接、读、列表分页、取图、存入（去重 / 墓碑 / 分批）、乐观锁重试、版本太新只读
import test from 'node:test';
import assert from 'node:assert/strict';
import { seedGallery, fakePng, bytes, PW } from './helpers.mjs';
import { createFakeGitHub } from './fake-github.mjs';
import * as G from '../../modules/draw/shared/gallery-sync/gallery-client.js';

const { SyncCore } = G;
const T0 = 1_700_000_000_000;
const img = (i, extra = {}) => ({ meta: { name: `img${i}`, prompt: `tag${i}, snow`, model: i % 2 ? 'V5' : 'V4.5', at: `2026-09-0${i}T00:00:00.000Z`, ...extra }, thumb: bytes(`thumb-${i}`), full: bytes(`full-${i}`) });
const patches = fake => fake.log.filter(x => x.method === 'PATCH').length;

test('connect: wrong password → pw; right password → same key; password never returned', async () => {
    const { fake, creds } = await seedGallery();
    await assert.rejects(G.connect({ tok: 'tok-rw', pw: 'wrong password', repo: fake.repo, fetch: fake.fetch }), { code: 'pw' });
    const c = await G.connect({ tok: 'Bearer tok-rw', pw: PW, repo: `https://github.com/${fake.repo}.git`, fetch: fake.fetch });
    assert.deepEqual(Object.keys(c).sort(), ['fresh', 'key', 'repo', 'tok']);
    assert.equal(c.key, creds.key);
    assert.equal(c.repo, fake.repo);
    assert.equal(c.fresh, false);
});

test('connect: repo auto-detect, ambiguous token, input checks without network', async () => {
    const { fake } = await seedGallery();
    assert.equal((await G.connect({ tok: 'tok-rw', pw: PW, fetch: fake.fetch })).repo, fake.repo);
    const multi = createFakeGitHub({ tokens: { t2: { repos: ['a/b', 'c/d'], write: true } } });
    await assert.rejects(G.connect({ tok: 't2', pw: PW, fetch: multi.fetch }), e => e.code === 'repo' && e.list.length === 2);
    const before = fake.log.length;
    await assert.rejects(G.connect({ tok: 'tok-rw', pw: 'short', fetch: fake.fetch }), { code: 'input' });
    await assert.rejects(G.connect({ tok: '', pw: PW, fetch: fake.fetch }), { code: 'input' });
    await assert.rejects(G.connect({ tok: 'tok-rw', pw: PW, repo: 'not a repo', fetch: fake.fetch }), { code: 'input' });
    assert.equal(fake.log.length, before);
    await assert.rejects(G.connect({ tok: 'nope', pw: PW, repo: fake.repo, fetch: fake.fetch }), { status: 401 });
});

test('connect: un-initialised repo is refused by default (no write); allowInit initialises', async () => {
    const fake = createFakeGitHub();
    await assert.rejects(G.connect({ tok: 'tok-rw', pw: PW, repo: fake.repo, fetch: fake.fetch }), { code: 'nometa' });
    assert.equal(fake.commitCount(), 0);
    const c = await G.connect({ tok: 'tok-rw', pw: PW, repo: fake.repo, fetch: fake.fetch, allowInit: true });
    assert.equal(c.fresh, true);
    assert.ok(fake.files().has('meta.json'));
});

test('readState decrypts what the core packed; wrong key → pw; empty repo → blank', async () => {
    const { fake, creds } = await seedGallery({ images: { a: img(1) }, state: { fav: { a: { t: T0, on: true, cols: [] } } } });
    const r = await G.readState(creds);
    assert.equal(r.readOnly, false);
    assert.equal(r.schema, 2);
    assert.equal(r.head, fake.head());
    assert.equal(r.state.imgs.a.meta.prompt, 'tag1, snow');
    assert.equal(r.state.blobs.a.on, true);
    assert.equal(r.state.fav.a.on, true);
    const other = await seedGallery();
    await assert.rejects(G.readState({ ...creds, key: other.creds.key }), { code: 'pw' });
    const fresh = createFakeGitHub();
    await G.connect({ tok: 'tok-rw', pw: PW, repo: fresh.repo, fetch: fresh.fetch, allowInit: true });
    const blank = await G.readState({ ...creds, fetch: fresh.fetch });
    assert.deepEqual(blank.state, SyncCore.blank());
});

test('listImages: filters tombstones / dels / no-meta, sorts newest first, paginates', async () => {
    const images = { i1: img(1), i2: img(2), i3: img(3), i4: img(4), i5: img(5), gone: { rec: { t: T0, on: false } }, bare: { rec: { t: T0, on: true } } };
    const { creds } = await seedGallery({ images, state: { dels: { i5: { t: T0, on: true } }, fav: { i2: { t: T0, on: true, cols: [] } } } });
    const { state } = await G.readState(creds);
    const p1 = G.listImages(state, { limit: 2 });
    assert.equal(p1.total, 4);
    assert.deepEqual(p1.items.map(x => x.id), ['i4', 'i3']);
    assert.equal(p1.nextOffset, 2);
    const p2 = G.listImages(state, { limit: 2, offset: p1.nextOffset });
    assert.deepEqual(p2.items.map(x => x.id), ['i2', 'i1']);
    assert.equal(p2.nextOffset, null);
    assert.ok(p2.items[0].fav && p2.items[0].hasBlob);
    assert.deepEqual(G.listImages(state, { favOnly: true }).items.map(x => x.id), ['i2']);
    assert.deepEqual(G.listImages(state, { model: 'V5' }).items.map(x => x.id), ['i3', 'i1']);
    assert.deepEqual(G.listImages(state, { query: 'TAG4' }).items.map(x => x.id), ['i4']);
});

test('loadImage: thumb/full decrypt, large file via git/blobs, cache hit skips network, missing → null', async () => {
    const big = new Uint8Array(4096).map((_, i) => i % 251);
    const { fake, creds } = await seedGallery({ images: { a: { ...img(1), full: big } }, fakeOpts: { inlineLimit: 1024 } });
    assert.deepEqual(await G.loadImage(creds, 'a', 't'), bytes('thumb-1'));
    const store = new Map(), cache = { get: k => store.get(k), set: (k, v) => store.set(k, v) };
    assert.deepEqual(await G.loadImage(creds, 'a', 'f', { cache }), big);
    assert.ok(fake.log.some(x => x.path.includes('/git/blobs/')), 'went through blobs API');
    const n = fake.log.length;
    assert.deepEqual(await G.loadImage(creds, 'a', 'f', { cache }), big);
    assert.equal(fake.log.length, n);
    assert.equal(await G.loadImage(creds, 'nope', 't'), null);
});

test('createThumbQueue: dedupes ids and caps concurrency', async () => {
    const images = Object.fromEntries([1, 2, 3, 4, 5, 6].map(i => [`i${i}`, img(i)]));
    const { fake, creds } = await seedGallery({ images });
    let inflight = 0, peak = 0;
    const slowFetch = async (...a) => { inflight++; peak = Math.max(peak, inflight); await new Promise(r => setTimeout(r, 5)); try { return await fake.fetch(...a); } finally { inflight--; } };
    const q = G.createThumbQueue({ ...creds, fetch: slowFetch }, { concurrency: 2 });
    assert.equal(q.get('i1'), q.get('i1'));
    const got = await Promise.all(Object.keys(images).map(id => q.get(id)));
    assert.deepEqual(got[5], bytes('thumb-6'));
    assert.ok(peak <= 2, `peak ${peak}`);
});

test('addImages: new image uploads blobs + record; same PNG again is skipped with no commit', async () => {
    const { fake, creds } = await seedGallery({ images: { old: img(1) } });
    const png = fakePng({ Comment: JSON.stringify({ prompt: 'chat pic', sampler: 'k_euler' }) });
    const id = await G.imageIdOf(png);
    const entry = { png, meta: { name: '角色 · 09-13', prompt: 'chat pic', model: 'V4.5', at: '2026-09-13T00:00:00.000Z', bogus: 'dropped' }, thumb: bytes('t'), full: bytes('f') };
    const r1 = await G.addImages(creds, [entry, { ...entry }], { now: () => T0 + 1 });
    assert.deepEqual(r1, { added: [id], skipped: [], pushed: true, commits: 1 });
    assert.ok(fake.files().has(`imgs/${id}.t`) && fake.files().has(`imgs/${id}.f`));
    assert.match(fake.messages()[0], /XBDraw · 存入 1 张/);
    const { state } = await G.readState(creds);
    assert.deepEqual(state.imgs[id], { t: T0 + 1, on: true, meta: { name: '角色 · 09-13', prompt: 'chat pic', model: 'V4.5', at: '2026-09-13T00:00:00.000Z' } });
    assert.deepEqual(state.blobs[id], { t: T0 + 1, on: true });
    assert.equal(state.imgs.old.meta.name, 'img1', 'existing records kept');
    assert.deepEqual(await G.loadImage(creds, id, 'f'), bytes('f'));

    const commits = fake.commitCount();
    const r2 = await G.addImages(creds, [{ ...entry, meta: { prompt: 'changed' } }], { now: () => T0 + 99 });
    assert.deepEqual(r2, { added: [], skipped: [{ id, reason: 'exists' }], pushed: false, commits: 0 });
    assert.equal(fake.commitCount(), commits);
    assert.equal((await G.readState(creds)).state.imgs[id].meta.prompt, 'chat pic', 'remote record not overwritten');
});

test('addImages: tombstoned id is skipped unless reAdd', async () => {
    const { creds } = await seedGallery({ images: { dead: { rec: { t: T0 + 5000, on: false } } }, state: { dels: { dead: { t: T0 + 5000, on: true } } } });
    const entry = { id: 'dead', meta: { prompt: 'back' }, thumb: bytes('t'), full: bytes('f') };
    assert.deepEqual((await G.addImages(creds, [entry], { now: () => T0 })).skipped, [{ id: 'dead', reason: 'deleted' }]);
    const r = await G.addImages(creds, [entry], { now: () => T0, reAdd: true });
    assert.deepEqual(r.added, ['dead']);
    const { state } = await G.readState(creds);
    assert.equal(state.imgs.dead.on, true);
    assert.equal(state.dels.dead.on, false);
    assert.deepEqual(G.listImages(state).items.map(x => x.id), ['dead']);
});

test('addImages: more than IMG_BATCH images → several commits', async () => {
    const { fake, creds } = await seedGallery();
    const entries = Array.from({ length: G.IMG_BATCH + 1 }, (_, i) => ({ id: `b${i}`, meta: { prompt: `p${i}` }, thumb: bytes(`t${i}`), full: bytes(`f${i}`) }));
    const r = await G.addImages(creds, entries);
    assert.equal(r.added.length, 31);
    assert.equal(r.commits, 2);
    assert.equal(G.listImages((await G.readState(creds)).state).total, 31);
    assert.equal([...fake.files().keys()].filter(p => p.startsWith('imgs/')).length, 62);
});

test('concurrent write: another device pushes mid-commit → 422 → core retries, both survive', async () => {
    const { fake, creds } = await seedGallery({ images: { base: img(1) } });
    fake.hooks.beforeRefUpdate = async () => {
        await SyncCore.sync({
            ...creds, local: { ...SyncCore.blank(), imgs: { other: { t: T0 + 2, on: true, meta: { prompt: 'from phone' } } }, fav: { base: { t: T0 + 2, on: true, cols: [] } } },
            plan: async (merged, remote, { pack }) => { merged.blobs.other = { t: T0 + 2, on: true }; return { files: [['imgs/other.t', await pack(bytes('ot'))], ['imgs/other.f', await pack(bytes('of'))]], removes: [] }; },
        });
    };
    const p0 = patches(fake);
    const r = await G.addImages(creds, [{ id: 'mine', meta: { prompt: 'from xbdraw' }, thumb: bytes('mt'), full: bytes('mf') }], { now: () => T0 + 3 });
    assert.deepEqual(r.added, ['mine']);
    assert.equal(patches(fake) - p0, 3, 'other device 1 + ours rejected 1 + ours retried 1');
    const { state } = await G.readState(creds);
    assert.deepEqual(Object.keys(state.imgs).sort(), ['base', 'mine', 'other']);
    assert.ok(state.blobs.mine.on && state.blobs.other.on && state.fav.base.on);
    for (const p of ['imgs/mine.t', 'imgs/other.f', 'imgs/base.t']) assert.ok(fake.files().has(p), p);
});

test('gallery device syncing afterwards keeps XBDraw uploads and does not trip the deletion guard', async () => {
    const { fake, creds, local } = await seedGallery({ images: { a: img(1), b: img(2) } });
    await G.addImages(creds, [{ id: 'x', meta: { prompt: 'x' }, thumb: bytes('t'), full: bytes('f') }]);
    const galleryLocal = { ...local, blobs: { a: { t: T0, on: true }, b: { t: T0, on: true } } };
    const r = await SyncCore.sync({ ...creds, local: galleryLocal });
    assert.equal(r.merged.imgs.x.on, true);
    assert.equal(r.merged.blobs.x.on, true);
    assert.ok(fake.files().has('imgs/x.f'));
});

test('unknown top-level fields written by a newer same-schema page survive an XBDraw write', async () => {
    const { fake, creds } = await seedGallery({ images: { a: img(1) } });
    const { state } = await G.readState(creds);
    fake.putFiles({ 'state.bin': await SyncCore._t.pack(await SyncCore._t.keyOf(creds.key), { ...state, futureField: { keep: true } }) });
    await G.addImages(creds, [{ id: 'n', meta: { prompt: 'n' }, thumb: bytes('t'), full: bytes('f') }]);
    assert.deepEqual((await G.readState(creds)).state.futureField, { keep: true });
});

test('format version too new → readState readOnly (still browsable); addImages refused with ver and no commit', async () => {
    const { fake, creds } = await seedGallery();
    const future = { ...SyncCore.blank(), v: SyncCore.SCHEMA + 1, imgs: { f: { t: T0, on: true, meta: { prompt: 'future', at: '2027-01-01' } } }, blobs: {}, newMap: {} };
    fake.putFiles({ 'state.bin': await SyncCore._t.pack(await SyncCore._t.keyOf(creds.key), future) });
    const r = await G.readState(creds);
    assert.equal(r.readOnly, true);
    assert.equal(r.schema, 3);
    assert.deepEqual(G.listImages(r.state).items.map(x => x.id), ['f']);
    const commits = fake.commitCount(), p0 = patches(fake);
    await assert.rejects(G.addImages(creds, [{ id: 'z', meta: {}, thumb: bytes('t'), full: bytes('f') }]), { code: 'ver' });
    assert.equal(fake.commitCount(), commits);
    assert.equal(patches(fake), p0);
});

test('read-only token can browse but writes surface 403', async () => {
    const { fake, creds } = await seedGallery({ images: { a: img(1) }, fakeOpts: { tokens: { 'tok-rw': { repos: ['Aezir/nai-gallery-data'], write: true }, 'tok-ro': { repos: ['Aezir/nai-gallery-data'], write: false } } } });
    const ro = { ...creds, tok: 'tok-ro' };
    assert.equal(G.listImages((await G.readState(ro)).state).total, 1);
    await assert.rejects(G.addImages(ro, [{ id: 'q', meta: {}, thumb: bytes('t'), full: bytes('f') }]), { status: 403 });
    assert.equal(fake.files().has('imgs/q.t'), false);
});
