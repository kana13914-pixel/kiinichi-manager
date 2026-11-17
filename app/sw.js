// Service Worker。オフラインでも画面が開けるよう静的ファイルをキャッシュし、通知の表示とタップを受け持つ。
// ファイルを更新したら CACHE_VERSION を上げること（古いキャッシュが残るのを防ぐ）。
const CACHE_VERSION = 'phase2-v3';
const ASSETS = [
  './',
  './index.html',
  './util.js',
  './dialogue.js',
  './ui.js',
  './app.js',
  './tasks.js',
  './report.js',
  './timer.js',
  './schedule.js',
  './style.css',
  './img/canopy-emblem.svg',
  './img/canopy-vines.svg',
  './img/fret.svg',
  './img/grain.svg',
  './manifest.webmanifest',
  './icons/icon-180.png',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './send.html',
  './send.js',
  './settings.js',
  './sample-data.js',
  './data/dialogue.json',
];

self.addEventListener('install', (event) => {
  // cache:'reload' … ブラウザの一時保存を使わず、必ずサーバーから最新を取る
  event.waitUntil(caches.open(CACHE_VERSION).then((c) => c.addAll(ASSETS.map((u) => new Request(u, { cache: 'reload' })))));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// ネットワーク優先、失敗時はキャッシュ。応答が NETWORK_WAIT_MS 以内に来なければ、待たずにキャッシュを返す
// （つながってはいるが極端に遅い回線で、起動が止まったように見えるのを防ぐ。D-033）。
// 遅れて届いた応答はキャッシュに入れるので、次に開いたときは新しい版になる。
// cache:'no-cache' … GitHub Pagesはファイルを最大10分ブラウザに保存させるため、毎回サーバーに更新の有無を確認する
// （変わっていなければ304で軽く済む）。これで更新後すぐ新しい版が表示される。
const NETWORK_WAIT_MS = 2500;
self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  if (new URL(event.request.url).origin !== self.location.origin) return; // 送信サーバー等の外部APIはキャッシュしない
  const cached = () => caches.match(event.request, { ignoreSearch: true });
  // navigate リクエストに初期化オプションは付けられないため、URLから作り直す
  const network = fetch(event.request.url, { cache: 'no-cache', credentials: 'same-origin' })
    .then((res) => {
      if (res.ok) {
        const copy = res.clone();
        caches.open(CACHE_VERSION).then((c) => c.put(event.request, copy));
      }
      return res;
    });
  let timer;
  const slow = new Promise((resolve) => { timer = setTimeout(resolve, NETWORK_WAIT_MS); }).then(cached);
  network.then(() => clearTimeout(timer), () => clearTimeout(timer)); // 先に決着したら待つのをやめる
  event.respondWith(
    Promise.race([
      network,
      slow.then((hit) => hit || network), // キャッシュになければ、そのままネットワークを待つ
    ]).catch(() => cached())
  );
  if (event.waitUntil) event.waitUntil(network.catch(() => {})); // 遅れて届いた応答をキャッシュに入れ終えるまで動かしておく
});

// ---- Web Push ----
// 送信サーバー（worker/worker.js）から {title, body, url, tag} が届く。
// tag は通知の種類。同じ種類は新しい通知で置き換わり、違う種類は並んで残る（D-033）
self.addEventListener('push', (event) => {
  let msg = {};
  try { msg = event.data ? event.data.json() : {}; } catch (_) { msg = { body: event.data && event.data.text() }; }
  const url = msg.url || new URL('index.html?source=webpush', self.registration.scope).href;
  event.waitUntil(
    self.registration.showNotification(msg.title || 'キィニチくん', {
      body: msg.body || '',
      icon: 'icons/icon-192.png',
      tag: msg.tag || 'kiinichi',
      data: { url },
    })
  );
});

// 通知タップ：開いている画面があれば前面に出して移動、なければホーム画面のアプリとして開く
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || new URL('index.html?source=webpush', self.registration.scope).href;
  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of all) {
      if ('focus' in c) {
        await c.focus();
        // 移動に失敗（例外または null）したら、画面に URL を渡して同じ処理をしてもらう（P1-12。WebKit Bug 263687）
        let moved = null;
        try { moved = 'navigate' in c ? await c.navigate(url) : null; } catch (_) { moved = null; }
        if (!moved && 'postMessage' in c) c.postMessage({ type: 'open-url', url });
        return;
      }
    }
    await self.clients.openWindow(url);
  })());
});
