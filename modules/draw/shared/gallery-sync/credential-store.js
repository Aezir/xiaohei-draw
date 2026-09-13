// 记住登录（G1）：把 {repo, tok, key} 和连接状态存进酒馆页面的 IndexedDB。
// 规则（gallery-decisions.md 第 2 条）：
//   - 只存仓库名、GitHub 令牌、由密码算出的 AES 密钥（base64）；密码从不存、从不经过这里。
//   - 不写进 XBDraw_NovelDraw.json（设置文件会被导出 / 同步，令牌不能跟着走）。
//   - 没有「仅本次会话」选项。断开 = 删凭据 + 清空缩略图缓存库。
// 设置 iframe 和酒馆主页面同源，两边打开同名库读到的是同一份，密钥不需要走 postMessage。
import { createIdbKv } from './idb-kv.js';
import { connect as clientConnect, normalizeRepo } from './gallery-client.js';

export const LINK_DB = 'xb_gallery_link';
export const THUMB_DB = 'xb_gallery_thumbs';
/** local：从没连过（纯本地画廊）/ connected：已连接 / error：上次连接失败 / disconnected：用户断开过 */
export const LINK_STATES = Object.freeze(['local', 'connected', 'error', 'disconnected']);

const CREDS_KEY = 'creds';
const STATUS_KEY = 'status';
const STATUS_FIELDS = ['state', 'repo', 'code', 'status', 'message', 'head', 'lastSyncAt'];
const err = (message, extra) => Object.assign(new Error(message), extra);

function pickCreds(c) {
    const repo = normalizeRepo(c && c.repo);
    const tok = String((c && c.tok) || '').trim().replace(/^Bearer\s+/i, '');
    const key = String((c && c.key) || '').trim();
    if (!repo || !tok || !key) throw err('凭据不完整：需要仓库、令牌和密钥', { code: 'input' });
    return { repo, tok, key };
}

function cleanStatus(patch) {
    const out = {};
    for (const k of STATUS_FIELDS) if (patch && patch[k] !== undefined) out[k] = patch[k];
    if (out.state !== undefined && !LINK_STATES.includes(out.state)) throw err(`未知的连接状态：${out.state}`, { code: 'input' });
    return out;
}

/**
 * @param {object} [opts]
 * @param {object} [opts.kv]        凭据库（默认 IndexedDB `xb_gallery_link`）
 * @param {object} [opts.thumbKv]   缩略图缓存库（默认 IndexedDB `xb_gallery_thumbs`，用到才打开）
 * @param {IDBFactory} [opts.indexedDB]
 * @param {() => number} [opts.now]
 * @param {Function} [opts.connectImpl]  默认 gallery-client 的 connect（测试可替换）
 */
export function createCredentialStore({ kv, thumbKv, indexedDB, now = () => Date.now(), connectImpl = clientConnect } = {}) {
    const link = kv || createIdbKv(LINK_DB, { indexedDB });
    let thumbs = thumbKv || null;
    const thumbStore = () => thumbs || (thumbs = createIdbKv(THUMB_DB, { indexedDB }));

    async function load() {
        const c = await link.get(CREDS_KEY);
        if (!c || !c.repo || !c.tok || !c.key) return null;
        return { repo: c.repo, tok: c.tok, key: c.key };
    }

    async function getStatus() {
        const s = await link.get(STATUS_KEY);
        return { state: 'local', repo: '', code: '', status: 0, message: '', at: 0, ...(s || {}) };
    }

    async function setStatus(patch) {
        const next = { ...(await getStatus()), ...cleanStatus(patch), at: now() };
        await link.set(STATUS_KEY, next);
        return next;
    }

    /** 保存凭据：只挑 repo/tok/key 三个字段，传进来的 pw 之类一律丢掉 */
    async function save(creds) {
        const c = pickCreds(creds);
        await link.set(CREDS_KEY, { ...c, savedAt: now() });
        await setStatus({ state: 'connected', repo: c.repo, code: '', status: 0, message: '' });
        return c;
    }

    /**
     * 连接并记住。密码只传给 connectImpl 算密钥，用完即弃。
     * 失败时记一条不含秘密的错误状态，已经保存的旧凭据保持不动。
     * @returns {Promise<{repo, tok, key, fresh}>}
     */
    async function connect({ tok, pw, repo, allowInit = false, fetch } = {}) {
        try {
            const r = await connectImpl({ tok, pw, repo, allowInit, fetch });
            await save(r);
            return r;
        } catch (e) {
            await setStatus({ state: 'error', code: String((e && e.code) || ''), status: Number((e && e.status) || 0), message: String((e && e.message) || '连接失败') });
            throw e;
        }
    }

    /** 断开：删凭据、清缩略图缓存，状态记为 disconnected（本机画廊 xb_gallery_local 不动） */
    async function logout() {
        await link.del(CREDS_KEY);
        await thumbStore().clear();
        await setStatus({ state: 'disconnected', code: '', status: 0, message: '', head: '' });
    }

    /** 给 gallery-client 的 loadImage / createThumbQueue 用的缓存 {get, set} */
    function thumbCache() {
        return { get: k => thumbStore().get(k), set: (k, v) => thumbStore().set(k, v) };
    }

    return { load, save, connect, logout, getStatus, setStatus, thumbCache };
}
