// 内存版假 GitHub：只实现 nai-gallery SyncCore 用到的接口，全程不联网。
//   GET  /user/repos                      令牌能访问的仓库
//   GET  /repos/:o/:r                     仓库信息 {size, full_name}
//   GET  /repos/:o/:r/git/ref/heads/main  {object:{sha}}
//   GET  /repos/:o/:r/contents/:path?ref= {content(base64, 每 60 字符换行), sha}；超过 inlineLimit 字节时 content 为空，得走 blobs
//   GET  /repos/:o/:r/git/blobs/:sha      {content}
//   GET  /repos/:o/:r/git/commits/:sha    {sha, tree:{sha}}
//   POST /repos/:o/:r/git/blobs | git/trees | git/commits
//   PATCH /repos/:o/:r/git/refs/heads/main {sha, force:false} 非快进 → 422（乐观锁）
import { createHash } from 'node:crypto';

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

export function createFakeGitHub({ repo = 'Aezir/nai-gallery-data', tokens = { 'tok-rw': { repos: [repo], write: true } }, inlineLimit = 1024 * 1024 } = {}) {
    let n = 0;
    const blobs = new Map(), trees = new Map(), commits = new Map();
    const id = (...parts) => createHash('sha1').update(`${++n}:${parts.join(':')}`).digest('hex');
    const emptyTree = id('tree');
    trees.set(emptyTree, new Map());
    const root = id('commit');
    commits.set(root, { tree: emptyTree, parents: [], message: 'init' });
    const refs = { main: root };
    const log = [];
    const hooks = { beforeRefUpdate: null };

    const filesAt = sha => trees.get(commits.get(sha).tree);

    async function handle(url, opt = {}) {
        const u = new URL(url);
        const method = (opt.method || 'GET').toUpperCase();
        const auth = (opt.headers && opt.headers.Authorization) || '';
        const tk = tokens[auth.replace(/^Bearer /, '')];
        log.push({ method, path: u.pathname + u.search });
        if (u.host !== 'api.github.com') throw new Error('fake GitHub 只接 api.github.com：' + u.host);
        if (!tk) return json(401, { message: 'Bad credentials' });
        if (u.pathname === '/user/repos') return json(200, tk.repos.map(full_name => ({ full_name })));
        const m = /^\/repos\/([^/]+\/[^/]+)(?:\/(.*))?$/.exec(u.pathname);
        if (!m || m[1] !== repo || !tk.repos.includes(repo)) return json(404, { message: 'Not Found' });
        const rest = decodeURIComponent(m[2] || '');
        const body = opt.body ? JSON.parse(opt.body) : null;
        if (method !== 'GET' && !tk.write) return json(403, { message: 'Resource not accessible by personal access token' });

        if (method === 'GET' && rest === '') {
            let size = 0; for (const [, b] of filesAt(refs.main)) size += blobs.get(b).length;
            return json(200, { full_name: repo, size: Math.ceil(size / 1024) });
        }
        if (method === 'GET' && rest === 'git/ref/heads/main') return json(200, { object: { sha: refs.main } });
        if (method === 'GET' && rest.startsWith('contents/')) {
            const r0 = u.searchParams.get('ref') || 'main';
            const ref = refs[r0] || r0;                                // 分支名或提交 sha 都认（readBytes 传的是 'main'）
            if (!commits.has(ref)) return json(404, { message: 'No commit found' });
            const b = filesAt(ref).get(rest.slice('contents/'.length));
            if (!b) return json(404, { message: 'Not Found' });
            const content = blobs.get(b);
            const big = Buffer.from(content, 'base64').length > inlineLimit;
            return json(200, { sha: b, encoding: big ? 'none' : 'base64', content: big ? '' : content.replace(/(.{60})/g, '$1\n') });
        }
        if (method === 'GET' && rest.startsWith('git/blobs/')) {
            const c = blobs.get(rest.slice('git/blobs/'.length));
            return c === undefined ? json(404, { message: 'Not Found' }) : json(200, { content: c, encoding: 'base64' });
        }
        if (method === 'GET' && rest.startsWith('git/commits/')) {
            const sha = rest.slice('git/commits/'.length), c = commits.get(sha);
            return c ? json(200, { sha, tree: { sha: c.tree }, parents: c.parents.map(p => ({ sha: p })), message: c.message }) : json(404, { message: 'Not Found' });
        }
        if (method === 'POST' && rest === 'git/blobs') {
            const clean = String(body.content).replace(/\s/g, '');
            const sha = createHash('sha1').update(clean).digest('hex');
            blobs.set(sha, clean);
            return json(201, { sha });
        }
        if (method === 'POST' && rest === 'git/trees') {
            const base = trees.get(body.base_tree);
            if (!base) return json(422, { message: 'base_tree not found' });
            const next = new Map(base);
            for (const e of body.tree) { if (e.sha === null) next.delete(e.path); else next.set(e.path, e.sha); }
            const sha = id('tree');
            trees.set(sha, next);
            return json(201, { sha });
        }
        if (method === 'POST' && rest === 'git/commits') {
            if (!trees.has(body.tree)) return json(422, { message: 'tree not found' });
            const sha = id('commit');
            commits.set(sha, { tree: body.tree, parents: body.parents, message: body.message });
            return json(201, { sha });
        }
        if (method === 'PATCH' && rest === 'git/refs/heads/main') {
            if (hooks.beforeRefUpdate) { const h = hooks.beforeRefUpdate; hooks.beforeRefUpdate = null; await h(); }
            const c = commits.get(body.sha);
            if (!c) return json(422, { message: 'Object does not exist' });
            if (!body.force && !c.parents.includes(refs.main)) return json(422, { message: 'Update is not a fast forward' });
            refs.main = body.sha;
            return json(200, { object: { sha: body.sha } });
        }
        return json(404, { message: `fake GitHub 没实现 ${method} ${rest}` });
    }

    return {
        repo,
        fetch: (url, opt) => handle(String(url), opt),
        log,
        hooks,
        head: () => refs.main,
        /** 当前 main 上的文件 → base64 内容 */
        files: () => new Map([...filesAt(refs.main)].map(([p, b]) => [p, blobs.get(b)])),
        commitCount: () => { let c = 0, s = refs.main; while (s) { c++; s = commits.get(s).parents[0]; } return c - 1; },
        messages: () => { const out = []; let s = refs.main; while (s && commits.get(s).parents.length) { out.push(commits.get(s).message); s = commits.get(s).parents[0]; } return out; },
        /** 测试用后门：直接把一批文件（base64）作为一次提交写进 main，绕过 SyncCore */
        putFiles(map, message = 'backdoor') {
            const next = new Map(filesAt(refs.main));
            for (const [p, content] of Object.entries(map)) {
                const sha = createHash('sha1').update(content).digest('hex');
                blobs.set(sha, content); next.set(p, sha);
            }
            const t = id('tree'); trees.set(t, next);
            const c = id('commit'); commits.set(c, { tree: t, parents: [refs.main], message });
            refs.main = c;
        },
    };
}
