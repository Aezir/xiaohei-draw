#!/usr/bin/env node
// 把 nai-gallery 整个静态网站（index.html + icon.svg）「原样」拷贝进插件的 gallery-web/，设置页「打开完整画廊」用 iframe 加载它。
//
//   node tools/sync-gallery-web.mjs            从 nai-gallery 的 HEAD 重新拷贝（覆盖 gallery-web/ 下的文件）
//   node tools/sync-gallery-web.mjs --check    只检查：gallery-web 文件有没有被手改、和 nai-gallery HEAD 是否一致
//   可选：--src <nai_gallery 目录>（默认 D:\projects\nai_gallery 或环境变量 NAI_GALLERY_DIR）  --ref <git 引用>（默认 HEAD）
//
// 只读 nai-gallery：用 `git show <ref>:<文件>` 取已提交的内容，不碰它的工作区，不提交、不推送。
// data.json 不从源仓库拷：插件里固定放空模板 {"batches":[],"total":0}，绝不带任何图和用户数据。
// vercel.json 不拷：里面只有 img/ 和 data.json 的缓存头，页面功能不依赖它。
// 退出码：0 一致 / 已写入；2 上游变了（需要重新拷贝）；1 出错或被手改。
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const WEB_DIR = path.join(ROOT, 'gallery-web');
export const WEB_MANIFEST = path.join(WEB_DIR, 'VENDOR.json');
export const COPIED_FILES = ['index.html', 'icon.svg'];
export const EMPTY_DATA = '{"batches":[],"total":0}\n';

export const sha256 = s => createHash('sha256').update(s, 'utf8').digest('hex');
const norm = s => s.replace(/\r\n/g, '\n');

export function readSourceFiles({ src, ref = 'HEAD' }) {
    const files = {};
    for (const f of COPIED_FILES) {
        files[f] = norm(execFileSync('git', ['-C', src, 'show', `${ref}:${f}`], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }));
    }
    const commit = execFileSync('git', ['-C', src, 'rev-parse', ref], { encoding: 'utf8' }).trim();
    return { files, commit };
}

// 页面放在子路径下（/scripts/extensions/third-party/<插件目录>/gallery-web/）能不能跑的静态检查
export function subpathProblems(html) {
    const out = [];
    const rooted = /\s(?:src|href)=["']\/(?!\/)/g;
    if (rooted.test(html)) out.push('index.html 里有以 / 开头的 src/href，放在插件子路径下会 404');
    if (/serviceWorker\s*\.\s*register/.test(html)) out.push('index.html 注册了 Service Worker，同源嵌进酒馆会接管酒馆页面，必须复查');
    if (/fetch\(\s*['"`]\//.test(html)) out.push('index.html 用绝对路径 fetch 站内文件，子路径下会 404');
    return out;
}

export function checkWeb({ src, ref = 'HEAD' } = {}) {
    const problems = [];
    let manifest;
    try { manifest = JSON.parse(fs.readFileSync(WEB_MANIFEST, 'utf8')); }
    catch { return { ok: false, drift: false, problems: ['还没有 gallery-web/VENDOR.json：先运行 node tools/sync-gallery-web.mjs'] }; }
    for (const f of COPIED_FILES) {
        const p = path.join(WEB_DIR, f);
        const text = fs.existsSync(p) ? norm(fs.readFileSync(p, 'utf8')) : null;
        if (text === null) problems.push(`gallery-web/${f}：文件不见了`);
        else if (sha256(text) !== manifest.files?.[f]?.sha256) problems.push(`gallery-web/${f}：内容和 VENDOR.json 记录的 sha256 不一致（被手改过？）`);
    }
    const dataPath = path.join(WEB_DIR, 'data.json');
    const data = fs.existsSync(dataPath) ? norm(fs.readFileSync(dataPath, 'utf8')) : null;
    if (data !== EMPTY_DATA) problems.push('gallery-web/data.json 必须是空模板 {"batches":[],"total":0}（插件里不放任何图和数据）');
    let drift = false, upstream = null;
    if (src && fs.existsSync(src)) {
        const now = readSourceFiles({ src, ref });
        upstream = { commit: now.commit };
        for (const f of COPIED_FILES) {
            if (sha256(now.files[f]) !== manifest.files?.[f]?.sha256) {
                drift = true;
                problems.push(`${f}：nai-gallery ${now.commit.slice(0, 7)} 里的文件变了（记录的是 ${String(manifest.commit).slice(0, 7)}），需要重新拷贝`);
            }
        }
    }
    return { ok: problems.length === 0, drift, problems, manifest, upstream };
}

export function writeWeb({ src, ref = 'HEAD' }) {
    const { files, commit } = readSourceFiles({ src, ref });
    const warn = subpathProblems(files['index.html']);
    if (warn.length) throw new Error(warn.join('；'));
    fs.mkdirSync(WEB_DIR, { recursive: true });
    for (const f of COPIED_FILES) fs.writeFileSync(path.join(WEB_DIR, f), files[f]);
    fs.writeFileSync(path.join(WEB_DIR, 'data.json'), EMPTY_DATA);
    const manifest = {
        source: 'Aezir/nai-gallery',
        commit,
        note: '自动生成，禁止手改。index.html / icon.svg 原样拷贝（只统一了换行符）；data.json 是插件自带的空模板，不来自源仓库。重新生成：node tools/sync-gallery-web.mjs',
        files: Object.fromEntries(COPIED_FILES.map(f => [f, { sha256: sha256(files[f]), bytes: Buffer.byteLength(files[f]) }])),
    };
    fs.writeFileSync(WEB_MANIFEST, JSON.stringify(manifest, null, 2) + '\n');
    return manifest;
}

export const defaultSrc = () => process.env.NAI_GALLERY_DIR || 'D:\\projects\\nai_gallery';

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const args = process.argv.slice(2);
    const opt = k => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
    const src = opt('--src') || defaultSrc(), ref = opt('--ref') || 'HEAD';
    try {
        if (args.includes('--check')) {
            const r = checkWeb({ src, ref });
            if (r.ok) console.log(`一致：gallery-web 来自 ${r.manifest.commit.slice(0, 7)}` + (r.upstream ? `；nai-gallery 当前 ${r.upstream.commit.slice(0, 7)}` : '（没找到 nai-gallery，只查了手改）'));
            else r.problems.forEach(p => console.error('× ' + p));
            process.exit(r.ok ? 0 : r.drift ? 2 : 1);
        }
        const m = writeWeb({ src, ref });
        console.log(`已拷贝 nai-gallery ${m.commit.slice(0, 7)} → gallery-web/`);
        for (const [f, b] of Object.entries(m.files)) console.log(`  ${f}  ${b.bytes} 字节  sha256 ${b.sha256.slice(0, 12)}…`);
        console.log('  data.json  空模板');
    } catch (e) {
        console.error('失败：' + e.message);
        process.exit(1);
    }
}
