// novel-cost-rule.js
// 「生成前要不要二次确认」的唯一口径（纯函数，node 可测）。
// 设置页底栏（ui/nd-cost-bar.js，原样 re-export）和宿主（novel-draw.js：编辑提示词后重新生成）共用。
// 规则：估算不为 0（含档位未知 / 手动档位导致的「约」）、或参数超限，都要先确认。模型本身不再是理由（V5 的「测试期间」约定已撤）。

import { estimateAnlasCost } from './novel-anlas-pricing.js';
import { resolveEffectiveSize } from './novel-effective-size.js';

export function isV5ModelId(model) {
    return /^nai-diffusion-5/.test(String(model || '').trim());
}

/** 底栏费用文字。 */
export function describeCost(estimate) {
    if (!estimate) return { text: '—', free: false, approx: true, invalid: false };
    if (estimate.invalid) return { text: '参数超出上限', free: false, approx: false, invalid: true };
    const approx = estimate.confidence === 'approx';
    const free = estimate.isFree === true && !approx;
    return { text: `${approx ? '约 ' : ''}${estimate.total}`, free, approx, invalid: false };
}

/** 生成前是否需要二次确认：只看会不会花 Anlas（不确定免费也算），不看模型。models 参数保留给老调用方。 */
export function needsGenerateConfirm({ estimates = [] } = {}) {
    const reasons = [];
    for (const estimate of estimates) {
        const cost = describeCost(estimate);
        if (cost.invalid) reasons.push('参数超出上限');
        else if (!cost.free) reasons.push(cost.approx ? `档位或免费条件不确定，预计 ${cost.text} Anlas` : `预计消耗 ${cost.text} Anlas`);
    }
    return { confirm: reasons.length > 0, reasons: [...new Set(reasons)] };
}

/**
 * 已保存的参数预设 → 计价输入。保存的预设里没有编码状态：有启用的氛围就当作未知（approx）。
 * overrideSize = 悬浮球尺寸快捷设置；不是 'default' 时按覆盖尺寸计价（和实际请求一致）。
 */
export function presetPricingConfig(preset, overrideSize = 'default') {
    const params = preset?.params || {};
    const vibes = preset?.vibes;
    const size = resolveEffectiveSize(params, overrideSize);
    return {
        model: String(params.model || '').trim(),
        width: size.width,
        height: size.height,
        steps: Number(params.steps) || 0,
        sm: params.sm === true,
        sm_dyn: params.sm_dyn === true,
        n_samples: 1,
        vibes: vibes ? { ...vibes, items: (vibes.items || []).map(item => ({ ...item, encoded: undefined })) } : null,
    };
}

/**
 * 宿主用：按已保存的参数预设判断重新生成前要不要确认。
 * subscription 为空（档位没查到）时估算是 approx，一律要确认。
 */
export function presetGenerateConfirm(preset, subscription = null, overrideSize = 'default') {
    const estimate = estimateAnlasCost(presetPricingConfig(preset, overrideSize), { subscription });
    return { ...needsGenerateConfirm({ estimates: [estimate], models: [String(preset?.params?.model || '')] }), estimate };
}
