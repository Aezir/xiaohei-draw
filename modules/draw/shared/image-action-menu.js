// image-action-menu.js
// 图片操作面板：聊天图片卡和灯箱共用一份「操作注册表」+ 一个面板组件。
// 不 import 酒馆模块，独立页面（harness）也能直接用。
//
// 注册：registerImageAction({ id, icon, label, when(ctx), run(ctx), order, surfaces })
//   surfaces：出现在哪里，'chat'（聊天图片长按）/ 'lightbox'（灯箱长按），缺省两处都有。
//   ctx = { surface, slotId, messageId, preview, index, total, download()?, lightbox?, card? }
//   when 返回真值才显示；run 可以是 async。返回值是注销函数。
// 内置：下载（两处都有，下载原图）。

import { ensureRemixIcon } from './remixicon-loader.js';
import { XB_ACCENT, xbAccentSoft } from './xb-theme.js';

export const IMAGE_ACTION_SURFACES = Object.freeze(['chat', 'lightbox']);
export const IMAGE_MENU_STYLE_ID = 'xbdraw-image-menu-styles';

const registry = new Map();
const openMenus = new Set();

export function registerImageAction(action) {
    if (!action || typeof action.id !== 'string' || !action.id.trim() || typeof action.run !== 'function') {
        throw new TypeError('registerImageAction 需要 { id, label, run }');
    }
    const surfaces = (Array.isArray(action.surfaces) && action.surfaces.length ? action.surfaces : IMAGE_ACTION_SURFACES)
        .filter(s => IMAGE_ACTION_SURFACES.includes(s));
    const entry = {
        order: 100,
        icon: 'ri-more-2-line',
        when: null,
        ...action,
        id: action.id.trim(),
        label: String(action.label || action.id),
        surfaces: Object.freeze([...new Set(surfaces)]),
    };
    registry.set(entry.id, entry);
    openMenus.forEach(menu => menu.isOpen() && menu.refresh());
    return () => {
        if (registry.get(entry.id) === entry) registry.delete(entry.id);
    };
}

export function getImageAction(id) {
    return registry.get(id) || null;
}

/** surface 为空返回全部；不传 ctx 返回该处全部已注册项；传 ctx 只返回 when(ctx) 为真的项。按 order 排序。 */
export function listImageActions(ctx, surface) {
    const all = [...registry.values()]
        .filter(a => !surface || a.surfaces.includes(surface))
        .sort((a, b) => (a.order - b.order) || a.id.localeCompare(b.id));
    if (!ctx) return all;
    return all.filter((action) => {
        if (typeof action.when !== 'function') return true;
        try { return !!action.when(ctx); } catch (error) {
            console.warn('[XBDrawImageMenu] when() 出错，已隐藏该项:', action.id, error);
            return false;
        }
    });
}

const hasImage = ctx => !!(ctx?.preview?.base64 || ctx?.preview?.savedUrl);

registerImageAction({
    id: 'download-original',
    icon: 'ri-download-2-line',
    label: '下载',
    order: 20,
    surfaces: ['chat', 'lightbox'],
    when: ctx => hasImage(ctx) && (typeof ctx.download === 'function' || typeof ctx.lightbox?.download === 'function'),
    run: ctx => (typeof ctx.download === 'function' ? ctx.download() : ctx.lightbox.download()),
});

// ── 样式 ────────────────────────────────────────────────────────────────

const MENU_CSS = `
.xb-img-menu, .xb-img-menu *, .xb-img-menu *::before, .xb-img-menu *::after { border-style: none !important; outline-style: none !important; box-shadow: none !important; }
.xb-img-menu { position: fixed; z-index: 100002; display: flex; flex-direction: column; gap: 2px; box-sizing: border-box; min-width: 168px; max-width: calc(100vw - 16px); margin: 0; padding: 4px; border-radius: 8px; background: #252525; color: #e6e6e4; font-family: Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Noto Sans SC', 'PingFang SC', 'Microsoft YaHei', sans-serif; font-size: 13px; line-height: 1.3; text-align: left; -webkit-tap-highlight-color: transparent; -webkit-touch-callout: none; -webkit-user-select: none; user-select: none; touch-action: manipulation; }
.xb-img-menu[hidden] { display: none !important; }
.xb-img-menu-item { display: flex; align-items: center; gap: 8px; box-sizing: border-box; width: 100%; min-height: 32px; margin: 0; padding: 6px 10px; border-radius: 6px; background: transparent; color: #e6e6e4; font: inherit; font-size: 13px; text-align: left; white-space: nowrap; cursor: pointer; transition: background 0.12s; }
.xb-img-menu-item:hover, .xb-img-menu-item:focus-visible { background: #2f2f2f; }
.xb-img-menu-item:active { background: ${xbAccentSoft(0.18)}; }
.xb-img-menu-item i { font-size: 16px; line-height: 1; color: #9b9b98; }
.xb-img-menu-item:hover i, .xb-img-menu-item:focus-visible i { color: ${XB_ACCENT}; }
.xb-img-menu-empty { padding: 8px 10px; font-size: 12px; color: #6b6b68; }
@media (pointer: coarse) { .xb-img-menu { min-width: 184px; } .xb-img-menu-item { min-height: 44px; font-size: 14px; } }
`;

export function ensureImageMenuStyles(doc = globalThis.document) {
    if (!doc?.head) return;
    ensureRemixIcon(doc);
    if (doc.getElementById(IMAGE_MENU_STYLE_ID)) return;
    const style = doc.createElement('style');
    style.id = IMAGE_MENU_STYLE_ID;
    style.textContent = MENU_CSS;
    doc.head.appendChild(style);
}

// ── 面板组件 ─────────────────────────────────────────────────────────────

/** 在 (x, y) 附近放一个 w×h 的面板：右下优先，放不下就翻到左 / 上，最后夹在视口内。纯函数。 */
export function placeMenu(x, y, w, h, vw, vh, { gap = 4, edge = 8 } = {}) {
    let left = x + gap;
    if (left + w > vw - edge) left = x - w - gap;
    let top = y + gap;
    if (top + h > vh - edge) top = y - h - gap;
    left = Math.max(edge, Math.min(left, vw - w - edge));
    top = Math.max(edge, Math.min(top, vh - h - edge));
    return { left: Math.round(left), top: Math.round(top), placement: `${top < y ? 'top' : 'bottom'}-${left < x ? 'left' : 'right'}` };
}

/**
 * options: {
 *   document, surface: 'chat'|'lightbox', parent (默认 body),
 *   onError(error, actionId)?,
 *   autoDismiss: true —— 外面按下 / 滚动 / Esc / 窗口变化时自动关（灯箱自己管，传 false），
 *   swallowSelector: 关面板的那次按下如果落在这些元素上，不再往下传（避免顺带触发单击）
 * }
 */
export function createImageActionMenu(options = {}) {
    const doc = options.document || globalThis.document;
    const surface = options.surface || 'chat';
    ensureImageMenuStyles(doc);
    const menu = doc.createElement('div');
    menu.className = 'xb-img-menu';
    menu.setAttribute('role', 'menu');
    menu.setAttribute('data-xbdraw-ui', '');
    menu.setAttribute('data-swipe-ignore', 'true');
    menu.dataset.surface = surface;
    menu.hidden = true;
    (options.parent || doc.body).appendChild(menu);

    let ctx = null;
    let open = false;
    const view = doc.defaultView || globalThis;

    function render() {
        menu.replaceChildren();
        const items = listImageActions(ctx, surface);
        if (!items.length) {
            const empty = doc.createElement('div');
            empty.className = 'xb-img-menu-empty';
            empty.textContent = '没有可用操作';
            menu.appendChild(empty);
            return;
        }
        for (const action of items) {
            const item = doc.createElement('button');
            item.type = 'button';
            item.className = 'xb-img-menu-item';
            item.setAttribute('role', 'menuitem');
            item.setAttribute('data-swipe-ignore', 'true');
            item.dataset.actionId = action.id;
            const icon = doc.createElement('i');
            icon.className = action.icon || 'ri-more-2-line';
            icon.setAttribute('aria-hidden', 'true');
            const label = doc.createElement('span');
            label.textContent = action.label;
            item.append(icon, label);
            menu.appendChild(item);
        }
    }

    function openAt(x, y, nextCtx) {
        ctx = { surface, ...(nextCtx || {}) };
        render();
        menu.hidden = false;
        open = true;
        const rect = menu.getBoundingClientRect();
        const vw = doc.documentElement.clientWidth || view.innerWidth;
        const vh = view.innerHeight;
        const pos = placeMenu(x, y, rect.width, rect.height, vw, vh);
        menu.style.left = `${pos.left}px`;
        menu.style.top = `${pos.top}px`;
        menu.dataset.placement = pos.placement;
        if (options.autoDismiss !== false) bindDismiss();
        return controller;
    }

    function close() {
        if (!open) return false;
        open = false;
        menu.hidden = true;
        unbindDismiss();
        return true;
    }

    // 自动关闭
    const onPointerDown = (event) => {
        if (menu.contains(event.target)) return;
        close();
        if (options.swallowSelector && event.target?.closest?.(options.swallowSelector)) {
            event.stopPropagation();
        }
    };
    const onScroll = (event) => { if (!menu.contains(event.target)) close(); };
    const onKeyDown = (event) => {
        if (event.key !== 'Escape') return;
        event.preventDefault();
        event.stopPropagation();
        close();
    };
    // 手机地址栏收起 / 弹出只改高度，也会发 resize：只在宽度变化（转屏、拖窗口）时关
    let openWidth = 0;
    const onViewChange = (event) => {
        if (event?.type === 'resize' && Math.abs((view.innerWidth || 0) - openWidth) < 2) return;
        close();
    };
    const onContextMenu = (event) => { if (menu.contains(event.target)) event.preventDefault(); };
    let dismissBound = false;
    function bindDismiss() {
        openWidth = view.innerWidth || 0;
        if (dismissBound) return;
        dismissBound = true;
        doc.addEventListener('pointerdown', onPointerDown, true);
        doc.addEventListener('scroll', onScroll, true);
        doc.addEventListener('keydown', onKeyDown, true);
        view.addEventListener?.('resize', onViewChange);
        view.addEventListener?.('blur', onViewChange);
    }
    function unbindDismiss() {
        if (!dismissBound) return;
        dismissBound = false;
        doc.removeEventListener('pointerdown', onPointerDown, true);
        doc.removeEventListener('scroll', onScroll, true);
        doc.removeEventListener('keydown', onKeyDown, true);
        view.removeEventListener?.('resize', onViewChange);
        view.removeEventListener?.('blur', onViewChange);
    }

    menu.addEventListener('contextmenu', onContextMenu);
    menu.addEventListener('click', async (event) => {
        const item = event.target.closest?.('.xb-img-menu-item');
        event.stopPropagation();
        if (!item) return;
        const action = registry.get(item.dataset.actionId);
        const runCtx = ctx;
        close();
        if (!action) return;
        try {
            await action.run(runCtx);
        } catch (error) {
            options.onError ? options.onError(error, action.id) : console.error('[XBDrawImageMenu] 操作失败:', action.id, error);
        }
    });

    const controller = {
        element: menu,
        surface,
        openAt,
        close,
        isOpen: () => open,
        refresh: () => { if (open) render(); },
        get context() { return ctx; },
        destroy() {
            close();
            openMenus.delete(controller);
            menu.remove();
        },
    };
    openMenus.add(controller);
    return controller;
}

// ── 聊天图片卡的面板（整页一个） ─────────────────────────────────────────

let chatMenu = null;

export function openChatImageMenu(x, y, ctx, { document: doc = globalThis.document, onError } = {}) {
    if (!chatMenu || !chatMenu.element.isConnected || chatMenu.element.ownerDocument !== doc) {
        chatMenu?.destroy();
        chatMenu = createImageActionMenu({ document: doc, surface: 'chat', onError, swallowSelector: '.xb-nd-img-wrap' });
    }
    return chatMenu.openAt(x, y, ctx);
}

export function getChatImageMenu() {
    return chatMenu;
}

export function closeChatImageMenu() {
    return chatMenu?.close() || false;
}

export function destroyChatImageMenu() {
    chatMenu?.destroy();
    chatMenu = null;
}
