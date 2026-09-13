// 批量把聊天图存入画廊（G2：「图片管理」里按角色 / 单张存入）。纯逻辑，不碰 DOM、不 import 酒馆模块。
// - 目标：{kind:'local', store} 或 {kind:'remote', creds, addImages?}（和 exportChatImage 一样）。
// - 去重三层：同一批里同一张图只算一次（原图字节 → 画廊 id）；本机目标先 has(id)；远端目标先读一次仓库 state，
//   已有 / 删过的图不转 webp；真正写入时 addImages 还会按当次远端再判断一遍。
// - 写入：攒够 IMG_BATCH（30）张提交一次，不一张一提交。远端写入出错（ver / pw / guard / 403 …）整批停下，已提交的保留。
// - 单张出错（取不到图、转码失败）记进 errors，继续下一张。
import { buildGalleryEntry, resolveImageBytes } from './chat-image-export.js';
import { imageIdOf, addImages as remoteAddImages, readState as remoteReadState, IMG_BATCH } from './gallery-client.js';

const labelOf = item => String(item?.preview?.imgId || item?.preview?.slotId || '');

function remoteStatus(state, id) {
    if (!state) return null;
    const r = state.imgs && state.imgs[id];
    const deleted = (r && r.on === false) || !!(state.dels && state.dels[id] && state.dels[id].on);
    if (deleted) return 'deleted';
    return r ? 'exists' : null;
}

/**
 * @param {Array<{preview, message?, name2?}>} items
 * @param {object} opts
 * @param {object} opts.target
 * @param {boolean} [opts.reAdd=false]
 * @param {(p: {done, total, added, skipped, errors, phase}) => void} [opts.onProgress]
 * @param {object} [opts.codec]          透传 buildGalleryEntry（Node 测试注入）
 * @param {Function} [opts.fetchBytes]
 * @param {Function} [opts.readRemoteState]  默认 gallery-client.readState（测试可替换）
 * @param {number} [opts.batchSize=IMG_BATCH]
 * @returns {Promise<{target, total, added: string[], skipped: Array<{id, reason, imgId}>, errors: Array<{imgId, message}>, commits: number, fatal: string}>}
 */
export async function exportChatImagesBatch(items, {
    target, reAdd = false, onProgress, codec, fetchBytes,
    readRemoteState = remoteReadState, batchSize = IMG_BATCH, buildEntry = buildGalleryEntry,
} = {}) {
    if (!target || (target.kind !== 'local' && target.kind !== 'remote')) {
        throw Object.assign(new Error('存到哪里？target.kind 要是 local 或 remote'), { code: 'input' });
    }
    const list = Array.isArray(items) ? items.filter(Boolean) : [];
    const res = { target: target.kind, total: list.length, added: [], skipped: [], errors: [], commits: 0, fatal: '' };
    let done = 0;
    const progress = phase => { if (onProgress) onProgress({ done, total: res.total, added: res.added.length, skipped: res.skipped.length, errors: res.errors.length, phase }); };

    let remoteState = null;
    if (target.kind === 'remote') {
        try { remoteState = (await readRemoteState(target.creds)).state; }
        catch (e) { res.fatal = (e && e.message) || '读不到画廊仓库'; return res; }
    }

    const seen = new Set();
    let pending = [];
    const flush = async () => {
        if (!pending.length) return true;
        const batch = pending;
        pending = [];
        progress('upload');
        try {
            let r;
            if (target.kind === 'local') r = await target.store.addImages(batch.map(b => b.entry), { reAdd });
            else {
                const add = target.addImages || remoteAddImages;
                r = await add(target.creds, batch.map(b => b.entry), { reAdd, device: 'XBDraw' });
                if (r && r.pushed) res.commits += Math.max(1, Number(r.commits) || 1);
            }
            const byId = new Map(batch.map(b => [b.entry.id, b.imgId]));
            for (const id of (r && r.added) || []) res.added.push(id);
            for (const s of (r && r.skipped) || []) res.skipped.push({ ...s, imgId: byId.get(s.id) || '' });
            return true;
        } catch (e) {
            res.fatal = (e && e.message) || '存入画廊失败';
            return false;
        }
    };

    for (const item of list) {
        const imgId = labelOf(item);
        try {
            const bytes = await resolveImageBytes(item.preview || {}, { fetchBytes });
            const id = await imageIdOf(bytes);
            if (seen.has(id)) { res.skipped.push({ id, reason: 'repeat', imgId }); continue; }
            seen.add(id);
            const status = target.kind === 'local' ? await target.store.has(id) : remoteStatus(remoteState, id);
            if (status === 'exists' || (status === 'deleted' && !reAdd)) { res.skipped.push({ id, reason: status, imgId }); continue; }
            const entry = await buildEntry({ preview: item.preview, message: item.message, name2: item.name2, bytes, codec, fetchBytes });
            pending.push({ entry, imgId });
            if (pending.length >= batchSize && !(await flush())) return res;
        } catch (e) {
            res.errors.push({ imgId, message: (e && e.message) || '处理失败' });
        } finally {
            done++;
            progress('encode');
        }
    }
    await flush();
    progress('done');
    return res;
}

/** 给界面的一句话总结 */
export function describeBatchResult(r) {
    if (!r) return { kind: 'error', text: '存入画廊失败' };
    const where = r.target === 'local' ? '本机画廊' : '画廊';
    const count = reason => r.skipped.filter(s => s.reason === reason).length;
    const parts = [`存入${where} ${r.added.length} 张`];
    const exists = count('exists') + count('repeat');
    if (exists) parts.push(`已存在 ${exists} 张`);
    if (count('deleted')) parts.push(`画廊里删过 ${count('deleted')} 张（没有加回）`);
    if (r.errors.length) parts.push(`失败 ${r.errors.length} 张`);
    if (r.fatal) return { kind: 'error', text: `${parts.join('，')}；已停止：${r.fatal}` };
    return { kind: r.errors.length ? 'error' : r.added.length ? 'success' : 'info', text: parts.join('，') };
}
