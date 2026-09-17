// 「导出全局配置」：把插件设置、共享画图设置、场景 Agent 配置拼成一个 JSON。纯函数，node 可测。

const SECRET_KEY_RE = /^(apiKey|api_key|tavilyApiKey|proxy_password|password|token|tok|secret)$|ApiKey$/i;

/** 深拷贝并清空所有密钥字段（值改成空字符串，结构保留，方便对照）。 */
export function stripSecrets(value) {
    if (Array.isArray(value)) return value.map(stripSecrets);
    if (!value || typeof value !== 'object') return value;
    const out = {};
    for (const [key, item] of Object.entries(value)) {
        out[key] = SECRET_KEY_RE.test(key) && (typeof item === 'string' || item == null) ? '' : stripSecrets(item);
    }
    return out;
}

export function buildSettingsExport({ provider = {}, shared = {}, sceneAgent = null, includeKeys = false, now = new Date() } = {}) {
    const clone = value => (value == null ? value : JSON.parse(JSON.stringify(value)));
    const body = {
        novelDraw: clone(provider),
        sharedDraw: clone(shared),
        sceneAgent: clone(sceneAgent),
    };
    return {
        app: 'xiaohei-draw',
        kind: 'global-settings',
        exportedAt: now.toISOString(),
        includesKeys: includeKeys === true,
        ...(includeKeys === true ? body : stripSecrets(body)),
    };
}

export function settingsExportFileName(now = new Date(), includeKeys = false, label = '') {
    const pad = n => String(n).padStart(2, '0');
    const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`;
    return `小黑生图配置-${label ? `${label}-` : ''}${stamp}${includeKeys ? '-含Key' : ''}.json`;
}

/** 导入前检查：必须是小黑生图导出的全局配置，且至少有一块设置。返回 { ok, error, sections }。 */
export function validateSettingsImport(data) {
    if (!data || typeof data !== 'object' || Array.isArray(data)) return { ok: false, error: '文件内容不是配置对象', sections: [] };
    if (data.app !== 'xiaohei-draw' || data.kind !== 'global-settings') return { ok: false, error: '这不是小黑生图导出的配置文件', sections: [] };
    const isObj = v => v && typeof v === 'object' && !Array.isArray(v);
    const sections = [
        isObj(data.novelDraw) && 'novelDraw',
        isObj(data.sharedDraw) && 'sharedDraw',
        isObj(data.sceneAgent) && 'sceneAgent',
    ].filter(Boolean);
    if (!sections.length) return { ok: false, error: '文件里没有可导入的设置', sections };
    return { ok: true, error: '', sections };
}
