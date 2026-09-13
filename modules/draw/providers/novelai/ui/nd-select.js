/* 小黑生图 · 自绘下拉（渐进增强）
 * 原生 select 保留为数据源：隐藏但不移动；紧跟其后插入触发按钮。
 * - 程序改 .value / .selectedIndex / innerHTML / 增删 option 时，触发器自动刷新
 * - 用户选中时用原生 setter 写回，值变了才依次派发 input、change（bubbles）
 * - body 观察器自动接管之后插入的 select（角色编辑、Agent 区、氛围卡等）
 * - 跳过：data-nd-native、multiple、size>1
 * - 列表始终贴在触发器正下方（下方放不下才翻到上方），所有屏宽行为一致，没有底部面板
 * - 作用域：加载前设置 window.NdSelectConfig = { scope: 'CSS 选择器' } 时，只接管位于这些容器内的 select
 *   （酒馆主页面用，见 shared/host-select.js）；不设置时接管整页（设置页 iframe）
 * 挂到 window.NdSelect = { enhance, enhanceAll, refresh, destroy, close }
 */
(function () {
    'use strict';
    if (window.NdSelect) return;

    const CONFIG = window.NdSelectConfig || {};
    const SCOPE = typeof CONFIG.scope === 'string' ? CONFIG.scope.trim() : '';
    function inScope(sel) {
        if (!SCOPE) return true;
        try { return !!sel.closest(SCOPE); } catch (e) { return false; }
    }

    const instances = new WeakMap();
    const live = new Set();
    let uid = 0;
    let layer = null;
    let openInst = null;
    let activeIndex = -1;
    let items = [];
    let typeBuffer = '';
    let typeTimer = 0;

    const FILTER_THRESHOLD = 12;
    const LIST_MAX_HEIGHT = 320;
    const GAP = 4;
    const EDGE = 4;
    const isCoarse = () => window.matchMedia('(pointer: coarse)').matches;

    function shouldSkip(sel) {
        return !sel || sel.tagName !== 'SELECT' || sel.hasAttribute('data-nd-native') || sel.multiple || Number(sel.size) > 1 || !inScope(sel);
    }

    function nativeDesc(sel, prop) {
        let proto = Object.getPrototypeOf(sel);
        while (proto) {
            const d = Object.getOwnPropertyDescriptor(proto, prop);
            if (d) return d;
            proto = Object.getPrototypeOf(proto);
        }
        return null;
    }

    function getLabelText(sel) {
        if (sel.getAttribute('aria-label')) return sel.getAttribute('aria-label');
        const doc = sel.ownerDocument;
        if (sel.id) {
            const l = doc.querySelector(`label[for="${CSS.escape(sel.id)}"]`);
            if (l) return l.textContent.trim();
        }
        const wrap = sel.closest('label');
        if (wrap) return wrap.textContent.trim();
        const group = sel.closest('.form-group, .kv-row');
        const gl = group && group.querySelector('.form-label, label');
        return gl ? gl.textContent.trim() : '';
    }

    function syncTriggerLook(inst) {
        const { sel, trigger } = inst;
        const cls = Array.from(sel.classList).filter(c => c !== 'nd-select-native' && c !== 'hidden');
        trigger.className = ['nd-select-trigger', ...cls].join(' ');
        const hidden = sel.hidden || sel.classList.contains('hidden') || sel.style.display === 'none';
        trigger.classList.toggle('hidden', hidden);
        trigger.disabled = sel.disabled;
        trigger.setAttribute('aria-disabled', String(sel.disabled));
        const css = sel.getAttribute('style') || '';
        if (inst.lastStyle !== css) {
            inst.lastStyle = css;
            trigger.style.cssText = css.replace(/display\s*:\s*none\s*;?/gi, '');
        }
    }

    function refreshNow(inst) {
        inst.pending = false;
        if (!inst.sel.isConnected) return;
        syncTriggerLook(inst);
        const opt = inst.sel.selectedIndex >= 0 ? inst.sel.options[inst.sel.selectedIndex] : null;
        inst.text.textContent = opt ? (opt.label || opt.textContent) : '未选择';
        inst.text.classList.toggle('is-empty', !opt);
        if (openInst === inst) renderList();
    }

    function scheduleRefresh(inst) {
        if (inst.pending) return;
        inst.pending = true;
        queueMicrotask(() => refreshNow(inst));
    }

    function enhance(sel) {
        if (shouldSkip(sel) || instances.has(sel)) return instances.get(sel) || null;
        const doc = sel.ownerDocument;
        const id = `nd-sel-${++uid}`;
        const trigger = doc.createElement('button');
        trigger.type = 'button';
        trigger.id = `${id}-trigger`;
        trigger.setAttribute('role', 'combobox');
        trigger.setAttribute('aria-haspopup', 'listbox');
        trigger.setAttribute('aria-expanded', 'false');
        trigger.setAttribute('aria-controls', 'nd-select-layer');
        const label = getLabelText(sel);
        if (label) trigger.setAttribute('aria-label', label);
        const text = doc.createElement('span');
        text.className = 'nd-select-text';
        const arrow = doc.createElement('i');
        arrow.className = 'ri-arrow-down-s-line nd-select-arrow';
        arrow.setAttribute('aria-hidden', 'true');
        trigger.append(text, arrow);

        sel.classList.add('nd-select-native');
        sel.setAttribute('tabindex', '-1');
        sel.setAttribute('aria-hidden', 'true');
        sel.insertAdjacentElement('afterend', trigger);

        const inst = { sel, trigger, text, id, pending: false, lastStyle: null };
        instances.set(sel, inst);
        live.add(inst);

        // 拦截程序赋值
        const vd = nativeDesc(sel, 'value');
        const sd = nativeDesc(sel, 'selectedIndex');
        try {
            Object.defineProperty(sel, 'value', {
                configurable: true,
                get() { return vd.get.call(this); },
                set(v) { vd.set.call(this, v); scheduleRefresh(inst); },
            });
            Object.defineProperty(sel, 'selectedIndex', {
                configurable: true,
                get() { return sd.get.call(this); },
                set(v) { sd.set.call(this, v); scheduleRefresh(inst); },
            });
        } catch (e) { /* 拦不到就靠观察器 + 打开前兜底 */ }
        inst.setValue = v => vd.set.call(sel, v);
        inst.getValue = () => vd.get.call(sel);

        const MO = doc.defaultView.MutationObserver;
        inst.mo = new MO(() => scheduleRefresh(inst));
        inst.mo.observe(sel, { childList: true, subtree: true, attributes: true, attributeFilter: ['disabled', 'hidden', 'class', 'label', 'selected', 'style'] });

        inst.onChange = () => scheduleRefresh(inst);
        inst.onFocus = () => trigger.focus();
        sel.addEventListener('change', inst.onChange);
        sel.addEventListener('focus', inst.onFocus);

        trigger.addEventListener('click', () => { openInst === inst ? close(true) : open(inst); });
        trigger.addEventListener('keydown', e => onTriggerKey(inst, e));

        refreshNow(inst);
        return inst;
    }

    function destroy(sel) {
        const inst = instances.get(sel);
        if (!inst) return;
        if (openInst === inst) close(false);
        inst.mo.disconnect();
        sel.removeEventListener('change', inst.onChange);
        sel.removeEventListener('focus', inst.onFocus);
        try { delete sel.value; delete sel.selectedIndex; } catch (e) {}
        inst.trigger.remove();
        sel.classList.remove('nd-select-native');
        instances.delete(sel);
        live.delete(inst);
    }

    function enhanceAll(root) {
        (root || document).querySelectorAll('select').forEach(enhance);
    }

    function refresh(sel) {
        if (sel) { const i = instances.get(sel); if (i) refreshNow(i); return; }
        live.forEach(refreshNow);
    }

    // ── 弹层 ──
    function ensureLayer() {
        if (layer && layer.isConnected) return;
        layer = document.createElement('div');
        layer.id = 'nd-select-layer';
        layer.hidden = true;
        layer.innerHTML = '<input type="text" class="nd-select-filter" placeholder="过滤…" autocomplete="off" hidden><div class="nd-select-list" role="listbox"></div>';
        document.body.append(layer);
        const filter = layer.querySelector('.nd-select-filter');
        filter.addEventListener('input', () => { renderList(); position(); });
        filter.addEventListener('keydown', e => onListKey(e, true));
        layer.addEventListener('keydown', e => { if (e.target === layer) onListKey(e, false); });
        layer.addEventListener('pointerdown', e => {
            if (e.target.closest('.nd-select-filter')) return;
            e.preventDefault(); // 保持焦点
        });
        layer.addEventListener('click', e => {
            const opt = e.target.closest('.nd-select-option');
            if (!opt || opt.getAttribute('aria-disabled') === 'true') return;
            commit(Number(opt.dataset.index));
        });
    }

    function open(inst) {
        if (inst.sel.disabled) return;
        ensureLayer();
        if (openInst && openInst !== inst) close(false);
        refreshNow(inst);
        openInst = inst;
        const filter = layer.querySelector('.nd-select-filter');
        filter.value = '';
        filter.hidden = inst.sel.options.length <= FILTER_THRESHOLD;
        layer.hidden = false;
        layer.setAttribute('aria-labelledby', inst.trigger.id);
        activeIndex = inst.sel.selectedIndex;
        renderList();
        position();
        inst.trigger.setAttribute('aria-expanded', 'true');
        inst.trigger.classList.add('is-open');
        // 触屏不自动聚焦过滤框，免得弹出软键盘把视口挤小
        if (!filter.hidden && !isCoarse()) filter.focus();
        else layer.tabIndex = -1;
        scrollActiveIntoView();
    }

    function close(returnFocus) {
        if (!openInst) return;
        const inst = openInst;
        openInst = null;
        layer.hidden = true;
        inst.trigger.setAttribute('aria-expanded', 'false');
        inst.trigger.removeAttribute('aria-activedescendant');
        inst.trigger.classList.remove('is-open');
        if (returnFocus && inst.trigger.isConnected) inst.trigger.focus({ preventScroll: true });
    }

    function renderList() {
        if (!openInst) return;
        const { sel } = openInst;
        const list = layer.querySelector('.nd-select-list');
        const filterEl = layer.querySelector('.nd-select-filter');
        const q = filterEl.hidden ? '' : filterEl.value.trim().toLowerCase();
        list.innerHTML = '';
        items = [];
        let group = null;
        let groupEl = null;
        Array.from(sel.options).forEach((opt, index) => {
            const label = opt.label || opt.textContent;
            if (q && !label.toLowerCase().includes(q)) return;
            const og = opt.parentElement && opt.parentElement.tagName === 'OPTGROUP' ? opt.parentElement : null;
            if (og !== group) {
                group = og;
                groupEl = null;
                if (og) {
                    groupEl = document.createElement('div');
                    groupEl.setAttribute('role', 'group');
                    const head = document.createElement('div');
                    head.className = 'nd-select-group';
                    head.id = `${openInst.id}-g${index}`;
                    head.textContent = og.label;
                    groupEl.setAttribute('aria-labelledby', head.id);
                    groupEl.append(head);
                    list.append(groupEl);
                }
            }
            const el = document.createElement('div');
            const disabled = opt.disabled || (og && og.disabled);
            el.className = 'nd-select-option' + (opt.className ? ' ' + opt.className : '');
            el.id = `${openInst.id}-o${index}`;
            el.dataset.index = String(index);
            el.setAttribute('role', 'option');
            el.setAttribute('aria-selected', String(index === sel.selectedIndex));
            if (disabled) el.setAttribute('aria-disabled', 'true');
            const span = document.createElement('span');
            span.textContent = label;
            el.append(span);
            if (index === sel.selectedIndex) {
                const chk = document.createElement('i');
                chk.className = 'ri-check-line';
                chk.setAttribute('aria-hidden', 'true');
                el.append(chk);
            }
            (groupEl || list).append(el);
            items.push({ index, el, disabled, label });
        });
        if (!items.length) {
            const empty = document.createElement('div');
            empty.className = 'nd-select-empty';
            empty.textContent = '无匹配项';
            list.append(empty);
        }
        if (!items.some(i => i.index === activeIndex)) {
            const first = items.find(i => !i.disabled);
            activeIndex = first ? first.index : -1;
        }
        highlight();
    }

    function highlight() {
        items.forEach(i => i.el.classList.toggle('is-active', i.index === activeIndex));
        if (openInst) {
            const cur = items.find(i => i.index === activeIndex);
            if (cur) openInst.trigger.setAttribute('aria-activedescendant', cur.el.id);
            else openInst.trigger.removeAttribute('aria-activedescendant');
        }
    }

    function scrollActiveIntoView() {
        const cur = items.find(i => i.index === activeIndex);
        if (cur) cur.el.scrollIntoView({ block: 'nearest' });
    }

    // 始终贴着触发器：默认在正下方；下方放不下整张列表、且上方空间更大时才翻到上方。
    // 宽度不小于触发器（至少 160），不超出视口；高度超出可用空间时列表内部滚动。
    function position() {
        if (!openInst) return;
        const r = openInst.trigger.getBoundingClientRect();
        const vv = window.visualViewport;
        const vw = document.documentElement.clientWidth || window.innerWidth;
        const vh = vv ? Math.min(window.innerHeight, vv.height + vv.offsetTop) : window.innerHeight;
        const width = Math.min(Math.max(r.width, 160), vw - EDGE * 2);
        layer.style.width = `${width}px`;
        layer.style.maxHeight = `${LIST_MAX_HEIGHT}px`;
        const natural = Math.min(layer.scrollHeight, LIST_MAX_HEIGHT);
        const below = Math.max(0, vh - r.bottom - GAP - EDGE);
        const above = Math.max(0, r.top - GAP - EDGE);
        const up = below < natural && above > below;
        const maxH = Math.max(Math.min(natural, 96), Math.min(LIST_MAX_HEIGHT, up ? above : below));
        layer.style.maxHeight = `${maxH}px`;
        layer.style.left = `${Math.max(EDGE, Math.min(r.left, vw - width - EDGE))}px`;
        const h = Math.min(layer.scrollHeight, maxH);
        layer.style.top = up ? `${Math.max(EDGE, r.top - GAP - h)}px` : `${r.bottom + GAP}px`;
        layer.dataset.placement = up ? 'top' : 'bottom';
    }

    function commit(index) {
        if (!openInst) return;
        const inst = openInst;
        const opt = inst.sel.options[index];
        close(true);
        if (!opt || opt.disabled) return;
        if (inst.sel.selectedIndex !== index) {
            inst.setValue(opt.value);
            if (inst.sel.selectedIndex !== index) inst.sel.options[index].selected = true;
            refreshNow(inst);
            inst.sel.dispatchEvent(new Event('input', { bubbles: true }));
            inst.sel.dispatchEvent(new Event('change', { bubbles: true }));
        }
    }

    function move(delta) {
        const enabled = items.filter(i => !i.disabled);
        if (!enabled.length) return;
        let pos = enabled.findIndex(i => i.index === activeIndex);
        if (delta === 'home') pos = 0;
        else if (delta === 'end') pos = enabled.length - 1;
        else pos = pos < 0 ? 0 : Math.max(0, Math.min(enabled.length - 1, pos + delta));
        activeIndex = enabled[pos].index;
        highlight();
        scrollActiveIntoView();
    }

    function typeMatch(ch, options, fromIndex) {
        clearTimeout(typeTimer);
        typeBuffer += ch.toLowerCase();
        typeTimer = setTimeout(() => { typeBuffer = ''; }, 500);
        const n = options.length;
        const same = typeBuffer.split('').every(c => c === typeBuffer[0]);
        const needle = same ? typeBuffer[0] : typeBuffer;
        const start = same || typeBuffer.length === 1 ? fromIndex + 1 : fromIndex;
        for (let k = 0; k < n; k++) {
            const o = options[(start + k) % n];
            if (!o.disabled && o.label.toLowerCase().startsWith(needle)) return o.index;
        }
        return -1;
    }

    function onTriggerKey(inst, e) {
        if (openInst === inst) { onListKey(e, false); return; }
        if (['Enter', ' ', 'ArrowDown', 'ArrowUp'].includes(e.key)) {
            e.preventDefault();
            open(inst);
            return;
        }
        if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
            const opts = Array.from(inst.sel.options).map((o, index) => ({ index, label: o.label || o.textContent, disabled: o.disabled }));
            const hit = typeMatch(e.key, opts, inst.sel.selectedIndex);
            if (hit >= 0 && hit !== inst.sel.selectedIndex) {
                e.preventDefault();
                inst.setValue(inst.sel.options[hit].value);
                refreshNow(inst);
                inst.sel.dispatchEvent(new Event('input', { bubbles: true }));
                inst.sel.dispatchEvent(new Event('change', { bubbles: true }));
            }
        }
    }

    function onListKey(e, fromFilter) {
        if (!openInst) return;
        switch (e.key) {
            case 'ArrowDown': e.preventDefault(); move(1); return;
            case 'ArrowUp': e.preventDefault(); move(-1); return;
            case 'Home': if (!fromFilter) { e.preventDefault(); move('home'); } return;
            case 'End': if (!fromFilter) { e.preventDefault(); move('end'); } return;
            case 'PageDown': e.preventDefault(); move(8); return;
            case 'PageUp': e.preventDefault(); move(-8); return;
            case 'Enter': e.preventDefault(); if (activeIndex >= 0) commit(activeIndex); return;
            case 'Escape': e.preventDefault(); close(true); return;
            case 'Tab': close(false); return;
            case ' ':
                if (!fromFilter) { e.preventDefault(); if (activeIndex >= 0) commit(activeIndex); }
                return;
            default:
                if (!fromFilter && e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
                    const hit = typeMatch(e.key, items, activeIndex);
                    if (hit >= 0) { activeIndex = hit; highlight(); scrollActiveIntoView(); }
                }
        }
    }

    // ── 全局关闭时机 ──
    document.addEventListener('pointerdown', e => {
        if (!openInst) return;
        if (layer.contains(e.target) || openInst.trigger.contains(e.target)) return;
        close(false);
    }, true);
    document.addEventListener('scroll', e => {
        if (!openInst) return;
        if (layer.contains(e.target)) return;
        close(false);
    }, true);
    // 视口变化（旋转、软键盘）时重新贴位，不关闭
    const reposition = () => { if (openInst) position(); };
    window.addEventListener('resize', reposition);
    window.visualViewport?.addEventListener('resize', reposition);

    // ── 自动增强 ──
    function start() {
        enhanceAll(document);
        const bodyObserver = new MutationObserver(records => {
            for (const r of records) {
                r.addedNodes.forEach(n => {
                    if (n.nodeType !== 1) return;
                    if (n.tagName === 'SELECT') enhance(n);
                    else if (n.querySelectorAll) n.querySelectorAll('select').forEach(enhance);
                });
                r.removedNodes.forEach(n => {
                    if (n.nodeType !== 1) return;
                    const sels = n.tagName === 'SELECT' ? [n] : (n.querySelectorAll ? Array.from(n.querySelectorAll('select')) : []);
                    sels.forEach(s => { if (!s.isConnected) destroy(s); });
                });
            }
        });
        bodyObserver.observe(document.body, { childList: true, subtree: true });
    }

    window.NdSelect = { enhance, enhanceAll, refresh, destroy, close: () => close(false) };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
    else start();
})();
