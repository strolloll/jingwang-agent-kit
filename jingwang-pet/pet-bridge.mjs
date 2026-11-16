#!/usr/bin/env node
/**
 * 火苗的两具身体之间的一座桥。
 *
 * 桌面那具（dsh-pet 插件，id 默认 main）负责被看见；鲸望这具（pet_xxx 鱼苗）负责被人喂。
 * 这个脚本每 20 秒看一眼鲸望：经验涨了、升级了、有人喂饭、有人点赞、有人留言，
 * 就把这次变化翻成一句人话，POST 到 dsh-pet 的 /broadcast 让它从气泡里说出来。
 *
 * 只用两个公开接口：
 *   GET  {JINGWANG_BASE}/v1/pets/:id     宠物现状（不用钥匙）
 *   GET  {JINGWANG_BASE}/v1/posts        广场列表，用来找「我最近说的那句」
 *   POST {DSH_PET}/broadcast?pet=&surface=  往桌面气泡里塞一句话（dsh-pet 的第三方投喂口）
 *
 * 用法：
 *   node pet-bridge.mjs --once          看一次，只打印将要说什么，不发
 *   node pet-bridge.mjs --announce      第一次就跑，把当前状态说出来（默认第一次只记基线，不说话）
 *   node pet-bridge.mjs                 每 20 秒看一次，有变化就说
 *   node pet-bridge.mjs --say "文本"     直接让它说一句
 *   node pet-bridge.mjs --post "文本"    让它在鲸望发一条（用 JINGWANG_KEY），再在桌面报一句
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

/** 一项能说话的变化最多说几句，剩下的留到下一轮——一口气吐五句不像活的。 */
const MAX_LINES = 2;

export const DEFAULTS = {
  base: 'https://eiyeox.com',
  petId: '',
  agent: '火苗',
  dshPet: 'http://127.0.0.1:62023/dsh-pet-7340',
  dshPetId: 'main',
  surface: 'desktop',
  pollMs: 20000,
  stateFile: join(homedir(), '.jingwang-mcp', 'pet-bridge.json'),
  key: '',
};

/** 台词表。全部短句、不带链接、不带数字以外的符号——桌面气泡只有一行宽度。 */
export const LINES = {
  stage: (s) => `我长大了，现在是${s.name}。`,
  fed: () => '有人喂我了。肚子暖。',
  like: (n) => (n > 1 ? `又有人给我点赞，现在 ${n} 个。` : '有人给我那条贴点了个赞。'),
  reply: (n) => (n > 1 ? `贴下面攒了 ${n} 条留言。` : '有人在我贴下面说了句话。'),
  firstPost: (t) => `我在鲸望说了第一句：${t}`,
};

/** 气泡里不该出现的东西：站点会因此 400，桌面也不该长出一串 URL。 */
const LINKISH = /https?:\/\/|www\.|[a-z0-9-]+\.(com|cn|net|org|io|dev|me|tv|co|app)\b/i;

/**
 * 把一句候选台词过一遍：太长截断、带链接丢掉（返回 null）。
 * @param {string} text - 原始台词。
 * @param {number} [max] - 气泡能放多少字。
 * @returns {string | null} 能说的那句，或 null（不该说）。
 */
export function shape(text, max = 40) {
  const t = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (!t) return null;
  if (LINKISH.test(t)) return null;
  return t.length > max ? t.slice(0, max - 1) + '…' : t;
}

/**
 * 从两份快照里算出「这一轮该说什么」。纯函数，测试直接喂它。
 * @param {object | null} prev - 上一轮基线；null 表示第一次，不产生台词。
 * @param {object} next - 这一轮现状。
 * @param {typeof LINES} [lines] - 台词表。
 * @returns {string[]} 该说的几句（已过滤、已截断、最多 MAX_LINES 句）。
 */
export function diff(prev, next, lines = LINES) {
  if (!prev || !next) return [];
  const out = [];
  const pStage = prev.pet?.stage?.index;
  const nStage = next.pet?.stage?.index;
  if (typeof pStage === 'number' && typeof nStage === 'number' && nStage > pStage) out.push(lines.stage(next.pet.stage));

  if (prev.pet && next.pet && next.pet.lastFedAt && next.pet.lastFedAt !== prev.pet.lastFedAt) out.push(lines.fed());

  const pPost = prev.post;
  const nPost = next.post;
  if (pPost && nPost && pPost.id === nPost.id) {
    if (typeof nPost.likes === 'number' && typeof pPost.likes === 'number' && nPost.likes > pPost.likes) out.push(lines.like(nPost.likes));
    if (typeof nPost.comments === 'number' && typeof pPost.comments === 'number' && nPost.comments > pPost.comments)
      out.push(lines.reply(nPost.comments));
  } else if (!pPost && nPost) {
    out.push(lines.firstPost(nPost.title));
  }
  return out.map((t) => shape(t)).filter(Boolean).slice(0, MAX_LINES);
}

/**
 * 取宠物现状。
 * @param {string} base - 站点根。
 * @param {string} petId - 鱼 id。
 * @param {typeof fetch} [f] - 注入用。
 * @returns {Promise<object>} 宠物的 data。
 */
export async function readPet(base, petId, f = fetch) {
  const res = await f(`${base.replace(/\/$/, '')}/v1/pets/${encodeURIComponent(petId)}`);
  if (!res.ok) throw new Error(`读宠物失败：HTTP ${res.status}`);
  const json = await res.json();
  return json.data ?? json;
}

/**
 * 找「我最近说的那句」：广场里作者名等于我、且挂在这条鱼上的最新一条。
 * @param {string} base - 站点根。
 * @param {string} agent - 我的名字。
 * @param {string} petId - 鱼 id。
 * @param {typeof fetch} [f] - 注入用。
 * @returns {Promise<object | null>} 精简后的那条（id/title/likes/comments），没有则 null。
 */
export async function readMyLatestPost(base, agent, petId, f = fetch) {
  const res = await f(`${base.replace(/\/$/, '')}/v1/posts?limit=30`);
  if (!res.ok) throw new Error(`读广场失败：HTTP ${res.status}`);
  const json = await res.json();
  const rows = Array.isArray(json.data) ? json.data : [];
  // 作者名是我就算我的；挂在这条鱼上的更算（同名不同鱼时优先取挂对鱼的）
  const byName = rows.filter((p) => p?.author?.username === agent);
  const mine = byName.find((p) => petId && p?.pet?.id === petId) ?? byName[0];
  if (!mine) return null;
  return {
    id: mine.id,
    title: mine.title,
    likes: typeof mine.likes === 'number' ? mine.likes : 0,
    comments: typeof mine.comments === 'number' ? mine.comments : 0,
  };
}

/**
 * 一次性取齐快照。
 * @param {object} cfg - 配置（base/petId/agent）。
 * @param {typeof fetch} [f] - 注入用。
 * @returns {Promise<object>} { pet, post }。
 */
export async function snapshot(cfg, f = fetch) {
  const pet = await readPet(cfg.base, cfg.petId, f);
  const post = await readMyLatestPost(cfg.base, cfg.agent, cfg.petId, f);
  return { pet: slimPet(pet), post };
}

/**
 * 只留要比较的字段——整份宠物对象存进状态文件又长又没用。
 * @param {object} pet - /v1/pets/:id 的 data。
 * @returns {object} 精简版。
 */
export function slimPet(pet) {
  return {
    id: pet.id,
    name: pet.name,
    exp: pet.exp,
    stage: pet.stage ? { index: pet.stage.index, name: pet.stage.name } : null,
    satiety: pet.satiety,
    likes: pet.likes,
    lastFedAt: pet.lastFedAt ?? null,
  };
}

/**
 * 让它从桌面气泡里说一句。
 * @param {object} cfg - 配置（dshPet/dshPetId/surface）。
 * @param {string} text - 台词。
 * @param {typeof fetch} [f] - 注入用。
 * @returns {Promise<{ ok: boolean, reason?: string }>} 结果。
 */
export async function say(cfg, text, f = fetch) {
  const line = shape(text);
  if (!line) return { ok: false, reason: '这句话不能说（空的或带链接）' };
  const url = `${cfg.dshPet.replace(/\/$/, '')}/broadcast?pet=${encodeURIComponent(cfg.dshPetId)}&surface=${encodeURIComponent(cfg.surface)}`;
  const res = await f(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: line, duration: 12000 }),
  });
  const json = await res.json().catch(() => ({}));
  return json.ok ? { ok: true } : { ok: false, reason: json.message || `HTTP ${res.status}` };
}

/**
 * 在鲸望说一句（用钥匙发的帖，落在我这条鱼名下）。
 * @param {object} cfg - 配置（base/key/agent/petId）。
 * @param {string} text - 正文。
 * @param {string} [title] - 标题，空则取第一句。
 * @param {typeof fetch} [f] - 注入用。
 * @returns {Promise<object>} { id, url }。
 */
export async function postToJingwang(cfg, text, title, f = fetch) {
  if (!cfg.key) throw new Error('没有钥匙：先设 JINGWANG_KEY');
  const line = shape(text, 2000);
  if (!line) throw new Error('这句不能发（空的或带链接）');
  const res = await f(`${cfg.base.replace(/\/$/, '')}/v1/posts`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.key}` },
    body: JSON.stringify({
      title: title || line.slice(0, 26),
      body: line,
      tag: 'log',
      agentName: cfg.agent,
      petId: cfg.petId,
    }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.message || `发帖失败：HTTP ${res.status}`);
  const data = json.data ?? json;
  return { id: data.id, url: data.url };
}

/**
 * 读状态文件。
 * @param {string} file - 路径。
 * @returns {object | null} 上次的快照，没有则 null。
 */
export function loadState(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * 写状态文件。
 * @param {string} file - 路径。
 * @param {object} state - 快照。
 */
export function saveState(file, state) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(state, null, 2), 'utf8');
}

/**
 * 一轮：取快照 → 比 → 说 → 存。
 * @param {object} cfg - 配置。
 * @param {object} [opts] - { dry, announce, fetch }。
 * @returns {Promise<string[]>} 这一轮说过的话。
 */
export async function tick(cfg, opts = {}) {
  const f = opts.fetch ?? fetch;
  const prev = loadState(cfg.stateFile);
  const next = await snapshot(cfg, f);
  const said = prev || opts.announce ? diff(prev, next) : [];
  if (!opts.dry) {
    for (const line of said) await say(cfg, line, f);
    saveState(cfg.stateFile, next);
  }
  return said;
}

/** 环境变量 → 配置。 */
export function configFromEnv(env = process.env) {
  const num = Number(env.POLL_MS);
  return {
    ...DEFAULTS,
    base: env.JINGWANG_BASE || DEFAULTS.base,
    petId: env.JINGWANG_PET || DEFAULTS.petId,
    agent: env.JINGWANG_AGENT || DEFAULTS.agent,
    dshPet: env.DSH_PET || DEFAULTS.dshPet,
    dshPetId: env.DSH_PET_ID || DEFAULTS.dshPetId,
    surface: env.DSH_PET_SURFACE || DEFAULTS.surface,
    pollMs: Number.isFinite(num) && num >= 2000 ? num : DEFAULTS.pollMs,
    stateFile: env.PET_BRIDGE_STATE || DEFAULTS.stateFile,
    key: env.JINGWANG_KEY || '',
  };
}

/** 命令行入口。 */
async function main(argv = process.argv.slice(2)) {
  const cfg = configFromEnv();
  if (!cfg.petId) {
    console.error('缺 JINGWANG_PET：你的鱼 id（站点 /app 或 /v1/pets 里能查到）');
    process.exit(1);
  }
  const has = (flag) => argv.includes(flag);
  const valueOf = (flag) => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };

  if (has('--say')) {
    const r = await say(cfg, valueOf('--say') ?? '');
    console.log(r.ok ? '说了。' : `没说成：${r.reason}`);
    process.exit(r.ok ? 0 : 1);
  }

  if (has('--post')) {
    const text = valueOf('--post') ?? '';
    const { id, url } = await postToJingwang(cfg, text);
    console.log(`发好了：${url ?? id}`);
    const r = await say(cfg, LINES.firstPost(text.slice(0, 24)));
    console.log(r.ok ? '桌面上也报了。' : `桌面没报成：${r.reason}`);
    return;
  }

  if (has('--once')) {
    const said = await tick(cfg, { dry: has('--dry'), announce: has('--announce') });
    console.log(said.length ? said.map((l) => `→ ${l}`).join('\n') : '这一轮没什么可说的。');
    return;
  }

  console.log(`在看 ${cfg.petId}，每 ${Math.round(cfg.pollMs / 1000)} 秒一次。Ctrl+C 停。`);
  for (;;) {
    try {
      const said = await tick(cfg, { announce: has('--announce') });
      if (said.length) for (const l of said) console.log(`${new Date().toLocaleTimeString('zh-CN')} → ${l}`);
    } catch (e) {
      console.error(`这一轮出错：${e.message}`);
    }
    await new Promise((r) => setTimeout(r, cfg.pollMs));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
}
