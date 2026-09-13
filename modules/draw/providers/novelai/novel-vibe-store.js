// 氛围迁移的 IndexedDB 存储：独立库 `xb_novelai_vibes`，不和画廊缓存放一起，
// 所以「清理图片缓存」不会把氛围图和编码结果带走。回滚代码也不会动它，需要时手动清。
//
// assets    keyPath assetId（= 原图 sha256）
//           {assetId, name, mime, width, height, image: Blob|null, thumbnail: Blob|string|null, source, createdAt}
// encodings keyPath key（= assetId|model|ie.toFixed(2)），索引 assetId
//           {key, assetId, model, informationExtracted, token: base64, bytes, origin: 'api'|'import', createdAt}
import { makeVibeEncodingKey } from './novel-vibe-format.js';

export const VIBE_DB_NAME = 'xb_novelai_vibes';
export const VIBE_DB_VERSION = 1;
const ASSETS = 'assets';
const ENCODINGS = 'encodings';

function promisifyRequest(request) {
    return new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

function transactionDone(tx) {
    return new Promise((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onabort = () => reject(tx.error || new Error('IndexedDB transaction aborted'));
        tx.onerror = () => reject(tx.error);
    });
}

export function createVibeStore({ indexedDB: idb = globalThis.indexedDB, name = VIBE_DB_NAME } = {}) {
    let dbPromise = null;

    function open() {
        if (!idb) return Promise.reject(new Error('当前环境没有 IndexedDB，无法保存氛围图'));
        dbPromise ||= new Promise((resolve, reject) => {
            const request = idb.open(name, VIBE_DB_VERSION);
            request.onupgradeneeded = () => {
                const db = request.result;
                if (!db.objectStoreNames.contains(ASSETS)) {
                    db.createObjectStore(ASSETS, { keyPath: 'assetId' });
                }
                if (!db.objectStoreNames.contains(ENCODINGS)) {
                    const store = db.createObjectStore(ENCODINGS, { keyPath: 'key' });
                    store.createIndex('assetId', 'assetId', { unique: false });
                }
            };
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => {
                dbPromise = null;
                reject(request.error);
            };
        });
        return dbPromise;
    }

    async function run(storeNames, mode, work) {
        const db = await open();
        const tx = db.transaction(storeNames, mode);
        const done = transactionDone(tx);
        const result = await work(tx);
        await done;
        return result;
    }

    return {
        open,
        async putAsset(asset) {
            if (!asset?.assetId) throw new TypeError('氛围图缺少 assetId');
            const record = { createdAt: Date.now(), ...asset };
            await run([ASSETS], 'readwrite', tx => promisifyRequest(tx.objectStore(ASSETS).put(record)));
            return record;
        },
        getAsset(assetId) {
            return run([ASSETS], 'readonly', tx => promisifyRequest(tx.objectStore(ASSETS).get(String(assetId))));
        },
        listAssets() {
            return run([ASSETS], 'readonly', tx => promisifyRequest(tx.objectStore(ASSETS).getAll()));
        },
        /** 删除氛围图及它的全部编码（同一事务）。 */
        deleteAsset(assetId) {
            const id = String(assetId);
            return run([ASSETS, ENCODINGS], 'readwrite', async (tx) => {
                tx.objectStore(ASSETS).delete(id);
                const keys = await promisifyRequest(tx.objectStore(ENCODINGS).index('assetId').getAllKeys(id));
                keys.forEach(key => tx.objectStore(ENCODINGS).delete(key));
            });
        },
        async putEncoding({ assetId, model, informationExtracted, token, bytes, origin = 'api', createdAt = Date.now() }) {
            if (!assetId || !model || !token) throw new TypeError('编码记录缺少 assetId / model / token');
            const record = {
                key: makeVibeEncodingKey(assetId, model, informationExtracted),
                assetId: String(assetId),
                model: String(model),
                informationExtracted: Number(Number(informationExtracted).toFixed(2)),
                token,
                bytes: Number(bytes) || 0,
                origin,
                createdAt,
            };
            await run([ENCODINGS], 'readwrite', tx => promisifyRequest(tx.objectStore(ENCODINGS).put(record)));
            return record;
        },
        getEncoding(assetId, model, informationExtracted) {
            const key = makeVibeEncodingKey(assetId, model, informationExtracted);
            return run([ENCODINGS], 'readonly', tx => promisifyRequest(tx.objectStore(ENCODINGS).get(key)));
        },
        listEncodings(assetId) {
            return run([ENCODINGS], 'readonly', tx => promisifyRequest(
                tx.objectStore(ENCODINGS).index('assetId').getAll(String(assetId)),
            ));
        },
        async close() {
            if (!dbPromise) return;
            const db = await dbPromise.catch(() => null);
            db?.close();
            dbPromise = null;
        },
    };
}

let defaultStore = null;
export function getVibeStore() {
    defaultStore ||= createVibeStore();
    return defaultStore;
}
