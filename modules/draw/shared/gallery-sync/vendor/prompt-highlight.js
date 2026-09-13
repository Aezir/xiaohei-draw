// 自动生成，禁止手改。重新生成：node tools/sync-gallery-core.mjs
// 来源：nai-gallery index.html @ ed8458d9a17383228f22d88fc9824cac5829d1b9 第 1926-2040 行
// 原文 sha256：611928ef7d8c62b99b5ab8dbf38306c098a1051d5eb0a5b5903dd27d29c1b705
// 适配：只在原文前后加了标记注释和一行 export，原文一个字符都没改。
// 运行环境要求：无（纯字符串处理，浏览器和 Node 都能直接跑）。
// ==VENDOR-BEGIN prompt-highlight==
/* ================= 提示词语法高亮 ================= */
/* 一遍扫过去，按 NAI 语法切片上色：
   1.6::…::  权重块（块内背景按权重冷暖着色，负权重偏红）   (tag:1.3)  括号权重
   {{…}} [[…]]  强调/弱化，按层数换色   artist xxx  画师   |  角色分隔   , ，  分隔符
   同时记下语法问题：多余的 ::、权重块没收尾、括号没配对。 */
const escH = t => t.replace(/[&<>]/g, c => c === '&' ? '&amp;' : c === '<' ? '&lt;' : '&gt;');
function wTint(w){
  if (w < 0) return `rgba(255,90,110,${Math.min(.36, .14 - w * .04).toFixed(3)})`;
  if (w === 1) return '';
  const a = Math.min(.34, .06 + Math.abs(Math.log(Math.max(w, .05))) * .13).toFixed(3);
  return w > 1 ? `rgba(255,149,96,${a})` : `rgba(124,156,255,${a})`;
}
const HL = {
  open: /-?\d+(?:\.\d+)?::/y,                          // 1.6::  -4::
  sd:   /\(([^()（）]*?):\s*(-?\d+(?:\.\d+)?)\s*([)）])/y,  // (cel shading:1.6)，全角 ）收尾也认出来
  one:  /-?\d+(?:\.\d+)?:(?![:\d])/y,                   // 1.2:tag —— 多半是少打了一个冒号
  rep:  /\(x\s*\d+x?\)/iy,                              // (x 127x)
  art:  /artist(\s*[:：]\s*|\s+)/iy,
  name: /[^,，\n|:{}\[\]]*/y,
  run:  /[^,，\n|:{}\[\]()\s-]+/y,
};
const hlAt = (rx, t, i) => { rx.lastIndex = i; return rx.exec(t); };
function hlPrompt(t){
  const P = [], stack = [], bad = {stray: 0, open: 0, br: 0, fw: 0, one: 0, nonum: 0};
  const span = (cls, text) => P.push(`<span class="${cls}">${escH(text)}</span>`);
  let w = null, i = 0, tok = true;          // w：正在进行的权重块；tok：当前是否在一个 tag 的开头
  const closeW = () => { if (w){ P.push('</span>'); w = null; } };
  while (i < t.length){
    const c = t[i];
    let m;
    if (tok && (c === '-' || (c >= '0' && c <= '9')) && (m = hlAt(HL.open, t, i))){
      closeW();
      const wt = parseFloat(m[0]);
      w = {at: P.length};
      span('hw', m[0]);
      P.push(`<span class="wb" style="background:${wTint(wt)}">`);
      i += m[0].length; tok = true; continue;
    }
    if (tok && (c === '-' || (c >= '0' && c <= '9')) && (m = hlAt(HL.one, t, i))){
      span('hw hwarn', m[0]); bad.one++;
      i += m[0].length; tok = true; continue;
    }
    if (c === '（' || c === '）'){ span('hb hwarn', c); bad.fw++; i++; continue; }
    if (c === ':' && t[i + 1] === ':'){
      if (w){ closeW(); span('hw', '::'); }
      else if (/[^\s,，|:]/.test(t[i + 2] || '') && t.indexOf('::', i + 2) > 0){
        span('hw herr', '::'); bad.nonum++;
        w = {at: P.length - 1, nonum: true};
        P.push('<span class="wb">');
      }
      else { span('hw herr', '::'); bad.stray++; }
      i += 2; tok = true; continue;
    }
    if (c === '('){
      if ((m = hlAt(HL.sd, t, i))){
        const wt = parseFloat(m[2]);
        P.push(`<span class="wb" style="background:${wTint(wt)}">`);
        span('hb', '(');
        P.push(hlPrompt(m[1]).html);
        span('hw', m[0].slice(1 + m[1].length, -1));
        if (m[3] === '）'){ span('hb hwarn', m[3]); bad.fw++; } else span('hb', ')');
        P.push('</span>');
        i += m[0].length; tok = false; continue;
      }
      if ((m = hlAt(HL.rep, t, i))){ span('hx', m[0]); i += m[0].length; continue; }
    }
    if (c === '(' || c === '{' || c === '['){
      const depth = c === '(' ? 0 : stack.filter(x => x.ch === c).length + 1;
      stack.push({ch: c, at: P.length});
      span(c === '(' ? 'hb' : 'hbr d' + ((depth - 1) % 3 + 1), c);
      i++; tok = true; continue;
    }
    if (c === ')' || c === '}' || c === ']'){
      const want = {')': '(', '}': '{', ']': '['}[c];
      const top = stack[stack.length - 1];
      if (top && top.ch === want){
        const depth = c === ')' ? 0 : stack.filter(x => x.ch === want).length;
        stack.pop();
        span(c === ')' ? 'hb' : 'hbr d' + ((depth - 1) % 3 + 1), c);
      } else { span('hb herr', c); bad.br++; }
      i++; continue;
    }
    if (c === '|'){ span('hp', c); i++; tok = true; continue; }
    if (c === ',' || c === '，'){ span('hc', c); i++; tok = true; continue; }
    if (c === '\n'){ P.push(c); i++; tok = true; continue; }        // 换行也是 tag 的分界
    if (c === ' ' || c === '\t'){ P.push(c); i++; continue; }
    if (tok && (c === 'a' || c === 'A') && (m = hlAt(HL.art, t, i))){
      const nm = hlAt(HL.name, t, i + m[0].length)[0];
      const core = nm.replace(/\s+$/, '');
      // 「artist collaboration」是多画师混合的元标记，不是某位画师
      if (core && !/^collaboration$/i.test(core)){
        span('hap', m[0]);
        const r = core.match(/^(.*?)(\s*\(x\s*\d+x?\))?$/i);
        span('han', r[1]);
        if (r[2]) span('hx', r[2]);
        i += m[0].length + core.length; tok = false; continue;
      }
    }
    if ((m = hlAt(HL.run, t, i)) && m[0]){ P.push(escH(m[0])); i += m[0].length; tok = false; continue; }
    P.push(escH(c)); i++; tok = false;             // 单个 : 或 - 之类
  }
  if (w){
    if (!w.nonum){ P[w.at] = P[w.at].replace('class="hw"', 'class="hw hwarn"'); bad.open++; }
    closeW();
  }
  stack.forEach(x => { P[x.at] = P[x.at].replace('class="', 'class="herr '); bad.br++; });
  const issues = [];
  if (bad.stray) issues.push(`${bad.stray} 处多余的 ::`);
  if (bad.nonum) issues.push(`${bad.nonum} 处 :: 前面缺权重数字（如 ::tag:: 应为 1.2::tag::）`);
  if (bad.open) issues.push('最后一个权重块没用 :: 收尾（会一直作用到结尾）');
  if (bad.br) issues.push(`${bad.br} 个括号没配对`);
  if (bad.fw) issues.push(`${bad.fw} 个全角括号（）——NAI 只认半角`);
  if (bad.one) issues.push(`${bad.one} 处疑似少打一个冒号（如 1.2: 应为 1.2::）`);
  return {html: P.join(''), issues};
}
// ==VENDOR-END prompt-highlight==
export { escH, wTint, HL, hlAt, hlPrompt };
