// 自动生成，禁止手改。重新生成：node tools/sync-gallery-core.mjs
// 来源：nai-gallery index.html @ ed8458d9a17383228f22d88fc9824cac5829d1b9 第 1715-1794 行
// 原文 sha256：eb8fae4966875c7e58971d6d1b957dd7751e4d422589f87637b5332c1420c491
// 适配：只在原文前后加了标记注释和一行 export，原文一个字符都没改。
// 运行环境要求（浏览器和 Node 18+ 都自带）：fetch、crypto.subtle、CompressionStream、Response、Blob、btoa/atob、TextEncoder。
// ==VENDOR-BEGIN nai-meta==
/* ---- 读 PNG 的文本分块，NAI 把完整 JSON 放在 tEXt[Comment] 里 ---- */
function pngText(buf){
  const v = new DataView(buf), u8 = new Uint8Array(buf), out = {};
  if (v.getUint32(0) !== 0x89504e47) return null;      // 不是 PNG
  let p = 8;
  const dec = new TextDecoder('utf-8');
  while (p + 8 <= u8.length){
    const len = v.getUint32(p), typ = String.fromCharCode(...u8.subarray(p + 4, p + 8));
    const data = u8.subarray(p + 8, p + 8 + len);
    if (typ === 'IDAT' || typ === 'IEND') break;
    try{
      if (typ === 'tEXt'){
        const z = data.indexOf(0);
        out[dec.decode(data.subarray(0, z))] = dec.decode(data.subarray(z + 1));
      } else if (typ === 'iTXt'){
        const z = data.indexOf(0);
        const key = dec.decode(data.subarray(0, z));
        // compression flag, method, language, translated key, then text
        let q = z + 3;
        for (let n = 0; n < 2; n++) q = data.indexOf(0, q) + 1;
        if (!out[key]) out[key] = dec.decode(data.subarray(q));
      }
    }catch(_){}
    p += 12 + len;
  }
  return out;
}

/* 影响出图的全部参数，规则和 data.json 的回填脚本一致：
   丢掉顶层已有的（prompt/uc/seed…）和纯传输用的（签名、流式格式）；null 丢，但 skip_cfg_above_sigma 留（null = Variety+ 关）；
   空列表、全是默认值的对象丢；角色提示词从 v4_prompt / v4_negative_prompt 拆成 chars */
const NAI_TOP  = new Set(['prompt', 'uc', 'seed', 'steps', 'scale', 'sampler', 'width', 'height']);
const NAI_DROP = new Set(['signed_hash', 'request_type', 'stream', 'version', 'n_samples', 'model_name', 'v4_prompt', 'v4_negative_prompt']);
function naiExtras(j){
  if (!j || !j.sampler) return undefined;                // 不是 NAI 的图就不留这个字段
  const o = {};
  for (const [k, v] of Object.entries(j)){
    if (NAI_TOP.has(k) || NAI_DROP.has(k)) continue;
    if (v === null && k !== 'skip_cfg_above_sigma') continue;
    if (v && typeof v === 'object' && !Object.keys(v).length) continue;
    if (v && typeof v === 'object' && !Array.isArray(v) && Object.values(v).every(x => [null, false, true, 0, 1, ''].includes(x))) continue;
    o[k] = v;
  }
  if (!j.controlnet_model) delete o.controlnet_strength;
  const vp = j.v4_prompt || {}, vn = j.v4_negative_prompt || {};
  const pc = (vp.caption || {}).char_captions || [], nc = (vn.caption || {}).char_captions || [];
  if (pc.length) o.chars = pc.map((c, i) => ({prompt: c.char_caption || '', uc: (nc[i] || {}).char_caption || '', centers: c.centers || []}));
  ['use_coords', 'use_order', 'legacy_uc'].forEach(k => { if (k in vp) o[k] = vp[k]; });
  return o;
}

/* 把 NAI 的元数据整成和 data.json 同构的记录 */
function metaFromPng(text, file){
  let j = {};
  try{ j = JSON.parse(text.Comment || '{}'); }catch(_){}
  const src = text.Source || '';
  return {
    prompt: j.prompt || text.Description || '',   // 认不出就留空，用户可以自己填
    uc: j.uc || j.negative_prompt || '',
    seed: j.seed, steps: j.steps, scale: j.scale, sampler: j.sampler, nai: naiExtras(j),
    model: /V5|Diffusion 5/i.test(src) ? 'V5' : /V4/i.test(src) ? 'V4.5' : (src || '未知'),
    at: new Date(file.lastModified).toISOString(),
    file: file.name,
  };
}

/* 用 canvas 转出缩略图和大图。缩略图参数跟 _build_site.py 一致；
   大图从 2026-09 起用 q95（实测 q82 细发丝发软，q95 局部放大和原图几乎分不出；仓库里的旧图不重压） */
function toWebp(bmp, max, q){
  const s = Math.min(1, max / Math.max(bmp.width, bmp.height));
  const w = Math.round(bmp.width * s), h = Math.round(bmp.height * s);
  const cv = document.createElement('canvas');
  cv.width = w; cv.height = h;
  cv.getContext('2d').drawImage(bmp, 0, 0, w, h);
  return new Promise(ok => cv.toBlob(ok, 'image/webp', q));
}
async function sha256(buf){
  const h = await crypto.subtle.digest('SHA-256', buf);
  return [...new Uint8Array(h)].slice(0, 16).map(b => b.toString(16).padStart(2, '0')).join('');
}
// ==VENDOR-END nai-meta==
export { pngText, NAI_TOP, NAI_DROP, naiExtras, metaFromPng, toWebp, sha256 };
