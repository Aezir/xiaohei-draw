// 场景 Agent 报错指引：OpenAI Responses 接口 + 中转站不支持时给中文提示，其他情况不加。
import test from 'node:test';
import assert from 'node:assert/strict';

import { describeProviderErrorHint, OPENAI_RESPONSES_UNSUPPORTED_HINT } from '../../modules/draw/shared/draw-agent-runtime.js';

test('用户实测的「500 not implemented」（状态码只在 message 里）', () => {
    assert.equal(describeProviderErrorHint(new Error('500 not implemented'), 'openai-responses'), OPENAI_RESPONSES_UNSUPPORTED_HINT);
    assert.match(OPENAI_RESPONSES_UNSUPPORTED_HINT, /OpenAI 兼容/);
});

test('状态码在 error.status，信息含 not found / unsupported / Not_Implemented', () => {
    for (const [status, message] of [[404, 'Not Found'], [405, 'method unsupported'], [500, 'Not_Implemented'], [501, 'not implemented']]) {
        assert.equal(describeProviderErrorHint(Object.assign(new Error(message), { status }), 'openai-responses'), OPENAI_RESPONSES_UNSUPPORTED_HINT, `${status} ${message}`);
    }
    assert.equal(describeProviderErrorHint({ message: 'upstream', body: 'route not found', response: { status: 404 } }, 'openai-responses'), OPENAI_RESPONSES_UNSUPPORTED_HINT);
});

test('不加提示：别的 provider、别的状态码、别的信息', () => {
    assert.equal(describeProviderErrorHint(new Error('500 not implemented'), 'openai-compatible'), '');
    assert.equal(describeProviderErrorHint(new Error('500 not implemented'), ''), '');
    assert.equal(describeProviderErrorHint(Object.assign(new Error('unauthorized'), { status: 401 }), 'openai-responses'), '');
    assert.equal(describeProviderErrorHint(Object.assign(new Error('internal error'), { status: 500 }), 'openai-responses'), '');
    assert.equal(describeProviderErrorHint(Object.assign(new Error('not found'), { status: 429 }), 'openai-responses'), '');
    assert.equal(describeProviderErrorHint(new Error('token 5000 not found'), 'openai-responses'), '');
});
