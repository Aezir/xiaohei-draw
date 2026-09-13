// 订阅档位查询（宿主侧）。只读，不扣 Anlas。
// 顺序：浏览器直连 GET /user/subscription → 网络/CORS 失败时走插件 /v1/subscription → 都失败用手动档位（计价显示「约」）。
// 结果只在内存里用（V2 通过 SUBSCRIPTION_DATA 消息发给页面），不落盘；API Key 不进日志、不进 URL。
// V1/VP 阶段只提供函数，还没有任何地方调用它。
import { NAI_BACKEND_BASE } from './novel-request-config.js';

export const NOVELAI_SUBSCRIPTION_URL = 'https://image.novelai.net/user/subscription';
export const NOVEL_SUBSCRIPTION_CAPABILITY = 'novelai-subscription-v1';
export const NOVEL_BACKEND_SUBSCRIPTION = `${NAI_BACKEND_BASE}/v1/subscription`;
export const MANUAL_SUBSCRIPTION_TIERS = Object.freeze({ none: 0, tablet: 1, scroll: 2, opus: 3 });

export class NovelSubscriptionError extends Error {
    constructor(message, { code = 'unknown', status = 0, cause } = {}) {
        super(message);
        this.name = 'NovelSubscriptionError';
        this.code = code;
        this.status = status;
        if (cause) this.cause = cause;
    }
}

/** 只保留计价需要的字段。 */
export function summarizeSubscription(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const tier = Number(raw.tier);
    if (!Number.isFinite(tier)) return null;
    const usage = raw.usage && typeof raw.usage === 'object'
        ? {
            isNegative: typeof raw.usage.isNegative === 'boolean' ? raw.usage.isNegative : undefined,
            percent: Number.isFinite(Number(raw.usage.percent)) ? Number(raw.usage.percent) : undefined,
        }
        : undefined;
    return {
        tier,
        active: raw.active === true,
        expiresAt: Number(raw.expiresAt) || 0,
        ...(usage ? { usage } : {}),
    };
}

/** `#nd_sub_tier` 的值：auto / none / tablet / scroll / opus。auto 或空返回 null。 */
export function subscriptionFromManualTier(value) {
    const key = String(value || '').trim().toLowerCase();
    if (!Object.prototype.hasOwnProperty.call(MANUAL_SUBSCRIPTION_TIERS, key)) return null;
    const tier = MANUAL_SUBSCRIPTION_TIERS[key];
    return { tier, active: tier > 0, source: 'manual' };
}

function isAbort(error, signal) {
    return signal?.aborted || error?.name === 'AbortError';
}

export async function fetchSubscriptionDirect({ apiKey, signal, fetchImpl = globalThis.fetch, url = NOVELAI_SUBSCRIPTION_URL } = {}) {
    const key = String(apiKey || '').trim();
    if (!key) throw new NovelSubscriptionError('没有 API Key', { code: 'no_key' });
    let response;
    try {
        response = await fetchImpl(url, {
            method: 'GET',
            mode: 'cors',
            headers: { 'Authorization': `Bearer ${key}` },
            signal,
        });
    } catch (error) {
        if (isAbort(error, signal)) throw error;
        throw new NovelSubscriptionError('浏览器直连订阅查询失败（网络或 CORS）', { code: 'network', cause: error });
    }
    if (response.status === 401) throw new NovelSubscriptionError('API Key 无效', { code: 'auth', status: 401 });
    if (!response.ok) throw new NovelSubscriptionError(`订阅查询失败（HTTP ${response.status}）`, { code: 'http', status: response.status });
    const summary = summarizeSubscription(await response.json().catch(() => null));
    if (!summary) throw new NovelSubscriptionError('订阅查询返回格式无法识别', { code: 'parse' });
    return summary;
}

export async function fetchSubscriptionViaPlugin({
    apiKey,
    signal,
    fetchImpl = globalThis.fetch,
    getHeaders = () => ({ 'Content-Type': 'application/json' }),
    insecure = false,
    timeout = 15000,
} = {}) {
    const key = String(apiKey || '').trim();
    if (!key) throw new NovelSubscriptionError('没有 API Key', { code: 'no_key' });
    let response;
    try {
        response = await fetchImpl(NOVEL_BACKEND_SUBSCRIPTION, {
            method: 'POST',
            headers: getHeaders(),
            body: JSON.stringify({ key, insecure: insecure === true, timeout }),
            signal,
        });
    } catch (error) {
        if (isAbort(error, signal)) throw error;
        throw new NovelSubscriptionError('插件订阅查询失败（酒馆服务器不可达）', { code: 'plugin_unreachable', cause: error });
    }
    if (response.status === 404) {
        throw new NovelSubscriptionError('插件没有订阅查询路由（需要 xbdraw-image-proxy 3.0.0）', { code: 'plugin_missing', status: 404 });
    }
    const data = await response.json().catch(() => null);
    if (data?.ok !== true) {
        if (data?.status === 401) throw new NovelSubscriptionError('API Key 无效', { code: 'auth', status: 401 });
        throw new NovelSubscriptionError(data?.error ? `插件订阅查询失败：${String(data.error).slice(0, 200)}` : '插件订阅查询失败', {
            code: 'plugin_error',
            status: Number(data?.status) || response.status,
        });
    }
    const summary = summarizeSubscription(data.subscription);
    if (!summary) throw new NovelSubscriptionError('订阅查询返回格式无法识别', { code: 'parse' });
    return summary;
}

/**
 * @returns {Promise<{source: 'direct'|'plugin'|'manual'|'unknown', subscription: object|null, errors: {code, message}[]}>}
 *   source 'manual' / 'unknown' 时计价必须显示「约」，且不标免费。
 */
export async function resolveNovelSubscription({
    apiKey,
    manualTier = 'auto',
    signal,
    fetchImpl = globalThis.fetch,
    getHeaders,
    insecure = false,
} = {}) {
    const errors = [];
    const fallback = () => {
        const manual = subscriptionFromManualTier(manualTier);
        return manual
            ? { source: 'manual', subscription: manual, errors }
            : { source: 'unknown', subscription: null, errors };
    };
    if (!String(apiKey || '').trim()) {
        errors.push({ code: 'no_key', message: '没有 API Key' });
        return fallback();
    }

    try {
        const subscription = await fetchSubscriptionDirect({ apiKey, signal, fetchImpl });
        return { source: 'direct', subscription, errors };
    } catch (error) {
        if (isAbort(error, signal)) throw error;
        errors.push({ code: error?.code || 'unknown', message: error?.message || String(error) });
        // 只有网络/CORS 失败才换插件；401 等 HTTP 错误说明请求已经到达 NovelAI，换通道没有意义。
        if (error?.code !== 'network') return fallback();
    }

    try {
        const subscription = await fetchSubscriptionViaPlugin({ apiKey, signal, fetchImpl, getHeaders, insecure });
        return { source: 'plugin', subscription, errors };
    } catch (error) {
        if (isAbort(error, signal)) throw error;
        errors.push({ code: error?.code || 'unknown', message: error?.message || String(error) });
        return fallback();
    }
}
