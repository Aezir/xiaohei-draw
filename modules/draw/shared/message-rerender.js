// 重渲染一个聊天楼层的唯一入口。纯逻辑，宿主函数注入，便于单测。
//
// 为什么不能自己 $('.mes_text').html(messageFormatting(...))：
// TavernHelper（酒馆助手）只在 CHARACTER_MESSAGE_RENDERED / USER_MESSAGE_RENDERED /
// MESSAGE_UPDATED / MESSAGE_SWIPED 时把 ```html 代码块换成 iframe。插件整块重写楼层却不发事件，
// MVU 变量卡的状态栏就停在一段原始代码上，直到刷新页面。
// 这里走酒馆自己的 updateMessageBlock（认 extra.display_text、补代码块复制按钮、媒体附件），
// 然后发 MESSAGE_UPDATED 让酒馆助手重新渲染。
//
// 同一楼层同一轮里的多次请求合并成一次渲染 + 一次事件，用最后一次请求的文本。
// 本模块自己发出的 MESSAGE_UPDATED 在派发期间 isSelfUpdate(messageId) 为 true，
// 插件内部的监听器据此跳过「整楼重建」，避免 重写 → 事件 → 重写 的循环。

function buildRenderTarget(message, text) {
    if (text === undefined || text === null || String(text) === message?.mes) return message;
    // 规划中的文本（带占位符）还没写进 message.mes，只拿来显示：浅拷贝一份，
    // 去掉 display_text 让 updateMessageBlock 显示这份文本；原 message 不动，也不会被保存。
    const extra = message?.extra && typeof message.extra === 'object' ? { ...message.extra } : message?.extra;
    if (extra && typeof extra === 'object') delete extra.display_text;
    return { ...message, mes: String(text), extra };
}

export function createMessageRerenderer({
    loadHost,
    isEditing = () => false,
    schedule = callback => queueMicrotask(callback),
    // 自愈：渲染后隔 retryDelayMs 查一次，needsRenderRetry(messageId) 为 true（状态栏还是代码）就再发一次 MESSAGE_UPDATED，最多 maxRetries 次
    needsRenderRetry = () => false,
    retryDelayMs = 500,
    maxRetries = 2,
    setTimer = (callback, ms) => setTimeout(callback, ms),
} = {}) {
    const entries = new Map();
    const selfDepth = new Map();

    async function emitAsSelf(host, key) {
        selfDepth.set(key, (selfDepth.get(key) || 0) + 1);
        try {
            await host.emitMessageUpdated(key);
        } finally {
            const depth = (selfDepth.get(key) || 1) - 1;
            if (depth > 0) selfDepth.set(key, depth);
            else selfDepth.delete(key);
        }
    }

    function scheduleHeal(key, attempt = 0) {
        if (attempt >= maxRetries) return;
        setTimer(async () => {
            try {
                // 期间又有新的渲染请求或用户在编辑：交给那一轮
                if (entries.has(key) || isEditing(key) || !needsRenderRetry(key)) return;
                await emitAsSelf(await loadHost(), key);
                scheduleHeal(key, attempt + 1);
            } catch {
                /* 自愈失败不影响主流程 */
            }
        }, retryDelayMs);
    }

    const scheduleFlush = (key, entry) => {
        if (entry.scheduled || entry.running) return;
        entry.scheduled = true;
        schedule(() => { void flush(key); });
    };

    async function flush(key) {
        const entry = entries.get(key);
        if (!entry) return;
        entry.scheduled = false;
        entry.running = true;
        const request = entry.request;
        const waiters = entry.waiters;
        entry.request = null;
        entry.waiters = [];

        let rendered = false;
        let failure = null;
        try {
            const host = await loadHost();
            if (request && !isEditing(key)) {
                host.updateMessageBlock(key, buildRenderTarget(request.message, request.text));
                await emitAsSelf(host, key);
                rendered = true;
                scheduleHeal(key);
            }
        } catch (error) {
            failure = error;
        }

        entry.running = false;
        for (const waiter of waiters) {
            if (failure) waiter.reject(failure);
            else waiter.resolve(rendered);
        }
        if (entry.request) scheduleFlush(key, entry);
        else entries.delete(key);
    }

    return {
        /**
         * @param {number} messageId
         * @param {object} message 活动楼层的 chat 对象
         * @param {{ text?: string }} [options] text 缺省 = 按 message 本身渲染；给了且不同于 message.mes = 只显示这份文本
         * @returns {Promise<boolean>} 实际渲染了返回 true；楼层正在编辑时不渲染返回 false
         */
        rerender(messageId, message, { text } = {}) {
            const key = Number(messageId);
            if (!Number.isInteger(key) || key < 0 || !message) return Promise.resolve(false);
            let entry = entries.get(key);
            if (!entry) {
                entry = { request: null, waiters: [], scheduled: false, running: false };
                entries.set(key, entry);
            }
            entry.request = { message, text };
            const promise = new Promise((resolve, reject) => entry.waiters.push({ resolve, reject }));
            scheduleFlush(key, entry);
            return promise;
        },
        isSelfUpdate(messageId) {
            return (selfDepth.get(Number(messageId)) || 0) > 0;
        },
    };
}
