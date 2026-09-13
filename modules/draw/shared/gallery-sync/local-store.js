// 本机画廊（G1，gallery-decisions.md 第 1 条）：不配同步仓库也能用。
// 数据全放在酒馆页面的 IndexedDB `xb_gallery_local`：
//   'state'          和画廊 state.bin 解开后同一个结构 {v, fav, cols, dels, vars, imgs, blobs, grps}，id 规则也一样
//                    （imgs[id] = {t, on, meta}，meta 只含 IMG_META 字段）。所以 gallery-client.listImages 能直接列它。
//   'file:<id>.t|f'  webp 字节（缩略图 420px q0.74 / 大图 1216px q0.95），不加密（只在本机）。
//   'files'          本机有哪些图片文件、各传到过哪些仓库：{[id]: {t, on, pushed?: {[repo]: t}}}。
//                    这份记录不进 state：state 的 blobs 在画廊里表示「文件已经在仓库里」，本机不能乱标，
//                    否则合并上去以后画廊设备会以为文件在、不去等上传。
// 之后连上仓库：mergeToRemote 用 SyncCore.sync（画廊自己的逐条合并、乐观锁、版本守卫、删除保护）把本机记录合并上去，
// 远端还没有文件的图随 plan 一起上传，每次最多 IMG_BATCH 张。
import { SyncCore, listImages, IMG_META, IMG_BATCH, SCHEMA, imageIdOf } from './gallery-client.js';
import { createIdbKv } from './idb-kv.js';

export const LOCAL_DB = 'xb_gallery_local';
const STATE_KEY = 'state';
const FILES_KEY = 'files';
const LOCAL_MAPS = ['fav', 'cols', 'dels', 'vars', 'imgs'];
const fileKey = (id, kind) => `file:${id}.${kind}`;
const err = (message, extra) => Object.assign(new Error(message), extra);
const isDeleted = (st, id) => !!(st.dels[id] && st.dels[id].on);

function pickMeta(meta) {
    return Object.fromEntries(IMG_META.filter(k => meta[k] !== undefined).map(k => [k, meta[k]]));
}
async function asU8(x) {
    if (x instanceof Uint8Array) return x;
    if (x instanceof ArrayBuffer) return new Uint8Array(x);
    // 设置页 iframe 和酒馆主页面是两个 realm，instanceof 认不出对方的 Uint8Array
    if (ArrayBuffer.isView(x)) return new Uint8Array(x.buffer, x.byteOffset, x.byteLength);
    if (Object.prototype.toString.call(x) === '[object ArrayBuffer]') return new Uint8Array(x);
    if (x && typeof x.arrayBuffer === 'function') return new Uint8Array(await x.arrayBuffer());
    throw err('图片字节要是 Uint8Array、ArrayBuffer 或 Blob', { code: 'input' });
}

/**
 * @param {object} [opts]
 * @param {object} [opts.kv]  存储（默认 IndexedDB `xb_gallery_local`；测试注入 createMemoryKv 或内存 IndexedDB）
 * @param {IDBFactory} [opts.indexedDB]
 * @param {() => number} [opts.now]
 */
export function createLocalGallery({ kv, indexedDB, now = () => Date.now() } = {}) {
    const db = kv || createIdbKv(LOCAL_DB, { indexedDB });
    let chain = Promise.resolve();
    const exclusive = fn => { const p = chain.then(fn); chain = p.catch(() => {}); return p; };   // 同一页面里的写操作排队
    const readRaw = async () => ({ ...SyncCore.blank(), ...((await db.get(STATE_KEY)) || {}) });
    const readFiles = async () => (await db.get(FILES_KEY)) || {};
    const statusOf = (st, id) => {
        const r = st.imgs[id];
        if ((r && r.on === false) || isDeleted(st, id)) return 'deleted';
        return r ? 'exists' : null;
    };

    /** 和 gallery-client.readState 同形（head 为 null，local 为 true） */
    async function readState() {
        const st = await readRaw();
        return { head: null, state: st, schema: st.v || SCHEMA, readOnly: false, local: true };
    }

    /** 列表：规则同 gallery-client.listImages；hasBlob 表示本机有图片文件 */
    async function list(opts) {
        const [st, files] = await Promise.all([readRaw(), readFiles()]);
        const r = listImages(st, opts);
        r.items = r.items.map(x => ({ ...x, hasBlob: !x.meta.noimg && !!(files[x.id] && files[x.id].on), local: true }));
        return r;
    }

    /** 'exists' | 'deleted' | null —— 存入前的去重检查（省掉重复转 webp） */
    async function has(id) { return statusOf(await readRaw(), id); }

    async function loadImage(id, kind = 't') {
        if (kind !== 't' && kind !== 'f') throw err(`kind 只能是 't' 或 'f'`, { code: 'input' });
        return (await db.get(fileKey(id, kind))) || null;
    }

    /**
     * 存入本机。entries[i] = {id? | png?, meta, thumb, full}，和 gallery-client.addImages 同一个入参和去重语义：
     * 已有 → skipped 'exists'；删过（墓碑或 dels 标删）→ skipped 'deleted'，reAdd=true 时加回。
     * @returns {Promise<{added:string[], skipped:Array<{id, reason}>}>}
     */
    async function addImages(entries, { reAdd = false } = {}) {
        const prepared = [];
        for (const e of entries || []) {
            const id = e.id || (e.png ? await imageIdOf(e.png) : null);
            if (!id) throw err('每张图要么给 id，要么给原图字节', { code: 'input' });
            if (!e.thumb || !e.full) throw err(`图 ${id} 缺少缩略图或大图`, { code: 'input' });
            prepared.push({ id, meta: pickMeta(e.meta || {}), thumb: await asU8(e.thumb), full: await asU8(e.full) });
        }
        return exclusive(async () => {
            const st = await readRaw(), files = await readFiles();
            const res = { added: [], skipped: [] }, seen = new Set();
            for (const r of prepared) {
                if (seen.has(r.id)) continue;
                seen.add(r.id);
                const s = statusOf(st, r.id);
                if (s === 'exists' || (s === 'deleted' && !reAdd)) { res.skipped.push({ id: r.id, reason: s }); continue; }
                // 加回时 t 必须压过墓碑，否则合并到仓库时墓碑会赢
                const t = Math.max(now(), ((st.imgs[r.id] || {}).t || 0) + 1, ((st.dels[r.id] || {}).t || 0) + 1);
                await db.set(fileKey(r.id, 't'), r.thumb);
                await db.set(fileKey(r.id, 'f'), r.full);
                st.imgs[r.id] = { t, on: true, meta: r.meta };
                if (st.dels[r.id]) st.dels[r.id] = { t, on: false };
                files[r.id] = { t, on: true };
                res.added.push(r.id);
            }
            if (res.added.length) { await db.set(FILES_KEY, files); await db.set(STATE_KEY, st); }
            return res;
        });
    }

    /** 删除：留墓碑（imgs on:false + dels on:true，和画廊删导入图一样），本机文件真删 */
    async function remove(id) {
        return exclusive(async () => {
            const st = await readRaw(), files = await readFiles();
            if (!st.imgs[id] || statusOf(st, id) === 'deleted') return false;
            const t = Math.max(now(), (st.imgs[id].t || 0) + 1);
            st.imgs[id] = { t, on: false };
            st.dels[id] = { t, on: true };
            delete files[id];
            await db.del(fileKey(id, 't'));
            await db.del(fileKey(id, 'f'));
            await db.set(FILES_KEY, files);
            await db.set(STATE_KEY, st);
            return true;
        });
    }

    /** 收藏开关，记录形状同画廊 fav[id] = {t, on, cols} */
    async function setFav(id, on) {
        return exclusive(async () => {
            const st = await readRaw(), old = st.fav[id] || {};
            st.fav[id] = { t: Math.max(now(), (old.t || 0) + 1), on: !!on, cols: Array.isArray(old.cols) ? old.cols : [] };
            await db.set(STATE_KEY, st);
            return st.fav[id];
        });
    }

    /**
     * 把本机画廊合并进同步仓库（不整份覆盖）。远端已有文件（blobs on）的图不重传，远端墓碑更新的图不传。
     * 写回本机时只更新本机原有条目的合并结果，不把远端独有的记录拉进本机（本机画廊保持「本机的东西」，换仓库也不串）。
     * 错误照核心原样抛：'ver' 远端格式太新 / 'pw' 密钥不对 / 'guard' 删除保护 / HTTP status。
     * @returns {Promise<{pushed:boolean, commits:number, uploaded:string[], state:object}>}
     */
    async function mergeToRemote({ repo, tok, key, fetch }, { device = 'XBDraw', onProgress, maxRounds = 100 } = {}) {
        return exclusive(async () => {
            const local = await readRaw(), files = await readFiles();
            let input = local, merged = null, commits = 0;
            const uploaded = [];
            for (let round = 0; round < maxRounds; round++) {
                let batch = [], more = false;
                const plan = async (m, remote, { pack }) => {
                    batch = []; more = false;                          // 被抢先重试时 plan 会再跑，按最新远端重算
                    const out = [], t = now();
                    for (const id of Object.keys(m.imgs).sort()) {
                        const r = m.imgs[id];
                        if (!r || r.on === false || !r.meta || r.meta.noimg || isDeleted(m, id)) continue;
                        if (m.blobs[id] && m.blobs[id].on) continue;
                        if (!(files[id] && files[id].on)) continue;
                        if (batch.length >= IMG_BATCH) { more = true; break; }
                        const th = await db.get(fileKey(id, 't')), fu = await db.get(fileKey(id, 'f'));
                        if (!th || !fu) continue;
                        out.push([`imgs/${id}.t`, await pack(th)], [`imgs/${id}.f`, await pack(fu)]);
                        m.blobs[id] = { t, on: true };
                        batch.push(id);
                    }
                    return { files: out, removes: [] };
                };
                const r = await SyncCore.sync({
                    repo, tok, key, fetch, local: input, plan, device, onProgress,
                    message: () => `sync · ${device} · 合并本机画廊 ${batch.length} 张`,
                });
                merged = r.merged;
                if (r.pushed) { commits++; uploaded.push(...batch); }
                if (!more || !r.pushed) break;
                input = merged;
            }
            const next = { ...local };
            for (const k of LOCAL_MAPS) {
                const out = { ...local[k] };
                for (const id of Object.keys(local[k])) if (merged[k] && merged[k][id]) out[id] = merged[k][id];
                next[k] = out;
            }
            for (const id of uploaded) files[id] = { ...files[id], pushed: { ...((files[id] && files[id].pushed) || {}), [repo]: now() } };
            await db.set(STATE_KEY, next);
            if (uploaded.length) await db.set(FILES_KEY, files);
            return { pushed: commits > 0, commits, uploaded, state: next };
        });
    }

    return { readState, list, has, loadImage, addImages, remove, setFav, mergeToRemote };
}
