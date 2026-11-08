// マネージャー本体。初回導線（D-009）、ホーム画面（D-018）、設定画面（確認用の起動状態）を扱う。

// 更新が反映されたか確認するための版。ファイルを更新したら sw.js の CACHE_VERSION と合わせて上げる
const APP_VERSION = 'phase1-v5';

// iOS Safari で :active（押した瞬間の反応）を有効にするため（I3-01）
document.addEventListener('touchstart', () => {}, { passive: true });

// 自動テスト用：localhost のときだけ ?mode=standalone でホーム画面アプリとして扱う
const TEST_STANDALONE = ['localhost', '127.0.0.1'].includes(location.hostname)
  && new URLSearchParams(location.search).get('mode') === 'standalone';

function isStandalone() {
  return TEST_STANDALONE || window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
}

// 初回導線の状態を決める（D-009）
const SETUP_DONE_KEY = 'setup.done';
function isSetupDone() {
  let done = false;
  try { done = localStorage.getItem(SETUP_DONE_KEY) === '1'; } catch (_) {}
  // 通知の許可を後から取り消した場合は設定し直してもらう
  const granted = !('Notification' in window) || Notification.permission === 'granted';
  // フェーズ0で設定済みの人（合言葉が保存済みで通知も許可済み）は、やり直さなくてよい
  const hasToken = Boolean(Settings.get('appToken'));
  return granted && (done || hasToken);
}
function decideState() {
  if (!isStandalone()) return 'safari';
  return isSetupDone() ? 'ready' : 'setup';
}
document.body.dataset.state = decideState();

function describeSource() {
  const src = new URLSearchParams(location.search).get('source');
  if (src === 'ntfy') return '通知（ntfy）のタップ';
  if (src === 'webpush') return '通知（Web Push）のタップ';
  if (src === 'homescreen') return 'ホーム画面のアイコン';
  return 'URLを直接開いた';
}

function setText(id, text, cls) {
  const el = document.getElementById(id);
  el.textContent = text;
  if (cls) el.className = cls;
}

setText('display-mode', isStandalone() ? 'ホーム画面アプリ（standalone）' : 'ブラウザ内', isStandalone() ? 'ok' : '');
setText('source', describeSource());
setText('opened-at', new Date().toLocaleString('ja-JP'));
setText('app-version', APP_VERSION);

// ---------- 画面の切り替え（下のタブ。URLの #home などで管理） ----------
const VIEWS = ['home', 'schedule', 'tasks', 'timer', 'report', 'settings'];
function showView() {
  const name = VIEWS.includes(location.hash.slice(1)) ? location.hash.slice(1) : 'home';
  for (const v of VIEWS) document.getElementById('view-' + v).hidden = v !== name;
  for (const a of document.querySelectorAll('.tabbar a')) a.classList.toggle('active', a.dataset.view === name);
}
window.addEventListener('hashchange', showView);
showView();

// ---------- 時計 ----------
function pad(n) { return String(n).padStart(2, '0'); }
function renderClock(now = new Date()) {
  document.getElementById('clock-time').textContent = `${pad(now.getHours())}:${pad(now.getMinutes())}`;
  document.getElementById('clock-date').textContent =
    now.toLocaleDateString('ja-JP', { month: 'long', day: 'numeric', weekday: 'short' });
}

// ---------- 次の予定（今は仮データ） ----------
function renderNextEvent(now = new Date()) {
  const next = SampleData.todayEvents(now).find((e) => e.at > now);
  const el = document.getElementById('next-event');
  if (!next) { el.textContent = '今日の予定はもうありません'; return; }
  const mins = Math.round((next.at - now) / 60000);
  const rest = mins >= 60 ? `${Math.floor(mins / 60)}時間${mins % 60 ? (mins % 60) + '分' : ''}後` : `${mins}分後`;
  el.innerHTML = '';
  const time = document.createElement('span'); time.className = 'next-time'; time.textContent = `${pad(next.at.getHours())}:${pad(next.at.getMinutes())}`;
  const title = document.createElement('span'); title.className = 'next-title'; title.textContent = next.title;
  const left = document.createElement('span'); left.className = 'next-rest'; left.textContent = rest;
  el.append(time, title, left);
}

function tick() { const now = new Date(); renderClock(now); renderNextEvent(now); }
tick();
setInterval(tick, 1000);

// ---------- 吹き出し（セリフ集 app/data/dialogue.json から選ぶ） ----------
let dialogue = null;
const dialogueReady = fetch('data/dialogue.json').then((r) => r.json()).then((d) => { dialogue = d; }).catch(() => {});

// "morning_wake.on_time" のようなキーからセリフを1つ選ぶ
function pickLine(key) {
  if (!dialogue || !key) return null;
  const [trigger, condId] = key.split('.');
  const cond = dialogue[trigger] && (dialogue[trigger].conditions || []).find((c) => c.id === condId);
  if (!cond || !cond.lines || !cond.lines.length) return null;
  return cond.lines[Math.floor(Math.random() * cond.lines.length)];
}

function say(key) {
  const line = pickLine(key);
  if (!line) return false;
  document.getElementById('bubble-text').textContent = line;
  document.getElementById('play-voice').classList.add('ready'); // 声のボタンを目立たせる
  return true;
}

// 通知から開いたとき（?trigger=midday_check.meal_overdue など）は、そのセリフをすぐ出す
dialogueReady.then(() => {
  const key = new URLSearchParams(location.search).get('trigger');
  if (!say(key)) document.getElementById('bubble-text').textContent = '（ここにセリフが出ます）';
});

// 記録ボタン（今は反応の確認だけ。記録の保存はフェーズ2〜3）
for (const btn of document.querySelectorAll('.act')) {
  btn.addEventListener('click', () => say(btn.dataset.trigger));
}

// 音声再生：ボタン1回で鳴らす。今はテスト用チャイム（合成音）。本番の声素材は人間が用意する（NEEDS_HUMAN）。
const voice = new Audio('audio/test-chime.wav');
voice.preload = 'auto';
voice.addEventListener('playing', () => setText('audio-status', '再生中', 'ok'));
voice.addEventListener('ended', () => setText('audio-status', '再生完了', 'ok'));
document.getElementById('play-voice').addEventListener('click', () => {
  voice.currentTime = 0;
  voice.play().catch((e) => setText('audio-status', '再生失敗: ' + e.name, 'ng'));
});

// Web Push：ボタン操作 → 通知許可 → 購読 → 送信サーバーに登録
Settings.bind('app-token', 'appToken');
Settings.bind('setup-token', 'appToken');

function base64UrlToBytes(str) {
  const s = atob(str.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((str.length + 3) % 4));
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
}

async function enablePush() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) {
    throw new Error(isStandalone() ? 'この端末はWeb Pushに対応していません（iOS 16.4以降が必要）'
                                   : 'ホーム画面のアイコンから開いてください（Safariでは使えません）');
  }
  // 許可ダイアログは利用者の操作の直後に出す必要がある（iOSの制約）
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') throw new Error('通知が許可されませんでした（' + permission + '）');
  const { publicKey } = await Settings.api('/api/vapid-public-key', { auth: false });
  const reg = await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  if (sub) {
    // 送信サーバーの鍵が変わっていたら作り直す
    const current = sub.options && sub.options.applicationServerKey;
    const same = current && btoa(String.fromCharCode(...new Uint8Array(current))) === btoa(String.fromCharCode(...base64UrlToBytes(publicKey)));
    if (!same) { await sub.unsubscribe(); sub = null; }
  }
  if (!sub) {
    sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: base64UrlToBytes(publicKey) });
  }
  await Settings.api('/api/subscribe', { method: 'POST', body: sub.toJSON() });
}

function explainError(e) {
  if (/許可されませんでした/.test(e.message)) {
    return e.message + '。iPhoneの「設定」→「通知」→「マネージャー」で通知をオンにしてから、もう一度押してください';
  }
  return e.message;
}

// 初回導線：合言葉 → 通知許可 → 購読登録 を1回のボタン操作で行う（iOSは許可ダイアログに利用者の操作が必要）
document.getElementById('setup-start').addEventListener('click', () => {
  const status = document.getElementById('setup-status');
  status.textContent = '設定中…';
  status.className = 'status';
  enablePush()
    .then(() => {
      try { localStorage.setItem(SETUP_DONE_KEY, '1'); } catch (_) {}
      setText('push-status', '有効（送信サーバーに登録済み）', 'ok');
      document.body.dataset.state = 'ready';
    })
    .catch((e) => {
      status.textContent = '失敗: ' + explainError(e);
      status.className = 'status ng';
    });
});

document.getElementById('enable-push').addEventListener('click', () => {
  setText('push-status', '設定中…', '');
  enablePush()
    .then(() => setText('push-status', '有効（送信サーバーに登録済み）', 'ok'))
    .catch((e) => setText('push-status', '失敗: ' + explainError(e), 'ng'));
});

if ('serviceWorker' in navigator) {
  navigator.serviceWorker
    .register('sw.js', { updateViaCache: 'none' }) // sw.js 自体も一時保存を使わず更新を確認する
    .then(() => navigator.serviceWorker.ready)
    .then((reg) => {
      setText('sw-status', '登録済み', 'ok');
      if (reg.pushManager) {
        reg.pushManager.getSubscription().then((sub) => {
          if (sub) setText('push-status', '購読あり（この端末）', 'ok');
        }).catch(() => {});
      }
    })
    .catch((e) => setText('sw-status', '登録失敗: ' + e.message, 'ng'));
} else {
  setText('sw-status', '非対応', 'ng');
}
