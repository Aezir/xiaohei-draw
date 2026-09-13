// 聊天图 → 画廊记录 + webp 两档（G2 用）。
// 参数来源优先级：V2 写进预览缓存的参数快照 preview.params（主）→ PNG 里 NAI 写的元数据（补）→ 旧预览记录的 positive/negativePrompt（兜底）。
// 快照形状按 execution-plan.md V2：{prompt, uc, seed, model, steps, scale, sampler, noiseSchedule, width, height, smea, dyn, cfgRescale, characterPrompts, vibes}
// 这里按「字段可能缺 / 可能换了名字」来读，旧记录没有快照也能出记录。vibes 摘要不是 NAI 格式，不写进 nai。
// 图片：只存 webp（decisions 第 4 条），缩略图最长边 420 q0.74、大图 1216 q0.95，和画廊一致；浏览器里用拷贝来的 toWebp，Node 测试注入 codec。
// 批次：meta.batch = 角色卡名；群聊取生成这张图的那条消息的角色名（decisions 第 3 条）。
// id：原图字节 SHA-256 前 16 字节 hex（画廊同款），同一张图重复存入会被识别。
import { imageIdOf, addImages as remoteAddImages, IMG_META } from './gallery-client.js';
import { pngText, metaFromPng, toWebp } from './vendor/nai-meta.js';

export const WEBP_TIERS = Object.freeze({
    thumb: Object.freeze({ max: 420, q: 0.74 }),
    full: Object.freeze({ max: 1216, q: 0.95 }),
});
const err = (message, extra) => Object.assign(new Error(message), extra);
const has = v => v !== undefined && v !== null && v !== '';
const num = v => ((typeof v === 'number' || (typeof v === 'string' && v.trim() !== '')) && Number.isFinite(Number(v)) ? Number(v) : undefined);
const str = v => (typeof v === 'string' && v.trim() ? v : undefined);
const bool = v => (typeof v === 'boolean' ? v : undefined);
const dropUndef = o => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));

async function asU8(x) {
    if (x instanceof Uint8Array) return x;
    if (x instanceof ArrayBuffer) return new Uint8Array(x);
    if (ArrayBuffer.isView(x)) return new Uint8Array(x.buffer, x.byteOffset, x.byteLength);
    if (x && typeof x.arrayBuffer === 'function') return new Uint8Array(await x.arrayBuffer());
    return null;
}

/** 'data:image/png;base64,....' 或裸 base64 → Uint8Array；解不开返回 null */
export function decodeBase64Image(value) {
    const raw = String(value || '').trim();
    if (!raw) return null;
    const m = raw.match(/^data:[^,]*;base64,(.*)$/is);
    try { return Uint8Array.from(atob((m ? m[1] : raw).replace(/\s/g, '')), c => c.charCodeAt(0)); }
    catch { return null; }
}

/** XBDraw 模型 id → 画廊的模型标签（画廊只认 'V5' / 'V4.5'，其他原样） */
export function modelLabel(model) {
    const m = String(model || '').trim();
    if (!m) return undefined;
    if (/diffusion-5\b|^V5$/i.test(m)) return 'V5';
    if (/diffusion-4-5\b|^V4\.5$/i.test(m)) return 'V4.5';
    return m;
}

export function resolveBatchName({ preview, message, name2 } = {}) {
    const candidates = [message && !message.is_user ? message.name : '', preview && preview.characterName, name2];
    for (const v of candidates) if (typeof v === 'string' && v.trim()) return v.trim();
    return '未知角色';
}

function charsFrom(list) {
    if (!Array.isArray(list) || !list.length) return undefined;
    const out = list.map(c => {
        if (typeof c === 'string') return { prompt: c, uc: '', centers: [] };
        if (!c || typeof c !== 'object') return null;
        const centers = Array.isArray(c.centers) ? c.centers
            : c.center && typeof c.center === 'object' ? [{ x: Number(c.center.x), y: Number(c.center.y) }] : [];
        return { prompt: String(c.prompt ?? c.char_caption ?? ''), uc: String(c.uc ?? c.negativePrompt ?? c.negative ?? ''), centers };
    }).filter(Boolean);
    return out.length ? out : undefined;
}

function snapshotOf(preview) {
    const p = preview && (preview.params || preview.paramsSnapshot || preview.snapshot);
    return p && typeof p === 'object' && !Array.isArray(p) ? p : {};
}

/** 参数快照 → 画廊 meta 的一部分（不含 name/at/file/w/h/batch） */
export function metaFromSnapshot(preview) {
    const p = snapshotOf(preview);
    const seed = num(p.seed);
    const nai = dropUndef({
        noise_schedule: str(p.noiseSchedule ?? p.noise_schedule ?? p.scheduler),
        cfg_rescale: num(p.cfgRescale ?? p.cfg_rescale),
        sm: bool(p.smea ?? p.sm),
        sm_dyn: bool(p.dyn ?? p.sm_dyn),
        chars: charsFrom(p.characterPrompts),
    });
    return dropUndef({
        prompt: str(p.prompt), uc: str(p.uc ?? p.negativePrompt),
        seed: Number.isInteger(seed) && seed >= 0 ? seed : undefined,
        steps: num(p.steps), scale: num(p.scale), sampler: str(p.sampler), model: modelLabel(p.model),
        nai: Object.keys(nai).length ? nai : undefined,
    });
}

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47];
function metaFromPngBytes(u8, file, ts) {
    if (u8.length < 8 || PNG_SIG.some((b, i) => u8[i] !== b)) return null;
    let text;
    try { text = pngText(u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength)); } catch { return null; }
    if (!text || !(text.Comment || text.Description)) return null;
    const m = metaFromPng(text, { lastModified: ts, name: file });
    return dropUndef({
        prompt: str(m.prompt), uc: str(m.uc), seed: num(m.seed), steps: num(m.steps), scale: num(m.scale), sampler: str(m.sampler),
        model: text.Source ? m.model : undefined, nai: m.nai,
    });
}

function legacyMeta(preview) {
    const chars = charsFrom(preview.characterPrompts);
    return dropUndef({ prompt: str(preview.positive), uc: str(preview.negativePrompt), nai: chars ? { chars } : undefined });
}

/** 按优先级合并：每个字段取第一个有值的；nai 逐键合并，前面的赢 */
function fillMeta(...sources) {
    const out = {};
    for (const src of sources) {
        if (!src) continue;
        for (const [k, v] of Object.entries(src)) if (k !== 'nai' && !has(out[k]) && has(v)) out[k] = v;
    }
    const nais = sources.filter(s => s && s.nai).map(s => s.nai);
    if (nais.length) out.nai = Object.assign({}, ...nais.reverse());
    return out;
}

function fileNameOf(preview, id) {
    const url = String(preview.savedUrl || '').split(/[?#]/)[0];
    const base = url.split('/').pop();
    if (base) { try { return decodeURIComponent(base); } catch { return base; } }
    return `${preview.imgId || preview.slotId || id}.png`;
}

const pad = n => String(n).padStart(2, '0');
const stamp = ts => { const d = new Date(ts); return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`; };

async function defaultFetchBytes(url) {
    const r = await fetch(url, { credentials: 'same-origin' });
    if (!r.ok) throw err(`读不到服务器上的图片（${r.status}）`, { status: r.status });
    return new Uint8Array(await r.arrayBuffer());
}

/** 原图字节：预览记录的 base64 优先，没有才同源取 savedUrl */
export async function resolveImageBytes(preview = {}, { bytes, fetchBytes } = {}) {
    let u8 = bytes ? await asU8(bytes) : decodeBase64Image(preview.base64);
    if ((!u8 || !u8.length) && preview.savedUrl) u8 = await asU8(await (fetchBytes || defaultFetchBytes)(preview.savedUrl));
    if (!u8 || !u8.length) throw err('这张图没有可用的图片数据（缓存和服务器文件都取不到）', { code: 'input' });
    return u8;
}

/** 浏览器 codec：createImageBitmap + 画廊的 toWebp */
export function browserCodec() {
    return {
        decodeImage: u8 => createImageBitmap(new Blob([u8])),
        async encodeWebp(bmp, max, q) {
            const blob = await toWebp(bmp, max, q);
            if (!blob) throw err('浏览器没能把图片转成 webp', { code: 'encode' });
            return new Uint8Array(await blob.arrayBuffer());
        },
        release: bmp => { if (bmp && typeof bmp.close === 'function') bmp.close(); },
    };
}

/** codec = {decodeImage(u8) → {width, height}, encodeWebp(img, max, q) → Uint8Array|Blob, release?(img)} */
export async function encodeWebpTiers(bytes, codec) {
    const img = await codec.decodeImage(bytes);
    try {
        const thumb = await asU8(await codec.encodeWebp(img, WEBP_TIERS.thumb.max, WEBP_TIERS.thumb.q));
        const full = await asU8(await codec.encodeWebp(img, WEBP_TIERS.full.max, WEBP_TIERS.full.q));
        if (!thumb || !full) throw err('webp 编码结果为空', { code: 'encode' });
        return { thumb, full, w: img.width, h: img.height };
    } finally {
        if (codec.release) codec.release(img);
    }
}

/**
 * @param {object} input
 * @param {object} input.preview   gallery-cache 的预览记录（base64 / savedUrl / characterName / timestamp / params …）
 * @param {object} [input.message] 生成这张图的聊天消息（取群聊角色名）
 * @param {string} [input.name2]   当前聊天角色名
 * @param {Uint8Array} [input.bytes]  已经取好的原图字节
 * @param {Function} [input.fetchBytes]
 * @param {object} [input.codec]   默认 browserCodec()
 * @returns {Promise<{id, meta, thumb, full, sources:{snapshot:boolean, png:boolean}}>}
 */
export async function buildGalleryEntry({ preview = {}, message, name2, bytes, fetchBytes, codec, now = () => Date.now() } = {}) {
    const u8 = await resolveImageBytes(preview, { bytes, fetchBytes });
    const id = await imageIdOf(u8);
    const ts = Number(preview.timestamp) > 0 ? Number(preview.timestamp) : now();
    const file = fileNameOf(preview, id);
    const batch = resolveBatchName({ preview, message, name2 });
    const snap = metaFromSnapshot(preview), png = metaFromPngBytes(u8, file, ts), legacy = legacyMeta(preview);
    const tiers = await encodeWebpTiers(u8, codec || browserCodec());
    const filled = fillMeta(snap, png, legacy);
    const meta = {
        name: `${batch} · ${stamp(ts)}`,
        ...filled,
        at: new Date(ts).toISOString(),
        file, w: tiers.w, h: tiers.h,
        pngMeta: !!filled.prompt,                       // 画廊里 pngMeta=true 表示提示词来自生成参数，详情页锁定原提示词
        batch,
    };
    return {
        id,
        meta: Object.fromEntries(IMG_META.filter(k => meta[k] !== undefined).map(k => [k, meta[k]])),
        thumb: tiers.thumb, full: tiers.full,
        sources: { snapshot: Object.keys(snap).length > 0, png: !!png },
    };
}

/**
 * 存一张聊天图。target：{kind:'local', store: createLocalGallery()} 或 {kind:'remote', creds, addImages?}
 * 本机目标先按 id 查重，已有就不转 webp；远端由 gallery-client.addImages 按当次远端去重。
 * @returns {Promise<{id, target:'local'|'remote', added:string[], skipped:Array<{id, reason}>, pushed?, commits?}>}
 */
export async function exportChatImage(input = {}, { target, reAdd = false, onProgress } = {}) {
    if (!target || (target.kind !== 'local' && target.kind !== 'remote')) throw err('存到哪里？target.kind 要是 local 或 remote', { code: 'input' });
    const bytes = await resolveImageBytes(input.preview || {}, input);
    const id = await imageIdOf(bytes);
    if (target.kind === 'local') {
        const s = await target.store.has(id);
        if (s === 'exists' || (s === 'deleted' && !reAdd)) return { id, target: 'local', added: [], skipped: [{ id, reason: s }] };
    }
    const entry = await buildGalleryEntry({ ...input, bytes });
    if (target.kind === 'local') return { id, target: 'local', ...(await target.store.addImages([entry], { reAdd })) };
    const add = target.addImages || remoteAddImages;
    return { id, target: 'remote', ...(await add(target.creds, [entry], { reAdd, onProgress, device: 'XBDraw' })) };
}
