// 各画面が共通で使う小道具（日付・保存）。画面には触らない。index.html で最初に読み込む。

function pad(n) { return String(n).padStart(2, '0'); }
function hm(d) { return `${pad(d.getHours())}:${pad(d.getMinutes())}`; }
function dateStr(d) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
// n 日後の同じ時刻
function addDays(d, n) { const x = new Date(d); x.setDate(x.getDate() + n); return x; }
// その日の 0 時
function startOfDay(d) { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; }
// 'YYYY-MM-DD' → その日の 0 時
function parseDay(key) { const [y, m, d] = key.split('-').map(Number); return new Date(y, m - 1, d); }
// 日付の表示：短い「11/20(金)」、長い「11月20日(金)」
function labelShort(d) { return d.toLocaleDateString('ja-JP', { month: 'numeric', day: 'numeric', weekday: 'short' }); }
function labelLong(d) { return d.toLocaleDateString('ja-JP', { month: 'long', day: 'numeric', weekday: 'short' }); }

// ---------- 1日の区切り（D-034） ----------
// 記録・日報・タスクの期限と完了日・通知のキーは、朝4時で日付を区切る（深夜1時は「前の日」）。
// 予定画面と「次の予定」は暦どおり（0時区切り）のまま。
const DAY_STARTS_AT = 4; // 時
// その時刻が属する日（0時の Date）
function logicalDay(now = new Date()) {
  const d = startOfDay(now);
  if (now.getHours() < DAY_STARTS_AT) d.setDate(d.getDate() - 1);
  return d;
}
// その時刻が属する日の 'YYYY-MM-DD'
function todayKey(now = new Date()) { return dateStr(logicalDay(now)); }

function newId() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }

// ---------- 端末内の保存（localStorage。フェーズ2で保存先を変えるときは、ここを差し替える） ----------
const Store = {
  // 読めない・壊れているときは fallback
  read(key, fallback = null) {
    try {
      const raw = localStorage.getItem(key);
      return raw === null ? fallback : JSON.parse(raw);
    } catch (_) { return fallback; }
  },
  // 保存できたら true。失敗（容量超過など）しても例外は出さない。呼び出し側が false を見て画面に知らせる
  write(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch (_) { return false; }
    // スプレッドシートに控えるデータが変わったことを知らせる（sync.js。D-050）
    if (SYNCED.includes(key)) window.dispatchEvent(new CustomEvent('datachange', { detail: key }));
    return true;
  },
  remove(key) {
    try { localStorage.removeItem(key); } catch (_) {}
  },
};
const SAVE_FAILED = '保存できませんでした。もう一度試してください';

// ---------- 保存の形（D-043。項目の一覧は docs/data_schema.md） ----------
// データのキーは db.* にそろえ、db.meta.schema に形の版を持つ。形を変えるときは MIGRATIONS に 1 つ足す。
const DB = {
  meta: 'db.meta',               // { schema: 2 }
  tasks: 'db.tasks',             // [ { id, title, due, priority, subtasks: [ { id, title, done, doneAt } ], done, doneAt, createdAt, updatedAt, toReport } ]
  reports: 'db.reports',         // { 'YYYY-MM-DD': { mood, done, left, tomorrow, savedAt } }
  reportDraft: 'db.reportDraft', // { date, mood, done, left, tomorrow } … 保存前の書きかけ（この端末だけ）
  records: 'db.records',         // { 'YYYY-MM-DD': { wake: { time: '07:12', at: 1794190000000 }, … } } … 日付は朝4時区切り
  timer: 'db.timer',             // { custom: [ { id, name, minutes } ], builtin, running, done, cancelPending }
  routineOverrides: 'db.routineOverrides', // { 'YYYY-MM-DD': { 項目: 'HH:MM' か null } } … 毎日の時刻をその日だけ変えたもの（D-060 ⑭）
  routine: 'db.routine',         // { weekday: { wake: '07:00', … }, holiday: { … }, holidays: [0, 6], updatedAt } … 毎日の時刻（D-048）
  prefs: 'db.prefs',             // { screenLines: true, voice: true, weekly: true, taskFolded: [], tone: 'client' } … 端末ごとの好み（D-047, D-049, D-082）
  sync: 'db.sync',               // { url, token, lastAt, lastSig, dirty, error } … スプレッドシートへの控えの送り先と状態（D-050。この端末だけ）
  calendar: 'db.calendar',       // { fetchedAt, from, to, events: [ { title, start, end, allDay } ], error } … カレンダーの予定の控え（D-053。この端末だけ）
  calendarError: 'db.calendarError', // 一度も取れていないときの理由
  weekly: 'db.weekly',           // { 週の初めの日付: { text, at } } … 週次コメント（D-058）
  stats: 'db.stats',             // { days: { 日付: { notified, missed, skipped, unused } }, closedThrough, lineShown } … 内部の記録（D-060 ⑩。この端末だけ・見せない）
  portrait: 'db.portrait',     // { w, h, alpha, scale, x, y, ui, at } … 写真から選んだ立ち絵の置き方と部品の透け具合（D-066, D-067。画像は IndexedDB。この端末だけ）
  evening: 'db.evening',         // { date } … 夕方の提案をホームで出した日（その日1回だけにするため。D-073。この端末だけ）
  touch: 'db.touch',             // { mutedUntil, stoppedAt, muteLevel, lastAt } … 触る段階の打ち切りの黙る時間（D-087, D-088。閉じても覚える。この端末だけ）
  scenes: 'db.scenes',           // { first, since, shown: { キー: 日付 }, tasksSeen: { date, done } } … ホームを開いたときの場面（D-083。この端末だけ）
  blocks: 'db.blocks',           // [ { id, date, start, end, kind, title, taskId, color } ] … 1日の輪に置いた時間（D-112。スプレッドシートに控え）
  notify: 'db.notify',           // { 予約したキー: { at, body } } … 送信サーバーに予約した声掛け（D-049。この端末だけ）
};
const SCHEMA = 2;
// スプレッドシートに控えるデータ（D-050）
const SYNCED = [DB.tasks, DB.reports, DB.records, DB.routine, DB.routineOverrides, DB.timer, DB.blocks]; // blocks：1日の輪に置いた時間（D-112）
const MIGRATIONS = {
  // 1（フェーズ1の仮の保存先）→ 2：キーを db.* に移す。記録は当日分だけだったものを、日付ごとの履歴にする
  2() {
    const moves = [['tasks.v1', DB.tasks], ['reports.v1', DB.reports], ['reports.draft', DB.reportDraft], ['timer.v1', DB.timer]];
    for (const [from, to] of moves) {
      const old = Store.read(from);
      if (old === null || Store.read(to) !== null) continue; // 新しいほうにもうあれば、そちらを残す
      if (from === 'tasks.v1' && Array.isArray(old)) {
        for (const t of old) if (t && !t.updatedAt) t.updatedAt = t.doneAt || t.createdAt || Date.now();
      }
      if (!Store.write(to, old)) return false;
    }
    const today = Store.read('records.today');
    if (today && typeof today.date === 'string' && today.items && Store.read(DB.records) === null) {
      const day = {};
      for (const [kind, time] of Object.entries(today.items)) {
        if (typeof time === 'string') day[kind] = { time, at: parseDay(today.date).getTime() };
      }
      if (!Store.write(DB.records, { [today.date]: day })) return false;
    }
    for (const key of ['tasks.v1', 'reports.v1', 'reports.draft', 'timer.v1', 'records.today']) Store.remove(key);
    return true;
  },
};
// 起動のたびに呼ぶ。済んでいれば何もしない。途中で保存に失敗したら版を上げず、次に開いたときにやり直す（元のデータは消さない）
function migrateData() {
  const meta = Store.read(DB.meta);
  let schema = meta && Number.isInteger(meta.schema) ? meta.schema : 1;
  while (schema < SCHEMA) {
    if (!MIGRATIONS[schema + 1]()) return false;
    schema += 1;
    if (!Store.write(DB.meta, { schema, migratedAt: Date.now() })) return false;
  }
  return true;
}
migrateData();

// ---------- 端末ごとの好み（D-047）。決まっていないものは既定値 ----------
// callModes：毎日の時刻の項目ごとの声掛け 'on'（時刻ちょうど）・'late'（30分後、まだ記録がなければ）・'off'（D-098）。はじめは今までと同じ
const CALL_DEFAULTS = { wake: 'off', breakfast: 'late', work_start: 'off', lunch: 'late', work_end: 'off', dinner: 'late', bath: 'off', sleep: 'on' };
// routineView：予定の一覧での毎日の時刻の出し方 'all'（ほかの予定と同じ）・'compact'（1行にまとめ、押すと開く）・'hidden'（出さない）（D-101）
// ringColors：1日の輪の項目ごとの色（D-111。{ sleep: 'c1', … }。ないものははじめの色）
const PREF_DEFAULTS = { screenLines: true, voice: true, weekly: true, taskFolded: [], tone: 'client', callModes: CALL_DEFAULTS, routineView: 'compact', ringColors: {} }; // taskFolded：タスクのたたんだ優先度（D-070）。tone：話し方（D-082）
const Prefs = {
  get(name) {
    const p = Store.read(DB.prefs, {});
    return p && typeof p === 'object' && typeof p[name] === typeof PREF_DEFAULTS[name] ? p[name] : PREF_DEFAULTS[name];
  },
  set(name, value) {
    const p = Store.read(DB.prefs, {});
    return Store.write(DB.prefs, { ...(p && typeof p === 'object' ? p : {}), [name]: value });
  },
  // 項目ごとの声掛け（D-098）。知らない値・ない項目は既定値
  callMode(id) {
    const m = this.get('callModes');
    return m && ['on', 'late', 'off'].includes(m[id]) ? m[id] : CALL_DEFAULTS[id];
  },
  setCallMode(id, mode) { return this.set('callModes', { ...CALL_DEFAULTS, ...this.get('callModes'), [id]: mode }); },
};
