// 记住登录：IndexedDB 键值封装、凭据只存 repo/tok/key、不存密码、断开清缓存、失败状态不带秘密
import test from 'node:test';
import assert from 'node:assert/strict';
import { seedGallery, PW, bytes } from './helpers.mjs';
import { createFakeIndexedDB } from './fake-indexeddb.mjs';
import { createIdbKv, createMemoryKv } from '../../modules/draw/shared/gallery-sync/idb-kv.js';
import { createCredentialStore, THUMB_DB, LINK_DB } from '../../modules/draw/shared/gallery-sync/credential-store.js';
import { loadImage } from '../../modules/draw/shared/gallery-sync/gallery-client.js';

const dumpText = idb => JSON.stringify([...idb._dump()].map(([n, d]) => [n, [...d.stores].map(([s, m]) => [s, [...m]])]));

test('idb-kv: get/set/del/keys/clear, stored values are copies, data survives reopening', async () => {
    const idb = createFakeIndexedDB();
    const a = createIdbKv('db1', { indexedDB: idb });
    assert.equal(await a.get('x'), undefined);
    const val = { n: 1, u8: bytes('hi') };
    await a.set('x', val);
    val.n = 2;
    assert.deepEqual(await a.get('x'), { n: 1, u8: bytes('hi') });
    await a.set('y', 2);
    assert.deepEqual((await a.keys()).sort(), ['x', 'y']);
    await a.del('x');
    await a.close();
    const b = createIdbKv('db1', { indexedDB: idb });
    assert.deepEqual(await b.keys(), ['y']);
    await b.clear();
    assert.deepEqual(await b.keys(), []);
    assert.throws(() => createIdbKv('z', { indexedDB: null }), { code: 'noidb' });
    const m = createMemoryKv();
    const o = { a: 1 };
    await m.set('k', o); o.a = 9;
    assert.deepEqual(await m.get('k'), { a: 1 });
});

test('connect remembers repo/tok/key (never the password), survives reload, thumb cache fills, logout clears creds + thumbs', async () => {
    const { fake, creds } = await seedGallery({ images: { a: { meta: { prompt: 'p' }, thumb: bytes('t1'), full: bytes('f1') } } });
    const idb = createFakeIndexedDB();
    const store = createCredentialStore({ indexedDB: idb, now: () => 42 });
    assert.equal(await store.load(), null);
    assert.equal((await store.getStatus()).state, 'local');
    const r = await store.connect({ tok: 'tok-rw', pw: PW, repo: fake.repo, fetch: fake.fetch });
    assert.equal(r.key, creds.key);

    const again = createCredentialStore({ indexedDB: idb });
    const loaded = await again.load();
    assert.deepEqual(loaded, { repo: fake.repo, tok: 'tok-rw', key: creds.key });
    const st = await again.getStatus();
    assert.equal(st.state, 'connected');
    assert.equal(st.repo, fake.repo);
    const dump = dumpText(idb);
    assert.ok(!dump.includes(PW), 'password must not be stored');
    assert.ok(dump.includes(creds.key));
    assert.deepEqual([...idb._dump().keys()], [LINK_DB]);

    await loadImage({ ...loaded, fetch: fake.fetch }, 'a', 't', { cache: again.thumbCache() });
    assert.equal((await createIdbKv(THUMB_DB, { indexedDB: idb }).keys()).length, 1);

    await again.logout();
    assert.equal(await again.load(), null);
    assert.equal((await again.getStatus()).state, 'disconnected');
    assert.deepEqual(await createIdbKv(THUMB_DB, { indexedDB: idb }).keys(), []);
});

test('failed connect records a secret-free error status and keeps the previous creds', async () => {
    const { fake, creds } = await seedGallery();
    const kv = createMemoryKv();
    const store = createCredentialStore({ kv, thumbKv: createMemoryKv() });
    await store.save({ ...creds, fetch: undefined });
    await assert.rejects(store.connect({ tok: 'tok-rw', pw: 'wrong password!', repo: fake.repo, fetch: fake.fetch }), { code: 'pw' });
    assert.equal((await store.load()).key, creds.key);
    const s = await store.getStatus();
    assert.equal(s.state, 'error');
    assert.equal(s.code, 'pw');
    const txt = JSON.stringify(s);
    assert.ok(!txt.includes('wrong password!') && !txt.includes('tok-rw') && !txt.includes(creds.key));
});

test('save refuses incomplete creds and drops extra fields such as pw', async () => {
    const kv = createMemoryKv();
    const store = createCredentialStore({ kv, thumbKv: createMemoryKv() });
    await assert.rejects(store.save({ repo: 'a/b', tok: 't' }), { code: 'input' });
    await store.save({ repo: 'https://github.com/a/b.git', tok: 'Bearer t', key: 'k', pw: 'secret-pass' });
    const raw = await kv.get('creds');
    assert.deepEqual(Object.keys(raw).sort(), ['key', 'repo', 'savedAt', 'tok']);
    assert.equal(raw.repo, 'a/b');
    assert.equal(raw.tok, 't');
    await assert.rejects(store.setStatus({ state: 'bogus' }), { code: 'input' });
});
