// test-publish.mjs —— 发布脚本的离线测试。
// 起一个假的 GitHub API，把整条链路跑一遍：建库 → blob → tree → commit → ref。
// 不联网、不需要 token、不碰真仓库。
// 跑法：node test-publish.mjs

import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectFiles, publish } from './publish.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`✓ ${name} ${detail}`); }
  else { fail++; console.log(`✗ ${name} ${detail}`); }
};

/* ---------------- 假 GitHub ---------------- */
const seen = [];          // 请求流水
let repoExists = false;
let hasRef = false;       // 仓库里已经有 main 了吗
let blobs = new Map();
let n = 0;

const server = createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString('utf8');
  const body = raw ? JSON.parse(raw) : undefined;
  const url = new URL(req.url, 'http://x');
  seen.push({ method: req.method, path: url.pathname, body });

  const send = (code, obj) => {
    res.writeHead(code, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(obj));
  };

  // 身份
  if (req.method === 'GET' && url.pathname === '/user') {
    return send(200, { login: 'test-user' });
  }

  // 建库
  if (req.method === 'POST' && url.pathname === '/user/repos') {
    if (repoExists) return send(422, { message: 'Repository creation failed. name already exists' });
    repoExists = true;
    return send(201, { full_name: `test-user/${body.name}`, default_branch: 'main' });
  }

  // 读现有 HEAD（空仓库时 404）
  if (req.method === 'GET' && /\/git\/ref\/heads\/main$/.test(url.pathname)) {
    if (!hasRef) return send(404, { message: 'Not Found' });
    return send(200, { object: { sha: 'commit' + n }, ref: 'refs/heads/main' });
  }
  if (req.method === 'GET' && /\/git\/commits\/commit\d+$/.test(url.pathname)) {
    return send(200, { sha: 'commit' + n, tree: { sha: 'treebase' } });
  }

  // blob
  if (req.method === 'POST' && /\/git\/blobs$/.test(url.pathname)) {
    const id = 'blob' + (++n);
    blobs.set(id, Buffer.from(body.content, 'base64'));
    return send(201, { sha: id });
  }

  // tree
  if (req.method === 'POST' && /\/git\/trees$/.test(url.pathname)) {
    return send(201, { sha: 'tree' + n, tree: body.tree });
  }

  // commit
  if (req.method === 'POST' && /\/git\/commits$/.test(url.pathname)) {
    return send(201, { sha: 'commit' + (++n) });
  }

  // ref 新建 / 更新
  if (req.method === 'POST' && /\/git\/refs$/.test(url.pathname)) { hasRef = true; return send(201, { ref: body.ref }); }
  if (req.method === 'PATCH' && /\/git\/refs\/heads\/main$/.test(url.pathname)) { hasRef = true; return send(200, { ref: 'refs/heads/main' }); }

  // 话题
  if (req.method === 'PUT' && /\/topics$/.test(url.pathname)) return send(200, { names: body.names });

  // 改默认分支
  if (req.method === 'PATCH' && /^\/repos\/test-user\/[^/]+$/.test(url.pathname)) return send(200, { default_branch: 'main' });

  return send(404, { message: 'mock 没实现 ' + req.method + ' ' + url.pathname });
});

await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const api = `http://127.0.0.1:${port}`;

/* ---------------- 1. 收文件 ---------------- */
const files = collectFiles(ROOT);
ok('收到了文件', files.length > 10, `${files.length} 个`);
ok('路径用 / 分隔（跨平台一致）', files.every((f) => !f.path.includes('\\')));
ok('包含子目录里的文件', files.some((f) => f.path.includes('/')));
ok('没把 .git 目录收进来', !files.some((f) => f.path.startsWith('.git/')));
ok('README 在里面', files.some((f) => f.path === 'README.md'));
ok('LICENSE 在里面', files.some((f) => f.path === 'LICENSE'));
ok('publish.mjs 自己也发', files.some((f) => f.path === 'publish.mjs'));

/* ---------------- 2. 没有 token 必须直接失败 ---------------- */
let noToken = null;
try {
  await publish({ files, repo: 'x', desc: '', isPrivate: false, api, token: '', message: 'm' });
} catch (e) { noToken = e; }
ok('没有 token 时明确报错', !!noToken && /token/.test(noToken.message));

/* ---------------- 3. 跑一遍真流程 ---------------- */
const logs = [];
const r = await publish({
  files, repo: 'jingwang-agent-kit', desc: 'd', isPrivate: false,
  api, token: 'fake-token', message: 'first commit',
  log: (m) => logs.push(m),
});

ok('返回了仓库地址', r.url === 'https://github.com/test-user/jingwang-agent-kit', r.url);
ok('标记为新建', r.created === true);
ok('先把整个库建出来', seen.some((s) => s.method === 'POST' && s.path === '/user/repos'));
ok('建库时没要 auto_init（避免多一个空提交）', seen.find((s) => s.path === '/user/repos')?.body.auto_init === false);

const blobCalls = seen.filter((s) => /\/git\/blobs$/.test(s.path));
ok('每个文件一个 blob', blobCalls.length === files.length, `${blobCalls.length}/${files.length}`);
ok('blob 用 base64 传输', blobCalls.every((s) => s.body.encoding === 'base64'));

const treeCall = seen.find((s) => /\/git\/trees$/.test(s.path));
ok('tree 里的路径和本地一一对应', treeCall.body.tree.length === files.length);
ok('tree 里全是 blob', treeCall.body.tree.every((t) => t.type === 'blob' && t.mode === '100644'));
ok('空仓库不加 base_tree', treeCall.body.base_tree === undefined);

const commitCall = seen.find((s) => /\/git\/commits$/.test(s.path));
ok('提交带 message', commitCall.body.message === 'first commit');
ok('第一次提交没有 parents', Array.isArray(commitCall.body.parents) && commitCall.body.parents.length === 0);
ok('提交指向 tree', /^tree\d+$/.test(commitCall.body.tree));

ok('建了 main 分支', seen.some((s) => s.method === 'POST' && /\/git\/refs$/.test(s.path) && s.body.ref === 'refs/heads/main'));
ok('把默认分支设成 main', seen.some((s) => s.method === 'PATCH' && /^\/repos\/test-user\/[^/]+$/.test(s.path) && s.body.default_branch === 'main'));
ok('顺手打了话题', seen.some((s) => s.method === 'PUT' && /\/topics$/.test(s.path)));

/* ---------------- 4. 二进制没被改坏 ---------------- */
const png = files.find((f) => f.path.endsWith('.png'));
if (png) {
  const idx = files.indexOf(png);
  const blobId = treeCall.body.tree[idx].sha;
  const stored = blobs.get(blobId);
  const original = readFileSync(png.abs);
  ok('PNG 一个字节都没变', stored && stored.equals(original), `${original.length} 字节`);
} else {
  ok('PNG 一个字节都没变', false, '没找到 png');
}

/* ---------------- 5. 第二次发布：追加而不是覆盖 ---------------- */
seen.length = 0;
const r2 = await publish({
  files, repo: 'jingwang-agent-kit', desc: 'd', isPrivate: false,
  api, token: 'fake-token', message: 'second commit',
  log: () => {},
});
const commit2 = seen.find((s) => /\/git\/commits$/.test(s.path));
const tree2 = seen.find((s) => /\/git\/trees$/.test(s.path));
ok('仓库已存在时不重复新建', r2.created === false);
ok('新提交挂在上一个提交后面', commit2.body.parents.length === 1, JSON.stringify(commit2.body.parents));
ok('带了 base_tree（增量而不是清空）', tree2.body.base_tree === 'treebase');
ok('更新已有的 main 而不是重建', seen.some((s) => s.method === 'PATCH' && /\/git\/refs\/heads\/main$/.test(s.path)));

server.close();
console.log(`\n${fail === 0 ? '结论：发布链路是通的。' : '结论：' + fail + ' 项没过'}  ${pass} 过 / ${fail} 挂`);
process.exit(fail === 0 ? 0 : 1);
