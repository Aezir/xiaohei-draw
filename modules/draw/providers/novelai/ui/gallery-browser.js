// 设置页 iframe 里的画廊连接和「导入为参数预设」（和酒馆主页面同源，直接读写 IndexedDB，密钥不走 postMessage）。
//   #nd-gallery-auth-slot  （API 配置）画廊同步仓库：令牌 + 密码 + 仓库（可空，自动识别）→ 连接；记住登录；断开；
//                          仓库没初始化时明确确认后由小黑生图初始化；连上后可把本机画廊合并上去。
//   #nd-preset-import-slot （绘图参数预设栏）「从画廊导入」→ 跳到图片管理页的画廊，提示在图片详情里点「加入绘图参数预设」。
//   window.NDGallery.importRecord(record, {vars, varIndex})：嵌入的完整画廊（ui/gallery-web-launcher.js 转过来）
//                          点「加入绘图参数预设」后走这里：起名 → 同来源查重 → 同名查重 → 发 IMPORT_GALLERY_PRESET。
// 2026-09-14：原来图片管理页里的精简画廊浏览网格（#nd-gallery-link-slot）撤掉了，由嵌入的完整画廊代替。
// 状态提示不再有自己的位置，发 document 事件 nd:gallery-import-status {state, text}，由画廊区域显示。
// 宿主消息：IMPORT_GALLERY_PRESET → GALLERY_PRESET_IMPORTED / GALLERY_PRESET_DUPLICATE / GALLERY_PRESET_NAME_CONFLICT；
//          GALLERY_BATCH_DONE → 刷新连接块，并发 nd:gallery-batch-done（嵌入的画廊同步一次）。
import { createCredentialStore } from '../../../shared/gallery-sync/credential-store.js';
import { createLocalGallery } from '../../../shared/gallery-sync/local-store.js';
import { listImages } from '../../../shared/gallery-sync/gallery-client.js';
import { initGalleryRepo } from '../../../shared/gallery-sync/repo-init.js';
import { buildImportGalleryPresetMessage } from '../../../shared/gallery-sync/gallery-actions.js';
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

const G = {
    deps: null,
    roots: { auth: null, importSlot: null },
    pick: false,
    importing: false,
    lastImport: null,
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

// 不用设置页的 updateStatus：它会整个覆盖 className，冲掉 nd-gl-status（空时隐藏靠它）
function setStatus(el, state, text) {
    if (!el) return;
    el.textContent = text || '';
    el.className = `status-text nd-gl-status${state ? ` ${state}` : ''}`;
}

/** 导入流程的状态提示：交给画廊区域（gallery-web-launcher.js）显示 */
function report(state, text) {
    document.dispatchEvent(new CustomEvent('nd:gallery-import-status', { detail: { state: state || '', text: text || '' } }));
}

function post(payload) {
    if (G.deps?.post) return G.deps.post(payload);
    if (typeof window.postToParent === 'function') return window.postToParent(payload);
    if (window.parent && window.parent !== window) window.parent.postMessage({ source: FRAME_SOURCE, ...payload }, PARENT_ORIGIN);
}

const frameState = () => (G.deps?.getState ? G.deps.getState() : (typeof window.ndGetState === 'function' ? window.ndGetState() : null)) || {};
const withFetch = creds => (G.deps?.fetch ? { ...creds, fetch: G.deps.fetch } : creds);

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
            h('p', { class: 'form-hint', text: '已记住登录：仓库、令牌和由密码算出的密钥存在这个浏览器（IndexedDB），密码没有保存，也不写进设置文件。图片管理页的画廊直接用这份连接。' }),
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
        notifyLinkChange();
    } catch (e) {
        let msg = e?.message || '连接失败';
        if (e?.code === 'repo' && Array.isArray(e.list) && e.list.length) msg += `：${e.list.slice(0, 6).join('、')}${e.list.length > 6 ? '…' : ''}`;
        setStatus(statusEl, e?.code === 'cancel' ? '' : 'error', msg);
        btn.disabled = false;
    }
}

async function logout(statusEl) {
    const ok = await xbConfirm('断开后这个浏览器不再保存令牌和密钥，缩略图缓存会清空。本机画廊里的图不受影响，仓库里的数据也不会动。图片管理页的画廊也会跟着断开。', {
        title: '断开画廊同步仓库', okLabel: '断开', danger: true, icon: 'ri-logout-box-r-line',
    });
    if (!ok) return;
    try {
        await G.deps.credentials.logout();
        await renderAuth(['success', '已断开']);
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
        if (r.pushed) document.dispatchEvent(new CustomEvent('nd:gallery-batch-done'));
    } catch (e) {
        setStatus(statusEl, 'error', e?.message || '合并失败');
        btn.disabled = false;
    }
}

function notifyLinkChange() {
    document.dispatchEvent(new CustomEvent('nd:gallery-link-change'));
}

// ── 导入为参数预设 ─────────────────────────────────────────────────────────

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
        kids.push(h('div', { class: 'xb-dlg-detail', text: `角色提示词 ${msg.characters.length} 个不进预设。` }));
    }
    const body = h('div', { class: 'nd-gl-import-body' }, ...kids);
    return { body, check };
}

// 导入为参数预设：先在导入弹框里起名（预填 批次/前几个 tag + 短 id，全选，Enter 确认，Esc 取消，空名字就地提示）
// → 同来源查重（覆盖 / 另存 / 取消）→ 同名查重（覆盖 / 自动改名 / 返回修改）→ 发给宿主，消息带 name。
async function importPreset(item, vars, varIndex) {
    const record = { id: item.id, meta: item.meta };
    const presets = frameState().paramsPresets || [];
    let msg;
    try { msg = buildImportGalleryPresetMessage(record, { vars, varIndex, presets }); }
    catch (e) { report('error', e?.message || '这条记录没法导入'); return; }
    const { body, check } = importDialogBody(msg, record);
    const nameDialogs = createPresetNameDialogs({ xbPrompt, xbChoose });
    let nameValue = defaultGalleryPresetName(record, msg.preset);
    let sourceChoice = null;
    for (let round = 0; round < 50; round++) {
        const raw = await openXbDialog({
            title: '加入绘图参数预设', icon: 'ri-download-2-line',
            message: `模型 ${msg.preset.params.model}。预设名称：`,
            body, cancelValue: false,
            input: { value: nameValue, placeholder: '预设名称', maxLength: PRESET_NAME_MAX, validate: v => validatePresetName(v).error },
            buttons: [{ value: false, label: '取消' }, { value: true, label: '加入', kind: 'primary' }],
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

/** 嵌入的完整画廊发来的「加入绘图参数预设」。弹框开着时再点忽略。 */
async function importRecord(record, { vars = null, varIndex = -1 } = {}) {
    if (G.importing) return;
    G.importing = true;
    try { await importPreset({ id: record?.id, meta: record?.meta }, vars, varIndex); }
    finally { G.importing = false; }
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
    const picked = await askPresetName({ presets: [...presets, conflict], defaultName: data.name, title: '加入绘图参数预设', excludeId: overwritingSource, allowOverwrite: !overwritingSource, ...dialogs });
    if (!picked) { report('', '已取消导入'); G.lastImport = null; return; }
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
    report('loading', '导入中…');
    post(msg);
}

// ── 预设栏「从画廊导入」 ────────────────────────────────────────────────────

function setPickMode(on) {
    G.pick = !!on;
}

function mountPresetImport(slot) {
    if (!slot) return;
    G.roots.importSlot = slot;
    const btn = h('button', { id: 'nd_params_gallery_import', class: 'btn btn-icon', type: 'button', title: '从画廊导入', 'aria-label': '从画廊导入' }, icon('ri-image-add-line'));
    btn.addEventListener('click', () => {
        setPickMode(true);
        if (typeof window.switchView === 'function') window.switchView('gallery');
        report('', '在下面的画廊里点开一张图，再点「加入绘图参数预设」。');
        setTimeout(() => document.getElementById('nd-gallery-web-slot')?.scrollIntoView({ block: 'start' }), 60);
    });
    slot.replaceChildren(btn);
}

// ── 宿主回执 ────────────────────────────────────────────────────────────────

function onHostMessage(event) {
    if (event.origin !== PARENT_ORIGIN || event.source !== window.parent) return;
    const data = event.data;
    if (!data || data.source !== HOST_SOURCE) return;
    switch (data.type) {
        case 'GALLERY_PRESET_IMPORTED':
            if (data.ok === false) { report('error', data.error || '导入失败'); break; }
            report('success', `${data.status === 'overwritten' ? '已覆盖' : '已加入'}绘图参数预设「${data.name || ''}」，已切到这个预设`);
            G.lastImport = null;
            if (G.pick) {
                setPickMode(false);
                if (typeof window.switchView === 'function') window.switchView('params');
            }
            break;
        case 'GALLERY_PRESET_NAME_CONFLICT':
            report('', '名称重复，等你决定');
            void resolveHostNameConflict(data);
            break;
        case 'GALLERY_PRESET_DUPLICATE':
            if (!G.lastImport) break;
            void askDuplicate(data.duplicateOf).then((choice) => {
                if (choice === 'cancel') { report('', '已取消导入'); G.lastImport = null; return; }
                sendImport({ ...G.lastImport, duplicateOf: data.duplicateOf, onDuplicate: choice });
            });
            break;
        case 'GALLERY_BATCH_DONE':
            void renderAuth();
            document.dispatchEvent(new CustomEvent('nd:gallery-batch-done'));
            break;
        default:
    }
}

// ── 挂载 ────────────────────────────────────────────────────────────────────

let listening = false;
function mountAll(deps) {
    G.deps = { ...defaultDeps(), ...(deps || {}) };
    mountGalleryAuth(document.getElementById('nd-gallery-auth-slot'));
    mountPresetImport(document.getElementById('nd-preset-import-slot'));
    if (!listening) {
        listening = true;
        window.addEventListener('message', onHostMessage);
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
    G.pick = false; G.importing = false; G.lastImport = null;
    const { memory, ...rest } = deps;
    const stores = memory
        ? { credentials: createCredentialStore({ kv: createMemoryKv(), thumbKv: createMemoryKv() }), local: createLocalGallery({ kv: createMemoryKv() }) }
        : {};
    mountAll({ ...G.deps, ...stores, ...rest });
}

if (typeof document !== 'undefined' && (document.getElementById('nd-gallery-auth-slot') || document.getElementById('nd-gallery-web-slot'))) {
    mountAll();
}

if (typeof window !== 'undefined') {
    window.NDGallery = Object.freeze({
        remount,
        renderAuth: () => renderAuth(),
        setPickMode,
        importRecord,
        /** 当前用的凭据库和本机画廊（harness 的假宿主用它当批量存入的目标） */
        get stores() { return { credentials: G.deps?.credentials || null, local: G.deps?.local || null }; },
        get state() { return { pick: G.pick, importing: G.importing, lastImport: G.lastImport }; },
    });
}

export { mountGalleryAuth, mountPresetImport, importRecord, remount };
