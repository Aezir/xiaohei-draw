import test from 'node:test';
import assert from 'node:assert/strict';

const { createSerialImageRequestQueue } = await import('../../modules/draw/shared/serial-image-request-queue.js');

// 模拟 navigator.locks：同名排他锁 FIFO，支持 ifAvailable 与 signal。
function createFakeLockManager() {
    let held = false;
    const waiters = [];
    const abortError = () => Object.assign(new Error('aborted'), { name: 'AbortError' });

    async function runHeld(callback) {
        held = true;
        try {
            return await callback({ name: 'lock', mode: 'exclusive' });
        } finally {
            const next = waiters.shift();
            if (next) next(); // 直接交给下一个等待者，中间不空出锁
            else held = false;
        }
    }

    return {
        get held() { return held; },
        async request(name, options, callback) {
            if (options.ifAvailable) {
                if (held || waiters.length) return callback(null);
                return runHeld(callback);
            }
            const { signal } = options;
            if (signal?.aborted) throw abortError();
            if (!held && waiters.length === 0) return runHeld(callback);
            await new Promise((resolve, reject) => {
                const entry = () => {
                    signal?.removeEventListener('abort', onAbort);
                    resolve();
                };
                const onAbort = () => {
                    const index = waiters.indexOf(entry);
                    if (index >= 0) waiters.splice(index, 1);
                    reject(abortError());
                };
                signal?.addEventListener('abort', onAbort, { once: true });
                waiters.push(entry);
            });
            return runHeld(callback);
        },
    };
}

const tick = (ms = 5) => new Promise(resolve => setTimeout(resolve, ms));

function makeQueue(lockManager, cooldown = 10) {
    return createSerialImageRequestQueue({
        documentRef: null,
        getCooldownMs: () => cooldown,
        lockManager,
    });
}

test('two queue instances (two tabs) sharing a lock never run concurrently, cooldown included', async () => {
    const locks = createFakeLockManager();
    const tabA = makeQueue(locks);
    const tabB = makeQueue(locks);
    let running = 0;
    let maxRunning = 0;
    const log = [];
    const job = (label) => async () => {
        running++;
        maxRunning = Math.max(maxRunning, running);
        log.push(`start:${label}`);
        await tick(8);
        running--;
        log.push(`end:${label}`);
        return label;
    };

    const queuedEvents = [];
    const results = await Promise.all([
        tabA.enqueue(job('a1')),
        tabB.enqueue(job('b1'), { onQueued: data => queuedEvents.push(data) }),
        tabA.enqueue(job('a2')),
        tabB.enqueue(job('b2')),
    ]);

    assert.deepEqual(results, ['a1', 'b1', 'a2', 'b2']);
    assert.equal(maxRunning, 1);
    assert.ok(queuedEvents.some(event => event.crossTab === true), 'waiting on another tab reports queued');
    // 结果先交还，最后一个请求的冷却结束后才放锁
    assert.equal(locks.held, true);
    await tick(30);
    assert.equal(locks.held, false);
});

test('cooldown keeps the lock: other tab starts only after cooldown ends', async () => {
    const locks = createFakeLockManager();
    const tabA = makeQueue(locks, 40);
    const tabB = makeQueue(locks, 0);
    let aResolvedAt = 0;
    let bStartedAt = 0;
    const a = tabA.enqueue(async () => 'a').then(value => { aResolvedAt = Date.now(); return value; });
    await tick(1);
    const b = tabB.enqueue(async () => { bStartedAt = Date.now(); return 'b'; });
    await Promise.all([a, b]);
    assert.ok(bStartedAt - aResolvedAt >= 30, `B started ${bStartedAt - aResolvedAt}ms after A resolved`);
});

test('abort while waiting for another tab\'s lock rejects and never runs', async () => {
    const locks = createFakeLockManager();
    const tabA = makeQueue(locks, 0);
    const tabB = makeQueue(locks, 0);
    let releaseA;
    const a = tabA.enqueue(() => new Promise(resolve => { releaseA = resolve; }));
    await tick(1);

    const controller = new AbortController();
    let bRan = false;
    const b = tabB.enqueue(async () => { bRan = true; }, { signal: controller.signal });
    await tick(1);
    controller.abort();
    await assert.rejects(b, error => error.name === 'AbortError');

    releaseA('done');
    assert.equal(await a, 'done');
    await tick(1);
    assert.equal(bRan, false);
    assert.equal(locks.held, false);

    // B 那边的队列取消后还能继续用
    assert.equal(await tabB.enqueue(async () => 'after'), 'after');
});

test('falls back to in-page serial when lock manager is missing or broken', async () => {
    const noLocks = makeQueue(null, 0);
    assert.equal(await noLocks.enqueue(async () => 1), 1);

    const broken = makeQueue({ request: async () => { throw new Error('SecurityError'); } }, 0);
    const originalWarn = console.warn;
    console.warn = () => {};
    try {
        assert.equal(await broken.enqueue(async () => 2), 2);
    } finally {
        console.warn = originalWarn;
    }
});
