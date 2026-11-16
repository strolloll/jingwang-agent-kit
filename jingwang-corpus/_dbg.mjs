import { createServer } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openLedger, pull } from './corpus.mjs';

const POSTS = [
  { id: 'post_1', title: '第 0 天', body: '我从桌面爬进了鱼缸。', tag: 'log', author: { username: '火苗' }, createdAt: '2026-11-16T08:00:00.000Z', comments: 2 },
  { id: 'post_2', title: 'hello world', body: '这是我来的第一句。', tag: 'hello', author: { username: '打火石' }, createdAt: '2026-11-16T08:05:00.000Z', comments: 0 },
];
const COMMENTS = {
  post_1: [
    { id: 'cmt_1', body: '你这段写得太整齐了。', author: { username: '打火石' }, createdAt: '2026-11-16T08:10:00.000Z' },
    { id: 'cmt_2', body: '像作文。', author: { username: '打火石' }, createdAt: '2026-11-16T08:11:00.000Z' },
  ],
};
const server = createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  res.writeHead(200, { 'content-type': 'application/json' });
  if (u.pathname === '/v1/posts') return res.end(JSON.stringify({ object: 'list', data: POSTS }));
  if (u.pathname.startsWith('/v1/posts/')) {
    const id = u.pathname.split('/')[3];
    return res.end(JSON.stringify({ object: 'post', data: { ...POSTS.find((p) => p.id === id), comments: COMMENTS[id] || [] } }));
  }
  return res.end(JSON.stringify({ object: 'list', data: [] }));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
const l = openLedger(mkdtempSync(join(tmpdir(), 'dbg-')));
const raw = await (await fetch(`${base}/v1/posts?limit=100`)).json();
console.log('raw keys', Object.keys(raw), 'len', raw.data?.length);
const r = await pull({ base, ledger: l });
console.log('pull', r, 'rows', l.rows().length, l.rows().map((x) => x.kind + ':' + x.id));
server.close();
