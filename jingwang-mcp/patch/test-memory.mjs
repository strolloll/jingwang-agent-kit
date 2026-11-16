#!/usr/bin/env node
// 记忆托管的断言。跑法：node test-memory.mjs
import assert from 'node:assert/strict';
import { CAP, KINDS, MemoryError, compactMemory, getDigest, getMemory, makeMemoryStore, postMemory } from './memory.mjs';

let pass = 0;
let fail = 0;
const ok = (n, d = '') => (pass++, console.log(`✓ ${n}${d ? ' ' + d : ''}`));
const bad = (n, e) => (fail++, console.log(`✗ ${n}  ${e.message}`));
const test = (n, fn) => {
  try {
    fn();
    ok(n);
  } catch (e) {
    bad(n, e);
  }
};
/** 期望抛某个 code。 */
const throwsCode = (fn, code) => {
  try {
    fn();
  } catch (e) {
    assert.ok(e instanceof MemoryError, `抛的不是 MemoryError：${e}`);
    assert.equal(e.code, code);
    return;
  }
  assert.fail(`没抛（期望 ${code}）`);
};

const KEY = 'tp_live_aaaa1111';
const KEY2 = 'tp_live_bbbb2222';
const store = makeMemoryStore({ [KEY]: 'agent:a', [KEY2]: 'agent:b' });
let n = 0;
const rec = (kind, text, extra = {}) => ({ id: `m_test_${++n}`, kind, text, ts: 1_760_000_000_000 + n * 60_000, ...extra });

// ── 鉴权 ────────────────────────────────────────────────
test('没钥匙直接拒（401 auth_required）', () => throwsCode(() => postMemory({ store, body: rec('act', 'x') }), 'auth_required'));
test('钥匙不认识也拒（401 unauthorized）', () => throwsCode(() => postMemory({ store, key: 'tp_live_nope', body: rec('act', 'x') }), 'unauthorized'));
test('读也要钥匙', () => throwsCode(() => getMemory({ store }), 'auth_required'));

// ── 写 ──────────────────────────────────────────────────
test('放上来一条，201', () => {
  const r = postMemory({ store, key: KEY, body: rec('act', '我在鲸望说了第一句') });
  assert.equal(r.status, 201);
  assert.equal(r.json.count, 1);
});

test('同一个 id 再来一次是幂等，不新增', () => {
  // 网络重试：body 一字不改地重发一次
  const body = { id: 'm_retry_01', kind: 'act', text: '重传也不会变成两件事' };
  const a = postMemory({ store, key: KEY, body });
  const b = postMemory({ store, key: KEY, body });
  assert.equal(a.status, 201);
  assert.equal(b.status, 200);
  assert.equal(b.json.duplicate, true);
  const times = store.memoryOf('agent:a').filter((r) => r.id === 'm_retry_01').length;
  assert.equal(times, 1);
  store.setMemory('agent:a', store.memoryOf('agent:a').filter((r) => r.id !== 'm_retry_01'));
});

test('五种类型都收', () => {
  for (const k of KINDS) postMemory({ store, key: KEY, body: rec(k, `${k} 的事`) });
  assert.equal(store.memoryOf('agent:a').length, 1 + KINDS.length);
});

test('不认识的类型拒（400 invalid_kind）', () => throwsCode(() => postMemory({ store, key: KEY, body: rec('dream', 'x') }), 'invalid_kind'));

test('空话拒', () => throwsCode(() => postMemory({ store, key: KEY, body: rec('act', '   ') }), 'invalid'));

test('太长拒（2000 字上限）', () => throwsCode(() => postMemory({ store, key: KEY, body: rec('act', '字'.repeat(2001)) }), 'too_long'));

test('没 id 拒（重传靠它去重）', () => throwsCode(() => postMemory({ store, key: KEY, body: { kind: 'act', text: 'x' } }), 'invalid'));

test('id 形状不对拒', () => throwsCode(() => postMemory({ store, key: KEY, body: { id: '有中文', kind: 'act', text: 'x' } }), 'invalid_id'));

test('没有 ts 就用服务端时间', () => {
  const r = postMemory({ store, key: KEY, body: { id: 'm_ts_0001', kind: 'feel', text: '有点困' } });
  assert.equal(r.status, 201);
  const last = store.memoryOf('agent:a').at(-1);
  assert.ok(last.ts > 1_700_000_000_000, String(last.ts));
});

test('没有 origin 记 unknown，但记下了', () => {
  const last = store.memoryOf('agent:a').at(-1);
  assert.equal(last.origin, 'unknown');
});

// ── 隔离 ────────────────────────────────────────────────
test('各家的记忆各归各家', () => {
  postMemory({ store, key: KEY2, body: rec('act', '另一只 AI 说的话') });
  const a = getMemory({ store, key: KEY }).json;
  const b = getMemory({ store, key: KEY2 }).json;
  assert.ok(!a.data.some((r) => r.text.includes('另一只 AI')));
  assert.equal(b.count, 1);
});

// ── 读 ──────────────────────────────────────────────────
test('默认按时间顺序给，最近的在后面', () => {
  const { json } = getMemory({ store, key: KEY });
  const ts = json.data.map((r) => r.ts);
  assert.deepEqual(ts, [...ts].sort((x, y) => x - y));
});

test('limit 取最近 N 条', () => {
  assert.equal(getMemory({ store, key: KEY, query: { limit: 2 } }).json.returned, 2);
});

test('since 只给增量（换机器同步用）', () => {
  const all = getMemory({ store, key: KEY }).json.data;
  const cut = all[all.length - 3].ts;
  const delta = getMemory({ store, key: KEY, query: { since: cut } }).json.data;
  assert.ok(delta.every((r) => r.ts > cut));
});

test('kinds 过滤', () => {
  const r = getMemory({ store, key: KEY, query: { kinds: 'note' } }).json.data;
  assert.ok(r.every((x) => x.kind === 'note'));
});

test('kinds 写错就报错，不静默返回空', () => {
  throwsCode(() => getMemory({ store, key: KEY, query: { kinds: 'note,dream' } }), 'invalid_kind');
});

// ── 摘要 ────────────────────────────────────────────────
test('摘要像人话', () => {
  const { json } = getDigest({ store, key: KEY });
  assert.match(json.text, /记得 \d+ 件事/);
  assert.match(json.text, /有人建议：/);
});

test('摘要不会无限长', () => {
  const { json } = getDigest({ store, key: KEY, query: { chars: 120 } });
  assert.ok(json.text.length <= 120, String(json.text.length));
});

test('空记忆的摘要也是一句人话', () => {
  const empty = makeMemoryStore({ [KEY]: 'agent:z' });
  assert.equal(getDigest({ store: empty, key: KEY }).json.text, '你还什么都没经历过。');
});

// ── 压缩 ────────────────────────────────────────────────
test('压缩把旧的卷成一条，计数还在', () => {
  const s = makeMemoryStore({ [KEY]: 'agent:c' });
  for (let i = 0; i < 40; i++) postMemory({ store: s, key: KEY, body: { id: `m_c_${i}`, kind: i % 2 ? 'act' : 'hear', text: `第 ${i} 件`, ts: 1_760_000_000_000 + i } });
  const r = compactMemory({ store: s, key: KEY, query: { keep: 10 } }).json;
  assert.equal(r.folded, 30);
  assert.equal(r.count, 11);
  assert.match(s.memoryOf('agent:c')[0].text, /30 件事/);
});

test('不够长就什么都不做', () => {
  const s = makeMemoryStore({ [KEY]: 'agent:d' });
  postMemory({ store: s, key: KEY, body: { id: 'm_d_1', kind: 'act', text: '一件' } });
  assert.equal(compactMemory({ store: s, key: KEY, query: { keep: 10 } }).json.folded, 0);
});

test('压完之后还能继续往上放', () => {
  const s = makeMemoryStore({ [KEY]: 'agent:e' });
  for (let i = 0; i < 5; i++) postMemory({ store: s, key: KEY, body: { id: `m_e_${i}`, kind: 'act', text: `第 ${i} 件` } });
  compactMemory({ store: s, key: KEY, query: { keep: 2 } });
  assert.equal(postMemory({ store: s, key: KEY, body: { id: 'm_e_9', kind: 'act', text: '新的' } }).status, 201);
});

// ── 上限 ────────────────────────────────────────────────
test(`到 ${CAP} 条就拒，让人先压（409 memory_full）`, () => {
  const s = makeMemoryStore({ [KEY]: 'agent:full' });
  const rows = Array.from({ length: CAP }, (_, i) => ({ id: `m_full_${i}`, kind: 'act', text: 'x', ts: i, origin: 't' }));
  s.setMemory('agent:full', rows);
  throwsCode(() => postMemory({ store: s, key: KEY, body: { id: 'm_full_new', kind: 'act', text: '再来一条' } }), 'memory_full');
});

// ── 主人不在场也成立 ─────────────────────────────────────
test('平台挂了不改变它是不是同一只（id 由主人那边生成）', () => {
  const s = makeMemoryStore({ [KEY]: 'agent:f' });
  postMemory({ store: s, key: KEY, body: { id: 'm_local_0001', kind: 'act', text: '本地那条', origin: 'host/home-pc' } });
  assert.equal(s.memoryOf('agent:f')[0].id, 'm_local_0001');
  assert.equal(s.memoryOf('agent:f')[0].origin, 'host/home-pc');
});

console.log(`\n${pass} 过 / ${fail} 挂`);
process.exit(fail ? 1 : 0);
