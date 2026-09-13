// xb-dialog.js
// 页内对话框（替代 window.confirm / alert / prompt）。设置页 iframe 和酒馆主页面共用这一份。
// 为什么：部分内嵌浏览器（手机 App WebView 等）直接屏蔽原生对话框，按钮会「点了没反应」。
//
// 用法（全部返回 Promise）：
//   await xbConfirm('确定删除？', { danger: true })            → true / false
//   await xbAlert('导入失败')                                   → undefined
//   await xbPrompt('输入新名称：', '旧名')                       → 字符串 / null（取消）
//   await xbChoose('已有同来源的预设', [{value:'overwrite', label:'覆盖'}, ...], { cancelValue: 'cancel' })
//   await openXbDialog({ title, message, detail, body, buttons, cancelValue, input })
// 规则：Esc、点遮罩 = 最安全的选项（cancelValue）；Tab 焦点困在对话框里；关闭后焦点回到原来的元素。
// 样式：Notion 暗色，零边框零描边零阴影，只靠底色区分；Remix Icon；375px 宽能用。
// 不 import 酒馆模块。加载后同时挂到 window.XBDialog，给设置页里的普通 <script> 用。

import { ensureRemixIcon } from './remixicon-loader.js';
import { XB_ACCENT, XB_ACCENT_HOVER, XB_ON_ACCENT, xbAccentSoft } from './xb-theme.js';

export const XB_DIALOG_STYLE_ID = 'xb-dialog-styles';
const Z_BASE = 2147483600;
let openCount = 0;

const CSS = `
.xb-dlg-backdrop, .xb-dlg-backdrop *, .xb-dlg-backdrop *::before, .xb-dlg-backdrop *::after { box-sizing: border-box; border-style: none !important; outline-style: none !important; box-shadow: none !important; }
.xb-dlg-backdrop { position: fixed; inset: 0; display: flex; align-items: center; justify-content: center; padding: 12px; background: rgba(0, 0, 0, 0.62); font-family: Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Noto Sans SC', 'PingFang SC', 'Microsoft YaHei', sans-serif; font-size: 13px; line-height: 1.5; color: #e6e6e4; -webkit-tap-highlight-color: transparent; }
.xb-dlg { display: flex; flex-direction: column; gap: 10px; width: min(440px, 100%); max-height: calc(100vh - 24px); max-height: calc(100dvh - 24px); padding: 14px; border-radius: 10px; background: #202020; overflow: hidden; }
.xb-dlg-head { display: flex; align-items: flex-start; gap: 8px; }
.xb-dlg-head i { flex: 0 0 auto; font-size: 18px; line-height: 20px; color: #9b9b98; }
.xb-dlg-head.is-danger i { color: #e5534b; }
.xb-dlg-title { margin: 0; font-size: 14px; font-weight: 600; line-height: 20px; color: #e6e6e4; word-break: break-word; }
.xb-dlg-scroll { display: flex; flex-direction: column; gap: 8px; min-height: 0; overflow-y: auto; overscroll-behavior: contain; }
.xb-dlg-msg { margin: 0; white-space: pre-wrap; word-break: break-word; color: #e6e6e4; }
.xb-dlg-detail { margin: 0; white-space: pre-wrap; word-break: break-word; font-size: 12px; color: #9b9b98; }
.xb-dlg-input { width: 100%; min-height: 32px; margin: 0; padding: 5px 9px; border-radius: 6px; background: #2e2e2e; color: #e6e6e4; font: inherit; caret-color: ${XB_ACCENT}; transition: background 0.12s; }
.xb-dlg-input:hover { background: #333333; }
.xb-dlg-input:focus { background: ${xbAccentSoft(0.16)}; }
.xb-dlg-input::selection { background: ${xbAccentSoft(0.42)}; color: #ffffff; }
.xb-dlg-input.is-invalid { background: rgba(229, 83, 75, 0.16); }
.xb-dlg-hint { margin: -4px 0 0; font-size: 12px; color: #e5534b; }
.xb-dlg-hint[hidden] { display: none !important; }
.xb-dlg-actions { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 6px; }
.xb-dlg-btn { display: inline-flex; align-items: center; justify-content: center; gap: 4px; min-height: 30px; margin: 0; padding: 4px 12px; border-radius: 6px; background: #2a2a2a; color: #e6e6e4; font: inherit; font-size: 13px; cursor: pointer; white-space: nowrap; }
.xb-dlg-btn i { font-size: 15px; line-height: 1; }
.xb-dlg-btn:hover { background: #333333; }
.xb-dlg-btn:focus-visible { background: #3d3d3d; }
.xb-dlg-btn.is-primary { background: ${XB_ACCENT}; color: ${XB_ON_ACCENT}; font-weight: 600; }
.xb-dlg-btn.is-primary:hover, .xb-dlg-btn.is-primary:focus-visible { background: ${XB_ACCENT_HOVER}; }
.xb-dlg-btn.is-danger { background: rgba(229, 83, 75, 0.16); color: #e5534b; font-weight: 600; }
.xb-dlg-btn.is-danger:hover, .xb-dlg-btn.is-danger:focus-visible { background: rgba(229, 83, 75, 0.26); }
.xb-dlg-kv { display: grid; grid-template-columns: minmax(72px, auto) minmax(0, 1fr); gap: 2px 8px; padding: 6px 8px; border-radius: 6px; background: #2a2a2a; font-size: 12px; }
.xb-dlg-kv > span:nth-child(odd) { color: #9b9b98; word-break: break-all; }
.xb-dlg-kv > span:nth-child(even) { color: #e6e6e4; word-break: break-word; }
.xb-dlg-check { display: flex; align-items: center; gap: 6px; font-size: 13px; cursor: pointer; }
.xb-dlg-check input { width: 14px; height: 14px; margin: 0; accent-color: ${XB_ACCENT}; }
@media (max-width: 480px) {
    .xb-dlg { padding: 12px; }
    .xb-dlg-actions { justify-content: stretch; }
    .xb-dlg-btn { flex: 1 1 0; min-height: 40px; font-size: 14px; }
}
`;

export function ensureXbDialogStyles(doc = globalThis.document) {
    if (!doc?.head) return;
    try { ensureRemixIcon(doc); } catch { /* 图标加载失败不影响对话框 */ }
    if (doc.getElementById(XB_DIALOG_STYLE_ID)) return;
    const style = doc.createElement('style');
    style.id = XB_DIALOG_STYLE_ID;
    style.textContent = CSS;
    doc.head.appendChild(style);
}

const FOCUSABLE = 'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])';

function el(doc, tag, className, text) {
    const node = doc.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = String(text);
    return node;
}

/**
 * @param {object} opts
 * @param {string} [opts.title]
 * @param {string} [opts.message]
 * @param {string} [opts.detail]         次要说明（小字）
 * @param {string} [opts.icon]           Remix 图标类名
 * @param {boolean} [opts.danger]
 * @param {Node|((doc: Document) => Node)} [opts.body]  自定义内容（勾选框、参数表……），关闭前可读
 * @param {{value?: string, placeholder?: string, maxLength?: number, validate?: (value: string) => string}} [opts.input]
 *        有它就是 prompt，确认时返回输入框文字；validate 返回非空文字 = 不关闭，在输入框下面显示这句提示
 * @param {Array<{value: any, label: string, kind?: 'primary'|'danger'|'plain', icon?: string}>} [opts.buttons]  从左到右
 * @param {any} [opts.cancelValue]       Esc / 点遮罩 / 没有按钮时的结果（最安全的选项）
 * @param {any} [opts.focusValue]        初始聚焦的按钮值（默认 = cancelValue 那个按钮；有输入框时聚焦输入框）
 * @param {Document} [opts.document]
 * @returns {Promise<any>}
 */
export function openXbDialog(opts = {}) {
    const doc = opts.document || globalThis.document;
    const cancelValue = opts.cancelValue;
    if (!doc?.body) return Promise.resolve(cancelValue);
    ensureXbDialogStyles(doc);
    const view = doc.defaultView || globalThis;
    const previousFocus = doc.activeElement;

    return new Promise((resolve) => {
        const backdrop = el(doc, 'div', 'xb-dlg-backdrop');
        backdrop.setAttribute('data-xbdraw-ui', '');
        backdrop.setAttribute('data-swipe-ignore', 'true');
        backdrop.style.zIndex = String(Z_BASE + (++openCount));
        const panel = el(doc, 'div', 'xb-dlg');
        panel.setAttribute('role', opts.buttons?.length > 1 || opts.input ? 'dialog' : 'alertdialog');
        panel.setAttribute('aria-modal', 'true');
        backdrop.appendChild(panel);

        if (opts.title) {
            const head = el(doc, 'div', `xb-dlg-head${opts.danger ? ' is-danger' : ''}`);
            const icon = el(doc, 'i', opts.icon || (opts.danger ? 'ri-error-warning-line' : 'ri-information-line'));
            icon.setAttribute('aria-hidden', 'true');
            const title = el(doc, 'h3', 'xb-dlg-title', opts.title);
            title.id = `xb-dlg-title-${openCount}`;
            panel.setAttribute('aria-labelledby', title.id);
            head.append(icon, title);
            panel.appendChild(head);
        }

        const scroll = el(doc, 'div', 'xb-dlg-scroll');
        if (opts.message) scroll.appendChild(el(doc, 'p', 'xb-dlg-msg', opts.message));
        if (opts.detail) scroll.appendChild(el(doc, 'p', 'xb-dlg-detail', opts.detail));
        if (!opts.title && opts.message) panel.setAttribute('aria-label', String(opts.message).slice(0, 80));
        const body = typeof opts.body === 'function' ? opts.body(doc) : opts.body;
        if (body) scroll.appendChild(body);
        let input = null;
        let hint = null;
        if (opts.input) {
            input = el(doc, 'input', 'xb-dlg-input');
            input.type = 'text';
            input.value = opts.input.value == null ? '' : String(opts.input.value);
            if (opts.input.placeholder) input.placeholder = opts.input.placeholder;
            if (opts.input.maxLength) input.maxLength = opts.input.maxLength;
            input.setAttribute('aria-label', opts.message || opts.title || '输入');
            scroll.appendChild(input);
            hint = el(doc, 'p', 'xb-dlg-hint');
            hint.setAttribute('role', 'alert');
            hint.hidden = true;
            scroll.appendChild(hint);
            input.addEventListener('input', () => {
                if (hint.hidden) return;
                hint.hidden = true;
                input.classList.remove('is-invalid');
                input.removeAttribute('aria-invalid');
            });
        }
        if (scroll.childNodes.length) panel.appendChild(scroll);

        const buttons = Array.isArray(opts.buttons) && opts.buttons.length ? opts.buttons : [{ value: cancelValue, label: '知道了', kind: 'primary' }];
        const actions = el(doc, 'div', 'xb-dlg-actions');
        const buttonEls = buttons.map((b) => {
            const btn = el(doc, 'button', `xb-dlg-btn${b.kind === 'primary' ? ' is-primary' : b.kind === 'danger' ? ' is-danger' : ''}`);
            btn.type = 'button';
            if (b.icon) { const i = el(doc, 'i', b.icon); i.setAttribute('aria-hidden', 'true'); btn.appendChild(i); }
            btn.appendChild(doc.createTextNode(b.label));
            btn.addEventListener('click', (event) => { event.stopPropagation(); finish(b.value); });
            actions.appendChild(btn);
            return btn;
        });
        panel.appendChild(actions);

        let done = false;
        function finish(value) {
            if (done) return;
            if (input && value !== cancelValue && typeof opts.input.validate === 'function') {
                let problem = '';
                try { problem = String(opts.input.validate(input.value) || ''); } catch (e) { problem = e?.message || '输入不正确'; }
                if (problem) {
                    hint.textContent = problem;
                    hint.hidden = false;
                    input.classList.add('is-invalid');
                    input.setAttribute('aria-invalid', 'true');
                    try { input.focus({ preventScroll: true }); input.select(); } catch { }
                    return;
                }
            }
            done = true;
            openCount = Math.max(0, openCount - 1);
            view.removeEventListener('keydown', onKey, true);
            const result = input && value !== cancelValue ? input.value : value;
            backdrop.remove();
            try { if (previousFocus && typeof previousFocus.focus === 'function' && previousFocus.isConnected) previousFocus.focus({ preventScroll: true }); } catch { }
            resolve(result);
        }

        function onKey(event) {
            if (!backdrop.isConnected) return;
            // 叠了好几层时只让最上面那层处理
            const layers = doc.querySelectorAll('.xb-dlg-backdrop');
            if (layers[layers.length - 1] !== backdrop) return;
            if (event.key === 'Escape') {
                event.preventDefault();
                event.stopImmediatePropagation();
                finish(cancelValue);
            } else if (event.key === 'Tab') {
                const items = [...panel.querySelectorAll(FOCUSABLE)].filter(n => n.getClientRects().length > 0);
                if (!items.length) { event.preventDefault(); return; }
                const first = items[0], last = items[items.length - 1];
                const active = doc.activeElement;
                if (!panel.contains(active)) { event.preventDefault(); first.focus(); }
                else if (event.shiftKey && active === first) { event.preventDefault(); last.focus(); }
                else if (!event.shiftKey && active === last) { event.preventDefault(); first.focus(); }
                event.stopImmediatePropagation();
            } else if (event.key === 'Enter' && input && doc.activeElement === input) {
                event.preventDefault();
                event.stopImmediatePropagation();
                const ok = buttons.find(b => b.kind === 'primary') || buttons[buttons.length - 1];
                finish(ok.value);
            } else {
                event.stopImmediatePropagation();   // 对话框打开时不把按键漏给底下的灯箱 / 设置页
            }
        }
        view.addEventListener('keydown', onKey, true);
        backdrop.addEventListener('pointerdown', (event) => { if (event.target === backdrop) backdrop.dataset.downOnBackdrop = '1'; });
        backdrop.addEventListener('click', (event) => {
            event.stopPropagation();
            if (event.target === backdrop && backdrop.dataset.downOnBackdrop === '1') finish(cancelValue);
            delete backdrop.dataset.downOnBackdrop;
        });

        doc.body.appendChild(backdrop);
        const focusValue = Object.prototype.hasOwnProperty.call(opts, 'focusValue') ? opts.focusValue : cancelValue;
        const focusIdx = buttons.findIndex(b => b.value === focusValue);
        const target = input || buttonEls[focusIdx >= 0 ? focusIdx : buttonEls.length - 1];
        try { target.focus({ preventScroll: true }); if (input) input.select(); } catch { }
    });
}

export function xbConfirm(message, { title, detail, okLabel = '确定', cancelLabel = '取消', danger = false, icon, body, document } = {}) {
    return openXbDialog({
        title: title || (danger ? '请确认' : '确认'),
        message, detail, icon, body, danger, document,
        cancelValue: false,
        buttons: [
            { value: false, label: cancelLabel, kind: 'plain' },
            { value: true, label: okLabel, kind: danger ? 'danger' : 'primary' },
        ],
    }).then(v => v === true);
}

export function xbAlert(message, { title = '提示', detail, icon, document, okLabel = '知道了' } = {}) {
    return openXbDialog({
        title, message, detail, icon, document,
        cancelValue: undefined,
        buttons: [{ value: undefined, label: okLabel, kind: 'primary' }],
    }).then(() => undefined);
}

export function xbPrompt(message, defaultValue = '', { title = '输入', detail, icon, placeholder, okLabel = '确定', cancelLabel = '取消', maxLength, validate, document } = {}) {
    return openXbDialog({
        title, message, detail, icon, document,
        input: { value: defaultValue, placeholder, maxLength, validate },
        cancelValue: null,
        buttons: [
            { value: null, label: cancelLabel, kind: 'plain' },
            { value: 'ok', label: okLabel, kind: 'primary' },
        ],
    });
}

/** 多选一。choices 从左到右；cancelValue 是 Esc / 遮罩的结果（应是最安全的那个）。 */
export function xbChoose(message, choices, { title = '请选择', detail, cancelValue = null, icon, body, document } = {}) {
    return openXbDialog({ title, message, detail, icon, body, document, cancelValue, buttons: choices });
}

if (typeof window !== 'undefined') {
    window.XBDialog = Object.freeze({ open: openXbDialog, confirm: xbConfirm, alert: xbAlert, prompt: xbPrompt, choose: xbChoose });
}
