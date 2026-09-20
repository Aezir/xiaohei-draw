// 生图日志的存储（浏览器）。只存本机 IndexedDB（库 xb_draw_logs），不写酒馆设置文件。
// 所有对外函数都自己吞错：日志坏了不能影响生图和楼层渲染。纯逻辑在 draw-log.js。

import {
    DRAW_LOG_MAX_ENTRIES,
    applyRenderReport,
    createDrawLogEntry,
    describeError,
    failEntry,
    finishEntryFromResult,
    foldAgentDiagnostic,
    summarizeNaiRequest,
    trimDrawLogEntries,
} from './draw-log.js';

const DB_NAME = 'xb_draw_logs';
const STORE_NAME = 'entries';
// 配图结束后这么久之内，这个楼层的重渲染（自愈补发、MVU 覆盖后补回）还算进这条日志
const RENDER_LINGER_MS = 30000;
const FLUSH_DELAY_MS = 600;
const NOTIFY_DELAY_MS = 300;

const memory = new Map();
const dirtyIds = new Set();
const removedIds = new Set();
const listeners = new Set();
const messageOwners = new Map();
const renderOwners = new Map();
let dbPromise = null;
let loadPromise = null;
let flushTimer = null;
let notifyTimer = null;
let mvuBusyProbe = null;

function warn(error) {
    try {
        console.warn('[小黑生图] 日志记录出错（不影响生图）:', error);
    } catch { /* ignore */ }
}

function safe(fn, fallback = undefined) {
    try {
        return fn();
    } catch (error) {
        warn(error);
        return fallback;
    }
}

function openDb() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve) => {
        try {
            if (typeof indexedDB === 'undefined') return resolve(null);
            const request = indexedDB.open(DB_NAME, 1);
            request.onupgradeneeded = () => {
                const db = request.result;
                if (!db.objectStoreNames.contains(STORE_NAME)) db.createObjectStore(STORE_NAME, { keyPath: 'id' });
            };
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => resolve(null);
            request.onblocked = () => resolve(null);
        } catch {
            resolve(null);
        }
    });
    return dbPromise;
}

function ensureLoaded() {
    loadPromise ||= (async () => {
        const db = await openDb();
        if (!db) return;
        const stored = await new Promise((resolve) => {
            try {
                const request = db.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).getAll();
                request.onsuccess = () => resolve(Array.isArray(request.result) ? request.result : []);
                request.onerror = () => resolve([]);
            } catch {
                resolve([]);
            }
        });
        for (const entry of stored) {
            if (!entry?.id || memory.has(entry.id)) continue;
            // 上次页面关掉 / 刷新时还没跑完的：结果没记录到
            if (entry.status === 'running') {
                entry.status = 'failed';
                entry.error = { code: '', label: '没记录到结果', message: '配图过程中页面被关闭或刷新了' };
                dirtyIds.add(entry.id);
            }
            memory.set(entry.id, entry);
        }
        trimMemory();
    })().catch(warn);
    return loadPromise;
}

function trimMemory() {
    const { removedIds: removed } = trimDrawLogEntries([...memory.values()], DRAW_LOG_MAX_ENTRIES);
    for (const id of removed) {
        memory.delete(id);
        dirtyIds.delete(id);
        removedIds.add(id);
    }
}

function scheduleFlush(immediate = false) {
    if (flushTimer) clearTimeout(flushTimer);
    flushTimer = setTimeout(() => {
        flushTimer = null;
        void flush();
    }, immediate ? 0 : FLUSH_DELAY_MS);
}

async function flush() {
    try {
        const db = await openDb();
        if (!db) return;
        const puts = [...dirtyIds].map(id => memory.get(id)).filter(Boolean);
        const deletes = [...removedIds];
        dirtyIds.clear();
        removedIds.clear();
        if (!puts.length && !deletes.length) return;
        await new Promise((resolve) => {
            try {
                const tx = db.transaction(STORE_NAME, 'readwrite');
                const store = tx.objectStore(STORE_NAME);
                for (const entry of puts) store.put(entry);
                for (const id of deletes) store.delete(id);
                tx.oncomplete = () => resolve();
                tx.onerror = () => resolve();
                tx.onabort = () => resolve();
            } catch (error) {
                warn(error);
                resolve();
            }
        });
    } catch (error) {
        warn(error);
    }
}

function notify() {
    if (notifyTimer) return;
    notifyTimer = setTimeout(() => {
        notifyTimer = null;
        for (const listener of [...listeners]) safe(() => listener());
    }, NOTIFY_DELAY_MS);
}

function touch(id) {
    dirtyIds.add(id);
    trimMemory();
    scheduleFlush();
    notify();
}

function updateEntry(id, change) {
    safe(() => {
        const current = memory.get(id);
        if (!current) return;
        const next = change(current);
        if (!next) return;
        memory.set(id, next);
        touch(id);
    });
}

const NOOP_HANDLE = Object.freeze({
    id: '',
    agent() {},
    naiPrepared() { return 0; },
    naiResult() {},
    naiShown() {},
    note() {},
    finish() {},
    fail() {},
});

/**
 * 一次配图开一条日志。返回的 handle 方法全部不抛错。
 * @param {{ kind?: 'message'|'text', messageId?: number|null, automatic?: boolean }} options
 */
export function beginDrawLog(options = {}) {
    return safe(() => {
        const entry = createDrawLogEntry(options);
        const id = entry.id;
        memory.set(id, entry);
        touch(id);
        void ensureLoaded();
        if (entry.kind === 'message' && entry.messageId !== null) {
            messageOwners.set(entry.messageId, { entryId: id, until: Infinity });
        }
        let released = false;
        const release = () => {
            if (released) return;
            released = true;
            const owner = messageOwners.get(entry.messageId);
            if (owner?.entryId === id) owner.until = Date.now() + RENDER_LINGER_MS;
        };
        return {
            id,
            agent(snapshot) {
                updateEntry(id, current => ({ ...current, agent: foldAgentDiagnostic(current.agent, snapshot) }));
            },
            /** 记下这一批实际要发的 NAI 请求，返回这批在 images 里的起始下标 */
            naiPrepared(preparedList, requests = [], sendMode = '') {
                let offset = 0;
                updateEntry(id, (current) => {
                    const images = [...(current.nai?.images || [])];
                    offset = images.length;
                    (Array.isArray(preparedList) ? preparedList : []).forEach((prepared, index) => {
                        images.push({ state: 'pending', request: summarizeNaiRequest(prepared, requests?.[index]), error: null });
                    });
                    return { ...current, nai: { sendMode: String(sendMode || current.nai?.sendMode || ''), images } };
                });
                return offset;
            },
            naiResult(index, { state = 'ready', error = null, classified = null } = {}) {
                updateEntry(id, (current) => {
                    const images = [...(current.nai?.images || [])];
                    if (!images[index]) return null;
                    images[index] = {
                        ...images[index],
                        state,
                        error: error || classified ? describeError(error, classified) : null,
                        finishedAt: Date.now(),
                    };
                    return { ...current, nai: { ...current.nai, images } };
                });
            },
            /** 楼层配图：这张图的卡有没有立刻插进楼层、被冲掉后补插了几次（{ immediate, reinserts, misses }） */
            naiShown(index, shown) {
                updateEntry(id, (current) => {
                    const images = [...(current.nai?.images || [])];
                    if (!images[index]) return null;
                    images[index] = { ...images[index], shown: { ...(images[index].shown || {}), ...(shown || {}) } };
                    return { ...current, nai: { ...current.nai, images } };
                });
            },
            /** 备注（正文被改写后的近似定位之类），多条用「；」接起来 */
            note(text) {
                const value = String(text || '').trim();
                if (!value) return;
                updateEntry(id, current => ({ ...current, note: current.note ? `${current.note}；${value}` : value }));
            },
            finish(result) {
                updateEntry(id, current => finishEntryFromResult(current, result));
                release();
            },
            fail(error, classified = null) {
                updateEntry(id, current => failEntry(current, error, classified));
                release();
            },
        };
    }, NOOP_HANDLE);
}

/** message-rerender.js 的 onRenderReport 报告（draw-common.js 补好 MVU / 状态栏信息后）交到这里。 */
export function reportRenderToDrawLog(report) {
    safe(() => {
        if (!report || typeof report !== 'object') return;
        const renderKey = String(report.renderId ?? '');
        if (!renderKey) return;
        let entryId = renderOwners.get(renderKey);
        if (!entryId && (report.stage === 'rendered' || report.stage === 'skipped' || report.stage === 'error')) {
            const owner = messageOwners.get(Number(report.messageId));
            if (!owner || owner.until < Date.now() || !memory.has(owner.entryId)) return;
            entryId = owner.entryId;
            renderOwners.set(renderKey, entryId);
            if (renderOwners.size > 500) renderOwners.delete(renderOwners.keys().next().value);
        }
        if (!entryId) return;
        updateEntry(entryId, current => ({ ...current, renders: applyRenderReport(current.renders, report) }));
    });
}

/** 有进行中 / 刚结束的配图在盯这个楼层吗（没有就不必去查 DOM）。 */
export function isDrawLogWatchingMessage(messageId) {
    return safe(() => {
        const owner = messageOwners.get(Number(messageId));
        return !!owner && owner.until >= Date.now();
    }, false);
}

export function setDrawLogMvuBusyProbe(probe) {
    mvuBusyProbe = typeof probe === 'function' ? probe : null;
}

export function readDrawLogMvuBusy() {
    return safe(() => (mvuBusyProbe ? mvuBusyProbe() === true : null), null);
}

export async function listDrawLogs() {
    try {
        await ensureLoaded();
        return trimDrawLogEntries([...memory.values()], DRAW_LOG_MAX_ENTRIES).kept;
    } catch (error) {
        warn(error);
        return [];
    }
}

export async function clearDrawLogs() {
    try {
        await ensureLoaded();
        for (const id of memory.keys()) removedIds.add(id);
        memory.clear();
        dirtyIds.clear();
        messageOwners.clear();
        renderOwners.clear();
        await flush();
        notify();
        return true;
    } catch (error) {
        warn(error);
        return false;
    }
}

export function subscribeDrawLogs(listener) {
    if (typeof listener !== 'function') return () => {};
    listeners.add(listener);
    return () => listeners.delete(listener);
}
