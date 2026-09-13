#!/usr/bin/env node
// 把 nai-gallery 的同步核心和 PNG 元数据函数「原样」拷贝进 XBDraw，并记录来源 commit 和 sha256。
//
//   node tools/sync-gallery-core.mjs            从 nai-gallery 的 HEAD 重新拷贝（覆盖 vendor/ 下三个文件）
//   node tools/sync-gallery-core.mjs --check    只检查：vendor 文件有没有被手改、和 nai-gallery HEAD 是否一致
//   可选：--src <nai_gallery 目录>（默认 D:\projects\nai_gallery 或环境变量 NAI_GALLERY_DIR）  --ref <git 引用>（默认 HEAD）
//
// 只读 nai-gallery：用 `git show <ref>:index.html` 取已提交的内容，不碰它的工作区，不提交、不推送。
// 退出码：0 一致 / 已写入；2 格式漂移（需要重新拷贝并复查测试）；1 出错（找不到标记等）。
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const VENDOR_DIR = path.join(ROOT, 'modules', 'draw', 'shared', 'gallery-sync', 'vendor');
export const MANIFEST = path.join(VENDOR_DIR, 'VENDOR.json');

// 每一块怎么从 index.html 里截：start 是块开头的原文，end 是块结尾（includeEnd=true 时连结尾一起拷）
export const BLOCKS = [
    {
        name: 'sync-core',
        file: 'sync-core.js',
        start: '/* ==SYNC-CORE==',
        end: '/* ==/SYNC-CORE== */',
        includeEnd: true,
        exports: ['SyncCore'],
    },
    {
        name: 'nai-meta',
        file: 'nai-meta.js',
        start: '/* ---- 读 PNG 的文本分块',
        end: '/* ================= 页内对话框',
        includeEnd: false,
        exports: ['pngText', 'NAI_TOP', 'NAI_DROP', 'naiExtras', 'metaFromPng', 'toWebp', 'sha256'],
    },
    {
        name: 'page-constants',
        file: 'page-constants.js',
        // 两个散落在页面接线里的常量，按整行截取
        lines: ['const IMG_META = ', 'const IMG_BATCH = '],
        exports: ['IMG_META', 'IMG_BATCH'],
    },
    {
        // 提示词语法高亮的分词/上色函数（纯字符串进、HTML 出；输入框叠层的 DOM 接线在 XBDraw 自己的 shared/nai-prompt-highlight.js）
        name: 'prompt-highlight',
        file: 'prompt-highlight.js',
        start: '/* ================= 提示词语法高亮 ================= */',
        end: '/* 输入框高度跟着内容走',
        includeEnd: false,
        exports: ['escH', 'wTint', 'HL', 'hlAt', 'hlPrompt'],
        runtime: '// 运行环境要求：无（纯字符串处理，浏览器和 Node 都能直接跑）。',
    },
];

const BEGIN = name => `// ==VENDOR-BEGIN ${name}==`;
const END = name => `// ==VENDOR-END ${name}==`;
export const sha256 = s => createHash('sha256').update(s, 'utf8').digest('hex');
const lineOf = (src, idx) => src.slice(0, idx).split('\n').length;

export function extractBlocks(src) {
    const out = {};
    for (const b of BLOCKS) {
        if (b.lines) {
            const all = src.split('\n');
            const picked = b.lines.map(prefix => {
                const i = all.findIndex(l => l.startsWith(prefix));
                if (i < 0) throw new Error(`index.html 里找不到「${prefix}」这一行，页面结构改过了？`);
                return { text: all[i].replace(/\r$/, ''), line: i + 1 };
            });
            const text = picked.map(p => p.text).join('\n');
            out[b.name] = { text, sha256: sha256(text), lines: picked.map(p => p.line) };
            continue;
        }
        const a = src.indexOf(b.start);
        if (a < 0) throw new Error(`index.html 里找不到开始标记「${b.start}」`);
        if (src.indexOf(b.start, a + 1) >= 0) throw new Error(`开始标记「${b.start}」出现了不止一次`);
        const e = src.indexOf(b.end, a);
        if (e < 0) throw new Error(`index.html 里找不到结束标记「${b.end}」`);
        const text = src.slice(a, b.includeEnd ? e + b.end.length : e).replace(/\s+$/, '');
        out[b.name] = { text, sha256: sha256(text), lines: [lineOf(src, a), lineOf(src, a + text.length)] };
    }
    const m = /const SCHEMA = (\d+);/.exec(out['sync-core'].text);
    if (!m) throw new Error('同步核心里找不到 SCHEMA');
    return { blocks: out, schema: Number(m[1]) };
}

// 从 vendor 文件里把两个标记之间的原文拿回来（用来发现手改）
export function bodyOfVendorFile(content, name) {
    const a = content.indexOf(BEGIN(name) + '\n');
    const e = content.indexOf('\n' + END(name));
    if (a < 0 || e < 0) return null;
    return content.slice(a + BEGIN(name).length + 1, e);
}

export function readSource({ src, ref = 'HEAD' }) {
    const text = execFileSync('git', ['-C', src, 'show', `${ref}:index.html`], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    const commit = execFileSync('git', ['-C', src, 'rev-parse', ref], { encoding: 'utf8' }).trim();
    return { text: text.replace(/\r\n/g, '\n'), commit };
}

function renderVendorFile(b, blk, commit) {
    return [
        '// 自动生成，禁止手改。重新生成：node tools/sync-gallery-core.mjs',
        `// 来源：nai-gallery index.html @ ${commit} 第 ${blk.lines.join(blk.lines.length === 2 && !b.lines ? '-' : ', ')} 行`,
        `// 原文 sha256：${blk.sha256}`,
        '// 适配：只在原文前后加了标记注释和一行 export，原文一个字符都没改。',
        b.runtime || '// 运行环境要求（浏览器和 Node 18+ 都自带）：fetch、crypto.subtle、CompressionStream、Response、Blob、btoa/atob、TextEncoder。',
        BEGIN(b.name),
        blk.text,
        END(b.name),
        `export { ${b.exports.join(', ')} };`,
        '',
    ].join('\n');
}

export function checkVendor({ src, ref = 'HEAD' } = {}) {
    const problems = [];
    let manifest;
    try { manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8')); }
    catch { return { ok: false, drift: false, problems: ['还没有 vendor/VENDOR.json：先运行 node tools/sync-gallery-core.mjs'] }; }
    for (const b of BLOCKS) {
        const want = manifest.blocks[b.name];
        const content = fs.existsSync(path.join(VENDOR_DIR, b.file)) ? fs.readFileSync(path.join(VENDOR_DIR, b.file), 'utf8') : '';
        const body = bodyOfVendorFile(content.replace(/\r\n/g, '\n'), b.name);
        if (body === null) problems.push(`${b.file}：缺少 VENDOR 标记`);
        else if (!want || sha256(body) !== want.sha256) problems.push(`${b.file}：内容和 VENDOR.json 记录的 sha256 不一致（被手改过？）`);
    }
    let drift = false, upstream = null;
    if (src && fs.existsSync(src)) {
        const { text, commit } = readSource({ src, ref });
        const now = extractBlocks(text);
        upstream = { commit, schema: now.schema };
        for (const b of BLOCKS) {
            if (now.blocks[b.name].sha256 !== manifest.blocks[b.name]?.sha256) {
                drift = true;
                problems.push(`${b.name}：nai-gallery ${commit.slice(0, 7)} 里的原文变了（记录的是 ${manifest.commit.slice(0, 7)}），需要重新拷贝`);
            }
        }
        if (now.schema !== manifest.schema) problems.push(`SCHEMA 从 ${manifest.schema} 变成了 ${now.schema}：数据格式升级，XBDraw 写入前必须复查`);
    }
    return { ok: problems.length === 0, drift, problems, manifest, upstream };
}

export function writeVendor({ src, ref = 'HEAD' }) {
    const { text, commit } = readSource({ src, ref });
    const { blocks, schema } = extractBlocks(text);
    fs.mkdirSync(VENDOR_DIR, { recursive: true });
    for (const b of BLOCKS) fs.writeFileSync(path.join(VENDOR_DIR, b.file), renderVendorFile(b, blocks[b.name], commit));
    const manifest = {
        source: 'Aezir/nai-gallery index.html',
        commit,
        schema,
        blocks: Object.fromEntries(BLOCKS.map(b => [b.name, { file: b.file, sha256: blocks[b.name].sha256, lines: blocks[b.name].lines }])),
    };
    fs.writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2) + '\n');
    return manifest;
}

export const defaultSrc = () => process.env.NAI_GALLERY_DIR || 'D:\\projects\\nai_gallery';

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const args = process.argv.slice(2);
    const opt = k => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
    const src = opt('--src') || defaultSrc(), ref = opt('--ref') || 'HEAD';
    try {
        if (args.includes('--check')) {
            const r = checkVendor({ src, ref });
            if (r.ok) console.log(`一致：vendor 来自 ${r.manifest.commit.slice(0, 7)}，SCHEMA ${r.manifest.schema}` + (r.upstream ? `；nai-gallery 当前 ${r.upstream.commit.slice(0, 7)}` : '（没找到 nai-gallery，只查了手改）'));
            else r.problems.forEach(p => console.error('× ' + p));
            process.exit(r.ok ? 0 : r.drift ? 2 : 1);
        }
        const m = writeVendor({ src, ref });
        console.log(`已拷贝 nai-gallery ${m.commit.slice(0, 7)}（SCHEMA ${m.schema}）→ ${path.relative(ROOT, VENDOR_DIR)}`);
        for (const [name, b] of Object.entries(m.blocks)) console.log(`  ${b.file}  行 ${b.lines.join(',')}  sha256 ${b.sha256.slice(0, 12)}…  (${name})`);
    } catch (e) {
        console.error('失败：' + e.message);
        process.exit(1);
    }
}
