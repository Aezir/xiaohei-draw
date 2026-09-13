// remixicon-loader.js
// 向当前文档（酒馆主页面）注入一次本地 Remix Icon 样式表。聊天图片卡、灯箱、悬浮球、云端预设弹窗共用。
// 路径按本文件位置解析，独立页面（harness）和酒馆里都能用。

export const REMIXICON_LINK_ID = 'xbdraw-remixicon';
export const REMIXICON_CSS_URL = new URL('../../../assets/remixicon/remixicon.css', import.meta.url).href;

export function ensureRemixIcon(doc = globalThis.document) {
    if (!doc?.head) return null;
    const existing = doc.getElementById(REMIXICON_LINK_ID);
    if (existing) return existing;
    const link = doc.createElement('link');
    link.id = REMIXICON_LINK_ID;
    link.rel = 'stylesheet';
    link.href = REMIXICON_CSS_URL;
    doc.head.appendChild(link);
    return link;
}
