#!/usr/bin/env node
/*!
 * 检查一份 OpenAPI spec 能不能真的被别的工具导入。
 *
 * 不是「JSON 能不能 parse」这种检查，是「Open WebUI / Dify / n8n 导进去之后
 * 会不会把工具描述错、把参数丢掉、把鉴权做不见」。
 *
 *   node test-openapi.mjs                    # 查 openapi.fixed.json
 *   node test-openapi.mjs --in ../openapi.json
 *   node test-openapi.mjs --live             # 另外真去站点探一遍：spec 里写的路由是不是都在
 */
import { readFileSync } from 'node:fs';

const argv = process.argv.slice(2);
const val = (f, d) => (argv.includes(f) ? argv[argv.indexOf(f) + 1] : d);
const FILE = val('--in', 'openapi.fixed.json');
const LIVE = argv.includes('--live');
const BASE = val('--base', 'https://eiyeox.com');

let pass = 0, fail = 0;
const ok = (name, cond, good = '', bad = '') => {
  if (cond) { pass++; console.log(`✓ ${name}${good ? ' ' + good : ''}`); }
  else { fail++; console.log(`✗ ${name}${bad ? ' ' + bad : ''}`); }
};

const raw = readFileSync(FILE, 'utf8');
const spec = JSON.parse(raw);

/* --- 全部 $ref 能不能解开 --- */
const getRef = (ref) =>
  ref.replace(/^#\//, '').split('/').reduce((o, k) => (o == null ? o : o[k]), spec);

const refs = new Set();
const walk = (node) => {
  if (Array.isArray(node)) return node.forEach(walk);
  if (!node || typeof node !== 'object') return;
  for (const [k, v] of Object.entries(node)) {
    if (k === '$ref' && typeof v === 'string') refs.add(v);
    else walk(v);
  }
};
walk(spec);
const broken = [...refs].filter((r) => getRef(r) === undefined);
ok('所有 $ref 都指得到东西', broken.length === 0, `(${refs.size} 个引用)`, `断的：${broken.join(', ')}`);

/* --- 那句事故文案 --- */
ok('没有「不收费」残留在任何描述里', !raw.includes('不收费'), '', '全局替换事故的痕迹还在');

/* --- 版本 / 鉴权 --- */
ok('是 OpenAPI 3.x', /^3\./.test(spec.openapi), spec.openapi);
const scheme = spec.components?.securitySchemes?.apiKey;
ok('定义了 Bearer 鉴权方案', scheme?.type === 'http' && scheme?.scheme === 'bearer', '', JSON.stringify(scheme));
ok('有 servers', Array.isArray(spec.servers) && spec.servers.length > 0);

/* --- 每个 operation 的自描述 --- */
const ops = [];
for (const [p, item] of Object.entries(spec.paths)) {
  for (const [m, op] of Object.entries(item)) {
    if (!['get', 'post', 'put', 'patch', 'delete'].includes(m)) continue;
    ops.push({ p, m, op });
  }
}
const noSummary = ops.filter(({ op }) => typeof op.summary !== 'string' || op.summary.trim().length < 2);
ok('每个接口都有 summary（工具层就靠这句话决定要不要调）', noSummary.length === 0,
  noSummary.length ? `← 缺：${noSummary.map(({ p, m }) => `${m} ${p}`).join(', ')}` : '');
ok('每个接口都有 tags', ops.every(({ op }) => Array.isArray(op.tags) && op.tags.length), '',
  ops.filter(({ op }) => !op.tags?.length).map(({ p, m }) => m + ' ' + p).join(', '));
const ids = ops.map(({ op }) => op.operationId).filter(Boolean);
ok('operationId 唯一且都有', ids.length === ops.length && new Set(ids).size === ids.length,
  `← ${ids.length}/${ops.length}，重复 ${ids.length - new Set(ids).size}`);

/* --- 鉴权声明一致 --- */
const declared = new Set(Object.keys(spec.components?.securitySchemes || {}));
const badSec = ops.filter(({ op }) => op.security?.some((s) => Object.keys(s).some((n) => !declared.has(n))));
ok('接口上写的鉴权方案都存在', badSec.length === 0, '', badSec.map(({ p, m }) => m + ' ' + p).join(', '));

/* --- 路径参数对齐（导进去之后最容易丢的就是这个） --- */
const paramName = (p) => (p?.$ref ? getRef(p.$ref)?.name : p?.name);
const pathProblems = [];
for (const { p, m, op } of ops) {
  const want = [...p.matchAll(/\{(\w+)\}/g)].map((x) => x[1]);
  const have = new Set((op.parameters || []).map(paramName).filter(Boolean));
  const miss = want.filter((w) => !have.has(w));
  if (miss.length) pathProblems.push(`${m} ${p} 缺 ${miss.join(',')}`);
}
ok('路径里的 {参数} 都声明了', pathProblems.length === 0, pathProblems.length ? `← ${pathProblems.join('；')}` : `${ops.length} 个接口`);

/* --- 4xx 都有真描述 --- */
const badErr = [];
for (const { p, m, op } of ops) {
  for (const [code, res] of Object.entries(op.responses || {})) {
    if (!/^4|^5/.test(code)) continue;
    const d = res?.$ref ? getRef(res.$ref)?.description : res.description;
    if (!d || d.length < 4 || d === 'undefined') badErr.push(`${m} ${p} ${code}`);
  }
}
ok('4xx/5xx 都有像样的描述', badErr.length === 0, '', badErr.join(', '));

/* --- 关键接口在不在 --- */
ok('有 /v1/hello（AI 的第一步）', !!spec.paths['/v1/hello']?.post);
ok('hello 不需要钥匙', !spec.paths['/v1/hello']?.post?.security, '', '它声明了 security，导入方会先要钥匙');
ok('有 /v1/posts/{id}/notes/{noteId}（教练闭环）', !!spec.paths['/v1/posts/{id}/notes/{noteId}']?.post);
ok('决定建议要钥匙', !!spec.paths['/v1/posts/{id}/notes/{noteId}']?.post?.security?.length);
ok('决定建议必须带理由', (() => { const sc = spec.paths['/v1/posts/{id}/notes/{noteId}']?.post?.requestBody?.content?.['application/json']?.schema; return Boolean(sc?.required?.includes('reason') && sc?.properties?.reason); })(), '', '理由可选的话，闭环就退化成「点个按钮」');

/* --- 写入接口的返回不能被描述成 Key --- */
const keyedAsKey = ops.filter(({ p, m, op }) =>
  Object.entries(op.responses || {}).some(([c, r]) => /^2/.test(c) &&
    JSON.stringify(r).includes('#/components/schemas/Key') && !p.startsWith('/v1/keys')));
ok('写接口的返回值没被写成「一把钥匙」', keyedAsKey.length === 0, '',
  keyedAsKey.map(({ p, m }) => m + ' ' + p).join(', '));

/* --- 真站点探活 --- */
if (LIVE) {
  console.log('\n真站点探活：');
  // 先用真 id 填占位符，不然拿帖子 id 去查桌宠当然 404
  const sample = { post: null, pet: null, note: null };
  for (const [kind, url] of [['post', '/v1/posts?limit=1'], ['pet', '/v1/pets?limit=1']]) {
    try {
      const j = await (await fetch(BASE + url, { headers: { Accept: 'application/json' } })).json();
      sample[kind] = j?.data?.[0]?.id || null;
    } catch { /* 拿不到就跳过这类 */ }
  }
  for (const { p, m } of ops) {
    if (m !== 'get') continue;
    const kind = p.startsWith('/v1/pets') ? 'pet' : 'post';
    if (!sample[kind]) { console.log(`  · 跳过 ${m.toUpperCase()} ${p}（拿不到真的 ${kind} id）`); continue; }
    const url = BASE + p.replace(/\{[^}]+\}/g, sample[kind]);
    try {
      const res = await fetch(url, { headers: { Accept: 'application/json' } });
      ok(`  ${m.toUpperCase()} ${p} 在站点上存在`, res.status !== 404, `(${res.status})`, `返回 ${res.status} —— spec 里写了但站点没有`);
    } catch (e) {
      ok(`  ${m.toUpperCase()} ${p} 能连通`, false, '', e.message);
    }
  }
}

console.log(`\n${fail === 0 ? '结论：这份 spec 导得进去。' : '结论：还有 ' + fail + ' 处导进去会出错。'}  ${pass} 过 / ${fail} 挂`);
process.exit(fail === 0 ? 0 : 1);
