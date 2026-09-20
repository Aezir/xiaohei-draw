// 场景 Agent「Provider」下拉里的官方渠道快捷项：选一下 = 通道切成「酒馆 OpenAI 兼容」+ 自动填官方地址。
// 以前这些地址放在 Base URL 输入框的 datalist 里，手机上一点输入框就弹一排选项把键盘挡住，所以挪到这里。
// 走酒馆通道是因为由酒馆后端代发不过浏览器 CORS，TauriTavern 里浏览器直连这些官方站基本都会被拦。
export const VENDOR_PROVIDER_PREFIX = 'vendor:';
export const VENDOR_TARGET_PROVIDER = 'sillytavern-openai-compatible';

export const VENDOR_PRESETS = Object.freeze([
    { id: 'deepseek', label: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1' },
    { id: 'zhipu', label: '智谱 GLM', baseUrl: 'https://open.bigmodel.cn/api/paas/v4' },
    { id: 'moonshot', label: 'Kimi（月之暗面）', baseUrl: 'https://api.moonshot.cn/v1' },
    { id: 'siliconflow', label: '硅基流动', baseUrl: 'https://api.siliconflow.cn/v1' },
    { id: 'dashscope', label: '通义千问（阿里百炼）', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1' },
    { id: 'volces', label: '豆包（火山方舟）', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3' },
    { id: 'minimax', label: 'MiniMax', baseUrl: 'https://api.minimaxi.com/v1' },
    { id: 'openrouter', label: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1' },
]);

/** 下拉的 option 值 → 渠道；不是渠道快捷项返回 null */
export function resolveVendorPreset(value) {
    const raw = String(value || '');
    if (!raw.startsWith(VENDOR_PROVIDER_PREFIX)) return null;
    const id = raw.slice(VENDOR_PROVIDER_PREFIX.length);
    return VENDOR_PRESETS.find(item => item.id === id) || null;
}

export function buildVendorOptionsMarkup() {
    return VENDOR_PRESETS
        .map(item => `<option value="${VENDOR_PROVIDER_PREFIX}${item.id}">${item.label}</option>`)
        .join('\n');
}
