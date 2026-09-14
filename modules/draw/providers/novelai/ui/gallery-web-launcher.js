// 「打开完整画廊」：在设置页里铺一层全屏浮层，用 iframe 加载插件自带的完整画廊网站（gallery-web/index.html，
// 由 tools/sync-gallery-web.mjs 从 nai-gallery 原样拷贝）。
//   - 地址按本文件的 import.meta.url 算，插件目录叫 xiaohei-draw / XBDraw / 别的名字都能找到。
//   - 完整画廊和酒馆同源：它自己的数据在 localStorage 的 nai.* 和 IndexedDB 的 nai-gallery，
//     和插件的 xb_* / xbdraw.* 不重名；登录（令牌 + 密码）也是它自己单独一份，和精简画廊不共用。
//   - 关闭浮层就卸掉 iframe。Esc 只在焦点在浮层顶栏时关闭（画廊里的 Esc 留给画廊自己用）。
export const GALLERY_WEB_URL = new URL('../../../../../gallery-web/index.html', import.meta.url).href;

const STYLE_ID = 'nd-gw-style';
const CSS = `
#nd-gallery-web-slot:empty { display: none; }
#nd-gallery-web-slot { margin-bottom: 8px; }
#nd-gallery-web-slot > .card { margin: 0; display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.nd-gw-text { flex: 1; min-width: 180px; }
.nd-gw-text .card-title { margin: 0 0 2px; }
.nd-gw-text .card-title i { color: var(--accent); font-size: 14px; vertical-align: -2px; margin-right: 4px; }
.nd-gw-desc { font-size: 12px; color: var(--text-secondary); line-height: 1.5; }
.nd-gw-overlay { position: fixed; inset: 0; z-index: 3000; display: flex; flex-direction: column; background: #0d0e12; }
.nd-gw-bar { flex: none; display: flex; align-items: center; gap: 6px; height: 40px; padding: 0 8px 0 12px;
    padding-top: env(safe-area-inset-top); box-sizing: content-box; background: #15161b; color: #e6e8ee; font-size: 13px; }
.nd-gw-name { flex: 1; min-width: 0; display: flex; align-items: center; gap: 6px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.nd-gw-name i { color: var(--accent); font-size: 16px; }
.nd-gw-btn { flex: none; display: inline-flex; align-items: center; justify-content: center; gap: 4px; min-width: 32px; height: 32px;
    padding: 0 8px; border: 0; border-radius: 8px; background: transparent; color: inherit; font-size: 13px; cursor: pointer; text-decoration: none; }
.nd-gw-btn i { font-size: 18px; }
.nd-gw-btn:hover { background: rgba(232, 137, 176, 0.16); color: var(--accent); }
.nd-gw-btn.is-close:hover { background: var(--accent); color: #1a1a1a; }
.nd-gw-frame { flex: 1; width: 100%; min-height: 0; border: 0; display: block; background: #0d0e12; }
@media (max-width: 768px) { .nd-gw-lbl { display: none; } }
`;

function el(tag, props = {}, ...kids) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
        if (k === 'class') n.className = v;
        else if (k === 'text') n.textContent = v;
        else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
        else n.setAttribute(k, v);
    }
    n.append(...kids);
    return n;
}
const ri = cls => el('i', { class: cls, 'aria-hidden': 'true' });

let overlay = null;
let lastFocus = null;

function onKey(e) {
    if (e.key === 'Escape' && overlay) { e.preventDefault(); closeGalleryWeb(); }
}

export function openGalleryWeb() {
    if (overlay) return overlay;
    lastFocus = document.activeElement;
    overlay = el('div', { class: 'nd-gw-overlay', role: 'dialog', 'aria-modal': 'true', 'aria-label': '完整画廊' },
        el('div', { class: 'nd-gw-bar' },
            el('div', { class: 'nd-gw-name' }, ri('ri-gallery-view-2'), el('span', { text: '完整画廊' })),
            el('a', { class: 'nd-gw-btn', href: GALLERY_WEB_URL, target: '_blank', rel: 'noopener', title: '在新标签页打开' },
                ri('ri-external-link-line'), el('span', { class: 'nd-gw-lbl', text: '新标签页' })),
            el('button', { class: 'nd-gw-btn is-close', type: 'button', title: '关闭（Esc）', 'aria-label': '关闭完整画廊', onclick: closeGalleryWeb },
                ri('ri-close-line'))),
        el('iframe', { class: 'nd-gw-frame', title: '完整画廊', src: GALLERY_WEB_URL, allow: 'clipboard-read; clipboard-write' }));
    document.body.appendChild(overlay);
    document.addEventListener('keydown', onKey);
    overlay.querySelector('.is-close').focus();
    return overlay;
}

export function closeGalleryWeb() {
    if (!overlay) return;
    document.removeEventListener('keydown', onKey);
    overlay.remove();
    overlay = null;
    try { lastFocus?.focus?.(); } catch { /* ignore */ }
}

export function mountGalleryWebLauncher(slot) {
    if (!slot) return;
    if (!document.getElementById(STYLE_ID)) document.head.appendChild(el('style', { id: STYLE_ID, text: CSS }));
    slot.replaceChildren(el('div', { class: 'card' },
        el('div', { class: 'nd-gw-text' },
            el('div', { class: 'card-title' }, ri('ri-gallery-view-2'), '完整画廊'),
            el('div', { class: 'nd-gw-desc', text: '全功能画廊网站（分面筛选、tag、导入、同步与备份）。登录单独一份，和下面的精简画廊互不影响。' })),
        el('button', { class: 'btn btn-primary', type: 'button', onclick: openGalleryWeb },
            ri('ri-fullscreen-line'), ' 打开完整画廊')));
}

if (typeof document !== 'undefined') {
    const go = () => mountGalleryWebLauncher(document.getElementById('nd-gallery-web-slot'));
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', go, { once: true });
    else go();
}
