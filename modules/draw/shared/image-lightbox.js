// image-lightbox.js
// 灯箱：看一个图片槽位的全部历史版本。
// - 缩放：双指捏合 / 滚轮（触控板捏合）以光标为中心缩放，放大后拖动平移，双击（双指点）在「适应」和 2 倍之间切换；范围 1–6 倍。
// - 切版本：只在适应大小时左右滑 / 左右键切换；放大时横滑是平移。切版本、重新打开都回到适应大小。
// - 长按（或鼠标右键）图片在按压位置弹出操作面板，任何缩放下都能用。
// 不 import 酒馆模块：保存、设为显示、下载都由调用方（gallery-cache.js）注入，独立页面也能直接用。
//
// 扩展点：registerLightboxAction({ id, icon, label, when(ctx), run(ctx), order, surfaces? })
//   是 image-action-menu.js 里 registerImageAction 的兼容包装：不写 surfaces 时只进灯箱；
//   写 surfaces: ['chat', 'lightbox'] 就两处都有（「同步到 Gallery」就是这样注册的）。
//   ctx = { surface, slotId, messageId, preview, index, total, download(), lightbox }
// 内置两项：保存到服务器（只对未保存的预览显示）、下载（下载原图）。

import { bindGestures } from './chat-image-gestures.js';
import { ensureRemixIcon } from './remixicon-loader.js';
import { XB_ACCENT_HOVER, xbAccentSoft } from './xb-theme.js';
import { createImageActionMenu, ensureImageMenuStyles, listImageActions, registerImageAction } from './image-action-menu.js';

export const LIGHTBOX_OVERLAY_ID = 'nd-gallery-overlay';
export const LIGHTBOX_STYLE_ID = 'nd-gallery-styles';
export const LIGHTBOX_ZOOM = Object.freeze({ min: 1, max: 6, doubleTap: 2, wheelStep: 0.0015, wheelPinchStep: 0.01 });

let current = null;

export function registerLightboxAction(action) {
    if (!action || typeof action.id !== 'string' || !action.id.trim() || typeof action.run !== 'function') {
        throw new TypeError('registerLightboxAction 需要 { id, label, run }');
    }
    return registerImageAction({ ...action, surfaces: action.surfaces?.length ? action.surfaces : ['lightbox'] });
}

/** 不传 ctx 返回灯箱里全部已注册项；传 ctx 只返回 when(ctx) 为真的项。按 order 排序。 */
export function listLightboxActions(ctx) {
    return listImageActions(ctx, 'lightbox');
}

// ── 原图下载 ─────────────────────────────────────────────────────────────

function parseBase64Image(value) {
    const raw = String(value || '').trim();
    if (!raw) return null;
    const match = raw.match(/^data:([^;]+);base64,(.*)$/i);
    return { mime: match?.[1] || 'image/png', data: match ? match[2] : raw };
}

const EXT_BY_MIME = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' };

/** 原图数据：优先画廊缓存的 base64，没有才取 savedUrl。 */
export async function resolveOriginalImageBlob(preview, { fetchImpl = globalThis.fetch } = {}) {
    const parsed = parseBase64Image(preview?.base64);
    if (parsed?.data) {
        const binary = atob(parsed.data);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        return new Blob([bytes], { type: parsed.mime });
    }
    const url = String(preview?.savedUrl || '').trim();
    if (!url) throw new Error('没有可下载的原图');
    const response = await fetchImpl(url);
    if (!response.ok) throw new Error(`原图读取失败（${response.status}）`);
    return response.blob();
}

export function getOriginalImageFileName(preview, blob) {
    const saved = String(preview?.savedUrl || '').split(/[?#]/)[0].split('/').pop() || '';
    if (!preview?.base64 && /\.[a-z0-9]{2,5}$/i.test(saved)) return decodeURIComponent(saved);
    const base = String(preview?.imgId || 'xbdraw-image').replace(/[^\w.-]+/g, '_');
    const ext = EXT_BY_MIME[String(blob?.type || '').toLowerCase()] || 'png';
    return `${base}.${ext}`;
}

export async function downloadImageOriginal(preview, { doc = globalThis.document, fetchImpl } = {}) {
    const blob = await resolveOriginalImageBlob(preview, { fetchImpl });
    const name = getOriginalImageFileName(preview, blob);
    const href = URL.createObjectURL(blob);
    const link = doc.createElement('a');
    link.href = href;
    link.download = name;
    link.rel = 'noopener';
    link.style.display = 'none';
    doc.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(href), 4000);
    return name;
}

// ── 缩放数学（纯函数，便于测试） ──────────────────────────────────────────

export function clampZoomScale(scale, { min = LIGHTBOX_ZOOM.min, max = LIGHTBOX_ZOOM.max } = {}) {
    return Math.min(max, Math.max(min, Number(scale) || min));
}

/** 平移范围：图片边缘不越过它适应大小时的框（放大后每个角落都能拖到框里看）。 */
export function clampZoomPan(tx, ty, scale, width, height) {
    const mx = Math.max(0, (width * (scale - 1)) / 2);
    const my = Math.max(0, (height * (scale - 1)) / 2);
    return { tx: Math.min(mx, Math.max(-mx, tx)), ty: Math.min(my, Math.max(-my, ty)) };
}

/**
 * 以屏幕上的点 (px, py) 为中心把缩放从 view.scale 改成 nextScale，这个点下面的图片内容保持不动。
 * view = { scale, tx, ty }，center = 图片适应大小时的中心（屏幕坐标），transform-origin 为中心。
 */
export function zoomAtPoint(view, nextScale, px, py, center) {
    const q = { x: (px - center.x - view.tx) / view.scale, y: (py - center.y - view.ty) / view.scale };
    return { scale: nextScale, tx: px - center.x - nextScale * q.x, ty: py - center.y - nextScale * q.y };
}

// ── 样式 ────────────────────────────────────────────────────────────────

const LIGHTBOX_CSS = `
#nd-gallery-overlay, #nd-gallery-overlay *, #nd-gallery-overlay *::before, #nd-gallery-overlay *::after { border-style: none !important; outline-style: none !important; box-shadow: none !important; }
#nd-gallery-overlay { position: fixed; inset: 0; z-index: 100000; display: none; flex-direction: column; align-items: center; justify-content: center; gap: 12px; box-sizing: border-box; padding: 16px; overflow: hidden; background: rgba(15, 15, 15, 0.92); color: #e6e6e4; font-size: 13px; touch-action: none; overscroll-behavior: contain; -webkit-tap-highlight-color: transparent; }
#nd-gallery-overlay.visible { display: flex; }
.nd-lb-icon-btn { display: flex; align-items: center; justify-content: center; flex-shrink: 0; width: 36px; height: 36px; margin: 0; padding: 0; border-radius: 8px; background: #2a2a2a; color: #e6e6e4; font-size: 20px; line-height: 1; cursor: pointer; transition: background 0.12s; }
.nd-lb-icon-btn:hover { background: #333333; }
.nd-lb-icon-btn:disabled { opacity: 0.3; cursor: default; }
.nd-lb-close { position: absolute; top: 12px; right: 12px; z-index: 3; }
.nd-lb-stage { display: flex; align-items: center; justify-content: center; gap: 12px; max-width: 100%; min-height: 0; }
.nd-lb-img-wrap { position: relative; z-index: 2; max-width: calc(100vw - 140px); touch-action: none; -webkit-touch-callout: none; -webkit-user-select: none; user-select: none; cursor: zoom-in; }
.nd-lb-img-wrap.zoomed { cursor: grab; }
.nd-lb-img-wrap.panning { cursor: grabbing; }
.nd-lb-img { display: block; max-width: 100%; max-height: calc(100vh - 140px); max-height: calc(100dvh - 140px); margin: 0 auto; border-radius: 10px; transform-origin: 50% 50%; will-change: transform; -webkit-user-drag: none; -webkit-user-select: none; user-select: none; -webkit-touch-callout: none; touch-action: none; }
.nd-lb-img.zoom-anim { transition: transform 0.18s ease; }
.nd-lb-badge { position: absolute; top: 8px; left: 8px; padding: 2px 8px; border-radius: 6px; background: rgba(77, 171, 111, 0.9); color: #ffffff; font-size: 11px; pointer-events: none; transition: opacity 0.12s; }
.nd-lb-img-wrap.zoomed .nd-lb-badge { opacity: 0; }
.nd-lb-badge[hidden] { display: none !important; }
.nd-lb-bar { position: relative; z-index: 3; display: flex; flex-wrap: wrap; align-items: center; justify-content: center; gap: 10px; font-size: 12px; color: #9b9b98; }
.nd-lb-use { display: inline-flex; align-items: center; gap: 4px; min-height: 28px; margin: 0; padding: 4px 10px; border-radius: 6px; background: ${xbAccentSoft(0.18)}; color: ${XB_ACCENT_HOVER}; font: inherit; font-size: 12px; cursor: pointer; }
.nd-lb-use:hover { background: ${xbAccentSoft(0.26)}; }
.nd-lb-use[hidden] { display: none !important; }
.nd-lb-hint { color: #6b6b68; }
@media (max-width: 600px), (pointer: coarse) {
    .nd-lb-nav { display: none; }
    .nd-lb-img-wrap { max-width: calc(100vw - 32px); }
}
`;

export function ensureLightboxStyles(doc = globalThis.document) {
    if (!doc?.head) return;
    ensureRemixIcon(doc);
    ensureImageMenuStyles(doc);
    if (doc.getElementById(LIGHTBOX_STYLE_ID)) return;
    const style = doc.createElement('style');
    style.id = LIGHTBOX_STYLE_ID;
    style.textContent = LIGHTBOX_CSS;
    doc.head.appendChild(style);
}

// ── 灯箱 ────────────────────────────────────────────────────────────────

function createIcon(doc, className) {
    const icon = doc.createElement('i');
    icon.className = className;
    icon.setAttribute('aria-hidden', 'true');
    return icon;
}

function createButton(doc, className, iconClass, label) {
    const button = doc.createElement('button');
    button.type = 'button';
    button.className = className;
    if (iconClass) button.appendChild(createIcon(doc, iconClass));
    if (label) button.setAttribute('aria-label', label);
    return button;
}

/**
 * options: {
 *   previews,            // 历史版本数组，index 0 = 最新
 *   startIndex, selectedIndex, slotId, messageId,
 *   getUrl(preview),     // 显示用 URL
 *   onUse(preview, index)?, onSave(preview, index)? -> url, onDownload(preview)?,
 *   onError(error, kind)?, onClose()?, document?
 * }
 */
export function openImageLightbox(options = {}) {
    const doc = options.document || globalThis.document;
    const previews = (Array.isArray(options.previews) ? options.previews : []).filter(Boolean);
    if (!doc?.body || !previews.length) return null;
    closeImageLightbox();
    ensureLightboxStyles(doc);

    const clampIndex = value => Math.min(previews.length - 1, Math.max(0, Number.parseInt(value, 10) || 0));
    const state = {
        index: clampIndex(options.startIndex),
        selectedIndex: options.selectedIndex == null ? clampIndex(options.startIndex) : clampIndex(options.selectedIndex),
        busy: false,
    };
    const getUrl = typeof options.getUrl === 'function'
        ? options.getUrl
        : (preview => preview?.savedUrl || (preview?.base64 ? (String(preview.base64).startsWith('data:') ? preview.base64 : `data:image/png;base64,${preview.base64}`) : ''));

    doc.getElementById(LIGHTBOX_OVERLAY_ID)?.remove();
    const overlay = doc.createElement('div');
    overlay.id = LIGHTBOX_OVERLAY_ID;
    overlay.setAttribute('data-xbdraw-ui', '');
    overlay.setAttribute('data-swipe-ignore', 'true');
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');

    const closeBtn = createButton(doc, 'nd-lb-icon-btn nd-lb-close', 'ri-close-line', '关闭');
    const stage = doc.createElement('div');
    stage.className = 'nd-lb-stage';
    const olderBtn = createButton(doc, 'nd-lb-icon-btn nd-lb-nav', 'ri-arrow-left-s-line', '更旧的版本');
    olderBtn.dataset.dir = 'older';
    const newerBtn = createButton(doc, 'nd-lb-icon-btn nd-lb-nav', 'ri-arrow-right-s-line', '更新的版本');
    newerBtn.dataset.dir = 'newer';
    const wrap = doc.createElement('div');
    wrap.className = 'nd-lb-img-wrap';
    wrap.setAttribute('data-swipe-ignore', 'true');
    const img = doc.createElement('img');
    img.className = 'nd-lb-img';
    img.alt = '';
    img.draggable = false;
    img.setAttribute('data-swipe-ignore', 'true');
    const badge = doc.createElement('span');
    badge.className = 'nd-lb-badge';
    badge.textContent = '已保存';
    wrap.append(img, badge);
    stage.append(olderBtn, wrap, newerBtn);

    const bar = doc.createElement('div');
    bar.className = 'nd-lb-bar';
    const info = doc.createElement('span');
    info.className = 'nd-lb-info';
    const useBtn = createButton(doc, 'nd-lb-use', 'ri-check-line');
    useBtn.append('设为显示');
    const hint = doc.createElement('span');
    hint.className = 'nd-lb-hint';
    const coarse = doc.defaultView?.matchMedia?.('(pointer: coarse)')?.matches;
    hint.textContent = coarse ? '双指缩放 · 长按更多操作' : '滚轮缩放 · 右键或长按更多操作';
    bar.append(info, useBtn, hint);

    overlay.append(closeBtn, stage, bar);
    doc.body.appendChild(overlay);

    const menu = createImageActionMenu({
        document: doc,
        surface: 'lightbox',
        parent: overlay,
        autoDismiss: false,
        onError: (error, id) => (options.onError ? options.onError(error, id) : console.error('[XBDrawLightbox] 操作失败:', id, error)),
    });

    // ── 缩放 / 平移 ──
    const view = { scale: 1, tx: 0, ty: 0 };
    const pointers = new Map(); // pointerId -> { x, y, type }
    let pinch = null;           // { dist, mid, view }
    let pan = null;             // { id, x, y, view }
    let multiTouch = false;     // 这次按压里出现过两根手指
    let multiEndedAt = 0;

    const baseBox = () => {
        const wr = wrap.getBoundingClientRect();
        const width = img.offsetWidth || wr.width;
        const height = img.offsetHeight || wr.height;
        return { width, height, center: { x: wr.left + img.offsetLeft + width / 2, y: wr.top + img.offsetTop + height / 2 } };
    };

    function applyView({ animate = false } = {}) {
        const box = baseBox();
        view.scale = clampZoomScale(view.scale);
        if (view.scale <= 1.001) { view.scale = 1; view.tx = 0; view.ty = 0; }
        const clamped = clampZoomPan(view.tx, view.ty, view.scale, box.width, box.height);
        view.tx = clamped.tx;
        view.ty = clamped.ty;
        img.classList.toggle('zoom-anim', animate);
        img.style.transform = view.scale === 1 ? '' : `translate(${view.tx}px, ${view.ty}px) scale(${view.scale})`;
        wrap.classList.toggle('zoomed', view.scale > 1);
        overlay.dataset.zoom = view.scale.toFixed(3);
    }

    function zoomTo(scale, px, py, opts) {
        const box = baseBox();
        const next = zoomAtPoint(view, clampZoomScale(scale), px ?? box.center.x, py ?? box.center.y, box.center);
        Object.assign(view, next);
        applyView(opts);
        return view.scale;
    }

    function resetZoom(opts) {
        view.scale = 1; view.tx = 0; view.ty = 0;
        pinch = null; pan = null;
        applyView(opts);
    }

    const isZoomed = () => view.scale > 1.001;
    const gestureBlocked = () => multiTouch || pointers.size > 1 || (Date.now() - multiEndedAt < 400);

    function onZoomPointerDown(event) {
        if (event.pointerType === 'mouse' && event.button !== 0) return;
        pointers.set(event.pointerId, { x: event.clientX, y: event.clientY, type: event.pointerType });
        if (pointers.size >= 2) {
            multiTouch = true;
            menu.close();
            const [a, b] = [...pointers.values()];
            pinch = { dist: Math.hypot(a.x - b.x, a.y - b.y) || 1, mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, view: { ...view } };
            pan = null;
            img.classList.remove('zoom-anim');
        } else if (isZoomed()) {
            pan = { id: event.pointerId, x: event.clientX, y: event.clientY, view: { ...view } };
        }
    }

    function onZoomPointerMove(event) {
        const p = pointers.get(event.pointerId);
        if (!p) return;
        p.x = event.clientX;
        p.y = event.clientY;
        if (pinch && pointers.size >= 2) {
            const [a, b] = [...pointers.values()];
            const dist = Math.hypot(a.x - b.x, a.y - b.y) || 1;
            const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
            const box = baseBox();
            // 以起始中点为锚缩放，再加上中点的移动 = 双指平移
            const next = zoomAtPoint(pinch.view, clampZoomScale(pinch.view.scale * (dist / pinch.dist)), pinch.mid.x, pinch.mid.y, box.center);
            Object.assign(view, { scale: next.scale, tx: next.tx + (mid.x - pinch.mid.x), ty: next.ty + (mid.y - pinch.mid.y) });
            applyView();
            if (event.cancelable) event.preventDefault();
            return;
        }
        if (pan && pan.id === event.pointerId && isZoomed()) {
            if (event.pointerType === 'mouse' && !(event.buttons & 1)) return;
            view.tx = pan.view.tx + (event.clientX - pan.x);
            view.ty = pan.view.ty + (event.clientY - pan.y);
            wrap.classList.add('panning');
            applyView();
            if (event.cancelable) event.preventDefault();
        }
    }

    function onZoomPointerEnd(event) {
        if (!pointers.has(event.pointerId)) return;
        pointers.delete(event.pointerId);
        wrap.classList.remove('panning');
        if (pan?.id === event.pointerId) pan = null;
        if (pointers.size < 2) pinch = null;
        if (pointers.size === 1 && isZoomed()) {
            // 捏合后剩一根手指：接着平移
            const [[id, rest]] = [...pointers.entries()];
            pan = { id, x: rest.x, y: rest.y, view: { ...view } };
        }
        if (pointers.size === 0) {
            if (multiTouch) multiEndedAt = Date.now();
            multiTouch = false;
            pan = null;
        }
    }

    function onWheel(event) {
        event.preventDefault();
        if (!wrap.contains(event.target) && !isZoomed()) return;
        const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 400 : 1;
        const step = event.ctrlKey ? LIGHTBOX_ZOOM.wheelPinchStep : LIGHTBOX_ZOOM.wheelStep;
        menu.close();
        zoomTo(view.scale * Math.exp(-event.deltaY * unit * step), event.clientX, event.clientY);
    }

    const preventNative = event => event.preventDefault();

    const controller = {
        element: overlay,
        menuElement: menu.element,
        canSave: typeof options.onSave === 'function',
        get index() { return state.index; },
        get total() { return previews.length; },
        get preview() { return previews[state.index]; },
        isMenuOpen: () => menu.isOpen(),
        go,
        save,
        download,
        close: closeImageLightbox,
        openMenuAt,
        closeMenu,
        refreshMenu: () => menu.refresh(),
        refresh: render,
        zoom: {
            get scale() { return view.scale; },
            get tx() { return view.tx; },
            get ty() { return view.ty; },
            zoomTo,
            reset: resetZoom,
            toggleAt,
        },
    };

    function buildContext() {
        return {
            surface: 'lightbox',
            slotId: options.slotId ?? null,
            messageId: options.messageId ?? null,
            preview: previews[state.index],
            index: state.index,
            total: previews.length,
            download: () => controller.download(),
            lightbox: controller,
        };
    }

    function render() {
        const preview = previews[state.index];
        const url = getUrl(preview) || '';
        if (img.getAttribute('src') !== url) img.src = url;
        badge.hidden = !preview?.savedUrl;
        olderBtn.disabled = state.index >= previews.length - 1;
        newerBtn.disabled = state.index <= 0;
        const date = preview?.timestamp ? new Date(preview.timestamp).toLocaleString() : '';
        info.textContent = `版本 ${previews.length - state.index} / ${previews.length}${date ? ` · ${date}` : ''}`;
        useBtn.hidden = typeof options.onUse !== 'function' || state.index === state.selectedIndex;
    }

    function go(delta) {
        const next = state.index + delta;
        if (next < 0 || next >= previews.length) return false;
        state.index = next;
        closeMenu();
        resetZoom();
        render();
        return true;
    }

    async function save() {
        const preview = previews[state.index];
        if (!controller.canSave || !preview || preview.savedUrl || state.busy) return null;
        state.busy = true;
        try {
            const url = await options.onSave(preview, state.index);
            if (url) preview.savedUrl = url;
            return url || null;
        } catch (error) {
            options.onError ? options.onError(error, 'save') : console.error('[XBDrawLightbox] 保存失败:', error);
            return null;
        } finally {
            state.busy = false;
            if (current === controller) render();
        }
    }

    async function download() {
        const preview = previews[state.index];
        if (!preview) return null;
        try {
            return options.onDownload
                ? await options.onDownload(preview, state.index)
                : await downloadImageOriginal(preview, { doc });
        } catch (error) {
            options.onError ? options.onError(error, 'download') : console.error('[XBDrawLightbox] 下载失败:', error);
            return null;
        }
    }

    function openMenuAt(x, y) {
        return menu.openAt(x, y, buildContext());
    }

    function closeMenu() {
        return menu.close();
    }

    function toggleAt(x, y) {
        if (isZoomed()) resetZoom({ animate: true });
        else zoomTo(LIGHTBOX_ZOOM.doubleTap, x, y, { animate: true });
        return view.scale;
    }

    // 缩放监听在捕获阶段先跑，手势识别（单击 / 双击 / 长按 / 横滑）在冒泡阶段。
    wrap.addEventListener('pointerdown', onZoomPointerDown, true);
    wrap.addEventListener('pointermove', onZoomPointerMove, { capture: true, passive: false });
    wrap.addEventListener('pointerup', onZoomPointerEnd, true);
    wrap.addEventListener('pointercancel', onZoomPointerEnd, true);
    overlay.addEventListener('wheel', onWheel, { passive: false });
    overlay.addEventListener('gesturestart', preventNative);
    overlay.addEventListener('gesturechange', preventNative);
    overlay.addEventListener('touchmove', preventNative, { passive: false });
    overlay.addEventListener('dblclick', preventNative);

    const gestures = bindGestures(wrap, {
        onSwipe: ({ direction }) => {
            // 放大时横滑是平移；只在适应大小时切版本。手指右往左 = 更新的一张；左往右 = 更旧的一张
            if (isZoomed() || gestureBlocked()) return;
            if (direction === 'left') go(-1);
            else if (direction === 'right') go(1);
        },
        onLongPress: ({ x, y }) => { if (!gestureBlocked()) openMenuAt(x, y); },
        onDoubleTap: ({ x, y }) => { if (!gestureBlocked()) { closeMenu(); toggleAt(x, y); } },
        onTap: () => closeMenu(),
    }, { preventContextMenu: 'always' });

    const onContextMenu = (event) => {
        event.preventDefault();
        if (!menu.isOpen()) openMenuAt(event.clientX, event.clientY);
    };
    wrap.addEventListener('contextmenu', onContextMenu);

    closeBtn.addEventListener('click', (event) => { event.stopPropagation(); closeImageLightbox(); });
    olderBtn.addEventListener('click', (event) => { event.stopPropagation(); go(1); });
    newerBtn.addEventListener('click', (event) => { event.stopPropagation(); go(-1); });
    useBtn.addEventListener('click', async (event) => {
        event.stopPropagation();
        const index = state.index;
        try {
            await options.onUse?.(previews[index], index);
            state.selectedIndex = index;
            render();
        } catch (error) {
            options.onError ? options.onError(error, 'use') : console.error('[XBDrawLightbox] 设为显示失败:', error);
        }
    });

    overlay.addEventListener('click', (event) => {
        if (menu.element.contains(event.target)) return;
        // 先关面板，再关灯箱
        if (menu.isOpen()) { closeMenu(); return; }
        if (event.target === overlay || event.target === stage || event.target === bar) closeImageLightbox();
    });

    const onKeyDown = (event) => {
        if (current !== controller) return;
        if (event.key === 'Escape') {
            event.preventDefault();
            if (menu.isOpen()) closeMenu();
            else closeImageLightbox();
        } else if (event.key === 'ArrowLeft') {
            go(1);
        } else if (event.key === 'ArrowRight') {
            go(-1);
        }
    };
    doc.addEventListener('keydown', onKeyDown, true);

    const view$ = doc.defaultView || globalThis;
    const onResize = () => applyView();
    view$.addEventListener?.('resize', onResize);

    controller._teardown = () => {
        gestures.destroy();
        wrap.removeEventListener('contextmenu', onContextMenu);
        doc.removeEventListener('keydown', onKeyDown, true);
        view$.removeEventListener?.('resize', onResize);
        menu.destroy();
        overlay.remove();
        try { options.onClose?.(); } catch { }
    };

    current = controller;
    render();
    resetZoom();
    overlay.classList.add('visible');
    return controller;
}

export function closeImageLightbox() {
    const active = current;
    if (!active) return false;
    current = null;
    active._teardown?.();
    return true;
}

export function getActiveLightbox() {
    return current;
}
