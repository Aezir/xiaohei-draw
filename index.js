// 小黑生图 (XBDraw) — standalone entry for the draw feature extracted from LittleWhiteBox.
// Based on LittleWhiteBox by biex. The provider-switch, draw facade and startup
// sequence below are ported from LittleWhiteBox/index.js; everything unrelated
// to drawing was removed. The two non-NovelAI providers and the background task
// runner were removed in P0 (2026-09-13); only NovelAI remains.
import { extension_settings } from "../../../extensions.js";
import { saveSettingsDebounced } from "../../../../script.js";
import { EXT_ID, EXT_FOLDER_ID, extensionFolderPath } from "./core/constants.js";
import { EventCenter } from "./core/event-manager.js";
import {
    cleanupChatMessageImages,
    initChatMessageImages,
    refreshChatMessageImages,
} from "./modules/draw/shared/chat-message-images.js";
import {
    cleanupNovelDraw,
    initNovelDraw,
} from "./modules/draw/providers/novelai/novel-draw.js";
import { setupDrawGenerateInterceptor } from "./modules/draw/shared/draw-common.js";
import {
    checkGeneratedImageCache as checkGeneratedImageCacheRuntime,
    clearExpiredGeneratedImageCache as clearExpiredGeneratedImageCacheRuntime,
    clearSharedImageRequests as clearSharedImageRequestsRuntime,
    generateSharedImage as generateSharedImageRuntime,
} from "./modules/draw/shared/generated-image-runtime.js";
import { ensureHostSelects } from "./modules/draw/shared/host-select.js";

const LOG = '[小黑生图]';
const DRAW_PROVIDER_VALUES = new Set(['disabled', 'novelai']);

extension_settings[EXT_ID] ||= { enabled: true, drawProvider: 'disabled' };
const settings = extension_settings[EXT_ID];

// 面板已去掉「画图后端」下拉：只剩 NovelAI，开关由「启用小黑生图」一个控制。
if (settings.drawProvider !== 'novelai') {
    console.info(`${LOG} 画图后端固定为 NovelAI（原值 "${settings.drawProvider}"）`);
    settings.drawProvider = 'novelai';
    saveSettingsDebounced();
}

let isEnabled = settings.enabled !== false;
let drawProviderTransitionGeneration = 0;
const moduleCleanupFunctions = new Map();

window.isXbDrawEnabled = isEnabled;

function normalizeDrawProvider(provider) {
    return DRAW_PROVIDER_VALUES.has(provider) ? provider : 'disabled';
}

function registerModuleCleanup(moduleName, cleanupFunction) {
    moduleCleanupFunctions.set(moduleName, cleanupFunction);
}
// Provider modules call this optional global to register their own cleanup.
window.registerModuleCleanup ||= registerModuleCleanup;

async function cleanupDrawProvider(provider = settings.drawProvider) {
    clearSharedImageRequestsRuntime();
    if (normalizeDrawProvider(provider) === 'novelai') {
        try { await cleanupNovelDraw(); } catch (e) { }
    }
}

async function initActiveDrawProvider() {
    settings.drawProvider = normalizeDrawProvider(settings.drawProvider);
    if (!isEnabled) return;
    if (settings.drawProvider === 'novelai') {
        await initNovelDraw();
    }
}

function installDrawFacade() {
    function joinDrawTags(...parts) {
        return parts
            .filter(Boolean)
            .map(part => String(part).trim().replace(/[，、]/g, ',').replace(/^,+|,+$/g, ''))
            .filter(part => part.length > 0)
            .join(', ');
    }

    function getDrawProviderFacade(provider) {
        if (provider === 'novelai') return window.xbdrawNovelDraw;
        return null;
    }

    function normalizeCharacterPrompts(value) {
        return Array.isArray(value)
            ? value.filter(item => item && typeof item === 'object')
            : [];
    }

    function cloneDrawGenerationValue(value) {
        if (typeof structuredClone === 'function') {
            try { return structuredClone(value); } catch { }
        }
        return JSON.parse(JSON.stringify(value));
    }

    function buildDrawPromptData(input = {}) {
        const provider = normalizeDrawProvider(settings.drawProvider);
        const payload = typeof input === 'string' ? { prompt: input } : (input || {});
        const prompt = String(payload.prompt || payload.tags || '').trim();
        const negativePrompt = String(payload.negativePrompt || payload.negative || '').trim();
        const characterPrompts = normalizeCharacterPrompts(payload.characterPrompts);

        if (provider === 'novelai') {
            const novelSettings = window.xbdrawNovelDraw?.getSettings?.();
            const preset = novelSettings?.paramsPresets?.find(p => p.id === novelSettings.selectedParamsPresetId)
                || novelSettings?.paramsPresets?.[0];
            return {
                tags: prompt,
                positive: joinDrawTags(preset?.positivePrefix, prompt),
                negativePrompt: negativePrompt || preset?.negativePrefix || '',
                characterPrompts,
                params: preset?.params || {},
                hasParamsPreset: !!preset,
            };
        }

        return { tags: prompt, positive: prompt, negativePrompt, characterPrompts, params: payload.params || {} };
    }

    function prepareDrawGeneration(input = {}) {
        const provider = normalizeDrawProvider(settings.drawProvider);
        const payload = typeof input === 'string' ? { prompt: input } : (input || {});
        const promptData = cloneDrawGenerationValue(buildDrawPromptData(payload));
        const providerFacade = getDrawProviderFacade(provider);
        const providerSnapshot = providerFacade?.getGenerationSnapshot?.(payload) || {};
        const providerConfig = cloneDrawGenerationValue(providerSnapshot.fingerprint || null);
        const generationConfig = providerSnapshot.execution || null;
        return {
            fingerprint: { version: 1, provider, promptData, providerConfig },
            async execute({ signal, onQueueStateChange } = {}) {
                if (provider === 'novelai') {
                    const novelDraw = window.xbdrawNovelDraw;
                    if (!novelDraw?.generateNovelImage) throw new Error('NovelAI 画图模块未初始化');
                    if (!promptData.hasParamsPreset) throw new Error('无可用的 NovelAI 参数预设');
                    return novelDraw.generateNovelImage({
                        scene: promptData.positive || promptData.tags || '',
                        characterPrompts: promptData.characterPrompts || [],
                        negativePrompt: promptData.negativePrompt || '',
                        params: promptData.params || {},
                        generationConfig,
                        signal,
                        onQueueStateChange,
                    });
                }
                throw new Error('未启用画图后端');
            },
        };
    }

    window.xbdrawDraw = {
        getProvider() {
            return normalizeDrawProvider(settings.drawProvider);
        },
        isEnabled() {
            return isEnabled && normalizeDrawProvider(settings.drawProvider) !== 'disabled';
        },
        getStatus() {
            const provider = normalizeDrawProvider(settings.drawProvider);
            const enabled = isEnabled && provider !== 'disabled';
            const generateImagesFromText = getDrawProviderFacade(provider)?.generateImagesFromText;
            return { provider, enabled, ready: enabled && typeof generateImagesFromText === 'function' };
        },
        buildPromptData(input = {}) {
            return buildDrawPromptData(input);
        },
        prepareGeneration(input = {}) {
            return prepareDrawGeneration(input);
        },
        async generateImage(input = {}) {
            const payload = typeof input === 'string' ? { prompt: input } : (input || {});
            const plan = prepareDrawGeneration(payload);
            return await plan.execute({ signal: payload.signal, onQueueStateChange: payload.onQueueStateChange });
        },
        generateSharedImage(input = {}) {
            return generateSharedImageRuntime(input);
        },
        checkGeneratedImageCache(input = {}) {
            return checkGeneratedImageCacheRuntime(input);
        },
        async generateImagesFromText(input = {}) {
            const provider = normalizeDrawProvider(settings.drawProvider);
            if (!isEnabled || provider === 'disabled') throw new Error('未启用画图后端');
            const generateImagesFromText = getDrawProviderFacade(provider)?.generateImagesFromText;
            if (typeof generateImagesFromText !== 'function') throw new Error('当前画图模块未初始化');
            return generateImagesFromText(input || {});
        },
    };
    void clearExpiredGeneratedImageCacheRuntime();
}

async function startFeatures() {
    try {
        await initActiveDrawProvider();
    } catch (e) {
        console.error(`${LOG} 初始化画图后端失败:`, e);
    }
    try {
        initChatMessageImages();
        registerModuleCleanup('chatMessageImages', cleanupChatMessageImages);
    } catch (e) {
        console.error(`${LOG} 初始化聊天图片失败:`, e);
    }
}

async function stopFeatures() {
    cleanupChatMessageImages();
    try { EventCenter.cleanupAll(); } catch (e) { }
    moduleCleanupFunctions.forEach((fn) => { try { fn(); } catch (e) { } });
    moduleCleanupFunctions.clear();
    drawProviderTransitionGeneration++;
    await cleanupDrawProvider(settings.drawProvider);
}

function syncControls() {
    $('#xbdraw_provider, #xbdraw_open_settings')
        .prop('disabled', !isEnabled)
        .toggleClass('disabled-control', !isEnabled);
}

// 检查更新：走酒馆自带的扩展接口（和扩展管理里的「更新」同一套，git pull 插件目录）。
// 先按「当前用户的扩展」查，找不到（404）再按「所有用户共用的扩展」查。
function setupUpdateCheck() {
    const $button = $('#xbdraw_check_update');
    const $status = $('#xbdraw_update_status');
    let updateReady = null; // 查到有新版本时 = { global }

    const post = (endpoint, global) => fetch(`/api/extensions/${endpoint}`, {
        method: 'POST',
        headers: SillyTavern.getContext().getRequestHeaders(),
        body: JSON.stringify({ extensionName: EXT_FOLDER_ID, global }),
    });
    const findInstall = async () => {
        for (const global of [false, true]) {
            const response = await post('version', global);
            if (response.status === 404) continue;
            if (!response.ok) throw new Error(`酒馆返回 ${response.status}`);
            return { global, data: await response.json() };
        }
        throw new Error('没找到插件目录');
    };
    const setBusy = (busy, text) => {
        $button.prop('disabled', busy);
        if (text !== undefined) $status.text(text);
    };

    $button.on('click', async () => {
        if (updateReady) {
            setBusy(true, '正在更新…');
            try {
                const response = await post('update', updateReady.global);
                if (!response.ok) throw new Error(response.status === 403 ? '没有权限更新共用扩展，请用管理员账号' : `酒馆返回 ${response.status}`);
                const data = await response.json();
                updateReady = null;
                $button.find('span').text('检查');
                setBusy(false, `已更新到 ${data.shortCommitHash || '最新版'}，刷新页面后生效`);
                if (window.confirm('小黑生图已更新，现在刷新页面吗？')) location.reload();
            } catch (error) {
                setBusy(false, `更新失败：${error?.message || error}`);
            }
            return;
        }
        setBusy(true, '正在检查…');
        try {
            const { global, data } = await findInstall();
            const version = String(data.currentCommitHash || '').slice(0, 7);
            if (!data.remoteUrl) {
                setBusy(false, '这个目录不是从 GitHub 装的，没法在线更新');
            } else if (data.isUpToDate) {
                setBusy(false, `已是最新版${version ? `（${version}）` : ''}`);
            } else {
                updateReady = { global };
                $button.find('span').text('立即更新');
                setBusy(false, `有新版本（当前 ${version || '未知'}）`);
            }
        } catch (error) {
            setBusy(false, `检查失败：${error?.message || error}`);
        }
    });
}

async function setupSettings() {
    const container = document.getElementById('extensions_settings');
    if (!container) return;
    const response = await fetch(`${extensionFolderPath}/settings.html`);
    $(container).append(await response.text());
    // 自绘下拉只接管 XBDraw 自己的容器（抽屉里的「画图后端」等），原生 select 仍是数据源
    ensureHostSelects().catch(error => console.warn(`${LOG} 自绘下拉加载失败:`, error));

    $('#xbdraw_enabled').prop('checked', isEnabled).on('change', async function () {
        const next = $(this).prop('checked') === true;
        if (next === isEnabled) return;
        isEnabled = next;
        settings.enabled = next;
        window.isXbDrawEnabled = next;
        saveSettingsDebounced();
        syncControls();
        if (next) await startFeatures();
        else await stopFeatures();
        try { refreshChatMessageImages(); } catch { }
    });

    $('#xbdraw_provider')
        .val(normalizeDrawProvider(settings.drawProvider))
        .on('change', async function () {
            if (!isEnabled) return;
            const prev = normalizeDrawProvider(settings.drawProvider);
            const next = normalizeDrawProvider(String($(this).val() || 'disabled'));
            if (next !== $(this).val()) $(this).val(next);
            if (prev === next) return;

            const transitionGeneration = ++drawProviderTransitionGeneration;
            settings.drawProvider = next;
            saveSettingsDebounced();
            await cleanupDrawProvider(prev);
            if (transitionGeneration !== drawProviderTransitionGeneration) return;
            await initActiveDrawProvider();
            try { refreshChatMessageImages(); } catch { }
        });

    setupUpdateCheck();

    $('#xbdraw_open_settings').on('click', function () {
        if (!isEnabled) return;
        const provider = normalizeDrawProvider(settings.drawProvider);
        const facade = getDrawProviderFacadeForSettings(provider);
        if (provider === 'disabled') toastr.warning('请先选择画图后端');
        else if (facade?.openSettings) facade.openSettings();
        else toastr.warning('画图模块还没有初始化完成');
    });

    syncControls();
}

function getDrawProviderFacadeForSettings(provider) {
    return provider === 'novelai' ? window.xbdrawNovelDraw : null;
}

installDrawFacade();
setupDrawGenerateInterceptor({ shouldStrip: () => isEnabled });

jQuery(async () => {
    try {
        await setupSettings();
        if (isEnabled) await startFeatures();
    } catch (err) {
        console.error(`${LOG} 初始化失败:`, err);
    }
});
