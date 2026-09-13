// 小黑生图初始化数据仓库：先问、格式和画廊一致、画廊核心（等同网站代码）能连能读能同步、已初始化不重写、异常仓库拒绝
import test from 'node:test';
import assert from 'node:assert/strict';
import { seedGallery, PW, bytes } from './helpers.mjs';
import { createFakeGitHub } from './fake-github.mjs';
import { initGalleryRepo, inspectRepo, validateMeta, INIT_PROMPT } from '../../modules/draw/shared/gallery-sync/repo-init.js';
import * as G from '../../modules/draw/shared/gallery-sync/gallery-client.js';

const { SyncCore } = G;
const T0 = 1_700_000_000_000;

test('asks first; declining or no confirm writes nothing; input checks need no network', async () => {
    const fake = createFakeGitHub();
    let asked = null;
    await assert.rejects(initGalleryRepo({ tok: 'tok-rw', pw: PW, repo: fake.repo, fetch: fake.fetch, confirm: async (x) => { asked = x; return false; } }), { code: 'cancel' });
    assert.ok(asked.message.startsWith(INIT_PROMPT) && asked.message.includes(fake.repo));
    await assert.rejects(initGalleryRepo({ tok: 'tok-rw', pw: PW, repo: fake.repo, fetch: fake.fetch }), { code: 'cancel' });
    assert.equal(fake.commitCount(), 0);
    const n = fake.log.length;
    await assert.rejects(initGalleryRepo({ tok: 'tok-rw', pw: 'short', fetch: fake.fetch }), { code: 'input' });
    await assert.rejects(initGalleryRepo({ tok: 'tok-rw', pw: PW, repo: 'bad repo', fetch: fake.fetch }), { code: 'input' });
    assert.equal(fake.log.length, n);
});

test('writes meta.json in the gallery format; the gallery core connects, syncs, and reads what XBDraw writes', async () => {
    const fake = createFakeGitHub();
    const r = await initGalleryRepo({ tok: 'tok-rw', pw: PW, fetch: fake.fetch, confirm: async () => true });   // 仓库自动识别
    assert.equal(r.repo, fake.repo);
    assert.equal(r.initialized, true);
    assert.deepEqual(fake.messages(), ['sync: 初始化加密']);
    const text = Buffer.from(fake.files().get('meta.json'), 'base64').toString('utf8');
    const meta = JSON.parse(text);
    assert.equal(text, JSON.stringify(meta, null, 2));
    assert.deepEqual(Object.keys(meta), ['v', 'kdf', 'iter', 'salt', 'check']);
    assert.deepEqual(validateMeta(meta), []);

    const base = { repo: fake.repo, tok: 'tok-rw', fetch: fake.fetch };
    const site = await SyncCore.connect({ ...base, pw: PW });                 // 网站端第一次连接
    assert.equal(site.fresh, false);
    assert.equal(site.key, r.key);
    await assert.rejects(SyncCore.connect({ ...base, pw: 'another password' }), { code: 'pw' });

    await SyncCore.sync({ ...base, key: site.key, local: { ...SyncCore.blank(), fav: { x: { t: T0, on: true, cols: [] } } } });
    const creds = { ...base, key: r.key };
    assert.equal((await G.readState(creds)).state.fav.x.on, true);
    await G.addImages(creds, [{ id: 'n', meta: { prompt: 'n', batch: '角色' }, thumb: bytes('t'), full: bytes('f') }]);
    const back = await SyncCore.sync({ ...base, key: site.key, local: SyncCore.blank() });
    assert.equal(back.merged.imgs.n.meta.batch, '角色');
    const opened = await SyncCore.openState(site.key, (await SyncCore.snapshot(base)).state);
    assert.equal(opened.fav.x.on, true);
    assert.deepEqual(await SyncCore.readBytes({ ...base, key: site.key, path: 'imgs/n.f' }), bytes('f'));
});

test('already initialised repo: no prompt, no commit, just password check', async () => {
    const { fake, creds } = await seedGallery();
    const n = fake.commitCount();
    const confirm = async () => { throw new Error('must not ask'); };
    const r = await initGalleryRepo({ tok: 'tok-rw', pw: PW, repo: fake.repo, fetch: fake.fetch, confirm });
    assert.deepEqual([r.fresh, r.initialized, r.key], [false, false, creds.key]);
    await assert.rejects(initGalleryRepo({ tok: 'tok-rw', pw: 'wrong password', repo: fake.repo, fetch: fake.fetch, confirm }), { code: 'pw' });
    assert.equal(fake.commitCount(), n);
});

test('state.bin without meta.json → orphan; repo without commits → empty; broken meta.json → format', async () => {
    const fake = createFakeGitHub();
    fake.putFiles({ 'state.bin': 'AAAA' });
    const n = fake.commitCount();
    await assert.rejects(initGalleryRepo({ tok: 'tok-rw', pw: PW, repo: fake.repo, fetch: fake.fetch, confirm: async () => true }), { code: 'orphan' });
    assert.equal(fake.commitCount(), n);

    const empty = createFakeGitHub();
    const emptyFetch = async (url, opt) => (String(url).endsWith('/git/ref/heads/main')
        ? new Response(JSON.stringify({ message: 'Git Repository is empty.' }), { status: 409 })
        : empty.fetch(url, opt));
    await assert.rejects(inspectRepo({ repo: empty.repo, tok: 'tok-rw', fetch: emptyFetch }), { code: 'empty' });

    const broken = createFakeGitHub();
    broken.putFiles({ 'meta.json': Buffer.from('not json').toString('base64') });
    await assert.rejects(initGalleryRepo({ tok: 'tok-rw', pw: PW, repo: broken.repo, fetch: broken.fetch, confirm: async () => true }), { code: 'format' });
});

test('validateMeta flags parameter mismatches', () => {
    const p = validateMeta({ v: 1, kdf: 'PBKDF2-SHA256', iter: 1000, salt: btoa('short'), check: 'AAAA', extra: 1 });
    assert.equal(p.length, 4);
    assert.deepEqual(validateMeta(null), ['meta.json 不是 JSON 对象']);
});
