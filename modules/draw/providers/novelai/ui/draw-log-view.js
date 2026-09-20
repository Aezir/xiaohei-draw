// 设置页「日志」标签页（#view-log）。只读宿主发来的日志（宿主已打码），不自己存。
// 宿主消息：GET_DRAW_LOGS / CLEAR_DRAW_LOGS → DRAW_LOGS_DATA；日志有变化时宿主发 DRAW_LOGS_CHANGED。
// 设计规矩：色块不加线，层级只靠底色和留白；卡面不放编号角标 / 类型标签；图标用 Remix Icon。

import {
    buildEntryCopyText,
    describeCenter,
    describeEntryFloor,
    describeEntryResult,
    describeNaiShown,
    describeRenderStatus,
    formatDuration,
    formatLogTime,
    formatMessagesText,
    formatModelOutputText,
} from '../../../shared/draw-log.js';
import { PROMPT_HL_PALETTE, highlightPromptHtml } from '../../../shared/nai-prompt-highlight.js';

const STYLE_ID = 'nd-draw-log-styles';
const CLAMP_CHARS = 240;
const P = PROMPT_HL_PALETTE;

const CSS = `
#view-log .nd-log-bar { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; margin-bottom: 8px; }
#view-log .nd-log-bar .nd-log-spacer { flex: 1 1 auto; }
#view-log .nd-log-empty { padding: 28px 12px; color: var(--text-muted); font-size: 12px; text-align: center; }
#view-log .nd-log-empty i { display: block; margin-bottom: 6px; font-size: 28px; opacity: 0.45; }
.nd-log-entry { padding: 0; overflow: hidden; }
.nd-log-entry > summary { list-style: none; display: flex; align-items: center; gap: 8px; padding: 8px 12px; cursor: pointer; font-size: 13px; color: var(--text-primary); transition: background 0.12s; }
.nd-log-entry > summary::-webkit-details-marker { display: none; }
.nd-log-entry > summary:hover { background: var(--bg-tertiary); }
.nd-log-entry.is-current > summary { background: var(--accent-soft); }
.nd-log-line { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.nd-log-line .nd-log-dim { color: var(--text-muted); }
.nd-log-state { font-size: 15px; flex: 0 0 auto; }
.nd-log-state.is-success { color: var(--success); }
.nd-log-state.is-partial { color: var(--warning); }
.nd-log-state.is-failed { color: var(--danger); }
.nd-log-state.is-aborted, .nd-log-state.is-running { color: var(--text-muted); }
.nd-log-arrow { flex: 0 0 auto; color: var(--text-muted); font-size: 16px; transition: transform 0.15s; }
.nd-log-entry[open] > summary .nd-log-arrow { transform: rotate(90deg); }
.nd-log-body { padding: 4px 12px 12px; display: flex; flex-direction: column; gap: 10px; }
.nd-log-sec { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
.nd-log-sec > .nd-subhead { margin: 2px 0 0; }
.nd-log-block { display: flex; flex-direction: column; gap: 6px; padding: 8px 10px; border-radius: var(--radius); background: var(--bg-tertiary); min-width: 0; }
.nd-log-block-title { font-size: 12px; font-weight: 600; color: var(--text-secondary); display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.nd-log-block-title.is-bad { color: var(--danger); }
.nd-log-block-title.is-ok { color: var(--success); }
.nd-log-block-title .nd-log-shown { font-weight: 400; color: var(--text-muted); }
.nd-log-block-title .nd-log-shown.is-bad { color: var(--danger); }
.nd-log-kv { display: grid; grid-template-columns: minmax(64px, auto) minmax(0, 1fr); gap: 3px 10px; font-size: 12px; }
.nd-log-kv > span:nth-child(odd) { color: var(--text-muted); }
.nd-log-kv > span:nth-child(even) { color: var(--text-primary); min-width: 0; word-break: break-word; }
.nd-log-params { display: flex; flex-wrap: wrap; gap: 4px 14px; font-size: 12px; color: var(--text-primary); }
.nd-log-params > span > b { font-weight: 400; color: var(--text-muted); margin-right: 4px; }
.nd-log-label { font-size: 11px; color: var(--text-muted); margin-top: 2px; }
.nd-log-pre { margin: 0; padding: 6px 8px; border-radius: var(--radius-sm); background: var(--bg-input); color: var(--text-primary); font-family: Consolas, "Cascadia Mono", "SFMono-Regular", Menlo, monospace; font-size: 11.5px; line-height: 1.55; white-space: pre-wrap; overflow-wrap: anywhere; word-break: break-word; user-select: text; max-height: 460px; overflow: auto; }
.nd-log-prompt.is-clamped .nd-log-pre { max-height: 4.9em; overflow: hidden; }
.nd-log-more { align-self: flex-start; margin-top: 4px; }
.nd-log-prompt { display: flex; flex-direction: column; min-width: 0; }
.nd-log-fold { border-radius: var(--radius-sm); background: var(--bg-secondary); }
.nd-log-fold > summary { list-style: none; display: flex; align-items: center; gap: 6px; padding: 5px 8px; cursor: pointer; font-size: 12px; color: var(--text-secondary); border-radius: var(--radius-sm); }
.nd-log-fold > summary::-webkit-details-marker { display: none; }
.nd-log-fold > summary:hover { background: var(--bg-hover); }
.nd-log-fold > summary i { font-size: 14px; transition: transform 0.15s; }
.nd-log-fold[open] > summary i.nd-log-fold-arrow { transform: rotate(90deg); }
.nd-log-fold > .nd-log-pre { margin: 0 6px 6px; }
.nd-log-char { display: flex; flex-direction: column; gap: 3px; padding: 6px 8px; border-radius: var(--radius-sm); background: var(--bg-secondary); }
.nd-log-renders { display: flex; flex-direction: column; gap: 4px; }
.nd-log-render { display: flex; flex-wrap: wrap; gap: 3px 12px; padding: 6px 8px; border-radius: var(--radius); background: var(--bg-tertiary); font-size: 12px; color: var(--text-primary); }
.nd-log-render > span > b { font-weight: 400; color: var(--text-muted); margin-right: 4px; }
.nd-log-render .is-bad { color: var(--danger); }
.nd-log-render .is-ok { color: var(--success); }
.nd-log-note { font-size: 12px; color: var(--text-muted); }
.nd-log-hl .hw { color: ${P.weight}; }
.nd-log-hl .hc { color: ${P.comma}; }
.nd-log-hl .hp { color: ${P.pipe}; }
.nd-log-hl .hap { color: ${P.artistPrefix}; }
.nd-log-hl .han { color: ${P.artistName}; }
.nd-log-hl .hb { color: ${P.paren}; }
.nd-log-hl .hx { color: ${P.repeat}; }
.nd-log-hl .hbr.d1 { color: ${P.brace1}; }
.nd-log-hl .hbr.d2 { color: ${P.brace2}; }
.nd-log-hl .hbr.d3 { color: ${P.brace3}; }
.nd-log-hl .herr { text-decoration: underline wavy ${P.error}; text-underline-offset: 3px; }
.nd-log-hl .hwarn { text-decoration: underline wavy ${P.warn}; text-underline-offset: 3px; }
@media (max-width: 760px) {
    .nd-log-entry > summary { padding: 8px 10px; font-size: 12px; }
    .nd-log-line { white-space: normal; }
    .nd-log-body { padding: 4px 8px 10px; }
}
`;

const state = {
    entries: [],
    currentId: '',
    nodes: new Map(),
    signatures: new Map(),
    loading: false,
    refreshTimer: null,
};

const $ = id => document.getElementById(id);

function esc(value) {
    return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function ensureStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = CSS;
    document.head.appendChild(style);
}

function send(payload) {
    if (typeof window.postToParent === 'function') window.postToParent(payload);
}

function requestLogs() {
    state.loading = true;
    send({ type: 'GET_DRAW_LOGS' });
}

function isViewActive() {
    return !!$('view-log')?.classList.contains('active');
}

function scheduleRefresh() {
    if (!isViewActive() || state.refreshTimer) return;
    state.refreshTimer = setTimeout(() => {
        state.refreshTimer = null;
        if (isViewActive()) requestLogs();
    }, 800);
}

// ─── 小部件 ───────────────────────────────────────────────────────────────

function countChars(text) {
    const length = String(text || '').length;
    return length >= 10000 ? `${(length / 10000).toFixed(1)} 万字` : `${length} 字`;
}

/** 大段文本：折叠块，点开才把内容填进去（几万字的提示词不提前塞 DOM） */
function foldHtml(key, title, text, { icon = 'ri-file-text-line' } = {}) {
    const body = String(text || '');
    if (!body) return '';
    foldContents.set(key, body);
    return `<details class="nd-log-fold" data-fold="${esc(key)}"><summary><i class="ri-arrow-right-s-line nd-log-fold-arrow"></i><i class="${icon}"></i><span>${esc(title)} · ${countChars(body)}</span></summary><pre class="nd-log-pre"></pre></details>`;
}

const foldContents = new Map();

function promptHtml(label, text) {
    const body = String(text || '');
    const long = body.length > CLAMP_CHARS || body.split('\n').length > 3;
    let highlighted;
    try {
        highlighted = highlightPromptHtml(body);
    } catch {
        highlighted = esc(body);
    }
    return `<div class="nd-log-label">${esc(label)}</div>
        <div class="nd-log-prompt${long ? ' is-clamped' : ''}">
            <pre class="nd-log-pre nd-log-hl">${body ? highlighted : '<span class="nd-log-dim">（空）</span>'}</pre>
            ${long ? '<button type="button" class="btn btn-sm nd-log-more"><i class="ri-arrow-down-s-line"></i> 展开全部</button>' : ''}
        </div>`;
}

function kvHtml(pairs) {
    const rows = pairs.filter(([, value]) => value !== undefined && value !== null && value !== '');
    if (!rows.length) return '';
    return `<div class="nd-log-kv">${rows.map(([key, value]) => `<span>${esc(key)}</span><span>${esc(value)}</span>`).join('')}</div>`;
}

function stateIcon(status) {
    switch (status) {
        case 'success': return '<i class="ri-checkbox-circle-line nd-log-state is-success"></i>';
        case 'partial': return '<i class="ri-error-warning-line nd-log-state is-partial"></i>';
        case 'failed': return '<i class="ri-close-circle-line nd-log-state is-failed"></i>';
        case 'aborted': return '<i class="ri-stop-circle-line nd-log-state is-aborted"></i>';
        default: return '<i class="ri-loader-4-line ri-spin nd-log-state is-running"></i>';
    }
}

// ─── 三块内容 ─────────────────────────────────────────────────────────────

function agentSectionHtml(entry) {
    const agent = entry.agent;
    const head = '<div class="nd-subhead"><i class="ri-robot-2-line"></i>场景 Agent</div>';
    if (!agent) return `<section class="nd-log-sec">${head}<div class="nd-log-note">没有记录（可能在分析开始前就停了）</div></section>`;
    const statusText = agent.status === 'success' ? '通过' : agent.status === 'error' ? '失败' : agent.status === 'running' ? '进行中' : agent.status;
    const meta = kvHtml([
        ['接口', agent.provider],
        ['模型', agent.model],
        ['预设', agent.presetName],
        ['结果', [statusText, agent.errorCode, agent.errorMessage].filter(Boolean).join(' · ')],
        ['总耗时', formatDuration(agent.durationMs)],
    ]);
    const rounds = (agent.rounds || []).map((round) => {
        const key = `${entry.id}:agent:${round.index}`;
        const bad = !!(round.validation || round.errorCode);
        const title = `第 ${round.index} 轮 · ${round.phase === 'correction' ? '纠错' : '分析'} · ${formatDuration(round.durationMs)}${round.validation ? ' · 没过校验' : round.errorCode ? ' · 请求失败' : ''}`;
        const validation = round.validation ? kvHtml([
            ['错误码', round.validation.code],
            ['路径', round.validation.path],
            ['规则', round.validation.rule],
            ['说明', round.validation.message],
        ]) : '';
        const requestError = !round.validation && round.errorCode ? kvHtml([['错误码', round.errorCode]]) : '';
        const request = round.request || null;
        const messages = request?.messages ? formatMessagesText(request.messages) : '';
        const bodyText = request?.body && Object.keys(request.body).length ? JSON.stringify(request.body, null, 2) : '';
        const messageCount = Array.isArray(request?.messages) ? `${request.messages.length} 条消息` : '';
        return `<div class="nd-log-block">
            <div class="nd-log-block-title${bad ? ' is-bad' : ''}">${esc(title)}</div>
            ${validation}${requestError}
            ${messages ? foldHtml(`${key}:messages`, `发出去的提示词${messageCount ? `（${messageCount}）` : ''}`, messages, { icon: 'ri-chat-upload-line' }) : ''}
            ${bodyText ? foldHtml(`${key}:body`, messages ? '其余请求参数' : '发出去的请求', bodyText, { icon: 'ri-braces-line' }) : ''}
            ${!request ? '<div class="nd-log-note">这一轮没拿到实际请求内容</div>' : ''}
            ${round.modelOutput ? foldHtml(`${key}:output`, '模型原始回复', formatModelOutputText(round.modelOutput), { icon: 'ri-chat-download-line' }) : '<div class="nd-log-note">没有模型回复</div>'}
        </div>`;
    }).join('');
    return `<section class="nd-log-sec">${head}${meta}${rounds}</section>`;
}

function naiSectionHtml(entry) {
    const head = '<div class="nd-subhead"><i class="ri-image-ai-line"></i>NAI 请求</div>';
    const images = entry.nai?.images || [];
    if (!images.length) return `<section class="nd-log-sec">${head}<div class="nd-log-note">没有发出 NAI 请求</div></section>`;
    const mode = entry.nai?.sendMode ? `<div class="nd-log-note">发送方式：${entry.nai.sendMode === 'backend' ? '后端发送' : '前端直连'}</div>` : '';
    const blocks = images.map((image, index) => {
        const req = image.request || {};
        const ok = image.state === 'ready';
        const stateText = ok ? '成功' : image.state === 'failed' ? '失败' : image.state === 'cancelled' ? '已取消' : '没回结果';
        const errorText = image.error ? `：${[image.error.label, image.error.message].filter(Boolean).join(' · ')}` : '';
        const shownText = describeNaiShown(image.shown);
        const shownFine = shownText === '出图即上屏';
        const params = [
            ['模型', req.model || '—'],
            ['尺寸', `${req.width ?? '—'}×${req.height ?? '—'}`],
            ['步数', req.steps ?? '—'],
            ['CFG', req.scale ?? '—'],
            ['采样器', req.sampler || '—'],
            ['种子', req.seed ?? '—'],
            ['氛围图', `${req.vibeCount ?? 0} 张`],
        ].map(([key, value]) => `<span><b>${esc(key)}</b>${esc(value)}</span>`).join('');
        const characters = (req.characters || []).map((character, charIndex) => `<div class="nd-log-char">
            <div class="nd-log-label">角色 ${charIndex + 1} · 坐标 ${esc(describeCenter(character.center))}</div>
            ${promptHtml('正向', character.prompt)}
            ${character.uc ? promptHtml('负向', character.uc) : ''}
        </div>`).join('');
        return `<div class="nd-log-block">
            <div class="nd-log-block-title${ok ? ' is-ok' : image.state === 'failed' ? ' is-bad' : ''}">图 ${index + 1} · ${esc(stateText + errorText)}${shownText ? `<span class="nd-log-shown${shownFine ? '' : ' is-bad'}"> · 上屏：${esc(shownText)}</span>` : ''}</div>
            <div class="nd-log-params">${params}</div>
            ${promptHtml('正向提示词', req.positive)}
            ${promptHtml('负向提示词', req.negative)}
            ${characters}
        </div>`;
    }).join('');
    return `<section class="nd-log-sec">${head}${mode}${blocks}</section>`;
}

function yesNo(value) {
    return value === true ? '是' : value === false ? '否' : '未知';
}

function renderSectionHtml(entry) {
    const head = '<div class="nd-subhead"><i class="ri-layout-row-line"></i>楼层渲染</div>';
    const renders = entry.renders || [];
    if (entry.kind === 'text') return '';
    if (!renders.length) return `<section class="nd-log-sec">${head}<div class="nd-log-note">这次没有改写楼层</div></section>`;
    const rows = renders.map((render) => {
        const outcome = render.outcome === 'skipped' ? '楼层正在编辑，没渲染' : render.outcome === 'error' ? '渲染出错' : '改写楼层';
        const statusClass = render.statusAfter === 'code' ? 'is-bad' : render.statusAfter === 'iframe' ? 'is-ok' : '';
        const parts = [
            `<span>${esc(formatLogTime(render.at, { withDate: false, withMs: true }))}</span>`,
            `<span${render.outcome === 'error' ? ' class="is-bad"' : ''}>${esc(outcome)}</span>`,
            `<span><b>MVU 在忙</b>${esc(yesNo(render.mvuBusy))}</span>`,
            `<span><b>有 &lt;StatusPlaceHolderImpl/&gt;</b>${esc(yesNo(render.hasPlaceholder))}</span>`,
            `<span><b>半秒后</b><span class="${statusClass}">${esc(describeRenderStatus(render.statusAfter))}</span></span>`,
            `<span><b>自愈补发</b>${esc(render.retries || 0)} 次</span>`,
        ];
        if (render.retries) {
            parts.push(`<span><b>补发后恢复</b><span class="${render.recovered === true ? 'is-ok' : render.recovered === false ? 'is-bad' : ''}">${esc(yesNo(render.recovered))}</span></span>`);
        }
        if (render.note) parts.push(`<span class="nd-log-note">${esc(render.note)}</span>`);
        return `<div class="nd-log-render">${parts.join('')}</div>`;
    }).join('');
    return `<section class="nd-log-sec">${head}<div class="nd-log-renders">${rows}</div></section>`;
}

function entryBodyHtml(entry) {
    const meta = kvHtml([
        ['开始', formatLogTime(entry.startedAt, { withMs: true })],
        ['结束', entry.finishedAt ? formatLogTime(entry.finishedAt, { withMs: true }) : '还没结束'],
        ['触发', entry.kind === 'text' ? '文本配图' : entry.automatic ? '自动配图' : '手动配图'],
        ['错误', entry.error ? [entry.error.label, entry.error.code, entry.error.message].filter(Boolean).join(' · ') : ''],
        ['备注', entry.note],
    ]);
    return `${meta}${agentSectionHtml(entry)}${naiSectionHtml(entry)}${renderSectionHtml(entry)}`;
}

// ─── 列表 ─────────────────────────────────────────────────────────────────

function entryNode(entry) {
    const node = document.createElement('details');
    node.className = 'card nd-log-entry';
    node.dataset.id = entry.id;
    node.innerHTML = `<summary>${stateIcon(entry.status)}<span class="nd-log-line">${esc(formatLogTime(entry.startedAt))}<span class="nd-log-dim"> · </span>${esc(describeEntryFloor(entry))}<span class="nd-log-dim"> · </span>${esc(describeEntryResult(entry))}</span><i class="ri-arrow-right-s-line nd-log-arrow"></i></summary><div class="nd-log-body"></div>`;
    node.addEventListener('toggle', () => {
        if (node.open) {
            fillBody(node, entry.id);
            setCurrent(entry.id);
        } else if (state.currentId === entry.id) {
            const other = document.querySelector('#nd_log_list .nd-log-entry[open]');
            setCurrent(other?.dataset.id || '');
        }
    });
    return node;
}

function fillBody(node, id) {
    const body = node.querySelector('.nd-log-body');
    const entry = state.entries.find(item => item.id === id);
    if (!body || !entry || body.dataset.filled === '1') return;
    body.innerHTML = entryBodyHtml(entry);
    body.dataset.filled = '1';
}

function setCurrent(id) {
    state.currentId = id;
    document.querySelectorAll('#nd_log_list .nd-log-entry').forEach(item => item.classList.toggle('is-current', item.dataset.id === id));
    const copy = $('nd_log_copy');
    if (copy) copy.disabled = !id;
}

function renderList() {
    const list = $('nd_log_list');
    if (!list) return;
    const hint = $('nd_log_hint');
    if (hint) hint.textContent = state.entries.length ? `共 ${state.entries.length} 条，最多保留 50 条。点开一条再点「复制这条」，可以整条发给开发者（密钥已打码，图片不保存）。` : '';

    if (!state.entries.length) {
        state.nodes.clear();
        state.signatures.clear();
        list.innerHTML = '<div class="card nd-log-empty"><i class="ri-file-list-3-line"></i>还没有生图记录。配一次图之后这里会出现完整过程。</div>';
        setCurrent('');
        return;
    }

    // 已打开的折叠块记下来，重建后恢复（生成进行中日志会不断刷新）
    const openFolds = new Set([...list.querySelectorAll('.nd-log-fold[open]')].map(item => item.dataset.fold));
    const nextNodes = new Map();
    const fragment = document.createDocumentFragment();
    for (const entry of state.entries) {
        const signature = JSON.stringify(entry);
        let node = state.nodes.get(entry.id);
        if (!node || state.signatures.get(entry.id) !== signature) {
            const wasOpen = node?.open === true;
            node = entryNode(entry);
            if (wasOpen) {
                node.open = true;
                fillBody(node, entry.id);
            }
        }
        state.signatures.set(entry.id, signature);
        nextNodes.set(entry.id, node);
        fragment.appendChild(node);
    }
    for (const id of state.signatures.keys()) if (!nextNodes.has(id)) state.signatures.delete(id);
    state.nodes = nextNodes;
    list.replaceChildren(fragment);
    list.querySelectorAll('.nd-log-fold').forEach((fold) => {
        if (openFolds.has(fold.dataset.fold)) {
            fold.open = true;
            fillFold(fold);
        }
    });
    setCurrent(nextNodes.has(state.currentId) ? state.currentId : '');
}

function fillFold(fold) {
    const pre = fold.querySelector(':scope > .nd-log-pre');
    if (!pre || pre.dataset.filled === '1') return;
    pre.textContent = foldContents.get(fold.dataset.fold) || '';
    pre.dataset.filled = '1';
}

async function copyText(text) {
    try {
        if (navigator.clipboard?.writeText) {
            await navigator.clipboard.writeText(text);
            return true;
        }
    } catch { /* iframe 里可能没有剪贴板权限，走下面的老办法 */ }
    try {
        const area = document.createElement('textarea');
        area.value = text;
        area.setAttribute('readonly', '');
        area.style.cssText = 'position:fixed;top:0;left:-9999px;opacity:0;';
        document.body.appendChild(area);
        area.select();
        const ok = document.execCommand('copy');
        area.remove();
        return ok;
    } catch {
        return false;
    }
}

function flashButton(button, html) {
    if (!button) return;
    const original = button.dataset.originalHtml || button.innerHTML;
    button.dataset.originalHtml = original;
    button.innerHTML = html;
    clearTimeout(Number(button.dataset.flashTimer || 0));
    button.dataset.flashTimer = String(setTimeout(() => { button.innerHTML = original; }, 1600));
}

function bind() {
    const view = $('view-log');
    if (!view || view.dataset.bound === '1') return;
    view.dataset.bound = '1';
    ensureStyles();

    $('nd_log_refresh')?.addEventListener('click', requestLogs);
    $('nd_log_copy')?.addEventListener('click', async () => {
        const entry = state.entries.find(item => item.id === state.currentId);
        if (!entry) return;
        const ok = await copyText(buildEntryCopyText(entry));
        flashButton($('nd_log_copy'), ok ? '<i class="ri-check-line"></i> 已复制' : '<i class="ri-close-line"></i> 复制失败');
    });
    $('nd_log_clear')?.addEventListener('click', async () => {
        const dialog = window.XBDialog;
        const ok = dialog ? await dialog.confirm('确定清空全部生图日志？清空后找不回来。', { title: '清空日志', danger: true, okLabel: '清空' }) : false;
        if (ok) send({ type: 'CLEAR_DRAW_LOGS' });
    });

    $('nd_log_list')?.addEventListener('toggle', (event) => {
        const fold = event.target;
        if (fold?.classList?.contains('nd-log-fold') && fold.open) fillFold(fold);
    }, true);
    $('nd_log_list')?.addEventListener('click', (event) => {
        const more = event.target.closest?.('.nd-log-more');
        if (!more) return;
        const box = more.closest('.nd-log-prompt');
        const clamped = box.classList.toggle('is-clamped');
        more.innerHTML = clamped ? '<i class="ri-arrow-down-s-line"></i> 展开全部' : '<i class="ri-arrow-up-s-line"></i> 收起';
    });

    document.querySelectorAll('[data-view="log"]').forEach(item => item.addEventListener('click', () => {
        setTimeout(requestLogs, 0);
    }));

    window.addEventListener('message', (event) => {
        if (event.source !== window.parent) return;
        const data = event.data;
        if (!data || data.source !== 'XBDraw-NovelDraw') return;
        if (data.type === 'DRAW_LOGS_DATA') {
            state.loading = false;
            state.entries = Array.isArray(data.entries) ? data.entries : [];
            renderList();
        } else if (data.type === 'DRAW_LOGS_CHANGED') {
            scheduleRefresh();
        }
    });

    renderList();
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bind, { once: true });
else bind();
