// G2 / G1b 调用的注册与消息助手。只导出函数，本文件不自动注册任何东西、不 import 酒馆模块。
// 宿主（G2）接线示例：
//   import { registerLightboxAction } from '../image-lightbox.js';
//   registerGalleryLightboxAction(registerLightboxAction, {
//       getTarget: createTargetResolver({ credentials, local }),
//       resolveContext: ctx => ({ message: getContext().chat[ctx.messageId], name2: getContext().name2 }),
//       confirm: text => callGenericPopup(text, POPUP_TYPE.CONFIRM),
//       notify: (text, kind) => toastr[kind === 'error' ? 'error' : kind === 'success' ? 'success' : 'info'](text),
//   });
import { exportChatImage as defaultExport } from './chat-image-export.js';
import { presetFromGallery, findPresetBySource } from './preset-from-gallery.js';

export const GALLERY_SAVE_ACTION_ID = 'xb-gallery-save';
export const GALLERY_SAVE_ICON = 'ri-image-add-line';
export const GALLERY_SAVE_LABEL = '同步到 Gallery';
export const HOST_MESSAGES = Object.freeze({ IMPORT_GALLERY_PRESET: 'IMPORT_GALLERY_PRESET' });
export const READD_PROMPT = '画廊里删过这张图，要重新加回吗？';

/** 长按面板（聊天图片 / 灯箱）里是否显示「同步到 Gallery」：有图（base64 或已保存地址）且不是失败记录 */
export function canSaveToGallery(ctx) {
    const p = ctx && ctx.preview;
    return !!p && p.status !== 'failed' && !!(p.base64 || p.savedUrl);
}

/** 连上仓库存远端，没连就存本机画廊（decisions 第 1 条：纯本地可用） */
export function createTargetResolver({ credentials, local, fetch } = {}) {
    return async () => {
        const creds = credentials ? await credentials.load() : null;
        if (creds) return { kind: 'remote', creds: fetch ? { ...creds, fetch } : creds };
        if (local) return { kind: 'local', store: local };
        return null;
    };
}

export function describeSaveResult(r) {
    if (r && r.added && r.added.length) {
        return { kind: 'success', text: r.target === 'local' ? '已存入本机画廊，连上同步仓库后可以合并上去' : '已存入画廊' };
    }
    const s = r && r.skipped && r.skipped[0];
    if (s && s.reason === 'exists') return { kind: 'info', text: '这张图已经在画廊里了' };
    if (s && s.reason === 'deleted') return { kind: 'info', text: '画廊里删过这张图，没有重新加回' };
    return { kind: 'info', text: '画廊没有变化' };
}

/**
 * 往长按面板注册「同步到 Gallery」（surfaces: chat + lightbox，聊天图片和灯箱两处都出现）。返回注销函数。
 * deps.getTarget(ctx) → target|null（必填）；deps.resolveContext(ctx) → {message, name2}；
 * deps.confirm(text) → Promise<boolean>；deps.notify(text, kind: 'success'|'info'|'error')；
 * deps.codec / deps.fetchBytes 透传给 exportChatImage；deps.exportChatImage 可替换（测试）。
 */
export function registerGalleryLightboxAction(registerLightboxAction, deps = {}) {
    if (typeof registerLightboxAction !== 'function') throw new TypeError('需要传入 registerLightboxAction');
    if (typeof deps.getTarget !== 'function') throw new TypeError('deps.getTarget 必填');
    const exportImpl = deps.exportChatImage || defaultExport;
    const notify = typeof deps.notify === 'function' ? deps.notify : () => {};
    const confirm = typeof deps.confirm === 'function' ? deps.confirm : async () => false;
    const busy = new Set();

    return registerLightboxAction({
        id: GALLERY_SAVE_ACTION_ID,
        icon: GALLERY_SAVE_ICON,
        label: GALLERY_SAVE_LABEL,
        order: 30,
        surfaces: ['chat', 'lightbox'],   // 聊天图片长按面板和灯箱长按面板都有
        when: canSaveToGallery,
        async run(ctx) {
            const key = `${ctx && ctx.slotId}#${ctx && ctx.index}`;
            if (busy.has(key)) return null;
            busy.add(key);
            notify('正在存入画廊…', 'info');   // 点下去马上有反馈，存完再报结果
            try {
                const target = await deps.getTarget(ctx);
                if (!target) throw new Error('画廊还不能用：本机存储没有准备好');
                const extra = (deps.resolveContext && (await deps.resolveContext(ctx))) || {};
                const input = { preview: ctx.preview, message: extra.message, name2: extra.name2, codec: deps.codec, fetchBytes: deps.fetchBytes };
                let r = await exportImpl(input, { target });
                if (r && r.skipped && r.skipped.some(s => s.reason === 'deleted') && await confirm(READD_PROMPT)) {
                    r = await exportImpl(input, { target, reAdd: true });
                }
                const d = describeSaveResult(r);
                notify(d.text, d.kind);
                return r;
            } catch (e) {
                notify((e && e.message) || '存入画廊失败', 'error');   // 核心给的中文提示原样显示（ver / pw / guard / 401 / 403 / 404）
                return null;
            } finally {
                busy.delete(key);
            }
        },
    });
}

/**
 * iframe 里「从画廊导入」→ 发给宿主的消息。宿主（novel-draw.js）收到后：
 * duplicateOf 非空时问「覆盖 / 另存 / 取消」，再 normalizeParamsPreset（需保留 source）并保存。
 */
export function buildImportGalleryPresetMessage(record, { presets = [], ...opts } = {}) {
    const r = presetFromGallery(record, opts);
    const dup = findPresetBySource(presets, r.preset.source);
    return {
        type: HOST_MESSAGES.IMPORT_GALLERY_PRESET,
        preset: r.preset,
        unsupported: r.unsupported,
        characters: r.characters,
        notes: r.notes,
        duplicateOf: dup ? dup.id : null,
    };
}
