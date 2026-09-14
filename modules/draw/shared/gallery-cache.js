// gallery-cache.js
// 画廊和缓存管理模块

import { getContext } from "../../../../../../extensions.js";
import {
    LIGHTBOX_STYLE_ID,
    closeImageLightbox,
    downloadImageOriginal,
    ensureLightboxStyles,
    listLightboxActions,
    openImageLightbox,
    registerLightboxAction,
} from './image-lightbox.js';
import { XB_ACCENT_RGB, XB_ON_ACCENT } from './xb-theme.js';

// 灯箱长按面板扩展点（G2 画廊从这里注册「存入画廊」）
export { registerLightboxAction, listLightboxActions, downloadImageOriginal };

// ═══════════════════════════════════════════════════════════════════════════
// 常量
// ═══════════════════════════════════════════════════════════════════════════

const DB_NAME = 'xb_novel_draw_previews';
const DB_STORE = 'previews';
const DB_SELECTIONS_STORE = 'selections';
const DB_VERSION = 3;
const CACHE_TTL = 5 * 60 * 1000;
const PREVIEW_CACHE_LIMIT = 64;
const PREVIEW_OBJECT_URL_LIMIT = 128;
const PREVIEW_PRELOAD_LIMIT = 128;
const CACHE_SYNC_CHANNEL_NAME = 'xb_novel_draw_preview_changes';

// ═══════════════════════════════════════════════════════════════════════════
// 状态
// ═══════════════════════════════════════════════════════════════════════════

let db = null;
let dbOpening = null;

const previewCache = new Map();
const previewObjectUrlCache = new Map();
const previewPreloadCache = new Map();
const cacheChangeListeners = new Set();
let cacheSyncChannel = null;

// ═══════════════════════════════════════════════════════════════════════════
// 图片显示 URL
// ═══════════════════════════════════════════════════════════════════════════

function parseBase64Image(value) {
    const raw = String(value || '').trim();
    if (!raw) return null;
    const match = raw.match(/^data:([^;]+);base64,(.*)$/i);
    return {
        mime: match?.[1] || 'image/png',
        data: match ? match[2] : raw,
    };
}

export function getBase64ImagePayload(value) {
    const parsed = parseBase64Image(value);
    if (!parsed?.data) return { base64: '', format: 'png' };
    const format = parsed.mime === 'image/jpeg'
        ? 'jpg'
        : parsed.mime === 'image/webp'
            ? 'webp'
            : 'png';
    return { base64: parsed.data, format };
}

function base64ToBlob(base64, mime) {
    const binary = atob(base64);
    const chunkSize = 8192;
    const chunks = [];
    for (let offset = 0; offset < binary.length; offset += chunkSize) {
        const slice = binary.slice(offset, offset + chunkSize);
        const bytes = new Uint8Array(slice.length);
        for (let i = 0; i < slice.length; i++) {
            bytes[i] = slice.charCodeAt(i);
        }
        chunks.push(bytes);
    }
    return new Blob(chunks, { type: mime });
}

function blobToDataUrl(blob) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ''));
        reader.onerror = () => reject(reader.error || new Error('blob_read_failed'));
        reader.readAsDataURL(blob);
    });
}

async function savedUrlToDataUrl(savedUrl = '') {
    const url = String(savedUrl || '').trim();
    if (!url) return '';
    if (/^data:[^;]+;base64,/i.test(url)) return url;
    if (/^blob:/i.test(url)) {
        const response = await fetch(url);
        if (!response.ok) throw new Error('image_fetch_failed');
        return blobToDataUrl(await response.blob());
    }
    if (/^https?:\/\//i.test(url) || url.startsWith('/')) {
        const response = await fetch(url);
        if (!response.ok) throw new Error('image_fetch_failed');
        return blobToDataUrl(await response.blob());
    }
    return '';
}

function getObjectUrlCacheKey(imgId, base64) {
    return String(imgId || '').trim() || `inline-${String(base64 || '').slice(0, 80)}`;
}

function isObjectUrlInUse(url) {
    if (typeof document === 'undefined') return true;
    return Array.from(document.images || []).some(img => img?.src === url);
}

function prunePreviewObjectUrls() {
    if (previewObjectUrlCache.size <= PREVIEW_OBJECT_URL_LIMIT) return;
    for (const [key, url] of previewObjectUrlCache.entries()) {
        if (previewObjectUrlCache.size <= PREVIEW_OBJECT_URL_LIMIT) break;
        if (isObjectUrlInUse(url)) continue;
        try { URL.revokeObjectURL(url); } catch {}
        previewObjectUrlCache.delete(key);
    }
}

function prunePreviewPreloads() {
    while (previewPreloadCache.size > PREVIEW_PRELOAD_LIMIT) {
        const oldestKey = previewPreloadCache.keys().next().value;
        if (oldestKey === undefined) break;
        const cached = previewPreloadCache.get(oldestKey);
        if (cached?.img) {
            try { cached.img.src = ''; } catch {}
        }
        previewPreloadCache.delete(oldestKey);
    }
}

export function revokePreviewObjectUrl(imgId) {
    const key = String(imgId || '').trim();
    if (!key) return;
    const url = previewObjectUrlCache.get(key);
    if (url) {
        try { URL.revokeObjectURL(url); } catch {}
        previewObjectUrlCache.delete(key);
    }
    const preload = previewPreloadCache.get(key);
    if (preload?.img) {
        try { preload.img.src = ''; } catch {}
    }
    previewPreloadCache.delete(key);
}

export function clearPreviewObjectUrls() {
    for (const url of previewObjectUrlCache.values()) {
        try { URL.revokeObjectURL(url); } catch {}
    }
    previewObjectUrlCache.clear();
    for (const cached of previewPreloadCache.values()) {
        if (cached?.img) {
            try { cached.img.src = ''; } catch {}
        }
    }
    previewPreloadCache.clear();
}

export function getPreviewDisplayUrl(preview = {}) {
    const savedUrl = String(preview?.savedUrl || '').trim();
    if (savedUrl) return savedUrl;

    const parsed = parseBase64Image(preview?.base64);
    if (!parsed?.data) return '';

    if (typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function' || typeof atob !== 'function') {
        return `data:${parsed.mime};base64,${parsed.data}`;
    }

    const key = getObjectUrlCacheKey(preview?.imgId, parsed.data);
    const cached = previewObjectUrlCache.get(key);
    if (cached) return cached;

    try {
        const url = URL.createObjectURL(base64ToBlob(parsed.data, parsed.mime));
        previewObjectUrlCache.set(key, url);
        prunePreviewObjectUrls();
        return url;
    } catch {
        return `data:${parsed.mime};base64,${parsed.data}`;
    }
}

function getPreviewPreloadKey(preview = {}, url = '') {
    return String(preview?.imgId || '').trim() || String(url || '').trim();
}

export async function preloadPreviewDisplayUrl(preview = {}) {
    const url = getPreviewDisplayUrl(preview);
    if (!url || typeof Image === 'undefined') return false;

    const key = getPreviewPreloadKey(preview, url);
    const cached = previewPreloadCache.get(key);
    if (cached) return cached.promise;

    const img = new Image();
    img.decoding = 'async';
    const promise = new Promise((resolve) => {
        const done = (ok) => resolve(ok);
        img.onload = async () => {
            if (typeof img.decode === 'function') {
                try { await img.decode(); } catch {}
            }
            done(true);
        };
        img.onerror = () => {
            previewPreloadCache.delete(key);
            done(false);
        };
        img.src = url;
    });
    previewPreloadCache.set(key, { img, promise, timestamp: Date.now() });
    prunePreviewPreloads();
    return promise;
}

export async function warmSlotPreviewNeighbors(slotId, currentIndex = 0, range = 1) {
    const previews = await getPreviewsBySlot(slotId).catch(() => []);
    const successPreviews = previews.filter(p => p.status !== 'failed' && (p.base64 || p.savedUrl));
    if (successPreviews.length <= 1) return;

    const start = Math.max(0, currentIndex - range);
    const end = Math.min(successPreviews.length - 1, currentIndex + range);
    for (let index = start; index <= end; index++) {
        if (index === currentIndex) continue;
        const preload = () => {
            void preloadPreviewDisplayUrl(successPreviews[index]).catch(() => {});
        };
        if (typeof requestIdleCallback === 'function') {
            requestIdleCallback(preload, { timeout: 500 });
        } else {
            setTimeout(preload, 0);
        }
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// 内存缓存
// ═══════════════════════════════════════════════════════════════════════════

function prunePreviewCache() {
    const now = Date.now();
    for (const [slotId, cached] of previewCache.entries()) {
        if (!cached || now - cached.timestamp >= CACHE_TTL) {
            previewCache.delete(slotId);
        }
    }
    while (previewCache.size > PREVIEW_CACHE_LIMIT) {
        const oldestKey = previewCache.keys().next().value;
        if (oldestKey === undefined) break;
        previewCache.delete(oldestKey);
    }
}

function getCachedPreviews(slotId) {
    prunePreviewCache();
    const cached = previewCache.get(slotId);
    if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
        return cached.data;
    }
    return null;
}

function setCachedPreviews(slotId, data) {
    prunePreviewCache();
    previewCache.set(slotId, { data, timestamp: Date.now() });
    prunePreviewCache();
}

function invalidateCache(slotId) {
    if (slotId) {
        previewCache.delete(slotId);
    } else {
        previewCache.clear();
    }
}

function normalizeChangedSlotIds(slotIds) {
    if (slotIds === null) return null;
    return [...new Set((Array.isArray(slotIds) ? slotIds : [])
        .map(slotId => String(slotId || '').trim())
        .filter(Boolean))];
}

function notifyCacheChangeListeners(slotIds) {
    for (const listener of cacheChangeListeners) {
        try {
            listener({ slotIds });
        } catch (error) {
            console.error('[GalleryCache] 处理跨标签页缓存变更失败:', error);
        }
    }
}

function ensureCacheSyncChannel() {
    if (cacheSyncChannel || typeof globalThis.BroadcastChannel !== 'function') return cacheSyncChannel;
    try {
        cacheSyncChannel = new globalThis.BroadcastChannel(CACHE_SYNC_CHANNEL_NAME);
        cacheSyncChannel.onmessage = (event) => {
            if (event.data?.type !== 'invalidate') return;
            const slotIds = normalizeChangedSlotIds(event.data.slotIds);
            if (slotIds !== null && slotIds.length === 0) return;
            if (slotIds === null) {
                invalidateCache();
            } else {
                slotIds.forEach(invalidateCache);
            }
            notifyCacheChangeListeners(slotIds);
        };
    } catch {
        cacheSyncChannel = null;
    }
    return cacheSyncChannel;
}

function publishCacheChange(slotIds) {
    const normalized = normalizeChangedSlotIds(slotIds);
    if (normalized !== null && normalized.length === 0) return;
    try {
        ensureCacheSyncChannel()?.postMessage({ type: 'invalidate', slotIds: normalized });
    } catch {}
}

export function subscribeGalleryCacheChanges(listener) {
    if (typeof listener !== 'function') return () => {};
    cacheChangeListeners.add(listener);
    ensureCacheSyncChannel();
    return () => cacheChangeListeners.delete(listener);
}

function normalizePreviewBase64(value = '') {
    const parsed = parseBase64Image(value);
    if (!parsed?.data) return '';
    return `data:${parsed.mime};base64,${parsed.data}`;
}

// ═══════════════════════════════════════════════════════════════════════════
// 工具函数
// ═══════════════════════════════════════════════════════════════════════════

function getChatCharacterName() {
    const ctx = getContext();
    if (ctx.groupId) return String(ctx.groups?.[ctx.groupId]?.id ?? 'group');
    return String(ctx.characters?.[ctx.characterId]?.name || 'character');
}

function showToast(message, type = 'success', duration = 2500) {
    const colors = { success: 'rgba(62,207,142,0.95)', error: 'rgba(248,113,113,0.95)', info: `rgba(${XB_ACCENT_RGB},0.95)` };
    const textColor = colors[type] ? (type === 'info' ? XB_ON_ACCENT : '#fff') : XB_ON_ACCENT;
    const toast = document.createElement('div');
    toast.textContent = message;
    toast.style.cssText = `position:fixed;top:20px;left:50%;transform:translateX(-50%);background:${colors[type] || colors.info};color:${textColor};padding:10px 20px;border-radius:8px;font-size:13px;z-index:99999;animation:fadeInOut ${duration/1000}s ease-in-out;max-width:80vw;text-align:center;word-break:break-all`;
    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), duration);
}

// ═══════════════════════════════════════════════════════════════════════════
// IndexedDB 操作
// ═══════════════════════════════════════════════════════════════════════════

function isDbValid() {
    if (!db) return false;
    try {
        return db.objectStoreNames.length > 0;
    } catch {
        return false;
    }
}

export async function openDB() {
    if (dbOpening) return dbOpening;
    
    if (isDbValid() && db.objectStoreNames.contains(DB_SELECTIONS_STORE)) {
        return db;
    }
    
    if (db) {
        try { db.close(); } catch {}
        db = null;
    }
    
    dbOpening = new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);
        
        request.onerror = () => {
            dbOpening = null;
            reject(request.error);
        };
        
        request.onsuccess = () => {
            db = request.result;
            db.onclose = () => { db = null; };
            db.onversionchange = () => { db.close(); db = null; };
            dbOpening = null;
            resolve(db);
        };
        
        request.onupgradeneeded = (e) => {
            const database = e.target.result;
            if (!database.objectStoreNames.contains(DB_STORE)) {
                const store = database.createObjectStore(DB_STORE, { keyPath: 'imgId' });
                ['messageId', 'chatId', 'timestamp', 'slotId', 'characterName'].forEach(idx => store.createIndex(idx, idx));
            } else {
                const store = e.target.transaction.objectStore(DB_STORE);
                ['messageId', 'chatId', 'timestamp', 'slotId', 'characterName'].forEach((idx) => {
                    if (!store.indexNames.contains(idx)) {
                        store.createIndex(idx, idx);
                    }
                });
            }
            if (!database.objectStoreNames.contains(DB_SELECTIONS_STORE)) {
                database.createObjectStore(DB_SELECTIONS_STORE, { keyPath: 'slotId' });
            }
        };
    });
    
    return dbOpening;
}

// ═══════════════════════════════════════════════════════════════════════════
// 选中状态管理
// ═══════════════════════════════════════════════════════════════════════════

export async function setSlotSelection(slotId, imgId) {
    const database = await openDB();
    if (!database.objectStoreNames.contains(DB_SELECTIONS_STORE)) return;
    return new Promise((resolve, reject) => {
        try {
            const tx = database.transaction(DB_SELECTIONS_STORE, 'readwrite');
            tx.objectStore(DB_SELECTIONS_STORE).put({ slotId, selectedImgId: imgId, timestamp: Date.now() });
            tx.oncomplete = () => {
                publishCacheChange([slotId]);
                resolve();
            };
            tx.onerror = () => reject(tx.error);
        } catch (e) {
            reject(e);
        }
    });
}

export async function getSlotSelection(slotId) {
    const database = await openDB();
    if (!database.objectStoreNames.contains(DB_SELECTIONS_STORE)) return null;
    return new Promise((resolve, reject) => {
        try {
            const tx = database.transaction(DB_SELECTIONS_STORE, 'readonly');
            const request = tx.objectStore(DB_SELECTIONS_STORE).get(slotId);
            request.onsuccess = () => resolve(request.result?.selectedImgId || null);
            request.onerror = () => reject(request.error);
        } catch (e) {
            reject(e);
        }
    });
}

export async function exportPortablePreviewsForSlots(slotIds = []) {
    const slots = [...new Set((Array.isArray(slotIds) ? slotIds : [])
        .map((slotId) => String(slotId || '').trim())
        .filter(Boolean))];
    const previews = [];
    const selections = [];
    const skipped = [];
    for (const slotId of slots) {
        const display = await getDisplayPreviewForSlot(slotId).catch(() => null);
        const preview = display?.preview || null;
        const imgId = String(preview?.imgId || '').trim();
        if (!imgId) {
            skipped.push({ slotId, imgId: '', reason: 'image_preview_missing' });
            continue;
        }
        let base64 = normalizePreviewBase64(preview.base64);
        if (!base64 && preview.savedUrl) {
            base64 = await savedUrlToDataUrl(preview.savedUrl).catch(() => '');
        }
        if (!base64) {
            skipped.push({ slotId, imgId, reason: 'image_data_missing' });
            continue;
        }
        previews.push({
            imgId,
            slotId,
            messageId: String(preview.messageId || ''),
            chatId: String(preview.chatId || ''),
            characterName: String(preview.characterName || ''),
            source: String(preview.source || ''),
            bookId: String(preview.bookId || ''),
            bookTitle: String(preview.bookTitle || ''),
            chapterPath: String(preview.chapterPath || ''),
            chapterTitle: String(preview.chapterTitle || ''),
            base64,
            tags: String(preview.tags || ''),
            positive: String(preview.positive || ''),
            status: preview.status === 'failed' ? 'failed' : 'success',
            errorType: preview.errorType || null,
            errorMessage: preview.errorMessage || null,
            characterPrompts: preview.characterPrompts || null,
            negativePrompt: preview.negativePrompt || null,
            timestamp: Number(preview.timestamp) || Date.now(),
        });
        selections.push({ slotId, selectedImgId: imgId });
    }
    return { slots, previews, selections, skipped };
}

export async function importPortablePreviews(previews = [], selections = [], options = {}) {
    const database = await openDB();
    const bookId = String(options.bookId || '').trim();
    const bookTitle = String(options.bookTitle || '').trim();
    const records = (Array.isArray(previews) ? previews : [])
        .map((preview) => ({
            ...preview,
            imgId: String(preview?.imgId || '').trim(),
            slotId: String(preview?.slotId || preview?.imgId || '').trim(),
            bookId: bookId || String(preview?.bookId || ''),
            bookTitle: bookTitle || String(preview?.bookTitle || ''),
            base64: normalizePreviewBase64(preview?.base64),
            timestamp: Number(preview?.timestamp) || Date.now(),
            savedUrl: null,
        }))
        .filter((preview) => preview.imgId && preview.slotId && preview.base64);
    const selectionRows = (Array.isArray(selections) ? selections : [])
        .map((selection) => ({
            slotId: String(selection?.slotId || '').trim(),
            selectedImgId: String(selection?.selectedImgId || '').trim(),
            timestamp: Date.now(),
        }))
        .filter((selection) => selection.slotId && selection.selectedImgId);
    if (!records.length && !selectionRows.length) return { importedPreviews: 0, importedSelections: 0 };

    await new Promise((resolve, reject) => {
        try {
            const stores = [DB_STORE];
            if (database.objectStoreNames.contains(DB_SELECTIONS_STORE)) stores.push(DB_SELECTIONS_STORE);
            const tx = database.transaction(stores, 'readwrite');
            const previewStore = tx.objectStore(DB_STORE);
            records.forEach((record) => previewStore.put(record));
            if (stores.includes(DB_SELECTIONS_STORE)) {
                const selectionStore = tx.objectStore(DB_SELECTIONS_STORE);
                selectionRows.forEach((selection) => selectionStore.put(selection));
            }
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
        } catch (error) {
            reject(error);
        }
    });
    const changedSlotIds = [...new Set([
        ...records.map(record => record.slotId),
        ...selectionRows.map(selection => selection.slotId),
    ])];
    records.forEach((record) => invalidateCache(record.slotId));
    publishCacheChange(changedSlotIds);
    return {
        importedPreviews: records.length,
        importedSelections: selectionRows.length,
    };
}

export async function clearSlotSelection(slotId) {
    const database = await openDB();
    if (!database.objectStoreNames.contains(DB_SELECTIONS_STORE)) return;
    return new Promise((resolve, reject) => {
        try {
            const tx = database.transaction(DB_SELECTIONS_STORE, 'readwrite');
            tx.objectStore(DB_SELECTIONS_STORE).delete(slotId);
            tx.oncomplete = () => {
                publishCacheChange([slotId]);
                resolve();
            };
            tx.onerror = () => reject(tx.error);
        } catch (e) {
            reject(e);
        }
    });
}

// ═══════════════════════════════════════════════════════════════════════════
// 预览存储
// ═══════════════════════════════════════════════════════════════════════════

export async function storePreview(opts) {
    const {
        imgId,
        slotId,
        messageId,
        base64 = null,
        tags,
        positive,
        savedUrl = null,
        status = 'success',
        errorType = null,
        errorMessage = null,
        characterPrompts = null,
        negativePrompt = null,
        source = '',
        chatId = '',
        characterName = '',
        bookId = '',
        bookTitle = '',
        chapterPath = '',
        chapterTitle = '',
        // V2 生成参数快照（给画廊导出用）：{prompt, uc, seed, model, steps, scale, sampler, noiseSchedule,
        // width, height, smea, dyn, cfgRescale, characterPrompts, vibes 摘要}；不含 API Key。旧记录没有，按「无」处理。
        params = null,
    } = opts;
    const database = await openDB();
    const ctx = getContext();
    const resolvedChatId = String(chatId || ctx.chatId || (ctx.characterId || 'unknown'));
    const resolvedCharacterName = String(characterName || getChatCharacterName());
    const resolvedSlotId = slotId || imgId;
    
    return new Promise((resolve, reject) => {
        try {
            const tx = database.transaction(DB_STORE, 'readwrite');
            tx.objectStore(DB_STORE).put({
                imgId,
                slotId: resolvedSlotId,
                messageId,
                chatId: resolvedChatId,
                characterName: resolvedCharacterName,
                source,
                bookId,
                bookTitle,
                chapterPath,
                chapterTitle,
                base64,
                tags,
                positive,
                savedUrl,
                status,
                errorType,
                errorMessage,
                characterPrompts,
                negativePrompt,
                params: params && typeof params === 'object' ? params : null,
                timestamp: Date.now()
            });
            tx.oncomplete = () => {
                invalidateCache(resolvedSlotId);
                publishCacheChange([resolvedSlotId]);
                resolve();
            };
            tx.onerror = () => reject(tx.error);
        } catch (e) {
            reject(e);
        }
    });
}

export async function storeFailedPlaceholder(opts) {
    return storePreview({
        imgId: opts.imgId || `failed-${opts.slotId}-${Date.now()}`,
        slotId: opts.slotId,
        messageId: opts.messageId,
        source: opts.source || '',
        chatId: opts.chatId || '',
        characterName: opts.characterName || '',
        bookId: opts.bookId || '',
        bookTitle: opts.bookTitle || '',
        chapterPath: opts.chapterPath || '',
        chapterTitle: opts.chapterTitle || '',
        base64: null,
        tags: opts.tags,
        positive: opts.positive,
        status: 'failed',
        errorType: opts.errorType,
        errorMessage: opts.errorMessage,
        characterPrompts: opts.characterPrompts || null,
        negativePrompt: opts.negativePrompt || null,
    });
}

export async function getPreview(imgId) {
    const database = await openDB();
    return new Promise((resolve, reject) => {
        try {
            const tx = database.transaction(DB_STORE, 'readonly');
            const request = tx.objectStore(DB_STORE).get(imgId);
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        } catch (e) {
            reject(e);
        }
    });
}

export async function getPreviewsBySlot(slotId) {
    const cached = getCachedPreviews(slotId);
    if (cached) return cached;
    
    const database = await openDB();
    return new Promise((resolve, reject) => {
        try {
            const tx = database.transaction(DB_STORE, 'readonly');
            const store = tx.objectStore(DB_STORE);
            
            const processResults = (results) => {
                results.sort((a, b) => b.timestamp - a.timestamp);
                setCachedPreviews(slotId, results);
                resolve(results);
            };
            
            if (store.indexNames.contains('slotId')) {
                const request = store.index('slotId').getAll(slotId);
                request.onsuccess = () => {
                    if (request.result?.length) {
                        processResults(request.result);
                    } else {
                        const legacyRequest = store.get(slotId);
                        legacyRequest.onsuccess = () => {
                            const legacy = legacyRequest.result;
                            const results = legacy && (legacy.slotId === slotId || legacy.imgId === slotId || (!legacy.slotId && legacy.imgId === slotId))
                                ? [legacy]
                                : [];
                            processResults(results);
                        };
                        legacyRequest.onerror = () => reject(legacyRequest.error);
                    }
                };
                request.onerror = () => reject(request.error);
            } else {
                const results = [];
                store.openCursor().onsuccess = (event) => {
                    const cursor = event.target.result;
                    if (!cursor) {
                        processResults(results);
                        return;
                    }
                    const record = cursor.value;
                    if (record?.slotId === slotId || record?.imgId === slotId) {
                        results.push(record);
                    }
                    cursor.continue();
                };
                tx.onerror = () => reject(tx.error);
            }
        } catch (e) {
            reject(e);
        }
    });
}

export async function getDisplayPreviewForSlot(slotId) {
    const previews = await getPreviewsBySlot(slotId);
    if (!previews.length) return { preview: null, historyCount: 0, hasData: false, isFailed: false };
    
    const successPreviews = previews.filter(p => p.status !== 'failed' && (p.base64 || p.savedUrl));
    const failedPreviews = previews.filter(p => p.status === 'failed' || (!p.base64 && !p.savedUrl));
    const asFailure = (preview) => ({
        preview,
        historyCount: successPreviews.length,
        hasData: false,
        isFailed: true,
        failedInfo: {
            tags: preview?.tags || '',
            positive: preview?.positive || '',
            errorType: preview?.errorType,
            errorMessage: preview?.errorMessage,
        },
    });
    
    if (successPreviews.length === 0) {
        return asFailure(failedPreviews[0]);
    }
    
    const selectedImgId = await getSlotSelection(slotId);
    if (selectedImgId) {
        const selectedFailure = failedPreviews.find(p => p.imgId === selectedImgId);
        if (selectedFailure) return asFailure(selectedFailure);
        const selected = successPreviews.find(p => p.imgId === selectedImgId);
        if (selected) {
            return { preview: selected, historyCount: successPreviews.length, hasData: true, isFailed: false };
        }
    }
    
    return { preview: successPreviews[0], historyCount: successPreviews.length, hasData: true, isFailed: false };
}

export async function getLatestPreviewForSlot(slotId) {
    const result = await getDisplayPreviewForSlot(slotId);
    return result.preview;
}

export async function deletePreview(imgId) {
    const database = await openDB();
    const preview = await getPreview(imgId);
    const slotId = preview?.slotId;
    
    return new Promise((resolve, reject) => {
        try {
            const tx = database.transaction(DB_STORE, 'readwrite');
            tx.objectStore(DB_STORE).delete(imgId);
            tx.oncomplete = () => {
                revokePreviewObjectUrl(imgId);
                if (slotId) invalidateCache(slotId);
                publishCacheChange(slotId ? [slotId] : []);
                resolve();
            };
            tx.onerror = () => reject(tx.error);
        } catch (e) {
            reject(e);
        }
    });
}

export async function deleteFailedRecordsForSlot(slotId) {
    const previews = await getPreviewsBySlot(slotId);
    const failedRecords = previews.filter(p => p.status === 'failed' || (!p.base64 && !p.savedUrl));
    for (const record of failedRecords) {
        await deletePreview(record.imgId);
    }
}

export async function getCacheStats() {
    const database = await openDB();
    return new Promise((resolve) => {
        try {
            const tx = database.transaction(DB_STORE, 'readonly');
            const store = tx.objectStore(DB_STORE);
            const countReq = store.count();
            let totalSize = 0, successCount = 0, failedCount = 0;
            
            store.openCursor().onsuccess = (e) => {
                const cursor = e.target.result;
                if (cursor) { 
                    totalSize += (cursor.value.base64?.length || 0) * 0.75;
                    if (cursor.value.status === 'failed' || (!cursor.value.base64 && !cursor.value.savedUrl)) {
                        failedCount++;
                    } else {
                        successCount++;
                    }
                    cursor.continue(); 
                }
            };
            tx.oncomplete = () => resolve({ 
                count: countReq.result || 0, 
                successCount,
                failedCount,
                sizeBytes: Math.round(totalSize), 
                sizeMB: (totalSize / 1024 / 1024).toFixed(2) 
            });
        } catch {
            resolve({ count: 0, successCount: 0, failedCount: 0, sizeBytes: 0, sizeMB: '0' });
        }
    });
}

export async function clearExpiredCache(cacheDays = 3) {
    const cutoff = Date.now() - cacheDays * 24 * 60 * 60 * 1000;
    const database = await openDB();
    let cleaned = 0;
    
    return new Promise((resolve) => {
        try {
            const tx = database.transaction(DB_STORE, 'readwrite');
            const store = tx.objectStore(DB_STORE);
            store.openCursor().onsuccess = (e) => {
                const cursor = e.target.result;
                if (cursor) { 
                    const record = cursor.value;
                    const isExpiredUnsaved = record.timestamp < cutoff && !record.savedUrl;
                    const isFailed = record.status === 'failed' || (!record.base64 && !record.savedUrl);
                    const shouldTrimSavedBase64 = !!record.savedUrl && !!record.base64;

                    if (isExpiredUnsaved || (isFailed && record.timestamp < cutoff)) { 
                        revokePreviewObjectUrl(record.imgId);
                        cursor.delete(); 
                        cleaned++; 
                        cursor.continue(); 
                        return;
                    }

                    if (shouldTrimSavedBase64) {
                        record.base64 = null;
                        revokePreviewObjectUrl(record.imgId);
                        cursor.update(record);
                        cleaned++;
                    }

                    cursor.continue(); 
                }
            };
            tx.oncomplete = () => {
                invalidateCache();
                if (cleaned > 0) publishCacheChange(null);
                resolve(cleaned);
            };
        } catch {
            resolve(0);
        }
    });
}

export async function clearAllCache() {
    const database = await openDB();
    return new Promise((resolve, reject) => {
        try {
            const stores = [DB_STORE];
            if (database.objectStoreNames.contains(DB_SELECTIONS_STORE)) {
                stores.push(DB_SELECTIONS_STORE);
            }
            const tx = database.transaction(stores, 'readwrite');
            tx.objectStore(DB_STORE).clear();
            if (stores.length > 1) {
                tx.objectStore(DB_SELECTIONS_STORE).clear();
            }
            tx.oncomplete = () => {
                clearPreviewObjectUrls();
                invalidateCache();
                publishCacheChange(null);
                resolve();
            };
            tx.onerror = () => reject(tx.error);
        } catch (e) {
            reject(e);
        }
    });
}

export async function getGallerySummary() {
    const database = await openDB();
    return new Promise((resolve) => {
        try {
            const tx = database.transaction(DB_STORE, 'readonly');
            const store = tx.objectStore(DB_STORE);
            const summary = {};

            store.openCursor().onsuccess = (event) => {
                const cursor = event.target.result;
                if (!cursor) {
                    resolve(summary);
                    return;
                }
                const item = cursor.value;
                if (item.status !== 'failed' && (item.base64 || item.savedUrl)) {
                    const charName = item.characterName || 'Unknown';
                    if (!summary[charName]) {
                        summary[charName] = { count: 0, totalSize: 0, slots: {}, latestTimestamp: 0 };
                    }

                    const slotId = item.slotId || item.imgId;
                    if (!summary[charName].slots[slotId]) {
                        summary[charName].slots[slotId] = { count: 0, hasSaved: false, latestTimestamp: 0, latestImgId: null };
                    }

                    const slot = summary[charName].slots[slotId];
                    slot.count++;
                    if (item.savedUrl) slot.hasSaved = true;
                    if (item.timestamp > slot.latestTimestamp) {
                        slot.latestTimestamp = item.timestamp;
                        slot.latestImgId = item.imgId;
                    }

                    summary[charName].count++;
                    summary[charName].totalSize += (item.base64?.length || 0) * 0.75;
                    if (item.timestamp > summary[charName].latestTimestamp) {
                        summary[charName].latestTimestamp = item.timestamp;
                    }
                }
                cursor.continue();
            };
            tx.onerror = () => resolve({});
        } catch {
            resolve({});
        }
    });
}

export async function getCharacterPreviews(charName) {
    const database = await openDB();
    return new Promise((resolve) => {
        try {
            const tx = database.transaction(DB_STORE, 'readonly');
            const store = tx.objectStore(DB_STORE);
            const slots = {};
            const pushItem = (item) => {
                if ((item.characterName || 'Unknown') !== charName) return;
                if (item.status === 'failed' || (!item.base64 && !item.savedUrl)) return;

                const slotId = item.slotId || item.imgId;
                if (!slots[slotId]) slots[slotId] = [];
                slots[slotId].push(item);
            };
            const finish = () => {
                for (const sid in slots) {
                    slots[sid].sort((a, b) => b.timestamp - a.timestamp);
                }
                resolve(slots);
            };

            if (store.indexNames.contains('characterName') && charName !== 'Unknown') {
                const request = store.index('characterName').getAll(charName);
                request.onsuccess = () => {
                    (request.result || []).forEach(pushItem);
                    finish();
                };
                request.onerror = () => resolve({});
                return;
            }

            store.openCursor().onsuccess = (event) => {
                const cursor = event.target.result;
                if (!cursor) {
                    finish();
                    return;
                }
                const item = cursor.value;
                pushItem(item);
                cursor.continue();
            };
            tx.onerror = () => resolve({});
        } catch {
            resolve({});
        }
    });
}

// ═══════════════════════════════════════════════════════════════════════════
// 小画廊 UI
// ═══════════════════════════════════════════════════════════════════════════

// 灯箱 UI 在 image-lightbox.js（不依赖酒馆模块）。这里只注入下载。
// 不再有缩略条和删除；长按图片弹出操作面板，扩展项用 registerLightboxAction 注册。
export async function openGallery(slotId, messageId) {
    const previews = await getPreviewsBySlot(slotId);
    const validPreviews = previews.filter(p => p.status !== 'failed' && (p.base64 || p.savedUrl));

    if (!validPreviews.length) {
        showToast('没有找到图片历史', 'error');
        return null;
    }

    const selectedImgId = await getSlotSelection(slotId);
    let startIndex = 0;
    if (selectedImgId) {
        const idx = validPreviews.findIndex(p => p.imgId === selectedImgId);
        if (idx >= 0) startIndex = idx;
    }

    ensureLightboxStyles();
    return openImageLightbox({
        previews: validPreviews,
        startIndex,
        slotId,
        messageId,
        getUrl: getPreviewDisplayUrl,
        onDownload: async (current) => {
            const name = await downloadImageOriginal(current);
            showToast(`已开始下载原图：${name}`, 'info');
            return name;
        },
        onError: (error, kind) => {
            console.error('[GalleryCache] 灯箱操作失败:', kind, error);
            showToast(`操作失败: ${error?.message || error}`, 'error');
        },
    });
}

export function closeGallery() {
    closeImageLightbox();
}

// ═══════════════════════════════════════════════════════════════════════════
// 清理
// ═══════════════════════════════════════════════════════════════════════════

export function destroyGalleryCache() {
    closeGallery();
    invalidateCache();
    clearPreviewObjectUrls();
    
    document.getElementById('nd-gallery-overlay')?.remove();
    document.getElementById(LIGHTBOX_STYLE_ID)?.remove();
    
    if (db) {
        try { db.close(); } catch {}
        db = null;
    }
    dbOpening = null;
}
