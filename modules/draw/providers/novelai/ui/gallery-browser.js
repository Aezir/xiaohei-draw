// G1b：设置页 iframe 里的内置画廊（和酒馆主页面同源，直接读写 IndexedDB，密钥不走 postMessage）。
//   #nd-gallery-auth-slot  （API 配置）画廊同步仓库：令牌 + 密码 + 仓库（可空，自动识别）→ 连接；记住登录；断开；
//                          仓库没初始化时明确确认后由小黑生图初始化；连上后可把本机画廊合并上去。
//   #nd-gallery-link-slot  （图片管理）画廊浏览：懒加载缩略图网格、搜索、收藏 / 模型分段、批次筛选、分页、隐私模糊、
//                          详情（大图、参数、提示词分支、角色提示词「复制 / 存为角色标签」、导入为参数预设）。
//   #nd-preset-import-slot （绘图参数预设栏）「从画廊导入」→ 跳到画廊浏览的选择模式。
// 没连仓库时浏览的是本机画廊（decisions 第 1 条）。
// 宿主消息：IMPORT_GALLERY_PRESET → GALLERY_PRESET_IMPORTED / GALLERY_PRESET_DUPLICATE；
//          SAVE_GALLERY_CHARACTER_TAG → GALLERY_CHARACTER_TAG_SAVED；GALLERY_BATCH_DONE → 刷新列表。
import { createCredentialStore } from '../../../shared/gallery-sync/credential-store.js';
import { createLocalGallery } from '../../../shared/gallery-sync/local-store.js';
import { readState, listImages, loadImage } from '../../../shared/gallery-sync/gallery-client.js';
import { initGalleryRepo } from '../../../shared/gallery-sync/repo-init.js';
import { buildImportGalleryPresetMessage } from '../../../shared/gallery-sync/gallery-actions.js';
import { pickVariant } from '../../../shared/gallery-sync/preset-from-gallery.js';
import { createPausingThumbQueue } from '../../../shared/gallery-sync/thumb-queue.js';
import { createMemoryKv } from '../../../shared/gallery-sync/idb-kv.js';
import { openXbDialog, xbConfirm, xbPrompt, xbChoose } from '../../../shared/xb-dialog.js';
import {
    PRESET_NAME_MAX, askPresetName, createPresetNameDialogs, defaultGalleryPresetName, resolvePresetNameConflict, uniquePresetName, validatePresetName,
} from '../../../shared/preset-naming.js';

const HOST_SOURCE = 'XBDraw-NovelDraw';
const FRAME_SOURCE = 'NovelDraw-Frame';
const PARENT_ORIGIN = (() => {
    try { return new URL(document.referrer).origin; } catch { return window.location.origin; }
})();
const PRIVACY_KEY = 'xbdraw.gallery.privacy';
const PAGE_SIZE = 24;
const FILTERS = [['all', '全部'], ['fav', '收藏'], ['V4.5', 'V4.5'], ['V5', 'V5']];
const NSFW_RE = /\bnsfw\b/i;

const G = {
    deps: null,
    roots: { auth: null, browser: null, importSlot: null },
    source: null,          // {kind:'local'|'remote', repo, state, readOnly, error, localOnly}
    queue: null,
    loadFull: null,
    io: null,
    urls: new Map(),
    fullUrl: '',
    page: 0,
    query: '',
    filter: 'all',
    batch: '',
    privacy: true,
    revealed: new Set(),
    detail: null,
    pick: false,
    loadedOnce: false,
    loadToken: 0,
    lastImport: null,
    ui: {},
};

// ── 小工具 ───────────────────────────────────────────────────────────────

function h(tag, props = {}, ...kids) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
        if (v == null || v === false) continue;
        if (k === 'class') n.className = v;
        else if (k === 'text') n.textContent = String(v);
        else if (k === 'dataset') Object.assign(n.dataset, v);
        else if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2), v);
        else if (typeof v === 'boolean') n[k] = v;
        else n.setAttribute(k, String(v));
    }
    for (const c of kids.flat()) if (c != null && c !== false) n.append(c.nodeType ? c : document.createTextNode(String(c)));
    return n;
}
const icon = cls => h('i', { class: cls, 'aria-hidden': 'true' });

// 不用设置页的 updateStatus：它会整个覆盖 className，冲掉 nd-gl-status（空时隐藏、harness 定位都靠它）
function setStatus(el, state, text) {
    if (!el) return;
    el.textContent = text || '';
    el.className = `status-text nd-gl-status${state ? ` ${state}` : ''}`;
}

function post(payload) {
    if (G.deps?.post) return G.deps.post(payload);
    if (typeof window.postToParent === 'function') return window.postToParent(payload);
    if (window.parent && window.parent !== window) window.parent.postMessage({ source: FRAME_SOURCE, ...payload }, PARENT_ORIGIN);
}

const frameState = () => (G.deps?.getState ? G.deps.getState() : (typeof window.ndGetState === 'function' ? window.ndGetState() : null)) || {};
const withFetch = creds => (G.deps?.fetch ? { ...creds, fetch: G.deps.fetch } : creds);

function readPrivacy() {
    try { return localStorage.getItem(PRIVACY_KEY) !== 'off'; } catch { return true; }
}
function writePrivacy(on) {
    try { localStorage.setItem(PRIVACY_KEY, on ? 'on' : 'off'); } catch { }
}

function defaultDeps() {
    let credentials = null, local = null;
    try { credentials = createCredentialStore(); } catch (e) { console.warn('[小黑生图画廊] 凭据库不可用：', e); }
    try { local = createLocalGallery(); } catch (e) { console.warn('[小黑生图画廊] 本机画廊不可用：', e); }
    return { credentials, local, fetch: undefined };
}

function liveCount(state) {
    try { return listImages(state, { limit: 0 }).total; } catch { return 0; }
}

function fmtValue(v) {
    if (v == null || v === '') return '—';
    if (typeof v === 'object') { const s = JSON.stringify(v); return s.length > 160 ? `${s.slice(0, 160)}…` : s; }
    return String(v);
}

async function copyText(text) {
    try {
        await navigator.clipboard.writeText(text);
        return true;
    } catch {
        const ta = h('textarea', { class: 'nd-gl-copybuf', 'aria-hidden': 'true' });
        ta.value = text;
        document.body.appendChild(ta);
        ta.select();
        let ok = false;
        try { ok = document.execCommand('copy'); } catch { }
        ta.remove();
        return ok;
    }
}

// ── 连接块（API 配置） ────────────────────────────────────────────────────

async function renderAuth(flash) {
    const slot = G.roots.auth;
    if (!slot) return;
    const { credentials, local } = G.deps;
    const statusEl = h('div', { class: 'status-text nd-gl-status' });
    if (!credentials) {
        slot.replaceChildren(h('div', { class: 'card nd-gl-auth' },
            h('div', { class: 'card-title nd-gl-title' }, icon('ri-git-repository-line'), '画廊同步仓库'),
            h('p', { class: 'form-hint', text: '这个浏览器没有 IndexedDB，画廊同步不可用。' })));
        return;
    }
    let status = { state: 'local' }, creds = null, localCount = 0;
    try { [status, creds] = await Promise.all([credentials.getStatus(), credentials.load()]); }
    catch (e) { status = { state: 'error', message: e?.message || '读不到本机凭据库' }; }
    try { if (local) localCount = liveCount((await local.readState()).state); } catch { }

    const pill = creds
        ? h('span', { class: 'nd-gl-pill is-ok', text: '已连接' })
        : h('span', { class: `nd-gl-pill${status.state === 'error' ? ' is-err' : ''}`, text: status.state === 'error' ? '上次连接失败' : status.state === 'disconnected' ? '已断开' : '本机模式' });
    const title = h('div', { class: 'card-title nd-gl-title' }, icon('ri-git-repository-line'), '画廊同步仓库', pill);
    let body;
    if (creds) {
        const mergeBtn = h('button', { class: 'btn', type: 'button', disabled: !localCount || !local, 'data-act': 'merge' },
            icon('ri-upload-cloud-2-line'), localCount ? `合并本机画廊（${localCount} 张）` : '本机画廊没有图');
        const logoutBtn = h('button', { class: 'btn btn-danger', type: 'button', 'data-act': 'logout' }, icon('ri-logout-box-r-line'), '断开');
        mergeBtn.addEventListener('click', () => mergeLocal(statusEl, mergeBtn));
        logoutBtn.addEventListener('click', () => logout(statusEl));
        body = [
            h('div', { class: 'nd-gl-kv' }, h('span', { text: '仓库' }), h('span', { text: creds.repo })),
            h('p', { class: 'form-hint', text: '已记住登录：仓库、令牌和由密码算出的密钥存在这个浏览器（IndexedDB），密码没有保存，也不写进设置文件。' }),
            h('div', { class: 'btn-group nd-gl-actions' }, mergeBtn, logoutBtn),
        ];
    } else {
        const tok = h('input', { class: 'input', type: 'password', autocomplete: 'off', placeholder: 'github_pat_… / ghp_…', 'data-field': 'tok', 'aria-label': 'GitHub 令牌' });
        const pw = h('input', { class: 'input', type: 'password', autocomplete: 'new-password', placeholder: '至少 8 位', 'data-field': 'pw', 'aria-label': '加密密码' });
        const repo = h('input', { class: 'input', type: 'text', autocomplete: 'off', placeholder: '用户名/仓库名（可空，自动识别）', 'data-field': 'repo', 'aria-label': '数据仓库' });
        const connectBtn = h('button', { class: 'btn btn-primary', type: 'button', 'data-act': 'connect' }, icon('ri-link'), '连接');
        connectBtn.addEventListener('click', () => connect({ tok, pw, repo, btn: connectBtn, statusEl }));
        [tok, pw, repo].forEach(inp => inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') connectBtn.click(); }));
        body = [
            h('div', { class: 'nd-gl-form' },
                h('label', { class: 'nd-gl-field' }, h('span', { class: 'form-label', text: 'GitHub 令牌' }), tok),
                h('label', { class: 'nd-gl-field' }, h('span', { class: 'form-label', text: '加密密码' }), pw),
                h('label', { class: 'nd-gl-field' }, h('span', { class: 'form-label', text: '数据仓库' }), repo)),
            h('p', { class: 'form-hint', text: '和画廊网站用同一个令牌和密码。连接后记住登录：仓库、令牌和密钥存在这个浏览器，密码不保存，也不写进设置文件。不连接也能用本机画廊，以后连上可以合并上去。' }),
            h('div', { class: 'btn-group nd-gl-actions' }, connectBtn,
                localCount ? h('span', { class: 'nd-gl-muted', text: `本机画廊 ${localCount} 张` }) : null),
        ];
    }
    slot.replaceChildren(h('div', { class: 'card nd-gl-auth' }, title, ...body, statusEl));
    if (flash) setStatus(statusEl, flash[0], flash[1]);
    else if (!creds && status.state === 'error' && status.message) setStatus(statusEl, 'error', status.message);
}

async function connect({ tok, pw, repo, btn, statusEl }) {
    const { credentials } = G.deps;
    const input = { tok: tok.value, pw: pw.value, repo: repo.value, fetch: G.deps.fetch };
    btn.disabled = true;
    setStatus(statusEl, 'loading', '连接中…（用密码算密钥要几秒）');
    try {
        let r, initialized = false;
        try {
            r = await credentials.connect(input);
        } catch (e) {
            if (e?.code !== 'nometa') throw e;
            const out = await initGalleryRepo({
                ...input,
                confirm: ({ message, detail }) => xbConfirm(message, { title: '初始化画廊数据仓库', detail, okLabel: '初始化', danger: true, icon: 'ri-lock-2-line' }),
            });
            initialized = out.initialized;
            r = await credentials.save(out);
        }
        pw.value = '';
        await renderAuth(['success', initialized ? `已初始化并连接 ${r.repo}` : `已连接 ${r.repo}`]);
        if (G.loadedOnce) void reloadBrowser();
        notifyLinkChange();
    } catch (e) {
        let msg = e?.message || '连接失败';
        if (e?.code === 'repo' && Array.isArray(e.list) && e.list.length) msg += `：${e.list.slice(0, 6).join('、')}${e.list.length > 6 ? '…' : ''}`;
        setStatus(statusEl, e?.code === 'cancel' ? '' : 'error', msg);
        btn.disabled = false;
    }
}

async function logout(statusEl) {
    const ok = await xbConfirm('断开后这个浏览器不再保存令牌和密钥，缩略图缓存会清空。本机画廊里的图不受影响，仓库里的数据也不会动。', {
        title: '断开画廊同步仓库', okLabel: '断开', danger: true, icon: 'ri-logout-box-r-line',
    });
    if (!ok) return;
    try {
        await G.deps.credentials.logout();
        await renderAuth(['success', '已断开']);
        if (G.loadedOnce) void reloadBrowser();
        notifyLinkChange();
    } catch (e) {
        setStatus(statusEl, 'error', e?.message || '断开失败');
    }
}

async function mergeLocal(statusEl, btn) {
    const { credentials, local } = G.deps;
    const creds = await credentials.load();
    if (!creds || !local) return;
    const count = liveCount((await local.readState()).state);
    const ok = await xbConfirm(`把本机画廊的 ${count} 张图合并到 ${creds.repo}？逐条合并，仓库里已有的记录不会被覆盖；每 30 张一次提交。`, {
        title: '合并本机画廊', okLabel: '合并', icon: 'ri-upload-cloud-2-line',
    });
    if (!ok) return;
    btn.disabled = true;
    setStatus(statusEl, 'loading', '合并中…');
    try {
        const r = await local.mergeToRemote(withFetch(creds), {
            onProgress: (i, n) => setStatus(statusEl, 'loading', `合并中…上传文件 ${i} / ${n}`),
        });
        await credentials.setStatus({ state: 'connected', lastSyncAt: Date.now() });
        await renderAuth(['success', r.pushed ? `合并完成：上传 ${r.uploaded.length} 张，提交 ${r.commits} 次` : '仓库已经是最新，没有需要合并的']);
        if (G.loadedOnce) void reloadBrowser({ keepPage: true });
    } catch (e) {
        setStatus(statusEl, 'error', e?.message || '合并失败');
        btn.disabled = false;
    }
}

function notifyLinkChange() {
    document.dispatchEvent(new CustomEvent('nd:gallery-link-change'));
}

// ── 画廊浏览（图片管理） ────────────────────────────────────────────────────

function buildBrowserSkeleton(slot) {
    const ui = G.ui;
    ui.sourcePill = h('span', { class: 'nd-gl-pill', text: '…' });
    ui.privacyBtn = h('button', { class: 'btn btn-icon', type: 'button', 'data-act': 'privacy' });
    ui.refreshBtn = h('button', { class: 'btn btn-icon', type: 'button', title: '刷新', 'aria-label': '刷新', 'data-act': 'refresh' }, icon('ri-refresh-line'));
    ui.note = h('div', { class: 'nd-gl-note', hidden: true });
    ui.search = h('input', { class: 'input nd-gl-search', type: 'search', placeholder: '搜索名称或提示词', 'aria-label': '搜索画廊' });
    ui.seg = h('div', { class: 'nd-gl-seg', role: 'tablist', 'aria-label': '筛选' },
        FILTERS.map(([value, label]) => h('button', { type: 'button', role: 'tab', 'data-filter': value, class: value === G.filter ? 'active' : '', text: label })));
    ui.batch = h('select', { class: 'input nd-gl-batch', 'aria-label': '批次' }, h('option', { value: '', text: '全部批次' }));
    ui.grid = h('div', { class: 'nd-gl-grid' });
    ui.empty = h('div', { class: 'nd-gl-empty', hidden: true });
    ui.pager = h('div', { class: 'nd-gl-pager', hidden: true });
    ui.listView = h('div', { class: 'nd-gl-list' },
        h('div', { class: 'nd-gl-tools' }, ui.search, ui.seg, ui.batch), ui.grid, ui.empty, ui.pager);
    ui.detailView = h('div', { class: 'nd-gl-detail', hidden: true });
    ui.status = h('div', { class: 'status-text nd-gl-status' });
    ui.card = h('div', { class: 'card nd-gl' },
        h('div', { class: 'nd-gl-head' },
            h('div', { class: 'card-title nd-gl-title' }, icon('ri-gallery-line'), '画廊', ui.sourcePill),
            h('span', { class: 'nd-gl-spacer' }), ui.privacyBtn, ui.refreshBtn),
        ui.note, ui.listView, ui.detailView, ui.status);
    slot.replaceChildren(ui.card);

    let searchTimer = 0;
    ui.search.addEventListener('input', () => {
        clearTimeout(searchTimer);
        searchTimer = setTimeout(() => { G.query = ui.search.value; G.page = 0; renderList(); }, 200);
    });
    ui.seg.addEventListener('click', (e) => {
        const b = e.target.closest('[data-filter]');
        if (!b) return;
        G.filter = b.dataset.filter;
        G.page = 0;
        ui.seg.querySelectorAll('[data-filter]').forEach(x => x.classList.toggle('active', x === b));
        renderList();
    });
    ui.batch.addEventListener('change', () => { G.batch = ui.batch.value; G.page = 0; renderList(); });
    ui.privacyBtn.addEventListener('click', () => {
        G.privacy = !G.privacy;
        writePrivacy(G.privacy);
        G.revealed.clear();
        renderPrivacyBtn();
        ui.card.querySelectorAll('.nd-gl-thumb.is-nsfw, .nd-gl-full.is-nsfw').forEach(n => n.classList.toggle('is-private', G.privacy));
    });
    ui.refreshBtn.addEventListener('click', () => reloadBrowser({ keepPage: true }));
    ui.grid.addEventListener('click', (e) => {
        const card = e.target.closest('.nd-gl-item');
        if (!card) return;
        const item = G.pageItems?.find(x => x.id === card.dataset.id);
        if (!item) return;
        const thumb = card.querySelector('.nd-gl-thumb');
        if (thumb.classList.contains('is-private')) {
            thumb.classList.remove('is-private');
            G.revealed.add(item.id);
            return;
        }
        openDetail(item);
    });
    ui.card.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && G.detail) { e.preventDefault(); closeDetail(); }
    });
    renderPrivacyBtn();
}

function renderPrivacyBtn() {
    const b = G.ui.privacyBtn;
    b.replaceChildren(icon(G.privacy ? 'ri-eye-off-line' : 'ri-eye-line'));
    b.title = G.privacy ? '隐私模式：开（nsfw 图模糊，点一下显示）' : '隐私模式：关';
    b.setAttribute('aria-label', b.title);
    b.setAttribute('aria-pressed', String(G.privacy));
    b.classList.toggle('is-on', G.privacy);
}

function revokeUrls() {
    for (const url of G.urls.values()) { try { URL.revokeObjectURL(url); } catch { } }
    G.urls.clear();
    if (G.fullUrl) { try { URL.revokeObjectURL(G.fullUrl); } catch { } G.fullUrl = ''; }
}

async function reloadBrowser({ keepPage = false } = {}) {
    if (!G.roots.browser) return;
    const token = ++G.loadToken;
    G.loadedOnce = true;
    const { credentials, local } = G.deps;
    const ui = G.ui;
    ui.refreshBtn.disabled = true;
    setStatus(ui.status, 'loading', '读取画廊…');
    G.queue?.dispose();
    G.io?.disconnect();
    revokeUrls();
    let src;
    let creds = null;
    try { creds = credentials ? await credentials.load() : null; } catch { creds = null; }
    if (creds) {
        const c = withFetch(creds);
        try {
            const r = await readState(c);
            src = { kind: 'remote', repo: creds.repo, state: r.state, readOnly: r.readOnly, error: '' };
        } catch (e) {
            src = { kind: 'remote', repo: creds.repo, state: null, readOnly: true, error: e?.message || '读不到画廊仓库' };
        }
        const cache = credentials.thumbCache();
        G.queue = createPausingThumbQueue(id => loadImage(c, id, 't', { cache }), {
            onPause: () => setStatus(ui.status, 'error', 'GitHub 限流了，30 秒后继续加载缩略图'),
        });
        G.loadFull = id => loadImage(c, id, 'f');
        src.localOnly = 0;
        try {
            if (local && src.state) {
                const ls = (await local.readState()).state;
                src.localOnly = listImages(ls, { limit: 1e9 }).items.filter(x => !src.state.imgs[x.id]).length;
            }
        } catch { }
    } else if (local) {
        const r = await local.readState().catch(e => ({ state: null, error: e }));
        src = { kind: 'local', state: r.state, readOnly: false, error: r.state ? '' : (r.error?.message || '读不到本机画廊') };
        G.queue = createPausingThumbQueue(id => local.loadImage(id, 't'));
        G.loadFull = id => local.loadImage(id, 'f');
    } else {
        src = { kind: 'local', state: null, readOnly: true, error: '这个浏览器没有 IndexedDB，画廊不可用' };
    }
    if (token !== G.loadToken) return;
    G.source = src;
    if (!keepPage) G.page = 0;
    ui.refreshBtn.disabled = false;
    setStatus(ui.status, src.error ? 'error' : '', src.error || '');
    renderSource();
    renderBatches();
    renderNote();
    if (G.detail) closeDetail(false);
    renderList();
}

function renderSource() {
    const src = G.source, pill = G.ui.sourcePill;
    pill.className = `nd-gl-pill${src.kind === 'remote' ? ' is-ok' : ''}`;
    pill.textContent = src.kind === 'remote' ? src.repo : '本机画廊';
    pill.title = src.kind === 'remote' ? '已连接同步仓库' : '没有连接同步仓库，显示的是这个浏览器里的本机画廊';
}

function renderBatches() {
    const sel = G.ui.batch, st = G.source?.state;
    const counts = new Map();
    if (st) for (const x of listImages(st, { limit: 1e9 }).items) {
        const b = String(x.meta.batch || '').trim();
        if (b) counts.set(b, (counts.get(b) || 0) + 1);
    }
    if (G.batch && !counts.has(G.batch)) G.batch = '';
    sel.replaceChildren(h('option', { value: '', text: '全部批次' }),
        ...[...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([b, n]) => h('option', { value: b, text: `${b}（${n}）` })));
    sel.value = G.batch;
    sel.disabled = counts.size === 0;
    window.NdSelect?.refresh?.(sel);
}

function renderNote() {
    const note = G.ui.note, src = G.source;
    const parts = [];
    if (G.pick) {
        parts.push(h('div', { class: 'nd-gl-note-row is-pick' }, icon('ri-cursor-line'),
            h('span', { text: '选一张图，打开后点「导入为参数预设」。' }),
            h('button', { class: 'btn btn-sm', type: 'button', onclick: () => setPickMode(false) }, '退出选择')));
    }
    if (src?.readOnly && !src.error) {
        parts.push(h('div', { class: 'nd-gl-note-row is-warn' }, icon('ri-lock-line'), h('span', { text: '画廊格式比小黑生图新，只能看不能存。' })));
    }
    if (src?.kind === 'remote' && src.localOnly > 0) {
        parts.push(h('div', { class: 'nd-gl-note-row' }, icon('ri-hard-drive-2-line'),
            h('span', { text: `本机画廊还有 ${src.localOnly} 张没合并到仓库。` }),
            h('button', { class: 'btn btn-sm', type: 'button', onclick: () => goToAuth() }, '去合并')));
    }
    if (src?.kind === 'local' && !src.error) {
        parts.push(h('div', { class: 'nd-gl-note-row' }, icon('ri-information-line'),
            h('span', { text: '没有连接同步仓库：存入画廊的图先放在这个浏览器里。' }),
            h('button', { class: 'btn btn-sm', type: 'button', onclick: () => goToAuth() }, '连接仓库')));
    }
    note.replaceChildren(...parts);
    note.hidden = parts.length === 0;
}

function goToAuth() {
    if (typeof window.switchView === 'function') window.switchView('api');
    setTimeout(() => G.roots.auth?.scrollIntoView({ block: 'start', behavior: 'smooth' }), 60);
}

function isNsfw(meta, prompt) {
    return NSFW_RE.test(String(prompt ?? meta?.prompt ?? ''));
}

function currentPage() {
    const st = G.source?.state;
    if (!st) return { items: [], total: 0 };
    let view = st;
    if (G.batch) view = { ...st, imgs: Object.fromEntries(Object.entries(st.imgs || {}).filter(([, r]) => r && r.meta && r.meta.batch === G.batch)) };
    const model = G.filter === 'V4.5' || G.filter === 'V5' ? G.filter : '';
    const r = listImages(view, { offset: G.page * PAGE_SIZE, limit: PAGE_SIZE, query: G.query, favOnly: G.filter === 'fav', model });
    if (!r.items.length && r.total && G.page > 0) { G.page = Math.max(0, Math.ceil(r.total / PAGE_SIZE) - 1); return currentPage(); }
    return r;
}

function renderList() {
    const ui = G.ui, src = G.source;
    if (!src) return;
    G.queue?.clearWaiting();
    G.io?.disconnect();
    const { items, total } = currentPage();
    G.pageItems = items;
    const hasFilter = !!(G.query || G.batch || G.filter !== 'all');
    ui.grid.replaceChildren(...items.map(renderItem));
    ui.empty.hidden = items.length > 0 || !!src.error;
    ui.empty.replaceChildren(icon('ri-image-2-line'), h('div', {
        text: hasFilter ? '没有符合条件的图' : src.kind === 'remote' ? '仓库里还没有图' : '本机画廊还没有图',
    }), hasFilter ? null : h('p', { text: '长按聊天图片或灯箱里的图片选「同步到 Gallery」，或在下面按角色批量存入。' }));
    const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
    ui.pager.hidden = total <= PAGE_SIZE;
    ui.pager.replaceChildren(
        h('button', { class: 'btn btn-sm btn-icon', type: 'button', title: '上一页', 'aria-label': '上一页', disabled: G.page <= 0, onclick: () => { G.page--; renderList(); ui.card.scrollIntoView({ block: 'start' }); } }, icon('ri-arrow-left-s-line')),
        h('span', { class: 'nd-gl-muted', text: `第 ${G.page + 1} / ${pages} 页 · 共 ${total} 张` }),
        h('button', { class: 'btn btn-sm btn-icon', type: 'button', title: '下一页', 'aria-label': '下一页', disabled: G.page >= pages - 1, onclick: () => { G.page++; renderList(); ui.card.scrollIntoView({ block: 'start' }); } }, icon('ri-arrow-right-s-line')));
    observeThumbs();
}

function renderItem(item) {
    const meta = item.meta || {};
    const nsfw = isNsfw(meta);
    const hasImage = G.source.kind === 'local' ? !meta.noimg : item.hasBlob;
    const img = h('img', { alt: '', loading: 'lazy', decoding: 'async', hidden: true, draggable: 'false' });
    const ph = h('span', { class: 'nd-gl-ph' }, icon(hasImage ? 'ri-image-line' : 'ri-file-text-line'));
    const thumb = h('div', { class: `nd-gl-thumb${nsfw ? ' is-nsfw' : ''}${nsfw && G.privacy && !G.revealed.has(item.id) ? ' is-private' : ''}` }, img, ph,
        nsfw ? h('span', { class: 'nd-gl-veil' }, icon('ri-eye-off-line'), '点一下显示') : null);
    const badge = G.source.kind === 'remote'
        ? h('span', { class: 'nd-gl-badge is-synced', title: '在同步仓库里' }, icon('ri-cloud-line'), '已同步')
        : h('span', { class: 'nd-gl-badge', title: '只在这个浏览器里' }, icon('ri-hard-drive-2-line'), '本机');
    const card = h('button', { class: 'nd-gl-item', type: 'button', dataset: { id: item.id, hasImage: hasImage ? '1' : '' }, title: meta.name || '' },
        thumb,
        h('span', { class: 'nd-gl-cap' },
            h('span', { class: 'nd-gl-name', text: meta.name || meta.file || item.id.slice(0, 8) }),
            item.fav ? h('span', { class: 'nd-gl-fav', title: '收藏' }, icon('ri-star-fill')) : null,
            badge));
    if (G.urls.has(item.id)) { img.src = G.urls.get(item.id); img.hidden = false; ph.hidden = true; }
    return card;
}

function observeThumbs() {
    const cards = [...G.ui.grid.querySelectorAll('.nd-gl-item[data-has-image="1"]')].filter(c => !G.urls.has(c.dataset.id));
    if (!cards.length) return;
    if (typeof IntersectionObserver !== 'function') { cards.forEach(loadThumb); return; }
    const io = new IntersectionObserver((entries) => {
        for (const e of entries) if (e.isIntersecting) { io.unobserve(e.target); loadThumb(e.target); }
    }, { rootMargin: '240px' });
    G.io = io;
    cards.forEach(c => io.observe(c));
    // 兜底：有些 WebView / 后台标签页里 IntersectionObserver 回调不来，已经在视口里的卡片直接加载
    setTimeout(() => {
        if (G.io !== io) return;
        const vh = window.innerHeight || document.documentElement.clientHeight;
        for (const c of cards) {
            if (!c.isConnected || c.dataset.loading) continue;
            const r = c.getBoundingClientRect();
            if (r.bottom > -240 && r.top < vh + 240) { io.unobserve(c); loadThumb(c); }
        }
    }, 250);
}

function loadThumb(card) {
    if (card.dataset.loading) return;
    card.dataset.loading = '1';
    const id = card.dataset.id;
    const queue = G.queue, token = G.loadToken;
    const img = card.querySelector('img'), ph = card.querySelector('.nd-gl-ph');
    queue.get(id).then((u8) => {
        if (token !== G.loadToken) return;
        if (!u8) { ph.replaceChildren(icon('ri-image-line')); ph.title = '仓库里没有这张图的文件'; return; }
        let url = G.urls.get(id);
        if (!url) { url = URL.createObjectURL(new Blob([u8], { type: 'image/webp' })); G.urls.set(id, url); }
        img.src = url;
        img.hidden = false;
        ph.hidden = true;
    }).catch((e) => {
        if (e?.code === 'cancel' || token !== G.loadToken) {
            delete card.dataset.loading;   // 被取消的卡片还能重新加载
            if (card.isConnected && G.io) G.io.observe(card);
            return;
        }
        ph.replaceChildren(icon('ri-error-warning-line'));
        ph.title = e?.message || '缩略图加载失败';
    });
}

// ── 详情 ─────────────────────────────────────────────────────────────────

function paramRows(meta) {
    const nai = meta.nai && typeof meta.nai === 'object' ? meta.nai : {};
    const rows = [
        ['模型', meta.model],
        ['尺寸', meta.w && meta.h ? `${meta.w} × ${meta.h}` : ''],
        ['步数', meta.steps],
        ['CFG', meta.scale],
        ['采样器', meta.sampler],
        ['种子', meta.seed],
        ['噪声调度', nai.noise_schedule],
        ['CFG Rescale', nai.cfg_rescale],
        ['SMEA', nai.sm === undefined ? '' : `${nai.sm ? '开' : '关'}${nai.sm_dyn ? ' + DYN' : ''}`],
        ['批次', meta.batch],
        ['时间', meta.at ? new Date(meta.at).toLocaleString() : ''],
        ['文件', meta.file],
    ];
    return rows.filter(([, v]) => v !== undefined && v !== null && v !== '');
}

function openDetail(item) {
    const ui = G.ui, src = G.source;
    G.detail = item;
    const meta = item.meta || {};
    const vars = src.state?.vars?.[item.id];
    const list = vars && Array.isArray(vars.list) ? vars.list : [];
    let varIndex = vars && Number.isInteger(vars.active) && list[vars.active] ? vars.active : -1;

    const promptBox = h('div', { class: 'nd-gl-pre' });
    const ucBox = h('div', { class: 'nd-gl-pre is-uc' });
    const full = h('div', { class: 'nd-gl-full' }, h('span', { class: 'nd-gl-ph' }, icon('ri-loader-4-line ri-spin')));
    const renderPrompt = () => {
        const v = pickVariant(meta, vars, varIndex);
        promptBox.textContent = v.prompt || '（空）';
        ucBox.textContent = v.uc || '（空）';
        const nsfw = isNsfw(meta, v.prompt) || isNsfw(meta);
        full.classList.toggle('is-nsfw', nsfw);
        full.classList.toggle('is-private', nsfw && G.privacy && !G.revealed.has(item.id));
    };

    let variantRow = null;
    if (list.length) {
        const sel = h('select', { class: 'input', 'aria-label': '提示词分支' },
            h('option', { value: '-1', text: '原图提示词' }),
            ...list.map((x, i) => h('option', { value: String(i), text: `${x.name || `分支 ${i + 1}`}${i === vars.active ? '（当前）' : ''}` })));
        sel.value = String(varIndex);
        sel.addEventListener('change', () => { varIndex = Number(sel.value); renderPrompt(); });
        variantRow = h('div', { class: 'nd-gl-row' }, h('span', { class: 'form-label', text: '提示词分支' }), sel);
    }

    const chars = Array.isArray(meta.nai?.chars) ? meta.nai.chars : [];
    const charBlock = chars.length ? h('div', { class: 'nd-gl-chars' },
        h('div', { class: 'form-label', text: `角色提示词（${chars.length}）` }),
        ...chars.map((c, i) => h('div', { class: 'nd-gl-char' },
            h('div', { class: 'nd-gl-char-head' },
                h('span', { class: 'nd-gl-muted', text: `角色 ${i + 1}` }),
                h('span', { class: 'nd-gl-spacer' }),
                h('button', { class: 'btn btn-sm', type: 'button', onclick: async () => setStatus(ui.status, 'success', (await copyText(String(c?.prompt || ''))) ? '已复制角色提示词' : '复制失败，请手动选择文字') }, icon('ri-file-copy-line'), '复制'),
                h('button', { class: 'btn btn-sm', type: 'button', onclick: () => saveCharacterTag(c) }, icon('ri-user-add-line'), '存为角色标签')),
            h('div', { class: 'nd-gl-pre', text: c?.prompt || '（空）' }),
            c?.uc ? h('div', { class: 'nd-gl-pre is-uc', text: c.uc }) : null))) : null;

    const importBtn = h('button', { class: 'btn btn-primary', type: 'button', 'data-act': 'import' }, icon('ri-download-2-line'), '导入为参数预设');
    importBtn.addEventListener('click', () => importPreset(item, vars, varIndex));
    const backBtn = h('button', { class: 'btn btn-sm', type: 'button', 'data-act': 'back' }, icon('ri-arrow-left-line'), '返回');
    backBtn.addEventListener('click', () => closeDetail());
    full.addEventListener('click', () => {
        if (full.classList.contains('is-private')) { full.classList.remove('is-private'); G.revealed.add(item.id); }
    });

    ui.detailView.replaceChildren(
        h('div', { class: 'nd-gl-detail-bar' }, backBtn,
            h('span', { class: 'nd-gl-name', text: meta.name || item.id.slice(0, 8) }),
            src.kind === 'remote' ? h('span', { class: 'nd-gl-badge is-synced' }, icon('ri-cloud-line'), '已同步') : h('span', { class: 'nd-gl-badge' }, icon('ri-hard-drive-2-line'), '本机')),
        h('div', { class: 'nd-gl-detail-body' },
            full,
            h('div', { class: 'nd-gl-info' },
                variantRow,
                h('div', { class: 'form-label', text: '正向提示词' }), promptBox,
                h('div', { class: 'form-label', text: '负向提示词' }), ucBox,
                h('div', { class: 'nd-gl-kv' }, ...paramRows(meta).flatMap(([k, v]) => [h('span', { text: k }), h('span', { text: fmtValue(v) })])),
                charBlock,
                h('div', { class: 'btn-group nd-gl-actions' }, importBtn))));
    renderPrompt();
    ui.listView.hidden = true;
    ui.detailView.hidden = false;
    ui.card.scrollIntoView({ block: 'start' });
    backBtn.focus({ preventScroll: true });

    const token = G.loadToken;
    const hasImage = src.kind === 'local' ? !meta.noimg : item.hasBlob;
    if (!hasImage) { full.replaceChildren(h('span', { class: 'nd-gl-ph' }, icon('ri-file-text-line'), '没有图片文件')); return; }
    Promise.resolve().then(() => G.loadFull(item.id)).then((u8) => {
        if (token !== G.loadToken || G.detail !== item) return;
        if (!u8) { full.replaceChildren(h('span', { class: 'nd-gl-ph' }, icon('ri-image-line'), '仓库里没有大图文件')); return; }
        if (G.fullUrl) URL.revokeObjectURL(G.fullUrl);
        G.fullUrl = URL.createObjectURL(new Blob([u8], { type: 'image/webp' }));
        full.replaceChildren(h('img', { src: G.fullUrl, alt: meta.name || '', draggable: 'false' }),
            h('span', { class: 'nd-gl-veil' }, icon('ri-eye-off-line'), '点一下显示'));
    }).catch((e) => {
        if (G.detail !== item) return;
        full.replaceChildren(h('span', { class: 'nd-gl-ph' }, icon('ri-error-warning-line'), e?.message || '大图加载失败'));
    });
}

function closeDetail(render = true) {
    const ui = G.ui;
    G.detail = null;
    if (G.fullUrl) { try { URL.revokeObjectURL(G.fullUrl); } catch { } G.fullUrl = ''; }
    ui.detailView.hidden = true;
    ui.detailView.replaceChildren();
    ui.listView.hidden = false;
    if (render) {
        // 隐私状态可能在详情里改过
        ui.grid.querySelectorAll('.nd-gl-item').forEach((card) => {
            if (G.revealed.has(card.dataset.id)) card.querySelector('.nd-gl-thumb')?.classList.remove('is-private');
        });
    }
}

// ── 导入为参数预设 / 存为角色标签 ──────────────────────────────────────────

function importDialogBody(msg, record) {
    const seed = Number(record.meta?.seed);
    const hasSeed = Number.isInteger(seed) && seed >= 0;
    const check = h('input', { type: 'checkbox', disabled: !hasSeed });
    const kids = [
        h('label', { class: 'xb-dlg-check' }, check, hasSeed ? `固定种子（${seed}）` : '固定种子（这张图没有种子）'),
    ];
    if (msg.notes.length) {
        kids.push(h('div', { class: 'xb-dlg-detail', text: msg.notes.map(n => `· ${n}`).join('\n') }));
    }
    if (msg.unsupported.length) {
        kids.push(h('div', { class: 'xb-dlg-detail', text: `没有导入的 NAI 参数（${msg.unsupported.length}）：` }));
        kids.push(h('div', { class: 'xb-dlg-kv' }, ...msg.unsupported.flatMap(u => [
            h('span', { text: u.key }),
            h('span', { text: `${fmtValue(u.value)} · ${u.reason}` }),
        ])));
    }
    if (msg.characters.length) {
        kids.push(h('div', { class: 'xb-dlg-detail', text: `角色提示词 ${msg.characters.length} 个不进预设，可以在详情里「存为角色标签」。` }));
    }
    const body = h('div', { class: 'nd-gl-import-body' }, ...kids);
    return { body, check };
}

// 导入为参数预设：先在导入弹框里起名（预填 批次/前几个 tag + 短 id，全选，Enter 确认，Esc 取消，空名字就地提示）
// → 同来源查重（覆盖 / 另存 / 取消）→ 同名查重（覆盖 / 自动改名 / 返回修改）→ 发给宿主，消息带 name。
async function importPreset(item, vars, varIndex) {
    const ui = G.ui;
    const record = { id: item.id, meta: item.meta };
    const presets = frameState().paramsPresets || [];
    let msg;
    try { msg = buildImportGalleryPresetMessage(record, { vars, varIndex, presets }); }
    catch (e) { setStatus(ui.status, 'error', e?.message || '这条记录没法导入'); return; }
    const { body, check } = importDialogBody(msg, record);
    const nameDialogs = createPresetNameDialogs({ xbPrompt, xbChoose });
    let nameValue = defaultGalleryPresetName(record, msg.preset);
    let sourceChoice = null;
    for (let round = 0; round < 50; round++) {
        const raw = await openXbDialog({
            title: '导入为参数预设', icon: 'ri-download-2-line',
            message: `模型 ${msg.preset.params.model}。预设名称：`,
            body, cancelValue: false,
            input: { value: nameValue, placeholder: '预设名称', maxLength: PRESET_NAME_MAX, validate: v => validatePresetName(v).error },
            buttons: [{ value: false, label: '取消' }, { value: true, label: '导入', kind: 'primary' }],
        });
        if (raw === false || raw == null) return;
        const { name } = validatePresetName(raw);
        nameValue = name;
        msg = buildImportGalleryPresetMessage(record, { vars, varIndex, presets, keepSeed: check.checked });
        if (msg.duplicateOf && !sourceChoice) {
            sourceChoice = await askDuplicate(msg.duplicateOf);
            if (sourceChoice === 'cancel') return;
        }
        if (sourceChoice) msg.onDuplicate = sourceChoice;
        const overwritingSource = sourceChoice === 'overwrite' ? msg.duplicateOf : null;
        const resolved = await resolvePresetNameConflict(presets, name, { excludeId: overwritingSource, allowOverwrite: !overwritingSource, choose: nameDialogs.choose });
        if (resolved === 'back') continue;
        msg.name = resolved.name;
        if (resolved.onNameConflict) msg.onNameConflict = resolved.onNameConflict;
        sendImport(msg);
        return;
    }
}

// 宿主那边查出同名（iframe 里的预设列表过期了）：同样三选一；返回修改 = 改名后重发。
async function resolveHostNameConflict(data) {
    const last = G.lastImport;
    if (!last) return;
    const presets = frameState().paramsPresets || [];
    const conflict = presets.find(p => p.id === data.nameConflictOf) || { id: data.nameConflictOf, name: data.name };
    const overwritingSource = last.onDuplicate === 'overwrite' ? last.duplicateOf : null;
    const dialogs = createPresetNameDialogs({ xbPrompt, xbChoose });
    const choice = await dialogs.choose({ name: data.name, conflict, renamed: uniquePresetName([...presets, conflict], data.name, { excludeId: overwritingSource }), allowOverwrite: !overwritingSource });
    if (choice === 'overwrite' && !overwritingSource) { sendImport({ ...last, name: data.name, onNameConflict: 'overwrite' }); return; }
    if (choice === 'rename') { sendImport({ ...last, name: data.name, onNameConflict: 'rename' }); return; }
    const picked = await askPresetName({ presets: [...presets, conflict], defaultName: data.name, title: '导入为参数预设', excludeId: overwritingSource, allowOverwrite: !overwritingSource, ...dialogs });
    if (!picked) { setStatus(G.ui.status, '', '已取消导入'); G.lastImport = null; return; }
    const next = { ...last, name: picked.name };
    delete next.onNameConflict;
    if (picked.onNameConflict) next.onNameConflict = picked.onNameConflict;
    sendImport(next);
}

async function askDuplicate(duplicateOf) {
    const existing = (frameState().paramsPresets || []).find(p => p.id === duplicateOf);
    return xbChoose(`已经从这张图（同一个提示词分支）导入过预设${existing ? `「${existing.name}」` : ''}。`, [
        { value: 'cancel', label: '取消' },
        { value: 'copy', label: '另存一份' },
        { value: 'overwrite', label: '覆盖', kind: 'primary' },
    ], { title: '已有同来源的预设', cancelValue: 'cancel', icon: 'ri-file-copy-2-line' });
}

function sendImport(msg) {
    G.lastImport = msg;
    setStatus(G.ui.status, 'loading', '导入中…');
    post(msg);
}

async function saveCharacterTag(c) {
    const prompt = String(c?.prompt || '').trim();
    if (!prompt) { setStatus(G.ui.status, 'error', '这个角色提示词是空的'); return; }
    const guess = prompt.split(',').map(s => s.trim()).filter(s => s && !/^\d*\s*(girl|boy|woman|man|other)s?$/i.test(s))[0] || '';
    const name = await xbPrompt('角色名称（存到「角色标签」，外观 = 这段提示词，负面 = 角色 UC）：', guess.slice(0, 40), { title: '存为角色标签', placeholder: '角色名称' });
    if (name == null) return;
    if (!name.trim()) { setStatus(G.ui.status, 'error', '请输入角色名称'); return; }
    setStatus(G.ui.status, 'loading', '保存角色标签…');
    post({ type: 'SAVE_GALLERY_CHARACTER_TAG', name: name.trim(), prompt, uc: String(c?.uc || '') });
}

// ── 预设栏「从画廊导入」 ────────────────────────────────────────────────────

function setPickMode(on) {
    G.pick = !!on;
    if (G.ui.note) renderNote();
}

function mountPresetImport(slot) {
    if (!slot) return;
    G.roots.importSlot = slot;
    const btn = h('button', { id: 'nd_params_gallery_import', class: 'btn btn-icon', type: 'button', title: '从画廊导入', 'aria-label': '从画廊导入' }, icon('ri-image-add-line'));
    btn.addEventListener('click', () => {
        setPickMode(true);
        if (typeof window.switchView === 'function') window.switchView('gallery');
        if (!G.loadedOnce) void reloadBrowser();
        if (G.detail) closeDetail();
        setTimeout(() => G.ui.card?.scrollIntoView({ block: 'start' }), 60);
    });
    slot.replaceChildren(btn);
}

// ── 宿主回执 ────────────────────────────────────────────────────────────────

function onHostMessage(event) {
    if (event.origin !== PARENT_ORIGIN || event.source !== window.parent) return;
    const data = event.data;
    if (!data || data.source !== HOST_SOURCE) return;
    const status = G.ui.status;
    switch (data.type) {
        case 'GALLERY_PRESET_IMPORTED':
            if (data.ok === false) { setStatus(status, 'error', data.error || '导入失败'); break; }
            setStatus(status, 'success', `${data.status === 'overwritten' ? '已覆盖' : '已导入'}参数预设「${data.name || ''}」，已切到这个预设`);
            G.lastImport = null;
            if (G.pick) {
                setPickMode(false);
                if (typeof window.switchView === 'function') window.switchView('params');
            }
            break;
        case 'GALLERY_PRESET_NAME_CONFLICT':
            setStatus(status, '', '名称重复，等你决定');
            void resolveHostNameConflict(data);
            break;
        case 'GALLERY_PRESET_DUPLICATE':
            if (!G.lastImport) break;
            void askDuplicate(data.duplicateOf).then((choice) => {
                if (choice === 'cancel') { setStatus(status, '', '已取消导入'); G.lastImport = null; return; }
                sendImport({ ...G.lastImport, duplicateOf: data.duplicateOf, onDuplicate: choice });
            });
            break;
        case 'GALLERY_CHARACTER_TAG_SAVED':
            setStatus(status, data.ok === false ? 'error' : 'success', data.ok === false ? (data.error || '保存失败') : `已存为角色标签「${data.name || ''}」`);
            break;
        case 'GALLERY_BATCH_DONE':
            if (G.loadedOnce) void reloadBrowser({ keepPage: true });
            void renderAuth();
            break;
        default:
    }
}

// ── 挂载 ────────────────────────────────────────────────────────────────────

function mountGalleryBrowser(slot) {
    if (!slot) return;
    G.roots.browser = slot;
    buildBrowserSkeleton(slot);
    const view = document.getElementById('view-gallery');
    const visible = () => !view || view.classList.contains('active');
    if (visible()) void reloadBrowser();
    else if (view && typeof MutationObserver === 'function') {
        const mo = new MutationObserver(() => { if (visible() && !G.loadedOnce) void reloadBrowser(); });
        mo.observe(view, { attributes: true, attributeFilter: ['class'] });
    }
}

let listening = false;
function mountAll(deps) {
    G.deps = { ...defaultDeps(), ...(deps || {}) };
    G.privacy = readPrivacy();
    mountGalleryAuth(document.getElementById('nd-gallery-auth-slot'));
    mountGalleryBrowser(document.getElementById('nd-gallery-link-slot'));
    mountPresetImport(document.getElementById('nd-preset-import-slot'));
    if (!listening) {
        listening = true;
        window.addEventListener('message', onHostMessage);
        document.addEventListener('nd:gallery-link-change', () => { if (G.loadedOnce) void reloadBrowser(); });
    }
}

function mountGalleryAuth(slot) {
    if (!slot) return;
    G.roots.auth = slot;
    void renderAuth();
}

/**
 * 测试 / harness：换依赖重新挂载。
 * deps.memory = true：在本页面的 realm 里建内存版凭据库和本机画廊（不碰 IndexedDB）；deps.fetch：假 GitHub；deps.post：假宿主。
 */
function remount(deps = {}) {
    G.loadToken++;
    G.queue?.dispose();
    G.io?.disconnect();
    revokeUrls();
    G.source = null; G.detail = null; G.pick = false; G.loadedOnce = false; G.page = 0; G.query = ''; G.filter = 'all'; G.batch = ''; G.revealed.clear();
    G.ui = {};
    const { memory, ...rest } = deps;
    const stores = memory
        ? { credentials: createCredentialStore({ kv: createMemoryKv(), thumbKv: createMemoryKv() }), local: createLocalGallery({ kv: createMemoryKv() }) }
        : {};
    mountAll({ ...G.deps, ...stores, ...rest });
}

if (typeof document !== 'undefined' && document.getElementById('nd-gallery-link-slot')) {
    mountAll();
}

if (typeof window !== 'undefined') {
    window.NDGallery = Object.freeze({
        remount,
        reload: opts => reloadBrowser(opts),
        renderAuth: () => renderAuth(),
        setPickMode,
        /** 当前用的凭据库和本机画廊（harness 的假宿主用它当批量存入的目标） */
        get stores() { return { credentials: G.deps?.credentials || null, local: G.deps?.local || null }; },
        get state() { return { source: G.source, page: G.page, filter: G.filter, batch: G.batch, query: G.query, privacy: G.privacy, pick: G.pick, detail: G.detail?.id || null }; },
    });
}

export { mountGalleryAuth, mountGalleryBrowser, mountPresetImport, remount };
