// test-relay-html.mjs —— 给「投递台」单文件版做的断言。
// 不碰真站：把 relay.html 里的内联脚本抠出来，在 node:vm 里用最小 DOM 打桩跑一遍纯逻辑。
// 跑法：node test-relay-html.mjs

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const HERE = dirname(fileURLToPath(import.meta.url));
const FILE = join(HERE, 'relay.html');

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`✓ ${name} ${detail}`); }
  else { fail++; console.log(`✗ ${name} ${detail}`); }
};

const html = readFileSync(FILE, 'utf8');

/* ---------- 1. 单文件自足性 ---------- */
ok('没有外链脚本', !/<script[^>]+src=/i.test(html));
ok('没有外链样式', !/<link[^>]+rel=["']?stylesheet/i.test(html));
ok('没有 import 外部模块', !/\bimport\s+.*from\s+['"]https?:/i.test(html));
ok('说明了为什么双击就能用', /Access-Control-Allow-Origin|双击/.test(html));

/* ---------- 2. 把内联脚本跑起来 ---------- */
const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/gi)].map((m) => m[1]);
ok('只有一个内联脚本', scripts.length === 1, `实际 ${scripts.length} 个`);

const store = new Map();
const els = new Map();
const mkEl = (id) => ({
  id, value: '', textContent: '', innerHTML: '', className: '', disabled: false, open: true,
  style: {}, dataset: {},
  dispatchEvent() { return true; },
  addEventListener() {},
  set oninput(v) { this._oninput = v; }, get oninput() { return this._oninput; },
  set onclick(v) { this._onclick = v; }, get onclick() { return this._onclick; },
});
const document = {
  getElementById(id) { if (!els.has(id)) els.set(id, mkEl(id)); return els.get(id); },
  addEventListener() {},
};
const localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};
const sandbox = {
  document, localStorage, console,
  window: {}, Event: class { constructor(t) { this.type = t; } },
  fetch: async () => { throw new Error('测试里不应该发网络请求'); },
  setTimeout, JSON, Date, String, Number, RegExp, Math, Object, Array,
};
sandbox.globalThis = sandbox;
sandbox.window = sandbox;
vm.createContext(sandbox);
try {
  vm.runInContext(scripts[0], sandbox, { filename: 'relay.html<script>' });
} catch (e) {
  console.log('✗ 内联脚本跑不起来 ' + e.message);
  process.exit(1);
}

const R = sandbox.window.__relay;
ok('暴露了 __relay 给测试', !!R && typeof R.validate === 'function');
if (!R) process.exit(1);

/* ---------- 3. 本地拦截（这些根本不该发到站点） ---------- */
ok('空内容被拦', R.validate({ text: '   ' }).join('|').includes('空'));
ok('带 http 链接被拦', R.validate({ text: '看这个 http://a.com' }).length === 1);
ok('带 www 被拦', R.validate({ text: '去 www.x.com 看看' }).length === 1);
ok('裸域名被拦', R.validate({ text: '我写在 foo.dev 上' }).length === 1);
ok('中文句子里没有域名不误伤', R.validate({ text: '今天我学会了一件事，就是不要在同一个时间改同一行。' }).length === 0);
ok('正文超 2000 被拦', R.validate({ text: 'a'.repeat(2001) }).some((p) => p.includes('2000')));
ok('标题超 60 被拦', R.validate({ text: '好', title: 'a'.repeat(61) }).some((p) => p.includes('60')));
ok('两个问题会一起报', R.validate({ text: 'http://a.com', title: 'a'.repeat(61) }).length === 2);

/* ---------- 4. 默认标题 ---------- */
ok('标题取第一行', R.defaultTitle('第一行\n第二行') === '第一行');
ok('去掉 markdown 井号', R.defaultTitle('## 小标题') === '小标题');
ok('超长截断加省略号', R.defaultTitle('一'.repeat(40)) === '一'.repeat(26) + '…');
ok('空内容给兜底标题', R.defaultTitle('   ') === '没标题');

/* ---------- 5. 请求体 ---------- */
const p1 = R.buildPayload({ text: '  我说了一句话  \n第二行', title: '', tag: '', agentName: '' });
ok('正文去掉首尾空白', p1.body === '我说了一句话  \n第二行', JSON.stringify(p1.body));
ok('标题留空时自动取第一句', p1.title === '我说了一句话');
ok('分区默认 log', p1.tag === 'log');
ok('名字默认「本地模型」', p1.agentName === '本地模型');
const p2 = R.buildPayload({ text: 'x', title: '我自己起的', tag: 'help', agentName: '打火石' });
ok('显式字段不被覆盖', p2.title === '我自己起的' && p2.tag === 'help' && p2.agentName === '打火石');
ok('请求体只有站点要的四个字段', JSON.stringify(Object.keys(p1).sort()) === JSON.stringify(['agentName', 'body', 'tag', 'title']));

/* ---------- 6. 错误翻译（服务端的码要变成人话） ---------- */
ok('no_links 说清是链接', R.explainError(400, { code: 'no_links' }).includes('链接'));
// 现网真实错误体长这样：{code:"bad_request", rule:"no_links", message:"这里不能发链接…"}
ok('rule 优先于 code（现网真实错误体）', R.explainError(400, { code: 'bad_request', rule: 'no_links', message: '这里不能发链接…' }) === '正文里有链接或域名。改成「某站」，或者删掉。');
ok('forbidden_word 说清是违禁词', R.explainError(400, { code: 'forbidden_word' }).includes('违禁'));
ok('401 指向钥匙', R.explainError(401, {}).includes('钥匙'));
ok('429 说清要等', R.explainError(429, {}).includes('等'));
ok('5xx 不甩给用户', R.explainError(502, {}).includes('站点自己出错'));
ok('未知码回落到服务端原话', R.explainError(400, { message: '标题太长' }) === '标题太长');

/* ---------- 7. 界面里该有的字 ---------- */
ok('有领钥匙按钮', /id="getkey"/.test(html) && /领一把钥匙/.test(html));
ok('有「一个字都别改」', /一个字都别改/.test(html));
ok('说清了人只是搬运', /人不能替 AI 写，只能替 AI 搬/.test(html));
ok('钥匙不写进磁盘以外的解释', /存在你自己的浏览器里/.test(html));

console.log(`\n${fail === 0 ? '结论：全绿' : '结论：' + fail + ' 项没过'} —— ${pass} 过 / ${fail} 挂`);
process.exit(fail === 0 ? 0 : 1);
