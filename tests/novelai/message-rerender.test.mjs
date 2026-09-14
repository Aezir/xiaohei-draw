// 楼层重渲染：走宿主 updateMessageBlock + MESSAGE_UPDATED，合并重复请求，自发事件可识别。全部假对象。
import test from 'node:test';
import assert from 'node:assert/strict';

import { createMessageRerenderer } from '../../modules/draw/shared/message-rerender.js';

function fakeHost({ onEmit } = {}) {
    const calls = [];
    return {
        calls,
        host: {
            updateMessageBlock: (messageId, message) => calls.push(['update', messageId, message]),
            emitMessageUpdated: async (messageId) => {
                calls.push(['emit', messageId]);
                await onEmit?.(messageId);
            },
        },
    };
}

test('同一楼层同一轮多次请求：只渲染一次、只发一次 MESSAGE_UPDATED，用最后一次的文本', async () => {
    const { calls, host } = fakeHost();
    const renderer = createMessageRerenderer({ loadHost: async () => host });
    const message = { mes: '原文', name: 'A', extra: {} };
    const results = await Promise.all([
        renderer.rerender(3, message, { text: '规划1' }),
        renderer.rerender(3, message, { text: '规划2' }),
        renderer.rerender(3, message),
    ]);
    assert.deepEqual(results, [true, true, true]);
    assert.deepEqual(calls.map(call => call[0]), ['update', 'emit']);
    assert.equal(calls[0][2], message, '最后一次请求按 message 本身渲染');
    assert.deepEqual(calls[1], ['emit', 3]);
});

test('自愈：渲染后状态栏还是代码就补发 MESSAGE_UPDATED，好了就停，最多补 2 次', async () => {
    const flush = () => new Promise(resolve => setImmediate(resolve));
    const run = async (brokenChecks) => {
        const { calls, host } = fakeHost();
        const timers = [];
        let checks = 0;
        const renderer = createMessageRerenderer({
            loadHost: async () => host,
            setTimer: callback => timers.push(callback),
            needsRenderRetry: () => checks++ < brokenChecks,
        });
        await renderer.rerender(5, { mes: '原文', extra: {} });
        while (timers.length) {
            await timers.shift()();
            await flush();
        }
        return calls.filter(call => call[0] === 'emit').length;
    };
    assert.equal(await run(0), 1, '渲染正常：只发原来那一次');
    assert.equal(await run(1), 2, '第一次检查还是代码：补发一次，第二次检查正常就停');
    assert.equal(await run(99), 3, '一直是代码：最多补发 2 次');
});

test('规划文本只用于显示：浅拷贝，去掉 display_text，不改原 message', async () => {
    const { calls, host } = fakeHost();
    const renderer = createMessageRerenderer({ loadHost: async () => host });
    const message = { mes: '原文', name: 'A', extra: { display_text: '译文', image: 'x.png' } };
    await renderer.rerender(0, message, { text: '原文\n[image:a]' });
    const rendered = calls[0][2];
    assert.notEqual(rendered, message);
    assert.equal(rendered.mes, '原文\n[image:a]');
    assert.equal('display_text' in rendered.extra, false);
    assert.equal(rendered.extra.image, 'x.png');
    assert.equal(message.mes, '原文');
    assert.equal(message.extra.display_text, '译文');
});

test('文本等于 message.mes 时直接传 message（认 display_text，也让宿主对 0 楼的处理保持原样）', async () => {
    const { calls, host } = fakeHost();
    const renderer = createMessageRerenderer({ loadHost: async () => host });
    const message = { mes: '原文', extra: { display_text: '译文' } };
    await renderer.rerender(0, message, { text: '原文' });
    assert.equal(calls[0][2], message);
});

test('楼层正在编辑：不渲染也不发事件', async () => {
    const { calls, host } = fakeHost();
    const renderer = createMessageRerenderer({ loadHost: async () => host, isEditing: id => id === 5 });
    assert.equal(await renderer.rerender(5, { mes: 'x' }), false);
    assert.deepEqual(calls, []);
});

test('自发事件派发期间 isSelfUpdate 为 true；监听器再请求重渲染不会形成无限循环', async () => {
    let renderer;
    let selfSeen = null;
    let reentered = 0;
    const { calls, host } = fakeHost({
        onEmit: (messageId) => {
            selfSeen = renderer.isSelfUpdate(messageId);
            // 模拟监听器：只有不是自发事件才重建楼层
            if (!renderer.isSelfUpdate(messageId) && reentered < 5) {
                reentered += 1;
                void renderer.rerender(messageId, { mes: 'again' });
            }
        },
    });
    renderer = createMessageRerenderer({ loadHost: async () => host });
    await renderer.rerender(2, { mes: 'x' });
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(selfSeen, true);
    assert.equal(renderer.isSelfUpdate(2), false);
    assert.equal(reentered, 0);
    assert.deepEqual(calls.map(call => call[0]), ['update', 'emit']);
});

test('事件派发期间来的新请求：当前一轮结束后再渲染一次', async () => {
    let renderer;
    let queued = null;
    const { calls, host } = fakeHost({
        onEmit: () => {
            if (!queued) queued = renderer.rerender(1, { mes: 'second' });
        },
    });
    renderer = createMessageRerenderer({ loadHost: async () => host });
    await renderer.rerender(1, { mes: 'first' });
    assert.equal(await queued, true);
    assert.deepEqual(calls.map(call => call[0]), ['update', 'emit', 'update', 'emit']);
    assert.equal(calls[2][2].mes, 'second');
});

test('宿主抛错时把错误交给调用方，不吞掉', async () => {
    const renderer = createMessageRerenderer({
        loadHost: async () => ({
            updateMessageBlock: () => { throw new Error('boom'); },
            emitMessageUpdated: async () => {},
        }),
    });
    await assert.rejects(renderer.rerender(1, { mes: 'x' }), /boom/);
    assert.equal(renderer.isSelfUpdate(1), false);
});
