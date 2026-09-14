// MVU 变量卡落定等待：假时钟 + 假事件源，不真的 sleep。
import test from 'node:test';
import assert from 'node:assert/strict';

import {
    MVU_DEFAULT_EVENTS,
    createMvuActivityTracker,
    waitForMessageSettled,
} from '../../modules/draw/shared/mvu-settle.js';

function fakeClock() {
    let current = 1000;
    const timers = [];
    return {
        now: () => current,
        // sleep 推进时钟，并触发到点的「宿主动作」
        sleep: async (ms) => {
            current += ms;
            for (const timer of timers.filter(item => item.at <= current)) {
                timers.splice(timers.indexOf(timer), 1);
                timer.run();
            }
        },
        at: (offsetMs, run) => timers.push({ at: current + offsetMs, run }),
        elapsed: start => current - start,
    };
}

function fakeEventSource() {
    const listeners = new Map();
    return {
        on: (name, handler) => listeners.set(name, [...(listeners.get(name) || []), handler]),
        removeListener: (name, handler) => listeners.set(name, (listeners.get(name) || []).filter(item => item !== handler)),
        emit: (name, ...args) => (listeners.get(name) || []).forEach(handler => handler(...args)),
        count: name => (listeners.get(name) || []).length,
    };
}

test('没有 MVU：正文 800ms 不变就放行', async () => {
    const clock = fakeClock();
    const start = clock.now();
    const result = await waitForMessageSettled({ getText: () => '正文', now: clock.now, sleep: clock.sleep });
    assert.equal(result.status, 'settled');
    assert.ok(clock.elapsed(start) >= 800 && clock.elapsed(start) < 1000);
});

test('MVU 更新进行中：等 ended 事件后正文再稳定 800ms，看到占位符即放行', async () => {
    const clock = fakeClock();
    const source = fakeEventSource();
    const mvu = { events: { VARIABLE_UPDATE_STARTED: 'mag_variable_update_started', VARIABLE_UPDATE_ENDED: 'mag_variable_update_ended' } };
    const tracker = createMvuActivityTracker({ getMvu: () => mvu, eventSource: source, now: clock.now });
    tracker.start();
    let text = '正文<UpdateVariable>x</UpdateVariable>';
    source.emit(MVU_DEFAULT_EVENTS.VARIABLE_UPDATE_STARTED, {});
    assert.equal(tracker.isBusy(), true);
    clock.at(2000, () => source.emit(MVU_DEFAULT_EVENTS.VARIABLE_UPDATE_ENDED, {}));
    clock.at(2300, () => { text = '正文\n\n<StatusPlaceHolderImpl/>'; });

    const start = clock.now();
    const result = await waitForMessageSettled({ getText: () => text, tracker, now: clock.now, sleep: clock.sleep });
    assert.equal(result.status, 'settled');
    assert.ok(clock.elapsed(start) >= 3100, `waited ${clock.elapsed(start)}ms`);
    assert.ok(clock.elapsed(start) < 3400);
    // 默认事件名和卡里声明的一样时不重复挂监听
    assert.equal(source.count(MVU_DEFAULT_EVENTS.VARIABLE_UPDATE_ENDED), 1);
    tracker.stop();
    assert.equal(source.count(MVU_DEFAULT_EVENTS.VARIABLE_UPDATE_ENDED), 0);
});

test('额外模型解析中（Mvu.isDuringExtraAnalysis）：一直等到它结束', async () => {
    const clock = fakeClock();
    let extra = true;
    const tracker = createMvuActivityTracker({
        getMvu: () => ({ isDuringExtraAnalysis: () => extra }),
        eventSource: fakeEventSource(),
        now: clock.now,
    });
    clock.at(5000, () => { extra = false; });
    const start = clock.now();
    const result = await waitForMessageSettled({
        getText: () => '正文\n\n<StatusPlaceHolderImpl/>',
        tracker,
        now: clock.now,
        sleep: clock.sleep,
    });
    assert.equal(result.status, 'settled');
    assert.ok(clock.elapsed(start) >= 5000);
});

test('有 MVU 但还没占位符：多等宽限期；一直不来也不会超过宽限', async () => {
    const clock = fakeClock();
    const tracker = createMvuActivityTracker({ getMvu: () => ({}), eventSource: fakeEventSource(), now: clock.now });
    const start = clock.now();
    const result = await waitForMessageSettled({ getText: () => '正文', tracker, now: clock.now, sleep: clock.sleep });
    assert.equal(result.status, 'settled');
    assert.ok(clock.elapsed(start) >= 3000 && clock.elapsed(start) < 3300);
});

test('一直忙：到上限直接放行；楼层没了：立即返回 missing；取消：返回 aborted', async () => {
    const clock = fakeClock();
    const busyTracker = { isBusy: () => true, isPresent: () => true, getLastActivityAt: () => 0 };
    const timeout = await waitForMessageSettled({ getText: () => 'x', tracker: busyTracker, timeoutMs: 20000, now: clock.now, sleep: clock.sleep });
    assert.equal(timeout.status, 'timeout');
    assert.ok(timeout.waitedMs >= 20000 && timeout.waitedMs < 20200);

    let alive = true;
    clock.at(300, () => { alive = false; });
    const missing = await waitForMessageSettled({ getText: () => (alive ? 'x' : null), tracker: busyTracker, now: clock.now, sleep: clock.sleep });
    assert.equal(missing.status, 'missing');

    const controller = new AbortController();
    clock.at(200, () => controller.abort());
    const aborted = await waitForMessageSettled({ getText: () => 'x', tracker: busyTracker, signal: controller.signal, now: clock.now, sleep: clock.sleep });
    assert.equal(aborted.status, 'aborted');
});

test('started 之后迟迟没有 ended：超过 staleBusyMs 不再算忙', () => {
    const clock = fakeClock();
    const source = fakeEventSource();
    const tracker = createMvuActivityTracker({ getMvu: () => null, eventSource: source, now: clock.now, staleBusyMs: 1000 });
    tracker.start();
    source.emit(MVU_DEFAULT_EVENTS.VARIABLE_UPDATE_STARTED);
    assert.equal(tracker.isBusy(), true);
    void clock.sleep(1500);
    assert.equal(tracker.isBusy(), false);
    assert.equal(tracker.getActivityCount(), 1);
});
