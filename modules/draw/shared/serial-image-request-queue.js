function defaultAbortError() {
    const error = new Error('已取消');
    error.name = 'AbortError';
    return error;
}

function defaultWaitForCooldown(duration, {
    deadline,
    documentRef = globalThis.document,
    now = Date.now,
} = {}) {
    const cooldownDeadline = Number.isFinite(deadline)
        ? deadline
        : now() + normalizeCooldown(duration);
    return new Promise((resolve) => {
        let timerId = null;
        let settled = false;

        const finish = () => {
            if (settled) return;
            settled = true;
            if (timerId !== null) clearTimeout(timerId);
            documentRef?.removeEventListener?.('visibilitychange', handleVisibilityChange);
            resolve();
        };
        const schedule = () => {
            if (settled) return;
            if (timerId !== null) clearTimeout(timerId);
            const remaining = cooldownDeadline - now();
            if (remaining <= 0) {
                finish();
                return;
            }
            timerId = setTimeout(schedule, remaining);
        };
        const handleVisibilityChange = () => {
            if (documentRef?.visibilityState === 'visible') schedule();
        };

        documentRef?.addEventListener?.('visibilitychange', handleVisibilityChange);
        schedule();
    });
}

function normalizeCooldown(value) {
    const duration = Number(value);
    return Number.isFinite(duration) && duration > 0 ? duration : 0;
}

/**
 * 创建供应商级串行图片请求队列。
 *
 * 请求结果会立即交还调用者，但下一个供应商请求必须等待本体冷却结束；
 * 消费者取消只能撤销自己的排队请求，不能跳过已经开始的安全冷却。
 * batchKey 是单次批量生成的临时身份，仅用于区分“同批冷却”和“其他任务排队”。
 *
 * lockManager（默认 navigator.locks）让多个标签页共用一把排他锁，避免同一账号并发请求；
 * 没有 Web Locks 的环境传 null 或自动退回页内串行。
 */
export const DEFAULT_IMAGE_REQUEST_LOCK_NAME = 'xiaohei-draw:nai-request';

export function createSerialImageRequestQueue({
    createAbortError = defaultAbortError,
    documentRef = globalThis.document,
    getCooldownMs = () => 0,
    lockManager = globalThis.navigator?.locks ?? null,
    lockName = DEFAULT_IMAGE_REQUEST_LOCK_NAME,
    now = Date.now,
    waitForCooldown = defaultWaitForCooldown,
} = {}) {
    const pending = [];
    let active = null;
    let sequence = 0;

    function notify(callback, payload) {
        try {
            callback?.(payload);
        } catch (error) {
            console.error('[DrawRequestQueue] 状态回调失败:', error);
        }
    }

    function detachAbort(item) {
        if (item.abortHandler && item.signal) {
            item.signal.removeEventListener('abort', item.abortHandler);
            item.abortHandler = null;
        }
    }

    function notifyQueued() {
        pending.forEach((item, index) => {
            const ahead = (active ? 1 : 0) + index;
            const waitingForOwnCooldown = index === 0
                && active?.phase === 'cooldown'
                && item.batchKey !== undefined
                && item.batchKey === active.batchKey;
            if (waitingForOwnCooldown) {
                const remaining = active.cooldownUntil - now();
                if (item.queuePhase === 'queued' && remaining > 0) {
                    item.queuePhase = 'cooldown';
                    notify(item.onCooldown, { duration: remaining });
                }
                return;
            }
            if (ahead > 0) {
                item.queuePhase = 'queued';
                notify(item.onQueued, { ahead, position: ahead + 1 });
            }
        });
    }

    function pump() {
        if (active || pending.length === 0) return;

        const item = pending.shift();
        active = item;
        item.phase = 'running';
        item.queuePhase = null;
        detachAbort(item);
        notifyQueued();

        void (async () => {
            if (!lockManager || typeof lockManager.request !== 'function') {
                await execute(item);
            } else {
                await executeWithCrossTabLock(item);
            }

            if (active === item) {
                item.phase = 'complete';
                item.cooldownUntil = 0;
                active = null;
            }
            notifyQueued();
            pump();
        })();
    }

    /**
     * 跨标签页互斥：同名 Web Lock 同一时刻只给一个页面。
     * 「请求 + 冷却」整段都在锁里，别的标签页只能等冷却结束才发下一个请求。
     * 锁接口本身异常（不是取消）时退回页内串行，不让生成功能整个坏掉。
     */
    async function executeWithCrossTabLock(item) {
        if (item.signal?.aborted) {
            item.reject(createAbortError());
            return;
        }
        let entered = false;
        const runLocked = async () => {
            entered = true;
            await execute(item);
        };
        try {
            const acquired = await lockManager.request(
                lockName,
                { mode: 'exclusive', ifAvailable: true },
                async (lock) => {
                    if (!lock) return false;
                    await runLocked();
                    return true;
                },
            );
            if (acquired) return;
        } catch (caught) {
            if (entered) return;
            console.warn('[DrawRequestQueue] 跨标签页锁不可用，退回页内串行:', caught);
            await execute(item);
            return;
        }

        // 锁被别的标签页占着：报排队，等它连冷却一起结束。
        item.phase = 'waiting-lock';
        item.queuePhase = 'queued';
        notify(item.onQueued, { ahead: 1, position: 2, crossTab: true });
        try {
            const options = { mode: 'exclusive' };
            if (item.signal) options.signal = item.signal;
            await lockManager.request(lockName, options, runLocked);
        } catch (caught) {
            if (entered) return;
            if (item.signal?.aborted || caught?.name === 'AbortError') {
                item.phase = 'cancelled';
                item.reject(createAbortError());
                return;
            }
            console.warn('[DrawRequestQueue] 等待跨标签页锁失败，退回页内串行:', caught);
            await execute(item);
        }
    }

    // 执行一次请求并等完冷却；从不抛错，结果/错误都交给 item.resolve / item.reject。
    async function execute(item) {
        let result;
        let error = null;
        let started = false;
        try {
            item.phase = 'running';
            item.queuePhase = null;
            if (item.signal?.aborted) throw createAbortError();
            started = true;
            notify(item.onStart);
            result = await item.run();
        } catch (caught) {
            error = caught;
        }

        const cooldown = started ? normalizeCooldown(getCooldownMs()) : 0;
        if (cooldown > 0) {
            item.phase = 'cooldown';
            item.cooldownUntil = now() + cooldown;
            notify(item.onCooldown, { duration: cooldown });
        }

        if (error) item.reject(error);
        else item.resolve(result);

        if (cooldown > 0) {
            await waitForCooldown(cooldown, {
                deadline: item.cooldownUntil,
                documentRef,
                now,
            });
        }
    }

    function enqueue(run, { signal, batchKey, onQueued, onStart, onCooldown } = {}) {
        return new Promise((resolve, reject) => {
            if (signal?.aborted) {
                reject(createAbortError());
                return;
            }

            const item = {
                id: ++sequence,
                run,
                signal,
                batchKey,
                onQueued,
                onStart,
                onCooldown,
                resolve,
                reject,
                abortHandler: null,
                phase: 'pending',
                queuePhase: null,
                cooldownUntil: 0,
            };

            item.abortHandler = () => {
                if (active === item) return;
                const index = pending.indexOf(item);
                if (index < 0) return;
                pending.splice(index, 1);
                detachAbort(item);
                item.phase = 'cancelled';
                item.queuePhase = null;
                notifyQueued();
                reject(createAbortError());
            };
            signal?.addEventListener('abort', item.abortHandler, { once: true });

            pending.push(item);
            notifyQueued();
            pump();
        });
    }

    function clear() {
        const queued = pending.splice(0);
        queued.forEach((item) => {
            detachAbort(item);
            item.phase = 'cancelled';
            item.queuePhase = null;
            item.reject(createAbortError());
        });
    }

    return {
        clear,
        enqueue,
    };
}
