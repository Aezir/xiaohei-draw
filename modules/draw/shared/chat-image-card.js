// chat-image-card.js
// 聊天消息里的图片卡：唯一的渲染器（原先 novel-draw.js 和 draw-common.js 各有一份）。
// - 真实图片卡（preview / saved / saving / refreshing）：没有任何按钮，操作全靠手势（见 chat-image-gestures.js）。
// - 失败 / 等待占位卡：保留「重新生成 / 编辑提示词 / 移除」按钮。
// - 外观：Notion 暗色，零边线零阴影，层级只靠底色；图标用 Remix Icon。
// 本文件不 import 酒馆模块，独立页面（harness）也能直接用。
// 数据格式不变：data-slot-id / data-img-id / data-tags / data-mesid 等属性，老聊天（含 LittleWhiteBox 生成的图）照常渲染。

import { ensureRemixIcon } from './remixicon-loader.js';
import { attachPromptHighlight, ensurePromptHighlightStyles } from './nai-prompt-highlight.js';
import { XB_ACCENT, XB_ACCENT_HOVER, XB_ON_ACCENT, xbAccentSoft } from './xb-theme.js';

// 编辑提示词窗口和设置页用同一套字体（设置页 body 字体栈）。
const UI_FONT = "Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Noto Sans SC', 'PingFang SC', 'Microsoft YaHei', sans-serif";

export const ImageState = Object.freeze({
    PREVIEW: 'preview',
    SAVING: 'saving',
    SAVED: 'saved',
    REFRESHING: 'refreshing',
    FAILED: 'failed',
});

export const CHAT_IMAGE_STYLE_ID = 'xbdraw-chat-image-styles';

// 酒馆的消息滑动（swiped-events.js）只检查 e.target 本身，所以卡片里每个可能被按到的元素都要带上。
const SWIPE_IGNORE = 'data-swipe-ignore="true"';

export function escapeHtml(str) {
    return String(str ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

const CHAT_IMAGE_CSS = `
.xb-nd-img, .xb-nd-img *, .xb-nd-img *::before, .xb-nd-img *::after { border-style: none !important; outline-style: none !important; box-shadow: none !important; }
.xb-nd-img { position: relative; display: block; box-sizing: border-box; width: fit-content; max-width: 100%; margin: 0.8em auto; padding: 0; border-radius: 9px; background: transparent; color: inherit; text-align: center; font-size: 13px; line-height: 1.4; }
.xb-nd-img[data-state="failed"], .xb-nd-img[data-state="pending"] { width: 100%; padding: 12px; border-radius: 12px; background: rgba(128, 128, 128, 0.14); color: var(--SmartThemeBodyColor, inherit); }
.xb-nd-img.editing { width: 100%; }
.xb-nd-img-wrap { position: relative; width: fit-content; max-width: 100%; margin: 0 auto; overflow: hidden; border-radius: 9px; cursor: pointer; touch-action: pan-y pinch-zoom; -webkit-touch-callout: none; -webkit-user-select: none; user-select: none; -webkit-tap-highlight-color: transparent; }
.xb-nd-img-wrap img { display: block; width: auto; height: auto; max-width: 100%; margin: 0; border-radius: 9px; -webkit-user-drag: none; -webkit-user-select: none; user-select: none; -webkit-touch-callout: none; touch-action: pan-y pinch-zoom; transition: opacity 0.2s ease; }
.xb-nd-img.busy .xb-nd-img-wrap img { opacity: 0.5; }
.xb-nd-img-wrap img.sliding-left { animation: ndSlideOutLeft 0.22s ease forwards; }
.xb-nd-img-wrap img.sliding-right { animation: ndSlideOutRight 0.22s ease forwards; }
.xb-nd-img-wrap img.sliding-in-left { animation: ndSlideInLeft 0.22s ease forwards; }
.xb-nd-img-wrap img.sliding-in-right { animation: ndSlideInRight 0.22s ease forwards; }
@keyframes ndSlideOutLeft { from { transform: translateX(0); opacity: 1; } to { transform: translateX(-30%); opacity: 0; } }
@keyframes ndSlideOutRight { from { transform: translateX(0); opacity: 1; } to { transform: translateX(30%); opacity: 0; } }
@keyframes ndSlideInLeft { from { transform: translateX(30%); opacity: 0; } to { transform: translateX(0); opacity: 1; } }
@keyframes ndSlideInRight { from { transform: translateX(-30%); opacity: 0; } to { transform: translateX(0); opacity: 1; } }
.xb-nd-pos { position: absolute; left: 50%; bottom: 10px; z-index: 2; padding: 2px 9px; border-radius: 999px; background: rgba(25, 25, 25, 0.62); color: #f2f2f0; font-size: 11px; line-height: 1.5; font-variant-numeric: tabular-nums; white-space: nowrap; transform: translateX(-50%); opacity: 0; transition: opacity 0.2s ease; pointer-events: none; }
.xb-nd-pos.show { opacity: 1; }
.xb-nd-indicator { position: absolute; top: 50%; left: 50%; z-index: 3; display: inline-flex; align-items: center; gap: 6px; padding: 6px 12px; border-radius: 8px; background: rgba(25, 25, 25, 0.88); color: #e6e6e4; font-size: 12px; white-space: nowrap; transform: translate(-50%, -50%); pointer-events: none; }
.xb-nd-indicator.xb-nd-busy-inline { position: static; transform: none; background: transparent; color: inherit; }
.xb-nd-indicator i { font-size: 15px; line-height: 1; }
.xb-nd-spin { display: inline-block; animation: xbNdSpin 1s linear infinite; }
@keyframes xbNdSpin { to { transform: rotate(360deg); } }
.xb-nd-failed-head { display: flex; align-items: center; justify-content: center; gap: 6px; font-size: 13px; font-weight: 500; color: inherit; }
.xb-nd-failed-head i { font-size: 16px; color: #e5534b; }
.xb-nd-failed-desc { margin: 4px 0 10px; font-size: 12px; color: inherit; opacity: 0.72; }
.xb-nd-failed-btns { display: flex; flex-wrap: wrap; justify-content: center; gap: 6px; }
.xb-nd-failed-btns[hidden] { display: none !important; }
.xb-nd-btn { display: inline-flex; align-items: center; gap: 5px; min-height: 28px; margin: 0; padding: 4px 10px; border-radius: 6px; background: rgba(128, 128, 128, 0.18); color: inherit; font: inherit; font-size: 12px; line-height: 1.2; cursor: pointer; transition: background 0.12s; }
.xb-nd-btn i { font-size: 14px; line-height: 1; }
.xb-nd-btn:hover { background: rgba(128, 128, 128, 0.26); }
.xb-nd-btn:active { background: rgba(128, 128, 128, 0.32); }
.xb-nd-btn.primary { background: ${xbAccentSoft(0.18)}; color: ${XB_ACCENT_HOVER}; }
.xb-nd-btn.primary:hover { background: ${xbAccentSoft(0.26)}; }
.xb-nd-btn.danger { color: #e5534b; }
.xb-nd-btn.danger:hover { background: rgba(229, 83, 75, 0.14); }
.xb-nd-edit { margin-top: 6px; padding: 10px 12px; border-radius: 8px; background: #202020; text-align: left; font-family: ${UI_FONT}; font-size: 13px; line-height: 1.45; color: #e6e6e4; }
.xb-nd-edit[hidden] { display: none !important; }
.xb-nd-edit-title { display: flex; align-items: center; gap: 6px; margin-bottom: 8px; font-size: 12px; font-weight: 600; letter-spacing: 0.02em; color: #9b9b98; }
.xb-nd-edit-title i { font-size: 14px; line-height: 1; }
.xb-nd-edit-scroll { max-height: 320px; overflow-y: auto; overscroll-behavior: contain; }
.xb-nd-edit-group + .xb-nd-edit-group { margin-top: 6px; }
.xb-nd-edit-label { display: flex; align-items: center; gap: 4px; margin-bottom: 3px; font-size: 12px; font-weight: 500; color: #9b9b98; }
.xb-nd-edit-label i { font-size: 13px; line-height: 1; }
.xb-nd-edit-input { display: block; box-sizing: border-box; width: 100%; min-height: 60px; margin: 0; padding: 4px 8px; border-radius: 6px; background: #2e2e2e; color: #e6e6e4; font-family: ${UI_FONT}; font-size: 13px; font-weight: 400; line-height: 1.5; letter-spacing: normal; resize: vertical; transition: background 0.12s; }
.xb-nd-edit-input:hover { background: #333333; }
.xb-nd-edit-input:focus { background: #383838; }
.xb-nd-edit-actions { display: flex; justify-content: flex-end; gap: 6px; margin-top: 8px; }
.xb-nd-edit .xb-nd-btn { min-height: 28px; padding: 4px 10px; border-radius: 6px; background: #2a2a2a; color: #e6e6e4; font-family: ${UI_FONT}; font-size: 12px; }
.xb-nd-edit .xb-nd-btn:hover { background: #333333; }
.xb-nd-edit .xb-nd-btn.primary { background: ${XB_ACCENT}; color: ${XB_ON_ACCENT}; font-weight: 600; }
.xb-nd-edit .xb-nd-btn.primary:hover { background: ${XB_ACCENT_HOVER}; }
@media (pointer: coarse) { .xb-nd-btn { min-height: 36px; padding: 6px 12px; } }
`;

export function ensureChatImageStyles(doc = globalThis.document) {
    if (!doc?.head) return;
    ensureRemixIcon(doc);
    ensurePromptHighlightStyles(doc);
    if (doc.getElementById(CHAT_IMAGE_STYLE_ID)) return;
    const style = doc.createElement('style');
    style.id = CHAT_IMAGE_STYLE_ID;
    style.textContent = CHAT_IMAGE_CSS;
    doc.head.appendChild(style);
}

function toInt(value, fallback) {
    const n = Number.parseInt(value, 10);
    return Number.isFinite(n) ? n : fallback;
}

function normalizeHistory(currentIndex, historyCount) {
    const total = Math.max(1, toInt(historyCount, 1));
    const index = Math.min(total - 1, Math.max(0, toInt(currentIndex, 0)));
    return { index, total };
}

// 「第几版 / 共几版」：index 0 是最新的一张。卡面不常驻，只在切换版本时由 flashImageCardPosition 短暂显示。
export function formatImageVersion(currentIndex, historyCount) {
    const { index, total } = normalizeHistory(currentIndex, historyCount);
    return `${total - index} / ${total}`;
}

function indicatorHtml(state) {
    if (state === ImageState.SAVING) {
        return `<div class="xb-nd-indicator" ${SWIPE_IGNORE}><i class="ri-loader-4-line xb-nd-spin" aria-hidden="true"></i>保存中</div>`;
    }
    if (state === ImageState.REFRESHING) {
        return `<div class="xb-nd-indicator" ${SWIPE_IGNORE}><i class="ri-loader-4-line xb-nd-spin" aria-hidden="true"></i>生成中</div>`;
    }
    return '';
}

export function buildEditGroupsHtml({ tags = '', characterPrompts = [] } = {}) {
    let html = `<div class="xb-nd-edit-group">
    <div class="xb-nd-edit-label"><i class="ri-image-line" aria-hidden="true"></i>场景</div>
    <textarea class="xb-nd-edit-input" data-type="scene">${escapeHtml(tags)}</textarea>
</div>`;
    (Array.isArray(characterPrompts) ? characterPrompts : []).forEach((char, i) => {
        const name = char?.name || `角色 ${i + 1}`;
        html += `<div class="xb-nd-edit-group">
    <div class="xb-nd-edit-label"><i class="ri-user-line" aria-hidden="true"></i>${escapeHtml(name)}</div>
    <textarea class="xb-nd-edit-input" data-type="char" data-index="${i}">${escapeHtml(char?.prompt || '')}</textarea>
</div>`;
    });
    return html;
}

function editPanelHtml(tags, saveAction, saveLabel) {
    return `<div class="xb-nd-edit" hidden>
    <div class="xb-nd-edit-title"><i class="ri-edit-line" aria-hidden="true"></i>编辑提示词</div>
    <div class="xb-nd-edit-scroll">${buildEditGroupsHtml({ tags })}</div>
    <div class="xb-nd-edit-actions">
        <button type="button" class="xb-nd-btn" data-action="cancel-edit"><i class="ri-close-line" aria-hidden="true"></i>取消</button>
        <button type="button" class="xb-nd-btn primary" data-action="${saveAction}"><i class="ri-refresh-line" aria-hidden="true"></i>${saveLabel}</button>
    </div>
</div>`;
}

/** 真实图片卡：没有按钮，也没有常驻角标；卡面只有图片本身（无内边距、无底色）。 */
export function buildImageHtml({ slotId, imgId, url, tags, positive, messageId, state = ImageState.PREVIEW, historyCount = 1, currentIndex = 0 }) {
    const { index, total } = normalizeHistory(currentIndex, historyCount);
    const isBusy = state === ImageState.SAVING || state === ImageState.REFRESHING;
    const src = String(url || '');
    const lazyAttr = /^(data|blob):/i.test(src) ? '' : ' loading="lazy"';
    return `<div class="xb-nd-img${isBusy ? ' busy' : ''}" data-slot-id="${escapeHtml(slotId)}" data-img-id="${escapeHtml(imgId)}" data-tags="${escapeHtml(tags)}" data-positive="${escapeHtml(positive)}" data-mesid="${escapeHtml(messageId)}" data-state="${escapeHtml(state)}" data-current-index="${index}" data-history-count="${total}" ${SWIPE_IGNORE}>
<div class="xb-nd-img-wrap" ${SWIPE_IGNORE}><img src="${escapeHtml(src)}" alt="" draggable="false" ${SWIPE_IGNORE}${lazyAttr}>${indicatorHtml(state)}</div>
${editPanelHtml(tags, 'save-tags', '保存并重新生成')}
</div>`;
}

/** 失败占位卡：保留重试 / 编辑提示词 / 移除三个按钮。 */
export function buildFailedPlaceholderHtml({ slotId, messageId, tags, positive, errorType, errorMessage }) {
    return `<div class="xb-nd-img" data-slot-id="${escapeHtml(slotId)}" data-tags="${escapeHtml(tags)}" data-positive="${escapeHtml(positive)}" data-mesid="${escapeHtml(messageId)}" data-state="failed">
<div class="xb-nd-failed-head"><i class="ri-error-warning-line" aria-hidden="true"></i><span>${escapeHtml(errorType || '生成失败')}</span></div>
<div class="xb-nd-failed-desc">${escapeHtml(errorMessage || '可以重新生成')}</div>
<div class="xb-nd-failed-btns">
    <button type="button" class="xb-nd-btn primary" data-action="retry-image"><i class="ri-refresh-line" aria-hidden="true"></i>重新生成</button>
    <button type="button" class="xb-nd-btn" data-action="edit-tags"><i class="ri-edit-line" aria-hidden="true"></i>编辑提示词</button>
    <button type="button" class="xb-nd-btn danger" data-action="remove-placeholder"><i class="ri-close-line" aria-hidden="true"></i>移除</button>
</div>
${editPanelHtml(tags, 'save-tags-retry', '保存并重新生成')}
</div>`;
}

// 未完成槽位的统一占位卡。label 由调用方按真实状态给出，不伪造进度：
// chat 正文里只持久化 [image:slotId]，状态文案永远是运行时动态渲染的。
export function buildPendingImageHtml({ slotId, messageId, index = 0, total = 0, label = '等待生成' }) {
    const progress = total > 0 ? ` · ${Math.max(1, Number(index) || 1)} / ${total}` : '';
    return `<div class="xb-nd-img" data-slot-id="${escapeHtml(slotId)}" data-mesid="${escapeHtml(messageId)}" data-state="pending">
<div class="xb-nd-indicator xb-nd-busy-inline"><i class="ri-image-ai-line" aria-hidden="true"></i>${escapeHtml(label)}${progress}</div>
</div>`;
}

/** 占位卡重试时的临时内容。 */
export function buildBusyInnerHtml(label = '生成中') {
    return `<div class="xb-nd-indicator xb-nd-busy-inline"><i class="ri-loader-4-line xb-nd-spin" aria-hidden="true"></i>${escapeHtml(label)}</div>`;
}

export function setImageCardState(card, state) {
    if (!card) return;
    card.dataset.state = state;
    const busy = state === ImageState.SAVING || state === ImageState.REFRESHING;
    card.classList.toggle('busy', busy);
    card.querySelector('.xb-nd-indicator')?.remove();
    const html = indicatorHtml(state);
    if (html) (card.querySelector('.xb-nd-img-wrap') || card).insertAdjacentHTML('beforeend', html);
}

export const IMAGE_POSITION_FLASH_MS = 1200;

/** 切换版本后在图片上短暂显示「2 / 3」，约 1.2 秒后淡出并移除；只有一张时不显示。 */
export function flashImageCardPosition(card, { duration = IMAGE_POSITION_FLASH_MS } = {}) {
    const wrap = card?.querySelector?.('.xb-nd-img-wrap');
    if (!wrap) return null;
    const { index, total } = normalizeHistory(card.dataset.currentIndex, card.dataset.historyCount);
    let pill = wrap.querySelector('.xb-nd-pos');
    if (total <= 1) { pill?.remove(); return null; }
    const doc = card.ownerDocument || globalThis.document;
    if (!pill) {
        pill = doc.createElement('span');
        pill.className = 'xb-nd-pos';
        pill.setAttribute('aria-hidden', 'true');
        pill.setAttribute('data-swipe-ignore', 'true');
        wrap.appendChild(pill);
    }
    pill.textContent = formatImageVersion(index, total);
    clearTimeout(pill._xbHide);
    clearTimeout(pill._xbRemove);
    void pill.offsetWidth; // 先落一帧 opacity 0，淡入才有过渡
    pill.classList.add('show');
    pill._xbHide = setTimeout(() => {
        pill.classList.remove('show');
        pill._xbRemove = setTimeout(() => pill.remove(), 260);
    }, Math.max(0, duration));
    return pill;
}

/** 更新卡片记住的版本位置；flash 为真（默认）时短暂显示位置小胶囊。 */
export function updateImageCardHistory(card, currentIndex, historyCount, { flash = true } = {}) {
    if (!card) return;
    const { index, total } = normalizeHistory(currentIndex, historyCount);
    card.dataset.currentIndex = String(index);
    card.dataset.historyCount = String(total);
    if (flash) flashImageCardPosition(card);
}

/** 打开编辑面板（场景 + 各角色提示词）。数据由调用方传入。 */
export function openImageCardEditor(card, { tags, characterPrompts = [] } = {}) {
    const panel = card?.querySelector('.xb-nd-edit');
    if (!panel) return false;
    const scroll = panel.querySelector('.xb-nd-edit-scroll');
    if (scroll) {
        // 只拼接本地转义后的数据。
        // eslint-disable-next-line no-unsanitized/property
        scroll.innerHTML = buildEditGroupsHtml({ tags: tags ?? card.dataset.tags ?? '', characterPrompts });
    }
    panel.hidden = false;
    card.classList.add('editing');
    ensurePromptHighlightStyles(card.ownerDocument);
    panel.querySelectorAll('textarea.xb-nd-edit-input').forEach(attachPromptHighlight);
    const btns = card.querySelector('.xb-nd-failed-btns');
    if (btns) btns.hidden = true;
    try { scroll?.querySelector('[data-type="scene"]')?.focus({ preventScroll: true }); } catch { }
    return true;
}

export function closeImageCardEditor(card) {
    const panel = card?.querySelector('.xb-nd-edit');
    if (!panel) return false;
    panel.hidden = true;
    card.classList.remove('editing');
    const btns = card.querySelector('.xb-nd-failed-btns');
    if (btns) btns.hidden = false;
    const scroll = panel.querySelector('.xb-nd-edit-scroll');
    if (scroll) {
        // eslint-disable-next-line no-unsanitized/property
        scroll.innerHTML = buildEditGroupsHtml({ tags: card.dataset.tags || '' });
    }
    return true;
}
