// 场景 Agent 报错指引：OpenAI Responses 接口 + 中转站不支持时给中文提示，其他情况不加。
import test from 'node:test';
import assert from 'node:assert/strict';

import { describeProviderErrorHint, OPENAI_RESPONSES_UNSUPPORTED_HINT } from '../../modules/draw/shared/draw-agent-runtime.js';
import {
    DIRECT_CONNECTION_FAILURE_HINT,
    HOST_CONNECTION_FAILURE_HINT,
    HOST_ROUTE_MISSING_HINT,
    describeErrorWithCause,
    isConnectionFailure,
} from '../../modules/agent-core/connection-failure-hint.js';

test('连接类失败：SDK 的「Connection error.」要把 cause 里的 Failed to fetch 带出来', () => {
    const error = Object.assign(new Error('Connection error.'), { cause: new TypeError('Failed to fetch') });
    assert.equal(isConnectionFailure(error), true);
    assert.equal(describeErrorWithCause(error), 'Connection error.（底层：Failed to fetch）');
    assert.equal(describeErrorWithCause(new Error('Connection error.')), 'Connection error.');
    assert.equal(describeErrorWithCause(null, '未知错误'), '未知错误');
    assert.equal(isConnectionFailure(Object.assign(new Error('unauthorized'), { status: 401 })), false);
});

test('连接类失败的指引：浏览器直连 → CORS / 混合内容；酒馆通道 → 后端连不上 / 接口不存在', () => {
    const fetchFailed = Object.assign(new Error('Connection error.'), { cause: new TypeError('Failed to fetch') });
    assert.equal(describeProviderErrorHint(fetchFailed, 'openai-compatible'), DIRECT_CONNECTION_FAILURE_HINT);
    assert.equal(describeProviderErrorHint(fetchFailed, 'anthropic'), DIRECT_CONNECTION_FAILURE_HINT);
    assert.equal(describeProviderErrorHint(new TypeError('Load failed'), 'google'), DIRECT_CONNECTION_FAILURE_HINT);
    // 直连但对方回了状态码：不是连接失败
    assert.equal(describeProviderErrorHint(Object.assign(new Error('connection error'), { status: 502 }), 'openai-compatible'), '');
    // 酒馆通道：浏览器都没拿到回应 = 酒馆没这条接口
    assert.equal(describeProviderErrorHint(new TypeError('Failed to fetch'), 'sillytavern-openai-compatible'), HOST_ROUTE_MISSING_HINT);
    // 酒馆通道：后端回话了但说连不上上游
    assert.equal(describeProviderErrorHint(Object.assign(new Error('酒馆后端生成失败：connect ECONNREFUSED'), { status: 500 }), 'sillytavern-openai-compatible'), HOST_CONNECTION_FAILURE_HINT);
    // 普通报错不加
    assert.equal(describeProviderErrorHint(Object.assign(new Error('unauthorized'), { status: 401 }), 'openai-compatible'), '');
    // openai-responses 的老规则优先
    assert.equal(describeProviderErrorHint(new Error('500 not implemented'), 'openai-responses'), OPENAI_RESPONSES_UNSUPPORTED_HINT);
});

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
