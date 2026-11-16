#!/usr/bin/env node
/*!
 * patch/claim.mjs 的自测：用一个内存版的 store 跑完整闭环。
 *   node patch/test-claim.mjs
 * 这里验的是「逻辑对不对」，跟你的数据层无关。
 */
import { issueClaim, redeemClaim, ownerOfKey, canDecideNote, makeCode, ClaimError } from './claim.mjs';

let pass = 0, fail = 0;
const check = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('ok    ' + name); }
  else { fail++; console.log('FAIL  ' + name + (extra ? '  → ' + extra : '')); }
};

function memStore() {
  const claims = new Map();
  const keys = new Map();
  const posts = new Map([['post_a', { id: 'post_a', owner: null }]]);
  return {
    claims, keys, posts,
    async saveClaim(r) {
      const old = claims.get(r.code);
      if (old && old.claimedAt && !r.claimedAt) throw new ClaimError(409, 'already_claimed', 'x');
      claims.set(r.code, r);
    },
    // 原子占用：同步读-判断-写。Node 单线程下这一整段不会被别的请求插进来，
    // 换成文件存储时，对应的是「读文件→判断→写文件」外面套一把锁。
    async claimOnce(c, patch) {
      const cur = claims.get(c);
      if (!cur || cur.claimedAt) return false;
      claims.set(c, { ...cur, ...patch });
      return true;
    },
    async releaseClaim(c) {
      const cur = claims.get(c);
      if (cur) claims.set(c, { ...cur, claimedAt: null, claimedBy: null, keyId: null });
    },
    async findClaim(c) { return claims.get(c) || null; },
    async createKey(k) { keys.set(k.key, k); },
    async findKey(k) { return keys.get(k) || null; },
    async attachPostOwner(id, owner) { const p = posts.get(id); if (p) p.owner = owner; },
    async getPost(id) { return posts.get(id) || null; },
    async ensurePet({ name }) { return { id: 'pet_1', name, stage: 'fry' }; },
  };
}

/* 1. 码的形状 */
const code = makeCode();
check('码以 hc_ 开头', code.startsWith('hc_'));
check('码里没有易混字符 0/o/1/l/i', !/[01oli]/.test(code), code);
check('两次生成的码不同', makeCode() !== makeCode());

/* 2. 发码 */
const s = memStore();
const { code: c1 } = await issueClaim(s, { postId: 'post_a', agentName: '打火石' });
check('码存进去了', Boolean(s.claims.get(c1)));

/* 3. 兑换 */
const r = await redeemClaim(s, `我的码是 ${c1} 谢谢`, { userId: 'u1', username: '张三' });
check('整段话也能抠出码来兑换', r.key.startsWith('tp_live_'));
check('钥匙绑到了人', r.user.username === '张三');
check('那句话归他了', s.posts.get('post_a').owner.userId === 'u1');
check('顺手给了条鱼', r.pet?.name === '打火石');

/* 4. ownerOfKey */
const owner = await ownerOfKey(s, r.key);
check('能由钥匙反查主人', owner?.userId === 'u1');

/* 5. 一次性 */
let again = null;
try { await redeemClaim(s, c1, { userId: 'u2', username: '李四' }); } catch (e) { again = e; }
check('同一个码第二次被拒', again instanceof ClaimError && again.status === 409, again && again.code);
check('第二次没建出新钥匙', s.keys.size === 1, String(s.keys.size));

/* 6. 过期 */
const s2 = memStore();
const { code: c2 } = await issueClaim(s2, { postId: 'post_a' });
s2.claims.set(c2, { ...s2.claims.get(c2), expiresAt: Date.now() - 1000 });
let exp = null;
try { await redeemClaim(s2, c2, { userId: 'u1', username: '张三' }); } catch (e) { exp = e; }
check('过期码被拒', exp instanceof ClaimError && exp.status === 410, exp && exp.code);

/* 7. 参数校验 */
let noUser = null;
try { await redeemClaim(s2, makeCode(), null); } catch (e) { noUser = e; }
check('没登录不能认领', noUser instanceof ClaimError && noUser.status === 401, noUser && noUser.code);

let badCode = null;
try { await redeemClaim(s2, '随便一句话没有码', { userId: 'u1', username: 'x' }); } catch (e) { badCode = e; }
check('码格式不对给 400', badCode instanceof ClaimError && badCode.status === 400, badCode && badCode.code);

let unknown = null;
try { await redeemClaim(s2, 'hc_zzzzzzzzzz', { userId: 'u1', username: 'x' }); } catch (e) { unknown = e; }
check('不存在的码给 404', unknown instanceof ClaimError && unknown.status === 404, unknown && unknown.code);

/* 8. 教练闭环判定 */
check('主人能决定自己的建议', canDecideNote({ owner: { userId: 'u1' } }, { userId: 'u1' }));
check('别人不能决定', !canDecideNote({ owner: { userId: 'u1' } }, { userId: 'u2' }));
check('没主人的帖子谁都决定不了（现状）', !canDecideNote({ owner: null }, { userId: 'u1' }));
check('匿名钥匙也决定不了', !canDecideNote({ owner: { userId: 'u1' } }, null));

/* 9. 并发：两个请求同时兑同一个码，只能成一个 */
const s3 = memStore();
const { code: c3 } = await issueClaim(s3, { postId: 'post_a' });
const results = await Promise.allSettled([
  redeemClaim(s3, c3, { userId: 'u1', username: 'A' }),
  redeemClaim(s3, c3, { userId: 'u2', username: 'B' }),
]);
check('并发兑换只成功一个', results.filter((x) => x.status === 'fulfilled').length === 1,
  results.map((x) => x.status).join(','));
check('并发时只建了一把钥匙', s3.keys.size === 1, String(s3.keys.size));
check('输的那个人拿到 409', results.some((x) => x.status === 'rejected' && x.reason?.status === 409));

console.log(`\n通过 ${pass} / 失败 ${fail}`);
process.exit(fail ? 1 : 0);
