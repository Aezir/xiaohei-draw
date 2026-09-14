import { hashStableValue } from './generation-fingerprint.js';
import { stripDrawImageSlots } from './image-marker-syntax.js';

const IMAGE_MARKER_REGEX = /\[(?:image|ebook-image|tavern-image)\s*:\s*[a-z0-9_-]+\]/gi;
const SCENE_POINT_MARKER_REGEX = /【插图点\s+\d+】/g;
const USER_SCENE_POINT_MARKER_REGEX = /【插图点\s+(\d+)】/g;
const SENTENCE_END_REGEX = /[。！？!?…]/;
const SENTENCE_CLOSER_REGEX = /[”’」』】）》〉〕\]})"'*_~～]/;
const ATTRIBUTION_CLOSER_REGEX = /[”’」』】）》〉〕\]})"']/;
const COMMON_PERIOD_ABBREVIATIONS = new Set([
    'mr', 'mrs', 'ms', 'dr', 'prof', 'sr', 'jr', 'st', 'vs', 'etc', 'no', 'fig',
    'inc', 'ltd', 'co', 'corp', 'jan', 'feb', 'mar', 'apr', 'jun', 'jul', 'aug',
    'sep', 'sept', 'oct', 'nov', 'dec', 'e.g', 'i.e',
]);

function escapeRegex(value) {
    return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function createMappedText(sourceText) {
    return Array.from({ length: sourceText.length }, (_value, offset) => ({
        char: sourceText[offset],
        offset,
    }));
}

function getMappedText(mapped) {
    return mapped.map((item) => item.char).join('');
}

function removeMappedMatches(mapped, regex) {
    const text = getMappedText(mapped);
    const ranges = [];
    for (const match of text.matchAll(regex)) {
        if (!match[0]) continue;
        ranges.push([match.index, match.index + match[0].length]);
    }
    if (!ranges.length) return mapped;

    const kept = [];
    let rangeIndex = 0;
    for (let index = 0; index < mapped.length; index += 1) {
        while (rangeIndex < ranges.length && index >= ranges[rangeIndex][1]) rangeIndex += 1;
        const range = ranges[rangeIndex];
        if (!range || index < range[0] || index >= range[1]) kept.push(mapped[index]);
    }
    return kept;
}

function applyMappedFilterRules(mapped, rules = []) {
    let result = mapped;
    for (const rule of Array.isArray(rules) ? rules : []) {
        const start = String(rule?.start || '').trim();
        const end = String(rule?.end || '').trim();
        if (!start && !end) continue;
        if (start && end && start.toLocaleLowerCase() === end.toLocaleLowerCase()) {
            // 起止相同 = 单个记号（如 <StatusPlaceHolderImpl/>），删掉每一处，不截断前后正文。
            result = removeMappedMatches(result, new RegExp(escapeRegex(start), 'gi'));
            continue;
        }
        if (start && end) {
            result = removeMappedMatches(
                result,
                new RegExp(`${escapeRegex(start)}[\\s\\S]*?${escapeRegex(end)}`, 'gi'),
            );
            continue;
        }

        const text = getMappedText(result);
        if (start) {
            const index = text.toLocaleLowerCase().indexOf(start.toLocaleLowerCase());
            if (index >= 0) result = result.slice(0, index);
        } else {
            const index = text.toLocaleLowerCase().indexOf(end.toLocaleLowerCase());
            if (index >= 0) result = result.slice(index + end.length);
        }
    }
    return result;
}

function trimMappedText(mapped) {
    const text = getMappedText(mapped);
    if (!text) return [];
    const start = text.length - text.trimStart().length;
    const end = text.trimEnd().length;
    return mapped.slice(start, end);
}

function isAsciiLetterOrDigit(char = '') {
    return /[A-Za-z0-9]/.test(char);
}

function isSentencePeriod(mapped, index) {
    if (mapped[index]?.char !== '.') return false;
    const previous = mapped[index - 1]?.char || '';
    const next = mapped[index + 1]?.char || '';
    if (isAsciiLetterOrDigit(previous) && isAsciiLetterOrDigit(next)) return false;

    let token = '';
    for (let cursor = index - 1; cursor >= 0 && token.length < 24; cursor -= 1) {
        const char = mapped[cursor]?.char || '';
        if (/\s/.test(char)) break;
        token = char + token;
    }
    const normalizedWord = token.replace(/^[^A-Za-z]+|[^A-Za-z.]+$/g, '').toLowerCase();
    if (COMMON_PERIOD_ABBREVIATIONS.has(normalizedWord) || /^[A-Za-z]$/.test(normalizedWord)) return false;
    return true;
}

function isSentenceEnd(mapped, index) {
    const char = mapped[index]?.char || '';
    return char === '.' ? isSentencePeriod(mapped, index) : SENTENCE_END_REGEX.test(char);
}

function hasSameLineQuoteContinuation(mapped, closerEnd) {
    let cursor = closerEnd;
    while (cursor < mapped.length && /[ \t\u00a0]/.test(mapped[cursor].char)) cursor += 1;
    if (cursor >= mapped.length || /[\r\n]/.test(mapped[cursor].char)) return false;

    // A new quoted or Markdown-emphasized span is a separate narrative beat,
    // not an attribution such as `”她问。` that belongs to the quotation.
    return !/[*_~“‘「『《〈（(【[]/.test(mapped[cursor].char);
}

function skipHorizontalWhitespace(mapped, start) {
    let cursor = start;
    while (cursor < mapped.length && /[ \t\u00a0]/.test(mapped[cursor].char)) cursor += 1;
    return cursor;
}

// 整行只有 <story>、</story> 这类标签时不算正文内容：否则开头标签后、结尾标签后都会冒出插图点，
// 图片会插到第一句之前或包裹标签之外。
const MARKUP_TAG_REGEX = /^<\/?[A-Za-z][\w:.-]*(?:\s[^<>\r\n]*)?\/?>/;

function matchMarkupTagLength(mapped, index) {
    if (mapped[index]?.char !== '<') return 0;
    let head = '';
    for (let cursor = index; cursor < mapped.length && head.length < 200; cursor += 1) {
        head += mapped[cursor].char;
        if (mapped[cursor].char === '>') break;
    }
    return head.match(MARKUP_TAG_REGEX)?.[0].length || 0;
}

function collectScenePoints(mapped) {
    const points = [];
    let hasContent = false;
    const addPoint = (contentOffset) => {
        const previous = mapped[contentOffset - 1];
        if (!previous || points.at(-1)?.contentOffset === contentOffset) return;
        points.push({
            number: points.length + 1,
            contentOffset,
            offset: previous.offset + 1,
        });
        hasContent = false;
    };

    for (let index = 0; index < mapped.length; index += 1) {
        const char = mapped[index].char;
        if (char === '\r' || char === '\n') {
            let end = index + 1;
            while (end < mapped.length && (mapped[end].char === '\r' || mapped[end].char === '\n')) end += 1;
            if (hasContent) addPoint(end);
            index = end - 1;
            continue;
        }
        if (isSentenceEnd(mapped, index)) {
            let end = index + 1;
            while (end < mapped.length && isSentenceEnd(mapped, end)) end += 1;
            const punctuationEnd = end;
            let hasAttributionCloser = false;
            while (end < mapped.length && SENTENCE_CLOSER_REGEX.test(mapped[end].char)) {
                if (ATTRIBUTION_CLOSER_REGEX.test(mapped[end].char)) hasAttributionCloser = true;
                end += 1;
            }
            const pointEnd = skipHorizontalWhitespace(mapped, end);
            const closedQuotedSentence = end > punctuationEnd && hasAttributionCloser;
            if (hasContent && !(closedQuotedSentence && hasSameLineQuoteContinuation(mapped, end))) {
                addPoint(pointEnd);
            }
            index = (closedQuotedSentence ? end : pointEnd) - 1;
            continue;
        }
        const tagLength = matchMarkupTagLength(mapped, index);
        if (tagLength > 0) {
            index += tagLength - 1;
            continue;
        }
        if (!/\s/.test(char)) hasContent = true;
    }

    if (hasContent) addPoint(mapped.length);
    return points;
}

function escapeUserScenePointMarkers(content) {
    return String(content || '').replace(
        USER_SCENE_POINT_MARKER_REGEX,
        (_match, number) => `【原文中的“插图点 ${number}”字样】`,
    );
}

function restoreUserScenePointMarkers(content) {
    return String(content || '').replace(
        /【原文中的“插图点\s+(\d+)”字样】/g,
        (_match, number) => `【插图点 ${number}】`,
    );
}

function buildNumberedContent(content, points) {
    let cursor = 0;
    let result = '';
    for (const point of points) {
        result += escapeUserScenePointMarkers(content.slice(cursor, point.contentOffset));
        result += `【插图点 ${point.number}】`;
        cursor = point.contentOffset;
    }
    return result + escapeUserScenePointMarkers(content.slice(cursor));
}

// ── MVU 这类「变量卡」会在正文尾部增删的临时标记 ──
// <StatusPlaceHolderImpl/>（状态栏占位）、<UpdateVariable>…</UpdateVariable>（变量更新指令，未闭合时到结尾）、
// <status_current_variable>…</status_current_variable>。它们变化不代表剧情正文变了。
const TRANSIENT_MARKUP_SOURCE = String.raw`<StatusPlaceHolderImpl\s*\/?>|<(UpdateVariable|status_current_variable)\b[^>]*>[\s\S]*?(?:<\/\1\s*>|$)`;

export function createTransientMarkupRegex() {
    return new RegExp(TRANSIENT_MARKUP_SOURCE, 'gi');
}

// 把正文拆成「叙事单元」：每个非空白字符一个单元；连续空白和临时标记合并成一个空白单元。
// leadEnd = 空白单元里第一个临时标记之前的位置，映射时不会落进标记内部或跑到标记后面。
function buildNarrativeUnits(text) {
    const source = String(text ?? '');
    const blocks = [];
    for (const match of source.matchAll(createTransientMarkupRegex())) {
        if (match[0]) blocks.push([match.index, match.index + match[0].length]);
    }
    const units = [];
    const pushSpace = (start, end, isBlock) => {
        const last = units.at(-1);
        if (last?.key === ' ') {
            last.end = end;
            if (isBlock) last.hasBlock = true;
            else if (!last.hasBlock) last.leadEnd = end;
            return;
        }
        units.push({ key: ' ', start, end, leadEnd: isBlock ? start : end, hasBlock: isBlock });
    };
    let blockIndex = 0;
    let index = 0;
    while (index < source.length) {
        const block = blocks[blockIndex];
        if (block && index === block[0]) {
            pushSpace(block[0], block[1], true);
            index = block[1];
            blockIndex += 1;
            continue;
        }
        const char = source[index];
        if (/\s/.test(char)) pushSpace(index, index + 1, false);
        else units.push({ key: char, start: index, end: index + 1 });
        index += 1;
    }
    return units;
}

function innerNarrativeUnits(units) {
    let first = 0;
    let last = units.length - 1;
    while (first <= last && units[first].key === ' ') first += 1;
    while (last >= first && units[last].key === ' ') last -= 1;
    return first > last ? null : { first, last, inner: units.slice(first, last + 1) };
}

/**
 * 两份正文只差临时标记（及其前后空白、首尾空白、空白长度）时，返回 offset 映射函数；
 * 叙事内容有任何差异（改字、删句、加句）返回 null。
 */
export function createNarrativeOffsetMapper(fromText, toText) {
    const fromUnits = buildNarrativeUnits(fromText);
    const toUnits = buildNarrativeUnits(toText);
    const from = innerNarrativeUnits(fromUnits);
    const to = innerNarrativeUnits(toUnits);
    if (!from || !to || from.inner.length !== to.inner.length) return null;
    for (let index = 0; index < from.inner.length; index += 1) {
        if (from.inner[index].key !== to.inner[index].key) return null;
    }
    const fromFirst = from.inner[0];
    const fromLast = from.inner.at(-1);
    const toFirst = to.inner[0];
    const toLast = to.inner.at(-1);
    const toTail = toUnits[to.last + 1];

    return (offset) => {
        const value = Number(offset);
        if (value <= fromFirst.start) return toFirst.start;
        if (value >= fromLast.end) {
            const limit = toTail ? toTail.leadEnd : toLast.end;
            return Math.min(toLast.end + (value - fromLast.end), limit);
        }
        let low = 0;
        let high = from.inner.length - 1;
        while (low < high) {
            const middle = (low + high) >> 1;
            if (from.inner[middle].end <= value) low = middle + 1;
            else high = middle;
        }
        const source = from.inner[low];
        const target = to.inner[low];
        if (value <= source.start) return target.start;
        const sourceLead = source.hasBlock ? source.leadEnd - source.start : source.end - source.start;
        const targetLimit = target.hasBlock ? target.leadEnd : target.end;
        return Math.min(target.start + Math.min(value - source.start, sourceLead), targetLimit);
    };
}

// 正文尾部若是「空白 + 临时标记」，真正的叙事结尾在第一个临时标记之前。
export function findNarrativeTailOffset(sourceText) {
    const source = String(sourceText ?? '');
    const units = buildNarrativeUnits(source);
    const last = units.at(-1);
    if (units.length > 1 && last?.key === ' ' && last.hasBlock) return last.leadEnd;
    return source.length;
}

export function hashSceneSource(sourceText) {
    return hashStableValue(String(sourceText ?? ''), 'scene-source');
}

export function normalizeMessageSceneSourceText(sourceText) {
    return stripDrawImageSlots(sourceText);
}

export function stripScenePointMarkers(text) {
    return restoreUserScenePointMarkers(String(text || '').replace(SCENE_POINT_MARKER_REGEX, ''));
}

export function createSceneSource(sourceText, options = {}) {
    const original = String(sourceText ?? '');
    let mapped = createMappedText(original);
    mapped = removeMappedMatches(mapped, new RegExp(IMAGE_MARKER_REGEX.source, 'gi'));
    mapped = applyMappedFilterRules(mapped, options.filterRules);
    mapped = trimMappedText(mapped);

    const content = getMappedText(mapped);
    const internalPoints = collectScenePoints(mapped);
    return {
        sourceText: original,
        sourceHash: hashSceneSource(original),
        content,
        numberedContent: buildNumberedContent(content, internalPoints),
        points: internalPoints.map(({ number, offset }) => ({ number, offset })),
    };
}
