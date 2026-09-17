// floating-panel.js
/**
 * NovelDraw 画图按钮面板 - 支持楼层按钮和悬浮按钮双模式
 * 外观：Notion 暗色，零边线零阴影，层级只靠底色；图标用 Remix Icon。
 * 下拉菜单显示哪些绘图参数由 settings.floatFields 决定（见 float-fields.js），设置页勾选后 rebuildMenus() 实时生效。
 */

import { getContext } from '../../../../../../../extensions.js';
import {
    openNovelDrawSettings,
    generateAndInsertImages,
    getSettings,
    updateSettingsPersistent,
    findLastAIMessageId,
    classifyError,
    getGenerationPhase,
} from './novel-draw.js';
import { registerToToolbar, removeFromToolbar } from '../../../../widgets/message-toolbar.js';
import { formatScenePlannerProgress } from '../../shared/draw-common.js';
import { ensureRemixIcon } from '../../shared/remixicon-loader.js';
import { ensureHostSelects } from '../../shared/host-select.js';
import {
    FLOAT_SIZE_OPTIONS,
    applyFloatFieldValue,
    bindFloatFieldControls,
    buildFloatFieldRows,
    syncFloatFieldControls,
} from './float-fields.js';
import { FLOATING_PANEL_CSS } from './ui/floating-panel-styles.js';
import { createIdleDimmer } from './ui/float-idle-dim.js';

// ═══════════════════════════════════════════════════════════════════════════
// 常量
// ═══════════════════════════════════════════════════════════════════════════

const FLOAT_POS_KEY = 'xb_novel_float_pos';
const AUTO_RESET_DELAY = 8000;

const FloatState = {
    IDLE: 'idle',
    SUBMITTING: 'submitting',
    ACCEPTED: 'accepted',
    UNCERTAIN: 'uncertain',
    QUEUED: 'queued',
    LLM: 'llm',
    GEN: 'gen',
    COOLDOWN: 'cooldown',
    RECONNECTING: 'reconnecting',
    CANCELLING: 'cancelling',
    BACKEND_LEGACY: 'backend_legacy',
    SUCCESS: 'success',
    PARTIAL: 'partial',
    ERROR: 'error',
};

const SIZE_OPTIONS = FLOAT_SIZE_OPTIONS;

const FIELD_SAVED_TEXT = {
    preset: '预设已切换',
    size: '尺寸已切换',
    model: '模型已切换',
    sampler: '采样器已切换',
    steps: '步数已更新',
    scale: '引导已更新',
    seed: '种子已更新',
    supplement: '增补提示词开关已切换',
};

// ═══════════════════════════════════════════════════════════════════════════
// 状态
// ═══════════════════════════════════════════════════════════════════════════

// 楼层按钮状态
const panelMap = new Map();
const pendingCallbacks = new Map();
let floorObserver = null;

// 悬浮按钮状态
let floatingEl = null;
let floatingDragState = null;
let floatingState = FloatState.IDLE;
let floatingMessageId = null;
let floatingResult = { success: 0, total: 0, error: null, startTime: 0 };
let floatingAutoResetTimer = null;
let floatingCooldownRafId = null;
let floatingCooldownEndTime = 0;
let $floatingCache = {};
let floatingIdleDimmer = null;

// 通用状态
let stylesInjected = false;

// ═══════════════════════════════════════════════════════════════════════════
// 样式 - 统一样式（楼层+悬浮共用）
// ═══════════════════════════════════════════════════════════════════════════

const STYLES = FLOATING_PANEL_CSS;

function injectStyles() {
    ensureRemixIcon();
    void ensureHostSelects().catch((error) => console.warn('[NovelDraw] 自绘下拉加载失败:', error));
    if (stylesInjected) return;
    stylesInjected = true;

    const el = document.createElement('style');
    el.id = 'nd-float-styles';
    el.textContent = STYLES;
    document.head.appendChild(el);
}

// ═══════════════════════════════════════════════════════════════════════════
// 通用工具函数
// ═══════════════════════════════════════════════════════════════════════════

function createEl(tag, className, text) {
    const el = document.createElement(tag);
    if (className) el.className = className;
    if (text !== undefined) el.textContent = text;
    return el;
}

function createIcon(iconClass, extraClass = '') {
    const icon = document.createElement('i');
    icon.className = `${extraClass ? `${extraClass} ` : ''}${iconClass}`;
    icon.setAttribute('aria-hidden', 'true');
    return icon;
}

function setStatusIcon(el, iconClass, spin = false) {
    if (!el) return;
    el.textContent = '';
    el.className = `nd-status-icon ${iconClass}${spin ? ' nd-spin' : ''}`;
}

function isInsideSelectLayer(target) {
    return !!target?.closest?.('#nd-select-layer');
}

/** 菜单：勾选的绘图参数行 + 自动配图开关 + 设置按钮。 */
function createMenuElement(settings) {
    const isAuto = settings.mode === 'auto';
    const menu = createEl('div', 'nd-menu');
    const card = createEl('div', 'nd-card nd-field-rows');
    card.appendChild(buildFloatFieldRows(document, settings.floatFields, settings));
    bindFloatFieldControls(card, (id, value) => { void setQuickField(id, value); });

    const controls = createEl('div', 'nd-controls');
    const autoToggle = createEl('div', `nd-auto${isAuto ? ' on' : ''} nd-auto-toggle`);
    autoToggle.append(
        createEl('span', 'nd-dot'),
        createEl('span', 'nd-auto-text', '自动配图')
    );
    const settingsBtn = createEl('button', 'nd-gear nd-settings-btn');
    settingsBtn.type = 'button';
    settingsBtn.title = '打开设置';
    settingsBtn.appendChild(createIcon('ri-settings-3-line'));
    controls.append(autoToggle, settingsBtn);
    menu.append(card, controls);
    return menu;
}

function createDetailElement() {
    const detail = createEl('div', 'nd-detail');
    const detailRowResult = createEl('div', 'nd-detail-row');
    detailRowResult.append(
        createIcon('ri-bar-chart-line', 'nd-detail-icon'),
        createEl('span', 'nd-detail-label', '结果'),
        createEl('span', 'nd-detail-value nd-result', '-')
    );
    const detailRowError = createEl('div', 'nd-detail-row nd-error-row');
    detailRowError.style.display = 'none';
    detailRowError.append(
        createIcon('ri-lightbulb-line', 'nd-detail-icon'),
        createEl('span', 'nd-detail-label', '原因'),
        createEl('span', 'nd-detail-value error nd-error', '-')
    );
    const detailRowTime = createEl('div', 'nd-detail-row');
    detailRowTime.append(
        createIcon('ri-time-line', 'nd-detail-icon'),
        createEl('span', 'nd-detail-label', '耗时'),
        createEl('span', 'nd-detail-value nd-time', '-')
    );
    detail.append(detailRowResult, detailRowError, detailRowTime);
    return detail;
}

function createCapsuleElement({ drawTitle, arrowIcon }) {
    const capsule = createEl('div', 'nd-capsule');
    const inner = createEl('div', 'nd-inner');
    const layerIdle = createEl('div', 'nd-layer nd-layer-idle');
    const drawBtn = createEl('button', 'nd-btn-draw');
    drawBtn.type = 'button';
    drawBtn.title = drawTitle;
    drawBtn.appendChild(createIcon('ri-palette-line'));
    drawBtn.appendChild(createEl('span', 'nd-auto-dot'));
    const menuBtn = createEl('button', 'nd-btn-menu');
    menuBtn.type = 'button';
    menuBtn.title = '展开菜单';
    menuBtn.appendChild(createIcon(arrowIcon, 'nd-arrow'));
    layerIdle.append(drawBtn, menuBtn);

    const layerActive = createEl('div', 'nd-layer nd-layer-active');
    const statusIcon = createEl('span');
    setStatusIcon(statusIcon, 'ri-loader-4-line', true);
    layerActive.append(statusIcon, createEl('span', 'nd-status-text', '分析'));

    inner.append(layerIdle, layerActive);
    capsule.appendChild(inner);
    return capsule;
}

/** 按状态更新胶囊里的图标和文字（楼层与悬浮共用）。 */
function applyStatusView(statusIcon, statusText, state, data) {
    switch (state) {
        case FloatState.SUBMITTING:
            setStatusIcon(statusIcon, 'ri-loader-4-line', true);
            if (statusText) statusText.textContent = '提交后台';
            break;
        case FloatState.ACCEPTED:
            setStatusIcon(statusIcon, 'ri-refresh-line', true);
            if (statusText) statusText.textContent = '处理中';
            break;
        case FloatState.UNCERTAIN:
            setStatusIcon(statusIcon, 'ri-refresh-line', true);
            if (statusText) statusText.textContent = '确认中';
            break;
        case FloatState.QUEUED:
            setStatusIcon(statusIcon, 'ri-hourglass-line');
            if (statusText) statusText.textContent = data.ahead > 0 ? `排队${data.ahead}` : '排队';
            break;
        case FloatState.LLM:
            setStatusIcon(statusIcon, 'ri-loader-4-line', true);
            if (statusText) statusText.textContent = formatScenePlannerProgress(data);
            break;
        case FloatState.GEN:
            setStatusIcon(statusIcon, 'ri-brush-line');
            if (statusText) statusText.textContent = `${data.current || 0}/${data.total || 0}`;
            break;
        case FloatState.COOLDOWN:
            setStatusIcon(statusIcon, 'ri-time-line');
            break;
        case FloatState.RECONNECTING:
            setStatusIcon(statusIcon, 'ri-refresh-line', true);
            if (statusText) statusText.textContent = '重连';
            break;
        case FloatState.CANCELLING:
            setStatusIcon(statusIcon, 'ri-loader-4-line', true);
            if (statusText) statusText.textContent = '取消中';
            break;
        case FloatState.BACKEND_LEGACY:
            setStatusIcon(statusIcon, 'ri-share-forward-line');
            if (statusText) statusText.textContent = '兼容模式';
            break;
        case FloatState.SUCCESS:
            setStatusIcon(statusIcon, 'ri-check-line');
            if (statusText) statusText.textContent = `${data.success}/${data.total}`;
            break;
        case FloatState.PARTIAL:
            setStatusIcon(statusIcon, 'ri-alert-line');
            if (statusText) statusText.textContent = `${data.success}/${data.total}`;
            break;
        case FloatState.ERROR:
            setStatusIcon(statusIcon, 'ri-close-circle-line');
            if (statusText) statusText.textContent = data.error?.label || '错误';
            break;
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// 楼层按钮逻辑
// ═══════════════════════════════════════════════════════════════════════════

function createFloorPanelData(messageId) {
    return {
        messageId,
        root: null,
        state: FloatState.IDLE,
        result: { success: 0, total: 0, error: null, startTime: 0 },
        autoResetTimer: null,
        cooldownRafId: null,
        cooldownEndTime: 0,
        $cache: {},
        _cleanup: null,
    };
}

function createFloorPanelElement(messageId) {
    const settings = getSettings();
    const isAuto = settings.mode === 'auto';

    const root = document.createElement('div');
    root.className = `nd-float${isAuto ? ' auto-on' : ''}`;
    root.dataset.messageId = messageId;

    const capsule = createCapsuleElement({ drawTitle: '点击生成配图', arrowIcon: 'ri-arrow-down-s-line' });
    root.append(capsule, createDetailElement(), createMenuElement(settings));
    return root;
}

function cacheFloorDOM(panelData) {
    const el = panelData.root;
    if (!el) return;

    panelData.$cache = {
        statusIcon: el.querySelector('.nd-status-icon'),
        statusText: el.querySelector('.nd-status-text'),
        result: el.querySelector('.nd-result'),
        errorRow: el.querySelector('.nd-error-row'),
        error: el.querySelector('.nd-error'),
        time: el.querySelector('.nd-time'),
        fieldRows: el.querySelector('.nd-field-rows'),
        autoToggle: el.querySelector('.nd-auto-toggle'),
    };
}

function setFloorState(messageId, state, data = {}) {
    const panelData = panelMap.get(messageId);
    if (!panelData?.root) return;

    const el = panelData.root;
    panelData.state = state;

    if (panelData.autoResetTimer) {
        clearTimeout(panelData.autoResetTimer);
        panelData.autoResetTimer = null;
    }
    if (state !== FloatState.COOLDOWN && panelData.cooldownRafId) {
        cancelAnimationFrame(panelData.cooldownRafId);
        panelData.cooldownRafId = null;
        panelData.cooldownEndTime = 0;
    }

    el.classList.remove('working', 'cooldown', 'success', 'partial', 'error', 'show-detail');

    const { statusIcon, statusText } = panelData.$cache;
    if (statusText) statusText.className = 'nd-status-text';
    applyStatusView(statusIcon, statusText, state, data);

    switch (state) {
        case FloatState.IDLE:
            panelData.result = { success: 0, total: 0, error: null, startTime: 0 };
            break;
        case FloatState.SUBMITTING:
        case FloatState.ACCEPTED:
        case FloatState.UNCERTAIN:
        case FloatState.LLM:
            el.classList.add('working');
            if (!panelData.result.startTime) panelData.result.startTime = Date.now();
            break;
        case FloatState.QUEUED:
            el.classList.add('working');
            if (!panelData.result.startTime) panelData.result.startTime = Date.now();
            panelData.result.total = data.total || panelData.result.total || 0;
            break;
        case FloatState.GEN:
            el.classList.add('working');
            panelData.result.total = data.total || 0;
            break;
        case FloatState.COOLDOWN:
            el.classList.add('cooldown');
            startFloorCooldownTimer(panelData, data);
            break;
        case FloatState.RECONNECTING:
        case FloatState.CANCELLING:
        case FloatState.BACKEND_LEGACY:
            el.classList.add('working');
            break;
        case FloatState.SUCCESS:
            el.classList.add('success');
            panelData.result.success = data.success;
            panelData.result.total = data.total;
            panelData.autoResetTimer = setTimeout(() => setFloorState(messageId, FloatState.IDLE), AUTO_RESET_DELAY);
            break;
        case FloatState.PARTIAL:
            el.classList.add('partial');
            panelData.result.success = data.success;
            panelData.result.total = data.total;
            panelData.autoResetTimer = setTimeout(() => setFloorState(messageId, FloatState.IDLE), AUTO_RESET_DELAY);
            break;
        case FloatState.ERROR:
            el.classList.add('error');
            panelData.result.error = data.error;
            panelData.autoResetTimer = setTimeout(() => setFloorState(messageId, FloatState.IDLE), AUTO_RESET_DELAY);
            break;
    }
}

export function refreshGenerationUiState() {
    const messageId = findLastAIMessageId();
    if (floatingEl) {
        const generationPhase = messageId >= 0 ? getGenerationPhase(messageId) : null;
        if (generationPhase) {
            floatingMessageId = messageId;
            setFloatingState(generationPhase === 'llm'
                ? FloatState.LLM
                : generationPhase === 'submitting'
                    ? FloatState.SUBMITTING
                    : FloatState.GEN);
        } else {
            setFloatingState(FloatState.IDLE);
        }
    }
}

function resolveCooldownEndTime({ cooldownUntil, duration } = {}) {
    const absolute = Number(cooldownUntil);
    if (Number.isFinite(absolute) && absolute > 0) return absolute;
    return Date.now() + Math.max(0, Number(duration) || 0);
}

function startFloorCooldownTimer(panelData, data) {
    if (panelData.cooldownRafId) cancelAnimationFrame(panelData.cooldownRafId);
    panelData.cooldownEndTime = resolveCooldownEndTime(data);

    function tick() {
        if (!panelData.cooldownEndTime) return;
        const remaining = Math.max(0, panelData.cooldownEndTime - Date.now());
        const statusText = panelData.$cache?.statusText;
        if (statusText) {
            statusText.textContent = `${(remaining / 1000).toFixed(1)}s`;
            statusText.className = 'nd-status-text nd-countdown';
        }
        if (remaining <= 0) {
            panelData.cooldownRafId = null;
            panelData.cooldownEndTime = 0;
            return;
        }
        panelData.cooldownRafId = requestAnimationFrame(tick);
    }

    panelData.cooldownRafId = requestAnimationFrame(tick);
}

function updateFloorDetailPopup(messageId) {
    const panelData = panelMap.get(messageId);
    if (!panelData?.root) return;

    const { result: resultEl, errorRow, error: errorEl, time: timeEl } = panelData.$cache;
    const { result, state } = panelData;

    const elapsed = result.startTime
        ? ((Date.now() - result.startTime) / 1000).toFixed(1)
        : '-';

    if (state === FloatState.SUCCESS || state === FloatState.PARTIAL) {
        if (resultEl) {
            resultEl.textContent = `${result.success}/${result.total} 成功`;
            resultEl.className = `nd-detail-value ${state === FloatState.SUCCESS ? 'success' : 'warning'}`;
        }
        if (errorRow) errorRow.style.display = state === FloatState.PARTIAL ? 'flex' : 'none';
        if (errorEl && state === FloatState.PARTIAL) {
            errorEl.textContent = `${result.total - result.success} 张失败`;
        }
    } else if (state === FloatState.ERROR) {
        if (resultEl) {
            resultEl.textContent = '生成失败';
            resultEl.className = 'nd-detail-value error';
        }
        if (errorRow) errorRow.style.display = 'flex';
        if (errorEl) errorEl.textContent = result.error?.desc || '未知错误';
    }

    if (timeEl) timeEl.textContent = `${elapsed}s`;
}

async function handleFloorDrawClick(messageId) {
    const panelData = panelMap.get(messageId);
    if (!panelData || panelData.state !== FloatState.IDLE) return;
    const targetChatId = String(getContext()?.chatId || '');

    try {
        await generateAndInsertImages({
            messageId,
            onStateChange: (state, data) => {
                if (String(getContext()?.chatId || '') !== targetChatId) return;
                switch (state) {
                    case 'submitting': setFloorState(messageId, FloatState.SUBMITTING, data); break;
                    case 'accepted': setFloorState(messageId, FloatState.ACCEPTED, data); break;
                    case 'uncertain': setFloorState(messageId, FloatState.UNCERTAIN, data); break;
                    case 'queued': setFloorState(messageId, FloatState.QUEUED, data); break;
                    case 'llm': setFloorState(messageId, FloatState.LLM, data); break;
                    case 'gen': setFloorState(messageId, FloatState.GEN, data); break;
                    case 'progress': setFloorState(messageId, FloatState.GEN, data); break;
                    case 'cooldown': setFloorState(messageId, FloatState.COOLDOWN, data); break;
                    case 'reconnecting': setFloorState(messageId, FloatState.RECONNECTING, data); break;
                    case 'cancelling': setFloorState(messageId, FloatState.CANCELLING, data); break;
                    case 'backend_legacy': setFloorState(messageId, FloatState.BACKEND_LEGACY, data); break;
                    case 'success':
                        if (data.aborted && data.success === 0) {
                            setFloorState(messageId, FloatState.IDLE);
                        } else if (data.aborted || data.success < data.total) {
                            setFloorState(messageId, FloatState.PARTIAL, data);
                        } else {
                            setFloorState(messageId, FloatState.SUCCESS, data);
                        }
                        break;
                }
            }
        });
    } catch (e) {
        console.error('[NovelDraw]', e);
        if (String(getContext()?.chatId || '') !== targetChatId) return;
        if (e?.uncertain === true) {
            setFloorState(messageId, FloatState.UNCERTAIN);
        } else if (e.message?.includes('已有任务进行中') || e.message?.includes('该楼层已有任务进行中')) {
            setFloorState(messageId, FloatState.IDLE);
            if (e.message?.includes('任务进行中')) toastr?.info?.(e.message);
        } else {
            toastr?.error?.(e?.message || '后台画图提交失败', '小黑生图');
            setFloorState(messageId, FloatState.ERROR, { error: classifyError(e) });
        }
    }
}

async function handleFloorAbort(messageId) {
    try {
        const { abortGeneration } = await import('./novel-draw.js');
        const aborted = abortGeneration(messageId);
        if (aborted) {
            setFloorState(messageId, FloatState.CANCELLING);
            toastr?.info?.('正在中止');
        }
    } catch (e) {
        console.error('[NovelDraw] 中止失败:', e);
    }
}

function bindFloorPanelEvents(panelData) {
    const { messageId, root: el } = panelData;

    el.querySelector('.nd-btn-draw')?.addEventListener('click', (e) => {
        e.stopPropagation();
        handleFloorDrawClick(messageId);
    });

    el.querySelector('.nd-btn-menu')?.addEventListener('click', (e) => {
        e.stopPropagation();
        el.classList.remove('show-detail');
        if (!el.classList.contains('expanded')) {
            syncFloatFieldControls(panelData.$cache.fieldRows, getSettings());
        }
        el.classList.toggle('expanded');
    });

    el.querySelector('.nd-layer-active')?.addEventListener('click', (e) => {
        e.stopPropagation();
        const state = panelData.state;
        if ([FloatState.SUBMITTING, FloatState.ACCEPTED, FloatState.UNCERTAIN, FloatState.QUEUED, FloatState.LLM, FloatState.GEN, FloatState.COOLDOWN, FloatState.RECONNECTING, FloatState.BACKEND_LEGACY].includes(state)) {
            handleFloorAbort(messageId);
        } else if ([FloatState.SUCCESS, FloatState.PARTIAL, FloatState.ERROR].includes(state)) {
            updateFloorDetailPopup(messageId);
            el.classList.toggle('show-detail');
        }
    });

    panelData.$cache.autoToggle?.addEventListener('click', async () => {
        await toggleQuickAutoMode();
    });

    el.querySelector('.nd-settings-btn')?.addEventListener('click', (e) => {
        e.stopPropagation();
        el.classList.remove('expanded');
        openNovelDrawSettings();
    });

    const closeMenu = (e) => {
        if (!el.contains(e.target) && !isInsideSelectLayer(e.target)) {
            el.classList.remove('expanded', 'show-detail');
        }
    };
    document.addEventListener('click', closeMenu, { passive: true });

    panelData._cleanup = () => {
        document.removeEventListener('click', closeMenu);
        if (panelData.autoResetTimer) clearTimeout(panelData.autoResetTimer);
        panelData.autoResetTimer = null;
        if (panelData.cooldownRafId) cancelAnimationFrame(panelData.cooldownRafId);
        panelData.cooldownRafId = null;
        panelData.cooldownEndTime = null;
    };
}

async function persistQuickSetting(mutator, okText, afterSave) {
    const ok = await updateSettingsPersistent(mutator, okText);
    if (ok && typeof afterSave === 'function') {
        afterSave();
    }
    return ok;
}

/** 菜单里任意一个参数控件改动：写入设置，然后刷新所有菜单（失败或无效输入时回到保存值）。 */
async function setQuickField(id, value) {
    const ok = await updateSettingsPersistent(
        (settings) => { applyFloatFieldValue(settings, id, value); },
        FIELD_SAVED_TEXT[id] || '已保存',
    );
    refreshAllFieldControls();
    return ok;
}

async function toggleQuickAutoMode() {
    const current = getSettings();
    const nextMode = current.mode === 'auto' ? 'manual' : 'auto';
    return persistQuickSetting(
        (settings) => { settings.mode = nextMode; },
        nextMode === 'auto' ? '自动配图已开启' : '自动配图已关闭',
        updateAutoModeUI,
    );
}

function mountFloorPanel(messageEl, messageId) {
    if (panelMap.has(messageId)) {
        const existing = panelMap.get(messageId);
        if (existing.root?.isConnected) {
            return existing;
        }
        existing._cleanup?.();
        panelMap.delete(messageId);
    }

    injectStyles();

    const panelData = createFloorPanelData(messageId);
    const panel = createFloorPanelElement(messageId);
    panelData.root = panel;

    const success = registerToToolbar(messageId, panel, {
        position: 'right',
        id: `novel-draw-${messageId}`
    });

    if (!success) return null;

    cacheFloorDOM(panelData);
    bindFloorPanelEvents(panelData);

    panelMap.set(messageId, panelData);
    return panelData;
}

function setupFloorObserver() {
    if (floorObserver) return;

    floorObserver = new IntersectionObserver((entries) => {
        const toMount = [];

        for (const entry of entries) {
            if (!entry.isIntersecting) continue;

            const el = entry.target;
            const mid = Number(el.getAttribute('mesid'));

            if (pendingCallbacks.has(mid)) {
                toMount.push({ el, mid });
                pendingCallbacks.delete(mid);
                floorObserver.unobserve(el);
            }
        }

        if (toMount.length > 0) {
            requestAnimationFrame(() => {
                for (const { el, mid } of toMount) {
                    mountFloorPanel(el, mid);
                }
            });
        }
    }, { rootMargin: '300px' });
}

export function ensureNovelDrawPanel(messageEl, messageId, options = {}) {
    const settings = getSettings();
    if (settings.showFloorButton === false) return null;

    const { force = false } = options;

    injectStyles();

    if (panelMap.has(messageId)) {
        const existing = panelMap.get(messageId);
        if (existing.root?.isConnected) return existing;
        existing._cleanup?.();
        panelMap.delete(messageId);
    }

    if (force) {
        return mountFloorPanel(messageEl, messageId);
    }

    const rect = messageEl.getBoundingClientRect();
    if (rect.top < window.innerHeight + 500 && rect.bottom > -500) {
        return mountFloorPanel(messageEl, messageId);
    }

    setupFloorObserver();
    pendingCallbacks.set(messageId, true);
    floorObserver.observe(messageEl);

    return null;
}

export function setStateForMessage(messageId, state, data = {}) {
    let panelData = panelMap.get(messageId);

    if (!panelData?.root?.isConnected) {
        const messageEl = document.querySelector(`.mes[mesid="${messageId}"]`);
        if (messageEl) {
            panelData = ensureNovelDrawPanel(messageEl, messageId, { force: true });
        }
    }

    if (panelData) {
        setFloorState(messageId, state, data);
    }

    if (floatingEl && messageId === findLastAIMessageId()) {
        setFloatingState(state, data);
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// 悬浮按钮逻辑
// ═══════════════════════════════════════════════════════════════════════════

function getFloatingPosition() {
    try {
        const raw = localStorage.getItem(FLOAT_POS_KEY);
        if (raw) return JSON.parse(raw);
    } catch {}

    const debug = document.getElementById('xiaobaix-debug-mini');
    if (debug) {
        const r = debug.getBoundingClientRect();
        return { left: r.left, top: r.bottom + 8 };
    }
    return { left: window.innerWidth - 110, top: window.innerHeight - 80 };
}

function saveFloatingPosition() {
    if (!floatingEl) return;
    const r = floatingEl.getBoundingClientRect();
    try {
        localStorage.setItem(FLOAT_POS_KEY, JSON.stringify({
            left: Math.round(r.left),
            top: Math.round(r.top)
        }));
    } catch {}
}

function applyFloatingPosition() {
    if (!floatingEl) return;
    const pos = getFloatingPosition();
    const w = floatingEl.offsetWidth || 77;
    const h = floatingEl.offsetHeight || 34;
    floatingEl.style.left = `${Math.max(0, Math.min(pos.left, window.innerWidth - w))}px`;
    floatingEl.style.top = `${Math.max(0, Math.min(pos.top, window.innerHeight - h))}px`;
}

function clearFloatingCooldownTimer() {
    if (floatingCooldownRafId) {
        cancelAnimationFrame(floatingCooldownRafId);
        floatingCooldownRafId = null;
    }
    floatingCooldownEndTime = 0;
}

function startFloatingCooldownTimer(data) {
    clearFloatingCooldownTimer();
    floatingCooldownEndTime = resolveCooldownEndTime(data);

    function tick() {
        if (!floatingCooldownEndTime) return;
        const remaining = Math.max(0, floatingCooldownEndTime - Date.now());
        const statusText = $floatingCache.statusText;
        if (statusText) {
            statusText.textContent = `${(remaining / 1000).toFixed(1)}s`;
            statusText.className = 'nd-status-text nd-countdown';
        }
        if (remaining <= 0) {
            clearFloatingCooldownTimer();
            return;
        }
        floatingCooldownRafId = requestAnimationFrame(tick);
    }

    floatingCooldownRafId = requestAnimationFrame(tick);
}

function setFloatingState(state, data = {}) {
    if (!floatingEl) return;

    floatingState = state;

    if (floatingAutoResetTimer) {
        clearTimeout(floatingAutoResetTimer);
        floatingAutoResetTimer = null;
    }

    if (state !== FloatState.COOLDOWN) {
        clearFloatingCooldownTimer();
    }

    floatingEl.classList.remove('working', 'cooldown', 'success', 'partial', 'error', 'show-detail');

    const { statusIcon, statusText } = $floatingCache;
    if (!statusIcon || !statusText) return;
    statusText.className = 'nd-status-text';
    applyStatusView(statusIcon, statusText, state, data);

    switch (state) {
        case FloatState.IDLE:
            floatingMessageId = null;
            floatingResult = { success: 0, total: 0, error: null, startTime: 0 };
            break;
        case FloatState.SUBMITTING:
        case FloatState.ACCEPTED:
        case FloatState.UNCERTAIN:
        case FloatState.QUEUED:
        case FloatState.LLM:
            floatingEl.classList.add('working');
            if (!floatingResult.startTime) floatingResult.startTime = Date.now();
            break;
        case FloatState.GEN:
            floatingEl.classList.add('working');
            floatingResult.total = data.total || 0;
            break;
        case FloatState.COOLDOWN:
            floatingEl.classList.add('cooldown');
            startFloatingCooldownTimer(data);
            break;
        case FloatState.RECONNECTING:
        case FloatState.CANCELLING:
        case FloatState.BACKEND_LEGACY:
            floatingEl.classList.add('working');
            break;
        case FloatState.SUCCESS:
            floatingEl.classList.add('success');
            floatingResult.success = data.success;
            floatingResult.total = data.total;
            floatingAutoResetTimer = setTimeout(() => setFloatingState(FloatState.IDLE), AUTO_RESET_DELAY);
            break;
        case FloatState.PARTIAL:
            floatingEl.classList.add('partial');
            floatingResult.success = data.success;
            floatingResult.total = data.total;
            floatingAutoResetTimer = setTimeout(() => setFloatingState(FloatState.IDLE), AUTO_RESET_DELAY);
            break;
        case FloatState.ERROR:
            floatingEl.classList.add('error');
            floatingResult.error = data.error;
            floatingAutoResetTimer = setTimeout(() => setFloatingState(FloatState.IDLE), AUTO_RESET_DELAY);
            break;
    }
}

function updateFloatingDetailPopup() {
    const { detailResult, detailErrorRow, detailError, detailTime } = $floatingCache;
    if (!detailResult) return;

    const elapsed = floatingResult.startTime
        ? ((Date.now() - floatingResult.startTime) / 1000).toFixed(1)
        : '-';

    if (floatingState === FloatState.SUCCESS || floatingState === FloatState.PARTIAL) {
        detailResult.textContent = `${floatingResult.success}/${floatingResult.total} 成功`;
        detailResult.className = `nd-detail-value ${floatingState === FloatState.SUCCESS ? 'success' : 'warning'}`;
        detailErrorRow.style.display = floatingState === FloatState.PARTIAL ? 'flex' : 'none';
        if (floatingState === FloatState.PARTIAL) {
            detailError.textContent = `${floatingResult.total - floatingResult.success} 张失败`;
        }
    } else if (floatingState === FloatState.ERROR) {
        detailResult.textContent = '生成失败';
        detailResult.className = 'nd-detail-value error';
        detailErrorRow.style.display = 'flex';
        detailError.textContent = floatingResult.error?.desc || '未知错误';
    }

    detailTime.textContent = `${elapsed}s`;
}

function onFloatingPointerDown(e) {
    if (e.button !== 0) return;

    floatingDragState = {
        startX: e.clientX,
        startY: e.clientY,
        startLeft: floatingEl.getBoundingClientRect().left,
        startTop: floatingEl.getBoundingClientRect().top,
        pointerId: e.pointerId,
        moved: false,
        originalTarget: e.target
    };

    try { e.currentTarget.setPointerCapture(e.pointerId); } catch {}
    e.preventDefault();
}

function onFloatingPointerMove(e) {
    if (!floatingDragState || floatingDragState.pointerId !== e.pointerId) return;

    const dx = e.clientX - floatingDragState.startX;
    const dy = e.clientY - floatingDragState.startY;

    if (!floatingDragState.moved && (Math.abs(dx) > 3 || Math.abs(dy) > 3)) {
        floatingDragState.moved = true;
    }

    if (floatingDragState.moved) {
        const w = floatingEl.offsetWidth || 88;
        const h = floatingEl.offsetHeight || 36;
        floatingEl.style.left = `${Math.max(0, Math.min(floatingDragState.startLeft + dx, window.innerWidth - w))}px`;
        floatingEl.style.top = `${Math.max(0, Math.min(floatingDragState.startTop + dy, window.innerHeight - h))}px`;
    }

    e.preventDefault();
}

function onFloatingPointerUp(e) {
    if (!floatingDragState || floatingDragState.pointerId !== e.pointerId) return;

    const { moved, originalTarget } = floatingDragState;

    try { e.currentTarget.releasePointerCapture(e.pointerId); } catch {}
    floatingDragState = null;

    if (moved) {
        saveFloatingPosition();
    } else {
        routeFloatingClick(originalTarget);
    }
}

function routeFloatingClick(target) {
    if (target.closest('.nd-btn-draw')) {
        handleFloatingDrawClick();
    } else if (target.closest('.nd-btn-menu')) {
        floatingEl.classList.remove('show-detail');
        if (!floatingEl.classList.contains('expanded')) {
            syncFloatFieldControls($floatingCache.fieldRows, getSettings());
        }
        floatingEl.classList.toggle('expanded');
    } else if (target.closest('.nd-layer-active')) {
        if ([FloatState.SUBMITTING, FloatState.ACCEPTED, FloatState.UNCERTAIN, FloatState.QUEUED, FloatState.LLM, FloatState.GEN, FloatState.COOLDOWN, FloatState.RECONNECTING, FloatState.BACKEND_LEGACY].includes(floatingState)) {
            handleFloatingAbort();
        } else if ([FloatState.SUCCESS, FloatState.PARTIAL, FloatState.ERROR].includes(floatingState)) {
            updateFloatingDetailPopup();
            floatingEl.classList.toggle('show-detail');
        }
    }
}

async function handleFloatingDrawClick() {
    if (floatingState !== FloatState.IDLE) return;

    const messageId = findLastAIMessageId();
    if (messageId < 0) {
        toastr?.warning?.('没有可配图的AI消息');
        return;
    }

    floatingMessageId = messageId;
    const targetChatId = String(getContext()?.chatId || '');

    try {
        await generateAndInsertImages({
            messageId,
            onStateChange: (state, data) => {
                if (String(getContext()?.chatId || '') !== targetChatId) return;
                switch (state) {
                    case 'submitting': setFloatingState(FloatState.SUBMITTING, data); break;
                    case 'accepted': setFloatingState(FloatState.ACCEPTED, data); break;
                    case 'uncertain': setFloatingState(FloatState.UNCERTAIN, data); break;
                    case 'queued': setFloatingState(FloatState.QUEUED, data); break;
                    case 'llm': setFloatingState(FloatState.LLM, data); break;
                    case 'gen': setFloatingState(FloatState.GEN, data); break;
                    case 'progress': setFloatingState(FloatState.GEN, data); break;
                    case 'cooldown': setFloatingState(FloatState.COOLDOWN, data); break;
                    case 'reconnecting': setFloatingState(FloatState.RECONNECTING, data); break;
                    case 'cancelling': setFloatingState(FloatState.CANCELLING, data); break;
                    case 'backend_legacy': setFloatingState(FloatState.BACKEND_LEGACY, data); break;
                    case 'success':
                        if (data.aborted && data.success === 0) {
                            setFloatingState(FloatState.IDLE);
                        } else if (data.aborted || data.success < data.total) {
                            setFloatingState(FloatState.PARTIAL, data);
                        } else {
                            setFloatingState(FloatState.SUCCESS, data);
                        }
                        break;
                }
            }
        });
    } catch (e) {
        console.error('[NovelDraw]', e);
        if (String(getContext()?.chatId || '') !== targetChatId) return;
        if (e?.uncertain === true) {
            setFloatingState(FloatState.UNCERTAIN);
        } else if (e.message?.includes('已有任务进行中') || e.message?.includes('该楼层已有任务进行中')) {
            setFloatingState(FloatState.IDLE);
            if (e.message?.includes('任务进行中')) toastr?.info?.(e.message);
        } else {
            toastr?.error?.(e?.message || '后台画图提交失败', '小黑生图');
            setFloatingState(FloatState.ERROR, { error: classifyError(e) });
        }
    }
}

async function handleFloatingAbort() {
    try {
        const { abortGeneration } = await import('./novel-draw.js');
        const messageId = floatingMessageId;
        const aborted = messageId >= 0 && abortGeneration(messageId);
        if (aborted) {
            setFloatingState(FloatState.CANCELLING);
            toastr?.info?.('正在中止');
        }
    } catch (e) {
        console.error('[NovelDraw] 中止失败:', e);
    }
}

function cacheFloatingDOM() {
    if (!floatingEl) return;
    $floatingCache = {
        capsule: floatingEl.querySelector('.nd-capsule'),
        statusIcon: floatingEl.querySelector('.nd-status-icon'),
        statusText: floatingEl.querySelector('.nd-status-text'),
        detailResult: floatingEl.querySelector('.nd-result'),
        detailErrorRow: floatingEl.querySelector('.nd-error-row'),
        detailError: floatingEl.querySelector('.nd-error'),
        detailTime: floatingEl.querySelector('.nd-time'),
        fieldRows: floatingEl.querySelector('.nd-field-rows'),
        autoToggle: floatingEl.querySelector('.nd-auto-toggle'),
    };
}

function handleFloatingOutsideClick(e) {
    if (floatingEl && !floatingEl.contains(e.target) && !isInsideSelectLayer(e.target)) {
        floatingEl.classList.remove('expanded', 'show-detail');
    }
}

function createFloatingButton() {
    if (floatingEl) return;

    const settings = getSettings();
    if (settings.showFloatingButton !== true) return;

    injectStyles();

    const isAuto = settings.mode === 'auto';

    floatingEl = document.createElement('div');
    floatingEl.className = `nd-float nd-floating-global${isAuto ? ' auto-on' : ''}`;
    floatingEl.id = 'nd-floating-global';

    const capsule = createCapsuleElement({ drawTitle: '点击为最后一条AI消息生成配图', arrowIcon: 'ri-arrow-up-s-line' });
    floatingEl.append(createDetailElement(), createMenuElement(settings), capsule);

    document.body.appendChild(floatingEl);
    cacheFloatingDOM();
    applyFloatingPosition();

    const capsuleEl = $floatingCache.capsule;
    if (capsuleEl) {
        capsuleEl.addEventListener('pointerdown', onFloatingPointerDown, { passive: false });
        capsuleEl.addEventListener('pointermove', onFloatingPointerMove, { passive: false });
        capsuleEl.addEventListener('pointerup', onFloatingPointerUp, { passive: false });
        capsuleEl.addEventListener('pointercancel', onFloatingPointerUp, { passive: false });
    }

    $floatingCache.autoToggle?.addEventListener('click', async () => {
        await toggleQuickAutoMode();
    });

    floatingEl.querySelector('.nd-settings-btn')?.addEventListener('click', () => {
        floatingEl.classList.remove('expanded');
        openNovelDrawSettings();
    });

    document.addEventListener('click', handleFloatingOutsideClick, { passive: true });
    window.addEventListener('resize', applyFloatingPosition);

    // 闲置 3 秒变半透明；拖动中算"忙"
    floatingIdleDimmer = createIdleDimmer({ el: floatingEl, isBusy: () => !!floatingDragState });
}

function destroyFloatingButton() {
    clearFloatingCooldownTimer();

    if (floatingAutoResetTimer) {
        clearTimeout(floatingAutoResetTimer);
        floatingAutoResetTimer = null;
    }

    window.removeEventListener('resize', applyFloatingPosition);
    document.removeEventListener('click', handleFloatingOutsideClick);

    floatingIdleDimmer?.destroy();
    floatingIdleDimmer = null;

    floatingEl?.remove();
    floatingEl = null;
    floatingDragState = null;
    floatingState = FloatState.IDLE;
    $floatingCache = {};
}

// ═══════════════════════════════════════════════════════════════════════════
// 全局更新函数
// ═══════════════════════════════════════════════════════════════════════════

/** 按当前设置刷新所有菜单控件的取值（预设切换、参数保存后调用）。 */
export function refreshAllFieldControls() {
    const settings = getSettings();
    panelMap.forEach((data) => {
        syncFloatFieldControls(data.$cache?.fieldRows, settings);
    });
    syncFloatFieldControls($floatingCache.fieldRows, settings);
}

/** floatFields 改变后重建所有菜单行（设置页勾选时由宿主调用，实时生效）。 */
export function rebuildMenus() {
    const settings = getSettings();
    const rebuild = (rows) => {
        if (!rows) return;
        rows.replaceChildren(buildFloatFieldRows(document, settings.floatFields, settings));
    };
    panelMap.forEach(data => rebuild(data.$cache?.fieldRows));
    rebuild($floatingCache.fieldRows);
}

function updateAllPresetSelects() {
    refreshAllFieldControls();
}

function updateAllSizeSelects() {
    refreshAllFieldControls();
}

export function updateAutoModeUI() {
    const isAuto = getSettings().mode === 'auto';

    panelMap.forEach((data) => {
        if (!data.root) return;
        data.root.classList.toggle('auto-on', isAuto);
        data.$cache.autoToggle?.classList.toggle('on', isAuto);
    });

    if (floatingEl) {
        floatingEl.classList.toggle('auto-on', isAuto);
        $floatingCache.autoToggle?.classList.toggle('on', isAuto);
    }
}

export function refreshPresetSelectAll() {
    refreshAllFieldControls();
}

// ═══════════════════════════════════════════════════════════════════════════
// 按钮显示控制
// ═══════════════════════════════════════════════════════════════════════════

export function updateButtonVisibility(showFloor, showFloating) {
    if (showFloating && !floatingEl) {
        createFloatingButton();
    } else if (!showFloating && floatingEl) {
        destroyFloatingButton();
    }

    if (!showFloor) {
        panelMap.forEach((data, messageId) => {
            if (data.autoResetTimer) clearTimeout(data.autoResetTimer);
            if (data.cooldownRafId) cancelAnimationFrame(data.cooldownRafId);
            data._cleanup?.();
            if (data.root) removeFromToolbar(messageId, data.root);
        });
        panelMap.clear();
        pendingCallbacks.clear();
        floorObserver?.disconnect();
        floorObserver = null;
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// 初始化与清理
// ═══════════════════════════════════════════════════════════════════════════

export function initFloatingPanel() {
    const settings = getSettings();

    if (settings.showFloatingButton === true) {
        createFloatingButton();
    }
}

export function destroyFloatingPanel() {
    panelMap.forEach((data, messageId) => {
        if (data.autoResetTimer) clearTimeout(data.autoResetTimer);
        if (data.cooldownRafId) cancelAnimationFrame(data.cooldownRafId);
        data._cleanup?.();
        if (data.root) removeFromToolbar(messageId, data.root);
    });
    panelMap.clear();
    pendingCallbacks.clear();

    floorObserver?.disconnect();
    floorObserver = null;

    destroyFloatingButton();
}

// ═══════════════════════════════════════════════════════════════════════════
// 导出
// ═══════════════════════════════════════════════════════════════════════════

export {
    FloatState,
    refreshPresetSelectAll as refreshPresetSelect,
    SIZE_OPTIONS,
    updateAllPresetSelects,
    updateAllSizeSelects,
    createFloatingButton,
    destroyFloatingButton,
    setFloatingState,
};
