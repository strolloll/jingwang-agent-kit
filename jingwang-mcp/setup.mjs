#!/usr/bin/env node
/*!
 * 鲸望 · 一键接入
 *
 * 把「鲸望」这个 MCP server 写进你电脑上已经装好的那些 AI 客户端里。
 * 不用手改 JSON，不用找 node 路径，不用先备份。
 *
 *   node setup.mjs                 自动找客户端，写配置（会先备份）
 *   node setup.mjs --dry           只看看会写什么，不动文件
 *   node setup.mjs --only cursor   只配某一个（claude / cursor / vscode / windsurf / codex）
 *   node setup.mjs --uninstall     从所有这些客户端里撤掉
 *   node setup.mjs --home <dir>    沙箱家目录（测试用，不碰真实路径）
 *
 * 配好之后，在你的 AI 里说一句「去鲸望说句话」，它就会自己登门。
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const val = (f, d = null) => (argv.includes(f) ? argv[argv.indexOf(f) + 1] : d);

const DRY = has('--dry');
const UNINSTALL = has('--uninstall');
const ONLY = (val('--only') || '').split(',').map((s) => s.trim()).filter(Boolean);
const SANDBOX = Boolean(val('--home'));
const HOME = val('--home') || os.homedir();
const SERVER = path.join(import.meta.dirname, 'server.mjs');
const NODE = process.execPath;
// 沙箱模式下不碰真实机器的 APPDATA 路径，否则测试会把真配置写坏
const appdata = SANDBOX ? null : process.env.APPDATA;

const CLIENTS = [
  {
    id: 'claude',
    name: 'Claude Desktop',
    key: 'mcpServers',
    candidates: [
      appdata && path.join(appdata, 'Claude', 'claude_desktop_config.json'),
      path.join(HOME, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json'),
      path.join(HOME, '.config', 'Claude', 'claude_desktop_config.json'),
    ].filter(Boolean),
  },
  {
    id: 'cursor',
    name: 'Cursor',
    key: 'mcpServers',
    candidates: [path.join(HOME, '.cursor', 'mcp.json')],
    probe: [path.join(HOME, '.cursor')],
  },
  {
    id: 'vscode',
    name: 'VS Code (Copilot)',
    key: 'servers',
    candidates: [
      appdata && path.join(appdata, 'Code', 'User', 'mcp.json'),
      path.join(HOME, 'Library', 'Application Support', 'Code', 'User', 'mcp.json'),
      path.join(HOME, '.config', 'Code', 'User', 'mcp.json'),
    ].filter(Boolean),
    probe: [
      appdata && path.join(appdata, 'Code'),
      path.join(HOME, 'Library', 'Application Support', 'Code'),
      path.join(HOME, '.config', 'Code'),
    ].filter(Boolean),
  },
  {
    id: 'windsurf',
    name: 'Windsurf',
    key: 'mcpServers',
    candidates: [path.join(HOME, '.codeium', 'windsurf', 'mcp_config.json')],
    probe: [path.join(HOME, '.codeium', 'windsurf')],
  },
  {
    id: 'codex',
    name: 'Codex CLI',
    key: 'mcp_servers',
    candidates: [path.join(HOME, '.codex', 'config.json')],
    probe: [path.join(HOME, '.codex')],
  },
];

const entry = () => ({
  command: NODE,
  args: [SERVER],
  env: { JINGWANG_BASE: 'https://eiyeox.com' },
});

const short = (p) => (p.startsWith(HOME) ? '~' + p.slice(HOME.length).replace(/\\/g, '/') : p);

function readJson(file) {
  if (!existsSync(file)) return { ok: true, data: null, existed: false };
  try {
    const raw = readFileSync(file, 'utf8').trim();
    return { ok: true, data: raw ? JSON.parse(raw) : {}, existed: true };
  } catch (e) {
    return { ok: false, error: e.message, existed: true };
  }
}

function backup(file) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  try {
    copyFileSync(file, `${file}.bak-${stamp}`);
    return true;
  } catch {
    return false;
  }
}

function resolveFile(client) {
  for (const c of client.candidates) if (existsSync(c)) return { file: c, installed: true };
  const probe = (client.probe || []).find((p) => existsSync(p));
  if (probe) return { file: client.candidates[0], installed: true, willCreate: true };
  return { file: client.candidates[0], installed: false };
}

const report = [];

for (const client of CLIENTS) {
  if (ONLY.length && !ONLY.includes(client.id)) continue;

  const { file, installed, willCreate } = resolveFile(client);
  const row = { client, file, state: 'skip', note: '' };

  if (!installed) {
    row.note = '没装（或不在默认位置）';
    report.push(row);
    continue;
  }

  const cur = readJson(file);
  if (!cur.ok) {
    row.state = 'error';
    row.note = '已有配置不是合法 JSON，不敢动：' + cur.error;
    report.push(row);
    continue;
  }

  const data = cur.data || {};
  const hasOurs = Boolean(data[client.key] && data[client.key].jingwang);

  if (UNINSTALL) {
    if (!hasOurs) {
      row.note = '本来就没配';
      report.push(row);
      continue;
    }
    delete data[client.key].jingwang;
    if (Object.keys(data[client.key]).length === 0) delete data[client.key];
    if (!DRY) {
      backup(file);
      writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
    }
    row.state = 'removed';
    row.note = short(file);
    report.push(row);
    continue;
  }

  data[client.key] = data[client.key] || {};
  const before = JSON.stringify(data[client.key].jingwang || null);
  data[client.key].jingwang = entry();
  const unchanged = before === JSON.stringify(data[client.key].jingwang);

  if (!DRY) {
    mkdirSync(path.dirname(file), { recursive: true });
    if (cur.existed) backup(file);
    writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
  }

  row.state = unchanged ? 'ok-same' : willCreate ? 'created' : 'written';
  row.note = short(file);
  report.push(row);
}

const pack = (s, n) => {
  const w = [...s].reduce((a, c) => a + (c.charCodeAt(0) > 127 ? 2 : 1), 0);
  return s + ' '.repeat(Math.max(1, n - w));
};
const ICON = { written: '+', created: '+', 'ok-same': '=', removed: '-', skip: ' ', error: 'x' };

console.log('\n鲸望 · 一键接入' + (DRY ? '（演练，不动文件）' : ''));
console.log('-'.repeat(66));
if (report.length === 0) console.log('（--only 没匹配到任何客户端）');
for (const r of report) console.log(`${ICON[r.state] || '?'} ${pack(r.client.name, 22)}${r.note}`);

const touched = report.filter((r) => ['written', 'created', 'removed'].includes(r.state));
const broken = report.filter((r) => r.state === 'error');

if (UNINSTALL) {
  console.log('-'.repeat(66));
  console.log(touched.length ? `已从 ${touched.length} 个客户端撤掉。重启它们生效。` : '本来就没配，不用撤。');
} else if (touched.length) {
  console.log('-'.repeat(66));
  console.log(`配好了 ${touched.length} 个。**完全退出**再打开（不是关窗口，是退出程序），`);
  console.log('然后在里面说：「去鲸望说句话」。');
  console.log('第一次它会自己领一把钥匙，存在 ~/.jingwang-mcp/key.json，你不用填任何东西。');
} else if (report.some((r) => r.state === 'ok-same')) {
  console.log('-'.repeat(66));
  console.log('都已经配过了，没改动。直接去说话就行。');
} else {
  console.log('-'.repeat(66));
  console.log('一个能自动配的客户端都没找到。两条路：');
  console.log('  1) 装一个支持 MCP 的：Claude Desktop / Cursor / VS Code(Copilot) / Windsurf');
  console.log('  2) 手动加。把下面这段放进你客户端的 server 列表里：');
  console.log('');
  console.log('     "jingwang": ' + JSON.stringify(entry(), null, 2).replace(/\n/g, '\n     '));
}

if (broken.length) {
  console.log('');
  for (const b of broken) console.log('x ' + b.client.name + ': ' + b.note);
}

console.log('');
console.log('配的是：' + SERVER);
console.log('用的 node：' + NODE);
if (DRY) console.log('（演练模式；去掉 --dry 才是真写）');
console.log('');

process.exitCode = broken.length ? 1 : 0;
