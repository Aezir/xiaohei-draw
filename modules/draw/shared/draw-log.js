// 生图日志：纯函数（打码、裁剪、折叠诊断、渲染报告、拼复制文本）。不碰 DOM / 酒馆，node 可直接测。
// 存储见 draw-log-store.js，界面见 providers/novelai/ui/draw-log-view.js。

export const DRAW_LOG_MAX_ENTRIES = 50;
export const DRAW_LOG_MAX_TEXT = 200000;
const MAX_RENDERS_PER_ENTRY = 40;
const MAX_DEPTH = 12;
const REDACTED = '[已打码]';

const SECRET_KEY_REGEX = /^(?:authorization|proxy[-_]?authorization|cookie|set[-_]?cookie|(?:x[-_])?csrf(?:[-_]?token)?|token|tok|access[-_]?token|refresh[-_]?token|id[-_]?token|session[-_]?token|api[-_]?key|apikey|key|secret|client[-_]?secret|x[-_](?:goog[-_])?api[-_]?key|x[-_]api[-_]?key|proxy[-_]?password|password|passwd|pwd)$/i;

const SECRET_TEXT_PATTERNS = [
    // Authorization: Bearer xxx / Basic xxx
    [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{6,}/g, `$1 ${REDACTED}`],
    // NovelAI 持久令牌、OpenAI / Anthropic / OpenRouter 等 sk- 开头的 key
    [/\bpst-[A-Za-z0-9_-]{6,}/g, `pst-${REDACTED}`],
    [/\bsk-[A-Za-z0-9_-]{6,}/g, `sk-${REDACTED}`],
    [/\bAIza[0-9A-Za-z_-]{20,}/g, REDACTED],
    [/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/g, REDACTED],
    [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, REDACTED],
    [/\bxox[abposr]-[A-Za-z0-9-]{10,}/g, REDACTED],
    // JWT
    [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, REDACTED],
    // URL / 文本里的 key=xxx、"api_key": "xxx"
    [/([?&](?:key|api[-_]?key|token|access[-_]?token|password|secret)=)[^&\s"'#]+/gi, `$1${REDACTED}`],
    [/("(?:api[-_]?key|apiKey|token|password|secret|authorization|proxy_password)"\s*:\s*")[^"]*(")/gi, `$1${REDACTED}$2`],
];

const DATA_URL_REGEX = /data:[a-z]+\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=]+/gi;
const LONG_BASE64_REGEX = /^[A-Za-z0-9+/=]{800,}$/;

function describeBytes(chars) {
    const kb = Math.max(1, Math.round((chars * 3) / 4 / 1024));
    return `约 ${kb} KB`;
}

/** 文本打码：key / 令牌 / Bearer 头，外加图片 base64 省略、超长截断。 */
export function redactText(value, { maxLength = DRAW_LOG_MAX_TEXT } = {}) {
    let text = String(value ?? '');
    if (text.length >= 800 && LONG_BASE64_REGEX.test(text.replace(/[\r\n]/g, ''))) {
        return `[二进制/图片数据已省略，${describeBytes(text.length)}]`;
    }
    text = text.replace(DATA_URL_REGEX, match => `[图片数据已省略，${describeBytes(match.length)}]`);
    for (const [pattern, replacement] of SECRET_TEXT_PATTERNS) {
        text = text.replace(pattern, replacement);
    }
    if (text.length > maxLength) {
        text = `${text.slice(0, maxLength)}\n…[太长，后面 ${text.length - maxLength} 字没存]`;
    }
    return text;
}

/** 深拷贝 + 打码。按字段名打码，字符串再走一遍正则兜底。 */
export function redactSecrets(value, options = {}, depth = 0) {
    if (value === null || value === undefined) return value;
    if (typeof value === 'string') return redactText(value, options);
    if (typeof value === 'number' || typeof value === 'boolean') return value;
    if (typeof value === 'bigint') return String(value);
    if (typeof value !== 'object') return undefined;
    if (depth >= MAX_DEPTH) return '[层级太深，已省略]';
    if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) {
        return `[二进制数据已省略，${value.byteLength} 字节]`;
    }
    if (Array.isArray(value)) return value.map(item => redactSecrets(item, options, depth + 1));
    const out = {};
    for (const [key, entry] of Object.entries(value)) {
        if (typeof entry === 'function') continue;
        if (SECRET_KEY_REGEX.test(key) && entry !== null && entry !== undefined && entry !== '') {
            out[key] = REDACTED;
            continue;
        }
        out[key] = redactSecrets(entry, options, depth + 1);
    }
    return out;
}

function toNumberOrNull(value) {
    const number = Number(value);
    return value === null || value === undefined || value === '' || !Number.isFinite(number) ? null : number;
}

// ─── 场景 Agent ────────────────────────────────────────────────────────────

function extractRequestMessages(inspection) {
    const body = inspection?.request?.body ?? inspection?.body ?? null;
    if (!body || typeof body !== 'object') return { messages: null, body: body ?? null };
    const rest = { ...body };
    let messages = null;
    for (const key of ['messages', 'contents', 'input']) {
        if (Array.isArray(body[key])) {
            messages = body[key];
            delete rest[key];
            break;
        }
    }
    const system = body.system ?? body.systemInstruction ?? body.instructions;
    if (system !== undefined && messages) {
        messages = [{ role: 'system', content: system }, ...messages];
        delete rest.system;
        delete rest.systemInstruction;
        delete rest.instructions;
    }
    return { messages, body: rest };
}

function pickValidation(failure) {
    if (!failure) return null;
    return {
        code: String(failure.errorCode || ''),
        path: String(failure.errorPath || ''),
        rule: String(failure.errorRule || ''),
        message: String(failure.errorMessage || ''),
    };
}

/**
 * 把一次场景规划的诊断快照（beginDrawScenePlannerDiagnostic 的 publish 结果）折进日志。
 * 每一轮：请求（messages + 其余请求体）、模型原始回复、没过校验的原因、耗时。
 * 快照里的 request 永远是「最近一轮」的实际请求，所以按 attempts 长度落到对应轮次，旧轮次保留。
 */
export function foldAgentDiagnostic(previous, snapshot) {
    const agent = previous && typeof previous === 'object'
        ? { ...previous, rounds: Array.isArray(previous.rounds) ? previous.rounds.map(round => ({ ...round })) : [] }
        : { rounds: [] };
    if (!snapshot || typeof snapshot !== 'object') return agent;
    agent.status = String(snapshot.status || agent.status || '');
    agent.stage = String(snapshot.stage || '');
    agent.provider = String(snapshot.provider || agent.provider || '');
    agent.model = String(snapshot.model || agent.model || '');
    agent.presetName = String(snapshot.presetName || agent.presetName || '');
    agent.toolMode = String(snapshot.toolMode || agent.toolMode || '');
    agent.durationMs = toNumberOrNull(snapshot.durationMs) ?? agent.durationMs ?? null;
    agent.terminationReason = String(snapshot.terminationReason || '');
    agent.errorCode = String(snapshot.errorCode || '');
    agent.errorMessage = redactText(snapshot.errorMessage || '');

    const attempts = Array.isArray(snapshot.attempts) ? snapshot.attempts : [];
    const failures = Array.isArray(snapshot.validationFailures) ? snapshot.validationFailures : [];
    attempts.forEach((attempt, index) => {
        const round = agent.rounds[index] || { index: index + 1 };
        round.index = Number(attempt?.attempt) || index + 1;
        round.phase = round.index === 1 ? 'analysis' : 'correction';
        round.startedAt = toNumberOrNull(attempt?.startedAt);
        round.durationMs = toNumberOrNull(attempt?.durationMs);
        round.finishReason = String(attempt?.finishReason || '');
        if (attempt?.errorCode) round.errorCode = String(attempt.errorCode);
        const failure = failures.find(item => Number(item?.attempt) === round.index);
        if (failure) {
            round.validation = redactSecrets(pickValidation(failure));
            if (failure.modelOutput) round.modelOutput = redactText(failure.modelOutput);
        }
        if (!round.modelOutput && attempt?.modelOutput) round.modelOutput = redactText(attempt.modelOutput);
        agent.rounds[index] = round;
    });
    if (snapshot.request && attempts.length > 0) {
        const round = agent.rounds[attempts.length - 1];
        const { messages, body } = extractRequestMessages(snapshot.request);
        round.request = redactSecrets({
            url: snapshot.request?.request?.url || '',
            transport: snapshot.request?.transport || '',
            messages,
            body,
        });
    }
    if (snapshot.status === 'error' && agent.rounds.length > 0 && !attempts.some(item => item?.errorCode)) {
        const last = agent.rounds[agent.rounds.length - 1];
        if (!last.validation && agent.errorCode) last.errorCode ||= agent.errorCode;
    }
    return agent;
}

/** messages 数组 → 纯文本（[role] + 内容）。内容是数组（多模态 / parts）时拼文字，其余转 JSON。 */
export function formatMessagesText(messages) {
    if (!Array.isArray(messages)) return '';
    return messages.map((message) => {
        const role = String(message?.role || message?.type || 'message');
        const raw = message?.content ?? message?.parts ?? message?.text ?? message;
        let content;
        if (typeof raw === 'string') content = raw;
        else if (Array.isArray(raw)) {
            content = raw.map(part => (typeof part === 'string' ? part
                : typeof part?.text === 'string' ? part.text
                    : JSON.stringify(part, null, 2))).join('\n');
        } else content = JSON.stringify(raw, null, 2);
        const extras = [];
        if (message?.tool_calls) extras.push(`tool_calls: ${JSON.stringify(message.tool_calls, null, 2)}`);
        if (message?.tool_call_id) extras.push(`tool_call_id: ${message.tool_call_id}`);
        return `[${role}]\n${content}${extras.length ? `\n${extras.join('\n')}` : ''}`;
    }).join('\n\n');
}

/** 模型原始回复（诊断里是 JSON 字符串）→ 好读的缩进文本。 */
export function formatModelOutputText(modelOutput) {
    const text = String(modelOutput ?? '');
    if (!text) return '';
    try {
        const parsed = JSON.parse(text);
        if (parsed && typeof parsed === 'object') {
            const slim = { ...parsed };
            for (const key of Object.keys(slim)) {
                const value = slim[key];
                if (value === '' || value === null || value === undefined || value === false
                    || (Array.isArray(value) && value.length === 0)) delete slim[key];
            }
            return JSON.stringify(slim, null, 2);
        }
    } catch { /* 不是 JSON，原样 */ }
    return text;
}

// ─── NAI 请求 ──────────────────────────────────────────────────────────────

/** 实际发出的 NAI payload → 日志里要看的字段。不含 key / 端点，氛围图只记数量。 */
export function summarizeNaiRequest(prepared = {}, request = {}) {
    const payload = prepared?.payload && typeof prepared.payload === 'object' ? prepared.payload : {};
    const p = payload.parameters && typeof payload.parameters === 'object' ? payload.parameters : {};
    const params = request?.params && typeof request.params === 'object' ? request.params : {};
    const positive = p.v4_prompt?.caption?.base_caption ?? payload.input ?? request?.scene ?? '';
    const negative = p.v4_negative_prompt?.caption?.base_caption ?? p.negative_prompt ?? request?.negativePrompt ?? '';
    let characters = [];
    const posCaps = p.v4_prompt?.caption?.char_captions;
    const negCaps = p.v4_negative_prompt?.caption?.char_captions;
    if (Array.isArray(posCaps) && posCaps.length) {
        characters = posCaps.map((caption, index) => {
            const center = caption?.centers?.[0] || {};
            return {
                prompt: String(caption?.char_caption || ''),
                uc: String(negCaps?.[index]?.char_caption || ''),
                center: { x: toNumberOrNull(center.x), y: toNumberOrNull(center.y) },
            };
        });
    } else if (Array.isArray(request?.characterPrompts)) {
        characters = request.characterPrompts.filter(Boolean).map(item => ({
            prompt: String(item.prompt || ''),
            uc: String(item.uc || ''),
            center: { x: toNumberOrNull(item.center?.x), y: toNumberOrNull(item.center?.y) },
        }));
    }
    const vibeList = p.reference_image_multiple ?? p.director_reference_images ?? p.reference_image ?? null;
    const vibeCount = Array.isArray(vibeList) ? vibeList.length : (vibeList ? 1 : 0);
    return redactSecrets({
        model: String(payload.model || params.model || ''),
        transport: String(prepared?.transport || (prepared?.isV5 ? 'msgpack-stream' : '')),
        positive: String(positive),
        negative: String(negative),
        characters,
        useCoords: p.use_coords === true || p.v4_prompt?.use_coords === true,
        width: toNumberOrNull(p.width ?? params.width),
        height: toNumberOrNull(p.height ?? params.height),
        steps: toNumberOrNull(p.steps ?? params.steps),
        scale: toNumberOrNull(p.scale ?? params.scale),
        cfgRescale: toNumberOrNull(p.cfg_rescale ?? params.cfg_rescale),
        sampler: String(p.sampler || params.sampler || ''),
        noiseSchedule: String(p.noise_schedule || params.scheduler || ''),
        seed: toNumberOrNull(p.seed ?? params.seed),
        vibeCount,
    });
}

export function describeError(error, classified = null) {
    if (!error && !classified) return null;
    return redactSecrets({
        code: String(classified?.code || error?.code || ''),
        label: String(classified?.label || ''),
        message: String(error?.message || classified?.desc || error || ''),
    });
}

// ─── 楼层渲染 ──────────────────────────────────────────────────────────────

const STATUS_PLACEHOLDER_REGEX = /<StatusPlaceHolderImpl\s*\/?>/i;

export function hasStatusPlaceholder(text) {
    return STATUS_PLACEHOLDER_REGEX.test(String(text ?? ''));
}

/**
 * message-rerender.js 的 onRenderReport 报告折进一条日志的 renders 列表。
 * stage: rendered（改写了楼层）/ skipped（在编辑，没渲染）/ error / checked（隔半秒查状态栏）/ retried（自愈补发）/ superseded（被新一轮渲染接手）
 */
export function applyRenderReport(renders, report) {
    const list = Array.isArray(renders) ? renders.map(item => ({ ...item })) : [];
    if (!report || typeof report !== 'object') return list;
    const renderId = String(report.renderId ?? '');
    const at = toNumberOrNull(report.at) ?? Date.now();
    const find = () => list.find(item => item.renderId === renderId);
    switch (report.stage) {
        case 'rendered':
        case 'skipped':
        case 'error': {
            const existing = find();
            if (existing) {
                if (report.stage === 'error') {
                    existing.outcome = 'error';
                    existing.note = redactText(report.error || '渲染出错');
                }
                break;
            }
            list.push({
                renderId,
                messageId: toNumberOrNull(report.messageId),
                at,
                outcome: report.stage,
                mvuBusy: typeof report.mvuBusy === 'boolean' ? report.mvuBusy : null,
                hasPlaceholder: typeof report.hasPlaceholder === 'boolean' ? report.hasPlaceholder : null,
                statusAfter: null,
                retries: 0,
                recovered: null,
                note: report.stage === 'error' ? redactText(report.error || '渲染出错') : '',
            });
            break;
        }
        case 'checked': {
            const item = find();
            if (!item) break;
            const status = report.statusBar === 'iframe' || report.statusBar === 'code' || report.statusBar === 'none'
                ? report.statusBar
                : (report.needsRetry ? 'code' : 'ok');
            const attempt = Number(report.attempt) || 0;
            if (attempt === 0) item.statusAfter = status;
            else item.recovered = !report.needsRetry;
            item.finalStatus = status;
            break;
        }
        case 'retried': {
            const item = find();
            if (item) item.retries = Math.max(item.retries || 0, Number(report.attempt) || 1);
            break;
        }
        case 'superseded': {
            const item = find();
            if (item && item.statusAfter === null) {
                item.statusAfter = 'superseded';
                item.note = '半秒内又有新的渲染，交给下一次检查';
            }
            break;
        }
        default:
            break;
    }
    return list.slice(-MAX_RENDERS_PER_ENTRY);
}

// ─── 条目 ──────────────────────────────────────────────────────────────────

export function createDrawLogEntry({ id, kind = 'message', messageId = null, automatic = false, now = Date.now() } = {}) {
    return {
        id: String(id || `log-${now}-${Math.random().toString(36).slice(2, 8)}`),
        version: 1,
        startedAt: now,
        finishedAt: null,
        kind: kind === 'text' ? 'text' : 'message',
        messageId: kind === 'text' ? null : toNumberOrNull(messageId),
        automatic: automatic === true,
        status: 'running',
        success: 0,
        total: 0,
        error: null,
        agent: null,
        nai: { sendMode: '', images: [] },
        renders: [],
    };
}

/** 按开始时间倒序，最多留 max 条。返回 { kept, removedIds }。 */
export function trimDrawLogEntries(entries, max = DRAW_LOG_MAX_ENTRIES) {
    const list = (Array.isArray(entries) ? entries : []).filter(item => item && item.id);
    list.sort((a, b) => (Number(b.startedAt) || 0) - (Number(a.startedAt) || 0));
    const limit = Math.max(0, Math.floor(Number(max) || 0));
    return { kept: list.slice(0, limit), removedIds: list.slice(limit).map(item => item.id) };
}

function pad(number, size = 2) {
    return String(number).padStart(size, '0');
}

export function formatLogTime(timestamp, { withDate = true, withMs = false } = {}) {
    const date = new Date(Number(timestamp) || 0);
    if (Number.isNaN(date.getTime())) return '—';
    const time = `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}${withMs ? `.${pad(date.getMilliseconds(), 3)}` : ''}`;
    return withDate ? `${date.getMonth() + 1}-${pad(date.getDate())} ${time}` : time;
}

export function formatDuration(ms) {
    const number = Number(ms);
    if (!Number.isFinite(number) || number < 0) return '—';
    return number < 1000 ? `${Math.round(number)} 毫秒` : `${(number / 1000).toFixed(1)} 秒`;
}

export function describeEntryFloor(entry) {
    if (entry?.kind === 'text') return '文本配图';
    const id = toNumberOrNull(entry?.messageId);
    return id === null ? '楼层未知' : `#${id} 楼`;
}

export function describeEntryResult(entry) {
    const total = Number(entry?.total) || 0;
    const success = Number(entry?.success) || 0;
    const failed = (entry?.nai?.images || []).filter(image => image?.state === 'failed').length;
    switch (entry?.status) {
        case 'running': return '进行中';
        case 'aborted': return success > 0 ? `已取消，成功 ${success} 张` : '已取消';
        case 'failed': {
            const reason = entry?.error?.label || entry?.error?.message || '未知原因';
            return `失败：${reason}`;
        }
        case 'partial': return `成功 ${success} 张，失败 ${failed || Math.max(0, total - success)} 张`;
        case 'success': return total === 0 ? '没有要画的图' : `成功 ${success} 张`;
        default: return String(entry?.status || '—');
    }
}

export function summarizeEntryLine(entry) {
    return `${formatLogTime(entry?.startedAt)} · ${describeEntryFloor(entry)} · ${describeEntryResult(entry)}`;
}

/** 配图结束：按生成结果定 status。 */
export function finishEntryFromResult(entry, result = {}, now = Date.now()) {
    const next = { ...entry, finishedAt: now };
    next.success = Number(result?.success) || 0;
    next.total = Number(result?.total) || 0;
    if (result?.aborted) next.status = 'aborted';
    else if (next.total > 0 && next.success === 0) {
        next.status = 'failed';
        const firstFailed = (entry?.nai?.images || []).find(image => image?.state === 'failed');
        next.error = firstFailed?.error || { code: '', label: '全部失败', message: '这次的图都没有生成成功' };
    } else if (next.success < next.total) next.status = 'partial';
    else next.status = 'success';
    if (result?.terminationReason === 'detached') next.note = '聊天或楼层已经变化，图片没写进原楼层';
    return next;
}

export function failEntry(entry, error, classified = null, now = Date.now()) {
    const aborted = classified?.code === 'aborted' || error?.code === 'REQUEST_ABORTED';
    return {
        ...entry,
        finishedAt: now,
        status: aborted ? 'aborted' : 'failed',
        error: describeError(error, classified),
    };
}

// ─── 复制成纯文本 ─────────────────────────────────────────────────────────

const RENDER_STATUS_LABEL = {
    iframe: '状态栏是 iframe（正常）',
    code: '状态栏还是代码',
    none: '楼层里没有状态栏',
    ok: '没发现未渲染的状态栏代码',
    superseded: '被新一轮渲染接手',
};

export function describeRenderStatus(status) {
    return RENDER_STATUS_LABEL[status] || '没检查';
}

function yesNo(value, yes = '是', no = '否') {
    return value === true ? yes : value === false ? no : '未知';
}

function indent(text, prefix = '    ') {
    return String(text ?? '').split('\n').map(line => `${prefix}${line}`).join('\n');
}

export function describeCenter(center) {
    const x = toNumberOrNull(center?.x);
    const y = toNumberOrNull(center?.y);
    return x === null || y === null ? '未设' : `(${x}, ${y})`;
}

export function buildEntryCopyText(entry) {
    if (!entry) return '';
    const lines = [];
    lines.push(`【小黑生图日志】${summarizeEntryLine(entry)}`);
    lines.push(`开始：${formatLogTime(entry.startedAt, { withMs: true })}  结束：${entry.finishedAt ? formatLogTime(entry.finishedAt, { withMs: true }) : '—'}  触发：${entry.automatic ? '自动' : '手动'}`);
    if (entry.error) lines.push(`错误：${[entry.error.label, entry.error.code, entry.error.message].filter(Boolean).join(' | ')}`);
    if (entry.note) lines.push(`备注：${entry.note}`);

    const agent = entry.agent;
    lines.push('', '== 场景 Agent ==');
    if (!agent) lines.push('（没有记录，可能在分析前就停了）');
    else {
        lines.push(`接口：${agent.provider || '—'}  模型：${agent.model || '—'}  预设：${agent.presetName || '—'}  状态：${agent.status || '—'}  总耗时：${formatDuration(agent.durationMs)}`);
        if (agent.errorCode || agent.errorMessage) lines.push(`结果：${[agent.errorCode, agent.errorMessage].filter(Boolean).join(' | ')}`);
        for (const round of agent.rounds || []) {
            lines.push('', `-- 第 ${round.index} 轮 · ${round.phase === 'correction' ? '纠错' : '分析'} · 耗时 ${formatDuration(round.durationMs)}${round.finishReason ? ` · finish=${round.finishReason}` : ''} --`);
            if (round.errorCode) lines.push(`请求错误：${round.errorCode}`);
            if (round.validation) {
                lines.push(`没过校验：${round.validation.code || '—'}  路径：${round.validation.path || '—'}${round.validation.rule ? `  规则：${round.validation.rule}` : ''}`);
                if (round.validation.message) lines.push(`说明：${round.validation.message}`);
            }
            if (round.request) {
                lines.push('发出去的提示词：');
                lines.push(indent(round.request.messages ? formatMessagesText(round.request.messages) : JSON.stringify(round.request.body ?? null, null, 2)));
                if (round.request.messages && round.request.body && Object.keys(round.request.body).length) {
                    lines.push('其余请求参数：');
                    lines.push(indent(JSON.stringify(round.request.body, null, 2)));
                }
            }
            if (round.modelOutput) {
                lines.push('模型原始回复：');
                lines.push(indent(formatModelOutputText(round.modelOutput)));
            }
        }
    }

    lines.push('', '== NAI 请求 ==');
    const images = entry.nai?.images || [];
    if (!images.length) lines.push('（没有发出 NAI 请求）');
    if (entry.nai?.sendMode) lines.push(`发送方式：${entry.nai.sendMode === 'backend' ? '后端发送' : '前端直连'}`);
    images.forEach((image, index) => {
        const req = image.request || {};
        const state = image.state === 'ready' ? '成功' : image.state === 'failed' ? '失败' : image.state === 'cancelled' ? '已取消' : '没回结果';
        lines.push('', `-- 图 ${index + 1} · ${state}${image.error ? `：${[image.error.label, image.error.message].filter(Boolean).join(' | ')}` : ''} --`);
        lines.push(`模型：${req.model || '—'}  尺寸：${req.width ?? '—'}×${req.height ?? '—'}  步数：${req.steps ?? '—'}  CFG：${req.scale ?? '—'}  采样器：${req.sampler || '—'}  种子：${req.seed ?? '—'}  氛围图：${req.vibeCount ?? 0} 张`);
        lines.push('正向提示词：', indent(req.positive || ''));
        lines.push('负向提示词：', indent(req.negative || ''));
        (req.characters || []).forEach((character, charIndex) => {
            lines.push(`角色 ${charIndex + 1}  坐标 ${describeCenter(character.center)}`);
            lines.push(indent(`正向：${character.prompt || ''}`));
            lines.push(indent(`负向：${character.uc || ''}`));
        });
    });

    lines.push('', '== 楼层渲染 ==');
    const renders = entry.renders || [];
    if (!renders.length) lines.push('（没有改写楼层）');
    renders.forEach((render) => {
        const parts = [
            formatLogTime(render.at, { withDate: false, withMs: true }),
            render.outcome === 'skipped' ? '楼层正在编辑，没渲染' : render.outcome === 'error' ? '渲染出错' : '改写楼层',
            `MVU 忙：${yesNo(render.mvuBusy)}`,
            `有 <StatusPlaceHolderImpl/>：${yesNo(render.hasPlaceholder)}`,
            `半秒后：${describeRenderStatus(render.statusAfter)}`,
            `自愈补发：${render.retries || 0} 次`,
        ];
        if (render.retries) parts.push(`补发后恢复：${yesNo(render.recovered)}`);
        if (render.note) parts.push(render.note);
        lines.push(parts.join(' | '));
    });
    return lines.join('\n');
}
