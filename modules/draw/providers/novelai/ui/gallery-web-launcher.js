// 图片管理页下半部分「画廊」：完整画廊网站（gallery-web/index.html，由 tools/sync-gallery-web.mjs 从 nai-gallery 拷贝）
// 用 iframe 常驻嵌在页面里，地址带 ?embed=xiaohei（画廊换成小黑生图主题、藏掉主题切换、详情里多「加入绘图参数预设」）。
//   - 地址按本文件的 import.meta.url 算，插件目录叫 xiaohei-draw / XBDraw / 别的名字都能找到。
//   - 第一次切到图片管理页才加载 iframe；高度 = 设置页滚动区的可视高度（手机也一样）。
//   - 登录打通：画廊启动时发 hello，这里读插件的画廊连接（IndexedDB xb_gallery_link 的 {repo, tok, key}）回给它，
//     画廊只放内存里用。插件那边连接 / 断开后重新加载 iframe。消息约定见 shared/gallery-sync/embed-bridge.js。
//   - 「加入绘图参数预设」：画廊只发图的文字信息，这里交给 gallery-browser.js 的 window.NDGallery.importRecord，
//     走和原来「导入为参数预设」一样的起名 / 查重 / IMPORT_GALLERY_PRESET 路径。
import { createCredentialStore } from '../../../shared/gallery-sync/credential-store.js';
import { createLocalGallery } from '../../../shared/gallery-sync/local-store.js';
import { listImages } from '../../../shared/gallery-sync/gallery-client.js';
import { embedUrl, hostMessage, isTrustedEmbedMessage, linkReply, parseImportRequest } from '../../../shared/gallery-sync/embed-bridge.js';

export const GALLERY_WEB_URL = new URL('../../../../../gallery-web/index.html', import.meta.url).href;
export const GALLERY_EMBED_URL = embedUrl(GALLERY_WEB_URL);

const STYLE_ID = 'nd-gw-style';
const CSS = `
.nd-gallery-section + .nd-gallery-section { margin-top: 16px; }
#nd-gallery-web-slot { display: flex; flex-direction: column; gap: 6px; }
#nd-gallery-web-slot [hidden] { display: none !important; }
#nd-gallery-web-slot .nd-gw-status:empty { display: none; }
.nd-sec-toggle { display: flex; align-items: center; gap: 6px; width: 100%; border: 0; background: transparent; color: inherit; font: inherit; text-align: left; cursor: pointer; }
.nd-sec-toggle .nd-sec-arrow { margin-left: auto; font-size: 18px; opacity: .6; transition: transform .2s; }
.nd-gallery-section.is-collapsed .nd-sec-arrow { transform: rotate(-90deg); }
.nd-gallery-section.is-collapsed .nd-sec-body { display: none; }
.nd-gw-frame { display: block; width: 100%; height: calc(100dvh - 48px); min-height: 420px; border: 0; border-radius: var(--radius-lg, 10px); background: var(--bg-primary); }
`;

function el(tag, props = {}, ...kids) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
        if (v == null || v === false) continue;
        if (k === 'class') n.className = v;
        else if (k === 'text') n.textContent = v;
        else if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2), v);
        else if (v === true) n.setAttribute(k, '');
        else n.setAttribute(k, v);
    }
    n.append(...kids.filter(x => x != null && x !== false));
    return n;
}
const ri = cls => el('i', { class: cls, 'aria-hidden': 'true' });

const E = { slot: null, frame: null, note: null, status: null, box: null, credentials: undefined, local: undefined, listening: false };

function stores() {
    if (E.credentials === undefined) { try { E.credentials = createCredentialStore(); } catch { E.credentials = null; } }
    if (E.local === undefined) { try { E.local = createLocalGallery(); } catch { E.local = null; } }
    return { credentials: E.credentials, local: E.local };
}

function send(msg) {
    try { E.frame?.contentWindow?.postMessage(msg, window.location.origin); } catch { /* iframe 已卸载 */ }
}

function setStatus({ state = '', text = '' } = {}) {
    if (!E.status) return;
    E.status.textContent = text || '';
    E.status.className = `status-text nd-gw-status${state ? ` ${state}` : ''}`;
    if (E.frame && text && (state === 'success' || state === 'error')) send(hostMessage('toast', { text }));
}

function fitHeight() {
    if (!E.frame) return;
    const main = E.slot?.closest('.app-main');
    let h = 0;
    if (main) {
        const cs = getComputedStyle(main);
        h = main.clientHeight - (parseFloat(cs.paddingTop) || 0) - (parseFloat(cs.paddingBottom) || 0);
    }
    if (!(h > 0)) h = (window.innerHeight || 0) - 24;
    E.frame.style.height = `${Math.max(420, Math.round(h))}px`;
}

async function renderNote() {
    if (!E.note) return;
    const { credentials, local } = stores();
    let creds = null, localCount = 0;
    try { creds = credentials ? await credentials.load() : null; } catch { creds = null; }
    if (!creds && local) {
        try { localCount = listImages((await local.readState()).state, { limit: 0 }).total; } catch { localCount = 0; }
    }
    if (creds) { E.note.hidden = true; E.note.replaceChildren(); return; }
    const goAuth = () => {
        if (typeof window.switchView === 'function') window.switchView('api');
        setTimeout(() => document.getElementById('nd-gallery-auth-slot')?.scrollIntoView({ block: 'start', behavior: 'smooth' }), 60);
    };
    const text = localCount
        ? `小黑生图还没连画廊同步仓库：聊天里「同步到 Gallery」的 ${localCount} 张图存在小黑生图本机，这里的画廊看不到。连上仓库后可以合并上去。`
        : '小黑生图还没连画廊同步仓库。在 API 配置里连上以后，这里的画廊自动用同一个仓库，不用再登录一次。';
    E.note.replaceChildren(el('div', { class: 'nd-gl-note-row' }, ri('ri-information-line'), el('span', { text }),
        el('button', { class: 'btn btn-sm', type: 'button', onclick: goAuth }, '去连接')));
    E.note.hidden = false;
}

function loadFrame() {
    if (E.frame || !E.box) return;
    E.frame = el('iframe', { class: 'nd-gw-frame', title: '画廊', src: GALLERY_EMBED_URL, allow: 'clipboard-read; clipboard-write' });
    E.box.replaceChildren(E.frame);
    fitHeight();
}

function reloadFrame() {
    if (!E.frame) return;
    try { E.frame.contentWindow.location.reload(); } catch { E.frame.src = GALLERY_EMBED_URL; }
}

async function onMessage(event) {
    if (!E.frame || !isTrustedEmbedMessage(event, { origin: window.location.origin, frameWindow: E.frame.contentWindow })) return;
    const data = event.data;
    if (data.type === 'hello') {
        let creds = null;
        try { creds = stores().credentials ? await stores().credentials.load() : null; } catch { creds = null; }
        send(linkReply(creds));
        return;
    }
    if (data.type === 'import-preset') {
        let req;
        try { req = parseImportRequest(data); } catch (e) { setStatus({ state: 'error', text: e?.message || '这张图没法导入' }); return; }
        const api = window.NDGallery;
        if (!api || typeof api.importRecord !== 'function') { setStatus({ state: 'error', text: '设置页还没准备好，稍后再试' }); return; }
        void api.importRecord(req.record, { vars: req.vars, varIndex: req.varIndex });
    }
}

// 「文生图 / 画廊」两块可折叠：点标题收起/展开，状态记在本机浏览器（localStorage），默认都展开。
const COLLAPSE_KEY = 'xbdraw.gallerySections.collapsed';

function readCollapsed() {
    try { return JSON.parse(localStorage.getItem(COLLAPSE_KEY) || '{}') || {}; } catch { return {}; }
}

function isGalleryExpanded() {
    const section = document.querySelector('.nd-sec-toggle[data-sec="gallery"]')?.closest('.nd-gallery-section');
    return !section?.classList.contains('is-collapsed');
}

function setupSectionCollapse(onExpand) {
    const saved = readCollapsed();
    document.querySelectorAll('.nd-sec-toggle[data-sec]').forEach((button) => {
        const section = button.closest('.nd-gallery-section');
        if (!section || button.dataset.collapseBound) return;
        button.dataset.collapseBound = '1';
        const key = button.dataset.sec;
        const apply = (collapsed) => {
            section.classList.toggle('is-collapsed', collapsed);
            button.setAttribute('aria-expanded', String(!collapsed));
        };
        apply(saved[key] === true);
        button.addEventListener('click', () => {
            const collapsed = !section.classList.contains('is-collapsed');
            apply(collapsed);
            const next = readCollapsed();
            next[key] = collapsed;
            try { localStorage.setItem(COLLAPSE_KEY, JSON.stringify(next)); } catch { /* 存不了就只在本次生效 */ }
            if (!collapsed) onExpand(key);
        });
    });
}

export function mountGalleryWebEmbed(slot) {
    if (!slot) return;
    E.slot = slot;
    if (!document.getElementById(STYLE_ID)) document.head.appendChild(el('style', { id: STYLE_ID, text: CSS }));
    E.note = el('div', { class: 'nd-gw-note', hidden: true });
    E.status = el('div', { class: 'status-text nd-gw-status', role: 'status' });
    E.box = el('div', { class: 'nd-gw-box' });
    slot.replaceChildren(E.note, E.status, E.box);

    const view = document.getElementById('view-gallery');
    const visible = () => !view || view.classList.contains('active');
    // 画廊收起时不加载 iframe，展开时才加载
    const onShow = () => { if (isGalleryExpanded()) { loadFrame(); fitHeight(); } void renderNote(); };
    setupSectionCollapse((key) => { if (key === 'gallery' && visible()) onShow(); });
    if (visible()) onShow();
    if (view && typeof MutationObserver === 'function') {
        // 只在 active 真的变了才处理（回调里不写被观察的属性）
        let was = visible();
        new MutationObserver(() => { const now = visible(); if (now !== was) { was = now; if (now) onShow(); } })
            .observe(view, { attributes: true, attributeFilter: ['class'] });
    }
    if (E.listening) return;
    E.listening = true;
    window.addEventListener('message', onMessage);
    window.addEventListener('resize', fitHeight);
    const main = slot.closest('.app-main');
    if (main && typeof ResizeObserver === 'function') new ResizeObserver(fitHeight).observe(main);
    document.addEventListener('nd:gallery-link-change', () => { void renderNote(); reloadFrame(); });
    document.addEventListener('nd:gallery-import-status', e => setStatus(e.detail || {}));
    document.addEventListener('nd:gallery-batch-done', () => { void renderNote(); send(hostMessage('resync')); });
}

if (typeof document !== 'undefined') {
    const go = () => mountGalleryWebEmbed(document.getElementById('nd-gallery-web-slot'));
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', go, { once: true });
    else go();
}
