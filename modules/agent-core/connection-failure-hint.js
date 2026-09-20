// 「连接类失败」= 请求根本没拿到回应，不是对方回了个错误。
// 各处文案不一样：fetch 的 TypeError 叫「Failed to fetch」（Chrome / WebView）、「NetworkError when attempting to fetch resource.」（Firefox）、
// 「Load failed」（Safari）；OpenAI / Anthropic / Google 的 SDK 会把这些包一层，统一只说「Connection error.」，真正的原因藏在 error.cause 里。
// 这里把整条 cause 链的信息收齐，再按「浏览器直连」还是「酒馆后端代发」给出该查什么。
import { isSillyTavernProvider } from './provider-resolution.js';

const CONNECTION_FAILURE_PATTERN = /connection error|failed to fetch|networkerror|network request failed|load failed|err_connection|err_name_not_resolved|err_cert|econnrefused|enotfound|fetch failed/i;

/** 收集 error 及其 cause 链上的信息（去重、最多 5 层），给日志 / 报错拼「底层原因」用。 */
export function collectErrorMessages(error) {
    const messages = [];
    let current = error;
    for (let depth = 0; current && depth < 5; depth += 1) {
        const candidates = [
            current.message,
            typeof current.body === 'string' ? current.body : '',
            current.error?.message,
        ];
        for (const item of candidates) {
            const text = String(item || '').trim();
            if (text && !messages.includes(text)) messages.push(text);
        }
        current = current.cause;
    }
    return messages;
}

export function isConnectionFailure(error) {
    if (!error) return false;
    return collectErrorMessages(error).some(text => CONNECTION_FAILURE_PATTERN.test(text));
}

/** 有状态码 = 对方（或酒馆后端）回话了 */
function hasHttpStatus(error) {
    const status = Number(error?.status ?? error?.statusCode ?? error?.response?.status);
    return Number.isFinite(status) && status > 0;
}

/** 「Connection error.（底层：Failed to fetch）」——SDK 的笼统文案后面跟上真正的原因。 */
export function describeErrorWithCause(error, fallback = '未知错误') {
    const [first, ...rest] = collectErrorMessages(error);
    if (!first) return fallback;
    const deeper = rest.filter(text => !first.includes(text));
    return deeper.length ? `${first}（底层：${deeper.join(' / ')}）` : first;
}

export const DIRECT_CONNECTION_FAILURE_HINT = '这是浏览器直连没拿到任何回应，不是对方报错。常见原因：对方没给本站放 CORS（TauriTavern 的页面源是 http://tauri.localhost，中转要放行它）、https 页面去请求 http 地址、地址本身不通。省事的做法：改选「酒馆 OpenAI 兼容」，由酒馆后端代发就不过 CORS 这道关';
export const HOST_CONNECTION_FAILURE_HINT = '酒馆后端没连上这个地址（不是对方报错）。查三样：地址是否完整（带 http(s):// 和 /v1）、酒馆后端所在的机器 / 手机能不能访问它（TauriTavern 是 Rust 在发请求，不走浏览器的代理）、酒馆自己的连接页用同一地址能不能通';
export const HOST_ROUTE_MISSING_HINT = '酒馆自己的接口 /api/backends/chat-completions 都没回应：多半是这个酒馆版本 / 壳（如 TauriTavern 某些版本）没有实现这条接口，试试「使用酒馆当前 API」，或改回浏览器直连并给中转放行 CORS';

/** 按 provider 给出该查什么；不是连接类失败返回空串。 */
export function describeConnectionFailureHint(error, provider = '') {
    if (!isConnectionFailure(error)) return '';
    if (isSillyTavernProvider(provider)) {
        const messages = collectErrorMessages(error).join(' ');
        const browserFetchFailed = /failed to fetch|networkerror|load failed|network request failed/i.test(messages);
        return browserFetchFailed && !hasHttpStatus(error) ? HOST_ROUTE_MISSING_HINT : HOST_CONNECTION_FAILURE_HINT;
    }
    return hasHttpStatus(error) ? '' : DIRECT_CONNECTION_FAILURE_HINT;
}
