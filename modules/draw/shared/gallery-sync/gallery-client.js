// XBDraw 这一侧的画廊客户端（G0 设计桩，G1 浏览 / G2 存入画廊都通过它）。
// 读写 nai-gallery 的数据仓库（GitHub 私有仓库，端到端加密）。所有加密、合并、乐观锁、版本守卫、删除保护
// 都复用 vendor/ 里原样拷贝的 SyncCore，这里只做：连接前检查、只读解开 state、列表分页、按需取图、组装「存入画廊」的记录。
//
// 凭据对象 creds = {repo, tok, key}：key 是由密码算出的 AES 密钥（base64），密码本身从不保存、不返回。
// 所有函数都接受可选的 fetch（测试注入假 GitHub；页面里不传就用全局 fetch）。
import { SyncCore } from './vendor/sync-core.js';
import { sha256 as gallerySha256 } from './vendor/nai-meta.js';
import { IMG_META, IMG_BATCH } from './vendor/page-constants.js';

export { SyncCore, IMG_META, IMG_BATCH };
export const SCHEMA = SyncCore.SCHEMA;

const err = (message, extra) => Object.assign(new Error(message), extra);

// 和画廊设置页一致的输入整理（nai-gallery index.html:4419-4423）
export function normalizeRepo(repo) {
    return String(repo || '').trim().replace(/^https?:\/\/github\.com\//i, '').replace(/\.git$/, '').replace(/\/+$/, '');
}

/**
 * 连接数据仓库：识别仓库 → 用 meta.json 的盐算密钥 → 用校验密文验密码。
 * 默认 allowInit=false：仓库里还没有 meta.json 时拒绝（code 'nometa'），不替画廊初始化加密——那一步应该在画廊网站上做。
 * @returns {Promise<{repo:string, tok:string, key:string, fresh:boolean}>}
 * 错误 code：'input' 输入不对 / 'repo' 认不出仓库（带 list）/ 'nometa' 仓库未初始化 / 'pw' 密码错 / 'net' 网络；HTTP 错误带 status
 */
export async function connect({ tok, pw, repo, fetch, allowInit = false }) {
    tok = String(tok || '').trim().replace(/^Bearer\s+/i, '');
    repo = normalizeRepo(repo);
    if (!tok) throw err('先粘贴 GitHub 令牌', { code: 'input' });
    if (!pw || pw.length < 8) throw err('加密密码至少 8 位', { code: 'input' });
    if (repo && !/^[\w.-]+\/[\w.-]+$/.test(repo)) throw err('仓库要写成「用户名/仓库名」', { code: 'input' });
    if (!repo) {
        const found = await SyncCore.findRepo({ tok, fetch });
        if (!found.repo) throw err(found.list.length
            ? `这个令牌能访问 ${found.list.length} 个仓库，认不出哪个是数据仓库，请手动填写`
            : '这个令牌没授权任何仓库', { code: 'repo', list: found.list });
        repo = found.repo;
    }
    if (!allowInit) {
        const c = SyncCore._t.client({ repo, tok, fetch });
        if (!(await c.read('meta.json', await c.head()))) {
            throw err('这个仓库还没在画廊网站上开启同步：先去画廊设置里连接一次', { code: 'nometa' });
        }
    }
    const r = await SyncCore.connect({ repo, tok, pw, fetch });
    return { repo, tok, key: r.key, fresh: r.fresh };
}

// 只读解开 state.bin。核心的 unpack 没导出，这里按核心的格式（IV12 + AES-GCM(gzip(JSON))）自己解；
// 测试保证它和核心的 pack 互通。版本太新时照样解开给浏览用，但标记 readOnly。
const unb64 = s => Uint8Array.from(atob(String(s).replace(/\s/g, '')), c => c.charCodeAt(0));
async function unpackState(keyStr, s) {
    const key = await SyncCore._t.keyOf(keyStr);
    const u8 = unb64(s);
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: u8.subarray(0, 12) }, key, u8.subarray(12));
    const json = await new Response(new Blob([plain]).stream().pipeThrough(new DecompressionStream('gzip'))).text();
    return JSON.parse(json);
}

/**
 * @returns {Promise<{head:string, state:object, schema:number, readOnly:boolean}>}
 */
export async function readState({ repo, tok, key, fetch }) {
    const snap = await SyncCore.snapshot({ repo, tok, fetch });
    if (!snap.state) return { head: snap.head, state: SyncCore.blank(), schema: SCHEMA, readOnly: false };
    let st;
    try { st = { ...SyncCore.blank(), ...(await unpackState(key, snap.state)) }; }
    catch { throw err('解不开仓库里的数据：密钥对不上，请断开后用正确的密码重新连接', { code: 'pw' }); }
    const schema = st.v || 1;
    return { head: snap.head, state: st, schema, readOnly: schema > SCHEMA };
}

const isDeleted = (state, id) => !!(state.dels[id] && state.dels[id].on);

/**
 * 纯函数：把 state 里「活着的图」整理成列表并分页。只列 imgs 里 on 且带 meta、没被 dels 标删的。
 * 排序：meta.at 新的在前，没有 at 按 t，再按 id，保证稳定。
 * @returns {{items:Array<{id, t, meta, fav:boolean, hasBlob:boolean}>, total:number, nextOffset:number|null}}
 */
export function listImages(state, { offset = 0, limit = 60, query = '', favOnly = false, model = '' } = {}) {
    state = { ...SyncCore.blank(), ...state };
    const q = String(query).trim().toLowerCase();
    const all = Object.entries(state.imgs)
        .filter(([id, r]) => r && r.on !== false && r.meta && !isDeleted(state, id))
        .map(([id, r]) => ({
            id, t: r.t || 0, meta: r.meta,
            fav: !!(state.fav[id] && state.fav[id].on),
            hasBlob: !!(state.blobs[id] && state.blobs[id].on) && !r.meta.noimg,
        }))
        .filter(x => (!favOnly || x.fav) && (!model || x.meta.model === model)
            && (!q || `${x.meta.name || ''}\n${x.meta.prompt || ''}`.toLowerCase().includes(q)))
        .sort((a, b) => String(b.meta.at || '').localeCompare(String(a.meta.at || '')) || b.t - a.t || (a.id < b.id ? -1 : 1));
    const items = all.slice(offset, offset + limit);
    const next = offset + items.length;
    return { items, total: all.length, nextOffset: next < all.length ? next : null };
}

/**
 * 取一张图的解密字节（webp）。kind：'t' 缩略图 420px / 'f' 大图 1216px。文件不存在返回 null。
 * cache 可选：{get(k) → Uint8Array|undefined, set(k, u8)}，G1 用 IndexedDB 实现。
 */
export async function loadImage({ repo, tok, key, fetch }, id, kind = 't', { cache } = {}) {
    if (kind !== 't' && kind !== 'f') throw err(`kind 只能是 't' 或 'f'`, { code: 'input' });
    const ck = `${repo}:${id}.${kind}`;
    const hit = cache && await cache.get(ck);
    if (hit) return hit;
    const u8 = await SyncCore.readBytes({ repo, tok, key, fetch, path: `imgs/${id}.${kind}` });
    if (u8 && cache) await cache.set(ck, u8);
    return u8;
}

/**
 * 缩略图懒加载队列：同一 id 只下一次，最多 concurrency 个并发（画廊自己也是 4，index.html:4276）。
 * 限流（403/429）的整体暂停重试留给 G1。
 */
export function createThumbQueue(creds, { concurrency = 4, cache } = {}) {
    const jobs = new Map(), waiting = [];
    let running = 0;
    const pump = () => {
        while (running < concurrency && waiting.length) {
            const { id, ok, no } = waiting.shift();
            running++;
            loadImage(creds, id, 't', { cache }).then(ok, no).finally(() => { running--; pump(); });
        }
    };
    return {
        get(id) {
            if (!jobs.has(id)) jobs.set(id, new Promise((ok, no) => { waiting.push({ id, ok, no }); pump(); }));
            return jobs.get(id);
        },
        get running() { return running; },
    };
}

/** 画廊的去重 id：原文件 SHA-256 的前 16 字节 hex（nai-gallery index.html:1791-1794、2422） */
export async function imageIdOf(bytes) {
    const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    return gallerySha256(u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength));
}

/**
 * 把图片存进画廊（G2 用）。一次最多 IMG_BATCH 张一提交，超出的自动分批。
 * entries[i] = {id?, png?: 原图字节（用来算 id）, meta: 画廊 IMG_META 字段, thumb: webp 字节, full: webp 字节}
 * 去重：远端已有同 id → skipped 'exists'；远端是墓碑（或 dels 标删）→ skipped 'deleted'，除非 reAdd=true。
 * 写入只走 SyncCore.sync：远端格式太新（code 'ver'）、密钥不对（'pw'）、被抢先推送时的重试，全都由核心处理。
 * @returns {Promise<{added:string[], skipped:Array<{id, reason}>, pushed:boolean, commits:number}>}
 */
export async function addImages({ repo, tok, key, fetch }, entries, { reAdd = false, onProgress, device = 'XBDraw', now = () => Date.now() } = {}) {
    const recs = new Map();
    for (const e of entries) {
        const id = e.id || (e.png ? await imageIdOf(e.png) : null);
        if (!id) throw err('每张图要么给 id，要么给原图字节', { code: 'input' });
        if (!e.thumb || !e.full) throw err(`图 ${id} 缺少缩略图或大图`, { code: 'input' });
        if (!recs.has(id)) recs.set(id, { id, meta: pickMeta(e.meta || {}), thumb: toU8(e.thumb), full: toU8(e.full) });
    }
    const list = [...recs.values()];
    const result = { added: [], skipped: [], pushed: false, commits: 0 };
    for (let i = 0; i < list.length; i += IMG_BATCH) {
        const batch = list.slice(i, i + IMG_BATCH), t = now();
        const local = { ...SyncCore.blank(), imgs: Object.fromEntries(batch.map(r => [r.id, { t, on: true, meta: r.meta }])) };
        let outcome;
        const plan = async (merged, remote, { pack }) => {
            outcome = { added: [], skipped: [] };                 // 被抢先重试时 plan 会再跑一次，按最新远端重新判断
            const files = [];
            for (const r of batch) {
                const old = remote.imgs[r.id], deleted = (old && old.on === false) || isDeleted(remote, r.id);
                if ((old && old.on !== false && !isDeleted(remote, r.id)) || (deleted && !reAdd)) {
                    if (old) merged.imgs[r.id] = old; else delete merged.imgs[r.id];   // 远端原样保留，不拿本地这条覆盖
                    outcome.skipped.push({ id: r.id, reason: deleted ? 'deleted' : 'exists' });
                    continue;
                }
                merged.imgs[r.id] = { t, on: true, meta: r.meta };        // 重新加回时压过远端墓碑（远端墓碑 t 可能更大）
                if (deleted && merged.dels[r.id]) merged.dels[r.id] = { t, on: false };
                files.push([`imgs/${r.id}.t`, await pack(r.thumb)], [`imgs/${r.id}.f`, await pack(r.full)]);
                merged.blobs[r.id] = { t, on: true };
                outcome.added.push(r.id);
            }
            return { files, removes: [] };
        };
        const r = await SyncCore.sync({
            repo, tok, key, fetch, local, plan, device, onProgress,
            message: () => `sync · ${device} · 存入 ${outcome.added.length} 张`,
        });
        result.added.push(...outcome.added);
        result.skipped.push(...outcome.skipped);
        if (r.pushed) { result.pushed = true; result.commits++; }
    }
    return result;
}

function pickMeta(meta) {
    return Object.fromEntries(IMG_META.filter(k => meta[k] !== undefined).map(k => [k, meta[k]]));
}
function toU8(x) {
    if (x instanceof Uint8Array) return x;
    if (x instanceof ArrayBuffer) return new Uint8Array(x);
    // 跨 realm（设置页 iframe ↔ 酒馆主页面）时 instanceof 不成立
    if (ArrayBuffer.isView(x)) return new Uint8Array(x.buffer, x.byteOffset, x.byteLength);
    if (Object.prototype.toString.call(x) === '[object ArrayBuffer]') return new Uint8Array(x);
    throw err('图片字节要是 Uint8Array 或 ArrayBuffer（Blob 请先 arrayBuffer()）', { code: 'input' });
}
