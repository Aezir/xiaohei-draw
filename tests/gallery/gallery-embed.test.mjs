// 图片管理页嵌入完整画廊：设置页 ↔ 画廊的消息约定（embed-bridge.js）+ 画廊页面里嵌入模式的静态检查
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import {
    EMBED_HOST_SOURCE, EMBED_SOURCE, embedUrl, hostMessage, isTrustedEmbedMessage, linkReply, parseImportRequest,
} from '../../modules/draw/shared/gallery-sync/embed-bridge.js';
import { WEB_DIR } from '../../tools/sync-gallery-web.mjs';

const ORIGIN = 'http://127.0.0.1:8000';
const frame = { name: 'gallery-iframe' };

test('embedUrl adds ?embed=xiaohei and keeps the path', () => {
    assert.equal(embedUrl('http://x/ext/gallery-web/index.html'), 'http://x/ext/gallery-web/index.html?embed=xiaohei');
    assert.equal(embedUrl('http://x/g/index.html?a=1&embed=no'), 'http://x/g/index.html?a=1&embed=xiaohei');
});

test('only same-origin messages from the gallery iframe are trusted', () => {
    const data = { source: EMBED_SOURCE, type: 'hello' };
    assert.equal(isTrustedEmbedMessage({ origin: ORIGIN, source: frame, data }, { origin: ORIGIN, frameWindow: frame }), true);
    assert.equal(isTrustedEmbedMessage({ origin: 'https://evil.example', source: frame, data }, { origin: ORIGIN, frameWindow: frame }), false);
    assert.equal(isTrustedEmbedMessage({ origin: ORIGIN, source: {}, data }, { origin: ORIGIN, frameWindow: frame }), false);
    assert.equal(isTrustedEmbedMessage({ origin: ORIGIN, source: frame, data: { ...data, source: 'other' } }, { origin: ORIGIN, frameWindow: frame }), false);
    assert.equal(isTrustedEmbedMessage({ origin: ORIGIN, source: frame, data: 'hello' }, { origin: ORIGIN, frameWindow: frame }), false);
    assert.equal(isTrustedEmbedMessage({ origin: ORIGIN, source: frame, data }, { origin: ORIGIN, frameWindow: null }), false);
});

test('parseImportRequest keeps only record/vars/varIndex and clamps indexes', () => {
    const meta = { prompt: '1girl', model: 'nai-diffusion-4-5-full', seed: 1 };
    const r = parseImportRequest({ source: EMBED_SOURCE, type: 'import-preset', record: { id: 'abc123', meta, extra: 1 }, vars: { list: [{ prompt: 'x' }], active: 0, t: 5 }, varIndex: 0, tok: 'leak' });
    assert.deepEqual(r, { record: { id: 'abc123', meta }, vars: { list: [{ prompt: 'x' }], active: 0 }, varIndex: 0 });
    assert.deepEqual(parseImportRequest({ record: { id: 'a', meta }, vars: { list: [], active: 3 }, varIndex: 2 }), { record: { id: 'a', meta }, vars: { list: [], active: -1 }, varIndex: -1 });
    assert.deepEqual(parseImportRequest({ record: { id: 'a', meta } }), { record: { id: 'a', meta }, vars: null, varIndex: -1 });
    assert.throws(() => parseImportRequest({ record: { id: '../x', meta } }), /编号/);
    assert.throws(() => parseImportRequest({ record: { id: 'a', meta: [] } }), /参数/);
    assert.throws(() => parseImportRequest(null), /格式/);
});

test('linkReply sends only repo/tok/key, or null when not connected', () => {
    assert.deepEqual(linkReply({ repo: 'u/r', tok: 't', key: 'k', savedAt: 1, pw: 'secret' }), { source: EMBED_HOST_SOURCE, type: 'link', creds: { repo: 'u/r', tok: 't', key: 'k' } });
    assert.deepEqual(linkReply(null), { source: EMBED_HOST_SOURCE, type: 'link', creds: null });
    assert.equal(linkReply({ repo: 'u/r', tok: '', key: 'k' }).creds, null);
    assert.deepEqual(hostMessage('toast', { text: 'hi', source: 'spoof' }), { text: 'hi', source: EMBED_HOST_SOURCE, type: 'toast' });
});

const html = fs.readFileSync(path.join(WEB_DIR, 'index.html'), 'utf8');

test('gallery page: every inline script still parses (a stray line once broke if/else)', () => {
    let n = 0;
    for (const m of html.matchAll(/<script(\s[^>]*)?>([\s\S]*?)<\/script>/g)) {
        if (/\bsrc=/.test(m[1] || '')) continue;
        n++;
        assert.doesNotThrow(() => new vm.Script(m[2], { filename: `gallery-web/index.html#script${n}` }));
    }
    assert.ok(n >= 1);
});

test('gallery page: embed mode is opt-in (?embed=xiaohei inside an iframe) and standalone look is untouched', () => {
    assert.match(html, /const EMBED = new URLSearchParams\(location\.search\)\.get\('embed'\) === 'xiaohei' && window\.parent !== window;/);
    // 小黑生图主题、隐藏外壳只挂在 data-theme="xiaohei" / data-embed="xiaohei" 上
    const css = html.slice(html.indexOf('<style>'), html.indexOf('</style>'));
    for (const m of css.matchAll(/[^{}]*xiaohei[^{}]*\{/g)) assert.match(m[0], /data-(theme|embed)="xiaohei"/, m[0]);
    assert.match(css, /:root\[data-theme="xiaohei"\]\{[^}]*--accent:#e889b0/);
    assert.match(html, /if \(EMBED\)\{ document\.documentElement\.dataset\.theme = 'xiaohei'; return; \}/);
    // 按钮默认隐藏，只有嵌入时才显示
    assert.match(html, /<div class="xhrow" id="xhrow" hidden>/);
    assert.match(html, /if \(EMBED\)\{\s*\$\('#xhrow'\)\.hidden = false;/);
});

test('gallery page: postMessage is pinned to the same origin and checks the parent window', () => {
    assert.match(html, /window\.parent\.postMessage\(\{\.\.\.data, source: SRC, type\}, ORIGIN\)/);
    assert.match(html, /if \(e\.origin !== ORIGIN \|\| e\.source !== window\.parent\) return;/);
    assert.ok(!/postMessage\([^)]*'\*'\)/.test(html), 'no wildcard targetOrigin');
});

test('gallery page: plugin credentials stay in memory (never written to nai.sync)', () => {
    assert.match(html, /SYC = \{repo: c\.repo, tok: c\.tok, key: c\.key, last: 0, host: true\}/);
    assert.match(html, /const saveSYC = \(\) => \{ if \(SYC && !SYC\.host\) localStorage\.setItem\(SYNC_KEY/);
    // 同步成功后只通过 saveSYC 落盘；手动连接（非 host）照旧写 nai.sync
    const writes = [...html.matchAll(/localStorage\.setItem\(SYNC_KEY/g)].length;
    assert.equal(writes, 2, 'saveSYC + 手动连接各一处');
});
