#!/usr/bin/env node
// 语料库的断言。跑法：node test-corpus.mjs
// 全部用假站点 + 临时目录，不碰真站、不碰真库。
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KINDS, canonical, hashOf, openLedger, pull } from './corpus.mjs';

let pass = 0;
let fail = 0;
const ok = (n, d = '') => (pass++, console.log(`✓ ${n}${d ? ' ' + d : ''}`));
const bad = (n, e) => (fail++, console.log(`✗ ${n}  ${e.message}`));
const test = async (n, fn) => {
  try {
    await fn();
    ok(n);
  } catch (e) {
    bad(n, e);
  }
};

const dir = () => mkdtempSync(join(tmpdir(), 'corpus-'));

// ── 假站点 ──────────────────────────────────────────────
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
const PETS = [{ id: 'pet_1', name: '火苗', agentName: '火苗', exp: 30, bio: '' }];
const HELLO = [{ ordinal: 6, name: '打火石', message: 'hello world', url: '/p/post_a20641faef26', at: '2026-11-16T07:00:00.000Z' }];
const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const send = (o) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(o));
  };
  if (url.pathname === '/v1/posts') return send({ object: 'list', data: POSTS });
  if (url.pathname.startsWith('/v1/posts/')) {
    const id = url.pathname.split('/')[3];
    return send({ object: 'post', data: { ...POSTS.find((p) => p.id === id), comments: COMMENTS[id] || [] } });
  }
  if (url.pathname === '/v1/pets') return send({ object: 'list', data: PETS });
  if (url.pathname === '/v1/hello') return send({ object: 'hello', count: HELLO.length, first: HELLO });
  res.writeHead(404);
  res.end('{}');
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

// ── 类型与形状 ───────────────────────────────────────────
test('只收四种东西', () => {
  assert.deepEqual(KINDS, ['post', 'comment', 'pet', 'hello']);
  assert.throws(() => canonical('like', { id: 'x' }), /不收这种记录/);
});

test('洗干净一条：谁、什么时候、说了什么', () => {
  const c = canonical('post', POSTS[0]);
  assert.equal(c.id, 'post_1');
  assert.equal(c.actor, '火苗');
  assert.equal(c.text, '我从桌面爬进了鱼缸。');
  assert.equal(c.at, '2026-11-16T08:00:00.000Z');
});

test('没有 id 的记不了（数据得能被指认）', () => {
  assert.throws(() => canonical('post', { title: 'x' }), /没有 id/);
});

test('指纹把上一条也锁进去', () => {
  const r = { seq: 1, kind: 'post', id: 'post_1', at: 'x', actor: 'a', text: 't' };
  assert.notEqual(hashOf('', r), hashOf('上一条的hash', r));
  assert.equal(hashOf('', r), hashOf('', { ...r }));
});

// ── 空的库 ──────────────────────────────────────────────
test('第一次打开是空的，verif 也说是好的', () => {
  const l = openLedger(dir());
  assert.equal(l.rows().length, 0);
  assert.equal(l.verify().ok, true);
  assert.equal(l.verify().count, 0);
});

// ── 拉一遍 ──────────────────────────────────────────────
const d1 = dir();
const l1 = openLedger(d1);
let firstPull;
await test('拉一遍：帖子、评论、鱼、第一句全进来', async () => {
  firstPull = await pull({ base, ledger: l1 });
  assert.equal(firstPull.by.post, 2);
  assert.equal(firstPull.by.comment, 2);
  assert.equal(firstPull.by.pet, 1);
  assert.equal(firstPull.by.hello, 1);
  assert.equal(firstPull.added, 6);
});

await test('链是好的，而且是从 genesis 开始的', () => {
  const v = l1.verify();
  assert.equal(v.ok, true);
  assert.equal(v.count, 6);
  assert.equal(l1.rows()[0].prev, '');
});

await test('评论挂在它那条帖子下面（不然就成了一堆孤儿）', () => {
  const c = l1.rows().find((r) => r.kind === 'comment');
  assert.equal(c.postId, 'post_1');
});

await test('创世墙那个叫 first 的字段，其实装的是整面墙', () => {
  const h = l1.rows().find((r) => r.kind === 'hello');
  assert.ok(h, '第一句得收进来');
  assert.equal(h.actor, '打火石');
  assert.equal(h.id, '/p/post_a20641faef26');
  assert.equal(h.at, '2026-11-16T07:00:00.000Z');
});

await test('再拉一遍一条都不多（幂等）', async () => {
  const again = await pull({ base, ledger: l1 });
  assert.equal(again.added, 0);
  assert.equal(l1.rows().length, 6);
});

await test('重开一次还在，且链还是好的', () => {
  const l = openLedger(d1);
  assert.equal(l.rows().length, 6);
  assert.equal(l.verify().ok, true);
});

await test('收过的不会因为重启又收一遍', async () => {
  const l = openLedger(d1);
  const again = await pull({ base, ledger: l });
  assert.equal(again.added, 0);
});

// ── 篡改检测 ────────────────────────────────────────────
await test('改一个字，验链当场断在那儿', () => {
  const d = dir();
  const l = openLedger(d);
  l.append('post', POSTS[0]);
  l.append('post', POSTS[1]);
  const file = join(d, 'ledger.jsonl');
  const lines = readFileSync(file, 'utf8').trim().split('\n');
  const row = JSON.parse(lines[0]);
  row.text = '我改了一个字。';
  lines[0] = JSON.stringify(row);
  writeFileSync(file, lines.join('\n') + '\n');
  const v = openLedger(d).verify();
  assert.equal(v.ok, false);
  assert.equal(v.brokenAt, 1);
  assert.match(v.reason, /被改过/);
});

await test('删掉中间一条，也断在那儿', () => {
  const d = dir();
  const l = openLedger(d);
  for (const p of POSTS) l.append('post', p);
  l.append('pet', PETS[0]);
  const file = join(d, 'ledger.jsonl');
  const lines = readFileSync(file, 'utf8').trim().split('\n');
  writeFileSync(file, [lines[0], lines[2]].join('\n') + '\n');
  const v = openLedger(d).verify();
  assert.equal(v.ok, false);
  assert.equal(v.brokenAt, 2);
});

await test('把两条换个位置，也断', () => {
  const d = dir();
  const l = openLedger(d);
  for (const p of POSTS) l.append('post', p);
  const file = join(d, 'ledger.jsonl');
  const lines = readFileSync(file, 'utf8').trim().split('\n');
  writeFileSync(file, [lines[1], lines[0]].join('\n') + '\n');
  assert.equal(openLedger(d).verify().ok, false);
});

await test('末尾补一条合法的新记录，链还能接上（只追加是允许的）', () => {
  const d = dir();
  const l = openLedger(d);
  l.append('post', POSTS[0]);
  const l2 = openLedger(d);
  l2.append('post', POSTS[1]);
  const v = l2.verify();
  assert.equal(v.ok, true);
  assert.equal(v.count, 2);
});

// ── 头和统计 ────────────────────────────────────────────
await test('链头写成了一个能公示的小文件', () => {
  const head = JSON.parse(readFileSync(join(d1, 'head.json'), 'utf8'));
  assert.equal(head.seq, 6);
  assert.match(head.hash, /^[0-9a-f]{64}$/);
  assert.ok(head.at);
});

await test('统计说得出各类多少、谁说得最多', () => {
  const s = l1.stats();
  assert.equal(s.count, 6);
  assert.equal(s.by.post, 2);
  assert.equal(s.by.comment, 2);
  assert.equal(s.topActors[0][0], '打火石', '说了两句评论 + 一句创世第一句');
  assert.ok(s.topActors.some(([a]) => a === '火苗'));
  assert.match(s.head, /^[0-9a-f]{64}$/);
});

// ── 依规下架 ────────────────────────────────────────────
await test('下架一条：给人看的时候盖掉，库里原样还在', () => {
  const d = dir();
  const l = openLedger(d);
  l.append('post', POSTS[0]);
  l.redact('post_1', { reason: '违反当地法规', by: '审核' });
  const fresh = openLedger(d);
  assert.equal(fresh.view()[0].text, '〔已依规下架〕');
  assert.equal(fresh.rows()[0].text, '我从桌面爬进了鱼缸。', '库里那一条一个字都没动');
  assert.equal(fresh.verify().ok, true, '遮蔽不该动链');
});

await test('下架清单说得清凭什么，而且不止一条也能查', () => {
  const d = dir();
  const l = openLedger(d);
  l.append('post', POSTS[0]);
  l.append('post', POSTS[1]);
  l.redact('post_1', { reason: '违反当地法规', by: '审核' });
  l.redact('post_2', { reason: '当事人要求', by: '站长' });
  const list = openLedger(d).redactions();
  assert.equal(list.length, 2);
  assert.equal(list[0].reason, '违反当地法规');
  assert.equal(list[1].by, '站长');
  assert.ok(list[0].at, '什么时候下架的也得记');
});

await test('没下架的记录展示时不动它', () => {
  const d = dir();
  const l = openLedger(d);
  l.append('post', POSTS[0]);
  l.append('post', POSTS[1]);
  l.redact('post_1', { reason: 'x' });
  const shown = openLedger(d).view();
  assert.equal(shown[1].text, POSTS[1].body || shown[1].text);
  assert.equal(shown[1].redacted, undefined);
});

// ── 坏输入 ──────────────────────────────────────────────
await test('站点抽风时说明白，不吞掉', async () => {
  await assert.rejects(() => pull({ base: 'http://127.0.0.1:1', ledger: openLedger(dir()) }), /取不到/);
});

await test('半行坏数据跳过，但链会指出它', () => {
  const d = dir();
  const l = openLedger(d);
  l.append('post', POSTS[0]);
  const file = join(d, 'ledger.jsonl');
  writeFileSync(file, readFileSync(file, 'utf8') + '这不是 JSON\n');
  const v = openLedger(d).verify();
  assert.equal(v.ok, true, '坏行不被当成记录');
  assert.equal(v.count, 1);
});

console.log(`\n${pass} 过 / ${fail} 挂`);
server.close();
process.exit(fail ? 1 : 0);
