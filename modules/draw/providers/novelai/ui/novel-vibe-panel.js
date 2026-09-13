// V3：氛围迁移卡（设置页 iframe 内，画在 #nd-vibe-slot）。
// - 导入图片 / .naiv4vibe → 存 IndexedDB `xb_novelai_vibes`（设置页与酒馆同源，直接读写）。
// - 每个氛围：启用、强度、信息提取（数字框 + 滑条）、导出 .naiv4vibe、移除。
// - 「编码」按钮是唯一会编码的入口：发 VIBE_ENCODE 给宿主（宿主持有 Key），每次 2 Anlas，不重试。
// - 预设里只存轻量元数据（getPresetVibes），跟随「保存」一起写入。
// 挂到 window.NDVibePanel = { init, applyPreset, getPresetVibes, getPricingVibes, setItemEnabledByIndex, refresh }
import { normalizeNovelVibeConfig, NOVEL_VIBE_DEFAULT_INFORMATION_EXTRACTED, NOVEL_VIBE_DEFAULT_STRENGTH } from '../novel-vibe-config.js';
import { getVibeStore } from '../novel-vibe-store.js';
import { base64ToBytes, buildNaiv4Vibe, formatInformationExtracted, parseNaiv4Vibe, sha256Hex, vibeKeyFromModel } from '../novel-vibe-format.js';
import { readVibeAssetImageBase64 } from '../novel-vibe-resolve.js';
import { getNovelVibeSupport, NOVEL_VIBE_FREE_COUNT, NOVEL_VIBE_MAX } from '../novel-model-capabilities.js';
import { isFreeOption, VIBE_ENCODE_COST } from '../novel-anlas-pricing.js';
import { xbConfirm } from '../../../shared/xb-dialog.js';

const HOST_SOURCE = 'XBDraw-NovelDraw';
const FRAME_SOURCE = 'NovelDraw-Frame';
const PARENT_ORIGIN = (() => {
    try { return new URL(document.referrer).origin; } catch { return window.location.origin; }
})();

const panel = {
    root: null,
    config: normalizeNovelVibeConfig(null),
    encoded: new Map(),      // item.id -> true/false（当前模型 + 信息提取下是否已有编码）
    assets: new Map(),       // assetId -> { hasImage, thumbUrl }
    pending: new Map(),      // requestId -> item.id
    notice: null,            // { text, level }
    initialized: false,
    refreshToken: 0,
};

const store = () => getVibeStore();

function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
}

function icon(name) {
    const i = el('i', name);
    i.setAttribute('aria-hidden', 'true');
    return i;
}

function currentModel() {
    const sel = document.getElementById('nd_model_sel');
    const custom = document.getElementById('nd_model');
    return String(sel?.value === 'custom' ? custom?.value : sel?.value || '').trim();
}

function hasHost() {
    return window.parent && window.parent !== window;
}

function enabledCount() {
    return panel.config.items.filter(item => item.enabled).length;
}

function enabledLimit() {
    return panel.config.allowOver4 ? NOVEL_VIBE_MAX : NOVEL_VIBE_FREE_COUNT;
}

function notifyChange() {
    document.dispatchEvent(new CustomEvent('nd:vibes-change'));
}

function setNotice(text, level = 'info') {
    panel.notice = text ? { text, level } : null;
    renderNotice();
}

// ── 数据 ────────────────────────────────────────────────────────────────

async function loadAssetMeta(assetId) {
    if (panel.assets.has(assetId)) return panel.assets.get(assetId);
    const meta = { hasImage: false, thumbUrl: '' };
    try {
        const asset = await store().getAsset(assetId);
        if (asset) {
            meta.hasImage = !!asset.image;
            if (typeof asset.thumbnail === 'string') meta.thumbUrl = asset.thumbnail;
            else if (asset.thumbnail instanceof Blob) meta.thumbUrl = URL.createObjectURL(asset.thumbnail);
            else if (asset.image instanceof Blob) meta.thumbUrl = URL.createObjectURL(asset.image);
        } else {
            meta.missing = true;
        }
    } catch {
        meta.missing = true;
    }
    panel.assets.set(assetId, meta);
    return meta;
}

async function refreshEncodedFlags() {
    const token = ++panel.refreshToken;
    const model = currentModel();
    const support = getNovelVibeSupport(model);
    const next = new Map();
    for (const item of panel.config.items) {
        await loadAssetMeta(item.assetId);
        if (!support.supported) { next.set(item.id, false); continue; }
        try {
            const cached = await store().getEncoding(item.assetId, model, item.informationExtracted);
            next.set(item.id, !!cached?.token);
        } catch {
            next.set(item.id, false);
        }
    }
    if (token !== panel.refreshToken) return;
    panel.encoded = next;
    render();
    notifyChange();
}

let flagsTimer = 0;
function scheduleEncodedRefresh(delay = 150) {
    clearTimeout(flagsTimer);
    flagsTimer = setTimeout(() => { void refreshEncodedFlags(); }, delay);
}

function makeItemId() {
    return `vibe-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

function addItem({ assetId, name, informationExtracted, strength }) {
    if (panel.config.items.some(item => item.assetId === assetId)) {
        return { added: false, reason: `「${name || assetId.slice(0, 8)}」已经在列表里` };
    }
    if (panel.config.items.length >= NOVEL_VIBE_MAX) {
        return { added: false, reason: `最多 ${NOVEL_VIBE_MAX} 个氛围` };
    }
    const canEnable = enabledCount() < enabledLimit();
    panel.config.items.push({
        id: makeItemId(),
        assetId,
        name: String(name || ''),
        informationExtracted: informationExtracted ?? NOVEL_VIBE_DEFAULT_INFORMATION_EXTRACTED,
        strength: strength ?? NOVEL_VIBE_DEFAULT_STRENGTH,
        enabled: canEnable,
    });
    panel.config = normalizeNovelVibeConfig(panel.config);
    if (panel.config.items.length === 1) panel.config.enabled = true;
    return { added: true, enabled: canEnable };
}

function readImageSize(blob) {
    return new Promise((resolve) => {
        const url = URL.createObjectURL(blob);
        const img = new Image();
        img.onload = () => { resolve({ img, width: img.naturalWidth, height: img.naturalHeight, url }); };
        img.onerror = () => { URL.revokeObjectURL(url); resolve(null); };
        img.src = url;
    });
}

async function makeThumbnail(blob) {
    const loaded = await readImageSize(blob);
    if (!loaded) return { thumbnail: null, width: 0, height: 0 };
    const side = 112;
    const canvas = document.createElement('canvas');
    canvas.width = side;
    canvas.height = side;
    const ctx = canvas.getContext('2d');
    const scale = Math.max(side / loaded.width, side / loaded.height);
    const w = loaded.width * scale;
    const h = loaded.height * scale;
    ctx.drawImage(loaded.img, (side - w) / 2, (side - h) / 2, w, h);
    URL.revokeObjectURL(loaded.url);
    return { thumbnail: canvas.toDataURL('image/jpeg', 0.8), width: loaded.width, height: loaded.height };
}

async function importImageFile(file) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const assetId = await sha256Hex(bytes);
    const blob = new Blob([bytes], { type: file.type || 'image/png' });
    const { thumbnail, width, height } = await makeThumbnail(blob);
    if (!thumbnail) throw new Error(`「${file.name}」不是可识别的图片`);
    await store().putAsset({ assetId, name: file.name, mime: blob.type, width, height, image: blob, thumbnail, source: 'image' });
    panel.assets.delete(assetId);
    return addItem({ assetId, name: file.name.replace(/\.[^.]+$/, '') });
}

async function importVibeFile(file) {
    const text = await file.text();
    const parsed = parseNaiv4Vibe(text);
    let imageBlob = null;
    if (parsed.asset.imageBase64) {
        imageBlob = new Blob([base64ToBytes(parsed.asset.imageBase64)], { type: 'image/png' });
    }
    const assetId = parsed.asset.assetId
        || await sha256Hex(imageBlob ? new Uint8Array(await imageBlob.arrayBuffer()) : text);
    let thumbnail = parsed.asset.thumbnail || null;
    let width = 0;
    let height = 0;
    if (imageBlob) {
        const made = await makeThumbnail(imageBlob);
        thumbnail ||= made.thumbnail;
        width = made.width;
        height = made.height;
    }
    const name = parsed.asset.name || file.name.replace(/\.[^.]+$/, '');
    await store().putAsset({ assetId, name, mime: imageBlob ? 'image/png' : '', width, height, image: imageBlob, thumbnail, source: 'naiv4vibe' });
    let imported = 0;
    for (const encoding of parsed.encodings) {
        if (!encoding.model) continue;
        await store().putEncoding({
            assetId,
            model: encoding.model,
            informationExtracted: encoding.informationExtracted,
            token: encoding.token,
            bytes: Math.floor(encoding.token.length * 0.75),
            origin: 'import',
        });
        imported++;
    }
    panel.assets.delete(assetId);
    const result = addItem({
        assetId,
        name,
        informationExtracted: parsed.defaults.informationExtracted,
        strength: parsed.defaults.strength,
    });
    const notes = [];
    if (imported) notes.push(`导入 ${imported} 份编码`);
    if (parsed.unknownModelKeys.length) notes.push(`不认识的模型键 ${parsed.unknownModelKeys.join(', ')}（不参与生成）`);
    if (!imageBlob) notes.push('文件不带原图，改信息提取后无法重新编码');
    return { ...result, notes };
}

async function importFiles(fileList) {
    const files = Array.from(fileList || []);
    if (!files.length) return;
    const messages = [];
    let level = 'info';
    for (const file of files) {
        try {
            const isVibe = /\.(naiv4vibe|json)$/i.test(file.name) || file.type === 'application/json';
            const result = isVibe ? await importVibeFile(file) : await importImageFile(file);
            if (!result.added) { messages.push(result.reason); level = 'warn'; continue; }
            if (!result.enabled) { messages.push(`「${file.name}」已添加但未启用（启用上限 ${enabledLimit()} 个）`); level = 'warn'; }
            if (result.notes?.length) messages.push(`「${file.name}」${result.notes.join('；')}`);
        } catch (error) {
            messages.push(`导入「${file.name}」失败：${error?.message || error}`);
            level = 'error';
        }
    }
    setNotice(messages.join('；'), level);
    await refreshEncodedFlags();
}

async function exportItem(item) {
    try {
        const asset = await store().getAsset(item.assetId);
        const encodings = await store().listEncodings(item.assetId);
        const imageBase64 = asset ? await readVibeAssetImageBase64(asset) : null;
        const json = buildNaiv4Vibe({
            asset: {
                assetId: item.assetId,
                name: item.name || asset?.name || '',
                createdAt: asset?.createdAt || Date.now(),
                imageBase64,
                thumbnail: typeof asset?.thumbnail === 'string' ? asset.thumbnail : null,
            },
            encodings: (encodings || []).map(record => ({ model: record.model, informationExtracted: record.informationExtracted, token: record.token })),
            defaults: { modelKey: vibeKeyFromModel(currentModel()), informationExtracted: item.informationExtracted, strength: item.strength },
        });
        const blob = new Blob([JSON.stringify(json)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `${(item.name || item.assetId.slice(0, 12)).replace(/[\\/:*?"<>|]+/g, '_')}.naiv4vibe`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        setNotice(encodings?.length ? '' : '已导出（还没有编码，文件里只有原图）', 'info');
    } catch (error) {
        setNotice(`导出失败：${error?.message || error}`, 'error');
    }
}

async function requestEncode(item) {
    const model = currentModel();
    const support = getNovelVibeSupport(model);
    if (!support.supported) { setNotice(support.message.replace('本次已忽略', '无法编码'), 'warn'); return; }
    if (!hasHost()) { setNotice('独立页面没有连接酒馆，无法编码', 'warn'); return; }
    const meta = panel.assets.get(item.assetId);
    if (meta && !meta.hasImage) { setNotice('这个氛围没有原图，无法编码', 'warn'); return; }
    const label = `「${item.name || item.assetId.slice(0, 8)}」`;
    const ok = await xbConfirm(`编码 ${label}（信息提取 ${formatInformationExtracted(item.informationExtracted)}）会花 ${VIBE_ENCODE_COST} Anlas，失败不重试。`, {
        title: `编码 · ${VIBE_ENCODE_COST} Anlas`, okLabel: '编码', icon: 'ri-coins-line',
    });
    if (!ok) return;
    const requestId = `enc-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    panel.pending.set(requestId, item.id);
    render();
    window.parent.postMessage({
        source: FRAME_SOURCE,
        type: 'VIBE_ENCODE',
        requestId,
        assetId: item.assetId,
        informationExtracted: item.informationExtracted,
        model,
    }, PARENT_ORIGIN);
}

function handleEncodeResult(data) {
    if (!panel.pending.has(data.requestId)) return;
    panel.pending.delete(data.requestId);
    if (data.ok) setNotice(data.cached ? '已有编码，未重复扣费' : `编码完成${data.bytes ? `（${data.bytes} bytes）` : ''}`, 'info');
    else setNotice(`编码失败：${data.error || '未知错误'}`, 'error');
    void refreshEncodedFlags();
}

// ── 渲染 ────────────────────────────────────────────────────────────────

function renderNotice() {
    const box = panel.root?.querySelector('.nd-vibe-notice');
    if (!box) return;
    const model = currentModel();
    const support = getNovelVibeSupport(model);
    let text = panel.notice?.text || '';
    let level = panel.notice?.level || 'info';
    if (!support.supported && panel.config.items.length) {
        text = [support.reason === 'v5' ? 'V5 不支持氛围迁移，生成时会忽略' : '当前模型不支持氛围迁移（仅 V4 / V4.5），生成时会忽略', text].filter(Boolean).join('；');
        if (level === 'info') level = 'warn';
    }
    box.textContent = text;
    box.hidden = !text;
    box.className = `nd-vibe-notice${level === 'warn' ? ' is-warn' : level === 'error' ? ' is-error' : ''}`;
}

function numberSlider(kind, value, label) {
    const row = el('div', 'nd-vibe-slider');
    row.append(el('span', 'nd-vibe-label', label));
    const wrap = el('div', 'nai-num-slider');
    const num = el('input', 'input');
    Object.assign(num, { type: 'number', min: '0.01', max: '1', step: '0.01', value: String(value) });
    num.dataset.vibe = kind;
    num.setAttribute('aria-label', label);
    const range = el('input');
    Object.assign(range, { type: 'range', min: '0.01', max: '1', step: '0.01', value: String(value) });
    range.dataset.vibe = `${kind}-range`;
    range.setAttribute('aria-label', `${label}滑条`);
    wrap.append(num, range);
    row.append(wrap);
    return row;
}

function toggle(kind, checked, title) {
    const label = el('label', 'toggle-switch');
    label.title = title;
    const input = el('input');
    input.type = 'checkbox';
    input.checked = checked;
    input.dataset.vibe = kind;
    label.append(input, el('span', 'toggle-slider'));
    return label;
}

function iconButton(kind, iconName, title, extra = '') {
    const btn = el('button', `btn btn-icon btn-sm${extra}`);
    btn.type = 'button';
    btn.dataset.vibe = kind;
    btn.title = title;
    btn.setAttribute('aria-label', title);
    btn.append(icon(iconName));
    return btn;
}

function renderItem(item, support, subscription) {
    const node = el('div', `nd-vibe-item${item.enabled ? '' : ' is-off'}`);
    node.dataset.id = item.id;
    const meta = panel.assets.get(item.assetId) || {};
    const thumb = el('img', 'nd-vibe-thumb');
    thumb.alt = '';
    if (meta.thumbUrl) thumb.src = meta.thumbUrl;
    node.append(thumb);

    const body = el('div', 'nd-vibe-body');
    const row = el('div', 'nd-vibe-row');
    row.append(el('span', 'nd-vibe-name', item.name || item.assetId.slice(0, 10)));
    const encoded = panel.encoded.get(item.id) === true;
    const pending = [...panel.pending.values()].includes(item.id);
    let badgeText = encoded ? '已编码' : '未编码';
    let badgeClass = encoded ? ' is-encoded' : '';
    if (!support.supported) { badgeText = '不支持'; badgeClass = ' is-na'; }
    else if (meta.missing) { badgeText = '图已丢失'; badgeClass = ''; }
    const badge = el('span', `nd-vibe-badge${badgeClass}`, badgeText);
    if (encoded && support.supported && item.enabled
        && isFreeOption('vibe', { encoded: true, enabledCount: enabledCount() }, { model: currentModel(), vibes: panel.config }, subscription)) {
        badge.classList.add('nd-free');
    }
    row.append(badge, el('span', 'nd-vibe-spacer'));
    row.append(toggle('enable', item.enabled, '启用这个氛围'));
    row.append(iconButton('export', 'ri-download-2-line', '导出 .naiv4vibe'));
    row.append(iconButton('remove', 'ri-delete-bin-line', '从列表移除', ' btn-danger'));
    body.append(row);
    body.append(numberSlider('strength', item.strength, '强度'));
    body.append(numberSlider('ie', item.informationExtracted, '信息提取'));

    if (!encoded && support.supported && !meta.missing) {
        const encode = el('button', 'btn btn-sm nd-vibe-encode');
        encode.type = 'button';
        encode.dataset.vibe = 'encode';
        encode.disabled = pending || meta.hasImage === false;
        encode.title = meta.hasImage === false ? '没有原图，无法编码' : `为当前模型 + 信息提取编码，花 ${VIBE_ENCODE_COST} Anlas`;
        encode.append(icon(pending ? 'ri-loader-4-line ri-spin' : 'ri-magic-line'), el('span', '', pending ? '编码中…' : `编码 · ${VIBE_ENCODE_COST} Anlas`));
        body.append(encode);
    }
    node.append(body);
    return node;
}

function renderMeta() {
    const box = panel.root?.querySelector('.nd-vibe-meta');
    if (!box) return;
    const active = panel.config.items.filter(item => item.enabled);
    const count = panel.root.querySelector('.nd-vibe-count');
    if (count) count.textContent = panel.config.items.length ? `启用 ${active.length}/${enabledLimit()}` : '';
    if (!panel.config.items.length) { box.textContent = ''; box.hidden = true; return; }
    box.hidden = false;
    box.replaceChildren();
    const sum = active.reduce((total, item) => total + Number(item.strength || 0), 0);
    const sumNode = el('span', sum > 1 ? 'is-warn' : '', `强度合计 ${sum.toFixed(2)}`);
    const support = getNovelVibeSupport(currentModel());
    const unencoded = support.supported ? active.filter(item => panel.encoded.get(item.id) !== true).length : 0;
    box.append(sumNode);
    if (!panel.config.enabled) box.append(document.createTextNode(' · 总开关已关，生成时不带氛围'));
    else if (unencoded) box.append(document.createTextNode(` · ${unencoded} 个未编码：生成会被拦下，先点「编码」（${VIBE_ENCODE_COST} Anlas/个）`));
}

function render() {
    const root = panel.root;
    if (!root) return;
    const model = currentModel();
    const support = getNovelVibeSupport(model);
    const subscription = window.NDCostBar?.getSubscription?.() || null;
    const master = root.querySelector('input[data-vibe="master"]');
    if (master) master.checked = panel.config.enabled;
    const over4 = root.querySelector('input[data-vibe="over4"]');
    if (over4) over4.checked = panel.config.allowOver4;
    root.querySelector('.nd-vibe-over4').hidden = panel.config.items.length <= NOVEL_VIBE_FREE_COUNT && !panel.config.allowOver4;

    const list = root.querySelector('.nd-vibe-list');
    list.classList.toggle('is-unsupported', !support.supported);
    list.classList.toggle('is-master-off', !panel.config.enabled);
    if (!panel.config.items.length) {
        const empty = el('div', 'nd-vibe-empty');
        empty.dataset.vibe = 'add';
        empty.append(icon('ri-image-add-line'), el('span', '', '添加图片或 .naiv4vibe（也可以拖进来）'));
        list.replaceChildren(empty);
    } else {
        list.replaceChildren(...panel.config.items.map(item => renderItem(item, support, subscription)));
    }
    renderNotice();
    renderMeta();
}

function buildShell() {
    const card = el('div', 'card nd-vibe');
    card.id = 'nd_vibe_card';
    const head = el('div', 'nd-vibe-head');
    head.append(el('span', 'card-title', '氛围迁移'), el('span', 'nd-vibe-count'), el('span', 'nd-vibe-spacer'));
    const add = el('button', 'btn btn-sm');
    add.type = 'button';
    add.dataset.vibe = 'add';
    add.append(icon('ri-image-add-line'), el('span', '', '添加'));
    head.append(add, toggle('master', false, '氛围迁移总开关'));
    const file = el('input');
    file.type = 'file';
    file.multiple = true;
    file.hidden = true;
    file.accept = 'image/png,image/jpeg,image/webp,.naiv4vibe,application/json';
    file.dataset.vibe = 'file';
    const notice = el('div', 'nd-vibe-notice');
    notice.hidden = true;
    const list = el('div', 'nd-vibe-list');
    const meta = el('div', 'nd-vibe-meta');
    const over4 = el('label', 'check-row nd-vibe-over4');
    const over4Input = el('input');
    over4Input.type = 'checkbox';
    over4Input.dataset.vibe = 'over4';
    over4.append(over4Input, document.createTextNode(' 允许启用超过 4 个（超出部分每个每次生成 +2 Anlas）'));
    card.append(head, file, notice, list, meta, over4);
    return card;
}

function itemFromEvent(event) {
    const id = event.target.closest('.nd-vibe-item')?.dataset.id;
    return id ? panel.config.items.find(item => item.id === id) : null;
}

function clampUnit(value) {
    const number = Math.round(Number(value) * 100) / 100;
    return Number.isFinite(number) ? Math.min(1, Math.max(0.01, number)) : null;
}

function bindEvents(root) {
    const fileInput = root.querySelector('input[data-vibe="file"]');
    root.addEventListener('click', (event) => {
        const target = event.target.closest('[data-vibe]');
        if (!target) return;
        const kind = target.dataset.vibe;
        const item = itemFromEvent(event);
        if (kind === 'add') { fileInput.click(); return; }
        if (!item) return;
        if (kind === 'remove') {
            panel.config.items = panel.config.items.filter(entry => entry.id !== item.id);
            setNotice('已从列表移除（点保存生效；氛围图仍留在本机，可再次添加）', 'info');
            render();
            notifyChange();
        } else if (kind === 'export') {
            void exportItem(item);
        } else if (kind === 'encode') {
            requestEncode(item);
        }
    });
    root.addEventListener('change', (event) => {
        const target = event.target;
        const kind = target.dataset?.vibe;
        if (kind === 'file') { void importFiles(target.files); target.value = ''; return; }
        if (kind === 'master') { panel.config.enabled = target.checked; render(); notifyChange(); return; }
        if (kind === 'over4') {
            panel.config.allowOver4 = target.checked;
            if (!target.checked) {
                let seen = 0;
                panel.config.items.forEach((item) => { if (item.enabled && ++seen > NOVEL_VIBE_FREE_COUNT) item.enabled = false; });
            }
            render();
            notifyChange();
            return;
        }
        const item = itemFromEvent(event);
        if (!item) return;
        if (kind === 'enable') {
            if (target.checked && enabledCount() >= enabledLimit()) {
                target.checked = false;
                setNotice(`最多同时启用 ${enabledLimit()} 个${panel.config.allowOver4 ? '' : '（勾选下方「允许启用超过 4 个」才能多开，会额外扣费）'}`, 'warn');
                return;
            }
            item.enabled = target.checked;
            render();
            notifyChange();
        } else if (kind === 'strength' || kind === 'ie') {
            const value = clampUnit(target.value);
            if (value == null) return;
            target.value = String(value);
            applySliderValue(item, kind, value, target);
        }
    });
    root.addEventListener('input', (event) => {
        const target = event.target;
        const kind = target.dataset?.vibe;
        if (!['strength', 'ie', 'strength-range', 'ie-range'].includes(kind)) return;
        const item = itemFromEvent(event);
        if (!item) return;
        const value = clampUnit(target.value);
        if (value == null) return;
        applySliderValue(item, kind.replace('-range', ''), value, target);
    });
    // 拖入文件
    root.addEventListener('dragover', (event) => {
        if (!event.dataTransfer?.types?.includes('Files')) return;
        event.preventDefault();
        root.classList.add('is-drag');
    });
    root.addEventListener('dragleave', (event) => {
        if (!root.contains(event.relatedTarget)) root.classList.remove('is-drag');
    });
    root.addEventListener('drop', (event) => {
        if (!event.dataTransfer?.files?.length) return;
        event.preventDefault();
        root.classList.remove('is-drag');
        void importFiles(event.dataTransfer.files);
    });
}

function applySliderValue(item, kind, value, source) {
    const node = panel.root.querySelector(`.nd-vibe-item[data-id="${CSS.escape(item.id)}"]`);
    if (kind === 'strength') item.strength = value;
    else item.informationExtracted = value;
    node?.querySelectorAll(`[data-vibe="${kind}"], [data-vibe="${kind}-range"]`).forEach((input) => {
        if (input !== source) input.value = String(value);
    });
    renderMeta();
    if (kind === 'ie') scheduleEncodedRefresh(250);
    notifyChange();
}

// ── 对外接口 ────────────────────────────────────────────────────────────

function init() {
    if (panel.initialized) return;
    const slot = document.getElementById('nd-vibe-slot');
    if (!slot) return;
    panel.initialized = true;
    panel.root = buildShell();
    slot.replaceChildren(panel.root);
    bindEvents(panel.root);
    render();
    const onModelChange = () => { panel.notice = null; scheduleEncodedRefresh(0); };
    document.getElementById('nd_model_sel')?.addEventListener('change', onModelChange);
    document.getElementById('nd_model')?.addEventListener('change', onModelChange);
    document.addEventListener('nd:subscription-change', () => render());
    window.addEventListener('message', (event) => {
        if (event.origin !== PARENT_ORIGIN || event.source !== window.parent) return;
        const data = event.data;
        if (!data || data.source !== HOST_SOURCE) return;
        if (data.type === 'VIBE_ENCODE_RESULT') handleEncodeResult(data);
    });
}

/** applyParamsPreset 末尾调用：换预设 / INIT_DATA 时载入该预设的氛围。 */
function applyPreset(preset) {
    init();
    panel.config = normalizeNovelVibeConfig(preset?.vibes);
    panel.encoded = new Map();
    panel.notice = null;
    render();
    void refreshEncodedFlags();
}

/** collectParamsPreset 调用：保存进预设的轻量元数据（不含图片和 token）。 */
function getPresetVibes() {
    return normalizeNovelVibeConfig(JSON.parse(JSON.stringify(panel.config)));
}

/** 给计价用：预设形状 + 每个条目的 encoded 标记（V3/V5 由计价模块自己忽略）。 */
function getPricingVibes() {
    return {
        enabled: panel.config.enabled,
        allowOver4: panel.config.allowOver4,
        items: panel.config.items.map(item => ({
            id: item.id,
            assetId: item.assetId,
            name: item.name,
            enabled: item.enabled,
            encoded: panel.encoded.has(item.id) ? panel.encoded.get(item.id) === true : undefined,
        })),
    };
}

/** 复位：toFreeConfig 关掉的条目（按 items 下标）。 */
function setItemEnabledByIndex(index, enabled) {
    const item = panel.config.items[index];
    if (!item) return false;
    item.enabled = enabled === true;
    render();
    notifyChange();
    return true;
}

window.NDVibePanel = {
    init,
    applyPreset,
    getPresetVibes,
    getPricingVibes,
    setItemEnabledByIndex,
    refresh: () => { void refreshEncodedFlags(); },
};
