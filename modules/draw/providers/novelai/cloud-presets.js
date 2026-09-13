// cloud-presets.js
// 云端预设管理模块 (保持大尺寸 + 分页搜索)

import { V5_QUALITY_IDS, V5_UC_IDS } from './novel-v5-request.js';
import { ensureRemixIcon } from '../../shared/remixicon-loader.js';
import { xbPrompt } from '../../shared/xb-dialog.js';
import { XB_ACCENT, XB_ACCENT_HOVER, xbAccentSoft } from '../../shared/xb-theme.js';

// ═══════════════════════════════════════════════════════════════════════════
// 常量
// ═══════════════════════════════════════════════════════════════════════════

const CLOUD_PRESETS_API = 'https://draw.velure.top/';
const PLUGIN_KEY = 'xbaix';
const ITEMS_PER_PAGE = 8;
const PRESET_TYPE = 'novel-draw-preset';
const CURRENT_PRESET_VERSION = 2;
const LEGACY_UC_TO_V5 = Object.freeze({
    0: 'heavy',
    1: 'light',
    2: 'humanFocus',
    3: 'none',
});
const DEFAULT_PARAMS = Object.freeze({
    model: 'nai-diffusion-4-5-full',
    sampler: 'k_euler_ancestral',
    scheduler: 'karras',
    steps: 28,
    scale: 6,
    width: 1216,
    height: 832,
    seed: -1,
    qualityToggle: true,
    autoSmea: false,
    ucPreset: 0,
    cfg_rescale: 0,
    v5QualityPresetId: 'standard',
    v5UcPresetId: 'heavy',
    transparentBackground: false,
    variety_boost: false,
    sm: false,
    sm_dyn: false,
    decrisper: false,
});

// ═══════════════════════════════════════════════════════════════════════════
// 状态
// ═══════════════════════════════════════════════════════════════════════════

let modalElement = null;
let allPresets = [];
let filteredPresets = [];
let currentPage = 1;
let onImportCallback = null;

// ═══════════════════════════════════════════════════════════════════════════
// API 调用
// ═══════════════════════════════════════════════════════════════════════════

export async function fetchCloudPresets() {
    const response = await fetch(CLOUD_PRESETS_API, {
        method: 'GET',
        headers: {
            'Accept': 'application/json',
            'X-Plugin-Key': PLUGIN_KEY,
            'Cache-Control': 'no-cache',
            'Pragma': 'no-cache'
        },
        cache: 'no-store'
    });
    
    if (!response.ok) throw new Error(`HTTP错误: ${response.status}`);
    const data = await response.json();
    return data.items || [];
}

export async function downloadPreset(url) {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`下载失败: ${response.status}`);
    
    const data = await response.json();
    
    return data;
}

// ═══════════════════════════════════════════════════════════════════════════
// 预设处理
// ═══════════════════════════════════════════════════════════════════════════

function requirePresetEnvelope(data) {
    if (!data || typeof data !== 'object' || Array.isArray(data)
        || data.type !== PRESET_TYPE
        || !data.preset || typeof data.preset !== 'object' || Array.isArray(data.preset)) {
        throw new Error('无效的预设文件格式');
    }
    const version = Number(data.version);
    if (version !== 1 && version !== CURRENT_PRESET_VERSION) {
        throw new Error(`不支持的参数预设版本：${data.version ?? '缺失'}`);
    }
    return version;
}

function normalizeImportedParams(rawParams, version, warnings) {
    const importedParams = rawParams && typeof rawParams === 'object' && !Array.isArray(rawParams)
        ? { ...rawParams }
        : {};
    const qualityToggle = importedParams.qualityToggle !== false;
    const legacyUcPreset = [0, 1, 2, 3].includes(Number(importedParams.ucPreset))
        ? Number(importedParams.ucPreset)
        : 0;

    if (version === 1) {
        importedParams.v5QualityPresetId = qualityToggle ? 'standard' : 'none';
        importedParams.v5UcPresetId = LEGACY_UC_TO_V5[legacyUcPreset];
        importedParams.transparentBackground = false;
        return { ...DEFAULT_PARAMS, ...importedParams };
    }

    if (importedParams.v5QualityPresetId != null
        && !V5_QUALITY_IDS.includes(importedParams.v5QualityPresetId)) {
        warnings.push('无法识别 V5 Quality，已使用 Standard');
        importedParams.v5QualityPresetId = 'standard';
    }
    if (importedParams.v5UcPresetId != null
        && !V5_UC_IDS.includes(importedParams.v5UcPresetId)) {
        warnings.push('无法识别 V5 UC，已使用 Heavy');
        importedParams.v5UcPresetId = 'heavy';
    }
    return { ...DEFAULT_PARAMS, ...importedParams };
}

export function parsePresetData(data, generateId) {
    const version = requirePresetEnvelope(data);
    if (typeof generateId !== 'function') throw new TypeError('generateId must be a function');
    const warnings = [];
    const importedParams = normalizeImportedParams(data.preset.params, version, warnings);
    return {
        preset: {
            id: generateId(),
            name: String(data.name || data.preset.name || '云端预设'),
            positivePrefix: String(data.preset.positivePrefix || ''),
            negativePrefix: String(data.preset.negativePrefix || ''),
            maxImages: version === 1 ? 0 : Math.max(0, Number(data.preset.maxImages) || 0),
            maxCharactersPerImage: version === 1
                ? 0
                : Math.max(0, Number(data.preset.maxCharactersPerImage) || 0),
            params: importedParams,
        },
        warnings,
    };
}

export async function exportPreset(preset) {
    const author = await xbPrompt('作者名（可留空）：', '', { title: '导出预设' });
    if (author === null) return null;
    const description = await xbPrompt('简介（画风介绍，可留空）：', '', { title: '导出预设' });
    if (description === null) return null;

    return {
        type: PRESET_TYPE,
        version: CURRENT_PRESET_VERSION,
        exportDate: new Date().toISOString(),
        name: preset.name,
        author: author,
        简介: description,
        preset: {
            positivePrefix: preset.positivePrefix,
            negativePrefix: preset.negativePrefix,
            maxImages: preset.maxImages || 0,
            maxCharactersPerImage: preset.maxCharactersPerImage || 0,
            params: { ...preset.params }
        }
    };
}

// ═══════════════════════════════════════════════════════════════════════════
// 样式 - 保持原始大尺寸
// ═══════════════════════════════════════════════════════════════════════════

function escapeHtml(str) {
    return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function ensureStyles() {
    ensureRemixIcon();
    if (document.getElementById('cloud-presets-styles')) return;
    
    const style = document.createElement('style');
    style.id = 'cloud-presets-styles';
    style.textContent = `
/* 云端预设弹窗：Notion 暗色，零边线零阴影，层级只靠底色 */
.cloud-presets-overlay, .cloud-presets-overlay *, .cloud-presets-overlay *::before, .cloud-presets-overlay *::after { border-style: none !important; outline-style: none !important; box-shadow: none !important; }
.cloud-presets-overlay {
    position: fixed !important; top: 0 !important; left: 0 !important; width: 100vw !important; height: 100vh !important;
    z-index: 100001 !important; display: flex !important; align-items: center !important; justify-content: center !important;
    background: rgba(0, 0, 0, 0.75) !important; touch-action: none; -webkit-overflow-scrolling: touch;
    animation: cloudFadeIn 0.2s ease;
}
@keyframes cloudFadeIn { from { opacity: 0; } to { opacity: 1; } }
.cloud-presets-modal {
    display: flex; flex-direction: column; overflow: hidden; box-sizing: border-box;
    width: calc(100vw - 48px); max-width: 800px; height: 80vh;
    border-radius: 10px; background: #191919; color: #e6e6e4; font-size: 13px;
}
@media (max-width: 768px) { .cloud-presets-modal { width: 100vw; height: 100vh; max-width: none; border-radius: 0; } }
.cp-header { display: flex; align-items: center; justify-content: space-between; flex-shrink: 0; padding: 10px 12px 10px 16px; background: #202020; }
.cp-title { display: flex; align-items: center; gap: 8px; font-size: 14px; font-weight: 600; color: #e6e6e4; }
.cp-title i { font-size: 18px; color: ${XB_ACCENT}; }
.cp-close {
    display: flex; align-items: center; justify-content: center; width: 32px; height: 32px; min-width: 32px; margin: 0; padding: 0;
    border-radius: 6px; background: #2a2a2a; color: #e6e6e4; font-size: 18px; cursor: pointer; transition: background 0.15s; -webkit-tap-highlight-color: transparent;
}
.cp-close:hover, .cp-close:active { background: #333333; }
.cp-search { flex-shrink: 0; padding: 8px 12px; background: #202020; }
.cp-search-box { position: relative; }
.cp-search-box > i { position: absolute; left: 10px; top: 50%; transform: translateY(-50%); font-size: 15px; color: #6b6b68; pointer-events: none; }
.cp-search-input {
    box-sizing: border-box; width: 100%; min-height: 32px; margin: 0; padding: 6px 10px 6px 32px;
    border-radius: 6px; background: #2e2e2e; color: #e6e6e4; font: inherit; font-size: 13px; transition: background 0.15s;
}
.cp-search-input::placeholder { color: #6b6b68; }
.cp-search-input:focus { background: #333333; }
.cp-body { flex: 1; overflow-y: auto; padding: 12px; background: #191919; -webkit-overflow-scrolling: touch; }
.cp-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 8px; }
@media (max-width: 500px) { .cp-grid { grid-template-columns: 1fr; } }
.cp-card { display: flex; flex-direction: column; gap: 8px; padding: 12px; border-radius: 8px; background: #202020; transition: background 0.15s; }
.cp-card:hover { background: #252525; }
.cp-card-head { display: flex; align-items: center; gap: 10px; }
.cp-icon { display: flex; align-items: center; justify-content: center; flex-shrink: 0; width: 36px; height: 36px; border-radius: 8px; background: ${xbAccentSoft(0.16)}; color: ${XB_ACCENT}; font-size: 18px; }
.cp-meta { flex: 1; min-width: 0; overflow: hidden; }
.cp-name { margin-bottom: 2px; font-size: 13px; font-weight: 600; color: #e6e6e4; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.cp-author { display: flex; align-items: center; gap: 4px; font-size: 12px; color: #9b9b98; }
.cp-author i { font-size: 12px; opacity: 0.8; }
.cp-desc { min-height: 34px; font-size: 12px; line-height: 1.45; color: #9b9b98; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.cp-btn {
    display: flex; align-items: center; justify-content: center; gap: 5px; width: 100%; min-height: 30px; margin: auto 0 0; padding: 6px 10px;
    border-radius: 6px; background: ${xbAccentSoft(0.16)}; color: ${XB_ACCENT_HOVER}; font: inherit; font-size: 12px; font-weight: 500;
    cursor: pointer; transition: background 0.15s; -webkit-tap-highlight-color: transparent;
}
.cp-btn:hover { background: ${xbAccentSoft(0.26)}; }
.cp-btn:disabled { opacity: 0.5; cursor: not-allowed; }
.cp-btn.success { background: rgba(77, 171, 111, 0.2); color: #4dab6f; }
.cp-btn.error { background: rgba(229, 83, 75, 0.16); color: #e5534b; }
.cp-pagination { display: flex; align-items: center; justify-content: center; gap: 10px; flex-shrink: 0; padding: 8px 12px; background: #202020; }
.cp-page-btn {
    display: flex; align-items: center; gap: 4px; min-height: 30px; margin: 0; padding: 4px 12px;
    border-radius: 6px; background: #2a2a2a; color: #e6e6e4; font: inherit; font-size: 12px; cursor: pointer; transition: background 0.15s; -webkit-tap-highlight-color: transparent;
}
.cp-page-btn:hover:not(:disabled) { background: #333333; }
.cp-page-btn:disabled { opacity: 0.35; cursor: not-allowed; }
.cp-page-info { min-width: 60px; text-align: center; font-size: 12px; color: #9b9b98; font-variant-numeric: tabular-nums; }
.cp-loading, .cp-load-error, .cp-empty { padding: 48px 16px; text-align: center; color: #9b9b98; }
.cp-loading-icon { margin-bottom: 12px; font-size: 28px; line-height: 1; color: ${XB_ACCENT}; }
.cp-spin { display: inline-block; animation: cpSpin 1s linear infinite; }
@keyframes cpSpin { to { transform: rotate(360deg); } }
.cp-empty > i { display: block; margin-bottom: 12px; font-size: 36px; opacity: 0.5; }
.cp-empty p { margin-top: 6px; font-size: 12px; opacity: 0.7; }
.cp-load-error, .cp-import-error { color: #e5534b; }
.cp-import-error { margin: 0 0 10px; padding: 8px 10px; border-radius: 6px; background: rgba(229, 83, 75, 0.12); }
@media (hover: none) and (pointer: coarse) {
    .cp-close { width: 40px; height: 40px; }
    .cp-search-input { min-height: 44px; }
    .cp-btn { min-height: 44px; }
    .cp-page-btn { min-height: 40px; }
}
`;
    document.head.appendChild(style);
}

// ═══════════════════════════════════════════════════════════════════════════
// UI 逻辑
// ═══════════════════════════════════════════════════════════════════════════

function createModal() {
    ensureStyles();
    
    const overlay = document.createElement('div');
    overlay.className = 'cloud-presets-overlay';
    
    // Template-only UI markup.
    // eslint-disable-next-line no-unsanitized/property
    overlay.innerHTML = `
        <div class="cloud-presets-modal">
            <div class="cp-header">
                <div class="cp-title">
                    <i class="ri-cloud-line" aria-hidden="true"></i>
                    云端绘图预设
                </div>
                <button class="cp-close" type="button" aria-label="关闭"><i class="ri-close-line" aria-hidden="true"></i></button>
            </div>

            <div class="cp-search">
                <div class="cp-search-box">
                    <i class="ri-search-line" aria-hidden="true"></i>
                    <input type="text" class="cp-search-input" placeholder="搜索预设名称、作者或简介">
                </div>
            </div>

            <div class="cp-body">
                <div class="cp-loading">
                    <div class="cp-loading-icon"><i class="ri-loader-4-line cp-spin" aria-hidden="true"></i></div>
                    <div>正在获取云端数据...</div>
                </div>
                <div class="cp-load-error" style="display:none"></div>
                <div class="cp-import-error" style="display:none"></div>
                <div class="cp-empty" style="display:none">
                    <i class="ri-inbox-line" aria-hidden="true"></i>
                    <div>没有找到相关预设</div>
                    <p>试试其他关键词？</p>
                </div>
                <div class="cp-grid" style="display:none"></div>
            </div>

            <div class="cp-pagination" style="display:none">
                <button class="cp-page-btn" id="cp-prev">
                    <i class="ri-arrow-left-s-line" aria-hidden="true"></i> 上一页
                </button>
                <span class="cp-page-info" id="cp-info">1 / 1</span>
                <button class="cp-page-btn" id="cp-next">
                    下一页 <i class="ri-arrow-right-s-line" aria-hidden="true"></i>
                </button>
            </div>
        </div>
    `;

    // 事件绑定
    overlay.querySelector('.cp-close').onclick = closeModal;
    overlay.onclick = (e) => { if (e.target === overlay) closeModal(); };
    overlay.querySelector('.cloud-presets-modal').onclick = (e) => e.stopPropagation();
    overlay.querySelector('.cp-search-input').oninput = (e) => handleSearch(e.target.value);
    overlay.querySelector('#cp-prev').onclick = () => changePage(-1);
    overlay.querySelector('#cp-next').onclick = () => changePage(1);
    
    return overlay;
}

function handleSearch(query) {
    const q = query.toLowerCase().trim();
    filteredPresets = allPresets.filter(p => 
        (p.name || '').toLowerCase().includes(q) || 
        (p.author || '').toLowerCase().includes(q) ||
        (p.简介 || p.description || '').toLowerCase().includes(q)
    );
    currentPage = 1;
    renderPage();
}

function changePage(delta) {
    const maxPage = Math.ceil(filteredPresets.length / ITEMS_PER_PAGE) || 1;
    const newPage = currentPage + delta;
    if (newPage >= 1 && newPage <= maxPage) {
        currentPage = newPage;
        renderPage();
    }
}

function renderPage() {
    const grid = modalElement.querySelector('.cp-grid');
    const pagination = modalElement.querySelector('.cp-pagination');
    const empty = modalElement.querySelector('.cp-empty');
    const loading = modalElement.querySelector('.cp-loading');
    const importError = modalElement.querySelector('.cp-import-error');
    
    loading.style.display = 'none';
    importError.style.display = 'none';
    
    if (filteredPresets.length === 0) {
        grid.style.display = 'none';
        pagination.style.display = 'none';
        empty.style.display = 'block';
        return;
    }
    
    empty.style.display = 'none';
    grid.style.display = 'grid';
    
    const maxPage = Math.ceil(filteredPresets.length / ITEMS_PER_PAGE);
    pagination.style.display = maxPage > 1 ? 'flex' : 'none';
    
    const start = (currentPage - 1) * ITEMS_PER_PAGE;
    const pageItems = filteredPresets.slice(start, start + ITEMS_PER_PAGE);
    
    // Escaped fields are used in the template.
    // eslint-disable-next-line no-unsanitized/property
    grid.innerHTML = pageItems.map(p => `
        <div class="cp-card">
            <div class="cp-card-head">
                <div class="cp-icon"><i class="ri-palette-line" aria-hidden="true"></i></div>
                <div class="cp-meta">
                    <div class="cp-name" title="${escapeHtml(p.name)}">${escapeHtml(p.name || '未命名')}</div>
                    <div class="cp-author"><i class="ri-user-3-line" aria-hidden="true"></i> ${escapeHtml(p.author || '匿名')}</div>
                </div>
            </div>
            <div class="cp-desc">${escapeHtml(p.简介 || p.description || '暂无简介')}</div>
            <button class="cp-btn" type="button" data-url="${escapeHtml(p.url)}">
                <i class="ri-download-2-line" aria-hidden="true"></i> 导入预设
            </button>
        </div>
    `).join('');

    // 绑定导入按钮
    grid.querySelectorAll('.cp-btn').forEach(btn => {
        btn.onclick = async (e) => {
            e.stopPropagation();
            const url = btn.dataset.url;
            if (!url || btn.disabled) return;
            
            btn.disabled = true;
            const errorElement = modalElement.querySelector('.cp-import-error');
            errorElement.style.display = 'none';
            errorElement.textContent = '';
            const origHtml = btn.innerHTML;
            // Template-only UI markup.
            // eslint-disable-next-line no-unsanitized/property
            btn.innerHTML = '<i class="ri-loader-4-line cp-spin" aria-hidden="true"></i> 导入中';
            
            try {
                const data = await downloadPreset(url);
                const accepted = onImportCallback ? await onImportCallback(data) : undefined;
                if (accepted === false) {
                    // 用户在起名对话框里取消：什么都没导入，按钮复原
                    // eslint-disable-next-line no-unsanitized/property
                    btn.innerHTML = origHtml;
                    btn.disabled = false;
                    return;
                }
                btn.classList.add('success');
                // Template-only UI markup.
                // eslint-disable-next-line no-unsanitized/property
                btn.innerHTML = '<i class="ri-check-line" aria-hidden="true"></i> 成功';
                setTimeout(() => {
                    btn.classList.remove('success');
                    // Template-only UI markup.
                    // eslint-disable-next-line no-unsanitized/property
                    btn.innerHTML = origHtml;
                    btn.disabled = false;
                }, 2000);
            } catch (err) {
                console.error('[CloudPresets]', err);
                const message = String(err?.message || '未知错误');
                errorElement.textContent = `导入失败：${message}`;
                errorElement.style.display = 'block';
                btn.title = message;
                btn.classList.add('error');
                // Template-only UI markup.
                // eslint-disable-next-line no-unsanitized/property
                btn.innerHTML = '<i class="ri-close-line" aria-hidden="true"></i> 失败';
                setTimeout(() => {
                    btn.classList.remove('error');
                    // Template-only UI markup.
                    // eslint-disable-next-line no-unsanitized/property
                    btn.innerHTML = origHtml;
                    btn.disabled = false;
                }, 2000);
            }
        };
    });
    
    // 更新分页信息
    modalElement.querySelector('#cp-info').textContent = `${currentPage} / ${maxPage}`;
    modalElement.querySelector('#cp-prev').disabled = currentPage === 1;
    modalElement.querySelector('#cp-next').disabled = currentPage === maxPage;
}

// ═══════════════════════════════════════════════════════════════════════════
// 公开接口
// ═══════════════════════════════════════════════════════════════════════════

export async function openCloudPresetsModal(importCallback) {
    onImportCallback = importCallback;
    
    if (!modalElement) modalElement = createModal();
    document.body.appendChild(modalElement);
    
    // 重置状态
    currentPage = 1;
    allPresets = [];
    filteredPresets = [];
    modalElement.querySelector('.cp-loading').style.display = 'block';
    modalElement.querySelector('.cp-grid').style.display = 'none';
    modalElement.querySelector('.cp-pagination').style.display = 'none';
    modalElement.querySelector('.cp-empty').style.display = 'none';
    const loadError = modalElement.querySelector('.cp-load-error');
    const importError = modalElement.querySelector('.cp-import-error');
    const searchInput = modalElement.querySelector('.cp-search-input');
    loadError.style.display = 'none';
    loadError.textContent = '';
    importError.style.display = 'none';
    importError.textContent = '';
    searchInput.value = '';
    searchInput.disabled = true;
    
    try {
        allPresets = await fetchCloudPresets();
        filteredPresets = [...allPresets];
        searchInput.disabled = false;
        renderPage();
    } catch (e) {
        console.error('[CloudPresets]', e);
        modalElement.querySelector('.cp-loading').style.display = 'none';
        const errEl = modalElement.querySelector('.cp-load-error');
        errEl.style.display = 'block';
        errEl.textContent = '加载失败: ' + e.message;
    }
}

export function closeModal() {
    modalElement?.remove();
}

export async function downloadPresetAsFile(preset) {
    const data = await exportPreset(preset);
    if (!data) return false;
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${preset.name || 'preset'}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
}

export function destroyCloudPresets() {
    closeModal();
    modalElement = null;
    allPresets = [];
    filteredPresets = [];
    document.getElementById('cloud-presets-styles')?.remove();
}
