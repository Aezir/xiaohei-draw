import test from 'node:test';
import assert from 'node:assert/strict';

import { createIdleDimmer, DIM_CLASS, IDLE_DIM_DELAY } from '../../modules/draw/providers/novelai/ui/float-idle-dim.js';

function makeEl() {
    const classes = new Set(['nd-float']);
    const handlers = {};
    return {
        classList: {
            add: (c) => classes.add(c),
            remove: (...cs) => cs.forEach(c => classes.delete(c)),
            contains: (c) => classes.has(c),
        },
        addEventListener: (t, fn) => { (handlers[t] ||= new Set()).add(fn); },
        removeEventListener: (t, fn) => { handlers[t]?.delete(fn); },
        fire: (t) => handlers[t]?.forEach(fn => fn({ type: t })),
        listenerCount: () => Object.values(handlers).reduce((n, s) => n + s.size, 0),
    };
}

function makeTimers() {
    let now = 0;
    let seq = 0;
    const pending = new Map();
    return {
        setTimeout: (fn, ms) => { const id = ++seq; pending.set(id, { fn, at: now + ms }); return id; },
        clearTimeout: (id) => { pending.delete(id); },
        advance(ms) {
            now += ms;
            for (const [id, t] of [...pending]) {
                if (t.at <= now) { pending.delete(id); t.fn(); }
            }
        },
        count: () => pending.size,
    };
}

function setup(extra = {}) {
    const el = makeEl();
    const timers = makeTimers();
    const dimmer = createIdleDimmer({ el, timers, MutationObserverImpl: null, ...extra });
    return { el, timers, dimmer };
}

test('闲置 3 秒后变淡，之前不变', () => {
    const { el, timers } = setup();
    timers.advance(IDLE_DIM_DELAY - 1);
    assert.equal(el.classList.contains(DIM_CLASS), false);
    timers.advance(1);
    assert.equal(el.classList.contains(DIM_CLASS), true);
});

test('悬停立刻恢复，离开后重新计时', () => {
    const { el, timers } = setup();
    timers.advance(IDLE_DIM_DELAY);
    el.fire('pointerenter');
    assert.equal(el.classList.contains(DIM_CLASS), false);
    timers.advance(IDLE_DIM_DELAY * 2);
    assert.equal(el.classList.contains(DIM_CLASS), false, '悬停期间不变淡');
    el.fire('pointerleave');
    timers.advance(IDLE_DIM_DELAY - 1);
    assert.equal(el.classList.contains(DIM_CLASS), false);
    timers.advance(1);
    assert.equal(el.classList.contains(DIM_CLASS), true);
});

test('触屏：按下唤醒，抬起后 3 秒再变淡；拖动期间保持不淡', () => {
    let dragging = false;
    const { el, timers } = setup({ isBusy: () => dragging });
    timers.advance(IDLE_DIM_DELAY);
    dragging = true;
    el.fire('pointerdown');
    assert.equal(el.classList.contains(DIM_CLASS), false);
    timers.advance(IDLE_DIM_DELAY * 2);
    assert.equal(el.classList.contains(DIM_CLASS), false);
    dragging = false;
    el.fire('pointerup');
    timers.advance(IDLE_DIM_DELAY);
    assert.equal(el.classList.contains(DIM_CLASS), true);
});

for (const cls of ['expanded', 'show-detail', 'working', 'cooldown', 'success', 'partial', 'error']) {
    test(`.${cls} 时不变淡，结束后重新计时`, () => {
        const { el, timers, dimmer } = setup();
        timers.advance(IDLE_DIM_DELAY);
        el.classList.add(cls);
        dimmer.refresh();
        assert.equal(el.classList.contains(DIM_CLASS), false);
        timers.advance(IDLE_DIM_DELAY * 2);
        assert.equal(el.classList.contains(DIM_CLASS), false);
        el.classList.remove(cls);
        dimmer.refresh();
        timers.advance(IDLE_DIM_DELAY);
        assert.equal(el.classList.contains(DIM_CLASS), true);
    });
}

// 浏览器里 classList.add/remove 即使内容没变也会产生一次 class 属性变更记录（Chromium 实测）。
// 旧实现在「忙」状态下每次 refresh 都 remove，observer 又回调 refresh，页面卡死。
function makeBrowserLikeEl() {
    const el = makeEl();
    const observers = new Set();
    const classes = el.classList;
    let writes = 0;
    const notify = () => {
        writes += 1;
        if (writes > 1000) throw new Error('class 写入失控（死循环）');
        observers.forEach(cb => cb([{ type: 'attributes', attributeName: 'class' }]));
    };
    el.classList = {
        add: (c) => { classes.add(c); notify(); },
        remove: (...cs) => { classes.remove(...cs); notify(); },
        contains: (c) => classes.contains(c),
    };
    function FakeObserver(cb) { this.cb = cb; }
    FakeObserver.prototype.observe = function () { observers.add(this.cb); };
    FakeObserver.prototype.disconnect = function () { observers.delete(this.cb); };
    return { el, FakeObserver, writes: () => writes };
}

test('浏览器式 observer：忙状态下悬停 / 状态类不会无限写 class', () => {
    const { el, FakeObserver, writes } = makeBrowserLikeEl();
    const timers = makeTimers();
    createIdleDimmer({ el, timers, MutationObserverImpl: FakeObserver });
    timers.advance(IDLE_DIM_DELAY);
    assert.equal(el.classList.contains(DIM_CLASS), true);

    assert.doesNotThrow(() => el.fire('pointerenter'));
    assert.equal(el.classList.contains(DIM_CLASS), false);
    assert.doesNotThrow(() => el.classList.add('working'));
    assert.doesNotThrow(() => el.fire('pointerdown'));
    assert.ok(writes() < 10, `class 写入次数应很少，实际 ${writes()}`);

    el.classList.remove('working');
    el.fire('pointerleave');
    timers.advance(IDLE_DIM_DELAY);
    assert.equal(el.classList.contains(DIM_CLASS), true);
});

test('destroy 清掉计时器、监听和 is-dim', () => {
    const { el, timers, dimmer } = setup();
    timers.advance(IDLE_DIM_DELAY);
    dimmer.destroy();
    assert.equal(el.classList.contains(DIM_CLASS), false);
    assert.equal(el.listenerCount(), 0);
    assert.equal(timers.count(), 0);
    dimmer.refresh();
    timers.advance(IDLE_DIM_DELAY);
    assert.equal(el.classList.contains(DIM_CLASS), false);
});
