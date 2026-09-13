// 内存版 IndexedDB 垫片：只实现 idb-kv.js 用到的部分（open / upgradeneeded / 单库事务 get put delete clear getAllKeys）。
// 值按结构化克隆存取；同一个工厂里同名库在「重新打开」后数据还在，用来测记住登录。
export function createFakeIndexedDB() {
    const dbs = new Map();
    const later = fn => setTimeout(fn, 0);
    const request = () => ({ result: undefined, error: null, onsuccess: null, onerror: null, onupgradeneeded: null });

    function makeDb(name, rec) {
        return {
            name,
            objectStoreNames: { contains: n => rec.stores.has(n) },
            createObjectStore(n) { rec.stores.set(n, new Map()); return {}; },
            close() { rec.closed = (rec.closed || 0) + 1; },
            transaction(storeName, mode = 'readonly') {
                for (const n of [].concat(storeName)) if (!rec.stores.has(n)) throw new Error(`NotFoundError: ${n}`);
                const tx = { oncomplete: null, onerror: null, onabort: null, error: null };
                let pending = 0, done = false;
                const finish = () => { if (!done && pending === 0) { done = true; later(() => tx.oncomplete && tx.oncomplete()); } };
                tx.objectStore = (n) => {
                    const data = rec.stores.get(n);
                    const op = (fn) => {
                        const req = request();
                        pending++;
                        queueMicrotask(() => {
                            try { req.result = fn(); } catch (e) {
                                pending--; done = true; req.error = tx.error = e;
                                later(() => { if (req.onerror) req.onerror(); if (tx.onerror) tx.onerror(); });
                                return;
                            }
                            pending--;
                            if (req.onsuccess) req.onsuccess();
                            finish();
                        });
                        return req;
                    };
                    const rw = () => { if (mode !== 'readwrite') throw new Error('ReadOnlyError'); };
                    return {
                        get: k => op(() => (data.has(k) ? structuredClone(data.get(k)) : undefined)),
                        put: (v, k) => { rw(); return op(() => { data.set(k, structuredClone(v)); return k; }); },
                        delete: k => { rw(); return op(() => { data.delete(k); }); },
                        clear: () => { rw(); return op(() => { data.clear(); }); },
                        getAllKeys: () => op(() => [...data.keys()]),
                    };
                };
                later(finish);
                return tx;
            },
        };
    }

    return {
        open(name, version = 1) {
            const req = request();
            later(() => {
                let rec = dbs.get(name);
                const upgrade = !rec || rec.version < version;
                if (!rec) { rec = { version, stores: new Map() }; dbs.set(name, rec); }
                req.result = makeDb(name, rec);
                if (upgrade) { rec.version = version; if (req.onupgradeneeded) req.onupgradeneeded({}); }
                if (req.onsuccess) req.onsuccess();
            });
            return req;
        },
        deleteDatabase(name) {
            const req = request();
            later(() => { dbs.delete(name); if (req.onsuccess) req.onsuccess(); });
            return req;
        },
        /** 测试后门：所有库的原始数据 name → store → Map */
        _dump: () => dbs,
    };
}
