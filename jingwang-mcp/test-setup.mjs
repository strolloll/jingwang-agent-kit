#!/usr/bin/env node
/*!
 * setup.mjs 的沙箱测试：用假家目录跑真实写入，验五件事
 *   1. 不存在的客户端被跳过，不创建空文件
 *   2. 已有配置被合并，别人的 server 不能丢
 *   3. 写入前有备份
 *   4. 重复跑是幂等的（第二次不产生新备份）
 *   5. --uninstall 只删自己那条
 *   node test-setup.mjs
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';

const home = mkdtempSync(path.join(os.tmpdir(), 'jw-setup-'));
let pass = 0, fail = 0;
const check = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('ok    ' + name); }
  else { fail++; console.log('FAIL  ' + name + (extra ? '  → ' + extra : '')); }
};

// 造一个「装过 Cursor + Windsurf，没装 Claude」的假机器
mkdirSync(path.join(home, '.cursor'), { recursive: true });
writeFileSync(path.join(home, '.cursor', 'mcp.json'), JSON.stringify({
  mcpServers: { someoneelse: { command: 'node', args: ['x.js'] } },
}, null, 2));
mkdirSync(path.join(home, '.codeium', 'windsurf'), { recursive: true });

const run = (...args) => spawnSync(process.execPath, [path.join(import.meta.dirname, 'setup.mjs'), '--home', home, ...args], { encoding: 'utf8' });

const SKIP = new Set(['cursor', 'windsurf']);
const other = (d) => readdirSync(d).filter((f) => f.startsWith('mcp'));

/* 1 */
let r = run();
check('退出码 0', r.status === 0, r.stderr);
check('跳过了没装的 Claude', /Claude Desktop\s+没装/.test(r.stdout), r.stdout);
check('没给 Claude 建空文件', !existsSync(path.join(home, '.config', 'Claude', 'claude_desktop_config.json')));

const cursorFile = path.join(home, '.cursor', 'mcp.json');
const windFile = path.join(home, '.codeium', 'windsurf', 'mcp_config.json');

/* 2 */
const cursor = JSON.parse(readFileSync(cursorFile, 'utf8'));
check('别人的 server 还在', Boolean(cursor.mcpServers.someoneelse), JSON.stringify(cursor));
check('加进了 jingwang', Boolean(cursor.mcpServers.jingwang));
check('command 是当前 node', cursor.mcpServers.jingwang.command === process.execPath, cursor.mcpServers.jingwang.command);
check('args 指向 server.mjs', /server\.mjs$/.test(cursor.mcpServers.jingwang.args[0]), cursor.mcpServers.jingwang.args[0]);
check('Windsurf 新建了配置', existsSync(windFile));

/* 3 */
check('Cursor 留了备份', other(path.join(home, '.cursor')).length === 2, other(path.join(home, '.cursor')).join(','));
check('Windsurf 新建时不备份', other(path.join(home, '.codeium', 'windsurf')).length === 1, other(path.join(home, '.codeium', 'windsurf')).join(','));

/* 4 */
const before = readFileSync(cursorFile, 'utf8');
r = run();
check('二次运行说没改动', /没改动/.test(r.stdout) || /都已经配过/.test(r.stdout), r.stdout);
check('二次运行没多出备份', other(path.join(home, '.cursor')).length === 2, other(path.join(home, '.cursor')).join(','));
check('文件内容稳定', readFileSync(cursorFile, 'utf8') === before);

/* 5 */
r = run('--uninstall');
const after = JSON.parse(readFileSync(cursorFile, 'utf8'));
check('撤掉后 jingwang 没了', !after.mcpServers.jingwang, JSON.stringify(after));
check('撤掉后别人的还在', Boolean(after.mcpServers.someoneelse));
check('Windsurf 空了就整块删掉', Object.keys(JSON.parse(readFileSync(windFile, 'utf8'))).length === 0);

/* 6 dry run 不写 */
const d = run('--dry');
check('--dry 能跑', d.status === 0, d.stderr);
check('--dry 不写文件', !JSON.parse(readFileSync(cursorFile, 'utf8')).mcpServers.jingwang);

/* 7 坏 JSON 不覆盖 */
writeFileSync(cursorFile, '{ this is not json');
r = run('--only', 'cursor');
check('坏 JSON 时退出码 1', r.status === 1, String(r.status));
check('坏 JSON 原样保留', readFileSync(cursorFile, 'utf8') === '{ this is not json');

rmSync(home, { recursive: true, force: true });
console.log(`\n通过 ${pass} / 失败 ${fail}`);
process.exit(fail ? 1 : 0);
