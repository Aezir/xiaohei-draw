// nai-prompt-highlight.js
// NAI 提示词输入框的语法高亮（设置页 iframe 和酒馆主页面共用）。
// 分词 / 上色函数是从 nai-gallery 原样拷贝的 vendor/prompt-highlight.js（hlPrompt），这里只做输入框叠层的 DOM 接线：
//   textarea 文字透明、只留光标；上面盖一层同字体 / 同内边距 / 同换行规则的 <pre>（pointer-events: none）上色，滚动同步。
//   上色只改颜色和背景，不改粗细、字号、字距（否则两层字宽不同，光标会错位）。
// 不 import 酒馆模块，harness 和 node 测试都能直接用。

import { hlPrompt } from './gallery-sync/vendor/prompt-highlight.js';

export const PROMPT_HL_STYLE_ID = 'xbdraw-prompt-hl-styles';

// 配色：Notion 暗色，刻意避开主题粉色，免得和选中态混淆。
export const PROMPT_HL_PALETTE = Object.freeze({
    text: '#e6e6e4',      // 普通 tag
    weight: '#f2a766',    // 1.2:: / :: / (tag:1.2) 里的数字
    comma: '#6f6f6c',     // , ，
    pipe: '#5ec8d0',      // | 角色分隔
    artistPrefix: '#8f8f8c',
    artistName: '#7fd4c1',
    paren: '#9b9b98',     // ( )
    repeat: '#6f6f6c',    // (x 127x)
    brace1: '#7aa7ff',    // {} [] 第 1 / 2 / 3 层
    brace2: '#5cc98f',
    brace3: '#c49cf5',
    error: '#ff6b6b',     // 未配对括号、多余 ::（波浪下划线，不占宽度）
    warn: '#ffc94d',
    placeholder: '#6b6b68',
});

const P = PROMPT_HL_PALETTE;
export const PROMPT_HL_CSS = `
.xbhl-wrap { position: relative; display: block; min-width: 0; }
.xbhl-wrap > textarea.xbhl-ta { color: transparent !important; -webkit-text-fill-color: transparent !important; caret-color: ${P.text} !important; white-space: pre-wrap !important; overflow-wrap: break-word !important; word-break: normal !important; }
.xbhl-wrap > textarea.xbhl-ta::placeholder { color: ${P.placeholder} !important; -webkit-text-fill-color: ${P.placeholder} !important; }
.xbhl-wrap > textarea.xbhl-ta::selection { background: rgba(122, 167, 255, 0.32); }
.xbhl-pre { position: absolute; top: 0; left: 0; z-index: 1; box-sizing: border-box; margin: 0; overflow: hidden; pointer-events: none; user-select: none; -webkit-user-select: none; background: transparent !important; border-style: none !important; outline-style: none !important; box-shadow: none !important; color: ${P.text}; white-space: pre-wrap; overflow-wrap: break-word; word-break: normal; font-variant-ligatures: none; }
.xbhl-ta { font-variant-ligatures: none; }
.xbhl-pre span { font: inherit; letter-spacing: inherit; }
.xbhl-pre .wb { border-radius: 3px; }
.xbhl-pre .hw { color: ${P.weight}; }
.xbhl-pre .hc { color: ${P.comma}; }
.xbhl-pre .hp { color: ${P.pipe}; }
.xbhl-pre .hap { color: ${P.artistPrefix}; }
.xbhl-pre .han { color: ${P.artistName}; }
.xbhl-pre .hb { color: ${P.paren}; }
.xbhl-pre .hx { color: ${P.repeat}; }
.xbhl-pre .hbr.d1 { color: ${P.brace1}; }
.xbhl-pre .hbr.d2 { color: ${P.brace2}; }
.xbhl-pre .hbr.d3 { color: ${P.brace3}; }
.xbhl-pre .herr { text-decoration: underline wavy ${P.error}; text-decoration-skip-ink: none; text-underline-offset: 3px; }
.xbhl-pre .hwarn { text-decoration: underline wavy ${P.warn}; text-decoration-skip-ink: none; text-underline-offset: 3px; }
`;

/** 纯函数：提示词 → 高亮 HTML（和画廊网站同一套分词）。 */
export function highlightPromptHtml(text) {
    return hlPrompt(String(text ?? '')).html;
}

/** 纯函数：语法问题列表（多余 ::、括号没配对……）。 */
export function promptIssues(text) {
    return hlPrompt(String(text ?? '')).issues;
}

/** 测试用：高亮 HTML 去标签、反转义，应与原文一字不差。 */
export function stripHighlightHtml(html) {
    return String(html).replace(/<[^>]*>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

export function ensurePromptHighlightStyles(doc = globalThis.document) {
    if (!doc?.head || doc.getElementById(PROMPT_HL_STYLE_ID)) return;
    const style = doc.createElement('style');
    style.id = PROMPT_HL_STYLE_ID;
    style.textContent = PROMPT_HL_CSS;
    doc.head.appendChild(style);
}

// 两层必须一致的排版属性（边框宽度折进内边距，<pre> 自己没有边框）。
const COPY_PROPS = ['fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'fontStretch', 'lineHeight', 'letterSpacing', 'wordSpacing',
    'textTransform', 'textIndent', 'textAlign', 'tabSize', 'direction'];

const controllers = new WeakMap();

/**
 * 给一个 textarea 加高亮叠层。重复调用返回同一个控制器。
 * 返回 { refresh(), detach() }。程序里直接赋值 textarea.value（含 jQuery .val()）也会自动重画。
 */
export function attachPromptHighlight(textarea) {
    if (!textarea || textarea.tagName !== 'TEXTAREA') return null;
    if (controllers.has(textarea)) return controllers.get(textarea);
    const doc = textarea.ownerDocument;
    const win = doc.defaultView;
    ensurePromptHighlightStyles(doc);

    const wrap = doc.createElement('div');
    wrap.className = 'xbhl-wrap';
    textarea.parentNode.insertBefore(wrap, textarea);
    wrap.appendChild(textarea);
    const pre = doc.createElement('pre');
    pre.className = 'xbhl-pre';
    pre.setAttribute('aria-hidden', 'true');
    wrap.appendChild(pre);
    textarea.classList.add('xbhl-ta');

    let lastText = null;
    const paint = () => {
        const text = textarea.value;
        if (text !== lastText) {
            lastText = text;
            // 只拼接 hlPrompt 转义过的文本；末尾补一个换行，最后一行是空行时两层高度才一致。
            pre.innerHTML = highlightPromptHtml(text) + '\n';
        }
    };
    const layout = () => {
        const cs = win.getComputedStyle(textarea);
        for (const prop of COPY_PROPS) pre.style[prop] = cs[prop];
        const bt = parseFloat(cs.borderTopWidth) || 0;
        const br = parseFloat(cs.borderRightWidth) || 0;
        const bb = parseFloat(cs.borderBottomWidth) || 0;
        const bl = parseFloat(cs.borderLeftWidth) || 0;
        // 出现竖向滚动条时，textarea 的内容区变窄，<pre> 右侧补同样的宽度，换行位置才一致。
        const scrollbar = Math.max(0, textarea.offsetWidth - textarea.clientWidth - bl - br);
        pre.style.paddingTop = `${(parseFloat(cs.paddingTop) || 0) + bt}px`;
        pre.style.paddingBottom = `${(parseFloat(cs.paddingBottom) || 0) + bb}px`;
        pre.style.paddingLeft = `${(parseFloat(cs.paddingLeft) || 0) + bl}px`;
        pre.style.paddingRight = `${(parseFloat(cs.paddingRight) || 0) + br + scrollbar}px`;
        pre.style.top = `${textarea.offsetTop}px`;
        pre.style.left = `${textarea.offsetLeft}px`;
        pre.style.width = `${textarea.offsetWidth}px`;
        pre.style.height = `${textarea.offsetHeight}px`;
        pre.style.borderRadius = cs.borderRadius;
        pre.scrollTop = textarea.scrollTop;
    };
    const refresh = () => { paint(); layout(); };
    const onScroll = () => { pre.scrollTop = textarea.scrollTop; };

    textarea.addEventListener('input', refresh);
    textarea.addEventListener('scroll', onScroll);
    textarea.addEventListener('focus', layout);
    textarea.addEventListener('blur', layout);

    // 程序赋值（textarea.value = x / jQuery .val(x)）不触发 input 事件：在实例上包一层 setter。
    const proto = Object.getOwnPropertyDescriptor(win.HTMLTextAreaElement.prototype, 'value');
    Object.defineProperty(textarea, 'value', {
        configurable: true,
        enumerable: true,
        get() { return proto.get.call(this); },
        set(v) { proto.set.call(this, v); refresh(); },
    });

    const ro = typeof win.ResizeObserver === 'function' ? new win.ResizeObserver(() => layout()) : null;
    ro?.observe(textarea);
    doc.fonts?.ready?.then(layout).catch(() => {});

    const controller = {
        textarea,
        pre,
        refresh,
        detach() {
            ro?.disconnect();
            textarea.removeEventListener('input', refresh);
            textarea.removeEventListener('scroll', onScroll);
            textarea.removeEventListener('focus', layout);
            textarea.removeEventListener('blur', layout);
            delete textarea.value;
            textarea.classList.remove('xbhl-ta');
            if (wrap.parentNode) wrap.parentNode.insertBefore(textarea, wrap);
            wrap.remove();
            controllers.delete(textarea);
        },
    };
    controllers.set(textarea, controller);
    refresh();
    return controller;
}

/** 给 root 下所有匹配的 textarea 加高亮，并监听之后插入的（设置页的角色编辑表单是模板字符串动态渲染的）。 */
export function autoAttachPromptHighlight(root, selector) {
    const scan = (node) => {
        if (!node || node.nodeType !== 1) return;
        if (node.matches?.(selector)) attachPromptHighlight(node);
        node.querySelectorAll?.(selector).forEach(attachPromptHighlight);
    };
    const base = root?.nodeType === 9 ? root.documentElement : root;
    scan(base);
    const win = (root?.nodeType === 9 ? root : root?.ownerDocument)?.defaultView;
    if (!win?.MutationObserver) return null;
    const mo = new win.MutationObserver((records) => {
        for (const record of records) record.addedNodes.forEach(scan);
    });
    mo.observe(base, { childList: true, subtree: true });
    return mo;
}
