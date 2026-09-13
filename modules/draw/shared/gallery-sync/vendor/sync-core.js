// 自动生成，禁止手改。重新生成：node tools/sync-gallery-core.mjs
// 来源：nai-gallery index.html @ ed8458d9a17383228f22d88fc9824cac5829d1b9 第 3910-4102 行
// 原文 sha256：3133c7abf8417be6277f13af867b0b2bfd8420a1cb0211a3c40eb41b35c8ef61
// 适配：只在原文前后加了标记注释和一行 export，原文一个字符都没改。
// 运行环境要求（浏览器和 Node 18+ 都自带）：fetch、crypto.subtle、CompressionStream、Response、Blob、btoa/atob、TextEncoder。
// ==VENDOR-BEGIN sync-core==
/* ==SYNC-CORE== 同步核心：不碰界面，网络请求和本地数据都从外面传进来，所以能单独拿出来测试。
   仓库里两份文件：meta.json（明文：盐 + 一段校验密文，用来在新设备上验证密码）
                  state.bin（密文：收藏 / 合集 / 删除记录 / 提示词分支 / 我的分组）。
   加密：JSON → gzip → AES-GCM；密钥由密码经 PBKDF2-SHA256 31 万次算出，只在浏览器里算，GitHub 上只有密文 */
const SyncCore = (() => {
  const enc = new TextEncoder(), dec = new TextDecoder();
  const b64 = u8 => { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return btoa(s); };
  const unb64 = s => Uint8Array.from(atob(s.replace(/\s/g, '')), c => c.charCodeAt(0));
  const pipe = async (u8, stream) => new Uint8Array(await new Response(new Blob([u8]).stream().pipeThrough(stream)).arrayBuffer());
  const gzip = u8 => pipe(u8, new CompressionStream('gzip'));
  const gunzip = u8 => pipe(u8, new DecompressionStream('gzip'));
  async function deriveKey(pw, salt, iter){
    const base = await crypto.subtle.importKey('raw', enc.encode(pw), 'PBKDF2', false, ['deriveKey']);
    return crypto.subtle.deriveKey({name: 'PBKDF2', hash: 'SHA-256', salt, iterations: iter}, base,
                                   {name: 'AES-GCM', length: 256}, true, ['encrypt', 'decrypt']);
  }
  const exportKey = async k => b64(new Uint8Array(await crypto.subtle.exportKey('raw', k)));
  const importKey = s => crypto.subtle.importKey('raw', unb64(s), {name: 'AES-GCM'}, false, ['encrypt', 'decrypt']);
  async function seal(key, u8){                      // 每次随机 12 字节 IV，放在密文前面
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = new Uint8Array(await crypto.subtle.encrypt({name: 'AES-GCM', iv}, key, u8));
    const out = new Uint8Array(12 + ct.length); out.set(iv); out.set(ct, 12); return out;
  }
  const unseal = async (key, u8) => new Uint8Array(await crypto.subtle.decrypt({name: 'AES-GCM', iv: u8.subarray(0, 12)}, key, u8.subarray(12)));
  const pack = async (key, obj) => b64(await seal(key, await gzip(enc.encode(JSON.stringify(obj)))));
  const unpack = async (key, s) => JSON.parse(dec.decode(await gunzip(await unseal(key, unb64(s)))));

  // 逐条合并：同一条两边都有就取 t 大的；t 一样按内容比大小，保证两台设备合并出同一个结果
  const sortKeys = x => Array.isArray(x) ? x.map(sortKeys)
    : x && typeof x === 'object' ? Object.fromEntries(Object.keys(x).sort().map(k => [k, sortKeys(x[k])])) : x;
  const canon = x => JSON.stringify(sortKeys(x));
  const newer = (a, b) => (a.t || 0) > (b.t || 0) || ((a.t || 0) === (b.t || 0) && canon(a) > canon(b));
  const mergeMap = (a = {}, b = {}) => { const out = {...a}; for (const k in b) if (!out[k] || newer(b[k], out[k])) out[k] = b[k]; return out; };
  const SCHEMA = 2;                                // v2：加了导入的图（imgs）和图片文件登记（blobs）
  const MAPS = ['fav', 'cols', 'dels', 'vars', 'imgs', 'blobs'];
  const blank = () => ({v: SCHEMA, fav: {}, cols: {}, dels: {}, vars: {}, imgs: {}, blobs: {}, grps: {t: 0, list: []}});
  function merge(a, b){
    a = {...blank(), ...a}; b = {...blank(), ...b};
    const out = {...a, ...b, v: SCHEMA};             // 不认识的字段原样保留：以后加字段时，老页面不会把它丢掉
    MAPS.forEach(k => out[k] = mergeMap(a[k], b[k]));
    out.grps = newer(b.grps, a.grps) ? b.grps : a.grps;
    return out;
  }
  // 大规模删除保护（Copie 吃过「一次同步清空所有设备」的亏）：一次同步会让本机一大片东西消失，
  // 多半是哪里出了问题——自动同步就停下，交给用户确认
  function losses(local, merged){
    const alive = (k, r) => !!r && (k === 'cols' ? !r.del : k === 'vars' ? !!(r.list && r.list.length) : r.on !== false);
    const out = [];
    [['fav', '收藏'], ['cols', '合集'], ['imgs', '导入的图'], ['vars', '提示词分支']].forEach(([k, name]) => {
      const mine = Object.keys(local[k]).filter(id => alive(k, local[k][id]));
      const lost = mine.filter(id => !alive(k, merged[k][id])).length;
      if (lost) out.push({name, lost, of: mine.length, bad: lost >= 3 && lost > mine.length / 2});
    });
    const dels = Object.keys(merged.dels).filter(id => merged.dels[id].on && !(local.dels[id] && local.dels[id].on)).length;
    if (dels) out.push({name: '被删的图', lost: dels, of: 0, bad: dels >= 30});
    return out;
  }
  const same = (a, b) => canon(a) === canon(b);

  function client({repo, tok, branch = 'main', fetch: f = (...a) => fetch(...a)}){
    async function gh(path, opt = {}){
      let r;
      try{
        r = await f(`https://api.github.com/repos/${repo}${path ? '/' + path : ''}`, {
          method: opt.method || 'GET', cache: 'no-store',
          headers: {Authorization: 'Bearer ' + tok, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28',
                    ...(opt.body ? {'Content-Type': 'application/json'} : {})},
          body: opt.body ? JSON.stringify(opt.body) : undefined});
      }catch(_){ throw Object.assign(new Error('连不上 GitHub，检查一下网络'), {code: 'net'}); }
      if (r.status === 404 && opt.soft) return null;
      if (!r.ok){
        const msg = {401: '令牌无效或已过期', 403: '令牌没有这个仓库的读写权限，或请求太频繁',
                     404: '找不到这个仓库：名字写错了，或令牌没授权它'}[r.status] || `GitHub 返回 ${r.status}`;
        throw Object.assign(new Error(msg), {status: r.status});
      }
      return r.json();
    }
    const head = async () => (await gh(`git/ref/heads/${branch}`)).object.sha;
    async function read(path, ref){                  // 返回文件的 base64 内容；没有这个文件返回 null
      const j = await gh(`contents/${path}?ref=${ref}`, {soft: true});
      if (!j) return null;
      if (j.content) return j.content;               // 1MB 以内直接带内容
      return (await gh(`git/blobs/${j.sha}`)).content;   // 更大的要按 sha 单独取
    }
    // 一次提交多个文件：传 blob → 拼目录树 → 做提交 → 把分支快进过去。
    // 分支在这期间被别的设备推过，快进会被拒（422），返回 false 让调用方从头再来——这就是乐观锁
    async function commit(parent, files, message, removes = [], onProgress){
      const base = await gh(`git/commits/${parent}`), tree = [];
      for (let i = 0; i < files.length; i++){
        const [path, content] = files[i];
        const b = await gh('git/blobs', {method: 'POST', body: {content, encoding: 'base64'}});
        tree.push({path, mode: '100644', type: 'blob', sha: b.sha});
        if (onProgress) onProgress(i + 1, files.length);
      }
      removes.forEach(path => tree.push({path, mode: '100644', type: 'blob', sha: null}));   // sha: null = 从目录树里删掉
      const t = await gh('git/trees', {method: 'POST', body: {base_tree: base.tree.sha, tree}});
      const c = await gh('git/commits', {method: 'POST', body: {message, tree: t.sha, parents: [parent]}});
      try{ await gh(`git/refs/heads/${branch}`, {method: 'PATCH', body: {sha: c.sha, force: false}}); return true; }
      catch(e){ if (e.status === 422 || e.status === 409) return false; throw e; }
    }
    return {head, read, commit, info: () => gh('')};
  }
  const keys = new Map();                          // 同一把密钥只导入一次
  const keyOf = s => { if (!keys.has(s)) keys.set(s, importKey(s)); return keys.get(s); };
  // 读一个加密的二进制文件（导入的图）；文件不存在返回 null
  async function readBytes({repo, tok, key, path, fetch: f}){
    const b = await client({repo, tok, fetch: f}).read(path, 'main');
    return b ? unseal(await keyOf(key), unb64(b)) : null;
  }
  const repoInfo = ({repo, tok, fetch: f}) => client({repo, tok, fetch: f}).info();

  // 细粒度令牌自带「只读元数据」权限，能反查它可以访问哪些仓库：
  // 只有一个就是它；有好几个（比如老式全权限令牌）就挑名字像数据仓库的；再认不出就交给用户指定
  async function findRepo({tok, fetch: f = (...a) => fetch(...a)}){
    let r;
    try{
      r = await f('https://api.github.com/user/repos?per_page=100&sort=updated', {cache: 'no-store',
        headers: {Authorization: 'Bearer ' + tok, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28'}});
    }catch(_){ throw Object.assign(new Error('连不上 GitHub，检查一下网络'), {code: 'net'}); }
    if (r.status === 401) throw Object.assign(new Error('令牌无效或已过期'), {status: 401});
    if (!r.ok) throw Object.assign(new Error(`GitHub 返回 ${r.status}`), {status: r.status});
    const list = (await r.json()).map(x => x.full_name);
    const repo = list.length === 1 ? list[0] : list.find(n => /\/nai-gallery-data$/i.test(n)) || null;
    return {repo, list};
  }

  const CHECK = 'nai-gallery-sync-ok';
  // 连接：仓库里没有 meta.json = 第一台设备，生成盐写进去；有就用它的盐算密钥，再用校验密文验密码
  async function connect({repo, tok, pw, fetch: f}){
    const c = client({repo, tok, fetch: f});
    for (let attempt = 0; attempt < 3; attempt++){
      const h = await c.head(), m = await c.read('meta.json', h);
      if (m){
        const meta = JSON.parse(dec.decode(unb64(m)));
        const key = await deriveKey(pw, unb64(meta.salt), meta.iter);
        let ok = false;
        try{ ok = dec.decode(await unseal(key, unb64(meta.check))) === CHECK; }catch(_){}
        if (!ok) throw Object.assign(new Error('密码和其他设备上用的不一样'), {code: 'pw'});
        return {key: await exportKey(key), fresh: false};
      }
      const salt = crypto.getRandomValues(new Uint8Array(16)), iter = 310000;
      const key = await deriveKey(pw, salt, iter);
      const meta = {v: 1, kdf: 'PBKDF2-SHA256', iter, salt: b64(salt), check: b64(await seal(key, enc.encode(CHECK)))};
      if (await c.commit(h, [['meta.json', b64(enc.encode(JSON.stringify(meta, null, 2)))]], 'sync: 初始化加密'))
        return {key: await exportKey(key), fresh: true};
      // 被抢先：别的设备同时在初始化，回头重读一次，用它的盐
    }
    throw new Error('初始化没成功，稍后再试');
  }
  // 同步一次：读远端 → 和本地逐条合并 → 有变化才推；推的时候被抢先就从头再来
  // plan(merged, remote, {pack})：页面在推送前决定这次要带上哪些图片文件、移除哪些，返回 {files, removes}
  async function sync({repo, tok, key: keyStr, local, fetch: f, device = '', plan, force = false, onProgress, message}){
    const c = client({repo, tok, fetch: f}), key = await keyOf(keyStr);
    local = {...blank(), ...local};
    for (let attempt = 0; attempt < 4; attempt++){
      const h = await c.head(), s = await c.read('state.bin', h);
      let remote = blank();
      if (s){
        try{ remote = {...blank(), ...await unpack(key, s)}; }
        catch(_){ throw Object.assign(new Error('解不开仓库里的数据：密钥对不上，请断开后用正确的密码重新连接'), {code: 'pw'}); }
        if ((remote.v || 1) > SCHEMA) throw Object.assign(new Error('仓库里的数据来自更新版本的画廊页面：先刷新页面再同步'), {code: 'ver'});
      }
      const merged = merge(local, remote);
      const lost = losses(local, merged);
      if (!force && lost.some(x => x.bad)) throw Object.assign(new Error(
        '这次同步会让本机 ' + lost.map(x => `${x.lost} 个${x.name}`).join('、') + ' 消失，看着不对劲，已暂停自动同步'), {code: 'guard', lost});
      const extra = plan ? await plan(merged, remote, {pack: async u8 => b64(await seal(key, u8))}) : {files: [], removes: []};
      if (same(merged, remote) && !extra.files.length && !extra.removes.length) return {merged, pushed: false};
      const msg = message ? message(merged) : 'sync' + (device ? ' · ' + device : '');
      if (await c.commit(h, [['state.bin', await pack(key, merged)], ...extra.files], msg, extra.removes, onProgress))
        return {merged, pushed: true, files: extra.files.length};
    }
    throw new Error('仓库一直在变，稍后再试');
  }
  // 导出数据仓库包用：仓库当前提交和状态；以及"写进仓库时的原始字节"（和 commit 里 base64 解码后落盘的内容一致）
  async function snapshot({repo, tok, fetch: f}){
    const c = client({repo, tok, fetch: f}), h = await c.head();
    return {head: h, state: await c.read('state.bin', h)};
  }
  async function openState(keyStr, s){
    if (!s) return blank();
    let st;
    try{ st = {...blank(), ...await unpack(await keyOf(keyStr), s)}; }
    catch(_){ throw Object.assign(new Error('解不开仓库里的数据：密钥对不上'), {code: 'pw'}); }
    if ((st.v || 1) > SCHEMA) throw Object.assign(new Error('仓库里的数据来自更新版本的画廊页面：先刷新页面'), {code: 'ver'});
    return st;
  }
  const sealFile = async (keyStr, u8) => seal(await keyOf(keyStr), u8);
  const sealState = async (keyStr, obj) => unb64(await pack(await keyOf(keyStr), obj));
  return {SCHEMA, findRepo, connect, sync, readBytes, repoInfo, merge, blank, same, snapshot, openState, sealFile, sealState,
          _t: {pack, keyOf, client}};
})();
/* ==/SYNC-CORE== */
// ==VENDOR-END sync-core==
export { SyncCore };
