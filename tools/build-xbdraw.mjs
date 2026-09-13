// Build D:\projects\XBDraw from a LittleWhiteBox checkout: copy the draw import
// closure + assets, then apply the rename rules. Re-runnable when upstream updates.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(HERE, 'LittleWhiteBox');
const SHELL = path.join(HERE, 'xbdraw-shell');
const OUT = process.argv[2] || 'D:/projects/XBDraw';

if (fs.existsSync(OUT) && fs.readdirSync(OUT).length) {
    console.error(`refusing to overwrite non-empty ${OUT}`);
    process.exit(1);
}

// ---- 1. files: import closure (minus LWB's HTML-block renderer) + non-JS assets
const closure = JSON.parse(fs.readFileSync(path.join(HERE, 'closure.json'), 'utf8')).files;
const DROP = new Set(['modules/iframe-renderer.js', 'core/wrapper-inline.js', 'core/slash-command.js']);
const files = new Set(closure.filter(f => !DROP.has(f)));

function walk(dir, filter) {
    const abs = path.join(SRC, dir);
    for (const ent of fs.readdirSync(abs, { withFileTypes: true })) {
        const rel = `${dir}/${ent.name}`;
        if (ent.isDirectory()) walk(rel, filter);
        else if (filter(rel)) files.add(rel);
    }
}
walk('modules/draw', f => !f.includes('/tests/') && /\.(html|md|dat|json|css)$/.test(f));
files.add('modules/agent-core/ui/settings-surface.css');
walk('server-plugin', () => true);
files.add('docs/LICENSE.md');

// ---- 2. rename rules (runtime identity only; chat data keys / IndexedDB names kept for compatibility)
const RULES = [
    ['EXT_ID', /export const EXT_ID = "LittleWhiteBox";/g, 'export const EXT_ID = "XBDraw";'],
    ['EXT_NAME', /export const EXT_NAME = "小白X";/g, 'export const EXT_NAME = "小黑生图";'],
    ['storage files', /'LittleWhiteBox_(\w+)\.json'/g, "'XBDraw_$1.json'"],
    ['enable flag', /window\?\.isXiaobaixEnabled/g, 'window?.isXbDrawEnabled'],
    ['window facades', /\bxiaobaix(Draw|NovelDraw|SdDraw|ComfyDraw)\b/g, 'xbdraw$1'],
    ['interceptor global', /\bxiaobaixGenerateInterceptor\b/g, 'xbdrawGenerateInterceptor'],
    ['DOM ids', /xiaobaix-(novel-draw|sd-draw|comfy-draw|sd-floating|comfy-floating|draw-image)/g, 'xbdraw-$1'],
    ['iframe msg source', /LittleWhiteBox-NovelDraw/g, 'XBDraw-NovelDraw'],
    ['comfy filename prefix', /"LittleWhiteBox_Comfy"/g, '"XBDraw_Comfy"'],
    ['plugin path hint', /third-party\/LittleWhiteBox\//g, 'third-party/XBDraw/'],
    ['UI text LittleWhiteBox', /随 LittleWhiteBox 一起下载/g, '随小黑生图一起下载'],
    ['UI text 小白X画图', /小白X画图/g, '小黑生图'],
    ['UI text 小白X', /小白X ?/g, '小黑生图'],
];
const SPECIAL = {
    // LWB's HTML code-block renderer is not part of this extension; ST's messageFormatting above already re-rendered.
    'modules/draw/providers/novelai/novel-draw.js': [[
        "                const { processMessageById } = await import('../../../iframe-renderer.js');\n                processMessageById(messageId, true);\n",
        '',
    ]],
};

const counts = Object.fromEntries(RULES.map(([n]) => [n, 0]));
let copied = 0;
for (const rel of [...files].sort()) {
    const from = path.join(SRC, rel);
    const to = path.join(OUT, rel);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    const isText = /\.(m?js|cjs|html|md|json|css|txt)$/.test(rel) && !rel.startsWith('server-plugin/') && rel !== 'docs/LICENSE.md';
    if (!isText) { fs.copyFileSync(from, to); copied++; continue; }
    let text = fs.readFileSync(from, 'utf8');
    for (const [search, replace] of SPECIAL[rel] || []) {
        const eol = text.includes('\r\n') ? search.replace(/\n/g, '\r\n') : search;
        if (!text.includes(eol)) throw new Error(`special patch not found in ${rel}`);
        text = text.replace(eol, replace);
    }
    for (const [name, re, rep] of RULES) {
        text = text.replace(re, (...m) => { counts[name]++; return m[0].replace(re, rep); });
    }
    fs.writeFileSync(to, text);
    copied++;
}
for (const name of fs.readdirSync(SHELL)) {
    fs.copyFileSync(path.join(SHELL, name), path.join(OUT, name));
    copied++;
}
console.log('copied', copied, 'files');
console.log('rename hits', counts);
