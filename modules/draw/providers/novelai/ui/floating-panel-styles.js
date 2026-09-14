// floating-panel-styles.js
// 楼层按钮 / 悬浮球的样式（Notion 暗色，零边线零阴影）。单独成文件，harness 可以不经过酒馆模块直接引用。
export const FLOATING_PANEL_CSS = `
.nd-float, .nd-float *, .nd-float *::before, .nd-float *::after { border-style: none !important; outline-style: none !important; box-shadow: none !important; -webkit-tap-highlight-color: transparent; }
.nd-float {
    --nd-h: 34px;
    --nd-bg: #202020;
    --nd-bg-raise: #2a2a2a;
    --nd-bg-input: #2e2e2e;
    --nd-bg-hover: #333333;
    --nd-bg-active: #383838;
    --nd-text-primary: #e6e6e4;
    --nd-text-secondary: #9b9b98;
    --nd-text-muted: #6b6b68;
    --nd-success: #4dab6f;
    --nd-warning: #d29922;
    --nd-error: #e5534b;
    --nd-info: #60a5fa;
    position: relative;
    user-select: none;
    color: var(--nd-text-primary);
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
}
/* 全局悬浮球闲置变淡（类名由 float-idle-dim.js 切换） */
.nd-floating-global { transition: opacity 0.3s ease; }
.nd-floating-global.is-dim { opacity: 0.45; }

/* ── 胶囊 ── */
.nd-capsule {
    position: relative;
    width: 74px;
    height: var(--nd-h);
    overflow: hidden;
    border-radius: 17px;
    background: var(--nd-bg);
    transition: background 0.2s;
}
.nd-float:hover .nd-capsule { background: var(--nd-bg-raise); }
.nd-float.working .nd-capsule { background: #2e2228; }
.nd-float.cooldown .nd-capsule { background: #1f2a38; }
.nd-float.success .nd-capsule { background: #1f2e25; }
.nd-float.partial .nd-capsule { background: #302a1c; }
.nd-float.error .nd-capsule { background: #33211f; }

.nd-inner {
    display: grid;
    width: 100%;
    height: 100%;
    grid-template-areas: "s";
    grid-template-rows: minmax(0, 1fr);
    grid-template-columns: minmax(0, 1fr);
    pointer-events: none;
}
.nd-layer {
    grid-area: s;
    display: flex;
    align-items: center;
    width: 100%;
    height: 100%;
    min-width: 0;
    min-height: 0;
    pointer-events: auto;
    transition: opacity 0.2s, transform 0.2s;
}
.nd-layer-idle { opacity: 1; transform: translateY(0); }
.nd-float.working .nd-layer-idle,
.nd-float.cooldown .nd-layer-idle,
.nd-float.success .nd-layer-idle,
.nd-float.partial .nd-layer-idle,
.nd-float.error .nd-layer-idle { opacity: 0; transform: translateY(-100%); pointer-events: none; }

.nd-btn-draw {
    position: relative;
    display: flex;
    flex: 1;
    align-items: center;
    justify-content: center;
    height: 100%;
    margin: 0;
    padding: 0;
    background: transparent;
    color: var(--nd-text-primary);
    font-size: 17px;
    line-height: 1;
    cursor: pointer;
    transition: background 0.15s;
}
.nd-btn-draw:hover { background: var(--nd-bg-hover); }
.nd-btn-draw:active { background: var(--nd-bg-active); }
.nd-auto-dot {
    position: absolute;
    top: 7px;
    right: 6px;
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--nd-success);
    opacity: 0;
    transform: scale(0);
    transition: opacity 0.2s, transform 0.2s;
}
.nd-float.auto-on .nd-auto-dot { opacity: 1; transform: scale(1); }

.nd-btn-menu {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 24px;
    height: 100%;
    margin: 0;
    padding: 0;
    background: transparent;
    color: var(--nd-text-muted);
    font-size: 15px;
    line-height: 1;
    cursor: pointer;
    transition: background 0.15s, color 0.15s;
}
.nd-btn-menu:hover { background: var(--nd-bg-hover); color: var(--nd-text-secondary); }
.nd-arrow { display: inline-block; transition: transform 0.2s; }
.nd-float.expanded .nd-arrow { transform: rotate(180deg); }

.nd-layer-active {
    box-sizing: border-box;
    justify-content: center;
    gap: 5px;
    padding: 0 6px;
    color: var(--nd-text-primary);
    font-size: 13px;
    font-weight: 600;
    opacity: 0;
    transform: translateY(100%);
    cursor: pointer;
    pointer-events: none;
}
.nd-float.working .nd-layer-active,
.nd-float.cooldown .nd-layer-active,
.nd-float.success .nd-layer-active,
.nd-float.partial .nd-layer-active,
.nd-float.error .nd-layer-active { opacity: 1; transform: translateY(0); pointer-events: auto; }
.nd-float.cooldown .nd-layer-active { color: var(--nd-info); }
.nd-float.success .nd-layer-active { color: var(--nd-success); }
.nd-float.partial .nd-layer-active { color: var(--nd-warning); }
.nd-float.error .nd-layer-active { color: var(--nd-error); }

.nd-status-icon { flex-shrink: 0; font-size: 15px; line-height: 1; }
.nd-status-text { min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.nd-spin { display: inline-block; animation: nd-spin 1.2s linear infinite; }
@keyframes nd-spin { to { transform: rotate(360deg); } }
.nd-countdown { min-width: 36px; text-align: center; font-variant-numeric: tabular-nums; }

/* ── 详情弹窗（楼层按钮向下展开） ── */
.nd-detail {
    position: absolute;
    top: calc(100% + 8px);
    right: 0;
    z-index: 100;
    padding: 8px 12px;
    border-radius: 10px;
    background: var(--nd-bg);
    color: var(--nd-text-secondary);
    font-size: 12px;
    white-space: nowrap;
    opacity: 0;
    visibility: hidden;
    transform: translateY(-6px) scale(0.96);
    transform-origin: top right;
    transition: opacity 0.2s, transform 0.2s, visibility 0.2s;
}
.nd-float.show-detail .nd-detail { opacity: 1; visibility: visible; transform: translateY(0) scale(1); }
.nd-detail-row { display: flex; align-items: center; gap: 8px; padding: 3px 0; }
.nd-detail-row + .nd-detail-row { margin-top: 2px; }
.nd-detail-icon { font-size: 14px; line-height: 1; color: var(--nd-text-muted); }
.nd-detail-label { color: var(--nd-text-muted); }
.nd-detail-value { margin-left: auto; font-weight: 600; color: var(--nd-text-primary); }
.nd-detail-value.success { color: var(--nd-success); }
.nd-detail-value.warning { color: var(--nd-warning); }
.nd-detail-value.error { color: var(--nd-error); }

/* ── 菜单（楼层按钮向下展开） ── */
.nd-menu {
    position: absolute;
    top: calc(100% + 8px);
    right: 0;
    z-index: 100;
    box-sizing: border-box;
    width: 216px;
    padding: 8px;
    border-radius: 10px;
    background: var(--nd-bg);
    opacity: 0;
    visibility: hidden;
    transform: translateY(-6px) scale(0.96);
    transform-origin: top right;
    transition: opacity 0.2s, transform 0.2s, visibility 0.2s;
}
.nd-float.expanded .nd-menu { opacity: 1; visibility: visible; transform: translateY(0) scale(1); }
.nd-card { display: flex; flex-direction: column; gap: 4px; }
.nd-card:empty { display: none; }
.nd-row { display: flex; align-items: center; gap: 8px; min-height: 30px; }
.nd-label { flex-shrink: 0; width: 30px; font-size: 11px; color: var(--nd-text-muted); }
.nd-select, .nd-input {
    flex: 1;
    box-sizing: border-box;
    min-width: 0;
    min-height: 30px;
    margin: 0;
    padding: 5px 8px;
    border-radius: 6px;
    background: var(--nd-bg-input);
    color: var(--nd-text-primary);
    font: inherit;
    font-size: 12px;
    -webkit-appearance: none;
    appearance: none;
    transition: background 0.15s;
}
.nd-select:hover, .nd-input:hover { background: var(--nd-bg-hover); }
.nd-input:focus { background: var(--nd-bg-active); }
.nd-select.size { font-family: "SF Mono", Menlo, Consolas, monospace; }
.nd-input { user-select: text; font-variant-numeric: tabular-nums; }

.nd-controls { display: flex; align-items: center; gap: 6px; margin-top: 8px; }
.nd-card:empty + .nd-controls { margin-top: 0; }
.nd-auto {
    display: flex;
    flex: 1;
    align-items: center;
    gap: 8px;
    min-height: 32px;
    box-sizing: border-box;
    padding: 6px 10px;
    border-radius: 6px;
    background: var(--nd-bg-raise);
    cursor: pointer;
    transition: background 0.15s;
}
.nd-auto:hover { background: var(--nd-bg-hover); }
.nd-auto.on { background: rgba(77, 171, 111, 0.16); }
.nd-dot { width: 7px; height: 7px; border-radius: 50%; background: #555555; transition: background 0.2s; }
.nd-auto.on .nd-dot { background: var(--nd-success); }
.nd-auto-text { font-size: 12px; color: var(--nd-text-secondary); }
.nd-auto.on .nd-auto-text { color: var(--nd-success); }
.nd-gear {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 32px;
    height: 32px;
    margin: 0;
    padding: 0;
    border-radius: 6px;
    background: var(--nd-bg-raise);
    color: var(--nd-text-secondary);
    font-size: 16px;
    line-height: 1;
    cursor: pointer;
    transition: background 0.15s, color 0.15s;
}
.nd-gear:hover { background: var(--nd-bg-hover); color: var(--nd-text-primary); }

@media (pointer: coarse) {
    .nd-row { min-height: 38px; }
    .nd-select, .nd-input { min-height: 36px; font-size: 13px; }
}

/* ── 悬浮按钮（固定定位，可拖拽；详情和菜单向上展开） ── */
.nd-floating-global { position: fixed; z-index: 10000; user-select: none; will-change: transform; }
.nd-floating-global .nd-capsule { touch-action: none; cursor: grab; }
.nd-floating-global .nd-capsule:active { cursor: grabbing; }
.nd-floating-global .nd-detail { top: auto; bottom: calc(100% + 10px); transform: translateY(4px) scale(0.96); transform-origin: bottom right; }
.nd-floating-global.show-detail .nd-detail { transform: translateY(0) scale(1); }
.nd-floating-global .nd-menu { top: auto; bottom: calc(100% + 10px); transform: translateY(6px) scale(0.98); transform-origin: bottom right; }
.nd-floating-global.expanded .nd-menu { transform: translateY(0) scale(1); }
`;
