import { createNarrativeOffsetMapper, findNarrativeTailOffset, hashSceneSource } from './scene-source.js';
import { createDrawImageSlotRegex } from './image-marker-syntax.js';

export class ScenePlacementError extends Error {
    constructor(message, code = 'SCENE_PLACEMENT_INVALID') {
        super(message);
        this.name = 'ScenePlacementError';
        this.code = code;
    }
}

/** 去掉全部空白的正文 + 每个字对应回原文的下标（按上下文找位置、算改动位置都用它） */
function compactNarrative(text) {
    const chars = [];
    const map = [];
    const source = String(text ?? '');
    for (let index = 0; index < source.length; index += 1) {
        const char = source[index];
        if (/\s/.test(char)) continue;
        chars.push(char);
        map.push(index);
    }
    return { compact: chars.join(''), map };
}

const ANCHOR_LENGTHS = [24, 16, 10, 6];

/**
 * 叙事真的改了（别的脚本 / 插件在规划期间改写了这楼）时的近似定位：
 * 先拿插图点前面那一小段字（去空白后 24 → 6 个字逐级缩短）去新正文里找，找到就插在它后面；
 * 前面那段被改了就换插图点后面那段找，找到就插在它前面；两头都找不到才放到叙事末尾。
 * 位置单调不回头，多张图不会乱序。
 */
function rebaseApproximately(list, from, to, toHash) {
    const fromC = compactNarrative(from);
    const toC = compactNarrative(to);
    const tail = findNarrativeTailOffset(to);
    let lastCompact = 0;
    const relocated = { anchor: 0, tail: 0 };
    const placements = list.map((placement) => {
        if (placement?.mode !== 'source') return placement;
        const offset = Number(placement.offset) || 0;
        let before = 0;
        while (before < fromC.map.length && fromC.map[before] < offset) before += 1;
        if (before === 0) { relocated.anchor += 1; return { ...placement, offset: 0, sourceHash: toHash }; }
        const locate = (anchor) => {
            const found = toC.compact.indexOf(anchor, lastCompact);
            return found >= 0 ? found : toC.compact.indexOf(anchor);
        };
        for (const length of ANCHOR_LENGTHS) {
            const anchor = fromC.compact.slice(Math.max(0, before - length), before);
            if (anchor.length < Math.min(length, 4)) continue;
            const found = locate(anchor);
            if (found < 0) continue;
            const endCompact = found + anchor.length;
            lastCompact = Math.max(lastCompact, endCompact);
            relocated.anchor += 1;
            return { ...placement, offset: toC.map[endCompact - 1] + 1, sourceHash: toHash };
        }
        for (const length of ANCHOR_LENGTHS) {
            const anchor = fromC.compact.slice(before, before + length);
            if (anchor.length < Math.min(length, 4)) continue;
            const found = locate(anchor);
            if (found < 0) continue;
            lastCompact = Math.max(lastCompact, found);
            relocated.anchor += 1;
            return { ...placement, offset: toC.map[found], sourceHash: toHash };
        }
        relocated.tail += 1;
        return { ...placement, mode: 'tail', offset: tail, sourceHash: toHash };
    });
    return { rebased: true, approximate: true, relocated, placements };
}

/**
 * 两份正文（去空白后）哪里不一样：从第几个字起、删了什么、加了什么。给日志 / 提示用，不参与定位。
 */
export function describeNarrativeChange(fromText, toText, { snippet = 40 } = {}) {
    const from = compactNarrative(fromText).compact;
    const to = compactNarrative(toText).compact;
    if (from === to) return null;
    let prefix = 0;
    while (prefix < from.length && prefix < to.length && from[prefix] === to[prefix]) prefix += 1;
    let suffix = 0;
    while (suffix < from.length - prefix && suffix < to.length - prefix
        && from[from.length - 1 - suffix] === to[to.length - 1 - suffix]) suffix += 1;
    const clip = (text) => (text.length > snippet ? `${text.slice(0, snippet)}…（共 ${text.length} 字）` : text);
    return {
        fromLength: from.length,
        toLength: to.length,
        changedAt: prefix,
        removed: clip(from.slice(prefix, from.length - suffix)),
        added: clip(to.slice(prefix, to.length - suffix)),
    };
}

export function formatNarrativeChange(change) {
    if (!change) return '';
    const parts = [];
    if (change.removed) parts.push(`删了「${change.removed}」`);
    if (change.added) parts.push(`加了「${change.added}」`);
    return `第 ${change.changedAt + 1} 个字起${parts.length ? parts.join('、') : '有改动'}（去空白后 ${change.fromLength} → ${change.toLength} 字）`;
}

/**
 * 把按 fromText 规划的 placements 挪到 toText 上。两份文本都是去掉图片槽位后的正文。
 * - 文本相同：原样返回；
 * - 只差 MVU 临时标记（<StatusPlaceHolderImpl/>、<UpdateVariable> 块、尾部空白）：offset 映射到新正文的同一叙事位置；
 * - 叙事内容变了：默认按上下文近似定位（approximate: true，relocated 记按锚点 / 放末尾各几张）；
 *   allowApproximate: false 时和以前一样抛 SCENE_SOURCE_CHANGED 拒绝写入。
 */
export function rebaseScenePlacements(placements, fromText, toText, { allowApproximate = true } = {}) {
    const from = String(fromText ?? '');
    const to = String(toText ?? '');
    const list = Array.isArray(placements) ? placements : [];
    const fromHash = hashSceneSource(from);
    const assertOwned = (placement) => {
        if (placement?.mode === 'source' && placement.sourceHash !== fromHash) {
            throw new ScenePlacementError('图片任务不属于当前正文。', 'SCENE_SOURCE_CHANGED');
        }
    };
    if (from === to) {
        list.forEach(assertOwned);
        return { placements: list.slice(), rebased: false };
    }
    list.forEach(assertOwned);
    const toHash = hashSceneSource(to);
    const mapOffset = createNarrativeOffsetMapper(from, to);
    if (!mapOffset) {
        if (!allowApproximate) {
            throw new ScenePlacementError('正文已在场景规划后发生变化，已拒绝写入图片占位符。', 'SCENE_SOURCE_CHANGED');
        }
        return rebaseApproximately(list, from, to, toHash);
    }
    return {
        rebased: true,
        placements: list.map((placement) => {
            if (placement?.mode !== 'source') return placement;
            return { ...placement, offset: mapOffset(placement.offset), sourceHash: toHash };
        }),
    };
}

export function assertSceneSourceUnchanged(sourceText, expectedHash) {
    const actualHash = hashSceneSource(sourceText);
    if (!expectedHash || actualHash !== expectedHash) {
        throw new ScenePlacementError('正文已在场景规划后发生变化，已拒绝写入图片占位符。', 'SCENE_SOURCE_CHANGED');
    }
    return actualHash;
}

function resolvePlacementOffset(sourceText, placement, sourceHash) {
    // 尾插放在 MVU 状态栏占位符等尾部临时标记之前，图片不会跑到状态栏下面。
    if (placement?.mode === 'tail') return findNarrativeTailOffset(sourceText);
    if (placement?.mode !== 'source') {
        throw new ScenePlacementError('图片任务缺少有效 placement。');
    }
    if (placement.sourceHash !== sourceHash) {
        throw new ScenePlacementError('图片任务不属于当前正文。', 'SCENE_SOURCE_CHANGED');
    }
    const offset = Number(placement.offset);
    if (!Number.isInteger(offset) || offset < 0 || offset > sourceText.length) {
        throw new ScenePlacementError('图片任务包含无效正文 offset。');
    }
    return offset;
}

function wrapBlockContent(source, offset, content) {
    let wrapped = content;
    if (offset > 0 && source[offset - 1] !== '\n') wrapped = `\n${wrapped}`;
    if (offset < source.length && source[offset] !== '\n') wrapped = `${wrapped}\n`;
    return wrapped;
}

function escapeRegex(value) {
    return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function getSceneSlotIds(sourceText) {
    const ids = [];
    const regex = createDrawImageSlotRegex();
    let match;
    while ((match = regex.exec(String(sourceText ?? ''))) !== null) ids.push(match[1]);
    return [...new Set(ids)];
}

export function setActiveMessageText(message, text) {
    const value = String(text ?? '');
    if (!message || typeof message !== 'object') return value;
    message.mes = value;
    const swipe = Number(message.swipe_id);
    if (Array.isArray(message.swipes) && Number.isInteger(swipe) && swipe >= 0 && swipe < message.swipes.length) {
        message.swipes[swipe] = value;
    }
    return value;
}

// 只认 image-marker-syntax 定义的规范 slotId；非规范 id 从来不是合法槽位。
// 交付前必须逐槽位确认它还在正文里。用户删掉的槽位是他对这张图的最终意见，
// 交付流程重建它就是在跟用户对抗——刷新后的接回流程尤其容易犯这个错，
// 因为它手里的恢复记录是提交那一刻的事实，不知道用户后来删过什么。
export function isSceneSlotAlive(currentText, slotId) {
    const id = String(slotId || '').trim();
    if (!id) return false;
    const regex = createDrawImageSlotRegex();
    let match;
    while ((match = regex.exec(String(currentText ?? ''))) !== null) {
        if (match[1].toLowerCase() === id.toLowerCase()) return true;
    }
    return false;
}

export function removeSceneSlotPlaceholders(sourceText, slotIds = [], markerName = 'image') {
    const ids = new Set((Array.isArray(slotIds) ? slotIds : [])
        .map((slotId) => String(slotId || '').trim())
        .filter(Boolean));
    if (!ids.size) return String(sourceText ?? '');
    const marker = escapeRegex(markerName);
    const idPattern = [...ids].map(escapeRegex).join('|');
    const regex = new RegExp(`(\\n?)\\[${marker}\\s*:\\s*(?:${idPattern})\\](\\n?)`, 'gi');
    return String(sourceText ?? '').replace(
        regex,
        (_match, before, after) => (before && after ? '\n' : ''),
    );
}

// 后台任务提交前唯一允许写入占位符的入口。CAS 本身保持同步；保存失败时只移除本批槽位，
// 因而不会覆盖保存等待期间发生的用户编辑或其它任务写入。
export async function commitRecoverableScenePlacements({
    getCurrentChatId,
    getCurrentMessage,
    expectedChatId,
    messageId,
    message,
    originalText,
    plannedText,
    slotIds,
    isEditing = () => false,
    persist,
    syncAfterRollback,
} = {}) {
    if (getCurrentChatId?.() !== expectedChatId) return false;
    if (getCurrentMessage?.(messageId) !== message) return false;
    if (isEditing(messageId)) return false;
    if (message?.mes !== originalText) return false;

    setActiveMessageText(message, plannedText);
    try {
        await persist?.();
        return true;
    } catch (error) {
        setActiveMessageText(message, removeSceneSlotPlaceholders(message.mes, slotIds));
        try {
            await syncAfterRollback?.(message.mes);
        } catch (syncError) {
            console.warn('[ScenePlacement] 占位符保存失败后的界面同步未完成:', syncError);
        }
        throw error;
    }
}

export async function commitSceneSlotReplacement({
    message,
    stagedText,
    replacedSlotIds = [],
    persist,
} = {}) {
    setActiveMessageText(message, stagedText);
    await persist?.();

    const replacementText = removeSceneSlotPlaceholders(message?.mes, replacedSlotIds);
    if (replacementText === message?.mes) return replacementText;
    setActiveMessageText(message, replacementText);
    try {
        await persist?.();
        return replacementText;
    } catch (error) {
        // 第二次保存结果未知。内存退回“旧图 + 新图”这一安全超集，绝不因响应丢失而抹掉旧图。
        if (message?.mes === replacementText) setActiveMessageText(message, stagedText);
        throw error;
    }
}

// 三家 provider 共用的槽位交付顺序。后台链路在每个持久化步骤前都通过 guard 续租；
// 用户在任一步期间删除槽位时，只回滚本次刚写入的事实，不重建槽位。
export async function commitSceneSlotDelivery({
    committedEarly,
    resolveTarget,
    guard = async () => {},
    persist,
    rollbackPersisted,
    select,
    rollbackSelection,
} = {}) {
    const getTarget = () => committedEarly ? resolveTarget?.() : null;
    await guard();
    let target = getTarget();
    if (committedEarly && !target) return false;
    await persist(target);
    await guard();
    target = getTarget();
    if (committedEarly && !target) {
        await rollbackPersisted?.();
        return false;
    }
    if (typeof select !== 'function') return true;

    await select();
    await guard();
    target = getTarget();
    if (committedEarly && !target) {
        await rollbackSelection?.();
        await guard();
        await rollbackPersisted?.();
        return false;
    }
    return true;
}

// 本地链路的排版提交：占位符不提前落盘，而是在生成结束时一次性写入正文，
// 所以这里的基准必然是规划文本，只把「什么结果都没有」的槽位剔掉。
//
// 刻意不接受原始正文快照：旧实现在「一张都没成功」时整段回写 originalText，会连带抹掉
// 用户在生成期间做的任何编辑。真正需要表达的只是「没有结果的槽位不要写进去」，
// 一张都没成功时把全部槽位剔掉自然就得到接近原文的结果，不需要回滚这个动作。
//
// 这不是结算。后台链路的占位符在提交前就已经持久化，它的结算发生在当前活着的正文上，
// 用的是 removeSceneSlotPlaceholders，基准绝不能是任何快照。
export function commitSettledScenePlacements(plannedText, { allSlotIds = [], settledSlotIds = [] } = {}) {
    const settled = new Set((Array.isArray(settledSlotIds) ? settledSlotIds : [])
        .map((slotId) => String(slotId || '').trim())
        .filter(Boolean));
    const unsettled = (Array.isArray(allSlotIds) ? allSlotIds : [])
        .filter((slotId) => !settled.has(String(slotId || '').trim()));
    return removeSceneSlotPlaceholders(plannedText, unsettled);
}

export function insertScenePlacements(sourceText, insertions = [], options = {}) {
    const source = String(sourceText ?? '');
    const sourceHash = hashSceneSource(source);
    const ordered = (Array.isArray(insertions) ? insertions : []).map((insertion, order) => {
        const offset = resolvePlacementOffset(source, insertion?.placement, sourceHash);
        const content = String(insertion?.content ?? '');
        return {
            content: options.block ? wrapBlockContent(source, offset, content) : content,
            offset,
            order,
        };
    }).sort((left, right) => right.offset - left.offset || right.order - left.order);

    let result = source;
    for (const insertion of ordered) {
        result = `${result.slice(0, insertion.offset)}${insertion.content}${result.slice(insertion.offset)}`;
    }
    return result;
}

// 新一批占位符先与旧图片槽位共存。旧槽位只有在整批结果完成并成功保存后才会删除，
// 因而保存响应丢失或生成中断都不会先把用户原有图片从持久正文中抹掉。
export function insertScenePlacementsPreservingSlots(sourceText, insertions = [], options = {}) {
    const source = String(sourceText ?? '');
    const markerRanges = [];
    const regex = createDrawImageSlotRegex();
    let match;
    while ((match = regex.exec(source)) !== null) {
        markerRanges.push({ start: match.index, end: match.index + match[0].length });
    }
    if (markerRanges.length === 0) return insertScenePlacements(source, insertions, options);

    const cleanSource = source.replace(createDrawImageSlotRegex(), '');
    const sourceHash = hashSceneSource(cleanSource);
    const mapOffset = (cleanOffset) => {
        let removedLength = 0;
        for (const range of markerRanges) {
            const cleanRangeStart = range.start - removedLength;
            if (cleanOffset <= cleanRangeStart) return cleanOffset + removedLength;
            removedLength += range.end - range.start;
        }
        return cleanOffset + removedLength;
    };
    const ordered = (Array.isArray(insertions) ? insertions : []).map((insertion, order) => {
        const cleanOffset = resolvePlacementOffset(cleanSource, insertion?.placement, sourceHash);
        const content = String(insertion?.content ?? '');
        return {
            content: options.block ? wrapBlockContent(cleanSource, cleanOffset, content) : content,
            offset: mapOffset(cleanOffset),
            order,
        };
    }).sort((left, right) => right.offset - left.offset || right.order - left.order);

    let result = source;
    for (const insertion of ordered) {
        result = `${result.slice(0, insertion.offset)}${insertion.content}${result.slice(insertion.offset)}`;
    }
    return result;
}
