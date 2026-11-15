// Worker の検証（Node の WebCrypto で実行）。実際のプッシュサービスには送らず、
// 送信内容を受け取り、ブラウザ側の鍵で復号できること・VAPID署名が正しいことを確かめる。
// 実行: node --test tests/
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import worker, { _internal } from '../worker/worker.js';

// Cloudflare D1 の最小限の偽物（node:sqlite で実際にSQLを実行する）
function makeD1() {
  const db = new DatabaseSync(':memory:');
  const stmt = (sql, args = []) => ({
    bind: (...a) => stmt(sql, a),
    async all() { return { results: db.prepare(sql).all(...args) }; },
    async first() { return db.prepare(sql).get(...args) ?? null; },
    async run() { db.prepare(sql).run(...args); return { success: true }; },
  });
  return { prepare: (sql) => stmt(sql), async batch(list) { return Promise.all(list.map((x) => x.run())); } };
}

const { b64url, unb64url, hkdf, concat } = _internal;
const enc = new TextEncoder();
const dec = new TextDecoder();

function makeKV() {
  const m = new Map();
  return {
    m,
    async get(k, type) { const v = m.get(k); return v === undefined ? null : type === 'json' ? JSON.parse(v) : v; },
    async put(k, v) { m.set(k, v); },
    async delete(k) { m.delete(k); },
  };
}

// ブラウザ（User Agent）役の鍵と購読情報を作る
async function makeBrowser() {
  const pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const pub = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
  const auth = crypto.getRandomValues(new Uint8Array(16));
  return {
    pair, pub, auth,
    subscription: { endpoint: 'https://web.push.apple.com/QXabc123', keys: { p256dh: b64url(pub), auth: b64url(auth) } },
  };
}

// RFC 8291 の復号（ブラウザ側の処理を再現）
async function decrypt(browser, body) {
  const salt = body.slice(0, 16);
  const idlen = body[20];
  const asPublic = body.slice(21, 21 + idlen);
  const cipher = body.slice(21 + idlen);
  const asKey = await crypto.subtle.importKey('raw', asPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const ecdh = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: asKey }, browser.pair.privateKey, 256));
  const ikm = await hkdf(browser.auth, ecdh, concat(enc.encode('WebPush: info\0'), browser.pub, asPublic), 32);
  const cek = await hkdf(salt, ikm, enc.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, enc.encode('Content-Encoding: nonce\0'), 12);
  const key = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['decrypt']);
  const plain = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce }, key, cipher));
  assert.equal(plain[plain.length - 1], 2, '最終レコードの区切りがある');
  return JSON.parse(dec.decode(plain.slice(0, -1)));
}

async function verifyVapid(authHeader, endpoint, vapidPublic) {
  const m = authHeader.match(/^vapid t=([^,]+), k=(.+)$/);
  assert.ok(m, 'vapid t=..., k=... の形式');
  const [h, c, s] = m[1].split('.');
  assert.equal(m[2], vapidPublic);
  const claims = JSON.parse(dec.decode(unb64url(c)));
  assert.equal(claims.aud, new URL(endpoint).origin);
  assert.ok(claims.sub.startsWith('https://') || claims.sub.startsWith('mailto:'));
  assert.ok(claims.exp - Date.now() / 1000 <= 24 * 3600, 'exp は24時間以内');
  const key = await crypto.subtle.importKey('raw', unb64url(vapidPublic), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
  const ok = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, unb64url(s), enc.encode(`${h}.${c}`));
  assert.ok(ok, 'VAPID署名が正しい');
}

const ORIGIN = 'https://kana13914-pixel.github.io';
function req(path, { method = 'GET', token, body } = {}) {
  const headers = { Origin: ORIGIN };
  if (token) headers.Authorization = 'Bearer ' + token;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  return new Request('https://kiinichi.example.workers.dev' + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
}

function setup() {
  const env = { PUSH_KV: makeKV(), APP_TOKEN: 'secret-token-123' };
  const pushes = [];
  globalThis.fetch = async (url, init) => {
    pushes.push({ url, init });
    return new Response('', { status: 201 });
  };
  return { env, pushes };
}

test('VAPID公開鍵は初回に自動生成され、以後同じ値', async () => {
  const { env } = setup();
  const r1 = await (await worker.fetch(req('/api/vapid-public-key'), env)).json();
  const r2 = await (await worker.fetch(req('/api/vapid-public-key'), env)).json();
  assert.equal(unb64url(r1.publicKey).length, 65);
  assert.equal(r1.publicKey, r2.publicKey);
});

test('合言葉なし・違う合言葉は401、未設定は500', async () => {
  const { env } = setup();
  assert.equal((await worker.fetch(req('/api/status'), env)).status, 401);
  assert.equal((await worker.fetch(req('/api/status', { token: 'wrong' }), env)).status, 401);
  assert.equal((await worker.fetch(req('/api/status', { token: 'x' }), { PUSH_KV: makeKV() })).status, 500);
});

test('CORS: 許可したサイトからの事前確認に応答する', async () => {
  const { env } = setup();
  const res = await worker.fetch(req('/api/send', { method: 'OPTIONS' }), env);
  assert.equal(res.status, 204);
  assert.equal(res.headers.get('Access-Control-Allow-Origin'), ORIGIN);
  assert.match(res.headers.get('Access-Control-Allow-Headers'), /Authorization/);
});

test('購読→即時送信：暗号化された本文をブラウザ側の鍵で復号でき、VAPID署名も正しい', async () => {
  const { env, pushes } = setup();
  const browser = await makeBrowser();
  const sub = await worker.fetch(req('/api/subscribe', { method: 'POST', token: env.APP_TOKEN, body: browser.subscription }), env);
  assert.equal(sub.status, 200);
  const res = await worker.fetch(req('/api/send', { method: 'POST', token: env.APP_TOKEN, body: { title: 'タイトル', body: '本文', url: ORIGIN + '/x/app/index.html?source=webpush' } }), env);
  assert.equal(res.status, 200);
  assert.equal(pushes.length, 1);
  const { url, init } = pushes[0];
  assert.equal(url, browser.subscription.endpoint);
  assert.equal(init.headers['Content-Encoding'], 'aes128gcm');
  assert.ok(Number(init.headers.TTL) > 0);
  const msg = await decrypt(browser, init.body);
  assert.deepEqual(msg, { title: 'タイトル', body: '本文', url: ORIGIN + '/x/app/index.html?source=webpush' });
  const vapid = await (await worker.fetch(req('/api/vapid-public-key'), env)).json();
  await verifyVapid(init.headers.Authorization, url, vapid.publicKey);
});

for (const kind of ['d1', 'kv']) {
  test(`予約送信（${kind}）：予定の30秒前より前は送らず、以降のCron実行で1回だけ送る`, async () => {
    const { env, pushes } = setup();
    if (kind === 'd1') env.DB = makeD1();
    const browser = await makeBrowser();
    await worker.fetch(req('/api/subscribe', { method: 'POST', token: env.APP_TOKEN, body: browser.subscription }), env);
    const r = await (await worker.fetch(req('/api/send', { method: 'POST', token: env.APP_TOKEN, body: { delaySeconds: 300 } }), env)).json();
    assert.equal(r.scheduled, true);
    assert.equal(r.queueStore, kind);
    assert.equal(pushes.length, 0);
    const st = await (await worker.fetch(req('/api/status', { token: env.APP_TOKEN }), env)).json();
    assert.equal(st.queue.length, 1);
    assert.deepEqual(await _internal.runDue(env, r.at - 31000), { sent: 0, left: 1 }); // 31秒前はまだ
    assert.deepEqual(await _internal.runDue(env, r.at - 29000), { sent: 1, left: 0 }); // 30秒前以降は送る
    assert.deepEqual(await _internal.runDue(env, r.at + 61000), { sent: 0, left: 0 }); // 二重送信しない
    assert.equal(pushes.length, 1);
    const msg = await decrypt(browser, pushes[0].init.body);
    assert.equal(msg.title, 'キィニチくん（検証）');
  });
}

test('D1：複数の予約は時刻が来たものだけ送り、残りは残す', async () => {
  const { env, pushes } = setup();
  env.DB = makeD1();
  const browser = await makeBrowser();
  await worker.fetch(req('/api/subscribe', { method: 'POST', token: env.APP_TOKEN, body: browser.subscription }), env);
  const a = await (await worker.fetch(req('/api/send', { method: 'POST', token: env.APP_TOKEN, body: { delaySeconds: 60 } }), env)).json();
  await worker.fetch(req('/api/send', { method: 'POST', token: env.APP_TOKEN, body: { delaySeconds: 600 } }), env);
  assert.deepEqual(await _internal.runDue(env, a.at), { sent: 1, left: 1 });
  assert.equal(pushes.length, 1);
});

test('Cron の scheduled ハンドラが予約キューを処理する', async () => {
  const { env, pushes } = setup();
  const browser = await makeBrowser();
  await worker.fetch(req('/api/subscribe', { method: 'POST', token: env.APP_TOKEN, body: browser.subscription }), env);
  await env.PUSH_KV.put('queue', JSON.stringify([{ id: 'a', at: Date.now() - 1, title: 't', body: 'b' }])); // KV代用時
  let p;
  worker.scheduled({}, env, { waitUntil: (x) => { p = x; } });
  await p;
  assert.equal(pushes.length, 1);
});

test('購読がない状態での送信は分かるエラーを返す', async () => {
  const { env } = setup();
  const res = await worker.fetch(req('/api/send', { method: 'POST', token: env.APP_TOKEN, body: {} }), env);
  assert.equal(res.status, 502);
  assert.match((await res.json()).error, /購読がありません/);
});

test('プッシュサービスが410を返したら購読を消す', async () => {
  const { env } = setup();
  const browser = await makeBrowser();
  await worker.fetch(req('/api/subscribe', { method: 'POST', token: env.APP_TOKEN, body: browser.subscription }), env);
  globalThis.fetch = async () => new Response('gone', { status: 410 });
  await worker.fetch(req('/api/send', { method: 'POST', token: env.APP_TOKEN, body: {} }), env);
  assert.equal(await env.PUSH_KV.get('subscription'), null);
});

test('不正な購読情報・3日超の予約は拒否する', async () => {
  const { env } = setup();
  assert.equal((await worker.fetch(req('/api/subscribe', { method: 'POST', token: env.APP_TOKEN, body: { endpoint: 'http://x' } }), env)).status, 400);
  assert.equal((await worker.fetch(req('/api/send', { method: 'POST', token: env.APP_TOKEN, body: { delaySeconds: 4 * 86400 } }), env)).status, 400);
});

for (const kind of ['d1', 'kv']) {
  test(`キー付きの予約（${kind}）：同じキーは上書きし、取り消すと届かない（D-015）`, async () => {
    const { env, pushes } = setup();
    if (kind === 'd1') env.DB = makeD1();
    const browser = await makeBrowser();
    const post = (path, body) => worker.fetch(req(path, { method: 'POST', token: env.APP_TOKEN, body }), env);
    await post('/api/subscribe', browser.subscription);
    const at = Date.now() + 5 * 60000;
    const r1 = await (await post('/api/schedule', { key: 'timer', at, body: '一回目', url: ORIGIN + '/x' })).json();
    assert.deepEqual([r1.ok, r1.key, r1.at, r1.queueStore], [true, 'timer', at, kind]);
    await post('/api/schedule', { key: 'timer', at: at + 60000, body: '二回目' }); // 上書き
    await post('/api/schedule', { key: 'meal_check:2026-11-07', at, body: '別のキー' });
    let st = await (await worker.fetch(req('/api/status', { token: env.APP_TOKEN }), env)).json();
    assert.deepEqual(st.queue.map((q) => q.id).sort(), ['key:meal_check:2026-11-07', 'key:timer']);
    // 取り消し：あれば 1、なければ 0
    assert.equal((await (await post('/api/cancel', { key: 'meal_check:2026-11-07' })).json()).removed, 1);
    assert.equal((await (await post('/api/cancel', { key: 'meal_check:2026-11-07' })).json()).removed, 0);
    assert.deepEqual(await _internal.runDue(env, at + 29000), { sent: 0, left: 1 }); // 上書き前の時刻（at）では送らない。新しい時刻の30秒前から送る
    assert.deepEqual(await _internal.runDue(env, at + 30000), { sent: 1, left: 0 });
    assert.equal(pushes.length, 1);
    const msg = await decrypt(browser, pushes[0].init.body);
    assert.deepEqual([msg.title, msg.body], ['キィニチ', '二回目']);
    // 取り消したものは届かない
    await post('/api/schedule', { key: 'timer', at: Date.now() + 60000, body: '三回目' });
    await post('/api/cancel', { key: 'timer' });
    assert.deepEqual(await _internal.runDue(env, Date.now() + 10 * 60000), { sent: 0, left: 0 });
    assert.equal(pushes.length, 1);
  });
}

test('キー付きの予約：notBefore は予定時刻より前に送らない（タイマーの終了）', async () => {
  const { env, pushes } = setup();
  env.DB = makeD1();
  const browser = await makeBrowser();
  const post = (path, body) => worker.fetch(req(path, { method: 'POST', token: env.APP_TOKEN, body }), env);
  await post('/api/subscribe', browser.subscription);
  const at = Date.now() + 3 * 60000;
  assert.equal((await post('/api/schedule', { key: 'timer', at, notBefore: true, body: '時間だ。' })).status, 200);
  assert.deepEqual(await _internal.runDue(env, at - 1000), { sent: 0, left: 1 }); // 1秒前でも送らない
  assert.deepEqual(await _internal.runDue(env, at), { sent: 1, left: 0 });
  assert.equal(pushes.length, 1);
});

test('キー付きの予約：合言葉が必要で、不正な入力は拒否する', async () => {
  const { env } = setup();
  const post = (body, token = env.APP_TOKEN) => worker.fetch(req('/api/schedule', { method: 'POST', token, body }), env);
  const at = Date.now() + 60000;
  assert.equal((await post({ key: 'timer', at, body: 'x' }, 'wrong')).status, 401);
  assert.equal((await post({ at, body: 'x' })).status, 400); // キーなし
  assert.equal((await post({ key: 'a b', at, body: 'x' })).status, 400); // 使えない文字
  assert.equal((await post({ key: 'timer', at: Date.now() - 1, body: 'x' })).status, 400); // 過去
  assert.equal((await post({ key: 'timer', body: 'x' })).status, 400); // 時刻なし
  assert.equal((await post({ key: 'timer', at: Date.now() + 4 * 86400000, body: 'x' })).status, 400); // 3日超
  assert.equal((await post({ key: 'timer', at })).status, 400); // 本文なし
  assert.equal((await worker.fetch(req('/api/cancel', { method: 'POST', token: env.APP_TOKEN, body: {} }), env)).status, 400);
});

// ---- 送れなかったときの扱い（D-033） ----
async function scheduled2(kind) {
  const { env, pushes } = setup();
  if (kind === 'd1') env.DB = makeD1();
  const browser = await makeBrowser();
  const post = (path, body) => worker.fetch(req(path, { method: 'POST', token: env.APP_TOKEN, body }), env);
  await post('/api/subscribe', browser.subscription);
  const at = Date.now() + 5 * 60000;
  await post('/api/schedule', { key: 'meal_check:2026-11-07', at, body: 'A' });
  await post('/api/schedule', { key: 'timer', at: at + 1000, body: 'B' });
  const status = async () => (await worker.fetch(req('/api/status', { token: env.APP_TOKEN }), env)).json();
  return { env, pushes, post, at, status, browser };
}

for (const kind of ['d1', 'kv']) {
  test(`送信の一時的な失敗（${kind}）：予約を残して次の分にやり直し、3分を過ぎたらあきらめる`, async () => {
    const { env, at, status } = await scheduled2(kind);
    globalThis.fetch = async () => new Response('busy', { status: 503 });
    assert.deepEqual(await _internal.runDue(env, at), { sent: 0, left: 2 });
    assert.deepEqual(await _internal.runDue(env, at + 60000), { sent: 0, left: 2 });
    let ok = 0;
    globalThis.fetch = async () => { ok++; return new Response('', { status: 201 }); };
    assert.deepEqual(await _internal.runDue(env, at + 120000), { sent: 2, left: 0 }); // 回復したら届く
    assert.equal(ok, 2);
    // 3分を過ぎても送れなければ捨てる（何時間も後に「時間だ」が届かないように）
    const s2 = await scheduled2(kind);
    globalThis.fetch = async () => new Response('busy', { status: 503 });
    assert.deepEqual(await _internal.runDue(s2.env, s2.at + 4 * 60000), { sent: 0, left: 0 });
    if (kind === 'd1') {
      const st = await status();
      assert.deepEqual(st.recent.map((x) => x.result.split(':')[0]).sort(), ['retry', 'retry', 'retry', 'retry', 'sent', 'sent']);
    }
  });
}

test('送信中の例外：1件目で通信エラーになっても、2件目を送る。1件目はやり直す', async () => {
  const { env, at } = await scheduled2('d1');
  let n = 0;
  globalThis.fetch = async () => { if (n++ === 0) throw new TypeError('network error'); return new Response('', { status: 201 }); };
  assert.deepEqual(await _internal.runDue(env, at + 1000), { sent: 1, left: 1 });
  assert.deepEqual(await _internal.runDue(env, at + 61000), { sent: 1, left: 0 });
});

test('やり直しの間に同じキーで予約し直したら、新しい予約を残す', async () => {
  const { env, at, post, status } = await scheduled2('d1');
  await post('/api/cancel', { key: 'meal_check:2026-11-07' });
  const realStore = env.DB;
  // 送信に失敗している最中に、アプリが同じキー timer を予約し直した状況を作る
  globalThis.fetch = async () => {
    await realStore.prepare('INSERT OR REPLACE INTO queue (id, at, title, body, url) VALUES (?, ?, ?, ?, ?)').bind('key:timer', at + 600000, 't', '新しい', null).run();
    return new Response('busy', { status: 503 });
  };
  await _internal.runDue(env, at + 1000);
  const st = await status();
  assert.deepEqual(st.queue.map((q) => [q.id, q.at]), [['key:timer', at + 600000]]);
});

test('購読切れ（410）や購読なしは、やり直さずに捨てる', async () => {
  const { env, at, status } = await scheduled2('d1');
  globalThis.fetch = async () => new Response('gone', { status: 410 });
  assert.deepEqual(await _internal.runDue(env, at + 1000), { sent: 0, left: 0 });
  const st = await status();
  assert.equal(st.subscribed, false);
  assert.ok(st.recent.every((x) => x.result.startsWith('dropped')));
});

test('予約の応答に購読の有無が入る（購読がなければアプリが登録し直せる）', async () => {
  const { env } = setup();
  const post = (path, body) => worker.fetch(req(path, { method: 'POST', token: env.APP_TOKEN, body }), env);
  const at = Date.now() + 60000;
  assert.equal((await (await post('/api/schedule', { key: 'timer', at, body: 'x' })).json()).subscribed, false);
  await post('/api/subscribe', (await makeBrowser()).subscription);
  assert.equal((await (await post('/api/schedule', { key: 'timer', at, body: 'x' })).json()).subscribed, true);
});

test('通知の種類（tag）：キー付きの予約はキーの種類、それ以外は付けない', async () => {
  const { env, pushes, at, browser } = await scheduled2('d1');
  await worker.fetch(req('/api/send', { method: 'POST', token: env.APP_TOKEN, body: { delaySeconds: 60 } }), env);
  await _internal.runDue(env, at + 1000);
  const tags = [];
  for (const p of pushes) tags.push((await decrypt(browser, p.init.body)).tag);
  assert.deepEqual(tags.map(String).sort(), ['meal_check', 'timer', 'undefined']);
});

test('内部で失敗しても、理由つきの応答（500・CORSつき）を返す', async () => {
  const { env } = setup();
  env.DB = { prepare: () => { throw new Error('D1_ERROR: quota'); }, batch: async () => { throw new Error('D1_ERROR: quota'); } };
  const res = await worker.fetch(req('/api/schedule', { method: 'POST', token: env.APP_TOKEN, body: { key: 'timer', at: Date.now() + 60000, body: 'x' } }), env);
  assert.equal(res.status, 500);
  assert.equal(res.headers.get('Access-Control-Allow-Origin'), ORIGIN);
  assert.match((await res.json()).error, /内部エラー.*D1_ERROR/);
  // 本文が JSON の null でも 400 で返す
  const { env: env2 } = setup();
  assert.equal((await worker.fetch(req('/api/schedule', { method: 'POST', token: env2.APP_TOKEN, body: null }), env2)).status, 400);
});
