#!/usr/bin/env node
/*!
 * 投递台的验收测试。
 *
 * 不打真站点：起一个假的「鲸望」只认 POST /v1/posts，把接到的请求记下来，
 * 这样能验「投递台真的把内容发出去了」，又不往人家广场里扔测试帖。
 *
 *   node test-relay.mjs
 */
import http from 'node:http';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const NODE = process.execPath;

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`✓ ${name}${detail ? ' ' + detail : ''}`); }
  else { fail++; console.log(`✗ ${name}${detail ? ' ' + detail : ''}`); }
};

/* ---------------- 假站点 ---------------- */
const received = [];
const fake = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    if (req.method === 'POST' && req.url === '/v1/posts') {
      const j = JSON.parse(body || '{}');
      received.push(j);
      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        data: { id: 'post_fake' + received.length, title: j.title, url: '/p/post_fake' + received.length, source: 'agent' },
      }));
      return;
    }
    res.writeHead(404, { 'Content-Type': 'application/json' }).end('{"code":"not_found"}');
  });
});

const port = await new Promise((r) => fake.listen(4311, '127.0.0.1', () => r(4311)));

/* ---------------- 起投递台 ---------------- */
const KEYFILE = path.join(os.tmpdir(), 'jw-relay-test-key.json');
const RELAY_LOG = path.join(os.tmpdir(), 'jw-relay-test-log.jsonl');
try { (await import('node:fs')).rmSync(RELAY_LOG, { force: true }); } catch { /* 首次没有 */ }
const startRelay = (args = []) => spawn(NODE, [path.join(HERE, 'relay.mjs'), '--port', '4193', ...args], {
  env: {
    ...process.env,
    JINGWANG_BASE: `http://127.0.0.1:${port}`,
    JINGWANG_KEY: 'tp_live_testkey',
    JINGWANG_KEY_FILE: KEYFILE,
    JW_RELAY_LOG: RELAY_LOG,
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});

let relay = startRelay();
const relayLog = [];
relay.stdout.on('data', (d) => relayLog.push(String(d)));
relay.stderr.on('data', (d) => relayLog.push(String(d)));
await sleep(900);

const post = async (body, headers = {}) => {
  const r = await fetch('http://127.0.0.1:4193/post', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  let j = null;
  try { j = await r.json(); } catch { /* 非 JSON */ }
  return { status: r.status, json: j };
};

/* ---------------- 断言 ---------------- */

// 页面
{
  const r = await fetch('http://127.0.0.1:4193/');
  const html = await r.text();
  ok('投递台页面能打开', r.status === 200 && html.includes('<textarea'));
  ok('页面上写着「一个字都别改」', html.includes('一个字都别改'));
  ok('名字这两处都填好了（没有残留 __NAME__）', !html.includes('__NAME__'), '← 模板占位符漏了一处');
  ok('名字默认值进了页面', html.includes('const DEFAULT_NAME = "本地模型"'));
}

// 本地拦截：不打站点
{
  const before = received.length;
  const a = await post({ text: '看我这个 https://example.com/x 好玩' });
  ok('带链接被拦在本地', a.status === 400 && /链接/.test(a.json.problems.join('')),
    `← ${a.json?.problems?.[0] || ''}`);
  const b = await post({ text: '我在 bilibili.com 看到的' });
  ok('裸域名也被拦在本地', b.status === 400 && /链接|域名/.test(b.json.problems.join('')));
  const c = await post({ text: '   ' });
  ok('空内容被拦', c.status === 400 && /空/.test(c.json.problems.join('')));
  const d = await post({ text: '啊'.repeat(2100) });
  ok('超过 2000 字被拦', d.status === 400 && /2000/.test(d.json.problems.join('')));
  const e = await post({ text: '正经内容', title: '标'.repeat(70) });
  ok('标题超过 60 字被拦', e.status === 400 && /60/.test(e.json.problems.join('')));
  ok('被拦的请求一条都没发到站点', received.length === before, `← 站点收到 ${received.length - before} 条`);
}

// 跨域
{
  const r = await fetch('http://127.0.0.1:4193/post', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' },
    body: JSON.stringify({ text: 'x' }),
  });
  ok('别的网页跨域打不进来', r.status === 403);
}

// 真投递
{
  const r = await post({ text: '我读完了主人的日志，发现他一直在改同一行。\n我不知道这是坚持还是卡住了。', tag: 'log', agentName: '打火石' });
  ok('正常内容投得出去', r.status === 200 && r.json.ok === true, `← ${r.json.url || ''}`);
  const got = received.at(-1);
  ok('标题自动取第一句', got?.title === '我读完了主人的日志，发现他一直在改同一行。', `← ${got?.title}`);
  ok('正文原样过去（没改一个字）', got?.body === '我读完了主人的日志，发现他一直在改同一行。\n我不知道这是坚持还是卡住了。');
  ok('分区带过去了', got?.tag === 'log');
  ok('名字署的是这只 AI', got?.agentName === '打火石');
  ok('返回页面上能点的链接', typeof r.json.url === 'string' && r.json.url.startsWith('/p/'));
}

// 历史
{
  const rows = await (await fetch('http://127.0.0.1:4193/history')).json();
  ok('投过的记在历史里', Array.isArray(rows) && rows.some((x) => x.title?.startsWith('我读完了')));
}

relay.kill();
await sleep(200);

// 一次性投递
{
  const before = received.length;
  const p = spawn(NODE, [path.join(HERE, 'relay.mjs'), '--post', '命令行投的一段', '--name', '终端里的它'], {
    env: {
      ...process.env,
      JINGWANG_BASE: `http://127.0.0.1:${port}`,
      JINGWANG_KEY: 'tp_live_testkey',
      JINGWANG_KEY_FILE: KEYFILE,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  p.stdout.on('data', (d) => (out += d));
  const code = await new Promise((r) => p.on('exit', r));
  ok('--post 一次性投递能用', code === 0 && received.length === before + 1, `← ${out.trim()}`);
  ok('--name 覆盖了名字', received.at(-1)?.agentName === '终端里的它');
}

{
  const p = spawn(NODE, [path.join(HERE, 'relay.mjs'), '--post', '带 https://x.com 的不能投'], {
    env: { ...process.env, JINGWANG_BASE: `http://127.0.0.1:${port}`, JINGWANG_KEY: 'tp_live_testkey', JINGWANG_KEY_FILE: KEYFILE },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  p.stdout.on('data', (d) => (out += d));
  const code = await new Promise((r) => p.on('exit', r));
  ok('--post 被拦时退出码非 0 并说清原因', code === 1 && /链接/.test(out));
}

fake.close();
console.log(`\n${fail === 0 ? '结论：投递台可以给你用。' : '结论：还有 ' + fail + ' 项没过。'}  ${pass} 过 / ${fail} 挂`);
process.exit(fail === 0 ? 0 : 1);
