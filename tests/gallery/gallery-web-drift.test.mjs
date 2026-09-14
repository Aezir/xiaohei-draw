// 完整画廊网站拷贝（gallery-web/）：没被手改、data.json 是空模板、放在插件子路径下能跑、存储键不和插件撞；本机有 nai-gallery 时还要和 HEAD 一致
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { checkWeb, defaultSrc, subpathProblems, WEB_DIR, EMPTY_DATA } from '../../tools/sync-gallery-web.mjs';

const html = fs.readFileSync(path.join(WEB_DIR, 'index.html'), 'utf8');

test('gallery-web files are untouched copies and data.json is the empty template', () => {
    const r = checkWeb({});
    assert.deepEqual(r.problems, []);
    assert.equal(fs.readFileSync(path.join(WEB_DIR, 'data.json'), 'utf8').replace(/\r\n/g, '\n'), EMPTY_DATA);
});

test('page works under a subpath (no root-relative assets, no service worker)', () => {
    assert.deepEqual(subpathProblems(html), []);
    assert.match(html, /fetch\('data\.json'\)/);
    assert.deepEqual(subpathProblems('<img src="/x.png">').length, 1);
});

test('gallery storage keys do not collide with the plugin (same origin as SillyTavern)', () => {
    const lsKeys = [...html.matchAll(/'(nai\.[A-Za-z]+)'/g)].map(m => m[1]);
    assert.ok(lsKeys.length > 5);
    for (const k of lsKeys) assert.ok(!/^xb/i.test(k), k);
    assert.match(html, /const DB_NAME = 'nai-gallery'/);
    assert.ok(!/\bxb_/.test(html), 'gallery page must not touch plugin xb_* keys/databases');
});

test('launcher resolves the vendored page relative to its own module URL', async () => {
    const url = new URL('../../modules/draw/providers/novelai/ui/gallery-web-launcher.js', import.meta.url);
    const { GALLERY_WEB_URL, GALLERY_EMBED_URL } = await import(url.href);
    assert.equal(GALLERY_WEB_URL, new URL('../../gallery-web/index.html', import.meta.url).href);
    assert.equal(GALLERY_EMBED_URL, new URL('../../gallery-web/index.html?embed=xiaohei', import.meta.url).href);
});

const src = defaultSrc();
let hasGit = false;
try { hasGit = fs.existsSync(src) && !!execFileSync('git', ['-C', src, 'rev-parse', 'HEAD'], { encoding: 'utf8' }); } catch { /* no git / no repo */ }

test('no drift against nai-gallery HEAD (read-only git show)', { skip: !hasGit && `没找到 ${src}，跳过漂移检查` }, () => {
    const r = checkWeb({ src });
    assert.ok(r.ok, '需要重新运行 node tools/sync-gallery-web.mjs：\n' + r.problems.join('\n'));
});
