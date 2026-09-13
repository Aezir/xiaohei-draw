// xb-theme.js
// 小黑生图的主题色（唯一来源）。JS 注入的样式（对话框、聊天图片卡、宿主下拉、灯箱、云端预设、toast、提示词高亮）都从这里取；
// 设置页 iframe（novel-draw.html）用同值的 CSS 变量 --accent / --accent-hover / --accent-soft。
// 对比度（WCAG）：accent 文字在 #202020 上 ≈ 6.7；#1a1a1a 文字在 accent 上 ≈ 7.2；accent 文字在 soft 底（叠在 #202020）上 ≈ 5.1。

export const XB_ACCENT = '#e889b0';
export const XB_ACCENT_HOVER = '#f0a3c3';
export const XB_ACCENT_RGB = '232, 137, 176';
export const XB_ON_ACCENT = '#1a1a1a';

/** 主题色半透明底：alpha 默认 0.16（选中项 / 次级主按钮底色），0.26 用于 hover。 */
export function xbAccentSoft(alpha = 0.16) {
    return `rgba(${XB_ACCENT_RGB}, ${alpha})`;
}
