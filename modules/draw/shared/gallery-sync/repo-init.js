// 由小黑生图初始化画廊加密数据仓库（gallery-decisions.md 第 1 条）。
// 仓库里还没有 meta.json 时，先明确提示用户「将把这个仓库设为画廊加密数据仓库」，确认后才写。
// 写入本身直接调用 vendor/ 里原样拷贝的 SyncCore.connect —— 它就是 nai-gallery 网站第一台设备初始化时跑的那段代码
// （PBKDF2-SHA256 31 万次 + 16 字节随机盐 + AES-GCM 校验文字 'nai-gallery-sync-ok'，提交信息 'sync: 初始化加密'），
// vendor-drift 测试保证它和 nai-gallery HEAD 一字不差，所以网站一定读得懂。写完再按格式自检一遍。
import { SyncCore, normalizeRepo } from './gallery-client.js';

export const INIT_PROMPT = '将把这个仓库设为画廊加密数据仓库';
export const INIT_DETAIL = '会在仓库里写入 meta.json（盐和密码校验）。以后所有设备都要用同一个密码，密码忘了数据就解不开。';
const CHECK_TEXT = 'nai-gallery-sync-ok';
export const GALLERY_META_FORMAT = Object.freeze({
    keys: Object.freeze(['v', 'kdf', 'iter', 'salt', 'check']),
    v: 1,
    kdf: 'PBKDF2-SHA256',
    iter: 310000,
    saltBytes: 16,
    checkBytes: 12 + CHECK_TEXT.length + 16,              // IV 12 + 密文 + GCM 标签 16
});

const err = (message, extra) => Object.assign(new Error(message), extra);
const unb64 = s => Uint8Array.from(atob(String(s).replace(/\s/g, '')), c => c.charCodeAt(0));

/** 检查 meta.json 是否和画廊格式完全一致；返回问题列表（空 = 一致） */
export function validateMeta(meta) {
    const F = GALLERY_META_FORMAT, p = [];
    if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return ['meta.json 不是 JSON 对象'];
    if (meta.v !== F.v) p.push(`v 应为 ${F.v}，实际 ${meta.v}`);
    if (meta.kdf !== F.kdf) p.push(`kdf 应为 ${F.kdf}，实际 ${meta.kdf}`);
    if (meta.iter !== F.iter) p.push(`iter 应为 ${F.iter}，实际 ${meta.iter}`);
    const len = s => { try { return typeof s === 'string' ? unb64(s).length : -1; } catch { return -1; } };
    if (len(meta.salt) !== F.saltBytes) p.push(`salt 应为 ${F.saltBytes} 字节 base64`);
    if (len(meta.check) !== F.checkBytes) p.push(`check 应为 ${F.checkBytes} 字节 base64（IV + 密文 + 标签）`);
    const extra = Object.keys(meta).filter(k => !F.keys.includes(k));
    if (extra.length) p.push(`多出字段：${extra.join('、')}`);
    return p;
}

/**
 * 只读查看仓库：有没有提交、meta.json、state.bin。
 * 完全空的 GitHub 仓库（一次提交都没有）拿不到 main 分支，核心也没法在上面提交 → code 'empty'。
 * @returns {Promise<{repo, head, hasMeta:boolean, hasState:boolean, meta:object|null|undefined}>} meta 为 undefined 表示读不懂
 */
export async function inspectRepo({ repo, tok, fetch }) {
    const c = SyncCore._t.client({ repo, tok, fetch });
    let head;
    try { head = await c.head(); }
    catch (e) {
        if (e.status === 409 || e.status === 404) {
            if (e.status === 404) await c.info();          // 仓库本身不存在 / 没授权时这里抛出核心的 404 提示
            throw err('这个仓库一次提交都没有：先在 GitHub 上建一个初始提交（比如创建时勾选「添加 README」），再回来连接', { code: 'empty' });
        }
        throw e;
    }
    const m = await c.read('meta.json', head);
    const s = await c.read('state.bin', head);
    let meta = null;
    if (m) { try { meta = JSON.parse(new TextDecoder().decode(unb64(m))); } catch { meta = undefined; } }
    return { repo, head, hasMeta: !!m, hasState: !!s, meta };
}

/**
 * 连接；仓库没初始化时经用户确认后初始化。
 * confirm({repo, message, detail}) → Promise<boolean>：必须由界面明确问用户；不传或返回假 → code 'cancel'，不写任何东西。
 * 已经初始化过的仓库：不弹确认，只验密码（等同 gallery-client.connect）。
 * @returns {Promise<{repo, tok, key, fresh:boolean, initialized:boolean}>}
 * 错误 code：'input' / 'repo'(带 list) / 'empty' 空仓库 / 'orphan' 有 state.bin 没 meta.json / 'format' meta 读不懂或格式不符 / 'cancel' / 'pw'；HTTP 错误带 status
 */
export async function initGalleryRepo({ tok, pw, repo, fetch, confirm } = {}) {
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
    const info = await inspectRepo({ repo, tok, fetch });
    if (info.hasMeta) {
        if (info.meta === undefined) throw err('仓库里的 meta.json 读不懂，不像画廊数据仓库，已停止', { code: 'format' });
        const r = await SyncCore.connect({ repo, tok, pw, fetch });
        return { repo, tok, key: r.key, fresh: r.fresh, initialized: false };
    }
    if (info.hasState) throw err('仓库里有 state.bin 却没有 meta.json，不像正常的画廊数据仓库，已停止，没有写入', { code: 'orphan' });
    const ok = typeof confirm === 'function' && await confirm({ repo, message: `${INIT_PROMPT}：${repo}`, detail: INIT_DETAIL });
    if (!ok) throw err('已取消，没有初始化仓库', { code: 'cancel' });
    const r = await SyncCore.connect({ repo, tok, pw, fetch });   // 被别的设备抢先初始化时，核心会改用对方的盐并验密码
    const after = await inspectRepo({ repo, tok, fetch });
    const problems = validateMeta(after.meta);
    if (problems.length) throw err(`仓库里的 meta.json 和画廊格式对不上：${problems.join('；')}`, { code: 'format', problems });
    return { repo, tok, key: r.key, fresh: r.fresh, initialized: r.fresh };
}
