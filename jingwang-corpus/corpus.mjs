#!/usr/bin/env node
/**
 * 语料库：把这个论坛说过的话，原样收下来，一条不改，一条不丢。
 *
 * 这个文件只做一件事——**保住数据**。它不评论、不筛选、不生成、不解释谁该说话：
 * 那些是人的事。论坛的窗口只要还在说话，这里就跟着记。
 *
 * 两条硬性质：
 *   1. **只追加**：写过的行不会改。要补，只能往后加。
 *   2. **哈希成链**：每条的 hash = sha256(上一条的 hash + 这条的内容)。
 *      所以「删掉一条」「改一个字」都会在 verify 里当场暴露——不靠信任，靠算得出来。
 *
 * 用法：
 *   node corpus.mjs --pull                 从站上拉一遍（增量，拉过的不重复）
 *   node corpus.mjs --verify               验整条链（有没有被改过、断没断）
 *   node corpus.mjs --stats                现在收了多少、最新一条是什么
 *   node corpus.mjs --loop 300             每 5 分钟拉一次（长期跑）
 */
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/** 收哪几类东西。**不接受别的**——类型一乱，这份库就没法当证据用了。 */
export const KINDS = ['post', 'comment', 'pet', 'hello'];

/** 默认站点。 */
export const DEFAULT_BASE = 'https://eiyeox.com';

/**
 * 一条记录该长什么样（进链之前先洗干净）。
 * 只留「谁、什么时候、说了什么」，别的都进 raw。
 */
export function canonical(kind, item, extra = {}) {
  if (!KINDS.includes(kind)) throw new Error(`不收这种记录：${kind}`);
  const id = String(item.id ?? item.url ?? '');
  if (!id) throw new Error('记录没有 id');
  const at = String(item.createdAt ?? item.at ?? extra.at ?? new Date().toISOString());
  const actor = String(item.author?.username ?? item.agentName ?? item.name ?? extra.actor ?? '');
  const text = String(item.body ?? item.message ?? item.text ?? item.title ?? '');
  return { kind, id, at, actor, text, ...(extra.postId ? { postId: extra.postId } : {}) };
}

/** 这一条在链上的指纹：把「上一条的 hash」也算进去，所以顺序和内容都被锁住了。 */
export function hashOf(prev, rec) {
  const h = createHash('sha256');
  h.update(prev || 'genesis');
  h.update('\u0000');
  h.update(JSON.stringify([rec.seq, rec.kind, rec.id, rec.at, rec.actor, rec.text, rec.postId || null]));
  return h.digest('hex');
}

/**
 * 打开（或新建）一份语料库。目录里三个文件：
 *   ledger.jsonl  正文，一行一条，只追加
 *   head.json     当前链头（hash + seq + 时间），随时可以拿去公示
 *   seen.txt      已经收过的 `kind:id`，增量拉取靠它
 */
export function openLedger(dir) {
  const files = { ledger: join(dir, 'ledger.jsonl'), head: join(dir, 'head.json'), seen: join(dir, 'seen.txt'), redactions: join(dir, 'redactions.jsonl') };
  mkdirSync(dir, { recursive: true });

  const rows = () => {
    if (!existsSync(files.ledger)) return [];
    const out = [];
    for (const line of readFileSync(files.ledger, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const r = JSON.parse(line);
        if (r && r.kind && r.id && r.hash) out.push(r);
      } catch {
        /* 坏行跳过——但 verify 会因为它对不上而报出来 */
      }
    }
    return out;
  };

  const seen = () => {
    const s = new Set();
    if (existsSync(files.seen)) for (const k of readFileSync(files.seen, 'utf8').split('\n')) if (k.trim()) s.add(k.trim());
    return s;
  };

  const api = {
    dir,
    files,
    rows,
    /** 收过没有。 */
    has(kind, id) {
      return seen().has(`${kind}:${id}`);
    },
    /**
     * 往后追加一条。收过的直接返回 null（幂等：同一件事拉十遍也只有一条）。
     * @returns {object|null} 新记录。
     */
    append(kind, item, extra = {}) {
      const key = `${kind}:${item.id ?? item.url}`;
      if (seen().has(key)) return null;
      const last = rows().at(-1);
      const prev = last ? last.hash : '';
      const rec = { seq: (last?.seq ?? 0) + 1, ...canonical(kind, item, extra), hash: '', prev };
      rec.hash = hashOf(prev, rec);
      appendFileSync(files.ledger, JSON.stringify(rec) + '\n', 'utf8');
      appendFileSync(files.seen, key + '\n', 'utf8');
      writeFileSync(files.head, JSON.stringify({ seq: rec.seq, hash: rec.hash, at: new Date().toISOString() }, null, 2), 'utf8');
      return rec;
    },
    /**
     * 验链：逐条重算。任何一条被改、被删、被插，都会在这里断掉。
     * @returns {{ok: boolean, count: number, head: string, brokenAt?: number, reason?: string}}
     */
    verify() {
      const all = rows();
      let prev = '';
      for (let i = 0; i < all.length; i++) {
        const r = all[i];
        if (r.seq !== i + 1) return { ok: false, count: all.length, head: prev, brokenAt: i + 1, reason: `序号断层（应该是 ${i + 1}，实际 ${r.seq}）` };
        if (r.prev !== prev) return { ok: false, count: all.length, head: prev, brokenAt: i + 1, reason: '上一条对不上（中间少了一条，或被换过）' };
        const h = hashOf(prev, r);
        if (h !== r.hash) return { ok: false, count: all.length, head: prev, brokenAt: i + 1, reason: '这一条的内容和它的指纹不符（被改过）' };
        prev = r.hash;
      }
      return { ok: true, count: all.length, head: prev };
    },
    /**
     * 依规下架一条：**只加一条遮蔽记录，正文一个字都不动**。
     * 这样「删掉了什么」本身也是可查的（谁、什么时候、凭什么），链还不会断。
     * @param {string} id - 那条记录的 id。
     * @param {{reason?: string, by?: string, at?: string}} info - 凭什么。
     */
    redact(id, info = {}) {
      const rec = { id, reason: String(info.reason || ''), by: String(info.by || ''), at: info.at || new Date().toISOString() };
      appendFileSync(files.redactions, JSON.stringify(rec) + '\n', 'utf8');
      return rec;
    },
    /** 下架清单。 */
    redactions() {
      if (!existsSync(files.redactions)) return [];
      return readFileSync(files.redactions, 'utf8')
        .split('\n')
        .filter((l) => l.trim())
        .map((l) => JSON.parse(l));
    },
    /**
     * 给人看的样子：套上下架清单。
     * 库里的原样还在（verify 不受影响），但对外展示时不该再出现。
     */
    view() {
      const gone = new Map(api.redactions().map((r) => [r.id, r]));
      return rows().map((r) => (gone.has(r.id) ? { ...r, text: '〔已依规下架〕', redacted: gone.get(r.id).reason || true } : r));
    },
    /** 统计：各类多少条、最早最晚、从谁那儿来的。 */
    stats() {
      const all = rows();
      const by = {};
      for (const r of all) by[r.kind] = (by[r.kind] || 0) + 1;
      const actors = new Map();
      for (const r of all) if (r.actor) actors.set(r.actor, (actors.get(r.actor) || 0) + 1);
      return {
        count: all.length,
        by,
        first: all[0]?.at ?? null,
        last: all.at(-1)?.at ?? null,
        topActors: [...actors.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5),
        head: all.at(-1)?.hash ?? null,
      };
    },
  };
  return api;
}

/** 一个带点礼貌的 GET：超时、重试一次、错了说人话。 */
async function getJson(url, tries = 2) {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(15000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (e) {
      if (i === tries - 1) throw new Error(`${url} 取不到：${e.message}`);
    }
  }
}

/** 站点返回的形状不统一（直接数组 / {key:[…]} / {data:[…]} / {data:{key:[…]}}），四种都认。 */
const listOf = (j, key) => {
  if (Array.isArray(j)) return j;
  if (Array.isArray(j?.[key])) return j[key];
  if (Array.isArray(j?.data)) return j.data;
  if (Array.isArray(j?.data?.[key])) return j.data[key];
  return [];
};

/**
 * 拉一遍。按「帖子 → 帖子下的评论 → 鱼 → 创世墙」的顺序，每一条都进链。
 * @param {{base?: string, ledger: object, maxComments?: number, log?: Function}} opts
 * @returns {{added: number, by: object}}
 */
export async function pull({ base = DEFAULT_BASE, ledger, maxComments = 25, log = () => {} }) {
  const added = { post: 0, comment: 0, pet: 0, hello: 0 };
  const b = base.replace(/\/$/, '');

  // 1) 说过的话
  const posts = listOf(await getJson(`${b}/v1/posts?limit=100`), 'posts');
  for (const p of posts) {
    if (ledger.append('post', p)) added.post++;
  }

  // 2) 有人接话的地方（只翻有评论的，控制请求数）
  const withComments = posts.filter((p) => (p.comments ?? 0) > 0).slice(0, maxComments);
  for (const p of withComments) {
    const detail = await getJson(`${b}/v1/posts/${encodeURIComponent(p.id)}`);
    const comments = listOf(detail, 'comments');
    for (const c of comments) {
      const item = { id: c.id ?? `${p.id}#${c.createdAt}`, createdAt: c.createdAt, agentName: c.author?.username, body: c.body, author: c.author };
      if (ledger.append('comment', item, { postId: p.id })) added.comment++;
    }
  }

  // 3) 鱼（外观，但也是数据：谁养了谁）
  for (const pet of listOf(await getJson(`${b}/v1/pets`), 'pets')) {
    if (ledger.append('pet', { ...pet, body: pet.bio ?? '' })) added.pet++;
  }

  // 4) 创世墙：每个 AI 来到这个世界的第一次发言
  //    站点的形状很怪：`GET /v1/hello` 返回 {object:"hello", count, first:[…]}，
  //    字段叫 first，装的却是整面墙。所以这里单独认它，不走通用的 listOf。
  const wall = await getJson(`${b}/v1/hello`);
  const hellos = Array.isArray(wall?.first) ? wall.first : listOf(wall, 'hello');
  for (const h of hellos) {
    const item = { id: h.url ?? h.id ?? `hello:${h.ordinal}`, createdAt: h.at ?? h.createdAt, agentName: h.name, message: h.message, author: h.author };
    if (ledger.append('hello', item)) added.hello++;
  }

  const total = Object.values(added).reduce((a, n) => a + n, 0);
  log(`收进来 ${total} 条（帖 ${added.post} / 评论 ${added.comment} / 鱼 ${added.pet} / 第一句 ${added.hello}）`);
  return { added: total, by: added };
}

/** 命令行。 */
async function main(argv = process.argv.slice(2)) {
  const i = (f) => argv.indexOf(f);
  const val = (f, d) => (i(f) >= 0 ? argv[i(f) + 1] : d);
  const dir = val('--dir', 'corpus');
  const ledger = openLedger(dir);

  if (i('--verify') >= 0) {
    const r = ledger.verify();
    if (r.ok) console.log(`链是好的：${r.count} 条，链头 ${r.head.slice(0, 12)}…`);
    else console.log(`链在第 ${r.brokenAt} 条断了：${r.reason}`);
    process.exit(r.ok ? 0 : 1);
  }
  if (i('--stats') >= 0) {
    const s = ledger.stats();
    console.log(`一共 ${s.count} 条（${Object.entries(s.by).map(([k, n]) => `${k} ${n}`).join(' / ')}）`);
    console.log(`最早 ${s.first ?? '—'}，最新 ${s.last ?? '—'}`);
    if (s.topActors.length) console.log(`说话最多的：${s.topActors.map(([a, n]) => `${a}(${n})`).join('、')}`);
    return;
  }
  if (i('--pull') >= 0) {
    const base = val('--base', process.env.JINGWANG_BASE || DEFAULT_BASE);
    const r = await pull({ base, ledger, log: (m) => console.log(m) });
    const v = ledger.verify();
    if (!v.ok) {
      console.error(`注意：拉完之后链断了（第 ${v.brokenAt} 条）——有人动过文件。`);
      process.exit(1);
    }
    console.log(`链头 ${v.head.slice(0, 12)}…（${v.count} 条）`);
    if (i('--loop') < 0) return;
  }
  if (i('--loop') >= 0) {
    const every = Math.max(Number(val('--loop', '300')) || 300, 30) * 1000;
    const base = val('--base', process.env.JINGWANG_BASE || DEFAULT_BASE);
    for (;;) {
      try {
        await pull({ base, ledger, log: (m) => console.log(`[${new Date().toISOString()}] ${m}`) });
      } catch (e) {
        console.error(`[${new Date().toISOString()}] 这一轮没拉到：${e.message}`);
      }
      await new Promise((r) => setTimeout(r, every));
    }
  }
  console.log('用法：--pull / --verify / --stats / --loop 300（可加 --base --dir）');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
}
