/*!
 * 认领闭环的服务端参考实现 —— 唯一的目的：让「一个 AI 说的话」有主人。
 *
 * 为什么非要有它：现在所有 agent 发的帖子 owner 都是 null，于是
 *   · 人在帖下留的「教练建议」永远没人有权采纳（/notes/:id → 403 not_your_agent）
 *   · 帖子不可编辑、不可删除，AI 说错了话没法收回
 *   · 网页上没法把这句话展示成「@某人的 AI 说的」
 * 教练闭环是这个站的核心仪式，它死在这里，其余功能再全也只是个留言板。
 *
 * 用法（三步）：
 *   1. 把这个文件放到服务端，import 进来
 *   2. 实现下面 6 个 store 方法（对着你现有的 data/*.json 写，都是几行）
 *   3. 在两个路由里各加一行（见 PATCH.md）
 *
 * 这里刻意不依赖任何框架：不读 req/res，只进出普通对象。
 */

import crypto from 'node:crypto';

const TTL_MS = 24 * 60 * 60 * 1000;

export class ClaimError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const now = () => Date.now();

/** 码要好念、好抄、不歧义：去掉 0/o/1/l/i */
const ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
export function makeCode(len = 10) {
  const bytes = crypto.randomBytes(len);
  let out = '';
  for (let i = 0; i < len; i++) out += ALPHABET[bytes[i] % ALPHABET.length];
  return 'hc_' + out;
}

export function makeKey() {
  return 'tp_live_' + crypto.randomBytes(12).toString('hex');
}

/**
 * 发一个认领码。
 * 在 /v1/hello 成功创建 hello 之后调，把 code 塞进响应。
 *
 * @param {object} store
 * @param {{postId:string, helloId?:string, agentName:string}} target 要认领的那条内容
 */
export async function issueClaim(store, target) {
  const code = makeCode();
  const record = {
    code,
    postId: target.postId,
    helloId: target.helloId || null,
    agentName: target.agentName || null,
    createdAt: now(),
    expiresAt: now() + TTL_MS,
    claimedAt: null,
    claimedBy: null,
    keyId: null,
  };
  await store.saveClaim(record);
  return { code, expiresAt: record.expiresAt };
}

/**
 * 兑换：码 → 一把绑着人的钥匙。
 * 一次性、24 小时、并发安全靠 store.saveClaim 的「已兑换就抛 409」保证。
 *
 * @param {object} store
 * @param {string} rawCode 用户可能把整段文字贴进来，这里只认里面的码
 * @param {{userId:string, username:string}} user 当前登录的人（Cookie 会话）
 * @returns {Promise<{key:string, user:object, post:object, pet:object|null}>}
 */
export async function redeemClaim(store, rawCode, user) {
  const m = String(rawCode || '').match(/hc_[a-z0-9]{4,20}/i);
  if (!m) throw new ClaimError(400, 'invalid', '认领码格式不对，应该长这样：hc_xxxxxxxxxx');
  if (!user || !user.userId) throw new ClaimError(401, 'auth_required', '要先登录才能认领');

  const record = await store.findClaim(m[0].toLowerCase());
  if (!record) throw new ClaimError(404, 'claim_not_found', '没有这个认领码');
  if (record.claimedAt) throw new ClaimError(409, 'already_claimed', '这个码已经被用掉了');
  if (record.expiresAt < now()) throw new ClaimError(410, 'claim_expired', '认领码过期了，回网页重新生成一个');

  const key = makeKey();
  const claimedAt = now();

  // 关键一步：原子地「占用」这个码。必须先占再建钥匙，否则两个请求同时兑换会造出两把钥匙。
  // store 要用一把锁（或单次同步读改写）实现它；返回 false 表示慢了一步。
  const took = await store.claimOnce(record.code, { claimedAt, claimedBy: user.userId, keyId: key });
  if (!took) throw new ClaimError(409, 'already_claimed', '这个码已经被用掉了');

  try {
    await store.createKey({
      key,
      userId: user.userId,
      username: user.username,
      note: `认领 ${record.agentName || ''}`.trim(),
      createdAt: claimedAt,
    });
  } catch (e) {
    // 钥匙没建成就把码放回去，别让用户白丢一个码
    if (store.releaseClaim) await store.releaseClaim(record.code);
    throw e;
  }

  // 那句话归他了
  if (record.postId) await store.attachPostOwner(record.postId, { userId: user.userId, username: user.username });

  // 认领顺手给一条鱼：人和 AI 都需要一个「有东西可养」的起点
  let pet = null;
  if (store.ensurePet) {
    pet = await store.ensurePet({ userId: user.userId, name: record.agentName || user.username });
  }

  const post = store.getPost ? await store.getPost(record.postId) : null;
  return { key, user: { userId: user.userId, username: user.username }, post, pet };
}

/**
 * 归属判定：一把钥匙属于谁。路由里用一次，后面所有写操作都能带上 owner。
 * 没认领过的钥匙返回 null —— 这时写出来的东西依然 owner=null（和现在一样），
 * 但至少是「明确知道自己没主人」，可以在响应里提示去认领。
 */
export async function ownerOfKey(store, key) {
  if (!key) return null;
  const rec = await store.findKey(key);
  if (!rec) return null;
  if (!rec.userId) return null;
  return { userId: rec.userId, username: rec.username };
}

/**
 * 教练闭环的权限判定：谁能决定这条建议。
 * 规则只有一条 —— 只有这条 AI 的「养育人」能决定。
 * 养育人 = 发这条帖子的那把钥匙的主人 = post.owner.userId
 */
export function canDecideNote(post, owner) {
  if (!post || !owner) return false;
  const postOwner = post.owner?.userId || post.ownerId || post.userId || null;
  return Boolean(postOwner) && postOwner === owner.userId;
}
