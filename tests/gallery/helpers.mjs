// 测试共用：禁网、造一个「画廊网站已经同步过」的数据仓库、造带 NAI 元数据的 PNG
import { createFakeGitHub } from './fake-github.mjs';
import { SyncCore } from '../../modules/draw/shared/gallery-sync/vendor/sync-core.js';

globalThis.fetch = () => { throw new Error('network access is forbidden in tests'); };

export const PW = 'correct horse battery';
export const bytes = (s) => new TextEncoder().encode(s);

/** 用核心本身（等同画廊网站）初始化加密并同步一批图，返回 {fake, creds}；creds 不含 fetch 以外的秘密以外的东西 */
export async function seedGallery({ images = {}, state = {}, fakeOpts } = {}) {
    const fake = createFakeGitHub(fakeOpts);
    const base = { repo: fake.repo, tok: 'tok-rw', fetch: fake.fetch };
    const { key } = await SyncCore.connect({ ...base, pw: PW });
    const imgs = {}, now = 1_700_000_000_000;
    for (const [id, im] of Object.entries(images)) imgs[id] = im.rec || { t: now, on: true, meta: im.meta };
    const local = { ...SyncCore.blank(), ...state, imgs: { ...(state.imgs || {}), ...imgs } };
    await SyncCore.sync({
        ...base, key, local,
        plan: async (merged, remote, { pack }) => {                 // 和画廊 syncPlan 同样的做法：带文件并登记 blobs
            const files = [];
            for (const [id, im] of Object.entries(images)) {
                if (!im.thumb) continue;
                files.push([`imgs/${id}.t`, await pack(im.thumb)], [`imgs/${id}.f`, await pack(im.full)]);
                merged.blobs[id] = { t: now, on: true };
            }
            return { files, removes: [] };
        },
    });
    return { fake, creds: { ...base, key }, local };
}

function chunk(type, data) {
    const out = new Uint8Array(12 + data.length), v = new DataView(out.buffer);
    v.setUint32(0, data.length);
    out.set(bytes(type), 4);
    out.set(data, 8);
    return out;                                                      // CRC 留 0：pngText 不校验
}
/** 最小的「NAI 风格」PNG：签名 + IHDR + tEXt(键值...) + IDAT + IEND */
export function fakePng(text = {}) {
    const parts = [new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', new Uint8Array(13))];
    for (const [k, val] of Object.entries(text)) parts.push(chunk('tEXt', new Uint8Array([...bytes(k), 0, ...bytes(val)])));
    parts.push(chunk('IDAT', new Uint8Array([1, 2, 3])), chunk('IEND', new Uint8Array()));
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let o = 0; for (const p of parts) { out.set(p, o); o += p.length; }
    return out;
}
