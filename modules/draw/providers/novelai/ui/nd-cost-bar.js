// F5：底部生成栏计价 +「复位」+ 免费选项绿色标记（设置页 iframe 内）。
// 不发任何网络请求：档位来自宿主的 SUBSCRIPTION_DATA（宿主免费查询 /user/subscription），查不到时用 #nd_sub_tier 手动档位。
// 计价口径全部来自 novel-anlas-pricing.js（estimateAnlasCost / toFreeConfig / isFreeOption）。
// 挂到 window.NDCostBar = { init, refresh, getSubscription, getEstimate, confirmGenerate }
import { estimateAnlasCost, isFreeOption, OPUS_FREE_MAX_STEPS, toFreeConfig } from '../novel-anlas-pricing.js';
import { subscriptionFromManualTier } from '../novel-subscription.js';
import { xbConfirm } from '../../../shared/xb-dialog.js';
import { describeCost, needsGenerateConfirm, presetPricingConfig } from '../novel-cost-rule.js';
import { parseOverrideSize, sizeOverrideNotice } from '../novel-effective-size.js';

// 确认口径搬到 novel-cost-rule.js（宿主也要用），这里原样转出，老的 import 不受影响。
export { describeCost, isV5ModelId, needsGenerateConfirm } from '../novel-cost-rule.js';

const HOST_SOURCE = 'XBDraw-NovelDraw';
const TIER_NAMES = Object.freeze({ 0: '无订阅', 1: 'Tablet', 2: 'Scroll', 3: 'Opus' });

// ── 纯函数（node 可测） ───────────────────────────────────────────────────

/**
 * 把 SUBSCRIPTION_DATA + 手动档位合成计价用的订阅。
 * 返回 { subscription, verified, label }：verified 只有接口查到（direct/plugin）才为 true。
 */
export function resolveSubscriptionView(data, manualTier = 'auto') {
    const source = data?.source || 'pending';
    if ((source === 'direct' || source === 'plugin') && data.subscription) {
        const sub = data.subscription;
        const name = TIER_NAMES[sub.tier] || `档位 ${sub.tier}`;
        return {
            subscription: sub,
            verified: true,
            label: `${name}${sub.tier > 0 && sub.active !== true ? '（未生效）' : ''}`,
            detail: `已查询（${source === 'direct' ? '直连' : '插件'}）：${name}${sub.tier > 0 ? (sub.active ? '，有效' : '，未生效') : ''}`,
        };
    }
    const manual = subscriptionFromManualTier(manualTier);
    const why = source === 'pending' ? '正在查询档位' : '自动查询失败或没有 Key';
    if (manual) {
        const name = TIER_NAMES[manual.tier];
        return { subscription: manual, verified: false, label: `手动 ${name}`, detail: `${why}，按手动档位「${name}」估算（显示为「约」，不标免费）` };
    }
    return { subscription: null, verified: false, label: source === 'pending' ? '查询中' : '档位未知', detail: `${why}，费用按无免费估算（显示为「约」）` };
}

/** overrideSize：'768x1280' 这类快捷值；也接受 {width,height}（给测试和以后的非白名单尺寸用）。 */
function toOverrideDims(overrideSize) {
    if (overrideSize && typeof overrideSize === 'object') {
        const width = Number(overrideSize.width) || 0;
        const height = Number(overrideSize.height) || 0;
        return width > 0 && height > 0 ? { width, height } : null;
    }
    return parseOverrideSize(overrideSize);
}

/** 表单宽高 + 悬浮球尺寸覆盖 → 实际计价输入（{..., width, height, overridden}）。 */
export function effectivePricingConfig(formConfig, overrideSize = 'default') {
    const dims = toOverrideDims(overrideSize);
    return dims ? { ...formConfig, ...dims, overridden: true } : { ...formConfig, overridden: false };
}

/**
 * 复位计划：只改步数 / 尺寸 / 超过 4 个的氛围，绝不碰提示词、种子、采样器、引导。
 * config 是表单（预设）参数；opts.overrideSize 是悬浮球尺寸覆盖。按「实际尺寸」判断免费：
 *   - 覆盖尺寸本身免费：不动覆盖，也不动表单宽高（表单宽高此时不生效）。
 *   - 覆盖尺寸不免费：取消覆盖（apply.clearOverride，立即保存，因为它是全局快捷设置），
 *     再按表单宽高判断，表单尺寸也不免费就一并改表单。
 * 返回 { ok, apply: {steps?, width?, height?, clearOverride, disableVibeIndexes: []}, message, notices, config }
 * config = 复位后实际会用的计价输入。
 */
export function planFreeReset(config, subscriptionView, { overrideSize = 'default' } = {}) {
    if (!subscriptionView?.verified) {
        return { ok: false, apply: null, message: '档位未知，无法确认免费条件', notices: [] };
    }
    const sub = subscriptionView.subscription;
    const effective = effectivePricingConfig(config, overrideSize);
    const { overridden } = effective;
    delete effective.overridden;
    const result = toFreeConfig(effective, sub);
    if (!result.possible) {
        return { ok: false, apply: null, message: `无法复位为免费配置：${result.notices.join('、')}`, notices: result.notices };
    }
    const isSizeField = change => change.field === 'width' || change.field === 'height';
    const apply = { disableVibeIndexes: [], clearOverride: false };
    const parts = [];
    for (const change of result.changes) {
        if (change.field === 'steps') { apply.steps = change.to; parts.push(`步数 ${change.from}→${change.to}`); }
        else if (!isSizeField(change)) {
            const match = change.field.match(/^vibes\[(\d+)\]\.enabled$/);
            if (match) apply.disableVibeIndexes.push(Number(match[1]));
        }
    }
    let sizeChanges = overridden ? [] : result.changes.filter(isSizeField);
    if (overridden && result.changes.some(isSizeField)) {
        apply.clearOverride = true;
        parts.push(`取消悬浮球尺寸覆盖 ${effective.width}×${effective.height}`);
        const formResult = toFreeConfig(config, sub);
        sizeChanges = formResult.possible ? formResult.changes.filter(isSizeField) : [];
    }
    for (const change of sizeChanges) apply[change.field] = change.to;
    if (apply.width !== undefined || apply.height !== undefined) {
        parts.push(`尺寸 ${config.width}×${config.height}→${apply.width ?? config.width}×${apply.height ?? config.height}`);
    }
    if (apply.disableVibeIndexes.length) parts.push(`关闭 ${apply.disableVibeIndexes.length} 个超出的氛围`);
    const tail = apply.clearOverride ? '（表单改动点保存才生效；尺寸覆盖是全局快捷设置，已直接取消）' : '（只改了表单，点保存才生效）';
    const message = parts.length ? `已复位为免费配置：${parts.join('、')}${tail}` : '当前参数已经满足免费条件';
    const finalConfig = overridden && !apply.clearOverride
        ? result.config
        : { ...result.config, width: apply.width ?? (Number(config.width) || 0), height: apply.height ?? (Number(config.height) || 0) };
    return { ok: true, apply, message, notices: result.notices, config: finalConfig };
}

// ── DOM ────────────────────────────────────────────────────────────────

const bar = {
    initialized: false,
    data: null,
    view: resolveSubscriptionView(null, 'auto'),
    estimate: null,
    frame: 0,
    // 悬浮球尺寸快捷设置（宿主 INIT_DATA.settings.overrideSize / OVERRIDE_SIZE 下发）
    overrideSize: 'default',
};

const $ = id => (typeof document === 'undefined' ? null : document.getElementById(id));

function formModel() {
    const sel = $('nd_model_sel');
    return String(sel?.value === 'custom' ? $('nd_model')?.value : sel?.value || '').trim();
}

export function readFormPricingConfig() {
    return {
        model: formModel(),
        width: Number($('nd_width')?.value) || 0,
        height: Number($('nd_height')?.value) || 0,
        steps: Number($('nd_steps')?.value) || 0,
        sm: $('nd_sm')?.checked === true,
        sm_dyn: $('nd_sm_dyn')?.checked === true,
        n_samples: 1,
        vibes: window.NDVibePanel?.getPricingVibes?.() || null,
    };
}

function currentManualTier() {
    return $('nd_sub_tier')?.value || 'auto';
}

function setFree(node, free) {
    node?.classList.toggle('nd-free', free === true);
}

function markSelectOptions(select, predicate) {
    if (!select) return;
    let selectedFree = false;
    Array.from(select.options).forEach((option) => {
        const free = option.value !== 'custom' && predicate(option.value);
        if (option.classList.contains('nd-free') !== free) option.classList.toggle('nd-free', free);
        if (option.selected) selectedFree = free;
    });
    if (select.classList.contains('nd-free') !== selectedFree) select.classList.toggle('nd-free', selectedFree);
}

function applyFreeMarks(config) {
    const sub = bar.view.verified ? bar.view.subscription : null;
    const free = (field, value, cfg = config) => isFreeOption(field, value, cfg, sub);
    markSelectOptions($('nd_size_preset'), value => free('size', value));
    markSelectOptions($('nd_model_sel'), value => free('model', value));
    markSelectOptions($('nd_sampler_sel'), value => free('sampler', value));
    markSelectOptions($('nd_scheduler_sel'), value => free('noise_schedule', value));
    // config 是实际尺寸。覆盖生效时表单宽高不参与出图：宽高框不标绿，绿色标在覆盖提示条上。
    const sizeFree = free('size', { width: config.width, height: config.height });
    setFree($('nd_width'), sizeFree && !config.overridden);
    setFree($('nd_height'), sizeFree && !config.overridden);
    setFree($('nd_size_override'), sizeFree && config.overridden === true);
    setFree($('nd_steps'), free('steps', config.steps));
    ['nd_scale', 'nd_cfg_rescale', 'nd_seed'].forEach(id => setFree($(id), free(id === 'nd_seed' ? 'seed' : id === 'nd_scale' ? 'scale' : 'cfg_rescale', $(id)?.value)));
    ['nd_sm', 'nd_sm_dyn'].forEach(id => setFree($(id)?.closest('.check-row'), free('sm', true)));
    const range = document.querySelector('input[type="range"][data-nd-sync="nd_steps"]');
    if (range) {
        const rangeFree = free('steps', OPUS_FREE_MAX_STEPS);
        range.classList.toggle('nd-free-range', rangeFree);
        const min = Number(range.min) || 1;
        const max = Number(range.max) || 50;
        range.style.setProperty('--nd-free-pct', `${((OPUS_FREE_MAX_STEPS - min) / (max - min)) * 100}%`);
    }
}

/** 实际计价输入：表单参数 + 悬浮球尺寸覆盖。 */
export function readEffectivePricingConfig() {
    return effectivePricingConfig(readFormPricingConfig(), bar.overrideSize);
}

function renderOverrideNotice() {
    const notice = sizeOverrideNotice(bar.overrideSize);
    const box = $('nd_size_override');
    if (!box) return notice;
    box.classList.toggle('hidden', !notice.visible);
    const text = $('nd_size_override_text');
    if (text) text.textContent = notice.text;
    box.title = notice.visible ? '悬浮球 / 楼层菜单里选了固定尺寸，出图和计价都用这个尺寸，下面的宽高暂不生效' : '';
    return notice;
}

function render() {
    bar.frame = 0;
    renderOverrideNotice();
    const config = readEffectivePricingConfig();
    bar.view = resolveSubscriptionView(bar.data, currentManualTier());
    bar.estimate = estimateAnlasCost(config, { subscription: bar.view.subscription });
    const cost = describeCost(bar.estimate);

    const value = $('nd_cost_value');
    if (value) {
        value.textContent = cost.text;
        value.classList.remove('nd-cost-placeholder');
    }
    const slot = $('nd_cost_slot');
    if (slot) {
        slot.classList.toggle('is-free', cost.free);
        slot.classList.toggle('is-invalid', cost.invalid);
        const reasons = bar.estimate.freeReasons?.length ? `\n不免费的原因：${bar.estimate.freeReasons.join('、')}` : '';
        const sizeLine = config.overridden ? `\n按悬浮球尺寸覆盖 ${config.width}×${config.height} 计价` : '';
        slot.title = `生成 1 张预计消耗（客户端公式估算，以实际扣费为准）\n${bar.view.detail}${sizeLine}${reasons}`;
        slot.dataset.width = String(config.width);
        slot.dataset.height = String(config.height);
    }
    const chip = $('nd_tier_chip');
    if (chip) {
        chip.textContent = bar.view.label;
        chip.title = bar.view.detail;
    }
    const subStatus = $('nd_sub_status');
    if (subStatus) subStatus.textContent = bar.view.detail;
    const reset = $('nd_cost_reset');
    if (reset) {
        reset.disabled = !bar.view.verified;
        reset.title = bar.view.verified ? '把步数、尺寸等改成免费配置（不动提示词，不自动保存）' : '档位未知，无法确认免费条件';
    }
    applyFreeMarks(config);
}

function refresh() {
    if (typeof requestAnimationFrame !== 'function') { render(); return; }
    if (bar.frame) return;
    bar.frame = requestAnimationFrame(render);
}

/** 设置尺寸覆盖（宿主消息 / 乐观更新）。 */
function setOverrideSize(value) {
    const next = parseOverrideSize(value) ? String(value).trim().toLowerCase() : 'default';
    if (bar.overrideSize === next) { renderOverrideNotice(); return; }
    bar.overrideSize = next;
    render();
}

/** 取消覆盖：发给宿主走统一保存（同时刷新悬浮球菜单），本地先乐观隐藏，宿主会回发真实值。 */
function clearOverrideSize() {
    window.parent?.postMessage?.({ source: 'NovelDraw-Frame', type: 'SAVE_OVERRIDE_SIZE', overrideSize: 'default' }, parentOrigin());
    setOverrideSize('default');
}

function runReset() {
    const config = readFormPricingConfig();
    const status = $('nd_status');
    const plan = planFreeReset(config, resolveSubscriptionView(bar.data, currentManualTier()), { overrideSize: bar.overrideSize });
    const show = (state, text) => {
        if (typeof window.updateStatus === 'function') window.updateStatus(status, state, text);
        else if (status) status.textContent = text;
    };
    if (!plan.ok) { show('error', plan.message); return; }
    const { apply } = plan;
    if (apply.clearOverride) clearOverrideSize();
    if (apply.steps !== undefined && $('nd_steps')) $('nd_steps').value = String(apply.steps);
    if (apply.width !== undefined && $('nd_width')) $('nd_width').value = String(apply.width);
    if (apply.height !== undefined && $('nd_height')) $('nd_height').value = String(apply.height);
    if (apply.width !== undefined || apply.height !== undefined) window.updateSizePreset?.();
    apply.disableVibeIndexes.forEach(index => window.NDVibePanel?.setItemEnabledByIndex?.(index, false));
    window.syncNaiControls?.();
    $('view-params')?.dispatchEvent(new Event('change', { bubbles: true }));
    show('success', [plan.message, ...plan.notices].join('；'));
    render();
}

/** 生成按钮点击时调用；Promise 结果为 false 表示用户取消。savedPreset = 宿主实际要用的已保存预设。 */
async function confirmGenerate({ savedPreset } = {}) {
    render();
    const estimates = [bar.estimate];
    const models = [readFormPricingConfig().model];
    if (savedPreset) {
        estimates.push(estimateAnlasCost(presetPricingConfig(savedPreset, bar.overrideSize), { subscription: bar.view.subscription }));
        models.push(String(savedPreset.params?.model || ''));
    }
    const check = needsGenerateConfirm({ estimates, models });
    if (!check.confirm) return true;
    return xbConfirm(`- ${check.reasons.join('\n- ')}`, {
        title: '生成前确认', detail: '生成用的是已保存的预设；表单改动需先保存。', okLabel: '仍要生成', icon: 'ri-coins-line',
    });
}

function init() {
    if (bar.initialized || typeof document === 'undefined') return;
    bar.initialized = true;
    const view = $('view-params');
    view?.addEventListener('input', refresh);
    view?.addEventListener('change', refresh);
    document.addEventListener('nd:vibes-change', refresh);
    $('nd_cost_reset')?.addEventListener('click', runReset);
    $('nd_size_override_clear')?.addEventListener('click', clearOverrideSize);
    $('nd_sub_tier')?.addEventListener('change', () => {
        window.parent?.postMessage?.({ source: 'NovelDraw-Frame', type: 'SAVE_SUB_TIER', subTier: currentManualTier() }, parentOrigin());
        render();
        document.dispatchEvent(new CustomEvent('nd:subscription-change'));
    });
    window.addEventListener('message', (event) => {
        if (event.origin !== parentOrigin() || event.source !== window.parent) return;
        const data = event.data;
        if (!data || data.source !== HOST_SOURCE) return;
        if (data.type === 'SUBSCRIPTION_DATA') handleSubscriptionData(data);
        else if (data.type === 'INIT_DATA') setOverrideSize(data.settings?.overrideSize);
        else if (data.type === 'OVERRIDE_SIZE') setOverrideSize(data.overrideSize);
    });
    render();
}

function handleSubscriptionData(data) {
    // 消息外层的 source 字段被消息协议占用（'XBDraw-NovelDraw'），档位来源在 subscriptionSource 里。
    bar.data = { source: data.subscriptionSource || 'unknown', subscription: data.subscription || null };
    if (data.manualTier && $('nd_sub_tier') && $('nd_sub_tier').value !== data.manualTier) $('nd_sub_tier').value = data.manualTier;
    render();
    document.dispatchEvent(new CustomEvent('nd:subscription-change'));
}

function parentOrigin() {
    try { return new URL(document.referrer).origin; } catch { return window.location.origin; }
}

if (typeof window !== 'undefined' && typeof document !== 'undefined') {
    window.NDCostBar = {
        init,
        refresh,
        getSubscription: () => (bar.view.verified ? bar.view.subscription : null),
        getEstimate: () => bar.estimate,
        getOverrideSize: () => bar.overrideSize,
        setOverrideSize,
        confirmGenerate,
    };
}
