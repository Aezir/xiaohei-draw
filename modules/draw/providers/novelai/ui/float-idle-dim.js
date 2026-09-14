// float-idle-dim.js
// 全局悬浮球闲置变淡：闲置 delay 毫秒后加 .is-dim（CSS 负责半透明 + 过渡）。
// 悬停 / 按下 / 拖动 / 菜单展开 / 详情弹出 / 非 idle 状态时立刻恢复；这些结束后重新计时。
// 不依赖酒馆模块，node 测试可直接引用。

export const DIM_CLASS = 'is-dim';
export const IDLE_DIM_DELAY = 3000;
const BUSY_CLASSES = ['expanded', 'show-detail', 'working', 'cooldown', 'success', 'partial', 'error'];

/**
 * @param {object} opts
 * @param {HTMLElement} opts.el 悬浮球根节点
 * @param {() => boolean} [opts.isBusy] 额外的"忙"判断（比如正在拖动）
 * @param {number} [opts.delay]
 * @param {{ setTimeout: Function, clearTimeout: Function }} [opts.timers]
 * @param {typeof MutationObserver} [opts.MutationObserverImpl]
 */
export function createIdleDimmer({
    el,
    isBusy = () => false,
    delay = IDLE_DIM_DELAY,
    timers = globalThis,
    MutationObserverImpl = globalThis.MutationObserver,
} = {}) {
    let timer = null;
    let hovered = false;
    let destroyed = false;

    const clearTimer = () => {
        if (timer !== null) {
            timers.clearTimeout(timer);
            timer = null;
        }
    };

    const busy = () => hovered || !!isBusy() || BUSY_CLASSES.some(c => el.classList.contains(c));

    // 只在类名真的要变时才动 classList：浏览器里 add/remove 即使没改变内容也会重写 class 属性、
    // 产生一次 MutationObserver 记录，而下面的 observer 又会调用 refresh()，
    // 「忙」状态下就会 remove → 记录 → refresh → remove … 无限循环，把整个页面卡死。
    const setDim = (on) => {
        if (el.classList.contains(DIM_CLASS) === on) return;
        if (on) el.classList.add(DIM_CLASS);
        else el.classList.remove(DIM_CLASS);
    };

    function refresh() {
        if (destroyed) return;
        if (busy()) {
            clearTimer();
            setDim(false);
            return;
        }
        if (el.classList.contains(DIM_CLASS) || timer !== null) return;
        timer = timers.setTimeout(() => {
            timer = null;
            if (!destroyed && !busy()) setDim(true);
        }, delay);
    }

    function wake() {
        if (destroyed) return;
        clearTimer();
        setDim(false);
        refresh();
    }

    const onEnter = () => { hovered = true; wake(); };
    const onLeave = () => { hovered = false; refresh(); };
    const onDown = () => wake();
    const onUp = () => refresh();

    const listeners = [
        ['pointerenter', onEnter],
        ['pointerleave', onLeave],
        ['pointerdown', onDown],
        ['pointerup', onUp],
        ['pointercancel', onUp],
    ];
    listeners.forEach(([type, fn]) => el.addEventListener?.(type, fn));

    // 类名变化（展开菜单、状态切换等）统一在这里接住，不用在每个改类名的地方手动通知
    let observer = null;
    if (typeof MutationObserverImpl === 'function') {
        observer = new MutationObserverImpl(() => refresh());
        observer.observe(el, { attributes: true, attributeFilter: ['class'] });
    }

    refresh();

    return {
        refresh,
        wake,
        isDimmed: () => el.classList.contains(DIM_CLASS),
        destroy() {
            destroyed = true;
            clearTimer();
            observer?.disconnect();
            observer = null;
            listeners.forEach(([type, fn]) => el.removeEventListener?.(type, fn));
            el.classList.remove(DIM_CLASS);
        },
    };
}
