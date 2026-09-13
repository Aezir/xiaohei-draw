// novel-effective-size.js
// 「实际出图尺寸」的唯一口径（纯函数，node 可测，不 import 酒馆模块）。
// 悬浮球 / 楼层菜单的尺寸快捷设置 settings.overrideSize 在编译请求时会盖掉参数预设的宽高（compiler.js）。
// 设置页提示条、底栏计价、复位、生成前确认都从这里取尺寸，保证页面显示的就是真正发出去的尺寸。

export const OVERRIDE_SIZE_VALUES = Object.freeze(['832x1216', '1216x832', '1024x1024', '768x1280', '1280x768']);

/** '768x1280' → { width: 768, height: 1280 }；'default' / 空 / 非白名单 → null。 */
export function parseOverrideSize(overrideSize) {
    const text = String(overrideSize ?? '').trim().toLowerCase();
    if (!OVERRIDE_SIZE_VALUES.includes(text)) return null;
    const [width, height] = text.split('x').map(Number);
    return { width, height };
}

export function isSizeOverridden(overrideSize) {
    return parseOverrideSize(overrideSize) !== null;
}

/** 预设（或表单）宽高 + 覆盖值 → 实际尺寸。overridden=true 时宽高来自覆盖。 */
export function resolveEffectiveSize(base = {}, overrideSize = 'default') {
    const override = parseOverrideSize(overrideSize);
    if (override) return { ...override, overridden: true };
    return { width: Number(base?.width) || 0, height: Number(base?.height) || 0, overridden: false };
}

/** 计价输入（含 width/height）套上覆盖，返回新对象，不改原对象。 */
export function applyEffectiveSize(config = {}, overrideSize = 'default') {
    const { width, height } = resolveEffectiveSize(config, overrideSize);
    return { ...config, width, height };
}

/** 设置页分辨率区提示条：visible + 文案。 */
export function sizeOverrideNotice(overrideSize) {
    const override = parseOverrideSize(overrideSize);
    if (!override) return { visible: false, text: '', width: 0, height: 0 };
    return { visible: true, text: `悬浮球尺寸覆盖中：${override.width} × ${override.height}`, ...override };
}
