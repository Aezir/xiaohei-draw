// 注册助手：灯箱「存入画廊」只注册不接线；本机 / 远端目标；删过要确认；错误原样提示；导入预设消息查重
import test from 'node:test';
import assert from 'node:assert/strict';
import { seedGallery, fakePng } from './helpers.mjs';
import { createMemoryKv } from '../../modules/draw/shared/gallery-sync/idb-kv.js';
import { createLocalGallery } from '../../modules/draw/shared/gallery-sync/local-store.js';
import { createCredentialStore } from '../../modules/draw/shared/gallery-sync/credential-store.js';
import {
    registerGalleryLightboxAction, createTargetResolver, buildImportGalleryPresetMessage, GALLERY_SAVE_ACTION_ID, READD_PROMPT,
} from '../../modules/draw/shared/gallery-sync/gallery-actions.js';

const codec = { decodeImage: async () => ({ width: 100, height: 100 }), encodeWebp: async (_i, max) => new TextEncoder().encode(`w${max}`) };
function registry() {
    const list = [];
    return { list, register: (a) => { list.push(a); return () => list.splice(list.indexOf(a), 1); } };
}
const ctxOf = (tag) => ({ slotId: 's', messageId: 3, index: 0, total: 1, preview: { base64: Buffer.from(fakePng({ tag })).toString('base64'), characterName: '角色' } });

test('registers one action: id/label/order, remix icon, no emoji, when() needs an image; unregister works', () => {
    const reg = registry();
    const off = registerGalleryLightboxAction(reg.register, { getTarget: async () => null });
    const a = reg.list[0];
    assert.deepEqual([a.id, a.label, a.order], [GALLERY_SAVE_ACTION_ID, '同步到 Gallery', 30]);
    assert.deepEqual(a.surfaces, ['chat', 'lightbox']);
    assert.match(a.icon, /^ri-/);
    assert.doesNotMatch(a.label + a.icon, /\p{Extended_Pictographic}/u);
    assert.equal(a.when({ preview: { base64: 'x' } }), true);
    assert.equal(a.when({ preview: { savedUrl: '/a.png' } }), true);
    assert.equal(a.when({ preview: { base64: 'x', status: 'failed' } }), false);
    assert.equal(a.when({}), false);
    off();
    assert.equal(reg.list.length, 0);
    assert.throws(() => registerGalleryLightboxAction(reg.register, {}), TypeError);
});

test('not connected → saves to the local gallery; connected → remote; batch from resolveContext speaker', async () => {
    const local = createLocalGallery({ kv: createMemoryKv() });
    const credentials = createCredentialStore({ kv: createMemoryKv(), thumbKv: createMemoryKv() });
    const { fake, creds } = await seedGallery();
    const notes = [];
    const reg = registry();
    registerGalleryLightboxAction(reg.register, {
        getTarget: createTargetResolver({ credentials, local, fetch: fake.fetch }),
        resolveContext: () => ({ message: { name: '说话的人', is_user: false }, name2: '卡名' }),
        notify: (text, kind) => notes.push([kind, text]), codec,
    });
    const run = reg.list[0].run;
    const r1 = await run(ctxOf('one'));
    assert.equal(r1.target, 'local');
    assert.deepEqual(notes[0], ['info', '正在存入画廊…'], '点下去先提示，不等存完');
    assert.match(notes[1][1], /本机画廊/);
    assert.equal((await local.list()).items[0].meta.batch, '说话的人');

    await credentials.save(creds);
    const r2 = await run(ctxOf('two'));
    assert.equal(r2.target, 'remote');
    assert.deepEqual(notes.at(-1), ['success', '已存入画廊']);
    assert.ok(fake.files().has(`imgs/${r2.id}.f`));
});

test('previously deleted → asks; declined → nothing written; accepted → reAdd; errors show the core message', async () => {
    const local = createLocalGallery({ kv: createMemoryKv() });
    const asked = [], notes = [];
    let answer = false;
    const reg = registry();
    registerGalleryLightboxAction(reg.register, {
        getTarget: async () => ({ kind: 'local', store: local }),
        confirm: async (t) => { asked.push(t); return answer; },
        notify: (text, kind) => notes.push([kind, text]), codec,
    });
    const run = reg.list[0].run;
    const r = await run(ctxOf('d'));
    await local.remove(r.id);
    const declined = await run(ctxOf('d'));
    assert.deepEqual(asked, [READD_PROMPT]);
    assert.deepEqual(declined.added, []);
    assert.equal((await local.list()).total, 0);
    answer = true;
    const accepted = await run(ctxOf('d'));
    assert.deepEqual(accepted.added, [r.id]);

    const failing = registry();
    registerGalleryLightboxAction(failing.register, {
        getTarget: async () => ({ kind: 'remote', creds: {} }),
        exportChatImage: async () => { throw Object.assign(new Error('仓库里的数据来自更新版本的画廊页面：先刷新页面再同步'), { code: 'ver' }); },
        notify: (text, kind) => notes.push([kind, text]),
    });
    assert.equal(await failing.list[0].run(ctxOf('e')), null);
    assert.deepEqual(notes.at(-1), ['error', '仓库里的数据来自更新版本的画廊页面：先刷新页面再同步']);
});

test('buildImportGalleryPresetMessage builds IMPORT_GALLERY_PRESET and flags a duplicate source', () => {
    const rec = { id: 'img9', meta: { prompt: 'a, b', model: 'V4.5', nai: { chars: [{ prompt: 'c', uc: '', centers: [] }] } } };
    const first = buildImportGalleryPresetMessage(rec, { presets: [] });
    assert.equal(first.type, 'IMPORT_GALLERY_PRESET');
    assert.equal(first.duplicateOf, null);
    assert.equal(first.characters.length, 1);
    const again = buildImportGalleryPresetMessage(rec, { presets: [{ id: 'existing', source: first.preset.source }] });
    assert.equal(again.duplicateOf, 'existing');
    assert.doesNotThrow(() => structuredClone(again), 'message must survive postMessage');
});
