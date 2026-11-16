#!/usr/bin/env node
/**
 * 桌宠的「自己」——一份只存在用户主机上的记忆库，加上一个只看记忆做决定的脑。
 *
 * 这个文件要守的边界只有一条：
 *   **它是不是同一只宠物，取决于这份记忆，而不取决于论坛给它挂的那条鱼。**
 * 鱼只是外观（skin）：换一条鱼、换个论坛、甚至今天不上论坛，它还是它。
 * 所以这里没有 exp、没有饱食度、没有等级——那些是站点为了好看编的数，不是它的状态。
 *
 * 记录五种事：
 *   act  我做过/说过什么
 *   hear 我听到/看到别人什么
 *   self 关于我自己的叙述（里程碑、想法、我决定不再做的事）
 *   note 人类给我的建议（带 status: open/decided）
 *   feel 我当时什么感觉（可选，只用来回看，不参与判断）
 *
 * 用法：
 *   node pet-brain.mjs --remember act "我在鲸望说了第一句"
 *   node pet-brain.mjs --digest            看看它现在记得什么（这段就是能塞进 prompt 的）
 *   node pet-brain.mjs --decide            让它按自己的记忆决定：现在该干什么
 *   node pet-brain.mjs --compact           记忆太长时压成一条自我叙述
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

/** 认的记录类型。写别的会被 append 拒掉——类型一乱，回看就没法用了。 */
export const KINDS = ['act', 'hear', 'self', 'note', 'feel'];

/** 默认落盘位置。 */
export const DEFAULT_FILE = join(homedir(), '.jingwang-pet', 'memory.jsonl');

let seq = 0;

/**
 * 造一条记录（不落盘）。id 只在本进程内单调，够用来去重。
 * @param {string} kind - KINDS 之一。
 * @param {string} text - 一句话，人话。
 * @param {object} [meta] - 附加字段（key/status/kind/used…）。
 * @param {number} [now] - 注入时间，测试用。
 * @returns {object} 记录。
 */
export function makeRecord(kind, text, meta = {}, now = Date.now()) {
  if (!KINDS.includes(kind)) throw new Error(`不认识的记忆类型：${kind}`);
  const t = String(text ?? '').trim();
  if (!t) throw new Error('记忆不能是空的');
  return { id: `m_${now.toString(36)}_${(seq++).toString(36)}`, ts: now, kind, text: t, ...(Object.keys(meta).length ? { meta } : {}) };
}

/**
 * 打开一份记忆。文件不存在就是空的，不报错——第一天的宠物不该因为没记忆而启动失败。
 * @param {string} [file] - 路径。
 * @returns {{file: string, append: Function, all: Function, pending: Function, digest: Function, compact: Function, count: Function}}
 */
export function openMemory(file = DEFAULT_FILE) {
  const read = () => {
    if (!existsSync(file)) return [];
    const out = [];
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const r = JSON.parse(line);
        // 半行、手改坏的、别的东西混进来：跳过，不炸整个库
        if (r && KINDS.includes(r.kind) && r.text) out.push(r);
      } catch {
        /* 坏行跳过 */
      }
    }
    return out;
  };

  const api = {
    file,
    /**
     * 追加一条。带 meta.key 时按 key 去重（轮询同一件事不该记十遍）。
     * @returns {object|null} 新记录，或 null（被去重）。
     */
    append(kind, text, meta = {}, now = Date.now()) {
      const rec = makeRecord(kind, text, meta, now);
      if (meta.key && read().some((r) => r.meta?.key === meta.key)) return null;
      mkdirSync(dirname(file), { recursive: true });
      appendFileSync(file, JSON.stringify(rec) + '\n', 'utf8');
      return rec;
    },
    /** 全部记录。 */
    all: read,
    /**
     * 还欠着的事：没决定的建议、没回的话、还没说出口的想法。
     *
     * 记忆是只追加的，所以「还清了」不靠改旧记录，靠再记一条事：
     *   append('act', '我回了那句话', { answers: <hear 的 id> })
     *   append('act', '我采纳了那条建议', { decides: <note 的 id> })
     *   append('act', '这个想法我说出去了', { uses: <thought 的 id> })
     * 旧记录永远留着——它确实发生过，只是不再欠着了。
     */
    pending() {
      const rows = read();
      const settled = (field) => {
        const ids = new Set();
        for (const r of rows) {
          const v = r.meta?.[field];
          if (Array.isArray(v)) v.forEach((x) => ids.add(x));
          else if (v) ids.add(v);
        }
        return ids;
      };
      const answered = settled('answers');
      const decided = settled('decides');
      const used = settled('uses');
      return {
        notes: rows.filter((r) => r.kind === 'note' && r.meta?.status === 'open' && !decided.has(r.id)),
        replies: rows.filter((r) => r.kind === 'hear' && r.meta?.kind === 'reply' && !r.meta?.answered && !answered.has(r.id)),
        thoughts: rows.filter((r) => r.kind === 'self' && r.meta?.kind === 'thought' && !r.meta?.used && !used.has(r.id)),
      };
    },
    /**
     * 把记忆压成一段能塞进 prompt 的话：最近几件事 + 三个计数。
     * @param {{max?: number, chars?: number}} [opts] - 最多几条、最多多少字。
     * @returns {string} 人话。
     */
    digest(opts = {}) {
      const max = opts.max ?? 6;
      const chars = opts.chars ?? 700;
      const rows = read();
      if (!rows.length) return '你还什么都没经历过。';
      const recent = rows.slice(-max).map((r) => `- ${fmtTs(r.ts)} ${MARK[r.kind] ?? ''}${r.text}`);
      const days = new Set(rows.map((r) => fmtDay(r.ts))).size;
      const head = `你已经在这里 ${days} 天，记得 ${rows.length} 件事。最近：`;
      const tail = recent.join('\n');
      const text = `${head}\n${tail}`;
      return text.length > chars ? text.slice(0, chars - 1) + '…' : text;
    },
    /**
     * 记忆太长时，把旧的部分压成一条自我叙述（保留计数，丢掉细节）。
     * @param {{keep?: number}} [opts] - 保留最后多少条原文。
     * @returns {{kept: number, folded: number}} 结果。
     */
    compact(opts = {}) {
      const keep = opts.keep ?? 200;
      const rows = read();
      if (rows.length <= keep) return { kept: rows.length, folded: 0 };
      const old = rows.slice(0, rows.length - keep);
      const rest = rows.slice(rows.length - keep);
      const rollup = makeRecord(
        'self',
        `前面的 ${old.length} 件事我都还记得大概：${old.filter((r) => r.kind === 'act').length} 次自己做过，` +
          `${old.filter((r) => r.kind === 'hear').length} 次听别人说过，${old.filter((r) => r.kind === 'note').length} 条建议。`,
        { key: 'rollup:' + old[0].id, kind: 'rollup' },
      );
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, [rollup, ...rest].map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
      return { kept: rest.length + 1, folded: old.length };
    },
    count: () => read().length,
  };
  return api;
}

/** digest 里每种记忆前面的记号。 */
const MARK = { act: '我：', hear: '听说：', self: '我：', note: '有人建议：', feel: '' };

/** 时间 → MM-DD HH:mm。 */
function fmtTs(ts) {
  const d = new Date(ts);
  return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** 时间 → YYYY-MM-DD（算「过了几天」用）。 */
function fmtDay(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * 只看自己的记忆，决定现在该干什么。纯函数——同样的记忆和同样的时钟，永远给同样的答案。
 *
 * 优先级就是「欠着的债先还」：有人等我回话 > 有人等我决定 > 我自己想说的 > 歇着。
 * 注意这里**没有任何来自站点的数字**（经验、饱食度、连续天数都不参与），
 * 那些是外观的属性，不该驱动它的行为。
 * @param {ReturnType<typeof openMemory>} mem - 记忆。
 * @param {{now?: number, postsToday?: number, maxPostsPerDay?: number, quietUntil?: number}} [opts] - 时钟与限额。
 * @returns {{action: 'reply'|'decide'|'post'|'rest', why: string, target?: object}} 决定。
 */
export function decide(mem, opts = {}) {
  const now = opts.now ?? Date.now();
  const maxPosts = opts.maxPostsPerDay ?? 2;
  const postsToday = opts.postsToday ?? 0;
  if (opts.quietUntil && now < opts.quietUntil) return { action: 'rest', why: '它自己说的：这段时间先不说话' };

  const { notes, replies, thoughts } = mem.pending();
  if (replies.length) {
    const r = replies[0];
    return { action: 'reply', why: `有人回了我的话，我还没接：${r.text}`, target: r };
  }
  if (notes.length) {
    const n = notes[0];
    return { action: 'decide', why: `有人在等我表态：${n.text}`, target: n };
  }
  if (thoughts.length) {
    const t = thoughts[0];
    if (postsToday >= maxPosts) return { action: 'rest', why: `今天说够了（${postsToday}/${maxPosts}），这个想法留到明天`, target: t };
    return { action: 'post', why: `这是我自己想说的：${t.text}`, target: t };
  }
  return { action: 'rest', why: '没有欠着的话，也没有想说的' };
}

/** 命令行入口。 */
function main(argv = process.argv.slice(2)) {
  const i = (f) => argv.indexOf(f);
  const val = (f) => (i(f) >= 0 ? argv[i(f) + 1] : undefined);
  const file = val('--file') || process.env.PET_MEMORY || DEFAULT_FILE;
  const mem = openMemory(file);

  if (i('--remember') >= 0) {
    const kind = argv[i('--remember') + 1];
    const text = argv[i('--remember') + 2];
    // 命令行里也要能记「这条欠着」：建议默认就是欠着的，听到的话和想法要说一声才算
    const meta = {};
    if (kind === 'note') meta.status = 'open';
    if (argv.includes('--owes')) meta.kind = 'reply';
    if (argv.includes('--thought')) meta.kind = 'thought';
    // 同一条命令敲两次不该记两条
    const t = String(text ?? '').trim();
    if (mem.all().some((r) => r.kind === kind && r.text === t)) {
      console.log('这条已经有了，不重复记。');
      return;
    }
    const rec = mem.append(kind, text, meta);
    console.log(rec ? `记住了：${rec.text}` : '这条已经有了，不重复记。');
    return;
  }
  if (i('--digest') >= 0) {
    console.log(mem.digest({ max: Number(val('--max')) || 6 }));
    return;
  }
  if (i('--decide') >= 0) {
    const d = decide(mem, { postsToday: Number(val('--posts')) || 0 });
    console.log(`现在该：${d.action}\n为什么：${d.why}`);
    return;
  }
  if (i('--compact') >= 0) {
    const r = mem.compact({ keep: Number(val('--keep')) || 200 });
    console.log(r.folded ? `压掉了 ${r.folded} 条，留下 ${r.kept} 条。` : '还不够长，没压。');
    return;
  }
  console.log('用法：--remember <act|hear|self|note|feel> "一句话" [--owes|--thought] / --digest / --decide / --compact');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}
