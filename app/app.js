// マネージャー本体。初回導線（D-009）、ホーム画面（D-019・見た目は D-021）、通知の購読、設定画面（確認用の起動状態）を扱う。
// 共通の小道具は util.js（日付・保存）、dialogue.js（セリフ集）、ui.js（確認・取り消しの表示）にある。

// 更新が反映されたか確認するための版。ファイルを更新したら sw.js の CACHE_VERSION と合わせて上げる
const APP_VERSION = 'phase3-v23';

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

// ---------- 画面の高さの補い（D-041） ----------
// iPhone のホーム画面アプリは、完全に閉じた状態から開いた直後、画面の高さが実際より短く伝わることがある
// （下に固定したタブバーが上にずれ、その下に空きができる。触ると直る）。
// 伝わっている高さ（innerHeight）と端末の画面の高さ（screen）を比べ、足りない分だけ下に固定した部品を下げる。
// 高さが正しくなれば差は 0 になり、何もしない。iPhone のホーム画面アプリ（navigator.standalone）以外では動かさない
const VH_FIX_MAX = 120; // これより大きい差は別の理由（キーボードなど）とみなして補わない
let vhFirst = null; // 開いた直後の実測（設定画面の確認用）
function fixViewportHeight() {
  if (window.navigator.standalone !== true) return;
  const portrait = window.matchMedia('(orientation: portrait)').matches;
  const full = portrait ? Math.max(screen.height, screen.width) : Math.min(screen.height, screen.width);
  const diff = Math.round(full - window.innerHeight);
  if (vhFirst === null) {
    vhFirst = diff;
    setText('viewport-height', `${window.innerHeight} / ${full}（差 ${diff}）`);
  }
  const fix = diff > 0 && diff <= VH_FIX_MAX ? diff : 0;
  const value = fix + 'px';
  if (document.documentElement.style.getPropertyValue('--vh-fix') !== value) document.documentElement.style.setProperty('--vh-fix', value);
}
fixViewportHeight();
for (const type of ['resize', 'orientationchange', 'pageshow', 'scroll', 'touchend']) window.addEventListener(type, fixViewportHeight, { passive: true });
document.addEventListener('visibilitychange', fixViewportHeight);
if (window.visualViewport) window.visualViewport.addEventListener('resize', fixViewportHeight);
// 高さが直ったことを知らせる合図が来ない場合に備え、開いてから 5 秒間は確かめ続ける
{
  const until = Date.now() + 5000;
  const watch = () => { fixViewportHeight(); if (Date.now() < until) requestAnimationFrame(watch); };
  requestAnimationFrame(watch);
}

// ---------- 画面の切り替え（下のタブ5個＋右上の設定。URLの #home などで管理。D-019 Q1） ----------
const VIEWS = ['home', 'schedule', 'tasks', 'timer', 'report', 'settings', 'system'];
let shownView = null;
function showView() {
  const name = VIEWS.includes(location.hash.slice(1)) ? location.hash.slice(1) : 'home';
  if (shownView !== null && shownView !== name) window.scrollTo(0, 0); // 別の画面に移ったら上から見せる（設定の下から仕様関連へ移ったときなど）
  shownView = name;
  for (const v of VIEWS) document.getElementById('view-' + v).hidden = v !== name;
  for (const a of document.querySelectorAll('.tabbar a')) {
    if (a.dataset.view === name) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current'); // I2-03
  }
}
window.addEventListener('hashchange', showView);
showView();

// 立ち絵は portrait.js（D-022 ④、D-066）

// ---------- 時計 ----------
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
  if (lastDate !== null && lastDate !== todayKey(now)) applyRecords(now); // 1日の区切り（朝4時。D-034）をまたいだら記録を読み直す
  if (lastHour !== null && lastHour !== now.getHours()) markPrimary(now); // 「時」が変わったら主ボタンを判定し直す
  lastHour = now.getHours();
  lastDate = todayKey(now);
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
  if (h >= 10 && h < 16) return 'day';     // 区切りは D-088（利用者の指定 2026-11-21）：朝 5〜10・昼 10〜16・夕方 16〜19・夜 19〜翌5時
  if (h >= 16 && h < 19) return 'evening';
  return 'night';
}
function applyPeriod(now = new Date()) {
  const p = periodOf(now);
  if (document.body.dataset.period !== p) document.body.dataset.period = p; // 変わったときだけ
}

// ---------- セリフ（選び方は dialogue.js） ----------
// セリフを表示する（声の再生は見送り。D-023）
function showLine(key, { index, hash, vars, extra } = {}) {
  const picked = pickLine(key, { index, hash });
  if (!picked) return false;
  const bubble = document.getElementById('bubble-text');
  const { kinich, ahau } = splitAhau(fillLine(picked.text, vars));
  bubble.textContent = kinich + (extra || '');
  showAhau(ahau);
  document.getElementById('bubble-choices').hidden = true; // 選択肢は、それを出したセリフのときだけ
  document.getElementById('bubble-mood').hidden = true;
  if (typeof placeToast === 'function' && document.getElementById('toast').classList.contains('in-dialogue')) { homeToast.hide(); placeToast(); }
  bubble.classList.remove('line-enter'); void bubble.offsetWidth; bubble.classList.add('line-enter'); // CR-M01：入りの動きをやり直す
  return true;
}

// アハウの合いの手（D-085）：あるときだけ、セリフの面の上に小さな吹き出しで出す。次のセリフ・ほかの画面へ移ったら消す
function showAhau(text) {
  document.getElementById('ahau-text').textContent = text || '';
  document.getElementById('ahau-line').hidden = !text;
}
window.addEventListener('hashchange', () => showAhau(''));

// 通知や記録の反応がないときの時間帯の一言（D-019 Q4 = 出す）。出せなければ「…」（沈黙）
function showIdle(now = new Date()) {
  // 初回起動・翌日の再訪・疲れた日・記録のくせ（D-060 ⑩）・節目・タスクの進み具合・レア（D-083。touch.js の Scenes）。
  // どれも出なければ時間帯の一言
  if (typeof Scenes !== 'undefined' && Scenes.show(now)) return;
  if (showLine('idle_greeting.' + periodOf(now))) return;
  document.getElementById('bubble-text').textContent = '…';
}

// ---------- 主ボタン（金の塗り）は 1 つ（V3-02, C4-02） ----------
// 選び方は renderDock（下の「記録」）。名前は以前のまま残す（通知から開いた状態などから呼ぶ）
function markPrimary(now = new Date()) { renderDock(now); }

// ---------- 通知から開いた状態（C5-03。source=webpush のときだけ。ntfy は PWA で開かない） ----------
// セリフの面の上辺を金にする。記録するか、10分以上裏に置くと終わる（D-024）
function startNotificationState() {
  document.body.classList.add('from-notification');
  markPrimary();
}
function endNotificationState() {
  document.body.classList.remove('from-notification');
  markPrimary();
}

// 開いたときの処理（読み込み時・通知のタップ時）。URL の source / trigger / line を見る
function applyOpenParams(params, now = new Date()) {
  const trigger = params.get('trigger');
  const index = params.has('line') ? Number(params.get('line')) : undefined; // Number(null) は 0 になるため has を確かめる
  const hash = params.get('h') || undefined; // 通知の文の印（D-081）。古い通知にはない
  const fromPush = params.get('source') === 'webpush';
  const vars = { title: params.get('title') || '' }; // 予定の前の声掛けは予定の名前を差し込む（D-054）
  if (trigger && showLine(trigger, { index, hash, vars })) {
    if (fromPush) startNotificationState(); else markPrimary(now);
    return;
  }
  document.body.classList.remove('from-notification');
  if (!offerEvening(now)) showIdle(now);
  markPrimary(now);
}

// 通知から開いた印（trigger・line・source=webpush）は、使い終えたら URL から外す。
// 残したままだと、再読み込みのたびに同じ通知のセリフと金の上辺が出直す（D-033）
function clearOpenParams() {
  const params = new URLSearchParams(location.search);
  if (!params.has('trigger') && !params.has('line') && !params.has('title') && params.get('source') !== 'webpush') return;
  params.delete('trigger');
  params.delete('line');
  params.delete('h');
  params.delete('title');
  if (params.get('source') === 'webpush') params.delete('source');
  const query = params.toString();
  history.replaceState(null, '', location.pathname + (query ? '?' + query : '') + location.hash);
}

applyPeriod();
// 開いたときの一言は、セリフ集と、このあとに読み込むスクリプト（stats.js・tasks.js など）の両方がそろってから選ぶ。
// セリフ集が先に届くと、夕方の提案（D-073）や記録のくせの一言（D-060 ⑩）を見ないまま、時間帯の一言になってしまうため
const scriptsReady = document.readyState === 'loading'
  ? new Promise((resolve) => document.addEventListener('DOMContentLoaded', resolve, { once: true }))
  : Promise.resolve();
Promise.all([dialogueReady, scriptsReady]).then(() => {
  applyOpenParams(new URLSearchParams(location.search));
  clearOpenParams();
});

// ---------- 記録（I3-02, C6-01, D-043, D-046） ----------
// 記録の種類（一日の順）。win は「ホームに出す時間帯」を毎日の時刻（routine.js。D-048）から決める（分。朝4時を 240、深夜1時を 1500 と数える）。
// 予定時刻が「なし」の記録はホームに出さない（一覧からは記録できる）。既定の時刻なら D-046 の時間帯と同じになる
// repeat … 1日に何度でも記録できる（休憩）。主ボタン（金の塗り）にはしない
const DAY_END = (24 + DAY_STARTS_AT) * 60; // 次の朝4時
const around = (t, before, after) => (t === null ? null : [Math.max(DAY_STARTS_AT * 60, t - before), Math.min(DAY_END, t + after)]);
const untilDayEnd = (t, before) => (t === null ? null : [Math.max(DAY_STARTS_AT * 60, t - before), DAY_END]);
const RECORD_KINDS = [
  { id: 'wake', label: '起きた', trigger: 'morning_wake.on_time', win: (m) => around(m.wake, 180, 240) },
  { id: 'breakfast', label: '朝食', trigger: 'record_done.breakfast', win: (m) => around(m.breakfast, 150, 210) },
  { id: 'work_start', label: '仕事開始', trigger: 'work_start.default', win: (m) => around(m.work_start, 120, 240) },
  { id: 'lunch', label: '昼食', trigger: 'record_done.lunch', win: (m) => around(m.lunch, 60, 180) },
  { id: 'break', label: '休憩', trigger: 'record_done.break', repeat: true,
    win: (m) => (m.work_start === null || m.work_end === null ? null : [m.work_start + 60, Math.min(DAY_END, m.work_end + 30)]) },
  { id: 'work_end', label: '仕事終わり', trigger: 'record_done.work_end', win: (m) => around(m.work_end, 150, 270) },
  { id: 'dinner', label: '夕食', trigger: 'record_done.dinner', win: (m) => around(m.dinner, 150, 210) },
  { id: 'bath', label: '入浴', trigger: 'record_done.bath', win: (m) => untilDayEnd(m.bath, 210) },
  { id: 'brush', label: '歯磨き', trigger: 'record_done.brush', win: (m) => untilDayEnd(m.sleep, 210) },
  { id: 'sleep', label: '就寝', trigger: 'record_done.sleep', win: (m) => untilDayEnd(m.sleep, 150) },
];
const DOCK_MAX = 3; // ホームに同時に出すのは 3 個まで（I4-04）
const kindOf = (id) => RECORD_KINDS.find((k) => k.id === id);
// その日の予定時刻を分で（なしは null）
function plannedMinutes(now = new Date()) {
  const times = Routine.timesFor(logicalDay(now));
  const out = {};
  for (const [id] of ROUTINE_ITEMS) out[id] = routineMinutes(times[id]);
  return out;
}
// 起きたときに、今日のカレンダーの予定の数と最初の予定を添える（D-054。通知は増やさない）。予定がなければ添えない
function todayPlansLine(now = new Date()) {
  if (!Calendar.ready()) return '';
  const day = logicalDay(now);
  const plans = Calendar.eventsOn(day).sort((a, b) => (a.allDay !== b.allDay ? (a.allDay ? -1 : 1) : a.at - b.at));
  if (!plans.length) return '';
  const timed = plans.find((e) => !e.allDay);
  const first = timed ? `${hm(timed.at)}の「${timed.title}」` : `終日の「${plans[0].title}」`;
  const picked = pickLine('calendar_today.some');
  return picked ? fillLine(picked.text, { n: plans.length, first }) : '';
}
// 起きたときの一言は、予定の起床時刻との差で分ける（spec：±15分以内は定刻）
function wakeTrigger(now) {
  const planned = plannedMinutes(now).wake;
  if (planned === null) return 'morning_wake.on_time';
  const diff = logicalMinutes(now) - planned;
  return diff < -15 ? 'morning_wake.early' : diff > 15 ? 'morning_wake.late' : 'morning_wake.on_time';
}

// 記録は日付（朝4時区切り。D-034）ごとに残し、消さない（D-043）。形は docs/data_schema.md
//   ふつう：{ time: '07:12', at: ミリ秒 }／休憩：[ { time, at }, … ]／今日はなし：{ skipped: true, at }
// 記録による通知予約の取り消し（D-015）は、声掛けを作るときにつなぐ
const Records = {
  all() {
    const r = Store.read(DB.records, {});
    return r && typeof r === 'object' && !Array.isArray(r) ? r : {};
  },
  day(now = new Date()) { return this.all()[todayKey(now)] || {}; },
  // 1つの種類の今日の状態：{ state: 'none' | 'done' | 'skipped', count, time }
  status(kind, day) {
    const v = day[kind];
    if (Array.isArray(v)) return v.length ? { state: 'done', count: v.length, time: v[v.length - 1].time } : { state: 'none', count: 0 };
    if (v && v.skipped) return { state: 'skipped', count: 0 };
    if (v && v.time) return { state: 'done', count: 1, time: v.time };
    return { state: 'none', count: 0 };
  },
  write(now, change) {
    const all = this.all();
    const key = todayKey(now);
    const day = { ...(all[key] || {}) };
    change(day);
    if (Object.keys(day).length) all[key] = day; else delete all[key];
    const ok = Store.write(DB.records, all);
    if (ok) window.dispatchEvent(new Event('recordschange')); // 声掛けの予約を決め直す（notify.js）
    return ok;
  },
  // 記録する。休憩は1回ずつ足す。保存できたら true
  set(kind, now = new Date()) {
    const rec = { time: hm(now), at: now.getTime() };
    return this.write(now, (day) => {
      if (kindOf(kind) && kindOf(kind).repeat) day[kind] = [...(Array.isArray(day[kind]) ? day[kind] : []), rec];
      else day[kind] = rec;
    });
  },
  // 取り消す。休憩は最後の1回だけ
  unset(kind, now = new Date()) {
    return this.write(now, (day) => {
      if (Array.isArray(day[kind]) && day[kind].length > 1) day[kind] = day[kind].slice(0, -1);
      else delete day[kind];
    });
  },
  // 「今日はなし」を付ける・外す（付けたものはホームに出さない。未記録の声掛けもしない）
  skip(kind, on, now = new Date()) {
    return this.write(now, (day) => { if (on) day[kind] = { skipped: true, at: now.getTime() }; else delete day[kind]; });
  },
  // 時刻を手で入れる（D-079）。time は 'HH:MM'（朝4時より前は次の暦日）。ふつうの記録は入れ替え、休憩は1回足して時刻の順に並べる。
  // 印 manual: true を付ける（1項目につき1日1回まで。スプレッドシートには「記録（手入力）」で送る）。保存できたら true
  setManual(kind, time, now = new Date()) {
    const d = logicalDay(now);
    d.setMinutes(routineMinutes(time));
    const rec = { time, at: d.getTime(), manual: true };
    return this.write(now, (day) => {
      if (kindOf(kind) && kindOf(kind).repeat) day[kind] = [...(Array.isArray(day[kind]) ? day[kind] : []), rec].sort((a, b) => a.at - b.at);
      else day[kind] = rec;
    });
  },
  // 今日、その項目を手で入れたか
  manualUsed(kind, day) {
    const v = day[kind];
    return Array.isArray(v) ? v.some((r) => r && r.manual) : Boolean(v && v.manual);
  },
};

// ---------- ホームの記録ボタン（D-046）：今の時間帯に合うものを、未記録を優先して最大 3 つ。並びは一日の順 ----------
function dockKinds(now = new Date()) {
  const lm = logicalMinutes(now);
  const planned = plannedMinutes(now);
  const day = Records.day(now);
  const open = RECORD_KINDS.filter((k) => {
    const w = k.win(planned);
    return w && lm >= w[0] && lm < w[1] && Records.status(k.id, day).state !== 'skipped';
  });
  const pending = open.filter((k) => Records.status(k.id, day).state === 'none');
  const picked = [...pending, ...open.filter((k) => !pending.includes(k))].slice(0, DOCK_MAX);
  return RECORD_KINDS.filter((k) => picked.includes(k));
}
function fillAct(btn, kind, st) {
  btn.classList.toggle('done', st.state === 'done' && !kind.repeat);
  btn.textContent = '';
  const label = document.createElement('span');
  label.className = 'act-label';
  if (st.state === 'done' && !kind.repeat) {
    label.textContent = `✓ ${kind.label}`;
    const time = document.createElement('span');
    time.className = 'act-time';
    time.textContent = ` ${st.time}`; // 読み上げと textContent では「✓ 起きた 07:12」と続く
    btn.append(label, time);
  } else if (kind.repeat && st.count) {
    label.textContent = kind.label;
    const time = document.createElement('span');
    time.className = 'act-time';
    time.textContent = ` ${st.count}回・${st.time}`;
    btn.append(label, time);
  } else {
    label.textContent = kind.label;
    btn.append(label);
  }
}
let dockKey = '';
function renderDock(now = new Date(), force = false) {
  const day = Records.day(now);
  const kinds = dockKinds(now);
  const stats = kinds.map((k) => Records.status(k.id, day));
  const primary = kinds.find((k, i) => !k.repeat && stats[i].state === 'none') || null;
  const key = JSON.stringify([kinds.map((k) => k.id), stats, primary && primary.id]);
  if (key === dockKey && !force) return; // 変わったときだけ作り直す（押している最中のボタンを消さない）
  dockKey = key;
  const box = document.getElementById('record-acts');
  const focused = document.activeElement && document.activeElement.dataset ? document.activeElement.dataset.record : null;
  box.replaceChildren(...kinds.map((k, i) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'act' + (k === primary ? ' primary' : '');
    btn.dataset.record = k.id;
    btn.dataset.label = k.label;
    fillAct(btn, k, stats[i]);
    btn.addEventListener('click', () => pressRecord(k.id));
    return btn;
  }));
  if (focused) { const b = box.querySelector(`[data-record="${focused}"]`); if (b) b.focus(); }
}
// 以前の名前（日付が変わったとき・裏から戻ったときに呼ぶ）
function applyRecords(now = new Date()) { renderDock(now, true); if (sheet.open) renderSheet(now); }

// 取り消しの表示（5秒）
const homeToast = makeToast(document.getElementById('toast'));
// info = { kind, prevLine, reactionLine } … prevLine は押した直後のときだけ
// 取り消しの表示の置き場所：夕方の提案の選択肢が出ているあいだは、セリフの面の中（選択肢の下）。ふだんは記録ボタンの上（D-060 ⑫）
const toastHome = { parent: document.getElementById('toast').parentNode, next: document.getElementById('toast').nextSibling };
function placeToast() {
  const el = document.getElementById('toast');
  const choices = [document.getElementById('bubble-choices'), document.getElementById('bubble-mood')].find((c) => !c.hidden);
  if (choices) {
    el.classList.add('in-dialogue');
    choices.after(el);
  } else if (el.classList.contains('in-dialogue')) {
    el.classList.remove('in-dialogue');
    toastHome.parent.insertBefore(el, toastHome.next);
  }
}
function showRecordToast(info) {
  placeToast();
  const k = kindOf(info.kind);
  const st = Records.status(info.kind, Records.day());
  const nth = k.repeat && st.count > 1 ? `（${st.count}回目）` : '';
  homeToast.show(`「${k.label}」を記録しました${nth}`, () => undoRecord(info));
}
function undoRecord({ kind, prevLine, reactionLine }) {
  Records.unset(kind);
  // 押した直後の取り消しで、セリフがまだ反応のままなら、押す前のセリフに戻す
  const bubble = document.getElementById('bubble-text');
  if (prevLine !== undefined && bubble.textContent === reactionLine) { bubble.textContent = prevLine; showAhau(''); }
  applyRecords();
}
// 記録する（ホームのボタン・一覧から）。反応のセリフを出す。保存できたら true
function recordNow(kind) {
  const now = new Date();
  if (!Records.set(kind, now)) return false;
  if (document.body.classList.contains('from-notification')) endNotificationState(); // 記録に移ったら通知の強調は終える（D-020）
  showLine(kind === 'wake' ? wakeTrigger(now) : kindOf(kind).trigger, { extra: kind === 'wake' ? todayPlansLine(now) : '' }); // 反応のセリフ
  if (kind === 'work_end') offerWorkEnd(now);
  applyRecords(now);
  return true;
}

// 夕方の予定見直し（D-059, D-073）。決めるのは本人（ボタン）。通知は増やさない（アプリの中だけ。利用者回答）
// ①仕事終わりを押したら、今日の調子をまだ聞いていなければ聞く（選んだ調子は日報の調子に入れる）
// ②今日まで（期限切れを含む）のタスクが残っていれば「明日に回す／このまま」。疲れているときは回すほうを先に言う
// ③仕事終わりの時刻を過ぎて（または仕事終わりを押したあと）ホームを開いたら、②をその日1回だけ出す
function todayMood(now = new Date()) {
  const key = todayKey(now);
  const r = Report.load()[key];
  if (r && r.mood) return r.mood;
  const d = Store.read(DB.reportDraft);
  return d && d.date === key && d.mood ? d.mood : null;
}
function offerPostpone(now = new Date(), key = null) {
  const n = Tasks.dueLeft(now);
  if (!n) return false;
  showLine(todayMood(now) === 'tired' ? 'work_end_check.tired' : key || 'work_end_check.left', { vars: { n } });
  document.getElementById('bubble-choices').hidden = false;
  Store.write(DB.evening, { date: todayKey(now) }); // ホームを開いたときにもう一度は出さない
  return true;
}
function offerWorkEnd(now = new Date()) {
  if (todayMood(now)) { offerPostpone(now); return; }
  showLine('work_end_mood.ask');
  document.getElementById('bubble-mood').hidden = false;
}
function isEvening(now = new Date()) {
  if (Records.status('work_end', Records.day()).state === 'done') return true;
  const t = Routine.timesFor(logicalDay(now)).work_end;
  return Boolean(t) && logicalMinutes(now) >= routineMinutes(t);
}
function offerEvening(now = new Date()) {
  if (typeof Tasks === 'undefined' || typeof Report === 'undefined') return false;
  const shown = Store.read(DB.evening, null);
  if (shown && shown.date === todayKey(now)) return false;
  return isEvening(now) && offerPostpone(now, 'work_end_check.evening');
}
for (const b of document.querySelectorAll('#bubble-mood [data-mood]')) {
  b.addEventListener('click', () => {
    const now = new Date();
    if (!Report.setMoodFor(b.dataset.mood, now)) { homeToast.show(SAVE_FAILED); return; }
    if (!offerPostpone(now)) showLine(b.dataset.mood === 'tired' ? 'work_end_mood.tired' : 'work_end_mood.ok');
  });
}
document.getElementById('choice-postpone').addEventListener('click', () => {
  const n = Tasks.postponeToTomorrow();
  if (n < 0) { homeToast.show(SAVE_FAILED); return; }
  showLine('work_end_check.postponed', { vars: { n } });
});
document.getElementById('choice-keep').addEventListener('click', () => showLine('work_end_check.kept'));
function pressRecord(kind) {
  const k = kindOf(kind);
  if (!k.repeat && Records.status(kind, Records.day()).state === 'done') { // 記録済み：新しい記録はせず、取り消しを出し直す（セリフは変えない）
    showRecordToast({ kind });
    return;
  }
  const prevLine = document.getElementById('bubble-text').textContent;
  if (!recordNow(kind)) { homeToast.show(SAVE_FAILED); return; } // 保存できなければ記録済みにしない
  showRecordToast({ kind, prevLine, reactionLine: document.getElementById('bubble-text').textContent });
}

// ---------- ほかの記録（「…」から開く一覧。D-046） ----------
const sheet = document.getElementById('records-sheet');
function sheetButton(text, onClick, extra = '') {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'cut-btn quiet chip' + extra;
  b.textContent = text;
  b.addEventListener('click', onClick);
  return b;
}
function sheetAct(fn) {
  return () => {
    if (!fn()) { setSheetStatus(SAVE_FAILED); return; }
    setSheetStatus('');
    applyRecords();
  };
}
// 時刻を手で入れる（D-079）。鉛筆を押している間だけ、各行を時刻の欄と「入れる」にする
let sheetEditing = false;
function setSheetEditing(on) {
  sheetEditing = on;
  document.getElementById('records-sheet-edit').setAttribute('aria-pressed', String(on));
  document.getElementById('records-sheet-note').hidden = !on;
  setSheetStatus('');
  renderSheet();
}
function setSheetStatus(text, ok = false) {
  const el = document.getElementById('records-sheet-status');
  el.textContent = text;
  el.className = ok ? 'status ok' : 'status ng';
}
// 欄に初めに入れておく時刻：記録があればその時刻、なければ予定の時刻（まだ来ていなければ今）
function manualDefault(kind, st, now) {
  if (st.time) return st.time;
  const planned = ROUTINE_ITEMS.some(([id]) => id === kind) ? plannedMinutes(now)[kind] : null;
  if (planned !== null && planned <= logicalMinutes(now)) return `${pad(Math.floor(planned / 60) % 24)}:${pad(planned % 60)}`;
  return hm(now);
}
function saveManual(k, input) {
  const now = new Date();
  const time = input.value;
  if (!ROUTINE_TIME.test(time)) { setSheetStatus('時刻を入れてください'); input.focus(); return; }
  if (routineMinutes(time) > logicalMinutes(now)) { setSheetStatus('これから先の時刻は入れられません'); input.focus(); return; }
  if (Records.manualUsed(k.id, Records.day(now))) return;
  if (!Records.setManual(k.id, time, now)) { setSheetStatus(SAVE_FAILED); return; }
  applyRecords(now); // 一覧（手で入れたあとの形）とホームの記録ボタンを描き直す。キィニチは何も言わない（あとから入れることが多いため）
  setSheetStatus(`「${k.label}」を ${time} で入れました`, true);
}
function manualActs(k, st, used, now) {
  if (used) {
    const note = document.createElement('span');
    note.className = 'sheet-used';
    note.textContent = '今日は入れ済み';
    return [note];
  }
  const input = document.createElement('input');
  input.type = 'time';
  input.className = 'sheet-time';
  input.value = manualDefault(k.id, st, now);
  input.setAttribute('aria-label', `「${k.label}」の時刻`);
  return [input, sheetButton('入れる', () => saveManual(k, input), ' rec')];
}
function renderSheet(now = new Date()) {
  const day = Records.day(now);
  document.getElementById('records-sheet-title').textContent = `${labelLong(logicalDay(now))}の記録`;
  document.getElementById('records-list').replaceChildren(...RECORD_KINDS.map((k) => {
    const st = Records.status(k.id, day);
    const used = Records.manualUsed(k.id, day);
    const li = document.createElement('li');
    li.className = 'sheet-row' + (st.state === 'done' ? ' done' : st.state === 'skipped' ? ' skipped' : '');
    li.dataset.record = k.id;
    const body = document.createElement('span');
    body.className = 'sheet-body';
    const name = document.createElement('span');
    name.className = 'sheet-name';
    name.textContent = k.label;
    const state = document.createElement('span');
    state.className = 'sheet-state';
    state.textContent = (st.state === 'skipped' ? '今日はなし'
      : st.state === 'done' ? (k.repeat ? `✓ ${st.count}回・最後 ${st.time}` : `✓ ${st.time}`) : '未記録') + (used ? '（手入力）' : '');
    body.append(name, state);
    const acts = document.createElement('span');
    acts.className = 'sheet-acts';
    if (sheetEditing) {
      acts.append(...manualActs(k, st, used, now));
    } else if (st.state === 'skipped') {
      acts.append(sheetButton('なしをやめる', sheetAct(() => Records.skip(k.id, false))));
    } else if (st.state === 'done') {
      if (k.repeat) acts.append(sheetButton('もう1回', sheetAct(() => recordNow(k.id)), ' rec'));
      acts.append(sheetButton(k.repeat ? '1回取り消す' : '取り消す', sheetAct(() => Records.unset(k.id))));
    } else {
      acts.append(sheetButton('今日はなし', sheetAct(() => Records.skip(k.id, true)), ' skip'), sheetButton('記録', sheetAct(() => recordNow(k.id)), ' rec'));
    }
    li.append(body, acts);
    return li;
  }));
}
document.getElementById('records-more').addEventListener('click', () => {
  homeToast.hide();
  setSheetEditing(false); // 開くときはいつものボタンの形から
  sheet.showModal();
  document.getElementById('records-sheet-close').focus();
});
document.getElementById('records-sheet-close').addEventListener('click', () => sheet.close());
document.getElementById('records-sheet-edit').addEventListener('click', () => setSheetEditing(!sheetEditing));
sheet.addEventListener('click', (e) => { if (e.target === e.currentTarget) sheet.close(); }); // 枠の外を押すと閉じる
applyRecords();
// 毎日の時刻を変えたら、ホームの記録ボタンと次の予定を決め直す
window.addEventListener('routinechange', () => { applyRecords(); lastEventKey = ''; renderNextEvent(); });

// ---------- Google カレンダー（D-053） ----------
// 取れたら「仮」の印を消し、次の予定・予定画面を描き直す。仕様関連に状態を出す
function applyCalendar() {
  document.body.classList.toggle('calendar-on', Calendar.ready());
  setText('calendar-status', Calendar.statusText());
  const note = document.getElementById('calendar-note');
  note.hidden = !Calendar.ready();
  if (Calendar.ready()) {
    const c = Store.read(DB.calendar);
    note.textContent = `Google カレンダーの予定です（${hm(new Date(c.fetchedAt))} に取得）。生活の時刻は設定の「毎日の時刻」から出しています。`;
  }
}
window.addEventListener('calendarchange', () => { applyCalendar(); lastEventKey = ''; renderNextEvent(); if (typeof Schedule !== 'undefined') Schedule.refresh(); });
window.addEventListener('calendarstatus', applyCalendar);
document.getElementById('calendar-now').addEventListener('click', () => {
  setText('calendar-status', 'カレンダー：読んでいます…');
  Calendar.refresh(true).then(applyCalendar);
});
applyCalendar();

// ---------- 開いたときの判定し直し（P1-11, P1-12） ----------
// ホーム画面のアプリは裏から再開されることが多い。表示に戻ったときに、セリフ・主ボタン・記録・時間帯を判定し直す
const RESUME_REFRESH_MS = 10 * 60 * 1000; // 仮決定（D-019）
let hiddenAt = null;
function onResume(away) {
  const now = new Date();
  applyRecords(now);
  if (away >= RESUME_REFRESH_MS) { // 長く裏にあった：通知から開いた状態を終え、今の時間帯の一言に戻す
    homeToast.hide();
    endNotificationState();
    if (!offerEvening(now)) showIdle(now);
    checkPush(); // 購読が切れていないか確かめ直す
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
    const target = new URL(e.data.url, location.href);
    if (target.hash) location.hash = target.hash; // タイマー終了の通知は #timer を開く（D-028）
    dialogueReady.then(() => applyOpenParams(target.searchParams));
  });
  if (navigator.serviceWorker.startMessages) navigator.serviceWorker.startMessages();
}

// ---------- 設定：キィニチの一言のオン・オフ（D-047） ----------
// オフのときは、各機能画面の一言の面（dialogue-mini）を出さない。ホームのセリフと通知はそのまま
function setSwitch(id, on) {
  const b = document.getElementById(id);
  b.setAttribute('aria-checked', String(on));
  b.textContent = on ? 'オン' : 'オフ';
}
function applyScreenLines() {
  const on = Prefs.get('screenLines');
  document.body.classList.toggle('no-screen-lines', !on);
  setSwitch('pref-lines', on);
}
document.getElementById('pref-lines').addEventListener('click', () => {
  Prefs.set('screenLines', !Prefs.get('screenLines'));
  applyScreenLines();
});
applyScreenLines();
// 声掛けの通知のオン・オフ（D-049）。オフにすると、予約済みの声掛けも取り消す（タイマーの通知は別）
document.getElementById('pref-voice').addEventListener('click', () => {
  Prefs.set('voice', !Prefs.get('voice'));
  setSwitch('pref-voice', Prefs.get('voice'));
  window.dispatchEvent(new Event('routinechange'));
});
setSwitch('pref-voice', Prefs.get('voice'));
// 週次コメントのオン・オフ（D-058）
document.getElementById('pref-weekly').addEventListener('click', () => {
  Prefs.set('weekly', !Prefs.get('weekly'));
  setSwitch('pref-weekly', Prefs.get('weekly'));
});
setSwitch('pref-weekly', Prefs.get('weekly'));
// キィニチの話し方（D-082）。変えたら声掛けの通知の文も選び直す（notify.js が tonechange を聞く）
const TONE_NOTES = {
  client: 'あなたは仕事を頼んだ依頼人です。無愛想ですが礼儀正しく、仕事は確実です（はじめはこれ）。',
  friend: 'あなたは親しい友人です。言い方は短く、軽い皮肉や本音が少し混ざります。',
  sweet: 'あなたは気を許した相手です。手間を引き受け、休んでいいと言い、短く素直に褒めます。',
};
function applyTone() {
  const t = currentTone();
  for (const b of document.querySelectorAll('#view-settings [data-tone]')) b.setAttribute('aria-pressed', String(b.dataset.tone === t));
  setText('tone-note', TONE_NOTES[t]);
}
for (const b of document.querySelectorAll('#view-settings [data-tone]')) {
  b.addEventListener('click', () => {
    if (currentTone() === b.dataset.tone) return;
    Prefs.set('tone', b.dataset.tone);
    applyTone();
    window.dispatchEvent(new Event('tonechange'));
  });
}
applyTone();

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

// 購読が切れていないかを確かめ、切れていたら登録し直す（D-033）。
// 送信サーバーは、プッシュサービスに「購読が無効」と言われると購読を消す。そのままだと、利用者が設定で押し直すまで通知がすべて止まる。
// 設定済み・通知を許可済みのときだけ動く（許可ダイアログは出ない）。通信できないときは何もしない
let pushCheck = null;
function checkPush() {
  if (document.body.dataset.state !== 'ready' || !Settings.get('appToken')) return Promise.resolve(false);
  if (!('Notification' in window) || Notification.permission !== 'granted') return Promise.resolve(false);
  if (pushCheck) return pushCheck; // 同時に2回は動かさない
  pushCheck = Settings.api('/api/status')
    .then((st) => (st.subscribed === false ? repairPush() : false))
    .catch(() => false)
    .finally(() => { pushCheck = null; });
  return pushCheck;
}
// 登録し直す。できたら true。タイマーと声掛けから同時に呼ばれても1回だけ行う
let repairing = null;
function repairPush() {
  if (repairing) return repairing;
  repairing = enablePush()
    .then(() => { setText('push-status', '有効（送信サーバーに登録し直しました）', 'ok'); return true; })
    .catch((e) => { setText('push-status', '通知の登録が切れています。「通知を有効にする」を押してください（' + e.message + '）', 'ng'); return false; })
    .finally(() => { repairing = null; });
  return repairing;
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
        }).catch(() => {}).then(checkPush);
      }
    })
    .catch((e) => setText('sw-status', '登録失敗: ' + e.message, 'ng'));
} else {
  setText('sw-status', '非対応', 'ng');
}
