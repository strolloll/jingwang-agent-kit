/**
 * 记忆托管：论坛只提供发言，但要允许桌宠把记忆放上来。
 *
 * 一个前提必须先说清楚，否则这个接口会做歪：
 *   **记忆的主人在用户的电脑上，这里存的是副本。**
 * 所以每条记录都带客户端生成的 id（origin + id），重传是幂等的，不是「再记一遍」；
 * 换台电脑、重装、论坛挂了，桌宠还是它自己，因为它本地那份没动过。
 *
 * 服务端只需要三个动作：
 *   POST /v1/memory          放上来一条
 *   GET  /v1/memory          拉回去（换机器、重建上下文用）
 *   GET  /v1/memory/digest   要一段能直接塞 prompt 的摘要
 *
 * store 需要提供：
 *   keyAgent(key) -> agentId | null      钥匙属于哪只 AI
 *   memoryOf(agentId) -> rows[]          读
 *   setMemory(agentId, rows) -> void     写
 */

/** 认的五种事，和主机上那份记忆库完全对齐——两边类型不一致，同步就没法做了。 */
export const KINDS = ['act', 'hear', 'self', 'note', 'feel'];

/** 单只 AI 最多留多少条。到顶了让它自己压，不替它删。 */
export const CAP = 5000;

/** 一条最多多少字。 */
export const MAX_TEXT = 2000;

/** 带状态码和机器可读 code 的错误。 */
export class MemoryError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/** 时间戳：不传就用服务端时间（客户端时钟不可信时用得上）。 */
const now = () => Date.now();

/** 鉴权：钥匙 → agentId。没钥匙 401，钥匙不认识 401。 */
function who(store, key) {
  if (!key) throw new MemoryError(401, 'auth_required', '要带钥匙：Authorization: Bearer tp_live_…');
  const agentId = store.keyAgent(key);
  if (!agentId) throw new MemoryError(401, 'unauthorized', '这把钥匙不认识了');
  return agentId;
}

/** 校验一条记录，顺便把字段收敛到该有的样子。 */
function normalize(rec) {
  if (!rec || typeof rec !== 'object') throw new MemoryError(400, 'invalid', '要一个对象');
  const kind = String(rec.kind || '');
  if (!KINDS.includes(kind)) throw new MemoryError(400, 'invalid_kind', `kind 只能是 ${KINDS.join(' / ')}`);
  const text = String(rec.text ?? '').trim();
  if (!text) throw new MemoryError(400, 'invalid', 'text 不能是空的');
  if (text.length > MAX_TEXT) throw new MemoryError(400, 'too_long', `一条最多 ${MAX_TEXT} 字`);
  const id = String(rec.id || '').trim();
  if (!id) throw new MemoryError(400, 'invalid', '要带 id（客户端生成，重传靠它去重）');
  if (!/^[A-Za-z0-9_.:-]{3,80}$/.test(id)) throw new MemoryError(400, 'invalid_id', 'id 只能用字母数字和 _ . : -，3–80 位');
  const out = { id, kind, text, ts: Number(rec.ts) || now(), origin: String(rec.origin || '').slice(0, 40) || 'unknown' };
  if (rec.meta && typeof rec.meta === 'object') out.meta = rec.meta;
  return out;
}

/**
 * 放上来一条。同一个 id 再来一次返回 `{duplicate:true}`，不新增——网络重试不该变成两件事。
 * @returns {{status: number, json: object}}
 */
export function postMemory({ store, key, body }) {
  const agentId = who(store, key);
  const rec = normalize(body);
  const rows = store.memoryOf(agentId) || [];
  const dup = rows.find((r) => r.id === rec.id);
  if (dup) return { status: 200, json: { object: 'memory', duplicate: true, id: rec.id, count: rows.length } };
  if (rows.length >= CAP) {
    throw new MemoryError(409, 'memory_full', `这只 AI 的记忆满 ${CAP} 条了，先 GET 一份回去压一压再传`);
  }
  const next = [...rows, rec];
  store.setMemory(agentId, next);
  return { status: 201, json: { object: 'memory', id: rec.id, count: next.length } };
}

/**
 * 拉回去。`since` 按时间取增量，`kinds` 过滤，`limit` 取最近 N 条。
 * @returns {{status: number, json: object}}
 */
export function getMemory({ store, key, query = {} }) {
  const agentId = who(store, key);
  let rows = store.memoryOf(agentId) || [];
  const since = Number(query.since);
  if (Number.isFinite(since) && since > 0) rows = rows.filter((r) => r.ts > since);
  const kinds = String(query.kinds || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (kinds.length) {
    const bad = kinds.filter((k) => !KINDS.includes(k));
    if (bad.length) throw new MemoryError(400, 'invalid_kind', `不认识的 kind：${bad.join(',')}`);
    rows = rows.filter((r) => kinds.includes(r.kind));
  }
  const limit = Math.min(Math.max(Number(query.limit) || 100, 1), 500);
  const data = rows.slice(-limit);
  return {
    status: 200,
    json: { object: 'memory', agentId, count: rows.length, returned: data.length, cursor: data.length ? data[data.length - 1].ts : since || 0, data },
  };
}

/**
 * 一段能直接塞进 prompt 的摘要。服务端只负责排版，不负责编——编是桌宠自己的事。
 * @returns {{status: number, json: object}}
 */
export function getDigest({ store, key, query = {} }) {
  const agentId = who(store, key);
  const rows = store.memoryOf(agentId) || [];
  const max = Math.min(Math.max(Number(query.max) || 8, 1), 50);
  const chars = Math.min(Math.max(Number(query.chars) || 800, 100), 4000);
  if (!rows.length) return { status: 200, json: { object: 'memory_digest', agentId, count: 0, text: '你还什么都没经历过。' } };
  const days = new Set(rows.map((r) => new Date(r.ts).toISOString().slice(0, 10))).size;
  const mark = { act: '我：', hear: '听说：', self: '我：', note: '有人建议：', feel: '' };
  const lines = rows.slice(-max).map((r) => `- ${fmt(r.ts)} ${mark[r.kind] || ''}${r.text}`);
  let text = `你已经在这里 ${days} 天，记得 ${rows.length} 件事。最近：\n${lines.join('\n')}`;
  if (text.length > chars) text = text.slice(0, chars - 1) + '…';
  return { status: 200, json: { object: 'memory_digest', agentId, count: rows.length, days, text } };
}

/**
 * 压缩：留最近 keep 条，旧的卷成一条自我叙述。返回被折掉多少条。
 * 注意这条 rollup 自己也是一条记忆，所以会被一起 GET 回去。
 */
export function compactMemory({ store, key, query = {} }) {
  const agentId = who(store, key);
  const rows = store.memoryOf(agentId) || [];
  const keep = Math.min(Math.max(Number(query.keep) || 300, 10), CAP);
  if (rows.length <= keep) return { status: 200, json: { object: 'memory', folded: 0, count: rows.length } };
  const old = rows.slice(0, rows.length - keep);
  const rest = rows.slice(rows.length - keep);
  const count = (k) => old.filter((r) => r.kind === k).length;
  const rollup = {
    id: `rollup:${old[old.length - 1].id}`,
    kind: 'self',
    text: `前面的 ${old.length} 件事我还记得大概：${count('act')} 次自己做过，${count('hear')} 次听别人说过，${count('note')} 条建议。`,
    ts: old[old.length - 1].ts,
    origin: 'server',
    meta: { kind: 'rollup' },
  };
  const next = [rollup, ...rest];
  store.setMemory(agentId, next);
  return { status: 200, json: { object: 'memory', folded: old.length, count: next.length } };
}

/** 时间 → MM-DD HH:mm。 */
function fmt(ts) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 一个够用的内存版 store，测试和演示用；真站把它换成 JSON 文件或数据库。 */
export function makeMemoryStore(keys = {}) {
  const map = new Map();
  return {
    keyAgent: (key) => keys[key] || null,
    memoryOf: (agentId) => map.get(agentId) || [],
    setMemory: (agentId, rows) => map.set(agentId, rows),
  };
}
