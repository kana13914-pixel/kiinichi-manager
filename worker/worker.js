// キィニチくん専属マネージャー：Web Push 送信サーバー（Cloudflare Workers）
//
// ・Cloudflare ダッシュボードの「コードを編集」にこのファイルの中身を丸ごと貼り付けて使う（外部ライブラリなし）
// ・必要な設定（手順は docs/cloudflare_setup.md）
//     KV バインディング   PUSH_KV        … 購読情報・VAPID鍵の保存先
//     D1 バインディング   DB             … 予約キューの保存先（強い整合性。未設定ならKVで代用するが遅れやすい）
//     シークレット         APP_TOKEN      … PWA/送信ページが送る合言葉。コードやリポジトリには書かない
//     変数（任意）         ALLOWED_ORIGIN … 呼び出しを許すサイト（既定 https://kana13914-pixel.github.io）
//     シークレット（任意） ANTHROPIC_API_KEY … 週次コメント（/api/weekly。D-058）で Claude を呼ぶための鍵。なければ週次コメントは使えない
//     Cron Trigger         * * * * *      … 毎分、予約キューを確認して時刻が来たものを送る
// ・VAPID 鍵は初回アクセス時に自動生成して KV に保存する（人間が鍵を扱わなくて済むように）
// ・Web Push の暗号化は RFC 8291（aes128gcm）、認証は RFC 8292（VAPID）に従う

const DEFAULT_ORIGIN = 'https://kana13914-pixel.github.io';
const VAPID_SUBJECT = 'https://kana13914-pixel.github.io/';
const MAX_DELAY_SEC = 3 * 24 * 3600; // 予約は3日先まで
const MAX_QUEUE = 50;
// Cronは毎分。予定時刻の30秒前から送ることで、ずれを概ね±30秒に収める（完了条件は±60秒）
const EARLY_MS = 30 * 1000;
// 送れなかった予約は、予定時刻からこの時間までは次の分にやり直す（毎分の確認で2〜3回。D-033）
const RETRY_MS = 3 * 60 * 1000;
const LOG_KEEP = 20; // 送信結果を残す件数（届かなかった理由を後から確かめるため）

// ---------- 週次コメント（D-058）：1週間の日報と記録から、キィニチの短い振り返りを Claude に書いてもらう ----------
// 鍵は Cloudflare のシークレットにだけ置く（アプリには置かない。CLAUDE.md）。費用を抑えるため：同じ週は1回だけ作って KV に控える、
// 月に WEEKLY_MONTHLY_MAX 回まで、送る量は WEEKLY_MAX_INPUT 文字まで。Anthropic の管理画面の月の上限（$5）とは別の歯止め
// このファイルは1つを貼り付けて使う（ライブラリを読み込めない）ので、Claude API は公式の HTTP の形（/v1/messages）で直接呼ぶ
const CLAUDE_MODEL = 'claude-opus-5-5';
const WEEKLY_MONTHLY_MAX = 8;
const WEEKLY_MAX_INPUT = 12000;
const WEEKLY_SYSTEM = [
  'あなたは「キィニチ」というキャラクターとして、利用者の1週間を振り返る短いコメントを書く。関係は上司くらいの温度感。',
  '話し方：短く言い切る。語尾は「〜だな」「〜しておけ」「〜か」「〜ぞ」など。敬語は使わない。一人称は使わない。',
  '守ること：',
  '- 渡された日報と記録に書いてあることだけを根拠にする。書いていないことを知っているように言わない。',
  '- 過剰に褒めない。励まし続けない。よかった点は1つまで、短く。',
  '- 疲れている日が多ければ、無理をさせない。休むよう促してよいが、決めるのは本人に任せる。',
  '- 「〜すべきだ」と断定せず、提案にとどめる。次の週に試せることを1つだけ添える。',
  '- 返事を求める問いかけで終わらない。',
  '- 3〜5文、全体で200字くらいまで。見出し・箇条書き・絵文字・記号の飾りは使わない。本文だけを書く。',
].join('\n');

async function weeklyComment(env, p) {
  const week = typeof p.week === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(p.week) ? p.week : null;
  if (!week) return { status: 400, body: { error: 'week（週の初めの日付）の形式が正しくありません' } };
  const input = typeof p.summary === 'string' ? p.summary.trim() : '';
  if (!input) return { status: 400, body: { error: 'summary（1週間のまとめ）がありません' } };
  if (input.length > WEEKLY_MAX_INPUT) return { status: 400, body: { error: 'summary が長すぎます' } };
  const saved = await env.PUSH_KV.get('weekly:' + week, 'json');
  if (saved) return { status: 200, body: { ok: true, week, text: saved.text, cached: true } }; // 同じ週はもう作らない
  if (!env.ANTHROPIC_API_KEY) return { status: 503, body: { error: '週次コメントの準備ができていません（シークレット ANTHROPIC_API_KEY が未設定です）' } };
  const month = new Date().toISOString().slice(0, 7);
  const used = Number(await env.PUSH_KV.get('weekly-count:' + month)) || 0;
  if (used >= WEEKLY_MONTHLY_MAX) return { status: 429, body: { error: '今月の週次コメントの回数の上限に達しました' } };
  await env.PUSH_KV.put('weekly-count:' + month, String(used + 1), { expirationTtl: 40 * 24 * 3600 }); // 失敗しても数える（呼びすぎ防止）
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': '2026-10-21',
      'anthropic-beta': 'server-side-fallback-2026-07-01', // 安全の判定で断られたら、別のモデルで書き直してもらう
    },
    body: JSON.stringify({
      model: CLAUDE_MODEL,
      max_tokens: 16000,
      output_config: { effort: 'medium' },
      fallbacks: 'default',
      system: WEEKLY_SYSTEM,
      messages: [{ role: 'user', content: `${week} から始まる1週間の記録です。これを読んで、振り返りのコメントを書いてください。\n\n${input}` }],
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) return { status: 502, body: { error: 'Claude を呼べませんでした（' + (data.error && data.error.message ? String(data.error.message).slice(0, 200) : 'HTTP ' + res.status) + '）' } };
  if (data.stop_reason === 'refusal') return { status: 502, body: { error: '週次コメントを作れませんでした（断られました）' } };
  const text = (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
  if (!text) return { status: 502, body: { error: '週次コメントが空でした' } };
  await env.PUSH_KV.put('weekly:' + week, JSON.stringify({ text, at: Date.now(), model: data.model || CLAUDE_MODEL }), { expirationTtl: 400 * 24 * 3600 });
  return { status: 200, body: { ok: true, week, text, cached: false } };
}

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
const D1_LOG = 'CREATE TABLE IF NOT EXISTS sendlog (n INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, id TEXT, status INTEGER, result TEXT)';

function queueStore(env) {
  if (env.DB) {
    let ready;
    const init = () => (ready ||= env.DB.batch([env.DB.prepare(D1_SCHEMA), env.DB.prepare(D1_INDEX), env.DB.prepare(D1_LOG)]));
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
      // 同じ id があれば置き換える（キー付きの予約の上書き。D-015）
      async add(item) {
        await init();
        await env.DB.prepare('INSERT OR REPLACE INTO queue (id, at, title, body, url) VALUES (?, ?, ?, ?, ?)')
          .bind(item.id, item.at, item.title, item.body, item.url ?? null).run();
      },
      // 送れなかったものを戻す。その間に同じ id で新しい予約が入っていたら、新しいほうを残す
      async putBack(item) {
        await init();
        await env.DB.prepare('INSERT OR IGNORE INTO queue (id, at, title, body, url) VALUES (?, ?, ?, ?, ?)')
          .bind(item.id, item.at, item.title, item.body, item.url ?? null).run();
      },
      async remove(id) {
        await init();
        return (await env.DB.prepare('DELETE FROM queue WHERE id = ? RETURNING id').bind(id).all()).results.length;
      },
      // 送信結果の記録（新しい LOG_KEEP 件だけ残す）
      async log(entry) {
        await init();
        await env.DB.batch([
          env.DB.prepare('INSERT INTO sendlog (at, id, status, result) VALUES (?, ?, ?, ?)').bind(entry.at, entry.id, entry.status, entry.result),
          env.DB.prepare('DELETE FROM sendlog WHERE n NOT IN (SELECT n FROM sendlog ORDER BY n DESC LIMIT ?)').bind(LOG_KEEP),
        ]);
      },
      async recent() {
        await init();
        return (await env.DB.prepare('SELECT at, id, status, result FROM sendlog ORDER BY n DESC LIMIT ?').bind(LOG_KEEP).all()).results;
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
      const queue = ((await env.PUSH_KV.get('queue', 'json')) || []).filter((q) => q.id !== item.id);
      queue.push(item);
      await env.PUSH_KV.put('queue', JSON.stringify(queue));
    },
    async putBack(item) {
      const queue = (await env.PUSH_KV.get('queue', 'json')) || [];
      if (queue.some((q) => q.id === item.id)) return;
      queue.push(item);
      await env.PUSH_KV.put('queue', JSON.stringify(queue));
    },
    // KV は書き込み回数の無料枠が小さいので、送信結果は残さない
    async log() {},
    async recent() { return []; },
    async remove(id) {
      const queue = (await env.PUSH_KV.get('queue', 'json')) || [];
      const rest = queue.filter((q) => q.id !== id);
      if (rest.length !== queue.length) await env.PUSH_KV.put('queue', JSON.stringify(rest));
      return queue.length - rest.length;
    },
    async takeDue(until) {
      const queue = (await env.PUSH_KV.get('queue', 'json')) || [];
      const due = queue.filter((q) => q.at <= until);
      if (due.length) await env.PUSH_KV.put('queue', JSON.stringify(queue.filter((q) => q.at > until)));
      return due;
    },
  };
}

// キー付きの予約の id。/api/send の予約（ランダムな id）と重ならないように接頭辞を付ける
function keyId(key) {
  return typeof key === 'string' && /^[\w:.-]{1,100}$/.test(key) ? 'key:' + key : null;
}

// 通知をまとめる名前。キー付きの予約は種類（キーの最初の : より前。例 meal_check:2026-11-07 → meal_check）。
// 同じ種類の通知は新しいもので置き換わり、違う種類は並んで残る（app/sw.js）
function tagOf(id) {
  return typeof id === 'string' && id.startsWith('key:') ? id.slice(4).split(':')[0] : undefined;
}

// 一時的な失敗（通信エラー・混雑・プッシュサービス側の障害）だけやり直す。購読なし・購読切れ・形式の誤りはやり直しても届かない
function isTemporary(r) {
  return r.threw === true || r.status === 429 || r.status >= 500;
}

async function runDue(env, now = Date.now()) {
  const store = queueStore(env);
  const due = await store.takeDue(now + EARLY_MS);
  let sent = 0;
  for (const item of due) {
    // 1件の失敗でほかの予約を巻き込まないよう、1件ずつ受け止める
    let r;
    try {
      r = await sendPush(env, { title: item.title, body: item.body, url: item.url || undefined, tag: tagOf(item.id) });
    } catch (e) {
      r = { ok: false, status: 0, threw: true, error: String((e && e.message) || e).slice(0, 300) };
    }
    let result = 'sent';
    if (r.ok) {
      sent++;
    } else if (isTemporary(r) && now < item.at + RETRY_MS) {
      result = 'retry';
      await store.putBack(item).catch(() => {});
    } else {
      result = 'dropped';
    }
    await store.log({ at: now, id: item.id, status: r.status, result: r.ok ? result : `${result}: ${r.error || ''}`.slice(0, 200) }).catch(() => {});
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
    return json({ subscribed: Boolean(sub), queueStore: store.kind, queue: await store.list(), recent: await store.recent() }, 200, h);
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
    const p = (await request.json().catch(() => null)) || {};
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

  // キー付きの予約（D-015）。同じキーは上書きする。PWA が予約・更新・取り消しを行い、サーバーは時刻が来たら送るだけ
  //   key        … 種類を表す名前（例 timer）。英数字と : . _ - のみ
  //   at         … 送る時刻（1970年からのミリ秒）
  //   応答の subscribed … false なら購読がなく、予約しても届かない
//   notBefore  … true なら予定時刻より前には送らない（タイマーの終了など。届くのは予定時刻〜約60秒後）
  if (pathname === '/api/schedule' && request.method === 'POST') {
    const p = (await request.json().catch(() => null)) || {};
    const id = keyId(p.key);
    if (!id) return json({ error: 'key の形式が正しくありません' }, 400, h);
    const now = Date.now();
    const at = Math.floor(Number(p.at));
    if (!Number.isFinite(at) || at <= now) return json({ error: 'at（送る時刻）が過去か、数値ではありません' }, 400, h);
    if (at > now + MAX_DELAY_SEC * 1000) return json({ error: '予約は3日先までです' }, 400, h);
    if (typeof p.body !== 'string' || !p.body) return json({ error: 'body（通知の本文）がありません' }, 400, h);
    const store = queueStore(env);
    await store.remove(id); // 数の上限を確かめる前に、置き換えられる分を除く
    if ((await store.count()) >= MAX_QUEUE) return json({ error: '予約が多すぎます' }, 429, h);
    const item = {
      id,
      at: at + (p.notBefore === true ? EARLY_MS : 0), // Cron は at の30秒前から送るので、その分だけ後ろにずらす
      title: String(p.title || 'キィニチ').slice(0, 100),
      body: p.body.slice(0, 500),
      url: typeof p.url === 'string' ? p.url.slice(0, 500) : undefined,
    };
    await store.add(item);
    // 購読がなければ予約しても届かないので、アプリが気づけるように返す（D-033）
    const subscribed = Boolean(await env.PUSH_KV.get('subscription', 'json'));
    return json({ ok: true, key: p.key, at, queueStore: store.kind, subscribed }, 200, h);
  }

  if (pathname === '/api/weekly' && request.method === 'POST') {
    const p = (await request.json().catch(() => null)) || {};
    const r = await weeklyComment(env, p);
    return json(r.body, r.status, h);
  }

  if (pathname === '/api/cancel' && request.method === 'POST') {
    const p = (await request.json().catch(() => null)) || {};
    const id = keyId(p.key);
    if (!id) return json({ error: 'key の形式が正しくありません' }, 400, h);
    return json({ ok: true, key: p.key, removed: await queueStore(env).remove(id) }, 200, h);
  }

  return json({ error: 'Not found' }, 404, h);
}

export default {
  // 途中で失敗しても、理由が分かる応答を返す（そのまま外に出すと、アプリには「Failed to fetch」としか伝わらない）
  fetch: async (request, env) => {
    try {
      return await handle(request, env);
    } catch (e) {
      return json({ error: '送信サーバーの内部エラー: ' + String((e && e.message) || e).slice(0, 200) }, 500, cors(env, request));
    }
  },
  scheduled: (event, env, ctx) => ctx.waitUntil(runDue(env)),
};

// テスト用（Workers では使わない）
export const _internal = { encryptPayload, vapidAuthHeader, getVapid, runDue, b64url, unb64url, hkdf, concat };
