// キィニチくん専属マネージャー：Web Push 送信サーバー（Cloudflare Workers）
//
// ・Cloudflare ダッシュボードの「コードを編集」にこのファイルの中身を丸ごと貼り付けて使う（外部ライブラリなし）
// ・必要な設定（手順は docs/cloudflare_setup.md）
//     KV バインディング   PUSH_KV        … 購読情報・VAPID鍵の保存先
//     D1 バインディング   DB             … 予約キューの保存先（強い整合性。未設定ならKVで代用するが遅れやすい）
//     シークレット         APP_TOKEN      … PWA/送信ページが送る合言葉。コードやリポジトリには書かない
//     変数（任意）         ALLOWED_ORIGIN … 呼び出しを許すサイト（既定 https://kana13914-pixel.github.io）
//     Cron Trigger         * * * * *      … 毎分、予約キューを確認して時刻が来たものを送る
// ・VAPID 鍵は初回アクセス時に自動生成して KV に保存する（人間が鍵を扱わなくて済むように）
// ・Web Push の暗号化は RFC 8291（aes128gcm）、認証は RFC 8292（VAPID）に従う

const DEFAULT_ORIGIN = 'https://kana13914-pixel.github.io';
const VAPID_SUBJECT = 'https://kana13914-pixel.github.io/';
const MAX_DELAY_SEC = 3 * 24 * 3600; // 予約は3日先まで
const MAX_QUEUE = 50;
// Cronは毎分。予定時刻の30秒前から送ることで、ずれを概ね±30秒に収める（完了条件は±60秒）
const EARLY_MS = 30 * 1000;

// ---------- 小道具 ----------
const enc = new TextEncoder();

function b64url(bytes) {
  let s = '';
  for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function unb64url(str) {
  const s = atob(str.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((str.length + 3) % 4));
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
}

function concat(...parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

async function hkdf(salt, ikm, info, length) {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, length * 8);
  return new Uint8Array(bits);
}

function timingSafeEqual(a, b) {
  const x = enc.encode(a), y = enc.encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] || 0) ^ (y[i] || 0);
  return diff === 0;
}

// ---------- VAPID ----------
async function getVapid(env) {
  const saved = await env.PUSH_KV.get('vapid', 'json');
  if (saved) return saved;
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const vapid = {
    publicKey: b64url(await crypto.subtle.exportKey('raw', pair.publicKey)),
    privateJwk: await crypto.subtle.exportKey('jwk', pair.privateKey),
  };
  await env.PUSH_KV.put('vapid', JSON.stringify(vapid));
  return vapid;
}

async function vapidAuthHeader(vapid, endpoint) {
  const aud = new URL(endpoint).origin;
  const header = b64url(enc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = b64url(enc.encode(JSON.stringify({
    aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: VAPID_SUBJECT,
  })));
  const key = await crypto.subtle.importKey('jwk', vapid.privateJwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, enc.encode(`${header}.${claims}`));
  return `vapid t=${header}.${claims}.${b64url(sig)}, k=${vapid.publicKey}`;
}

// ---------- 暗号化（RFC 8291 aes128gcm） ----------
async function encryptPayload(subscription, plaintext) {
  const uaPublic = unb64url(subscription.keys.p256dh);
  const authSecret = unb64url(subscription.keys.auth);
  const as = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const asPublic = new Uint8Array(await crypto.subtle.exportKey('raw', as.publicKey));
  const uaKey = await crypto.subtle.importKey('raw', uaPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const ecdhSecret = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, as.privateKey, 256));

  const ikm = await hkdf(authSecret, ecdhSecret, concat(enc.encode('WebPush: info\0'), uaPublic, asPublic), 32);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, enc.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, enc.encode('Content-Encoding: nonce\0'), 12);

  const aesKey = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const padded = concat(enc.encode(plaintext), new Uint8Array([2])); // 最終レコードの区切り
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, aesKey, padded));

  const rs = new Uint8Array([0, 0, 16, 0]); // レコードサイズ 4096
  return concat(salt, rs, new Uint8Array([asPublic.length]), asPublic, cipher);
}

async function sendPush(env, message) {
  const subscription = await env.PUSH_KV.get('subscription', 'json');
  if (!subscription) return { ok: false, status: 0, error: '購読がありません（PWAで「通知を有効にする」を先に押してください）' };
  const vapid = await getVapid(env);
  const body = await encryptPayload(subscription, JSON.stringify(message));
  const res = await fetch(subscription.endpoint, {
    method: 'POST',
    headers: {
      Authorization: await vapidAuthHeader(vapid, subscription.endpoint),
      'Content-Encoding': 'aes128gcm',
      'Content-Type': 'application/octet-stream',
      TTL: '3600',
      Urgency: 'high',
    },
    body,
  });
  if (res.status === 404 || res.status === 410) {
    await env.PUSH_KV.delete('subscription'); // 購読が無効になった
  }
  const ok = res.status >= 200 && res.status < 300;
  return { ok, status: res.status, error: ok ? undefined : (await res.text()).slice(0, 300) };
}

// ---------- 予約キュー ----------
// D1（SQLite）があればそちらを使う。KVは結果整合性で、予約が最大1分ほど遅れることがあったため（D-011, D-012）
const D1_SCHEMA = 'CREATE TABLE IF NOT EXISTS queue (id TEXT PRIMARY KEY, at INTEGER NOT NULL, title TEXT, body TEXT, url TEXT)';
const D1_INDEX = 'CREATE INDEX IF NOT EXISTS queue_at ON queue(at)';

function queueStore(env) {
  if (env.DB) {
    let ready;
    const init = () => (ready ||= env.DB.batch([env.DB.prepare(D1_SCHEMA), env.DB.prepare(D1_INDEX)]));
    return {
      kind: 'd1',
      async list() {
        await init();
        return (await env.DB.prepare('SELECT id, at FROM queue ORDER BY at').all()).results;
      },
      async count() {
        await init();
        return (await env.DB.prepare('SELECT COUNT(*) AS n FROM queue').first()).n;
      },
      async add(item) {
        await init();
        await env.DB.prepare('INSERT INTO queue (id, at, title, body, url) VALUES (?, ?, ?, ?, ?)')
          .bind(item.id, item.at, item.title, item.body, item.url ?? null).run();
      },
      // 取り出しと削除を1文で行い、二重送信を防ぐ
      async takeDue(until) {
        await init();
        return (await env.DB.prepare('DELETE FROM queue WHERE at <= ? RETURNING id, at, title, body, url').bind(until).all()).results;
      },
    };
  }
  return {
    kind: 'kv',
    async list() { return ((await env.PUSH_KV.get('queue', 'json')) || []).map((q) => ({ id: q.id, at: q.at })); },
    async count() { return ((await env.PUSH_KV.get('queue', 'json')) || []).length; },
    async add(item) {
      const queue = (await env.PUSH_KV.get('queue', 'json')) || [];
      queue.push(item);
      await env.PUSH_KV.put('queue', JSON.stringify(queue));
    },
    async takeDue(until) {
      const queue = (await env.PUSH_KV.get('queue', 'json')) || [];
      const due = queue.filter((q) => q.at <= until);
      if (due.length) await env.PUSH_KV.put('queue', JSON.stringify(queue.filter((q) => q.at > until)));
      return due;
    },
  };
}

async function runDue(env, now = Date.now()) {
  const store = queueStore(env);
  const due = await store.takeDue(now + EARLY_MS);
  let sent = 0;
  for (const item of due) {
    const r = await sendPush(env, { title: item.title, body: item.body, url: item.url || undefined });
    if (r.ok) sent++;
  }
  return { sent, left: await store.count() };
}

// ---------- HTTP ----------
function cors(env, request) {
  const allowed = env.ALLOWED_ORIGIN || DEFAULT_ORIGIN;
  const origin = request.headers.get('Origin');
  return {
    'Access-Control-Allow-Origin': origin === allowed ? origin : allowed,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

function json(data, status, headers) {
  return new Response(JSON.stringify(data), { status, headers: { ...headers, 'Content-Type': 'application/json; charset=utf-8' } });
}

function authorized(env, request) {
  const got = (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  return Boolean(env.APP_TOKEN) && got.length > 0 && timingSafeEqual(got, env.APP_TOKEN);
}

async function handle(request, env) {
  const h = cors(env, request);
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: h });
  if (!env.PUSH_KV) return json({ error: 'KVバインディング PUSH_KV が未設定です' }, 500, h);
  const { pathname } = new URL(request.url);

  if (pathname === '/' && request.method === 'GET') {
    return new Response('kiinichi push worker: OK', { headers: { ...h, 'Content-Type': 'text/plain; charset=utf-8' } });
  }
  if (pathname === '/api/vapid-public-key' && request.method === 'GET') {
    return json({ publicKey: (await getVapid(env)).publicKey }, 200, h);
  }

  if (!env.APP_TOKEN) return json({ error: 'シークレット APP_TOKEN が未設定です' }, 500, h);
  if (!authorized(env, request)) return json({ error: '合言葉（APP_TOKEN）が違います' }, 401, h);

  if (pathname === '/api/status' && request.method === 'GET') {
    const sub = await env.PUSH_KV.get('subscription', 'json');
    const store = queueStore(env);
    return json({ subscribed: Boolean(sub), queueStore: store.kind, queue: await store.list() }, 200, h);
  }

  if (pathname === '/api/subscribe' && request.method === 'POST') {
    const sub = await request.json().catch(() => null);
    if (!sub || typeof sub.endpoint !== 'string' || !sub.keys || !sub.keys.p256dh || !sub.keys.auth) {
      return json({ error: '購読情報の形式が正しくありません' }, 400, h);
    }
    if (!/^https:\/\//.test(sub.endpoint)) return json({ error: 'endpoint が https ではありません' }, 400, h);
    await env.PUSH_KV.put('subscription', JSON.stringify({ endpoint: sub.endpoint, keys: sub.keys }));
    return json({ ok: true }, 200, h);
  }

  if (pathname === '/api/send' && request.method === 'POST') {
    const p = await request.json().catch(() => ({}));
    const message = {
      title: String(p.title || 'キィニチくん（検証）').slice(0, 100),
      body: String(p.body || '通知テストだ。タップして開いてみろ。').slice(0, 500),
      url: typeof p.url === 'string' ? p.url.slice(0, 500) : undefined,
    };
    const delay = Math.floor(Number(p.delaySeconds) || 0);
    if (delay > 0) {
      if (delay > MAX_DELAY_SEC) return json({ error: '予約は3日先までです' }, 400, h);
      const store = queueStore(env);
      if ((await store.count()) >= MAX_QUEUE) return json({ error: '予約が多すぎます' }, 429, h);
      const item = { id: crypto.randomUUID(), at: Date.now() + delay * 1000, ...message };
      await store.add(item);
      return json({ ok: true, scheduled: true, id: item.id, at: item.at, queueStore: store.kind }, 200, h);
    }
    const r = await sendPush(env, message);
    return json({ ...r, scheduled: false, at: Date.now() }, r.ok ? 200 : 502, h);
  }

  return json({ error: 'Not found' }, 404, h);
}

export default {
  fetch: (request, env) => handle(request, env),
  scheduled: (event, env, ctx) => ctx.waitUntil(runDue(env)),
};

// テスト用（Workers では使わない）
export const _internal = { encryptPayload, vapidAuthHeader, getVapid, runDue, b64url, unb64url, hkdf, concat };
