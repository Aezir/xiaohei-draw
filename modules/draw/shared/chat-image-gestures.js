// chat-image-gestures.js
// 聊天图片卡和灯箱共用的手势识别：单击 / 双击 / 长按 / 左右滑，竖滑放行给页面滚动。
// 识别器本身不碰 DOM（计时器可注入），便于 node 测试；bindGestures 用 Pointer Events 接到元素上（鼠标拖动也算滑动）。
// 双击识别可关（options.doubleTap = false）：没有双击动作的地方（聊天图片卡）单击立即触发，不用等 300ms。

export const GESTURE_THRESHOLDS = Object.freeze({
    slop: 10,             // 移动超过这个距离才判断方向，也是长按允许的抖动
    axisRatio: 1.5,       // |dx| > 1.5|dy| 算横滑
    swipeDistance: 50,    // 横滑成立：|dx| > 50
    flickDistance: 30,    // 或 |dx| > 30 且用时 < flickTime
    flickTime: 300,
    longPress: 550,       // 按住不动 550ms 算长按
    doubleTapDelay: 300,  // 单击延迟 300ms 执行；期间出现第二击算双击
    doubleTapRadius: 30,  // 两击相距 < 30px
});

/**
 * 纯状态机。输入 down/move/up/cancel，输出回调：
 * onTap({x,y}) / onDoubleTap({x,y}) / onLongPress({x,y}) / onSwipe({direction, dx, dy, dt})
 * direction: 'left' = 手指从右往左，'right' = 从左往右。
 * move() 返回 'horizontal' | 'vertical' | null，调用方据此阻止默认行为或放行。
 * options.doubleTap = false 时不识别双击：抬起就触发 onTap，不再延迟等第二击。
 */
export function createGestureRecognizer(handlers = {}, options = {}) {
    const t = { ...GESTURE_THRESHOLDS, ...(options.thresholds || {}) };
    const detectDoubleTap = options.doubleTap !== false;
    const setTimer = options.setTimeout || ((fn, ms) => globalThis.setTimeout(fn, ms));
    const clearTimer = options.clearTimeout || (id => globalThis.clearTimeout(id));
    const emit = (name, payload) => {
        try { handlers[name]?.(payload); } catch (error) { console.error('[XBDrawGestures]', name, error); }
    };

    let press = null;      // 当前按压
    let pendingTap = null; // 等待确认的第一击 { x, y, upTime, timer }

    function clearPendingTap() {
        if (pendingTap?.timer != null) clearTimer(pendingTap.timer);
        pendingTap = null;
    }

    function down(x, y, time) {
        cancel({ keepPendingTap: true });
        let secondTap = false;
        if (pendingTap) {
            const near = Math.hypot(x - pendingTap.x, y - pendingTap.y) < t.doubleTapRadius;
            const quick = time - pendingTap.upTime <= t.doubleTapDelay;
            if (near && quick) {
                secondTap = true;
                if (pendingTap.timer != null) clearTimer(pendingTap.timer);
                pendingTap.timer = null;
            } else {
                // 离得远或太慢：第一击立即按单击处理
                const first = pendingTap;
                clearPendingTap();
                emit('onTap', { x: first.x, y: first.y });
            }
        }
        press = { sx: x, sy: y, st: time, x, y, mode: 'pressing', secondTap, longTimer: null };
        const current = press;
        current.longTimer = setTimer(() => {
            if (press !== current || current.mode !== 'pressing') return;
            current.mode = 'longpress';
            current.longTimer = null;
            clearPendingTap();
            emit('onLongPress', { x: current.x, y: current.y });
        }, t.longPress);
    }

    function move(x, y) {
        if (!press) return null;
        press.x = x;
        press.y = y;
        if (press.mode === 'horizontal') return 'horizontal';
        if (press.mode !== 'pressing') return press.mode === 'vertical' ? 'vertical' : null;
        const dx = x - press.sx;
        const dy = y - press.sy;
        if (Math.hypot(dx, dy) <= t.slop) return null;
        if (press.longTimer != null) clearTimer(press.longTimer);
        press.longTimer = null;
        if (press.secondTap) clearPendingTap();
        press.mode = Math.abs(dx) > t.axisRatio * Math.abs(dy) ? 'horizontal' : 'vertical';
        return press.mode;
    }

    function up(x, y, time) {
        if (!press) return null;
        const current = press;
        press = null;
        if (current.longTimer != null) clearTimer(current.longTimer);
        current.x = x;
        current.y = y;
        if (current.mode === 'pressing' && Math.hypot(x - current.sx, y - current.sy) > t.slop) {
            // 没有 move 事件就直接抬起（模拟事件或极快的手势）
            const dx = x - current.sx;
            const dy = y - current.sy;
            current.mode = Math.abs(dx) > t.axisRatio * Math.abs(dy) ? 'horizontal' : 'vertical';
            if (current.secondTap) clearPendingTap();
        }
        if (current.mode === 'pressing') {
            if (current.secondTap && pendingTap) {
                clearPendingTap();
                emit('onDoubleTap', { x, y });
                return 'doubletap';
            }
            if (!detectDoubleTap) {
                emit('onTap', { x, y });
                return 'tap';
            }
            const tapState = { x, y, upTime: time, timer: null };
            pendingTap = tapState;
            tapState.timer = setTimer(() => {
                if (pendingTap !== tapState) return;
                pendingTap = null;
                emit('onTap', { x: tapState.x, y: tapState.y });
            }, t.doubleTapDelay);
            return 'tap-pending';
        }
        if (current.mode === 'horizontal') {
            const dx = x - current.sx;
            const dy = y - current.sy;
            const dt = time - current.st;
            const adx = Math.abs(dx);
            if (adx > t.swipeDistance || (adx > t.flickDistance && dt < t.flickTime)) {
                emit('onSwipe', { direction: dx < 0 ? 'left' : 'right', dx, dy, dt });
                return 'swipe';
            }
            return 'none';
        }
        return current.mode === 'longpress' ? 'longpress-end' : 'none';
    }

    function cancel({ keepPendingTap = false } = {}) {
        if (press?.longTimer != null) clearTimer(press.longTimer);
        if (press?.secondTap && !keepPendingTap) clearPendingTap();
        press = null;
        if (!keepPendingTap) clearPendingTap();
    }

    return {
        down,
        move,
        up,
        cancel: () => cancel(),
        get active() { return !!press; },
        get mode() { return press?.mode || null; },
        get hasPendingTap() { return !!pendingTap; },
        destroy() { cancel(); },
    };
}

/**
 * 把识别器接到 DOM 上。
 * - selector 为空：只绑 target 本身；selector 非空：target 作为委托根，handlers 第二个参数是命中的元素。
 * - handlers: onTap/onDoubleTap/onLongPress/onSwipe(payload, element, event)；enabled(element) 返回 false 时忽略。
 *   没传 onDoubleTap 就不识别双击，单击抬起立即触发。
 * - 被识别的元素上吞掉 click、contextmenu（长按/触摸时）、dragstart，避免酒馆或浏览器的默认行为。
 */
export function bindGestures(target, handlers = {}, { selector = '', thresholds, preventContextMenu = 'touch' } = {}) {
    if (!target?.addEventListener) return { destroy() {} };
    let session = null; // { pointerId, element, pointerType }
    let lastTouchTime = 0;
    let longPressFiredAt = 0;

    const matchElement = (node) => {
        if (!node || typeof node.closest !== 'function') return null;
        if (!selector) return (node === target || target.contains?.(node)) ? target : null;
        const found = node.closest(selector);
        if (!found) return null;
        return (target === found || target.contains?.(found) || target.nodeType === 9) ? found : null;
    };

    const recognizer = createGestureRecognizer({
        onTap: payload => fire('onTap', payload),
        onDoubleTap: payload => fire('onDoubleTap', payload),
        onLongPress: (payload) => {
            longPressFiredAt = Date.now();
            fire('onLongPress', payload);
        },
        onSwipe: payload => fire('onSwipe', payload),
    }, { thresholds, doubleTap: typeof handlers.onDoubleTap === 'function' });

    let lastElement = null;
    let lastEvent = null;
    function fire(name, payload) {
        const element = session?.element || lastElement;
        if (!element) return;
        handlers[name]?.(payload, element, lastEvent);
    }

    function onPointerDown(event) {
        if (event.pointerType === 'mouse' && event.button !== 0) return;
        const element = matchElement(event.target);
        if (!element) return;
        if (typeof handlers.enabled === 'function' && handlers.enabled(element, event) === false) return;
        if (session && session.pointerId !== event.pointerId) {
            // 第二根手指：多点触控不算手势
            recognizer.cancel();
            session = null;
            return;
        }
        if (event.pointerType === 'touch' || event.pointerType === 'pen') lastTouchTime = Date.now();
        session = { pointerId: event.pointerId, element, pointerType: event.pointerType };
        lastElement = element;
        lastEvent = event;
        if (event.pointerType === 'mouse') {
            event.preventDefault();
            try { element.setPointerCapture?.(event.pointerId); } catch { }
        }
        recognizer.down(event.clientX, event.clientY, event.timeStamp || performance.now());
    }

    function onPointerMove(event) {
        if (!session || session.pointerId !== event.pointerId) return;
        lastEvent = event;
        const mode = recognizer.move(event.clientX, event.clientY);
        if (mode === 'horizontal') {
            if (event.cancelable) event.preventDefault();
            if (session.pointerType !== 'mouse') {
                try { session.element.setPointerCapture?.(event.pointerId); } catch { }
            }
        } else if (mode === 'vertical' && session.pointerType !== 'mouse') {
            // 竖滑交给浏览器滚动（touch-action: pan-y），浏览器随后会发 pointercancel
            recognizer.cancel();
            session = null;
        }
    }

    function onPointerUp(event) {
        if (!session || session.pointerId !== event.pointerId) return;
        lastEvent = event;
        const element = session.element;
        try { element.releasePointerCapture?.(event.pointerId); } catch { }
        recognizer.up(event.clientX, event.clientY, event.timeStamp || performance.now());
        lastElement = element;
        session = null;
    }

    function onPointerCancel(event) {
        if (!session || session.pointerId !== event.pointerId) return;
        recognizer.cancel();
        session = null;
    }

    function onClick(event) {
        if (!matchElement(event.target)) return;
        event.preventDefault();
        event.stopPropagation();
    }

    function onContextMenu(event) {
        const element = matchElement(event.target);
        if (!element) return;
        const recentTouch = Date.now() - lastTouchTime < 1500;
        const recentLong = Date.now() - longPressFiredAt < 1500;
        if (preventContextMenu === 'always' || recentTouch || recentLong || session || handlers.onContextMenu) {
            // 浏览器和酒馆的右键 / 长按菜单都不要
            event.preventDefault();
            // 有 onContextMenu（聊天卡）时面板由这里弹，也不让酒馆自己的右键处理再收到
            if (handlers.onContextMenu) event.stopPropagation();
        }
        // 鼠标右键：交给调用方（例如弹出操作面板）；触摸长按已经由 onLongPress 处理过
        if (handlers.onContextMenu && !recentTouch && !recentLong) {
            handlers.onContextMenu({ x: event.clientX, y: event.clientY }, element, event);
        }
    }

    function onSelectStart(event) {
        if (matchElement(event.target)) event.preventDefault();
    }

    function onDragStart(event) {
        if (matchElement(event.target)) event.preventDefault();
    }

    const opts = { passive: false };
    target.addEventListener('pointerdown', onPointerDown, opts);
    target.addEventListener('pointermove', onPointerMove, opts);
    target.addEventListener('pointerup', onPointerUp, opts);
    target.addEventListener('pointercancel', onPointerCancel, opts);
    target.addEventListener('click', onClick, true);
    target.addEventListener('contextmenu', onContextMenu, true);
    target.addEventListener('dragstart', onDragStart, true);
    target.addEventListener('selectstart', onSelectStart, true);

    return {
        recognizer,
        destroy() {
            recognizer.destroy();
            session = null;
            target.removeEventListener('pointerdown', onPointerDown, opts);
            target.removeEventListener('pointermove', onPointerMove, opts);
            target.removeEventListener('pointerup', onPointerUp, opts);
            target.removeEventListener('pointercancel', onPointerCancel, opts);
            target.removeEventListener('click', onClick, true);
            target.removeEventListener('contextmenu', onContextMenu, true);
            target.removeEventListener('dragstart', onDragStart, true);
            target.removeEventListener('selectstart', onSelectStart, true);
        },
    };
}

export const CHAT_IMAGE_GESTURE_SELECTOR = '.xb-nd-img[data-img-id] .xb-nd-img-wrap';

/**
 * 决定聊天图片卡上一次横滑该做什么（纯函数，便于测试）。
 * 历史顺序：index 0 = 最新。右往左滑 = 看更新的一张，已是最新则重新生成；左往右滑 = 看更旧的一张。
 */
export function resolveChatImageSwipe(direction, currentIndex, historyCount) {
    const index = Math.max(0, Number.parseInt(currentIndex, 10) || 0);
    const total = Math.max(1, Number.parseInt(historyCount, 10) || 1);
    if (direction === 'left') {
        return index > 0 ? { action: 'navigate', targetIndex: index - 1 } : { action: 'regenerate' };
    }
    if (direction === 'right') {
        return index < total - 1 ? { action: 'navigate', targetIndex: index + 1 } : { action: 'none' };
    }
    return { action: 'none' };
}

/**
 * 聊天图片卡手势（真实图片卡才有；失败/等待占位卡没有 data-img-id，不会命中）。
 * actions: { open(card), menu(card, {x, y}), download(card), navigate(card, targetIndex), regenerate(card), isBusy(card) }
 * 单击 = open（立即触发，没有双击所以不用等）；长按（触摸）/ 右键（鼠标）：有 menu 就在按压位置弹操作面板
 * （编辑提示词、下载、同步到 Gallery），没有 menu 才退回直接 download。
 * 编辑提示词只从面板进（原来的双击已取消）；长按之后不会再触发单击。
 */
export function attachChatImageCardGestures(root, actions = {}) {
    const press = (card, point) => {
        if (!card || card.classList.contains('editing')) return;
        if (typeof actions.menu === 'function') actions.menu(card, point);
        else actions.download?.(card);
    };
    const busy = card => card?.classList?.contains('busy')
        || ['saving', 'refreshing'].includes(card?.dataset?.state)
        || actions.isBusy?.(card) === true;
    return bindGestures(root, {
        enabled: (wrap) => {
            const card = wrap.closest('.xb-nd-img');
            return !!card && card.dataset.state !== 'failed' && card.dataset.state !== 'pending';
        },
        onTap: (_payload, wrap) => {
            const card = wrap.closest('.xb-nd-img');
            if (!card || busy(card) || card.classList.contains('editing')) return;
            actions.open?.(card);
        },
        onLongPress: ({ x, y }, wrap) => press(wrap.closest('.xb-nd-img'), { x, y }),
        onContextMenu: typeof actions.menu === 'function'
            ? ({ x, y }, wrap) => press(wrap.closest('.xb-nd-img'), { x, y })
            : undefined,
        onSwipe: ({ direction }, wrap) => {
            const card = wrap.closest('.xb-nd-img');
            if (!card || busy(card) || card.classList.contains('editing')) return;
            const decision = resolveChatImageSwipe(direction, card.dataset.currentIndex, card.dataset.historyCount);
            if (decision.action === 'navigate') actions.navigate?.(card, decision.targetIndex, direction);
            else if (decision.action === 'regenerate') actions.regenerate?.(card);
        },
    }, { selector: CHAT_IMAGE_GESTURE_SELECTOR });
}
