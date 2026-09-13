// 缩略图懒加载队列（G1，接 G0 留下的「限流暂停重试」）：
//   - 同一 id 只下一次；最多 concurrency 个并发（画廊同为 4）。
//   - 遇到 403 / 429（GitHub 限流）整个队列暂停 pauseMs（画廊同为 30 秒），这张图放回队头，暂停结束后继续；
//     同一张图连续限流 maxRetries 次才失败。其他错误直接失败，并允许之后重新请求。
// load(id) → Promise<Uint8Array|null>；now / setTimer 可注入（测试用假时钟）。
export const RATE_LIMIT_STATUSES = Object.freeze([403, 429]);

export function createPausingThumbQueue(load, {
    concurrency = 4, pauseMs = 30000, maxRetries = 3,
    now = () => Date.now(), setTimer = (fn, ms) => setTimeout(fn, ms), onPause,
} = {}) {
    if (typeof load !== 'function') throw new TypeError('load 必须是函数');
    const jobs = new Map();
    const waiting = [];
    let running = 0, pausedUntil = 0, timer = false, disposed = false;

    const pump = () => {
        if (disposed) return;
        const wait = pausedUntil - now();
        if (wait > 0) {
            if (!timer) { timer = true; setTimer(() => { timer = false; pump(); }, wait); }
            return;
        }
        while (running < concurrency && waiting.length) {
            const job = waiting.shift();
            running++;
            Promise.resolve().then(() => load(job.id)).then((v) => {
                running--; job.ok(v); pump();
            }, (e) => {
                running--;
                const status = Number(e && e.status);
                if (RATE_LIMIT_STATUSES.includes(status) && job.tries < maxRetries) {
                    job.tries++;
                    pausedUntil = Math.max(pausedUntil, now() + pauseMs);
                    waiting.unshift(job);
                    if (onPause) onPause({ id: job.id, status, until: pausedUntil });
                } else {
                    jobs.delete(job.id);
                    job.no(e);
                }
                pump();
            });
        }
    };

    return {
        get(id) {
            if (!jobs.has(id)) jobs.set(id, new Promise((ok, no) => { waiting.push({ id, ok, no, tries: 0 }); pump(); }));
            return jobs.get(id);
        },
        /** 翻页 / 换筛选时丢掉还没开始的请求（已在下载的照常完成） */
        clearWaiting() {
            for (const job of waiting.splice(0)) { jobs.delete(job.id); job.no(Object.assign(new Error('已取消'), { code: 'cancel' })); }
        },
        dispose() { disposed = true; this.clearWaiting(); },
        get running() { return running; },
        get waiting() { return waiting.length; },
        get pausedUntil() { return pausedUntil; },
    };
}
