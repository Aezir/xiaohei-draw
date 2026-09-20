// 设置页「日志」的纯函数：打码、裁剪条数、折叠 Agent 诊断、NAI 参数摘要、渲染报告、复制文本。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import {
    DRAW_LOG_MAX_ENTRIES,
    applyRenderReport,
    buildEntryCopyText,
    createDrawLogEntry,
    describeNaiShown,
    failEntry,
    finishEntryFromResult,
    foldAgentDiagnostic,
    formatMessagesText,
    hasStatusPlaceholder,
    redactSecrets,
    redactText,
    summarizeEntryLine,
    summarizeNaiRequest,
    trimDrawLogEntries,
} from '../../modules/draw/shared/draw-log.js';

test('打码：按字段名 + 正则兜底（Bearer / pst- / sk- / URL key=）', () => {
    const redacted = redactSecrets({
        headers: { Authorization: 'Bearer abcdefghijklmn', 'x-api-key': 'raw-key-123' },
        apiKey: 'pst-AAAAAAAAAAAAAAAA',
        proxy_password: 'hunter2',
        nested: [{ token: 'abc' }, { note: '用 sk-proj-ABCDEFGHIJKL 调的' }],
        text: 'curl -H "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9xxxx" https://x.com/v1?key=AIzaSyXXXXXXXXXXXXXXXXXXXXXXXX&model=a',
        pst: '令牌是 pst-abcdefghijklmnop 别外传',
    });
    const json = JSON.stringify(redacted);
    for (const secret of ['abcdefghijklmn', 'raw-key-123', 'pst-AAAA', 'hunter2', '"abc"', 'sk-proj-ABCDEFGHIJKL', 'eyJhbGciOiJIUzI1NiJ9xxxx', 'AIzaSy', 'pst-abcdefghijklmnop']) {
        assert.equal(json.includes(secret), false, `不应出现 ${secret}`);
    }
    assert.match(redacted.text, /Bearer \[已打码\]/);
    assert.match(redacted.text, /model=a/, '非密钥参数保留');
    assert.match(redacted.nested[1].note, /sk-\[已打码\]/);
});

test('打码：图片 base64 不存，超长文本截断，普通长文本不误伤', () => {
    const base64 = 'A'.repeat(5000);
    assert.match(redactText(base64), /已省略/);
    assert.match(redactText(`看图 data:image/png;base64,${'B'.repeat(3000)} 完`), /^看图 \[图片数据已省略，约 \d+ KB\] 完$/);
    const prose = 'word '.repeat(400);
    assert.equal(redactText(prose), prose, '带空格的长文本不是 base64');
    const huge = 'x,'.repeat(150000);
    const cut = redactText(huge);
    assert.ok(cut.length < huge.length);
    assert.match(cut, /太长/);
});

test('条数裁剪：按开始时间倒序，最多 50 条', () => {
    const entries = Array.from({ length: 60 }, (_, index) => ({ id: `e${index}`, startedAt: index }));
    const { kept, removedIds } = trimDrawLogEntries(entries);
    assert.equal(kept.length, DRAW_LOG_MAX_ENTRIES);
    assert.equal(kept[0].id, 'e59');
    assert.equal(removedIds.length, 10);
    assert.ok(removedIds.includes('e0'));
});

test('Agent 诊断折叠：分析 + 纠错两轮，各自的请求、原始回复、校验失败原因、耗时', () => {
    const request1 = { request: { url: 'https://api.x.com/v1/chat', headers: { Authorization: 'Bearer sk-secretsecret' }, body: { model: 'm', messages: [{ role: 'system', content: '系统' }, { role: 'user', content: '正文' }], tools: [1] } } };
    const request2 = { request: { body: { model: 'm', messages: [{ role: 'system', content: '系统' }, { role: 'user', content: '正文' }, { role: 'tool', content: '纠错反馈' }] } } };
    let agent = null;
    // 第 1 轮开始
    agent = foldAgentDiagnostic(agent, { status: 'running', stage: 'request', attempts: [], provider: 'openai-compatible', model: 'm' });
    // 第 1 轮返回
    agent = foldAgentDiagnostic(agent, { status: 'running', stage: 'request', attempts: [{ attempt: 1, startedAt: 1, durationMs: 1200, modelOutput: '{"text":"round1"}' }], request: request1 });
    // 第 1 轮没过校验
    agent = foldAgentDiagnostic(agent, {
        status: 'running', stage: 'correction', request: request1,
        attempts: [{ attempt: 1, startedAt: 1, durationMs: 1200, modelOutput: '{"text":"round1"}' }],
        validationFailures: [{ attempt: 1, errorCode: 'SCENE_SCHEMA', errorPath: 'images[0].placement', errorRule: 'required', errorMessage: '缺 placement', modelOutput: '{"text":"round1-full"}' }],
    });
    // 第 2 轮返回并通过
    agent = foldAgentDiagnostic(agent, {
        status: 'success', stage: 'parse', durationMs: 3000, request: request2,
        attempts: [{ attempt: 1, durationMs: 1200 }, { attempt: 2, durationMs: 800, modelOutput: '{"text":"round2"}' }],
        validationFailures: [{ attempt: 1, errorCode: 'SCENE_SCHEMA', errorPath: 'images[0].placement', errorMessage: '缺 placement' }],
    });
    assert.equal(agent.rounds.length, 2);
    assert.equal(agent.rounds[0].phase, 'analysis');
    assert.equal(agent.rounds[1].phase, 'correction');
    assert.equal(agent.rounds[0].request.messages.length, 2, '第 1 轮保留自己的请求');
    assert.equal(agent.rounds[1].request.messages.length, 3);
    assert.equal(agent.rounds[0].validation.code, 'SCENE_SCHEMA');
    assert.equal(agent.rounds[0].validation.path, 'images[0].placement');
    assert.match(agent.rounds[0].modelOutput, /round1/);
    assert.match(agent.rounds[1].modelOutput, /round2/);
    assert.equal(agent.rounds[1].durationMs, 800);
    assert.equal(agent.status, 'success');
    assert.equal(JSON.stringify(agent).includes('sk-secretsecret'), false);
    assert.match(formatMessagesText(agent.rounds[1].request.messages), /\[tool\]\n纠错反馈/);
});

test('NAI 摘要：V4.5 payload 取正负向、角色坐标、参数、氛围图数量；不带 key 和 base64', () => {
    const summary = summarizeNaiRequest({
        payload: {
            input: 'scene',
            model: 'nai-diffusion-4-5-full',
            parameters: {
                width: 832, height: 1216, steps: 28, scale: 5, sampler: 'k_euler_ancestral', seed: 42,
                negative_prompt: 'bad',
                reference_image_multiple: ['X'.repeat(4000), 'Y'.repeat(4000)],
                v4_prompt: { caption: { base_caption: '1girl, {solo}', char_captions: [{ char_caption: 'girl a', centers: [{ x: 0.3, y: 0.5 }] }] }, use_coords: true },
                v4_negative_prompt: { caption: { base_caption: 'bad', char_captions: [{ char_caption: 'ugly', centers: [{ x: 0.3, y: 0.5 }] }] } },
            },
        },
    });
    assert.equal(summary.positive, '1girl, {solo}');
    assert.equal(summary.negative, 'bad');
    assert.deepEqual(summary.characters, [{ prompt: 'girl a', uc: 'ugly', center: { x: 0.3, y: 0.5 } }]);
    assert.equal(summary.vibeCount, 2);
    assert.equal(summary.width, 832);
    assert.equal(summary.seed, 42);
    assert.equal(JSON.stringify(summary).includes('XXXX'), false);
});

test('渲染报告：改写 → 半秒后还是代码 → 补发 → 恢复', () => {
    let renders = [];
    renders = applyRenderReport(renders, { renderId: 'r1', messageId: 7, stage: 'rendered', at: 1000, mvuBusy: true, hasPlaceholder: false });
    renders = applyRenderReport(renders, { renderId: 'r1', messageId: 7, stage: 'checked', attempt: 0, needsRetry: true, statusBar: 'code' });
    renders = applyRenderReport(renders, { renderId: 'r1', messageId: 7, stage: 'retried', attempt: 1 });
    renders = applyRenderReport(renders, { renderId: 'r1', messageId: 7, stage: 'checked', attempt: 1, needsRetry: false, statusBar: 'iframe' });
    renders = applyRenderReport(renders, { renderId: 'unknown', stage: 'checked', attempt: 0 });
    assert.equal(renders.length, 1);
    assert.deepEqual(
        { mvuBusy: renders[0].mvuBusy, hasPlaceholder: renders[0].hasPlaceholder, statusAfter: renders[0].statusAfter, retries: renders[0].retries, recovered: renders[0].recovered },
        { mvuBusy: true, hasPlaceholder: false, statusAfter: 'code', retries: 1, recovered: true },
    );
    assert.equal(hasStatusPlaceholder('正文\n\n<StatusPlaceHolderImpl/>'), true);
    assert.equal(hasStatusPlaceholder('正文'), false);
});

test('上屏描述：即时 / 被冲掉补插 / 没插上；文本配图没有这一项', () => {
    assert.equal(describeNaiShown(undefined), '');
    assert.equal(describeNaiShown({ immediate: true, reinserts: 0, misses: 0 }), '出图即上屏');
    assert.equal(describeNaiShown({ immediate: true, reinserts: 2, misses: 0 }), '上屏后被冲掉，补插 2 次');
    assert.equal(describeNaiShown({ immediate: false, reinserts: 1, misses: 1 }), '没立刻插上，补插 1 次，另有 1 次没插上');
    assert.equal(describeNaiShown({ immediate: false, reinserts: 0, misses: 3 }), '没插上楼层（试了 3 次，等结束整楼重写）');
    assert.equal(describeNaiShown({ immediate: true, reinserts: 0, misses: 2 }), '上屏后被冲掉，2 次补插没插上');
    const entry = createDrawLogEntry({ kind: 'message', messageId: 3 });
    entry.nai.images = [{ state: 'ready', request: {}, shown: { immediate: false, reinserts: 1, misses: 0 } }, { state: 'ready', request: {} }];
    const text = buildEntryCopyText(entry);
    assert.match(text, /-- 图 1 · 成功 · 上屏：没立刻插上，补插 1 次 --/);
    assert.match(text, /-- 图 2 · 成功 --/);
});

test('结果与复制文本：成功几张 / 失败原因，复制文本含三块且无密钥', () => {
    let entry = createDrawLogEntry({ kind: 'message', messageId: 12, now: new Date(2026, 8, 15, 9, 5, 3).getTime() });
    entry.nai.images = [
        { state: 'ready', request: { positive: 'a', negative: 'b', characters: [{ prompt: 'c', uc: '', center: { x: 0.5, y: 0.5 } }], model: 'm', width: 1, height: 2, vibeCount: 0 } },
        { state: 'failed', request: { positive: 'd' }, error: { label: '额度', message: 'Anlas 不够' } },
    ];
    entry.agent = { status: 'success', rounds: [{ index: 1, phase: 'analysis', durationMs: 10, request: { messages: [{ role: 'user', content: 'hi Bearer sk-shouldnotleak' }], body: {} }, modelOutput: '{"text":"ok"}' }] };
    entry.renders = [{ renderId: 'r1', at: 1, mvuBusy: false, hasPlaceholder: true, statusAfter: 'iframe', retries: 0 }];
    const done = finishEntryFromResult(entry, { success: 1, total: 2 });
    assert.equal(done.status, 'partial');
    assert.equal(summarizeEntryLine(done), '9-15 09:05:03 · #12 楼 · 成功 1 张，失败 1 张');
    const text = buildEntryCopyText(redactSecrets(done));
    assert.match(text, /== 场景 Agent ==/);
    assert.match(text, /== NAI 请求 ==/);
    assert.match(text, /== 楼层渲染 ==/);
    assert.match(text, /坐标 \(0\.5, 0\.5\)/);
    assert.equal(text.includes('sk-shouldnotleak'), false);

    const failed = failEntry(entry, new Error('模型没有调用工具'), { code: 'tool_protocol', label: 'Tool 协议' });
    assert.equal(summarizeEntryLine(failed).endsWith('失败：Tool 协议'), true);
    assert.equal(finishEntryFromResult(entry, { success: 0, total: 0 }).status, 'success');
});

test('设置页接线：左栏和手机底栏都有日志入口，日志页不放进图片管理页', () => {
    const html = fs.readFileSync(new URL('../../modules/draw/providers/novelai/novel-draw.html', import.meta.url), 'utf8');
    assert.match(html, /class="nav-item" data-view="log"><i class="ri-file-list-3-line"><\/i>日志/);
    assert.match(html, /class="mobile-nav-item" data-view="log"><i class="ri-file-list-3-line"><\/i><span>日志<\/span>/);
    assert.match(html, /<div id="view-log" class="view">/);
    assert.match(html, /ui\/draw-log-view\.js/);
    const gallery = html.slice(html.indexOf('id="view-gallery"'), html.indexOf('id="view-api"'));
    assert.equal(gallery.includes('nd_log_'), false);
});
