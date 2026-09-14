// 设置页（novel-draw.html）和嵌在里面的完整画廊（gallery-web/index.html?embed=xiaohei）之间的消息约定。纯函数，node 可测。
//   画廊 → 设置页：{source: EMBED_SOURCE, type: 'hello'}                     请求插件的画廊仓库连接
//                  {source: EMBED_SOURCE, type: 'import-preset', record, vars, varIndex}   详情里「加入绘图参数预设」
//   设置页 → 画廊：{source: EMBED_HOST_SOURCE, type: 'link', creds: {repo, tok, key} | null}
//                  {source: EMBED_HOST_SOURCE, type: 'toast', text}
//                  {source: EMBED_HOST_SOURCE, type: 'resync'}                插件往仓库写过东西，让画廊同步一次
// 安全：两边同源（都在酒馆的域名下），只认「同源 + 来自那个 iframe / 父窗口」的消息，发送时 targetOrigin 写死本源。
export const EMBED_SOURCE = 'nai-gallery-embed';
export const EMBED_HOST_SOURCE = 'xiaohei-gallery-host';
export const EMBED_PARAM = 'xiaohei';

const ID_RE = /^[A-Za-z0-9_.-]{1,128}$/;
const isPlain = v => !!v && typeof v === 'object' && !Array.isArray(v);
const err = message => Object.assign(new Error(message), { code: 'input' });

/** 完整画廊地址加上 ?embed=xiaohei */
export function embedUrl(base) {
    const u = new URL(base);
    u.searchParams.set('embed', EMBED_PARAM);
    return u.href;
}

/** 这条消息是不是嵌入的画廊发来的：同源、来源窗口就是那个 iframe、source 对得上 */
export function isTrustedEmbedMessage(event, { origin, frameWindow } = {}) {
    if (!event || !origin || !frameWindow) return false;
    if (event.origin !== origin || event.source !== frameWindow) return false;
    const d = event.data;
    return isPlain(d) && d.source === EMBED_SOURCE && typeof d.type === 'string';
}

/**
 * 「加入绘图参数预设」请求 → {record: {id, meta}, vars: {list, active} | null, varIndex}
 * 只挑这几个字段，别的一律丢掉；格式不对抛错（code: 'input'）。
 */
export function parseImportRequest(data) {
    if (!isPlain(data)) throw err('画廊发来的消息格式不对');
    const rec = data.record;
    if (!isPlain(rec) || typeof rec.id !== 'string' || !ID_RE.test(rec.id)) throw err('画廊发来的图片编号不对');
    if (!isPlain(rec.meta)) throw err('这张图没有参数信息');
    let vars = null;
    if (isPlain(data.vars) && Array.isArray(data.vars.list)) {
        const active = Number.isInteger(data.vars.active) && data.vars.active >= 0 && data.vars.active < data.vars.list.length ? data.vars.active : -1;
        vars = { list: data.vars.list, active };
    }
    const n = vars ? vars.list.length : 0;
    const varIndex = Number.isInteger(data.varIndex) && data.varIndex >= 0 && data.varIndex < n ? data.varIndex : -1;
    return { record: { id: rec.id, meta: rec.meta }, vars, varIndex };
}

export function hostMessage(type, data = {}) {
    return { ...data, source: EMBED_HOST_SOURCE, type };
}

/** 回给画廊的连接信息：只带 repo / tok / key 三个字段，不完整就当没连 */
export function linkReply(creds) {
    const ok = isPlain(creds) && ['repo', 'tok', 'key'].every(k => typeof creds[k] === 'string' && creds[k]);
    return hostMessage('link', { creds: ok ? { repo: creds.repo, tok: creds.tok, key: creds.key } : null });
}
