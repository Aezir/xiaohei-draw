// MVU（MagVarUpdate）变量卡的「楼层落定」判断。纯逻辑，宿主对象全部注入，便于单测。
//
// 实测 MVU bundle（artifact/bundle.js）的行为：
// - 事件经 TavernHelper eventEmit 发到酒馆 eventSource：mag_variable_update_started / mag_variable_update_ended，
//   参数是变量对象，不带楼层号；
// - AI 回复后（MESSAGE_RECEIVED）解析 <UpdateVariable>，或另发一次「额外模型解析」请求，
//   结束后才用 setChatMessages 改写 message.mes：末尾补 "\n\n<StatusPlaceHolderImpl/>"、
//   额外模型模式先追加 <UpdateVariable> 块，随后 refresh:'affected' 重渲染楼层；
// - window.Mvu.isDuringExtraAnalysis() 表示额外模型解析正在进行。
// 所以「酒馆停止生成」不等于「正文定稿」，自动配图要等 MVU 这一轮写完。

export const MVU_DEFAULT_EVENTS = Object.freeze({
    VARIABLE_UPDATE_STARTED: 'mag_variable_update_started',
    VARIABLE_UPDATE_ENDED: 'mag_variable_update_ended',
});

const STATUS_PLACEHOLDER_REGEX = /<StatusPlaceHolderImpl\s*\/?>/i;

function readMvuEventNames(mvu) {
    const events = mvu && typeof mvu === 'object' ? mvu.events : null;
    return {
        started: String(events?.VARIABLE_UPDATE_STARTED || MVU_DEFAULT_EVENTS.VARIABLE_UPDATE_STARTED),
        ended: String(events?.VARIABLE_UPDATE_ENDED || MVU_DEFAULT_EVENTS.VARIABLE_UPDATE_ENDED),
    };
}

export function createMvuActivityTracker({
    getMvu = () => globalThis.Mvu,
    eventSource = null,
    now = () => Date.now(),
    staleBusyMs = 60000,
} = {}) {
    let started = 0;
    let ended = 0;
    let lastStartAt = 0;
    let lastActivityAt = 0;
    let activityCount = 0;
    const bindings = [];

    const safeMvu = () => {
        try {
            return getMvu?.() || null;
        } catch {
            return null;
        }
    };
    const onStarted = () => {
        started += 1;
        activityCount += 1;
        lastStartAt = now();
        lastActivityAt = lastStartAt;
    };
    const onEnded = () => {
        ended += 1;
        activityCount += 1;
        if (ended > started) started = ended;
        lastActivityAt = now();
    };
    const bindName = (name, handler) => {
        if (!eventSource?.on || bindings.some(item => item.name === name && item.handler === handler)) return;
        eventSource.on(name, handler);
        bindings.push({ name, handler });
    };

    return {
        // MVU 可能比本扩展晚加载：默认事件名先挂上，之后每次查询时补挂卡里声明的事件名。
        start() {
            const names = readMvuEventNames(safeMvu());
            bindName(MVU_DEFAULT_EVENTS.VARIABLE_UPDATE_STARTED, onStarted);
            bindName(MVU_DEFAULT_EVENTS.VARIABLE_UPDATE_ENDED, onEnded);
            bindName(names.started, onStarted);
            bindName(names.ended, onEnded);
        },
        stop() {
            for (const { name, handler } of bindings.splice(0)) {
                try {
                    eventSource?.removeListener?.(name, handler);
                } catch { /* 宿主已卸载 */ }
            }
        },
        isPresent() {
            return !!safeMvu();
        },
        isBusy() {
            const pending = started > ended && now() - lastStartAt < staleBusyMs;
            if (pending) return true;
            try {
                return safeMvu()?.isDuringExtraAnalysis?.() === true;
            } catch {
                return false;
            }
        },
        getLastActivityAt: () => lastActivityAt,
        getActivityCount: () => activityCount,
    };
}

/**
 * 等某一楼层的正文落定。满足全部条件才算落定：
 * 1. MVU 不忙（没有进行中的变量更新 / 额外模型解析）；
 * 2. 正文连续 stableMs 没变化（从开始等、或最近一次 MVU 活动算起）；
 * 3. 有 MVU 但正文还没有 <StatusPlaceHolderImpl/>：再多给 mvuGraceMs，MVU 通常马上会补上。
 * 超过 timeoutMs 直接放行（返回 timeout），不会无限等。
 * getText 返回 null / undefined 表示楼层已不在（换聊天、被删），立即返回 missing。
 */
export async function waitForMessageSettled({
    getText,
    tracker = null,
    stableMs = 800,
    timeoutMs = 20000,
    pollMs = 100,
    mvuGraceMs = 3000,
    signal = null,
    now = () => Date.now(),
    sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
} = {}) {
    const startedAt = now();
    let lastText = getText?.();
    if (lastText === null || lastText === undefined) return { status: 'missing', waitedMs: 0 };
    let lastChangeAt = startedAt;

    for (;;) {
        const current = now();
        const waitedMs = current - startedAt;
        if (signal?.aborted) return { status: 'aborted', waitedMs };
        const text = getText?.();
        if (text === null || text === undefined) return { status: 'missing', waitedMs };
        if (text !== lastText) {
            lastText = text;
            lastChangeAt = current;
        }
        const activityAt = Number(tracker?.getLastActivityAt?.()) || 0;
        if (activityAt > lastChangeAt) lastChangeAt = activityAt;

        const busy = tracker?.isBusy?.() === true;
        const awaitingPlaceholder = tracker?.isPresent?.() === true
            && !STATUS_PLACEHOLDER_REGEX.test(String(text))
            && current - Math.max(startedAt, activityAt) < mvuGraceMs;
        if (!busy && !awaitingPlaceholder && current - lastChangeAt >= stableMs) {
            return { status: 'settled', waitedMs };
        }
        if (waitedMs >= timeoutMs) return { status: 'timeout', waitedMs };
        await sleep(pollMs);
    }
}
