// 画廊模块共用的极简键值存储：IndexedDB 版（页面里用）+ 内存版（测试 / 没有 IndexedDB 的环境）。
// 两个版本接口一样：get(k) → 值|undefined、set(k, v)、del(k)、clear()、keys()、close()。
// 值按结构化克隆存取（Uint8Array、Blob、普通对象都行），取出来的是副本，改它不影响库里的。

const err = (message, extra) => Object.assign(new Error(message), extra);

/**
 * @param {string} dbName  IndexedDB 数据库名（每个用途一个库，断开时可以整库清空）
 * @param {{store?: string, indexedDB?: IDBFactory}} [opts]  indexedDB 可注入（测试用内存垫片）
 */
export function createIdbKv(dbName, { store = 'kv', indexedDB = globalThis.indexedDB } = {}) {
    if (!indexedDB) throw err('这个环境没有 IndexedDB', { code: 'noidb' });
    let dbp = null;
    const open = () => dbp || (dbp = new Promise((ok, no) => {
        const req = indexedDB.open(dbName, 1);
        req.onupgradeneeded = () => {
            const db = req.result;
            if (!db.objectStoreNames.contains(store)) db.createObjectStore(store);
        };
        req.onsuccess = () => ok(req.result);
        req.onerror = () => { dbp = null; no(req.error || err(`打不开 IndexedDB：${dbName}`, { code: 'idb' })); };
    }));
    const run = async (mode, fn) => {
        const db = await open();
        return new Promise((ok, no) => {
            const tx = db.transaction(store, mode);
            const req = fn(tx.objectStore(store));
            let val;
            if (req) req.onsuccess = () => { val = req.result; };
            tx.oncomplete = () => ok(val);
            tx.onerror = () => no(tx.error || err('IndexedDB 写入失败', { code: 'idb' }));
            tx.onabort = () => no(tx.error || err('IndexedDB 事务被中止', { code: 'idb' }));
        });
    };
    return {
        get: k => run('readonly', os => os.get(k)),
        set: (k, v) => run('readwrite', os => os.put(v, k)).then(() => undefined),
        del: k => run('readwrite', os => os.delete(k)).then(() => undefined),
        clear: () => run('readwrite', os => os.clear()).then(() => undefined),
        keys: () => run('readonly', os => os.getAllKeys()),
        async close() { if (dbp) { const db = await dbp; db.close(); } dbp = null; },
    };
}

/** 内存版：和 IndexedDB 版一样按结构化克隆存取 */
export function createMemoryKv() {
    const m = new Map();
    const copy = v => (v === undefined ? undefined : structuredClone(v));
    return {
        get: async k => copy(m.get(k)),
        set: async (k, v) => { m.set(k, copy(v)); },
        del: async k => { m.delete(k); },
        clear: async () => { m.clear(); },
        keys: async () => [...m.keys()],
        close: async () => {},
    };
}
