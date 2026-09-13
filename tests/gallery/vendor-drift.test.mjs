// 拷贝一致性：vendor 文件没被手改；如果本机有 nai-gallery，还要和它当前 HEAD 的原文一致（不一致 = 格式漂移，重新拷贝并复查）
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { checkVendor, defaultSrc, extractBlocks, BLOCKS } from '../../tools/sync-gallery-core.mjs';
import { SyncCore } from '../../modules/draw/shared/gallery-sync/vendor/sync-core.js';
import * as meta from '../../modules/draw/shared/gallery-sync/vendor/nai-meta.js';
import { IMG_META, IMG_BATCH } from '../../modules/draw/shared/gallery-sync/vendor/page-constants.js';

globalThis.fetch = () => { throw new Error('network access is forbidden in tests'); };

test('vendor files are untouched copies (sha256 matches VENDOR.json)', () => {
    const r = checkVendor({});
    assert.deepEqual(r.problems, []);
    assert.equal(r.manifest.schema, SyncCore.SCHEMA);
});

test('vendored modules export what the client needs', () => {
    for (const k of ['connect', 'sync', 'findRepo', 'readBytes', 'snapshot', 'openState', 'merge', 'blank', 'same']) assert.equal(typeof SyncCore[k], 'function', k);
    for (const k of ['pngText', 'naiExtras', 'metaFromPng', 'toWebp', 'sha256']) assert.equal(typeof meta[k], 'function', k);
    assert.ok(IMG_META.includes('nai') && IMG_META.includes('batch'));
    assert.equal(IMG_BATCH, 30);
});

test('extractor refuses a page whose markers are gone', () => {
    assert.throws(() => extractBlocks('<script>nothing here</script>'), /找不到/);
});

const src = defaultSrc();
let hasGit = false;
try { hasGit = fs.existsSync(src) && !!execFileSync('git', ['-C', src, 'rev-parse', 'HEAD'], { encoding: 'utf8' }); } catch { /* no git / no repo */ }

test('no format drift against nai-gallery HEAD (read-only git show)', { skip: !hasGit && `没找到 ${src}，跳过漂移检查` }, () => {
    const r = checkVendor({ src });
    assert.ok(r.ok, '需要重新运行 node tools/sync-gallery-core.mjs 并复查测试：\n' + r.problems.join('\n'));
    assert.equal(Object.keys(r.manifest.blocks).length, BLOCKS.length);
});
