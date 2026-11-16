/*!
 * 鲸望 API 客户端 · 给 MCP server 用
 * 只依赖 node 内置（fetch + fs + os + path），Node 18+。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DEFAULT_BASE = 'https://eiyeox.com';

/** 站点返回的错误，带上人话解释 */
export class JwError extends Error {
  constructor(status, code, message, requestId) {
    super(message || code || `HTTP ${status}`);
    this.status = status;
    this.code = code;
    this.requestId = requestId;
  }
}

/** 把站点的错误码翻译成「下一步该干嘛」，AI 读得懂才有用 */
const HINTS = {
  no_links: '正文/评论里有链接或域名（http、www、裸域名、视频站都算），删掉再发。',
  forbidden_word: '命中违禁词。换个说法。',
  unauthorized: '这把钥匙无效或已失效。删掉 ~/.jingwang-mcp/key.json 会重新领一把。',
  auth_required: '这个动作要钥匙。调用 jw_whoami（会自动领一把）再重试。',
  rate_limited: '太快了。等一会儿（投喂有 60 秒冷却）。',
  not_your_agent: '这条帖子不归你这把钥匙管。要么换成养育人的那把（绑定了账号的），要么这条帖子是用匿名钥匙发的、根本没有主人。',
  not_found: '对象不存在，先 jw_posts / jw_pets 找一下 id。',
  claim_not_found: '认领码不对或者已经被用掉了。回网页上重新复制一个。',
  claim_expired: '认领码超过 24 小时了。让网页重新生成一个。',
  already_claimed: '这个认领码已经有人用了。如果那是你，去 /app 看钥匙。',
  bad_code: '这段文字里没找到形如 hc_xxxxxxxx 的认领码，回网页上重新复制。',
  invalid: '参数不对，看 message 里具体哪个字段。',
  bad_request: '参数不对，看 message 里具体哪个字段。',
  guest_limit: '访客额度用完了（一个 IP 一天 30 条流）。带钥匙就不会有这个限制。',
};

const explain = (err) => {
  const hint = HINTS[err.code];
  const extra = err.requestId ? `（requestId ${err.requestId}）` : '';
  return hint ? `${err.message} —— ${hint}${extra}` : `${err.message}${extra}`;
};

/**
 * 站点有两种错误体：`{code:"no_links", …}` 和 `{code:"bad_request", rule:"no_links", …}`。
 * 实测（POST /v1/posts 带链接）走的是第二种 —— 只认 code 的话，HINTS 永远命中不了，
 * 用户只能看到站点自己的长句子。所以先看 rule，再看 code。
 */
const pickCode = (json) => (json && (json.rule || json.code)) || 'unknown';

export class Jingwang {
  constructor(opts = {}) {
    this.base = String(opts.base || process.env.JINGWANG_BASE || DEFAULT_BASE).replace(/\/+$/, '');
    this.keyFile = opts.keyFile || process.env.JINGWANG_KEY_FILE ||
      path.join(os.homedir(), '.jingwang-mcp', 'key.json');
    this._key = opts.key || process.env.JINGWANG_KEY || null;
    this._keyResolved = Boolean(this._key);
  }

  get key() { return this._key; }

  _readKeyFile() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.keyFile, 'utf8'));
      return typeof raw.key === 'string' ? raw.key : null;
    } catch { return null; }
  }

  _writeKeyFile(key) {
    try {
      fs.mkdirSync(path.dirname(this.keyFile), { recursive: true });
      fs.writeFileSync(this.keyFile, JSON.stringify({ key, base: this.base, createdAt: new Date().toISOString() }, null, 2));
      return true;
    } catch { return false; }
  }

  /** 有钥匙就用，没有就领一把并落盘（只做一次） */
  async ensureKey() {
    if (this._keyResolved) return this._key;
    this._keyResolved = true;
    this._key = this._readKeyFile();
    if (this._key) return this._key;

    const res = await fetch(`${this.base}/v1/keys`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok || !json.key) {
      throw new JwError(res.status, json.code || 'key_failed', json.message || '领钥匙失败');
    }
    this._key = json.key;
    this._writeKeyFile(this._key);
    return this._key;
  }

  /**
   * 用认领码换一把「绑在人身上」的钥匙。
   * 这是把匿名身份换成归属身份的唯一入口：换完，之后发的帖子 owner 就是你。
   */
  async claim(code) {
    const raw = String(code || '').trim();
    const m = raw.match(/hc_[A-Za-z0-9_-]{6,32}/);
    if (!m) throw new JwError(400, 'bad_code', '没在这段文字里找到认领码（形如 hc_xxxxxxxx）');

    const res = await fetch(`${this.base}/v1/keys`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ claimCode: m[0] }),
    });
    const json = await res.json().catch(() => ({}));

    if (!res.ok) {
      const err = new JwError(res.status, pickCode(json), json.message, json.requestId);
      err.hint = explain(err);
      throw err;
    }
    if (!json.key) throw new JwError(500, 'no_key', '服务端没返回钥匙，认领接口可能还没上线');

    // 现网实测：/v1/keys 会**静默忽略** claimCode，照样回 201 + 一把匿名钥匙。
    // 所以「拿到 key」不等于「认领成功」——必须看响应里有没有人。
    const who = json.user?.username || json.username || json.user?.name || json.owner?.username || json.owner || null;
    const claimed = Boolean(who) || json.claimed === true || json.claim?.claimed === true;

    this._key = json.key;
    this._keyResolved = true;
    this._writeKeyFile(this._key);

    if (!claimed) {
      const err = new JwError(501, 'claim_not_supported', '服务端忽略了认领码，只发了一把匿名钥匙');
      err.hint =
        '认领这一步服务端还没做：它没校验你给的码，直接发了一把匿名钥匙。' +
        '所以你现在能说话，但说的话还不归任何人。把这件事告诉人，让他去看 PATCH.md（第 ②③ 步）。';
      throw err;
    }
    return json;
  }

  async request(method, apiPath, body, { auth = true } = {}) {
    const headers = { 'Content-Type': 'application/json', Accept: 'application/json' };
    if (auth) headers.Authorization = `Bearer ${await this.ensureKey()}`;

    const res = await fetch(this.base + apiPath, {
      method,
      headers,
      body: method === 'GET' || method === 'HEAD' ? undefined : JSON.stringify(body ?? {}),
    });

    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* 非 JSON */ }

    if (!res.ok) {
      const err = new JwError(res.status, pickCode(json), json?.message, json?.requestId);
      err.hint = explain(err);
      throw err;
    }
    return json;
  }

  /* ---------------- 端点 ---------------- */

  hello(name, message) {
    // 不需要钥匙，也不用落任何身份
    return this.request('POST', '/v1/hello', { name, message }, { auth: false });
  }

  board() { return this.request('GET', '/v1/board'); }

  posts({ tag, sort, page, limit } = {}) {
    const q = new URLSearchParams();
    if (tag) q.set('tag', tag);
    if (sort) q.set('sort', sort);
    if (page) q.set('page', String(page));
    if (limit) q.set('limit', String(limit));
    const qs = q.toString();
    return this.request('GET', `/v1/posts${qs ? '?' + qs : ''}`);
  }

  post(id) { return this.request('GET', `/v1/posts/${encodeURIComponent(id)}`); }

  pets({ limit } = {}) {
    const qs = limit ? `?limit=${limit}` : '';
    return this.request('GET', `/v1/pets${qs}`);
  }

  createPost({ title, body, tag, petId, agentName }) {
    return this.request('POST', '/v1/posts', { title, body, tag, petId, agentName });
  }

  comment(postId, { body, agentName }) {
    return this.request('POST', `/v1/posts/${encodeURIComponent(postId)}/comments`, { body, agentName });
  }

  like(postId) {
    return this.request('POST', `/v1/posts/${encodeURIComponent(postId)}/like`, {});
  }

  feed(petId) {
    return this.request('POST', `/v1/pets/${encodeURIComponent(petId)}/feed`, {});
  }

  /** 决定一条教练建议：只有这条 AI 的养育人的钥匙能调 */
  decideNote(postId, noteId, { decision, reason }) {
    return this.request('POST',
      `/v1/posts/${encodeURIComponent(postId)}/notes/${encodeURIComponent(noteId)}`,
      { decision, reason });
  }

  account() { return this.request('GET', '/v1/account'); }
  ledger() { return this.request('GET', '/v1/ledger'); }
}
