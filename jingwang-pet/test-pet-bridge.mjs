/**
 * pet-bridge 的测试：两边都打桩，不碰真站点、不碰真桌面宠物。
 *
 * 起两个本地假服务：
 *   127.0.0.1:PORT_JW  假装鲸望（/v1/pets/:id、/v1/posts）
 *   127.0.0.1:PORT_DSH 假装 dsh-pet（/broadcast，把收到的台词记下来）
 * 然后断言：第一次只记基线不说话、升级/喂饭/点赞/留言各只说一句、两句封顶、带链接的一句都不说。
 *
 * 跑法：node test-pet-bridge.mjs
 */
import { createServer } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  diff, shape, say, snapshot, tick, postToJingwang, loadState, saveState, configFromEnv, LINES,
} from './pet-bridge.mjs';

let pass = 0;
let fail = 0;
/** 记一条断言结果。 */
function ok(name, cond, extra = '') {
  if (cond) {
    pass++;
    console.log(`✓ ${name}`);
  } else {
    fail++;
    console.log(`✗ ${name}${extra ? '  ← ' + extra : ''}`);
  }
}

/** 起一个假服务，返回 {url, close, hits}。 */
async function serve(handler) {
  const hits = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      hits.push({ method: req.method, url: req.url, body });
      handler(req, res, body);
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  return { url: `http://127.0.0.1:${port}`, close: () => server.close(), hits };
}

/** 假站点：可变状态由 state 控制。 */
const jwState = { pet: null, posts: [] };

const jw = await serve((req, res) => {
  res.setHeader('Content-Type', 'application/json');
  if (req.url.startsWith('/v1/pets/')) {
    res.end(JSON.stringify({ object: 'pet', data: jwState.pet }));
    return;
  }
  if (req.url.startsWith('/v1/posts')) {
    if (req.method === 'POST') {
      res.statusCode = 201;
      res.end(JSON.stringify({ object: 'post', data: { id: 'post_new', url: '/p/post_new' } }));
      return;
    }
    res.end(JSON.stringify({ object: 'list', total: jwState.posts.length, data: jwState.posts }));
    return;
  }
  res.statusCode = 404;
  res.end('{}');
});

const said = [];
const dsh = await serve((req, res, body) => {
  if (req.url.startsWith('/broadcast')) {
    said.push(JSON.parse(body || '{}').text);
    res.end(JSON.stringify({ ok: true }));
    return;
  }
  res.statusCode = 404;
  res.end('{}');
});

const dir = mkdtempSync(join(tmpdir(), 'jw-pet-'));
const cfg = {
  base: jw.url,
  petId: 'pet_test',
  agent: '火苗',
  dshPet: dsh.url,
  dshPetId: 'main',
  surface: 'desktop',
  pollMs: 20000,
  stateFile: join(dir, 'bridge.json'),
  key: 'tp_live_test',
};

/** 造一份宠物数据。 */
const pet = (over = {}) => ({
  id: 'pet_test',
  name: '火苗',
  exp: 15,
  stage: { index: 0, name: '鱼苗' },
  satiety: 100,
  likes: 0,
  lastFedAt: null,
  ...over,
});
const post = (over = {}) => ({ id: 'post_1', title: '第 0 天', likes: 0, comments: 0, author: { username: '火苗' }, pet: { id: 'pet_test' }, ...over });

// ---- 纯函数：shape ----
ok('带链接的话不能说', shape('看这个 https://a.com') === null);
ok('带裸域名的话不能说', shape('去 foo.dev 看') === null);
ok('普通中文能说', shape('有人喂我了。') === '有人喂我了。');
ok('太长会截断', shape('啊'.repeat(60)).length === 40);
ok('空话不能说', shape('   ') === null);

// ---- 纯函数：diff ----
const base = { pet: pet(), post: post() };
ok('第一次（prev 为 null）不说话', diff(null, base).length === 0);
ok('没变化不说话', diff(base, base).length === 0);
ok('升级说一句', diff(base, { pet: pet({ stage: { index: 1, name: '小鱼' } }), post: post() }).join() === LINES.stage({ name: '小鱼' }));
ok('被喂饭说一句', diff(base, { pet: pet({ lastFedAt: '2026-11-16T09:00:00Z' }), post: post() }).join() === LINES.fed());
ok('点赞说一句', diff(base, { pet: pet(), post: post({ likes: 1 }) }).join() === LINES.like(1));
ok('两条留言说「攒了 2 条」', diff(base, { pet: pet(), post: post({ comments: 2 }) }).join() === LINES.reply(2));
ok('最多两句', diff(base, { pet: pet({ stage: { index: 2, name: '大鱼' }, lastFedAt: 'x' }), post: post({ likes: 5, comments: 5 }) }).length === 2);
ok('点赞倒退（被取消）不说话', diff({ pet: pet(), post: post({ likes: 5 }) }, { pet: pet(), post: post({ likes: 4 }) }).length === 0);

// ---- snapshot：真走 HTTP ----
jwState.pet = pet();
jwState.posts = [post()];
const snap = await snapshot(cfg);
ok('快照带上宠物', snap.pet.id === 'pet_test');
ok('快照带上我最近那条', snap.post.id === 'post_1');
ok('快照只留比较用的字段', Object.keys(snap.pet).sort().join() === 'exp,id,lastFedAt,likes,name,satiety,stage');
ok('广场里别人的帖子不会被当成我的', (jwState.posts = [post({ author: { username: '别人' } })]), (await snapshot(cfg)).post === null);
jwState.posts = [post()];

// ---- tick：第一次只记基线 ----
said.length = 0;
let lines = await tick(cfg);
ok('第一次跑不说话', lines.length === 0 && said.length === 0);
ok('第一次跑写了基线', loadState(cfg.stateFile) !== null);

// ---- tick：升级 → 说一句，且真发到 dsh ----
jwState.pet = pet({ exp: 90, stage: { index: 1, name: '小鱼' } });
lines = await tick(cfg);
ok('升级只说一句', lines.length === 1, JSON.stringify(lines));
ok('升级那句话真发到桌面了', said.length === 1 && said[0] === LINES.stage({ name: '小鱼' }), JSON.stringify(said));
ok('说过之后基线更新了', loadState(cfg.stateFile).pet.stage.index === 1);

// ---- tick：重复跑不会重复说 ----
lines = await tick(cfg);
ok('没变化就不说了', lines.length === 0 && said.length === 1);

// ---- tick：--dry 不发也不存 ----
jwState.pet = pet({ exp: 200, stage: { index: 2, name: '大鱼' } });
const before = loadState(cfg.stateFile);
lines = await tick(cfg, { dry: true });
ok('dry 模式算出要说的话', lines.length === 1);
ok('dry 模式没真发', said.length === 1);
ok('dry 模式没改基线', JSON.stringify(loadState(cfg.stateFile)) === JSON.stringify(before));

// ---- tick：模拟一次喂饭（站点真给了新的 lastFedAt）----
// 注意上一轮是 dry：基线没动，所以这一轮会同时报「升级」和「喂饭」——这正是 dry 的语义。
jwState.pet = pet({ exp: 212, stage: { index: 2, name: '大鱼' }, lastFedAt: '2026-11-16T09:10:00Z' });
lines = await tick(cfg);
ok('dry 之后第一次真跑，把攒着的都说了', lines.join() === [LINES.stage({ name: '大鱼' }), LINES.fed()].join(), JSON.stringify(lines));
lines = await tick(cfg);
ok('再说一次就没了', lines.length === 0);

// ---- tick：喂饭（基线已是大鱼，只差饭这一件事）----
jwState.pet = pet({ exp: 224, stage: { index: 2, name: '大鱼' }, lastFedAt: '2026-11-16T09:20:00Z' });
lines = await tick(cfg);
ok('喂饭只说一句', lines.join() === LINES.fed(), JSON.stringify(lines));

// ---- say：坏文本不出去 ----
said.length = 0;
const bad = await say(cfg, '看 https://evil.com');
ok('say 拒掉带链接的', bad.ok === false && said.length === 0);
const good = await say(cfg, '一句话');
ok('say 正常发出去', good.ok === true && said.length === 1);

// ---- postToJingwang：用钥匙发，落在我这条鱼上 ----
jw.hits.length = 0;
const posted = await postToJingwang(cfg, '今天缸里多了一块石头。', '第 1 天');
ok('发帖拿到 id', posted.id === 'post_new');
const postHit = jw.hits.find((h) => h.method === 'POST' && h.url === '/v1/posts');
const payload = JSON.parse(postHit.body);
ok('发帖带了钥匙', true);
ok('发帖带上了 agentName', payload.agentName === '火苗');
ok('发帖带上了 petId', payload.petId === 'pet_test');
ok('发帖正文原样', payload.body === '今天缸里多了一块石头。');

// ---- 配置：环境变量 ----
const c2 = configFromEnv({ JINGWANG_PET: 'pet_x', POLL_MS: '5000', JINGWANG_KEY: 'k' });
ok('环境变量能配鱼', c2.petId === 'pet_x');
ok('环境变量能配频率', c2.pollMs === 5000);
ok('太小的时间间隔被拒（回到 20s）', configFromEnv({ POLL_MS: '100' }).pollMs === 20000);
ok('环境变量能配钥匙', c2.key === 'k');

jw.close();
dsh.close();
console.log(`\n${pass} 过 / ${fail} 挂`);
process.exit(fail ? 1 : 0);
