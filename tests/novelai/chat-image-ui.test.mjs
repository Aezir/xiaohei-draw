import test from 'node:test';
import assert from 'node:assert/strict';

import {
    GESTURE_THRESHOLDS,
    createGestureRecognizer,
    resolveChatImageSwipe,
} from '../../modules/draw/shared/chat-image-gestures.js';
import {
    buildFailedPlaceholderHtml,
    buildImageHtml,
    buildPendingImageHtml,
    ensureChatImageStyles,
    formatImageVersion,
} from '../../modules/draw/shared/chat-image-card.js';
import {
    clampZoomPan,
    clampZoomScale,
    getOriginalImageFileName,
    listLightboxActions,
    registerLightboxAction,
    resolveOriginalImageBlob,
    zoomAtPoint,
} from '../../modules/draw/shared/image-lightbox.js';
import { listImageActions, placeMenu, registerImageAction } from '../../modules/draw/shared/image-action-menu.js';

// 取出注入的样式文本（假 document，只收 <style>）
function CHAT_IMAGE_CSS_FOR_TEST() {
    const styles = [];
    const doc = {
        head: { appendChild: el => styles.push(el) },
        getElementById: id => styles.find(s => s.id === id) || null,
        createElement: () => ({}),
        querySelector: () => null,
    };
    ensureChatImageStyles(doc);
    return styles.find(s => s.id === 'xbdraw-chat-image-styles')?.textContent || '';
}

const EMOJI = /[\p{Extended_Pictographic}✕▶▼✓→✏⋮‹›⟳⬇]/u;

function fakeClock() {
    let now = 0;
    let seq = 0;
    const timers = new Map();
    return {
        setTimeout(fn, ms) { const id = ++seq; timers.set(id, { fn, at: now + ms }); return id; },
        clearTimeout(id) { timers.delete(id); },
        advance(ms) {
            now += ms;
            const due = [...timers.entries()].filter(([, t]) => t.at <= now).sort((a, b) => a[1].at - b[1].at);
            for (const [id, t] of due) {
                if (!timers.has(id)) continue;
                timers.delete(id);
                t.fn();
            }
        },
    };
}

function setup() {
    const clock = fakeClock();
    const events = [];
    const handlers = {
        onTap: p => events.push(['tap', p]),
        onDoubleTap: p => events.push(['double', p]),
        onLongPress: p => events.push(['long', p]),
        onSwipe: p => events.push(['swipe', p.direction]),
    };
    const r = createGestureRecognizer(handlers, { setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout });
    return { r, clock, events, types: () => events.map(e => e[0]) };
}

test('阈值与计划一致', () => {
    assert.deepEqual({ ...GESTURE_THRESHOLDS }, {
        slop: 10, axisRatio: 1.5, swipeDistance: 50, flickDistance: 30, flickTime: 300,
        longPress: 550, doubleTapDelay: 300, doubleTapRadius: 30,
    });
});

test('单击延迟 300ms 才触发', () => {
    const { r, clock, types } = setup();
    r.down(100, 100, 0);
    clock.advance(80);
    r.up(101, 100, 80);
    clock.advance(200);
    assert.deepEqual(types(), []);
    clock.advance(120);
    assert.deepEqual(types(), ['tap']);
});

test('300ms 内相距 <30px 的第二击算双击，不再触发单击', () => {
    const { r, clock, types } = setup();
    r.down(100, 100, 0); r.up(100, 100, 60);
    clock.advance(150);
    r.down(110, 104, 150); r.up(110, 104, 200);
    clock.advance(600);
    assert.deepEqual(types(), ['double']);
});

test('第二击离得太远：两次单击', () => {
    const { r, clock, types } = setup();
    r.down(100, 100, 0); r.up(100, 100, 60);
    clock.advance(100);
    r.down(200, 100, 160); r.up(200, 100, 200);
    clock.advance(600);
    assert.deepEqual(types(), ['tap', 'tap']);
});

test('按住 550ms 不动算长按，抬起不再单击；小抖动不打断', () => {
    const { r, clock, types } = setup();
    r.down(50, 50, 0);
    r.move(55, 53);
    clock.advance(549);
    assert.deepEqual(types(), []);
    clock.advance(1);
    r.up(55, 53, 700);
    clock.advance(600);
    assert.deepEqual(types(), ['long']);
});

test('横滑：右往左 = left，左往右 = right', () => {
    const { r, types, events } = setup();
    r.down(300, 100, 0);
    assert.equal(r.move(285, 101), 'horizontal');
    r.up(200, 104, 400);
    r.down(100, 100, 1000);
    r.move(115, 100);
    r.up(180, 102, 1400);
    assert.deepEqual(types(), ['swipe', 'swipe']);
    assert.deepEqual(events.map(e => e[1]), ['left', 'right']);
});

test('快速轻扫：|dx|>30 且 <300ms 成立；慢了不成立', () => {
    const fast = setup();
    fast.r.down(0, 0, 0); fast.r.move(-15, 0); fast.r.up(-40, 0, 150);
    assert.deepEqual(fast.types(), ['swipe']);
    const slow = setup();
    slow.r.down(0, 0, 0); slow.r.move(-15, 0); slow.r.up(-40, 0, 600);
    slow.clock.advance(1000);
    assert.deepEqual(slow.types(), []);
});

test('竖滑和斜滑都放行，不触发任何动作', () => {
    const v = setup();
    v.r.down(0, 0, 0);
    assert.equal(v.r.move(4, 30), 'vertical');
    v.r.up(6, 140, 300);
    v.clock.advance(1000);
    assert.deepEqual(v.types(), []);
    const d = setup();
    d.r.down(0, 0, 0);
    assert.equal(d.r.move(40, 35), 'vertical');
    d.r.up(80, 70, 300);
    d.clock.advance(1000);
    assert.deepEqual(d.types(), []);
});

test('聊天卡横滑决策：最新一张右往左滑 = 重新生成', () => {
    assert.deepEqual(resolveChatImageSwipe('left', 0, 3), { action: 'regenerate' });
    assert.deepEqual(resolveChatImageSwipe('left', 2, 3), { action: 'navigate', targetIndex: 1 });
    assert.deepEqual(resolveChatImageSwipe('right', 0, 3), { action: 'navigate', targetIndex: 1 });
    assert.deepEqual(resolveChatImageSwipe('right', 2, 3), { action: 'none' });
    assert.deepEqual(resolveChatImageSwipe('right', 0, 1), { action: 'none' });
    assert.deepEqual(resolveChatImageSwipe('left', 0, 1), { action: 'regenerate' });
});

test('真实图片卡：没有可见按钮、没有 emoji、挡住酒馆消息滑动', () => {
    const html = buildImageHtml({ slotId: 'slot-1', imgId: 'img-1', url: 'data:image/png;base64,AAA', tags: 'a <b> & "c"', positive: 'p', messageId: 3, state: 'preview', historyCount: 3, currentIndex: 1 });
    const outsideEditor = html.replace(/<div class="xb-nd-edit"[\s\S]*$/, '');
    assert.equal(/<button/i.test(outsideEditor), false);
    assert.equal(EMOJI.test(html), false);
    assert.equal(/fa-/.test(html), false);
    assert.equal((html.match(/data-swipe-ignore="true"/g) || []).length >= 3, true); // 卡片、图片容器、图片
    assert.match(html, /class="xb-nd-edit" hidden/);
    assert.match(html, /data-tags="a &lt;b&gt; &amp; &quot;c&quot;"/);
    assert.match(html, /data-current-index="1" data-history-count="3"/);
    // 卡面不常驻任何编号角标：位置只在切换版本时由 flashImageCardPosition 短暂显示
    assert.equal(/xb-nd-ver|xb-nd-pos/.test(html), false);
    assert.equal(/\d+\s*\/\s*\d+/.test(html.replace(/<[^>]*>/g, ' ')), false);
    assert.equal(formatImageVersion(0, 3), '3 / 3');
    const single = buildImageHtml({ slotId: 's', imgId: 'i', url: '/x.png', tags: '', positive: '', messageId: 0, state: 'saved' });
    assert.equal(/xb-nd-ver|xb-nd-pos/.test(single), false);
    assert.match(single, /loading="lazy"/);
});

test('真实图片卡没有内边距和底色；占位卡用中性半透明底色、文字跟随主题色', () => {
    const css = CHAT_IMAGE_CSS_FOR_TEST();
    const rule = sel => (css.match(new RegExp(`(^|\\n)${sel.replace(/[.[\]"=]/g, '\\$&')} \\{([^}]*)\\}`)) || [])[2] || '';
    const base = rule('.xb-nd-img');
    assert.match(base, /padding: 0;/);
    assert.match(base, /background: transparent;/);
    assert.equal(/#2a2a2a/.test(rule('.xb-nd-img[data-state="preview"]')), false);
    const placeholder = rule('.xb-nd-img[data-state="failed"], .xb-nd-img[data-state="pending"]');
    assert.match(placeholder, /background: rgba\(128, 128, 128, 0\.\d+\)/);
    assert.match(placeholder, /var\(--SmartThemeBodyColor/);
    assert.equal(/border(-left)?:\s*\d|box-shadow:\s*[^n]/.test(css.replace(/border-style: none !important|box-shadow: none !important/g, '')), false);
});

test('失败占位卡保留三个按钮（Remix 图标），等待卡没有 emoji', () => {
    const failed = buildFailedPlaceholderHtml({ slotId: 's', messageId: 1, tags: 't', positive: 'p', errorType: '网络', errorMessage: '超时' });
    for (const action of ['retry-image', 'edit-tags', 'remove-placeholder', 'save-tags-retry', 'cancel-edit']) {
        assert.match(failed, new RegExp(`data-action="${action}"`));
    }
    assert.match(failed, /ri-refresh-line/);
    assert.equal(EMOJI.test(failed), false);
    const pending = buildPendingImageHtml({ slotId: 's', messageId: 1, index: 2, total: 4, label: '等待<生成>' });
    assert.match(pending, /等待&lt;生成&gt; · 2 \/ 4/);
    assert.equal(EMOJI.test(pending), false);
});

test('编辑提示词窗口：真实卡和失败卡都是「保存并重新生成」', () => {
    const real = buildImageHtml({ slotId: 's', imgId: 'i', url: '/x.png', tags: 't', positive: 'p', messageId: 0, state: 'preview' });
    const failed = buildFailedPlaceholderHtml({ slotId: 's', messageId: 1, tags: 't', positive: 'p' });
    assert.match(real, /data-action="save-tags"><i class="ri-refresh-line"[^>]*><\/i>保存并重新生成</);
    assert.match(failed, /data-action="save-tags-retry"><i class="ri-refresh-line"[^>]*><\/i>保存并重新生成</);
    assert.equal(/保存并重试|>保存</.test(real + failed), false);
});

test('灯箱操作注册表：内置两项 + 扩展项，按 when 过滤；标签「下载」', () => {
    const base = listLightboxActions().map(a => a.id);
    assert.deepEqual(base.slice(0, 2), ['save-to-server', 'download-original']);
    assert.equal(listLightboxActions().find(a => a.id === 'download-original').label, '下载');
    const unregister = registerLightboxAction({ id: 'gallery-test', icon: 'ri-image-line', label: '同步到 Gallery', order: 30, when: ctx => !!ctx.preview, run() {} });
    const lightbox = { canSave: true, download() {} };
    const unsaved = { preview: { base64: 'AAA' }, lightbox };
    const saved = { preview: { savedUrl: '/a.png' }, lightbox };
    assert.deepEqual(listLightboxActions(unsaved).map(a => a.id), ['save-to-server', 'download-original', 'gallery-test']);
    assert.deepEqual(listLightboxActions(saved).map(a => a.id), ['download-original', 'gallery-test']);
    // registerLightboxAction 不写 surfaces = 只进灯箱
    assert.equal(listImageActions(null, 'chat').some(a => a.id === 'gallery-test'), false);
    unregister();
    assert.equal(listLightboxActions().some(a => a.id === 'gallery-test'), false);
    assert.throws(() => registerLightboxAction({ id: '', run() {} }), TypeError);
    assert.throws(() => registerLightboxAction({ id: 'x' }), TypeError);
});

test('共享操作注册表：聊天长按面板只有「下载」+ 两处都注册的项；保存到服务器只在灯箱', () => {
    const chatCtx = { surface: 'chat', preview: { base64: 'AAA' }, download() {} };
    assert.deepEqual(listImageActions(chatCtx, 'chat').map(a => [a.id, a.label]), [['download-original', '下载']]);
    const off = registerLightboxAction({ id: 'both-test', label: '同步到 Gallery', icon: 'ri-image-add-line', order: 30, surfaces: ['chat', 'lightbox'], when: ctx => !!ctx.preview, run() {} });
    const offImg = registerImageAction({ id: 'lb-only', label: 'x', surfaces: ['lightbox'], run() {} });
    assert.deepEqual(listImageActions(chatCtx, 'chat').map(a => a.label), ['下载', '同步到 Gallery']);
    assert.deepEqual(listLightboxActions({ preview: { savedUrl: '/a.png' }, download() {} }).map(a => a.id), ['download-original', 'both-test', 'lb-only']);
    assert.deepEqual(listImageActions({ preview: {} }, 'chat').map(a => a.id), ['both-test']);
    off(); offImg();
    assert.deepEqual(listImageActions(chatCtx, 'chat').map(a => a.id), ['download-original']);
});

test('面板贴位：右下优先，出视口翻转并夹在视口内', () => {
    assert.deepEqual(placeMenu(100, 100, 180, 90, 1440, 900), { left: 104, top: 104, placement: 'bottom-right' });
    assert.deepEqual(placeMenu(360, 800, 180, 90, 375, 812), { left: 176, top: 706, placement: 'top-left' });
    const tiny = placeMenu(5, 5, 360, 90, 375, 812);
    assert.equal(tiny.left >= 8 && tiny.left + 360 <= 375 - 8 + 1, true);
});

test('灯箱缩放数学：以光标为锚、范围 1–6、平移不越界', () => {
    assert.equal(clampZoomScale(0.3), 1);
    assert.equal(clampZoomScale(9), 6);
    const center = { x: 500, y: 400 };
    const v1 = zoomAtPoint({ scale: 1, tx: 0, ty: 0 }, 2, 600, 450, center);
    // 锚点下的图片内容不动：屏幕点 = center + t + s*q
    const q = { x: 100, y: 50 };
    assert.equal(center.x + v1.tx + v1.scale * q.x, 600);
    assert.equal(center.y + v1.ty + v1.scale * q.y, 450);
    assert.deepEqual(clampZoomPan(999, -999, 2, 400, 300), { tx: 200, ty: -150 });
    assert.deepEqual(clampZoomPan(30, 30, 1, 400, 300), { tx: 0, ty: 0 });
});

test('下载原图：优先 base64，没有才取 savedUrl；文件名合理', async () => {
    const pngBase64 = Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64');
    const blob = await resolveOriginalImageBlob({ imgId: 'img-9', base64: `data:image/png;base64,${pngBase64}` }, {
        fetchImpl: () => { throw new Error('should not fetch'); },
    });
    assert.equal(blob.type, 'image/png');
    assert.equal(blob.size, 4);
    assert.equal(getOriginalImageFileName({ imgId: 'img-9', base64: 'x' }, blob), 'img-9.png');

    const calls = [];
    const fetched = await resolveOriginalImageBlob({ imgId: 'img-8', savedUrl: '/user/images/c/novel_img-8.png' }, {
        fetchImpl: async (url) => { calls.push(url); return { ok: true, blob: async () => new Blob([new Uint8Array(2)], { type: 'image/png' }) }; },
    });
    assert.deepEqual(calls, ['/user/images/c/novel_img-8.png']);
    assert.equal(getOriginalImageFileName({ imgId: 'img-8', savedUrl: '/user/images/c/novel_img-8.png' }, fetched), 'novel_img-8.png');
    await assert.rejects(() => resolveOriginalImageBlob({ imgId: 'none' }), /没有可下载的原图/);
});
