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
    try { localStorage.setItem(key, JSON.stringify(value)); return true; } catch (_) { return false; }
  },
  remove(key) {
    try { localStorage.removeItem(key); } catch (_) {}
  },
};
const SAVE_FAILED = '保存できませんでした。もう一度試してください';
