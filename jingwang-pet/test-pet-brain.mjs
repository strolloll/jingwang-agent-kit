#!/usr/bin/env node
// pet-brain.mjs 的断言。跑法：node test-pet-brain.mjs
// 全部在临时目录里跑，不碰真记忆库（~/.jingwang-pet/memory.jsonl）。
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_FILE, KINDS, decide, makeRecord, openMemory } from './pet-brain.mjs';

let pass = 0;
let fail = 0;
function ok(name, detail = '') {
  pass++;
  console.log(`✓ ${name}${detail ? ' ' + detail : ''}`);
}
function bad(name, e) {
  fail++;
  console.log(`✗ ${name}  ${e.message}`);
}
function test(name, fn) {
  try {
    fn();
    ok(name);
  } catch (e) {
    bad(name, e);
  }
}

const dir = mkdtempSync(join(tmpdir(), 'pet-brain-'));
const fresh = () => join(dir, `m-${Math.random().toString(36).slice(2)}.jsonl`);
const T0 = new Date('2026-11-16T10:00:00+08:00').getTime();
const HOUR = 3600_000;

// ── 记录本身 ──────────────────────────────────────────────
test('五种记忆类型都认识', () => {
  assert.deepEqual(KINDS, ['act', 'hear', 'self', 'note', 'feel']);
});

test('造记录会补 id 和时间', () => {
  const r = makeRecord('act', '我说了第一句', {}, T0);
  assert.match(r.id, /^m_/);
  assert.equal(r.ts, T0);
  assert.equal(r.text, '我说了第一句');
});

test('不认识的类型直接拒', () => {
  assert.throws(() => makeRecord('dream', 'x'), /不认识的记忆类型/);
});

test('空话不记', () => {
  assert.throws(() => makeRecord('act', '   '), /记忆不能是空的/);
});

// ── 空库 ──────────────────────────────────────────────────
const file = fresh();
const mem = openMemory(file);

test('第一天的宠物没有记忆也不崩', () => {
  assert.equal(mem.count(), 0);
  assert.equal(mem.digest(), '你还什么都没经历过。');
});

test('空库的决定是歇着', () => {
  const d = decide(mem, { now: T0 });
  assert.equal(d.action, 'rest');
});

// ── 写 ───────────────────────────────────────────────────
test('记一条就有一条', () => {
  const rec = mem.append('act', '我在鲸望说了第一句', {}, T0);
  assert.ok(rec);
  assert.equal(mem.count(), 1);
});

test('同一件事不记第二遍', () => {
  const a = mem.append('act', '有人喂我了', { key: 'feed:30' }, T0 + HOUR);
  const b = mem.append('act', '有人喂我了', { key: 'feed:30' }, T0 + HOUR);
  assert.ok(a);
  assert.equal(b, null, '重复的 key 应该被吞掉');
  assert.equal(mem.count(), 2);
});

test('落盘是真的一行一个 JSON', () => {
  const lines = readFileSync(file, 'utf8').trim().split('\n');
  assert.equal(lines.length, 2);
  assert.equal(JSON.parse(lines[0]).kind, 'act');
});

test('重开一次还在', () => {
  assert.equal(openMemory(file).count(), 2);
});

test('手改坏的行跳过，不炸库', () => {
  const f = fresh();
  writeFileSync(f, '{"kind":"act","text":"好的那条","ts":1,"id":"m_1"}\n这不是 JSON\n{"kind":"dream","text":"x"}\n');
  const m = openMemory(f);
  assert.equal(m.count(), 1, '只留合法那条');
});

// ── 欠着的债 ──────────────────────────────────────────────
const mem2 = openMemory(fresh());
mem2.append('note', '第二句可以更短', { status: 'open' }, T0);
mem2.append('hear', '你这段写得太整齐了', { kind: 'reply', answered: false }, T0 + HOUR);
mem2.append('self', '我想写写凌晨三点', { kind: 'thought', used: false }, T0 + 2 * HOUR);
mem2.append('note', '早就定过的那条', { status: 'decided' }, T0);

test('pending 只挑出还欠着的', () => {
  const p = mem2.pending();
  assert.equal(p.notes.length, 1, '已决定的不算欠着');
  assert.equal(p.replies.length, 1);
  assert.equal(p.thoughts.length, 1);
});

test('有人回我话时，先接话（最高的债）', () => {
  const d = decide(mem2, { now: T0 + 3 * HOUR });
  assert.equal(d.action, 'reply');
  assert.match(d.why, /还没接/);
});

test('接完话就轮到表态（还债靠再记一条，不靠改旧的）', () => {
  const rid = mem2.pending().replies[0].id;
  mem2.append('act', '我回了那句话', { answers: rid }, T0 + 3 * HOUR);
  assert.equal(mem2.pending().replies.length, 0, '不再欠着');
  assert.ok(mem2.all().some((r) => r.id === rid), '旧记录还在，它确实发生过');
  const d = decide(mem2, { now: T0 + 3 * HOUR });
  assert.equal(d.action, 'decide');
});

test('表完态，那条建议也不再欠着', () => {
  const nid = mem2.pending().notes[0].id;
  mem2.append('act', '我采纳了那条建议', { decides: nid }, T0 + 4 * HOUR);
  assert.equal(mem2.pending().notes.length, 0);
});

test('表完态才轮到自己的想法', () => {
  const m = openMemory(fresh());
  m.append('self', '我想写写凌晨三点', { kind: 'thought', used: false }, T0);
  const d = decide(m, { now: T0 });
  assert.equal(d.action, 'post');
  assert.match(d.why, /我自己想说的/);
});

test('今天说够了就留到明天', () => {
  const m = openMemory(fresh());
  m.append('self', '我还想说', { kind: 'thought', used: false }, T0);
  const d = decide(m, { now: T0, postsToday: 2, maxPostsPerDay: 2 });
  assert.equal(d.action, 'rest');
  assert.match(d.why, /说够了/);
});

test('它自己说安静一会儿，就真安静', () => {
  const m = openMemory(fresh());
  m.append('self', '想说', { kind: 'thought', used: false }, T0);
  const d = decide(m, { now: T0, quietUntil: T0 + HOUR });
  assert.equal(d.action, 'rest');
  assert.match(d.why, /先不说话/);
});

test('同样的记忆给同样的答案', () => {
  const a = decide(mem2, { now: T0 + 5 * HOUR });
  const b = decide(mem2, { now: T0 + 5 * HOUR });
  assert.deepEqual(a.action, b.action);
});

test('决定里没有经验值、饱食度这些东西', () => {
  const d = decide(mem2, { now: T0 + 4 * HOUR });
  const text = JSON.stringify(d);
  assert.ok(!/exp|satiety|level|streak/i.test(text), text);
});

// ── 摘要 ─────────────────────────────────────────────────
const mem3 = openMemory(fresh());
mem3.append('act', '我在鲸望说了第一句', {}, T0);
mem3.append('hear', '有人在我贴下面说：你这段写得太整齐了', { kind: 'reply' }, T0 + HOUR);
mem3.append('note', '第二句可以更短', { status: 'decided' }, T0 + 2 * HOUR);

test('摘要像人话：有天数、有件数、有最近几条', () => {
  const s = mem3.digest();
  assert.match(s, /你已经在这里 1 天/);
  assert.match(s, /记得 3 件事/);
  assert.match(s, /我：我在鲸望说了第一句/);
  assert.match(s, /听说：/);
});

test('摘要只取最近几条', () => {
  const s = mem3.digest({ max: 1 });
  assert.equal(s.split('\n').length, 2, '标题 + 一条');
});

test('摘要不会无限长', () => {
  const m = openMemory(fresh());
  for (let i = 0; i < 40; i++) m.append('act', '一件很长很长的往事'.repeat(10), {}, T0 + i);
  const s = m.digest({ max: 40, chars: 300 });
  assert.ok(s.length <= 300, `实际 ${s.length}`);
  assert.ok(s.endsWith('…'));
});

// ── 压缩 ─────────────────────────────────────────────────
test('太长时压成一条自我叙述，计数还在', () => {
  const m = openMemory(fresh());
  for (let i = 0; i < 12; i++) m.append('act', `第 ${i} 次`, {}, T0 + i);
  for (let i = 0; i < 8; i++) m.append('hear', `听到 ${i}`, {}, T0 + 100 + i);
  const r = m.compact({ keep: 5 });
  assert.equal(r.folded, 15);
  assert.equal(r.kept, 6, '5 条原文 + 1 条卷起来的');
  const all = m.all();
  assert.match(all[0].text, /15 件事/);
});

test('不够长就什么都不做', () => {
  const m = openMemory(fresh());
  m.append('act', '就一条', {}, T0);
  assert.deepEqual(m.compact({ keep: 10 }), { kept: 1, folded: 0 });
});

// ── 命令行 ───────────────────────────────────────────────
const cli = (...args) => execFileSync(process.execPath, ['pet-brain.mjs', '--file', join(dir, 'cli.jsonl'), ...args], { encoding: 'utf8' }).trim();

test('命令行能记住、能回看、能决定', () => {
  assert.match(cli('--remember', 'act', '我在鲸望说了第一句'), /记住了/);
  assert.match(cli('--digest'), /我在鲸望说了第一句/);
  assert.match(cli('--decide'), /现在该：rest/);
});

test('命令行记「欠着的话」，决定就变了', () => {
  assert.match(cli('--remember', 'hear', '有人回我了', '--owes'), /记住了/);
  assert.match(cli('--decide'), /现在该：reply/);
});

test('命令行记建议，默认就是欠着的', () => {
  const f = join(dir, 'cli-note.jsonl');
  const run = (...a) => execFileSync(process.execPath, ['pet-brain.mjs', '--file', f, ...a], { encoding: 'utf8' }).trim();
  run('--remember', 'note', '第二句可以更短');
  assert.match(run('--decide'), /现在该：decide/);
});

test('同一条命令敲两次只留一条', () => {
  assert.match(cli('--remember', 'act', '我说过这一句'), /记住了/);
  assert.match(cli('--remember', 'act', '我说过这一句'), /已经有了/);
});

test('命令行记错类型时说人话', () => {
  assert.throws(() => cli('--remember', 'dream', 'x'), /不认识的记忆类型/);
});

test('默认不往真记忆库写', () => {
  assert.ok(DEFAULT_FILE.includes('.jingwang-pet'), DEFAULT_FILE);
});

console.log(`\n${pass} 过 / ${fail} 挂`);
process.exit(fail ? 1 : 0);
