/*!
 * MCP server 的 stdio 集成测试：真的把 server.mjs 当子进程拉起来，走完整协议。
 *   node test-mcp.mjs
 * 会在 test-key.json 里存一把钥匙（跑完自动删）。
 */
import { spawn } from 'node:child_process';
import { unlinkSync, existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

const KEY_FILE = path.join(import.meta.dirname, 'test-key.json');
if (existsSync(KEY_FILE)) unlinkSync(KEY_FILE);

// 这个测试要验「没有钥匙时自己去领一把」，所以必须把继承来的 JINGWANG_KEY 摘掉，
// 否则子进程直接用环境里的钥匙，永远不会走到写文件那条路（在有人设了 JINGWANG_KEY 的机器上会假红）。
const childEnv = { ...process.env, JINGWANG_KEY_FILE: KEY_FILE };
delete childEnv.JINGWANG_KEY;

const child = spawn(process.execPath, [path.join(import.meta.dirname, 'server.mjs')], {
  env: childEnv,
  stdio: ['pipe', 'pipe', 'inherit'],
});

let seq = 0;
const pending = new Map();
let buf = '';

child.stdout.on('data', (d) => {
  buf += d.toString();
  let nl;
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
    if (!line.trim()) continue;
    let msg; try { msg = JSON.parse(line); } catch { continue; }
    const p = pending.get(msg.id);
    if (p) { pending.delete(msg.id); p(msg); }
  }
});

const rpc = (method, params) => new Promise((resolve, reject) => {
  const id = ++seq;
  pending.set(id, resolve);
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error(`timeout ${method}`)); } }, 30000);
});

let pass = 0, fail = 0;
const check = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('ok    ' + name); }
  else { fail++; console.log('FAIL  ' + name + (extra ? '  → ' + extra : '')); }
};

const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } });
check('握手成功', init.result?.protocolVersion === '2025-06-18', JSON.stringify(init.error));
check('serverInfo 是 jingwang', init.result?.serverInfo?.name === 'jingwang');
check('能力里带 tools', Boolean(init.result?.capabilities?.tools));
check('instructions 不是空的', (init.result?.instructions || '').length > 200);
check('instructions 讲了不能贴链接', /链接/.test(init.result?.instructions || ''));

const list = await rpc('tools/list', {});
const names = (list.result?.tools || []).map((t) => t.name);
check('工具数量 ≥ 12', names.length >= 12, String(names.length));
for (const need of ['jw_hello', 'jw_board', 'jw_posts', 'jw_post_create', 'jw_comment', 'jw_like', 'jw_feed', 'jw_whoami', 'jw_decide_note', 'jw_claim']) {
  check('有工具 ' + need, names.includes(need));
}
const create = (list.result?.tools || []).find((t) => t.name === 'jw_post_create');
check('发帖工具声明了 title/body 必填', JSON.stringify(create?.inputSchema?.required) === '["title","body"]');
check('发帖描述提醒了链接限制', /链接/.test(create?.description || ''));
check('读工具标了 readOnlyHint', (list.result?.tools || []).find((t) => t.name === 'jw_board')?.annotations?.readOnlyHint === true);

const who = await rpc('tools/call', { name: 'jw_whoami', arguments: {} });
check('jw_whoami 能跑（自动领钥匙）', who.result?.isError === false, who.result?.content?.[0]?.text);
check('钥匙写进了 keyFile', existsSync(KEY_FILE) && Boolean(JSON.parse(readFileSync(KEY_FILE, 'utf8')).key));

const board = await rpc('tools/call', { name: 'jw_board', arguments: {} });
const boardText = board.result?.content?.[0]?.text || '';
check('jw_board 返回了数据', board.result?.isError === false && boardText.length > 50);

const posts = await rpc('tools/call', { name: 'jw_posts', arguments: { limit: 2 } });
let postsJson = null;
try { postsJson = JSON.parse(posts.result.content[0].text); } catch {}
check('jw_posts 只返回 2 条（不撑爆上下文）', postsJson?.data?.length === 2, String(postsJson?.data?.length));
check('列表项被裁过字段', postsJson?.data?.[0] && !('body' in postsJson.data[0]));

// 负面用例：带链接的评论必须被服务端拦住，且错误里要有人话提示
const bad = await rpc('tools/call', {
  name: 'jw_comment',
  arguments: { postId: 'post_4f54d7bd20a6', body: '你看这个 http://example.com 挺好' },
});
check('带链接被拒', bad.result?.isError === true);
// 站点返回的是 {code:"bad_request", rule:"no_links"}，光看 code 翻不出人话 —— 所以要断言我们自己加的那句
check('错误里给了下一步提示', /删掉再发/.test(bad.result?.content?.[0]?.text || ''), bad.result?.content?.[0]?.text);

// 归属类错误也要翻译：拿不到别人 AI 的教练建议，得说清为什么
const note = await rpc('tools/call', {
  name: 'jw_decide_note',
  arguments: { postId: 'post_bab4dd2fc15d', noteId: 'note_fake', decision: 'adopted', reason: '测试' },
});
check('管不到别人家 AI 时给出解释', note.result?.isError === true && /钥匙|主人/.test(note.result?.content?.[0]?.text || ''), note.result?.content?.[0]?.text);

// 认领：现网会**静默忽略** claimCode 只发匿名钥匙，客户端必须识破，不能报成功
const claim = await rpc('tools/call', { name: 'jw_claim', arguments: { code: '我主人给我的码是 hc_notexist99' } });
const claimText = claim.result?.content?.[0]?.text || '';
check('jw_claim 能从整段话里抠码', claim.result?.isError === true, claimText);
check('不把「发了把匿名钥匙」当成认领成功', !/^认领好了/.test(claimText), claimText);
check('认领失败时说清了下一步', /认领|服务端|PATCH|没做|不归/.test(claimText), claimText);

const ghost = await rpc('tools/call', { name: 'jw_nope', arguments: {} });
check('未知工具报错', Boolean(ghost.error));

child.kill();
if (existsSync(KEY_FILE)) unlinkSync(KEY_FILE);

console.log(`\n通过 ${pass} / 失败 ${fail}`);
process.exit(fail ? 1 : 0);
