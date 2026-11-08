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

// ---------- 画面の切り替え（下のタブ5個＋右上の設定。URLの #home などで管理。D-019 Q1） ----------
const VIEWS = ['home', 'schedule', 'tasks', 'timer', 'report', 'settings'];
function showView() {
  const name = VIEWS.includes(location.hash.slice(1)) ? location.hash.slice(1) : 'home';
  for (const v of VIEWS) document.getElementById('view-' + v).hidden = v !== name;
  for (const a of document.querySelectorAll('.tabbar a')) {
    if (a.dataset.view === name) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current'); // I2-03
  }
}
window.addEventListener('hashchange', showView);
showView();

// ---------- 時計 ----------
function pad(n) { return String(n).padStart(2, '0'); }
function hm(d) { return `${pad(d.getHours())}:${pad(d.getMinutes())}`; }
function setIfChanged(el, text) { if (el.textContent !== text) el.textContent = text; } // P3-04
function renderClock(now = new Date()) {
  setIfChanged(document.getElementById('clock-time'), hm(now));
  setIfChanged(document.getElementById('clock-date'),
    now.toLocaleDateString('ja-JP', { month: 'long', day: 'numeric', weekday: 'short' }));
}

// ---------- 次の予定（今は仮データ） ----------
// 今日の予定が尽きたら、明日の最初の予定を「明日」付きで出す（C7-03）
function nextEvent(now = new Date()) {
  const today = SampleData.todayEvents(now).find((e) => e.at > now);
  if (today) return { ...today, tomorrow: false };
  const tmr = new Date(now); tmr.setDate(tmr.getDate() + 1);
  const first = SampleData.todayEvents(tmr)[0];
  return first ? { ...first, tomorrow: true } : null;
}
// 「あと N 時間 M 分」（1時間未満は「あと M 分」）（C7-02）
function restText(ms) {
  const mins = Math.max(0, Math.ceil(ms / 60000));
  const h = Math.floor(mins / 60), m = mins % 60;
  if (h === 0) return `あと${m}分`;
  return m ? `あと${h}時間${m}分` : `あと${h}時間`;
}
let lastEventKey = '';
function renderNextEvent(now = new Date()) {
  const next = nextEvent(now);
  const el = document.getElementById('next-event');
  setIfChanged(document.getElementById('next-rest'), next ? restText(next.at - now) : '');
  const key = next ? `${next.tomorrow}|${next.at.getTime()}|${next.title}` : 'none';
  if (key === lastEventKey) return; // 表示が変わるときだけ作り直す（P3-04）
  lastEventKey = key;
  el.textContent = '';
  if (!next) { el.textContent = '予定はありません'; return; }
  const parts = [];
  if (next.tomorrow) parts.push(['next-day', '明日']);
  parts.push(['next-time', hm(next.at)], ['next-title', next.title]);
  for (const [cls, text] of parts) {
    const span = document.createElement('span'); span.className = cls; span.textContent = text; el.append(span);
  }
}

let lastMinute = '';
let lastHour = null;
let lastDate = null;
function tick() {
  const now = new Date();
  const minute = hm(now) + now.toDateString();
  if (minute === lastMinute) return; // 分が変わったときだけ書き換える（P3-04）
  lastMinute = minute;
  if (lastDate !== null && lastDate !== now.toDateString()) applyRecords(now); // 日付が変わったら記録を読み直す
  if (lastHour !== null && lastHour !== now.getHours()) markPrimary(now); // 「時」が変わったら主ボタンを判定し直す
  lastHour = now.getHours();
  lastDate = now.toDateString();
  applyPeriod(now);
  renderClock(now);
  renderNextEvent(now);
}
tick();
setInterval(tick, 1000);

// ---------- 時間帯（C9-01。時間帯の一言と配色はこれを参照する） ----------
function periodOf(now = new Date()) {
  const h = now.getHours();
  if (h >= 5 && h < 10) return 'morning';
  if (h >= 10 && h < 17) return 'day';
  if (h >= 17 && h < 22) return 'evening';
  return 'night';
}
function applyPeriod(now = new Date()) {
  const p = periodOf(now);
  if (document.body.dataset.period !== p) document.body.dataset.period = p; // 変わったときだけ
}

// ---------- セリフ（セリフ集 app/data/dialogue.json から選ぶ） ----------
let dialogue = null;
const dialogueReady = fetch('data/dialogue.json').then((r) => r.json()).then((d) => { dialogue = d; }).catch(() => {});
const lastLineIndex = {}; // キーごとに直前に出した候補の番号（C1-02）

function candidates(key) {
  if (!dialogue || !key) return null;
  const [trigger, condId] = key.split('.');
  const cond = dialogue[trigger] && (dialogue[trigger].conditions || []).find((c) => c.id === condId);
  return cond && cond.lines && cond.lines.length ? cond.lines : null;
}

// "morning_wake.on_time" のようなキーからセリフを1つ選び、{ text, index } を返す
// index が範囲内の整数ならその候補（通知の line 指定。C5-05）。それ以外は直前と違うものをランダムに（C1-02）
function pickLine(key, { index } = {}) {
  const lines = candidates(key);
  if (!lines) return null;
  let i;
  if (Number.isInteger(index) && index >= 0 && index < lines.length) {
    i = index;
  } else {
    const pool = lines.map((_, k) => k).filter((k) => lines.length < 2 || k !== lastLineIndex[key]);
    i = pool[Math.floor(Math.random() * pool.length)];
  }
  lastLineIndex[key] = i;
  return { text: lines[i], index: i };
}

// セリフを表示する。ready が真なら「声を聞く」を主ボタンにする
function showLine(key, { index, ready = false } = {}) {
  const picked = pickLine(key, { index });
  if (!picked) return false;
  document.getElementById('bubble-text').textContent = picked.text;
  document.getElementById('play-voice').classList.toggle('ready', ready);
  setVoiceState('idle'); // 新しいセリフが出たら「声を聞く」に戻す（C2-02）
  return true;
}

// 通知や記録の反応がないときの時間帯の一言（D-019 Q4 = 出す）。出せなければ「…」（沈黙）
function showIdle(now = new Date()) {
  if (showLine('idle_greeting.' + periodOf(now))) return;
  document.getElementById('bubble-text').textContent = '…';
  document.getElementById('play-voice').classList.remove('ready');
  setVoiceState('idle');
}

// ---------- 主ボタン（金の塗り）は 1 つ（V3-02, C4-02） ----------
// data-hours="4-11" … 4時以上11時未満（受付時間帯。仮決定 D-019）
function inHours(btn, hour) {
  const m = /^(\d+)-(\d+)$/.exec(btn.dataset.hours || '');
  if (!m) return false; // data-hours が無いボタンは主にしない
  return hour >= Number(m[1]) && hour < Number(m[2]);
}
function markPrimary(now = new Date()) {
  const acts = [...document.querySelectorAll('.act')];
  let primary = null;
  if (!document.body.classList.contains('from-notification')) { // 通知から開いた直後は「声を聞く」が主
    primary = acts.find((b) => !b.classList.contains('done') && inHours(b, now.getHours())) || null;
  }
  for (const b of acts) b.classList.toggle('primary', b === primary);
}

// ---------- 通知から開いた状態（C5-03。source=webpush のときだけ。ntfy は PWA で開かない） ----------
function startNotificationState() {
  document.body.classList.add('from-notification');
  voiceBtn.classList.add('ready');
  markPrimary();
}
function endNotificationState() {
  document.body.classList.remove('from-notification');
  voiceBtn.classList.remove('ready');
  markPrimary();
}

// 開いたときの処理（読み込み時・通知のタップ時）。URL の source / trigger / line を見る
function applyOpenParams(params, now = new Date()) {
  const trigger = params.get('trigger');
  const index = params.has('line') ? Number(params.get('line')) : undefined; // Number(null) は 0 になるため has を確かめる
  const fromPush = params.get('source') === 'webpush';
  if (trigger && showLine(trigger, { index, ready: fromPush })) {
    if (fromPush) startNotificationState(); else markPrimary(now);
    return;
  }
  document.body.classList.remove('from-notification');
  showIdle(now);
  markPrimary(now);
}

applyPeriod();
dialogueReady.then(() => applyOpenParams(new URLSearchParams(location.search)));

// ---------- 記録（I3-02, C6-01） ----------
// 仮の保存（D-019 Q7）。フェーズ2のデータ構造を決めるときに置き換える。記録による通知予約の取り消し（D-015）もフェーズ2
const RECORDS_KEY = 'records.today';
function dateStr(d) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
function loadRecords(now = new Date()) {
  try {
    const r = JSON.parse(localStorage.getItem(RECORDS_KEY) || 'null');
    if (r && r.date === dateStr(now) && r.items) return r; // 今日の分だけ使う
  } catch (_) {}
  return { date: dateStr(now), items: {} };
}
function saveRecords(r) {
  try { localStorage.setItem(RECORDS_KEY, JSON.stringify(r)); } catch (_) {} // 失敗しても画面は動かす
}
function setDone(btn, time) {
  btn.classList.add('done');
  btn.textContent = `✓ ${btn.dataset.label} ${time}`;
}
function setUndone(btn) {
  btn.classList.remove('done');
  btn.textContent = btn.dataset.label;
}
// 保存してある今日の記録を、ボタンの表示に反映する
function applyRecords(now = new Date()) {
  const r = loadRecords(now);
  for (const btn of document.querySelectorAll('.act')) {
    const t = r.items[btn.dataset.record];
    if (t) setDone(btn, t); else setUndone(btn);
  }
}

// 取り消しの表示（5秒）
const toast = document.getElementById('toast');
let toastTimer = null;
let toastFor = null; // { btn, prevLine, reactionLine } … prevLine は押した直後のときだけ
function hideToast() {
  toast.hidden = true;
  toastFor = null;
  clearTimeout(toastTimer);
}
function showToast(info) {
  toastFor = info; // 前のトーストの記録はそのまま確定する
  toast.textContent = '';
  const msg = document.createElement('span');
  msg.textContent = `「${info.btn.dataset.label}」を記録しました`;
  const undo = document.createElement('button');
  undo.type = 'button';
  undo.className = 'undo';
  undo.textContent = '取り消す';
  undo.addEventListener('click', undoRecord);
  toast.append(msg, undo);
  toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(hideToast, 5000);
}
function undoRecord() {
  if (!toastFor) return;
  const { btn, prevLine, reactionLine } = toastFor;
  setUndone(btn);
  const r = loadRecords();
  delete r.items[btn.dataset.record];
  saveRecords(r);
  // 押した直後の取り消しで、セリフがまだ反応のままなら、押す前のセリフに戻す
  const bubble = document.getElementById('bubble-text');
  if (prevLine !== undefined && bubble.textContent === reactionLine) {
    bubble.textContent = prevLine;
    setVoiceState('idle');
  }
  hideToast();
  markPrimary();
}

for (const btn of document.querySelectorAll('.act')) {
  btn.addEventListener('click', () => {
    if (btn.classList.contains('done')) { // 記録済み：新しい記録はせず、取り消しを出し直す（セリフは変えない）
      showToast({ btn });
      return;
    }
    const now = new Date();
    const prevLine = document.getElementById('bubble-text').textContent;
    if (document.body.classList.contains('from-notification')) endNotificationState(); // 記録に移ったら通知の強調は終える（D-020）
    showLine(btn.dataset.trigger, { ready: false }); // 反応のセリフ。主ボタンが2つにならないよう ready は付けない
    const time = hm(now);
    setDone(btn, time);
    const r = loadRecords(now);
    r.items[btn.dataset.record] = time;
    saveRecords(r);
    markPrimary(now);
    showToast({ btn, prevLine, reactionLine: document.getElementById('bubble-text').textContent });
  });
}
applyRecords();

// ---------- 開いたときの判定し直し（P1-11, P1-12） ----------
// ホーム画面のアプリは裏から再開されることが多い。表示に戻ったときに、セリフ・主ボタン・記録・時間帯を判定し直す
const RESUME_REFRESH_MS = 10 * 60 * 1000; // 仮決定（D-019）
let hiddenAt = null;
function onResume(away) {
  const now = new Date();
  applyRecords(now);
  if (away >= RESUME_REFRESH_MS) { // 長く裏にあった：通知から開いた状態を終え、今の時間帯の一言に戻す
    hideToast();
    endNotificationState();
    showIdle(now);
  }
  lastMinute = ''; // 時計と次の予定をすぐ更新する
  tick();
  applyPeriod(now);
  markPrimary(now);
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') { hiddenAt = Date.now(); return; }
  if (hiddenAt === null) return;
  const away = Date.now() - hiddenAt;
  hiddenAt = null;
  onResume(away);
});
window.addEventListener('pageshow', (e) => { if (e.persisted) onResume(Infinity); });

// 通知のタップで画面の移動に失敗したとき、Service Worker から URL が届く（sw.js）。通知から開いたときと同じ処理をする
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.addEventListener('message', (e) => {
    if (!e.data || e.data.type !== 'open-url') return;
    dialogueReady.then(() => applyOpenParams(new URL(e.data.url, location.href).searchParams));
  });
  if (navigator.serviceWorker.startMessages) navigator.serviceWorker.startMessages();
}

// ---------- 声を聞く（C2-02）：idle「声を聞く」/ playing「再生中」/ ended「もう一度聞く」/ error「再生できません」 ----------
// 今はテスト用チャイム（合成音）。本番の声素材は人間が用意する（H-005）。
const VOICE_LABELS = { idle: '声を聞く', playing: '再生中', ended: 'もう一度聞く', error: '再生できません' };
const voiceBtn = document.getElementById('play-voice');
function setVoiceState(state) {
  voiceBtn.dataset.state = state;
  voiceBtn.querySelector('.voice-label').textContent = VOICE_LABELS[state];
}
// 読み上げ専用の状態テキスト。setText は className を上書きして .sr-only を消すので使わない（I4-02）
function setAudioStatus(text, cls) {
  const el = document.getElementById('audio-status');
  el.textContent = text;
  el.classList.remove('ok', 'ng');
  if (cls) el.classList.add(cls);
}
const voice = new Audio('audio/test-chime.wav');
voice.preload = 'auto';
voice.addEventListener('playing', () => { setVoiceState('playing'); setAudioStatus('再生中', 'ok'); });
voice.addEventListener('ended', () => {
  setVoiceState('ended');
  setAudioStatus('再生完了', 'ok');
  onVoiceEnded();
});
voiceBtn.addEventListener('click', () => {
  voice.currentTime = 0;
  voice.play().catch((e) => { setVoiceState('error'); setAudioStatus('再生失敗: ' + e.name, 'ng'); }); // error で押すと再試行
});
// 再生が終わったら主ボタンの塗りを外し、通知から開いた状態を終える（C5-03）
function onVoiceEnded() {
  voiceBtn.classList.remove('ready');
  if (document.body.classList.contains('from-notification')) endNotificationState();
}

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
