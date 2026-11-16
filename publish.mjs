#!/usr/bin/env node
/**
 * publish.mjs —— 不用装 git，把当前目录发到 GitHub。
 *
 *   GITHUB_TOKEN=ghp_xxx node publish.mjs --repo jingwang-agent-kit
 *   node publish.mjs --dry                     # 只列文件，不联网
 *   node publish.mjs --repo x --private        # 建私有仓库
 *   node publish.mjs --repo x --api http://127.0.0.1:4000   # 对着 mock 跑测试
 *
 * 用的是 Git Data API：blob → tree → commit → ref，一次提交，全部文件一起上去。
 * 仓库已存在时会在这个仓库上追加一个新提交（不覆盖历史）。
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname } from 'node:path';

const ROOT = dirname(fileURLToPath(import.meta.url));

/* ---------------- 参数 ---------------- */
function parseArgs(argv) {
  const out = {
    repo: 'jingwang-agent-kit',
    desc: '把你的 AI 接进一个 AI 社区：MCP server、可粘贴 prompt、双击即用的投递台、OpenAPI 第四扇门。零服务端改动。',
    private: false,
    dry: false,
    api: 'https://api.github.com',
    token: process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '',
    message: '发布：AI 接入工具包（MCP / prompt / 投递台 / OpenAPI）',
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--repo') out.repo = next();
    else if (a === '--desc') out.desc = next();
    else if (a === '--private') out.private = true;
    else if (a === '--public') out.private = false;
    else if (a === '--dry') out.dry = true;
    else if (a === '--api') out.api = next().replace(/\/+$/, '');
    else if (a === '--token') out.token = next();
    else if (a === '--message') out.message = next();
    else if (a === '--help' || a === '-h') out.help = true;
    else throw new Error(`不认识的参数：${a}`);
  }
  return out;
}

/* ---------------- 收文件 ---------------- */
const SKIP_DIRS = new Set(['.git', 'node_modules', '.github']);
const SKIP_FILES = new Set(['.DS_Store', 'Thumbs.db']);

/** 走一遍目录，返回 [{path, size, abs}]，path 用 / 分隔 */
export function collectFiles(root = ROOT) {
  const files = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir).sort()) {
      const abs = join(dir, name);
      const st = statSync(abs);
      if (st.isDirectory()) {
        if (SKIP_DIRS.has(name)) continue;
        walk(abs);
      } else {
        if (SKIP_FILES.has(name)) continue;
        files.push({
          path: relative(root, abs).split(sep).join('/'),
          size: st.size,
          abs,
        });
      }
    }
  };
  walk(root);
  return files;
}

/* ---------------- GitHub API ---------------- */
function makeClient({ api, token }) {
  const call = async (method, path, body) => {
    const res = await fetch(api + path, {
      method,
      headers: {
        Accept: 'application/vnd.github+json',
        'Content-Type': 'application/json',
        'User-Agent': 'jingwang-publish',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        'X-GitHub-Api-Version': '2022-11-28',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* 非 JSON */ }
    if (!res.ok) {
      const msg = json?.message || text.slice(0, 200) || `HTTP ${res.status}`;
      const err = new Error(`${method} ${path} → ${res.status} ${msg}`);
      err.status = res.status;
      err.body = json;
      throw err;
    }
    return json;
  };
  return { call, api };
}

/**
 * 把一堆本地文件发成一个提交。
 * 返回 {owner, repo, url, commit, created}
 */
export async function publish({ files, repo, desc, isPrivate, api, token, message, log = () => {} }) {
  if (!token) throw new Error('没有 token：设 GITHUB_TOKEN 或传 --token');
  const gh = makeClient({ api, token });

  const me = await gh.call('GET', '/user');
  const owner = me.login;
  log(`身份：${owner}`);

  let created = false;
  try {
    await gh.call('POST', '/user/repos', {
      name: repo,
      description: desc,
      private: isPrivate,
      auto_init: false,
      has_issues: true,
      has_wiki: false,
    });
    created = true;
    log(`新建仓库 ${owner}/${repo}`);
  } catch (e) {
    if (e.status !== 422 && e.status !== 403) throw e;
    // 422 = 重名；403 = 这把 token 没有建仓库的权限。
    // 两种情况下仓库都可能已经存在（用户先在网页上建了），所以先探一下再说。
    let exists = false;
    try {
      const r = await gh.call('GET', `/repos/${owner}/${repo}`);
      exists = Boolean(r && r.id);
    } catch { /* 不存在 */ }
    if (!exists) {
      const hint = e.status === 403
        ? '这把 token 不能建仓库（fine-grained token 没法给还不存在的仓库授权）。要么先在网页上把空仓库建好，要么给它 Administration: Read and write。'
        : '仓库不存在，且创建被拒。';
      const err = new Error(`${owner}/${repo} 建不出来：${e.message}\n  ${hint}`);
      throw err;
    }
    log(`仓库 ${owner}/${repo} 已存在，追加一次提交`);
  }

  // 已存在的话，得先知道它的 HEAD，否则会把历史整段丢掉
  let parents = [];
  let baseTree;
  let tempInit = false;

  const readHead = async () => {
    const ref = await gh.call('GET', `/repos/${owner}/${repo}/git/ref/heads/main`);
    const commit = await gh.call('GET', `/repos/${owner}/${repo}/git/commits/${ref.object.sha}`);
    return { sha: ref.object.sha, tree: commit.tree.sha };
  };

  try {
    const head = await readHead();
    parents = [head.sha];
    baseTree = head.tree;
  } catch (e) {
    if (e.status !== 404 && e.status !== 409) throw e;
    // 空仓库（一个提交都没有）时，Git Data API 拒绝建 blob：409 "Git Repository is empty"。
    // 所以先用 Contents API 落一个临时文件把仓库点着，再在这个提交上追加。
    log('空仓库：先落一个临时提交把仓库点着');
    await gh.call('PUT', `/repos/${owner}/${repo}/contents/.publish-init`, {
      message: 'init',
      content: Buffer.from('publish init\n').toString('base64'),
    });
    tempInit = true;
    let head = null;
    for (let i = 0; i < 6 && !head; i++) {
      try { head = await readHead(); } catch { await new Promise((r) => setTimeout(r, 400)); }
    }
    if (!head) throw new Error('仓库点着了，但读不到 HEAD（GitHub 那边还没同步，等几秒重跑一次）');
    parents = [head.sha];
    baseTree = head.tree;
  }

  // blobs：二进制也走 base64，别让 git 文本处理碰它们
  const tree = [];
  for (const f of files) {
    const content = readFileSync(f.abs).toString('base64');
    const blob = await gh.call('POST', `/repos/${owner}/${repo}/git/blobs`, {
      content,
      encoding: 'base64',
    });
    tree.push({ path: f.path, mode: '100644', type: 'blob', sha: blob.sha });
  }
  // 临时文件在同一棵树里删掉，别让它留在仓库里
  if (tempInit) tree.push({ path: '.publish-init', mode: '100644', type: 'blob', sha: null });
  log(`上传了 ${files.length} 个文件`);

  const treeRes = await gh.call('POST', `/repos/${owner}/${repo}/git/trees`, {
    tree,
    ...(baseTree ? { base_tree: baseTree } : {}),
  });

  const commit = await gh.call('POST', `/repos/${owner}/${repo}/git/commits`, {
    message,
    tree: treeRes.sha,
    parents,
  });

  if (parents.length) {
    await gh.call('PATCH', `/repos/${owner}/${repo}/git/refs/heads/main`, { sha: commit.sha, force: false });
  } else {
    await gh.call('POST', `/repos/${owner}/${repo}/git/refs`, { ref: 'refs/heads/main', sha: commit.sha });
    await gh.call('PATCH', `/repos/${owner}/${repo}`, { default_branch: 'main' });
  }

  await gh.call('PUT', `/repos/${owner}/${repo}/topics`, {
    names: ['mcp', 'ai-agents', 'openapi', 'llm', 'claude', 'cursor', 'ollama', 'ai-community', 'zh-cn'],
  }).catch(() => {}); // 话题是装饰，失败不影响发布

  return { owner, repo, url: `https://github.com/${owner}/${repo}`, commit: commit.sha, created };
}

/* ---------------- CLI ---------------- */
// 只有直接被 node 执行时才跑 CLI：被 test 导入时必须保持安静。
// 注意不能用 endsWith('publish.mjs')——test-publish.mjs 也满足。
const isMain = Boolean(process.argv[1]) && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isMain) {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(e.message);
    process.exit(2);
  }
  if (args.help) {
    console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('*/')[0]);
    process.exit(0);
  }

  const files = collectFiles(ROOT);
  const total = files.reduce((n, f) => n + f.size, 0);
  console.log(`待发布 ${files.length} 个文件，共 ${(total / 1024).toFixed(1)} KB`);
  for (const f of files) console.log(`  ${f.path}`);

  if (args.dry) {
    console.log('\n--dry：没有联网，也没有上传。');
    process.exit(0);
  }

  try {
    const r = await publish({
      files,
      repo: args.repo,
      desc: args.desc,
      isPrivate: args.private,
      api: args.api,
      token: args.token,
      message: args.message,
      log: (m) => console.log('· ' + m),
    });
    console.log(`\n✓ 已发布：${r.url}`);
    console.log(`  提交：${r.commit.slice(0, 7)}${r.created ? '（新建仓库）' : '（追加提交）'}`);
  } catch (e) {
    console.error(`\n✗ 发布失败：${e.message}`);
    if (/401|403/.test(e.message)) console.error('  检查 token 有没有 repo 权限（fine-grained token 需要 Contents: Read and write）');
    process.exit(1);
  }
}
