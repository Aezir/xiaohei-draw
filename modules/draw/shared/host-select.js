// host-select.js
// 把自绘下拉（providers/novelai/ui/nd-select.js）加载进酒馆主页面，只接管 XBDraw 自己的界面：
// 扩展设置抽屉、楼层/悬浮画图面板、聊天图片卡、灯箱、云端预设弹窗，以及带 data-xbdraw-ui 的容器。
// 酒馆本体和其他扩展的 select 一律不碰（nd-select 读 window.NdSelectConfig.scope 过滤）。
// 原生 select 仍是数据源；选中后照常派发 input + change，原有 jQuery 监听不用改。

import { ensureRemixIcon } from './remixicon-loader.js';
import { XB_ACCENT, xbAccentSoft } from './xb-theme.js';

export const XBDRAW_SELECT_SCOPE = [
    '.xbdraw-settings',
    '.nd-float',
    '.xb-nd-img',
    '#nd-gallery-overlay',
    '.cloud-presets-overlay',
    '[data-xbdraw-ui]',
].join(', ');

export const ND_SELECT_SCRIPT_URL = new URL('../providers/novelai/ui/nd-select.js?v=20260913c', import.meta.url).href;
const STYLE_ID = 'xbdraw-nd-select-host';
const SCRIPT_ID = 'xbdraw-nd-select-script';

const HOST_CSS = `
.nd-select-native {
    position: absolute !important; opacity: 0 !important; pointer-events: none !important;
    width: 1px !important; height: 1px !important; min-height: 0 !important; min-width: 0 !important;
    padding: 0 !important; margin: 0 !important; clip-path: inset(50%) !important; overflow: hidden !important;
}
button.nd-select-trigger {
    position: relative; display: flex; align-items: center; box-sizing: border-box; width: 100%;
    min-height: 30px; margin: 0; padding: 4px 26px 4px 9px; text-align: left;
    background: #2e2e2e !important; color: #e6e6e4 !important;
    border: 0 !important; border-radius: 6px; outline: none !important; box-shadow: none !important;
    font: inherit; font-size: 13px; line-height: 1.3; cursor: pointer; transition: background 0.12s; filter: none;
}
button.nd-select-trigger:hover { background: #333333 !important; }
button.nd-select-trigger:focus-visible, button.nd-select-trigger.is-open { background: #383838 !important; }
button.nd-select-trigger:disabled { opacity: 0.45; cursor: not-allowed; }
button.nd-select-trigger.hidden { display: none !important; }
.nd-select-trigger .nd-select-text { flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.nd-select-trigger .nd-select-text.is-empty { color: #6b6b68; }
.nd-select-trigger .nd-select-arrow {
    position: absolute; right: 6px; top: 50%; font-size: 16px; line-height: 1; color: #9b9b98;
    transform: translateY(-50%); transition: transform 0.15s;
}
.nd-select-trigger.is-open .nd-select-arrow { transform: translateY(-50%) rotate(180deg); }
#nd-select-layer {
    position: fixed; z-index: 100010; display: flex; flex-direction: column; box-sizing: border-box;
    max-height: 320px; padding: 4px; overflow: hidden; border-radius: 8px;
    background: #323232; color: #e6e6e4; font-size: 13px; text-align: left;
}
#nd-select-layer, #nd-select-layer *, #nd-select-layer *::before, #nd-select-layer *::after { border-style: none !important; outline-style: none !important; box-shadow: none !important; }
#nd-select-layer[hidden] { display: none !important; }
#nd-select-layer .nd-select-filter {
    flex: 0 0 auto; box-sizing: border-box; width: 100%; min-height: 28px; margin: 0 0 4px; padding: 4px 8px;
    border-radius: 6px; background: #2e2e2e; color: #e6e6e4; font: inherit; font-size: 12px;
}
#nd-select-layer .nd-select-list { flex: 1 1 auto; overflow-y: auto; overscroll-behavior: contain; }
#nd-select-layer .nd-select-option {
    display: flex; align-items: center; gap: 6px; min-height: 28px; padding: 4px 8px;
    border-radius: 4px; font-size: 13px; color: #e6e6e4; cursor: pointer;
}
#nd-select-layer .nd-select-option > span { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
#nd-select-layer .nd-select-option.is-active, #nd-select-layer .nd-select-option:hover { background: #3d3d3d; }
#nd-select-layer .nd-select-option[aria-selected="true"] { background: ${xbAccentSoft(0.16)}; color: ${XB_ACCENT}; }
#nd-select-layer .nd-select-option[aria-selected="true"].is-active { background: ${xbAccentSoft(0.26)}; }
#nd-select-layer .nd-select-option[aria-disabled="true"] { color: #6b6b68; cursor: not-allowed; background: transparent; }
#nd-select-layer .nd-select-group { font-size: 11px; color: #6b6b68; padding: 6px 8px 2px; }
#nd-select-layer .nd-select-empty { font-size: 12px; color: #6b6b68; padding: 8px; }
@media (pointer: coarse) {
    #nd-select-layer .nd-select-option { min-height: 40px; font-size: 14px; }
    #nd-select-layer .nd-select-filter { min-height: 36px; font-size: 14px; }
}
.xbdraw-settings button.nd-select-trigger { flex: 0 1 auto; width: auto; min-width: 110px; max-width: 9rem; }
`;

let loading = null;

function ensureHostSelectStyles(doc) {
    if (doc.getElementById(STYLE_ID)) return;
    const style = doc.createElement('style');
    style.id = STYLE_ID;
    style.textContent = HOST_CSS;
    doc.head.appendChild(style);
}

/** 幂等：样式、脚本都只注入一次；已加载时顺手重扫一遍 XBDraw 容器。 */
export function ensureHostSelects(doc = globalThis.document) {
    if (!doc?.head) return Promise.resolve(null);
    const win = doc.defaultView || globalThis;
    ensureRemixIcon(doc);
    ensureHostSelectStyles(doc);
    if (win.NdSelect) {
        win.NdSelect.enhanceAll(doc);
        return Promise.resolve(win.NdSelect);
    }
    if (loading) return loading;
    win.NdSelectConfig = { ...(win.NdSelectConfig || {}), scope: XBDRAW_SELECT_SCOPE };
    loading = new Promise((resolve, reject) => {
        const script = doc.createElement('script');
        script.id = SCRIPT_ID;
        script.src = ND_SELECT_SCRIPT_URL;
        script.onload = () => resolve(win.NdSelect || null);
        script.onerror = () => {
            loading = null;
            script.remove();
            reject(new Error('XBDraw 自绘下拉脚本加载失败'));
        };
        doc.head.appendChild(script);
    });
    return loading;
}

/** 调试 / 验收用：列出主页面里已被接管的 select。 */
export function listEnhancedHostSelects(doc = globalThis.document) {
    return Array.from(doc.querySelectorAll('select.nd-select-native')).map(sel => ({
        id: sel.id || '',
        className: Array.from(sel.classList).filter(c => c !== 'nd-select-native').join(' '),
        container: sel.closest(XBDRAW_SELECT_SCOPE)?.className || sel.closest(XBDRAW_SELECT_SCOPE)?.id || '',
    }));
}
