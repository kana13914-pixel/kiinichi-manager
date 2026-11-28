// Service Worker の push / notificationclick 処理の検証。sw.js を偽の self の上で実行する。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const SCOPE = 'https://kana13914-pixel.github.io/x/app/';

function loadSw({ windows = [], fetchImpl = () => {}, cachesImpl = {}, timers = {} } = {}) {
  const handlers = {};
  const shown = [];
  const opened = [];
  const self = {
    location: new URL(SCOPE + 'sw.js'),
    registration: { scope: SCOPE, showNotification: async (title, opts) => { shown.push({ title, opts }); } },
    clients: {
      matchAll: async () => windows,
      openWindow: async (url) => { opened.push(url); },
      claim: () => {},
    },
    skipWaiting: () => {},
    addEventListener: (type, fn) => { handlers[type] = fn; },
  };
  vm.runInNewContext(readFileSync(new URL('../app/sw.js', import.meta.url), 'utf8'), { self, caches: cachesImpl, fetch: fetchImpl, URL, Request, setTimeout: timers.setTimeout || setTimeout, clearTimeout });
  return { handlers, shown, opened };
}

function fire(handler, event) {
  let p;
  handler({ ...event, waitUntil: (x) => { p = x; } });
  return p;
}

test('push を受けたらタイトル・本文・タップ先URLつきで通知を出す', async () => {
  const { handlers, shown } = loadSw();
  const payload = { title: 'キィニチくん（検証）', body: '本文', url: SCOPE + 'index.html?source=webpush' };
  await fire(handlers.push, { data: { json: () => payload, text: () => JSON.stringify(payload) } });
  assert.equal(shown.length, 1);
  assert.equal(shown[0].title, 'キィニチくん（検証）');
  assert.equal(shown[0].opts.body, '本文');
  assert.equal(shown[0].opts.data.url, payload.url);
});

test('URLなしの push でも index.html?source=webpush を開く設定になる', async () => {
  const { handlers, shown } = loadSw();
  await fire(handlers.push, { data: { json: () => ({ title: 't' }) } });
  assert.equal(shown[0].opts.data.url, SCOPE + 'index.html?source=webpush');
});

test('通知タップ：開いている画面がなければ新しく開く', async () => {
  const { handlers, opened } = loadSw();
  let closed = false;
  await fire(handlers.notificationclick, { notification: { close: () => { closed = true; }, data: { url: SCOPE + 'index.html?source=webpush' } } });
  assert.ok(closed);
  assert.deepEqual(opened, [SCOPE + 'index.html?source=webpush']);
});

test('通知タップ：開いている画面があれば前面に出して移動する', async () => {
  const calls = [];
  const win = { focus: async () => calls.push('focus'), navigate: async (u) => calls.push('navigate ' + u) };
  const { handlers, opened } = loadSw({ windows: [win] });
  await fire(handlers.notificationclick, { notification: { close() {}, data: { url: SCOPE + 'index.html?source=webpush' } } });
  assert.deepEqual(calls, ['focus', 'navigate ' + SCOPE + 'index.html?source=webpush']);
  assert.deepEqual(opened, []);
});

test('同じサイトのファイルは毎回サーバーに更新を確認して取得する（古い版を出さない）', async () => {
  const calls = [];
  const put = [];
  const fetchImpl = async (url, init) => { calls.push({ url, init }); return { ok: true, clone() { return this; } }; };
  const cachesImpl = { open: async () => ({ put: (req, res) => put.push(req) }), match: async () => null };
  const { handlers } = loadSw({ fetchImpl, cachesImpl });
  let responded;
  handlers.fetch({ request: { method: 'GET', url: SCOPE + 'app.js' }, respondWith: (p) => { responded = p; } });
  await responded;
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, SCOPE + 'app.js');
  assert.equal(calls[0].init.cache, 'no-cache');
});

test('外部（送信サーバー）へのリクエストには手を出さない', () => {
  let responded = false;
  const { handlers } = loadSw();
  handlers.fetch({ request: { method: 'GET', url: 'https://kiinichi-push.example.workers.dev/api/status' }, respondWith: () => { responded = true; } });
  assert.equal(responded, false);
});

test('通知タップ：navigate が例外なら、画面に URL を postMessage で渡す', async () => {
  const sent = [];
  const win = { focus: async () => {}, navigate: async () => { throw new Error('not allowed'); }, postMessage: (m) => sent.push(m) };
  const { handlers, opened } = loadSw({ windows: [win] });
  await fire(handlers.notificationclick, { notification: { close() {}, data: { url: SCOPE + 'index.html?source=webpush&trigger=a.b&line=0' } } });
  assert.deepEqual(JSON.parse(JSON.stringify(sent)), [{ type: 'open-url', url: SCOPE + 'index.html?source=webpush&trigger=a.b&line=0' }]);
  assert.deepEqual(opened, []);
});

test('通知タップ：navigate が null なら、画面に URL を postMessage で渡す', async () => {
  const sent = [];
  const win = { focus: async () => {}, navigate: async () => null, postMessage: (m) => sent.push(m) };
  const { handlers } = loadSw({ windows: [win] });
  await fire(handlers.notificationclick, { notification: { close() {}, data: { url: SCOPE + 'index.html?source=webpush' } } });
  assert.deepEqual(JSON.parse(JSON.stringify(sent)), [{ type: 'open-url', url: SCOPE + 'index.html?source=webpush' }]);
});

test('回線が極端に遅いときは、待たずにキャッシュを返し、遅れて届いた応答はキャッシュに入れる（D-033）', async () => {
  const put = [];
  let arrive;
  const fetchImpl = () => new Promise((resolve) => { arrive = () => resolve({ ok: true, clone() { return this; } }); });
  const cachesImpl = { open: async () => ({ put: (req) => put.push(req) }), match: async () => 'CACHED' };
  let timeout;
  const timers = { setTimeout: (fn, ms) => { timeout = { fn, ms }; return 1; } };
  const { handlers } = loadSw({ fetchImpl, cachesImpl, timers });
  let responded, kept;
  handlers.fetch({ request: { method: 'GET', url: SCOPE + 'app.js' }, respondWith: (p) => { responded = p; }, waitUntil: (p) => { kept = p; } });
  assert.ok(timeout.ms >= 2000 && timeout.ms <= 3000, '待つのは2〜3秒');
  timeout.fn(); // 時間切れ
  assert.equal(await responded, 'CACHED');
  arrive(); // 遅れて届く
  await kept;
  await new Promise((r) => setImmediate(r));
  assert.equal(put.length, 1);
});

test('回線が遅くてもキャッシュにないファイルは、ネットワークの応答を待つ', async () => {
  let arrive;
  const res = { ok: true, clone() { return this; } };
  const fetchImpl = () => new Promise((resolve) => { arrive = () => resolve(res); });
  const cachesImpl = { open: async () => ({ put() {} }), match: async () => undefined };
  let timeout;
  const { handlers } = loadSw({ fetchImpl, cachesImpl, timers: { setTimeout: (fn) => { timeout = fn; return 1; } } });
  let responded;
  handlers.fetch({ request: { method: 'GET', url: SCOPE + 'new.js' }, respondWith: (p) => { responded = p; } });
  timeout();
  await new Promise((r) => setImmediate(r));
  arrive();
  assert.equal(await responded, res);
});

test('通信できないときはキャッシュを返す', async () => {
  const fetchImpl = async () => { throw new TypeError('offline'); };
  const cachesImpl = { open: async () => ({ put() {} }), match: async () => 'CACHED' };
  const { handlers } = loadSw({ fetchImpl, cachesImpl });
  let responded;
  handlers.fetch({ request: { method: 'GET', url: SCOPE + 'app.js' }, respondWith: (p) => { responded = p; } });
  assert.equal(await responded, 'CACHED');
});

test('アプリの外の URL が届いても、通知はアプリのホームを開く設定になる（D-075）', async () => {
  const { handlers, shown } = loadSw();
  const outside = [
    'https://evil.example/login',
    'https://kana13914-pixel.github.io/other-repo/index.html',
    SCOPE + '../../other/index.html',
    'javascript:alert(1)',
    'http://kana13914-pixel.github.io/x/app/index.html',
  ];
  for (const url of outside) await fire(handlers.push, { data: { json: () => ({ title: 't', body: 'b', url }) } });
  assert.deepEqual(shown.map((x) => x.opts.data.url), outside.map(() => SCOPE + 'index.html?source=webpush'));
});

test('アプリの中の URL は、そのまま開く（相対の書き方も scope の下として読む）', async () => {
  const { handlers, shown } = loadSw();
  await fire(handlers.push, { data: { json: () => ({ title: 't', url: SCOPE + 'index.html?source=webpush&trigger=timer_done.work&line=0#timer' }) } });
  await fire(handlers.push, { data: { json: () => ({ title: 't', url: 'index.html?source=webpush#timer' }) } });
  assert.deepEqual(shown.map((x) => x.opts.data.url), [
    SCOPE + 'index.html?source=webpush&trigger=timer_done.work&line=0#timer',
    SCOPE + 'index.html?source=webpush#timer',
  ]);
});

test('通知タップ：通知に残っている URL がアプリの外なら、アプリのホームを開く（D-075）', async () => {
  const { handlers, opened } = loadSw();
  await fire(handlers.notificationclick, { notification: { close() {}, data: { url: 'https://evil.example/' } } });
  const calls = [];
  const win = { focus: async () => {}, navigate: async (u) => { calls.push(u); return {}; } };
  const second = loadSw({ windows: [win] });
  await fire(second.handlers.notificationclick, { notification: { close() {}, data: { url: 'https://evil.example/' } } });
  assert.deepEqual(opened, [SCOPE + 'index.html?source=webpush']);
  assert.deepEqual(calls, [SCOPE + 'index.html?source=webpush']);
});

test('通知の種類（tag）：届いた種類を使い、なければ共通の名前（D-033）', async () => {
  const { handlers, shown } = loadSw();
  await fire(handlers.push, { data: { json: () => ({ title: 't', body: 'b', tag: 'timer' }) } });
  await fire(handlers.push, { data: { json: () => ({ title: 't', body: 'b' }) } });
  assert.deepEqual(shown.map((x) => x.opts.tag), ['timer', 'kiinichi']);
});
