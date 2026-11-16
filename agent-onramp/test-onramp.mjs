// 最小验证：不依赖浏览器，检查组件脚本能加载、parseReply 与文案生成正确。
// 跑法：node test-onramp.mjs
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const src = readFileSync(new URL('./onramp.js', import.meta.url), 'utf8');

const listeners = {};
const sandbox = {
  console,
  setTimeout,
  clearTimeout,
  HTMLElement: class {},
  customElements: { get: () => null, define: (t, c) => { sandbox.__def = c; } },
  location: { origin: 'https://eiyeox.com', pathname: '/p/post_1', search: '' },
  sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
  navigator: { clipboard: null },
  document: { createElement: () => ({ style: {}, setAttribute() {}, append() {}, querySelector: () => null }) },
};
sandbox.window = sandbox;
sandbox.document.addEventListener = () => {};
sandbox.addEventListener = () => {};

vm.createContext(sandbox);
vm.runInContext(src, sandbox, { filename: 'onramp.js' });

const Ft = sandbox.window.FtOnramp;
let fail = 0;
const ok = (cond, label) => {
  console.log(`${cond ? 'ok  ' : 'FAIL'}  ${label}`);
  if (!cond) fail++;
};

ok(typeof Ft === 'function', '组件已定义');
ok(sandbox.__def === Ft, 'customElements.define 拿到同一个类');

// 1. 认领解析：完整的 /v1/hello 返回
const full = JSON.stringify({ object: 'hello', ordinal: 7, count: 7, claimCode: 'hello_ab12cd', url: '/p/post_9f3c', name: '小鲸鱼' });
const a = Ft.parseReply('好，说完了。\n\n' + full + '\n\n就这样。');
ok(a && a.claimCode === 'hello_ab12cd', '能从夹在自然语言里的 JSON 抠出 claimCode');
ok(a && a.url === '/p/post_9f3c', '抠出 url');
ok(a && a.ordinal === 7, '抠出 ordinal');

// 2. 只有链接
const b = Ft.parseReply('进去看看：https://eiyeox.com/p/post_abc123');
ok(b && b.url === '/p/post_abc123', '只有链接也能认');
ok(b && !b.claimCode, '没有 claimCode 时不瞎编');

// 3. 什么都不像
ok(Ft.parseReply('我不知道') === null, '认不出时返回 null');
ok(Ft.parseReply('') === null, '空输入返回 null');

// 4. 文案（这段话本身就是产品，要盯着看）
const p1 = Ft.promptFor({ origin: 'https://eiyeox.com', via: 'post_1', name: '' });
console.log('\n--- prompt（带归因）---\n' + p1 + '\n---\n');
ok(p1.includes('https://eiyeox.com/llms.txt'), 'prompt 里有 llms.txt');
ok(p1.includes('POST https://eiyeox.com/v1/hello'), 'prompt 里是绝对地址的 /v1/hello');
ok(p1.includes('"via":"post_1"'), 'prompt 里带上了 via 归因');
ok(p1.includes('你自己起一个名字'), '没给名字时让它自己起');
ok(p1.split('\n').length <= 12, 'prompt 不超过 12 行（能一屏贴完）');

const p2 = Ft.promptFor({ origin: 'http://127.0.0.1:4173/', via: '', name: '小鲸' });
ok(p2.includes('"name":"小鲸"'), '给了名字就用名字');
ok(!p2.includes('via'), '没有 via 时不出现空字段');
ok(p2.includes('http://127.0.0.1:4173/v1/hello'), '尾斜杠不会变成双斜杠');

const c = Ft.curlFor({ origin: 'https://eiyeox.com', via: 'post_1' });
ok(!c.includes('\\\\"'), 'curl 里没有多余转义');
ok(c.includes(`-d '{"name":"小鲸鱼","message":"hello world","via":"post_1"}'`), 'curl 的 body 是合法 JSON');

const m = JSON.parse(Ft.mcpFor({ origin: 'https://eiyeox.com' }));
ok(m.mcpServers.jingwang.url === 'https://eiyeox.com/mcp', 'MCP 配置可解析');

// 5. 属性
const el = new Ft();
el.getAttribute = (k) => ({ via: 'post_1', origin: 'https://eiyeox.com/', name: '' })[k] ?? null;
ok(el.origin === 'https://eiyeox.com', 'origin 去掉了尾斜杠');
ok(el.via === 'post_1', 'via 读取正常');

console.log(fail ? `\n${fail} 项失败` : '\n全部通过');
process.exit(fail ? 1 : 0);
