import { getContext } from "../../../../../../extensions.js";
import {
    getDisplayPreviewForSlot,
    getPreviewsBySlot,
    getPreviewDisplayUrl,
    subscribeGalleryCacheChanges,
    warmSlotPreviewNeighbors,
} from "./gallery-cache.js";
import {
    ScenePlannerError,
} from "./scene-plan-contract.js";
import { ScenePlacementError } from './scene-placement.js';
import { replaceSceneSlotElements } from './scene-slot-dom.js';
import { DEFAULT_MESSAGE_FILTER_RULES } from './message-filter-rules.js';
import { createMessageRerenderer } from './message-rerender.js';
import { hasStatusPlaceholder } from './draw-log.js';
import { isDrawLogWatchingMessage, readDrawLogMvuBusy, reportRenderToDrawLog } from './draw-log-store.js';
import { createDrawImageSlotRegex } from './image-marker-syntax.js';
import { classifyScenePlannerErrorForUi } from "./scene-planner-error-ui.js";
import { isCharacterEnabled } from './character-selection.js';
import { joinTags } from './character-prompts.js';
import { createModuleEvents, event_types } from "../../../core/event-manager.js";
import {
    GENERATE_INTERCEPTOR_ORDER,
    registerGenerateInterceptor,
    unregisterGenerateInterceptor,
} from "../../../shared/common/generate-interceptor.js";
import {
    ImageState,
    buildFailedPlaceholderHtml,
    buildImageHtml,
    buildPendingImageHtml,
    ensureChatImageStyles,
} from './chat-image-card.js';

const DRAW_IMAGE_HTML_REGEX = /<div\b[^>]*class=(["'])[^"']*\bxb-nd-img\b[^"']*\1[^>]*>[\s\S]*?<\/div>/gi;
const DRAW_SAVED_EXTRA_KEY = 'xiaobaixDrawSaved';
const LEGACY_NOVEL_SAVED_EXTRA_KEY = 'novelDrawSaved';
const INITIAL_RENDER_MESSAGE_LIMIT = 1;

let drawPreviewRuntimeEvents = null;
let drawPreviewRuntimeRefs = 0;
let drawPreviewMessageObserver = null;
let drawPreviewRuntimeGeneration = 0;
let drawPreviewCacheSyncCleanup = null;
const drawPreviewPendingTimers = new Set();
const drawPreviewRenderQueues = new WeakMap();

// 图片卡的状态、标记和样式统一在 chat-image-card.js，这里保留原来的导出名。
export { ImageState };

export const ErrorType = {
    INPUT: { code: 'input', label: '正文输入', desc: '正文没有可用的配图内容' },
    NETWORK: { code: 'network', label: '网络', desc: '连接超时或网络不稳定' },
    AUTH: { code: 'auth', label: '认证', desc: '认证信息无效或过期' },
    QUOTA: { code: 'quota', label: '额度', desc: '额度不足' },
    BUSY: { code: 'busy', label: '繁忙', desc: '当前并发繁忙，请稍后重试' },
    PARSE: { code: 'parse', label: '解析失败', desc: 'LLM 输出未解析为图片任务' },
    LLM: { code: 'llm', label: 'LLM失败', desc: '场景分析失败' },
    LLM_EMPTY: { code: 'llm_empty', label: '空回', desc: 'LLM 未返回内容' },
    TIMEOUT: { code: 'timeout', label: '超时', desc: '请求超时' },
    AGENT_CONFIG: { code: 'agent_config', label: 'Agent 配置', desc: '共享 Agent 主预设不可用' },
    PROMPT_EXPANSION: { code: 'prompt_expansion', label: 'Prompt 展开', desc: 'Prompt 宏展开失败，请检查提示词中的变量宏' },
    TOOL_PROTOCOL: { code: 'tool_protocol', label: 'Tool 协议', desc: '模型没有按要求调用场景规划 Tool' },
    SCENE_SCHEMA: { code: 'scene_schema', label: '计划校验', desc: '模型提交的场景计划不符合契约' },
    PROVIDER: { code: 'provider', label: 'Provider', desc: '模型 Provider 请求失败' },
    SCENE_PLACEMENT: { code: 'scene_placement', label: '插图位置', desc: '正文位置已变化，未写入图片' },
    ABORTED: { code: 'aborted', label: '已取消', desc: '场景规划已取消' },
    UNKNOWN: { code: 'unknown', label: '错误', desc: '未知错误' },
    CACHE_LOST: { code: 'cache_lost', label: '缓存丢失', desc: '图片缓存已过期' },
    JOB_EXPIRED: { code: 'job_expired', label: '后台任务已失效', desc: '后台任务已过期或被清理，可重新生成' },
    JOB_NOT_SUBMITTED: { code: 'job_not_submitted', label: '任务未提交', desc: '后台任务未提交成功，可重新生成' },
};

// 默认过滤规则的唯一来源在 message-filter-rules.js（纯数据，便于测试和设置迁移）。
export { DEFAULT_MESSAGE_FILTER_RULES };

// 楼层重渲染统一走酒馆 updateMessageBlock + MESSAGE_UPDATED，见 message-rerender.js。
const chatMessageRerenderer = createMessageRerenderer({
    loadHost: async () => {
        const host = await import('../../../../../../../script.js');
        return {
            updateMessageBlock: host.updateMessageBlock,
            emitMessageUpdated: messageId => host.eventSource.emit(host.event_types.MESSAGE_UPDATED, messageId),
        };
    },
    isEditing: messageId => isMessageBeingEdited(messageId),
    // 酒馆助手认的状态栏代码块（pre 里含 html> / <head> / <body）还没变成 iframe = 需要再触发一次渲染
    needsRenderRetry: (messageId) => {
        const mesText = getMesTextElement(messageId);
        if (!mesText) return false;
        return Array.from(mesText.querySelectorAll('pre')).some((pre) => {
            const text = pre.textContent || '';
            if (!['html>', '<head>', '<body'].some(key => text.includes(key))) return false;
            const box = pre.closest('div.TH-render');
            return !box || !box.querySelector('iframe');
        });
    },
    // 设置页「日志」的楼层渲染记录。整段包 try：日志出错不影响渲染
    onRenderReport: (report) => {
        try {
            const isFollowUp = report?.stage === 'checked' || report?.stage === 'retried' || report?.stage === 'superseded';
            if (!isFollowUp && !isDrawLogWatchingMessage(report?.messageId)) return;
            const { text, ...rest } = report || {};
            if (rest.stage === 'rendered') {
                rest.mvuBusy = readDrawLogMvuBusy();
                rest.hasPlaceholder = hasStatusPlaceholder(text);
            }
            if (rest.stage === 'checked') rest.statusBar = inspectStatusBarForLog(rest.messageId);
            reportRenderToDrawLog(rest);
        } catch {
            /* 日志坏了不影响渲染 */
        }
    },
});

// 日志用：状态栏现在是 iframe、还是代码、还是这层根本没有状态栏
function inspectStatusBarForLog(messageId) {
    const mesText = getMesTextElement(messageId);
    if (!mesText) return 'none';
    const hasCode = Array.from(mesText.querySelectorAll('pre')).some((pre) => {
        const text = pre.textContent || '';
        if (!['html>', '<head>', '<body'].some(key => text.includes(key))) return false;
        const box = pre.closest('div.TH-render');
        return !box || !box.querySelector('iframe');
    });
    if (hasCode) return 'code';
    return mesText.querySelector('iframe') ? 'iframe' : 'none';
}

export function rerenderChatMessage(messageId, message, options = {}) {
    return chatMessageRerenderer.rerender(messageId, message, options);
}

export function isSelfEmittedMessageUpdate(messageId) {
    return chatMessageRerenderer.isSelfUpdate(messageId);
}

export function toScenePlannerProgress(diagnostic = {}) {
    const phase = diagnostic?.progress?.phase;
    return { phase: phase === 'correction' ? 'correction' : 'analysis' };
}

export function formatScenePlannerProgress(progress = {}) {
    return toScenePlannerProgress({ progress }).phase === 'correction' ? '纠错' : '分析';
}

export function createPlaceholder(slotId) {
    return `[image:${slotId}]`;
}

function stripDrawImageHtml(text) {
    const value = String(text || '');
    if (!value.includes('xb-nd-img')) return value;
    if (typeof document === 'undefined') return value.replace(DRAW_IMAGE_HTML_REGEX, '');

    const template = document.createElement('template');
    // Local chat markup generated by the draw modules.
    // eslint-disable-next-line no-unsanitized/property
    template.innerHTML = value;
    template.content.querySelectorAll('.xb-nd-img').forEach(node => node.remove());
    return template.innerHTML || '';
}

export function stripDrawArtifactsFromMessage(text) {
    return stripDrawImageHtml(text).replace(createDrawImageSlotRegex(), '');
}

export function stripDrawArtifactsFromChat(chat) {
    if (!Array.isArray(chat)) return;
    for (const msg of chat) {
        if (!msg) continue;
        if (typeof msg.mes === 'string') {
            msg.mes = stripDrawArtifactsFromMessage(msg.mes);
        }
        if (typeof msg.content === 'string') {
            msg.content = stripDrawArtifactsFromMessage(msg.content);
        } else if (Array.isArray(msg.content)) {
            for (const part of msg.content) {
                if (part && typeof part.text === 'string') {
                    part.text = stripDrawArtifactsFromMessage(part.text);
                }
            }
        }
    }
}

export function setupDrawGenerateInterceptor(options = {}) {
    const shouldStrip = typeof options.shouldStrip === 'function' ? options.shouldStrip : () => true;
    registerGenerateInterceptor('draw', (chat) => {
        if (!shouldStrip()) return;
        stripDrawArtifactsFromChat(chat);
    }, GENERATE_INTERCEPTOR_ORDER.DRAW);
}

export function cleanupDrawGenerateInterceptor() {
    unregisterGenerateInterceptor('draw');
}

export { joinTags };

export function escapeHtml(str) {
    return String(str || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function escapeRegexChars(str) {
    return String(str || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeNamedTagList(list = []) {
    return (Array.isArray(list) ? list : [])
        .map(item => ({
            name: String(item?.name || '').trim(),
            tags: String(item?.tags || '').trim(),
        }))
        .filter(item => item.name || item.tags);
}

export function detectPresentCharacters(messageText, characterTags) {
    if (!messageText || !characterTags?.length) return [];
    const text = messageText.toLowerCase();
    const present = [];

    for (const char of characterTags) {
        if (!isCharacterEnabled(char) || !char.name) continue;
        const names = [char.name, ...(char.aliases || [])].filter(Boolean);
        const isPresent = names.some(name => {
            const lowerName = String(name).toLowerCase();
            return text.includes(lowerName) || new RegExp(`\\b${escapeRegexChars(lowerName)}\\b`, 'i').test(text);
        });

        if (isPresent) {
            present.push({
                name: char.name,
                aliases: char.aliases || [],
                type: char.type || 'girl',
                appearance: char.appearance || '',
                danbooruTag: char.danbooruTag || '',
                negativeTags: char.negativeTags || '',
                outfits: normalizeNamedTagList(char.outfits),
                dynamicStates: normalizeNamedTagList(char.dynamicStates),
            });
        }
    }
    return present;
}

export function findLastAIMessageId() {
    const ctx = getContext();
    const chat = ctx.chat || [];
    let id = chat.length - 1;
    while (id >= 0 && chat[id]?.is_user) id--;
    return id;
}

export function classifyError(error) {
    if (error instanceof ScenePlannerError) {
        return classifyScenePlannerErrorForUi(error, ErrorType);
    }
    if (error instanceof ScenePlacementError) {
        return { ...ErrorType.SCENE_PLACEMENT, desc: error.message || ErrorType.SCENE_PLACEMENT.desc };
    }
    if (error?.errorType) return error.errorType;
    // 带 HTTP status 的后端错误优先按 status 分类：上游正文常常不写数字，靠 message 匹配会退化成未知错误。
    const status = Number(error?.status) || 0;
    if (status === 401 || status === 403) return ErrorType.AUTH;
    if (status === 402) return ErrorType.QUOTA;
    if (status === 429) return ErrorType.BUSY;
    if (status === 408 || status === 504) return ErrorType.TIMEOUT;
    const msg = String(error?.message || error || '').toLowerCase();
    if (msg.includes('network') || msg.includes('fetch') || msg.includes('failed to fetch')) return ErrorType.NETWORK;
    if (msg.includes('401') || msg.includes('key') || msg.includes('auth')) return ErrorType.AUTH;
    if (msg.includes('429') || msg.includes('too many requests') || msg.includes('rate limit') || msg.includes('请求频繁') || msg.includes('busy')) return ErrorType.BUSY;
    if (msg.includes('402') || msg.includes('anlas') || msg.includes('quota')) return ErrorType.QUOTA;
    if (msg.includes('timeout') || msg.includes('abort')) return ErrorType.TIMEOUT;
    if (msg.includes('输出为空') || msg.includes('empty_output') || msg.includes('未返回内容')) return ErrorType.LLM_EMPTY;
    if (msg.includes('parse') || msg.includes('json')) return ErrorType.PARSE;
    if (msg.includes('无法解析') || msg.includes('未解析到图片任务')) return ErrorType.PARSE;
    if (msg.includes('llm') || msg.includes('xbgenraw')) return ErrorType.LLM;
    return { ...ErrorType.UNKNOWN, desc: error?.message || '未知错误' };
}

export {
    buildImageHtml,
    buildFailedPlaceholderHtml,
    buildPendingImageHtml,
    ensureChatImageStyles as ensureDrawImageStyles,
};

function getMesTextElement(messageId) {
    const id = Number(messageId);
    if (!Number.isInteger(id) || id < 0) return null;
    return document.querySelector(`#chat .mes[mesid="${id}"] .mes_text`);
}

export function isMessageBeingEdited(messageId) {
    const id = Number(messageId);
    if (!Number.isInteger(id) || id < 0) return false;
    const mesElement = document.querySelector(`.mes[mesid="${id}"]`);
    if (!mesElement) return false;
    return mesElement.querySelector('textarea.edit_textarea') !== null || mesElement.classList.contains('editing');
}

export function isAnyMessageBeingEdited() {
    return document.querySelector('#chat .mes.editing, #chat .mes textarea.edit_textarea') !== null;
}

export function buildDrawSlotSelector(slotId) {
    const escaped = Array.from(String(slotId ?? '')).map((char) => {
        const code = char.codePointAt(0);
        if (char === '\0') return '\\fffd ';
        if ((code >= 1 && code <= 31) || code === 127) return `\\${code.toString(16)} `;
        if (char === '"' || char === '\\') return `\\${char}`;
        return char;
    }).join('');
    return `.xb-nd-img[data-slot-id="${escaped}"]`;
}

export function extractSlotIds(mes) {
    const ids = new Set();
    if (!mes) return ids;
    let match;
    const regex = createDrawImageSlotRegex();
    while ((match = regex.exec(mes)) !== null) ids.add(match[1]);
    return ids;
}

async function persistChatSilently() {
    const ctx = getContext();
    if (!ctx?.saveChat) return;
    await Promise.resolve(ctx.saveChat());
}

function getSavedMap(message, key) {
    const savedMap = message?.extra?.[key];
    return savedMap && typeof savedMap === 'object' ? savedMap : null;
}

function ensureMessageExtra(message) {
    if (!message) return null;
    if (!message.extra || typeof message.extra !== 'object') {
        message.extra = {};
    }
    return message.extra;
}

function ensureSavedMap(message, key) {
    const extra = ensureMessageExtra(message);
    if (!extra) return null;
    if (!extra[key] || typeof extra[key] !== 'object') {
        extra[key] = {};
    }
    return extra[key];
}

function normalizeDrawSavedEntry(slotId, data = {}) {
    if (!slotId || !data?.savedUrl) return null;
    return {
        slotId,
        imgId: data.imgId || '',
        savedUrl: data.savedUrl,
        tags: data.tags || '',
        positive: data.positive || '',
        updatedAt: Number.isFinite(data.updatedAt) ? data.updatedAt : Date.now(),
    };
}

export function getDrawSavedEntry(message, slotId) {
    if (!slotId) return null;
    const current = normalizeDrawSavedEntry(slotId, getSavedMap(message, DRAW_SAVED_EXTRA_KEY)?.[slotId]);
    if (current) return current;
    return normalizeDrawSavedEntry(slotId, getSavedMap(message, LEGACY_NOVEL_SAVED_EXTRA_KEY)?.[slotId]);
}

export async function setDrawSavedEntry(messageId, slotId, data) {
    const ctx = getContext();
    const message = ctx.chat?.[messageId];
    const entry = normalizeDrawSavedEntry(slotId, data);
    if (!message || !entry) return false;

    const savedMap = ensureSavedMap(message, DRAW_SAVED_EXTRA_KEY);
    if (!savedMap) return false;

    const previous = savedMap[slotId];
    const unchanged = previous &&
        previous.imgId === entry.imgId &&
        previous.savedUrl === entry.savedUrl &&
        previous.tags === entry.tags &&
        previous.positive === entry.positive;
    const legacyMap = getSavedMap(message, LEGACY_NOVEL_SAVED_EXTRA_KEY);
    const hasLegacyEntry = !!legacyMap?.[slotId];
    if (unchanged && !hasLegacyEntry) return true;

    savedMap[slotId] = entry;
    if (hasLegacyEntry) {
        delete legacyMap[slotId];
        if (Object.keys(legacyMap).length === 0) {
            delete message.extra[LEGACY_NOVEL_SAVED_EXTRA_KEY];
        }
    }
    await persistChatSilently();
    return true;
}

export async function clearDrawSavedEntry(messageId, slotId) {
    const ctx = getContext();
    const message = ctx.chat?.[messageId];
    if (!message?.extra || !slotId) return false;

    let changed = false;
    for (const key of [DRAW_SAVED_EXTRA_KEY, LEGACY_NOVEL_SAVED_EXTRA_KEY]) {
        const savedMap = getSavedMap(message, key);
        if (!savedMap?.[slotId]) continue;
        delete savedMap[slotId];
        changed = true;
        if (Object.keys(savedMap).length === 0) delete message.extra[key];
    }

    if (!changed) return false;
    await persistChatSilently();
    return true;
}

export async function syncDrawSavedFromPreview(messageId, preview, overrides = {}) {
    const slotId = overrides.slotId || preview?.slotId;
    if (!slotId) return false;

    return setDrawSavedEntry(messageId, slotId, {
        imgId: overrides.imgId || preview?.imgId,
        savedUrl: overrides.savedUrl || preview?.savedUrl,
        tags: overrides.tags ?? preview?.tags ?? '',
        positive: overrides.positive ?? preview?.positive ?? '',
    });
}

export async function syncDrawSavedAfterDeletion(messageId, slotId, deletedImgId, remainingPreviews = []) {
    const message = getContext().chat?.[messageId];
    const currentSaved = getDrawSavedEntry(message, slotId);
    if (!currentSaved) return false;
    if (deletedImgId && currentSaved.imgId && currentSaved.imgId !== deletedImgId) return false;

    const replacement = remainingPreviews.find(item => item?.savedUrl);
    if (replacement) return syncDrawSavedFromPreview(messageId, replacement, { slotId });
    return clearDrawSavedEntry(messageId, slotId);
}

export function insertPreviewIntoRenderedMessage({ messageId, slotId, html }) {
    const mesTextEl = getMesTextElement(messageId);
    if (!mesTextEl || !slotId || !html) return false;
    const insertedSlotIds = replaceSceneSlotElements(mesTextEl, [{ slotId, html }]);
    if (insertedSlotIds.has(slotId)) return true;
    return mesTextEl.querySelector(buildDrawSlotSelector(slotId)) !== null;
}

async function resolveRenderPreviewForSlot(message, messageId, slotId) {
    const savedEntry = getDrawSavedEntry(message, slotId);
    if (savedEntry?.savedUrl) {
        const previews = await getPreviewsBySlot(slotId).catch(() => []);
        const successPreviews = previews.filter(p => p.status !== 'failed' && (p.base64 || p.savedUrl));
        const selectedIndex = successPreviews.findIndex(p => p.imgId === savedEntry.imgId);
        const matchedPreview = selectedIndex >= 0 ? successPreviews[selectedIndex] : null;

        return {
            preview: {
                ...matchedPreview,
                slotId,
                imgId: savedEntry.imgId || matchedPreview?.imgId || `saved-${slotId}`,
                savedUrl: savedEntry.savedUrl,
                tags: savedEntry.tags ?? matchedPreview?.tags ?? '',
                positive: savedEntry.positive ?? matchedPreview?.positive ?? '',
                messageId,
            },
            historyCount: selectedIndex >= 0 ? successPreviews.length : 1,
            currentIndex: selectedIndex >= 0 ? selectedIndex : 0,
            hasData: true,
            isFailed: false,
        };
    }

    const displayData = await getDisplayPreviewForSlot(slotId);
    return { ...displayData, currentIndex: 0 };
}

async function rebuildRenderedMessageFromState(messageId, {
    chatId,
    expectedMessage,
} = {}) {
    const ctx = getContext();
    const message = ctx.chat?.[messageId];
    if (!message || (chatId !== undefined && String(ctx.chatId || '') !== String(chatId || ''))
        || (expectedMessage && message !== expectedMessage) || isMessageBeingEdited(messageId)) return false;
    if (!getMesTextElement(messageId)) return false;
    return rerenderChatMessage(messageId, message);
}

function renderedMessageContainsSlot(mesTextEl, slotId) {
    if (mesTextEl.querySelector(buildDrawSlotSelector(slotId))) return true;
    return String(mesTextEl.textContent || '').includes(createPlaceholder(slotId));
}

async function renderPreviewsForMessageNow(messageId, {
    refreshSlotIds = [],
    expectedChatId,
    expectedMessage,
    allowRebuild = true,
} = {}) {
    const ctx = getContext();
    const message = ctx.chat?.[messageId];
    if (!message?.mes
        || String(ctx.chatId || '') !== String(expectedChatId || '')
        || message !== expectedMessage) return;

    const sourceText = message.mes;
    const slotIds = extractSlotIds(sourceText);
    let mesTextEl = getMesTextElement(messageId);
    if (!mesTextEl) return;
    // allowRebuild=false：这次是本插件自己发出的 MESSAGE_UPDATED 触发的，楼层刚按 message 重渲染过；
    // 再重建一次只会再发一次事件，形成循环（例如 display_text 里本来就没有槽位时）。
    if (allowRebuild && [...slotIds].some(slotId => !renderedMessageContainsSlot(mesTextEl, slotId))) {
        // message.mes 是持久化排版事实。adoption 当下若恰逢聊天切换或宿主 DOM
        // 尚未挂载，一次局部 patch 可能没有锚点；先按前台生成相同的宿主格式
        // 重建楼层，再在下面统一投影 pending 卡或图片。
        const rebuilt = await rebuildRenderedMessageFromState(messageId, {
            chatId: ctx.chatId,
            expectedMessage: message,
        });
        if (!rebuilt) return;
        mesTextEl = getMesTextElement(messageId);
        if (!mesTextEl) return;
    }
    const refreshSlots = new Set((Array.isArray(refreshSlotIds) ? refreshSlotIds : [])
        .map(slotId => String(slotId || '').trim())
        .filter(Boolean));
    for (const slotId of refreshSlots) {
        if (!slotIds.has(slotId)) mesTextEl.querySelector(buildDrawSlotSelector(slotId))?.remove();
    }
    if (slotIds.size === 0) return;

    const replacements = [];
    for (const slotId of slotIds) {
        if (!refreshSlots.has(slotId) && mesTextEl.querySelector(buildDrawSlotSelector(slotId))) continue;
        let replacementHtml;
        try {
            const displayData = await resolveRenderPreviewForSlot(message, messageId, slotId);
            if (displayData.isFailed) {
                replacementHtml = buildFailedPlaceholderHtml({
                    slotId,
                    messageId,
                    tags: displayData.failedInfo?.tags || '',
                    positive: displayData.failedInfo?.positive || '',
                    errorType: displayData.failedInfo?.errorType || ErrorType.CACHE_LOST.label,
                    errorMessage: displayData.failedInfo?.errorMessage || ErrorType.CACHE_LOST.desc,
                });
            } else if (displayData.hasData && displayData.preview) {
                const url = getPreviewDisplayUrl(displayData.preview);
                replacementHtml = buildImageHtml({
                    slotId,
                    imgId: displayData.preview.imgId,
                    url,
                    tags: displayData.preview.tags || '',
                    positive: displayData.preview.positive || '',
                    messageId,
                    state: displayData.preview.savedUrl ? ImageState.SAVED : ImageState.PREVIEW,
                    historyCount: displayData.historyCount,
                    currentIndex: displayData.currentIndex ?? 0,
                });
                void warmSlotPreviewNeighbors(slotId, displayData.currentIndex ?? 0).catch(() => {});
            } else {
                replacementHtml = buildFailedPlaceholderHtml({
                    slotId,
                    messageId,
                    tags: '',
                    positive: '',
                    errorType: ErrorType.CACHE_LOST.label,
                    errorMessage: ErrorType.CACHE_LOST.desc,
                });
            }
        } catch (error) {
            console.error(`[DrawCommon] 渲染 ${slotId} 失败:`, error);
            replacementHtml = buildFailedPlaceholderHtml({
                slotId,
                messageId,
                tags: '',
                positive: '',
                errorType: ErrorType.UNKNOWN.label,
                errorMessage: error?.message || '未知错误',
            });
        }
        replacements.push({ slotId, html: replacementHtml });
    }

    if (replacements.length === 0) return;
    const live = getContext();
    if (String(live.chatId || '') !== String(ctx.chatId || '')
        || live.chat?.[messageId] !== message
        || message.mes !== sourceText
        || getMesTextElement(messageId) !== mesTextEl
        || isMessageBeingEdited(messageId)) return;
    replaceSceneSlotElements(mesTextEl, replacements);
}

// 同一楼层只允许一个异步投影在运行。图片落库、恢复状态变化和消息事件可能在同一时刻
// 发起刷新；串行执行保证较早读取的旧事实一定先完成，最后留在 DOM 的总是较新的投影。
// 队列只绑定当前 message 对象，聊天切换或宿主替换消息对象后，旧任务会被上面的身份守卫丢弃。
export function renderPreviewsForMessage(messageId, { refreshSlotIds = [], allowRebuild = true } = {}) {
    const ctx = getContext();
    const message = ctx.chat?.[messageId];
    if (!message?.mes) return Promise.resolve();
    const expectedChatId = ctx.chatId;

    let queue = drawPreviewRenderQueues.get(message);
    if (!queue) {
        queue = { tail: Promise.resolve() };
        drawPreviewRenderQueues.set(message, queue);
    }
    const requestedSlots = Array.isArray(refreshSlotIds) ? [...refreshSlotIds] : [];
    const render = queue.tail.then(() => renderPreviewsForMessageNow(messageId, {
        refreshSlotIds: requestedSlots,
        expectedChatId,
        expectedMessage: message,
        allowRebuild,
    }));
    const tail = render.catch(() => {});
    queue.tail = tail;
    void tail.then(() => {
        if (queue.tail === tail) drawPreviewRenderQueues.delete(message);
    });
    return render;
}

// Draw Run adoption 会在酒馆完成楼层渲染之后才把 slots 写进 message.mes。
// 仅替换已有 DOM 锚点不够，必须先按宿主规则重建活动楼层，再把 slots 渲染成 pending/图片卡。
export async function syncRenderedMessageFromState(messageId, { chatId, expectedMessage } = {}) {
    const rebuilt = await rebuildRenderedMessageFromState(messageId, { chatId, expectedMessage });
    if (!rebuilt) return false;
    await renderPreviewsForMessage(messageId);
    return true;
}

function initDrawPreviewMessageObserver() {
    if (drawPreviewMessageObserver) return;
    drawPreviewMessageObserver = new IntersectionObserver((entries) => {
        entries.forEach(entry => {
            if (!entry.isIntersecting) return;
            const mesEl = entry.target;
            drawPreviewMessageObserver.unobserve(mesEl);
            delete mesEl.dataset.ndLazyObserved;
            const messageId = parseInt(mesEl.getAttribute('mesid'), 10);
            if (!Number.isNaN(messageId)) {
                renderPreviewsForMessage(messageId);
            }
        });
    }, { rootMargin: '600px 0px', threshold: 0.01 });
}

function observeMessageForDrawPreviewLazyRender(messageId) {
    const mesEl = document.querySelector(`.mes[mesid="${messageId}"]`);
    if (!mesEl || mesEl.dataset.ndLazyObserved === '1') return;
    initDrawPreviewMessageObserver();
    mesEl.dataset.ndLazyObserved = '1';
    drawPreviewMessageObserver.observe(mesEl);
}

function isMessageNearViewport(mesEl) {
    if (!mesEl) return false;
    const root = document.getElementById('chat');
    const rootRect = root?.getBoundingClientRect?.() || { top: 0, bottom: window.innerHeight || 0 };
    const rect = mesEl.getBoundingClientRect();
    return rect.bottom >= rootRect.top - 600 && rect.top <= rootRect.bottom + 600;
}

function cleanupDrawPreviewMessageObserver() {
    if (drawPreviewMessageObserver) {
        drawPreviewMessageObserver.disconnect();
        drawPreviewMessageObserver = null;
    }
    document.querySelectorAll('[data-nd-lazy-observed="1"]').forEach(el => {
        delete el.dataset.ndLazyObserved;
    });
}

export async function renderAllDrawPreviews() {
    const ctx = getContext();
    const chat = ctx.chat || [];
    let rendered = 0;

    for (let i = chat.length - 1; i >= 0; i--) {
        if (extractSlotIds(chat[i]?.mes).size === 0) continue;
        const mesEl = document.querySelector(`.mes[mesid="${i}"]`);
        if (rendered < INITIAL_RENDER_MESSAGE_LIMIT || isMessageNearViewport(mesEl)) {
            await renderPreviewsForMessage(i);
            rendered++;
        } else {
            observeMessageForDrawPreviewLazyRender(i);
        }
    }
}

function clearPendingDrawPreviewTimers() {
    for (const timer of drawPreviewPendingTimers) {
        clearTimeout(timer);
    }
    drawPreviewPendingTimers.clear();
}

function scheduleRenderAllDrawPreviews(delay = 150) {
    const generation = drawPreviewRuntimeGeneration;
    const timer = setTimeout(() => {
        drawPreviewPendingTimers.delete(timer);
        if (!drawPreviewRuntimeEvents || generation !== drawPreviewRuntimeGeneration) return;
        cleanupDrawPreviewMessageObserver();
        void renderAllDrawPreviews();
    }, delay);
    drawPreviewPendingTimers.add(timer);
}

function handleDrawPreviewMessageRendered(data) {
    const messageId = typeof data === 'number' ? data : data?.messageId ?? data?.mesId;
    if (messageId !== undefined) void renderPreviewsForMessage(messageId);
}

function handleDrawPreviewMessageModified(data) {
    const raw = typeof data === 'object' ? (data?.messageId ?? data?.mesId) : data;
    const messageId = parseInt(raw, 10);
    if (Number.isNaN(messageId)) return;
    // 在事件派发当下判断来源；延迟回调执行时自发标记早已清掉。
    const allowRebuild = !isSelfEmittedMessageUpdate(messageId);
    setTimeout(() => {
        void renderPreviewsForMessage(messageId, { allowRebuild });
    }, 100);
}

function handleGalleryCacheChanged({ slotIds } = {}) {
    const changedSlots = slotIds === null ? null : new Set(Array.isArray(slotIds) ? slotIds : []);
    if (changedSlots && changedSlots.size === 0) return;
    const chat = getContext().chat || [];
    for (let messageId = 0; messageId < chat.length; messageId++) {
        const messageSlots = extractSlotIds(chat[messageId]?.mes);
        const refreshSlotIds = changedSlots
            ? [...messageSlots].filter(slotId => changedSlots.has(slotId))
            : [...messageSlots];
        if (refreshSlotIds.length > 0) {
            void renderPreviewsForMessage(messageId, { refreshSlotIds });
        }
    }
}

export function startSharedDrawPreviewRuntime() {
    drawPreviewRuntimeRefs++;
    ensureChatImageStyles();
    if (drawPreviewRuntimeEvents) return;

    drawPreviewRuntimeGeneration++;
    drawPreviewRuntimeEvents = createModuleEvents('drawPreviewRuntime');
    drawPreviewRuntimeEvents.on(event_types.CHARACTER_MESSAGE_RENDERED, handleDrawPreviewMessageRendered);
    drawPreviewRuntimeEvents.on(event_types.USER_MESSAGE_RENDERED, handleDrawPreviewMessageRendered);
    drawPreviewRuntimeEvents.on(event_types.CHAT_CHANGED, () => scheduleRenderAllDrawPreviews(150));
    drawPreviewRuntimeEvents.on(event_types.MORE_MESSAGES_LOADED, () => scheduleRenderAllDrawPreviews(150));
    drawPreviewRuntimeEvents.on(event_types.MESSAGE_EDITED, handleDrawPreviewMessageModified);
    drawPreviewRuntimeEvents.on(event_types.MESSAGE_UPDATED, handleDrawPreviewMessageModified);
    drawPreviewRuntimeEvents.on(event_types.MESSAGE_SWIPED, handleDrawPreviewMessageModified);
    drawPreviewCacheSyncCleanup = subscribeGalleryCacheChanges(handleGalleryCacheChanged);

    setTimeout(() => {
        if (!drawPreviewRuntimeEvents) return;
        void renderAllDrawPreviews();
    }, 300);
}

export function stopSharedDrawPreviewRuntime() {
    drawPreviewRuntimeRefs = Math.max(0, drawPreviewRuntimeRefs - 1);
    if (drawPreviewRuntimeRefs > 0) return;

    drawPreviewRuntimeEvents?.cleanup();
    drawPreviewRuntimeEvents = null;
    drawPreviewCacheSyncCleanup?.();
    drawPreviewCacheSyncCleanup = null;
    drawPreviewRuntimeGeneration++;
    clearPendingDrawPreviewTimers();
    cleanupDrawPreviewMessageObserver();
}
