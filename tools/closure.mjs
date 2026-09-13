// Compute transitive import closure of draw entry files inside the LittleWhiteBox repo.
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(process.argv[2]);
const entries = process.argv.slice(3).map(p => path.resolve(ROOT, p));
const seen = new Set();
const external = new Map(); // spec -> importers
const missing = [];
const dynamicNonLiteral = [];

const RE = [
  /\bimport\s+(?:[\s\S]*?\s+from\s+)?['"]([^'"]+)['"]/g,
  /\bexport\s+(?:\*|\{[\s\S]*?\})\s+from\s+['"]([^'"]+)['"]/g,
  /\bimport\s*\(\s*['"`]([^'"`$]+)['"`]\s*\)/g,
];

function visit(file) {
  if (seen.has(file)) return;
  if (!fs.existsSync(file)) { missing.push(file); return; }
  seen.add(file);
  if (!/\.(m?js|cjs)$/.test(file)) return;
  const src = fs.readFileSync(file, 'utf8');
  if (/\bimport\s*\(\s*[^'"`\s)]/.test(src)) dynamicNonLiteral.push(path.relative(ROOT, file));
  for (const re of RE) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(src))) {
      const spec = m[1];
      if (!spec.startsWith('.')) { add(external, spec, file); continue; }
      const target = path.resolve(path.dirname(file), spec);
      if (!target.startsWith(ROOT + path.sep)) { add(external, spec, file); continue; }
      visit(target);
    }
  }
}
function add(map, k, f) { if (!map.has(k)) map.set(k, new Set()); map.get(k).add(path.relative(ROOT, f)); }

entries.forEach(visit);
const files = [...seen].map(f => path.relative(ROOT, f).replace(/\\/g, '/')).sort();
fs.writeFileSync(path.join(path.dirname(new URL(import.meta.url).pathname.slice(1)), 'closure.json'),
  JSON.stringify({ files, missing, dynamicNonLiteral, external: Object.fromEntries([...external].map(([k, v]) => [k, [...v]])) }, null, 2));
const byTop = {};
for (const f of files) { const t = f.split('/').slice(0, 2).join('/'); byTop[t] = (byTop[t] || 0) + 1; }
console.log('files', files.length, byTop);
console.log('missing', missing);
console.log('dynamic non-literal', dynamicNonLiteral);
console.log('external specs', [...external.keys()]);
