// 缩略图队列：并发上限、同 id 一次、403/429 整体暂停 30 秒后重试、其他错误可重新请求、翻页取消
import test from 'node:test';
import assert from 'node:assert/strict';
import { createPausingThumbQueue } from '../../modules/draw/shared/gallery-sync/thumb-queue.js';

function clock() {
    let t = 0;
    const timers = [];
    return {
        now: () => t,
        setTimer: (fn, ms) => timers.push({ fn, at: t + ms }),
        async advance(ms) {
            t += ms;
            for (const tm of timers.splice(0).sort((a, b) => a.at - b.at)) { if (tm.at <= t) tm.fn(); else timers.push(tm); }
            await flush();
        },
        pending: () => timers.length,
    };
}
const flush = () => new Promise(r => setImmediate(r));

test('concurrency cap and one request per id', async () => {
    const started = [];
    const gates = new Map();
    const q = createPausingThumbQueue(id => { started.push(id); return new Promise(ok => gates.set(id, ok)); }, { concurrency: 2 });
    const pa = q.get('a'), pb = q.get('b'), pc = q.get('c');
    assert.equal(q.get('a'), pa);
    await flush();
    assert.deepEqual(started, ['a', 'b']);
    gates.get('a')(new Uint8Array([1]));
    await flush();
    assert.deepEqual(started, ['a', 'b', 'c']);
    gates.get('b')(null); gates.get('c')(null);
    assert.deepEqual(await pa, new Uint8Array([1]));
    await Promise.all([pb, pc]);
});

test('429 pauses the whole queue for 30s then retries; other ids wait too', async () => {
    const c = clock();
    const calls = [];
    let limited = true;
    const pauses = [];
    const q = createPausingThumbQueue(async (id) => {
        calls.push(id);
        if (id === 'a' && limited) { limited = false; throw Object.assign(new Error('rate'), { status: 429 }); }
        return id;
    }, { concurrency: 1, now: c.now, setTimer: c.setTimer, onPause: p => pauses.push(p) });
    const pa = q.get('a'), pb = q.get('b');
    await flush(); await flush();
    assert.deepEqual(calls, ['a']);
    assert.equal(pauses.length, 1);
    assert.equal(q.pausedUntil, 30000);
    await c.advance(29999);
    assert.deepEqual(calls, ['a']);
    await c.advance(1);
    await flush();
    assert.equal(await pa, 'a');
    assert.equal(await pb, 'b');
    assert.deepEqual(calls, ['a', 'a', 'b']);
});

test('403 repeated beyond maxRetries fails; non-rate errors reject and can be requested again', async () => {
    const c = clock();
    let n = 0;
    const q = createPausingThumbQueue(async (id) => {
        if (id === 'x') throw Object.assign(new Error('forbidden'), { status: 403 });
        if (id === 'y' && n++ === 0) throw Object.assign(new Error('boom'), { status: 500 });
        return id;
    }, { maxRetries: 2, pauseMs: 10, now: c.now, setTimer: c.setTimer });
    const px = assert.rejects(q.get('x'), /forbidden/);
    for (let i = 0; i < 4; i++) { await flush(); await c.advance(10); }
    await px;
    await assert.rejects(q.get('y'), /boom/);
    assert.equal(await q.get('y'), 'y');
});

test('clearWaiting cancels queued requests so a new page starts fresh', async () => {
    const gates = [];
    const q = createPausingThumbQueue(() => new Promise(ok => gates.push(ok)), { concurrency: 1 });
    const first = q.get('p1');
    const queued = q.get('p2');
    await flush();
    q.clearWaiting();
    await assert.rejects(queued, e => e.code === 'cancel');
    gates[0]('done');
    assert.equal(await first, 'done');
    assert.equal(q.waiting, 0);
});
