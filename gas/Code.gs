// キィニチくん専属マネージャー：スプレッドシートへの控え（Google Apps Script。D-050）
//
// ・控え用のスプレッドシートの「拡張機能 → Apps Script」に、このファイルの中身を丸ごと貼り付けて使う（手順は docs/gas_setup.md）
// ・スクリプト プロパティ SYNC_TOKEN … アプリの設定で入れる合言葉と同じ文字列。コードやリポジトリには書かない
// ・ウェブアプリとしてデプロイし、その URL をアプリの設定に入れる
// ・Google カレンダーの予定を読んでアプリに返す（action: 'events'。読むだけ。app/calendar.js。D-053）
//   スクリプト プロパティ CALENDAR_IDS（任意）… 読むカレンダーの ID をカンマ区切り。なければ既定のカレンダー
// ・アプリ（app/sync.js）が端末のデータを送ってくる。ここでは書き込むだけで、アプリへは返さない（端末が正本。D-004）
//   消えないように：記録は届いた日付の分だけ入れ替える／日報は日付ごとに上書き／タスクは id ごとに上書きし、端末から消えたものは行を残して日時を付ける

var SHEET = {
  records: ['記録', ['日付', '種類', '名前', '時刻', '回目', '状態', '記録した日時']],
  reports: ['日報', ['日付', '調子', 'できたこと', 'やり残したこと', '明日いちばんにやること', '保存した日時']],
  tasks: ['タスク', ['id', 'やること', '期限', '状態', '完了した日時', '作った日時', '最後に変えた日時', '端末から消えた日時']],
  routine: ['毎日の時刻', ['区分', '起床', '朝食', '仕事開始', '昼食', '仕事終わり', '夕食', '入浴', '就寝']],
  timers: ['タイマー', ['名前', '分', '種類']],
  meta: ['同期', ['項目', '値']],
};

function doGet() {
  return out_({ ok: true, name: 'kiinichi sync' });
}

function doPost(e) {
  var p;
  try { p = JSON.parse(e.postData.contents); } catch (err) { return out_({ error: '送られてきた形式が正しくありません' }); }
  var token = PropertiesService.getScriptProperties().getProperty('SYNC_TOKEN');
  if (!token) return out_({ error: 'スクリプト プロパティ SYNC_TOKEN が未設定です' });
  if (!p || typeof p.token !== 'string' || !same_(p.token, token)) return out_({ error: '合言葉が違います' });
  if (p.action === 'events') return out_(events_(p.from, p.to));
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    writeRecords_(ss, p.records || {});
    writeReports_(ss, p.reports || []);
    writeTasks_(ss, p.tasks || [], p.sentAt || '');
    if (p.routine) replace_(ss, SHEET.routine, p.routine);
    if (p.timers) replace_(ss, SHEET.timers, p.timers);
    replace_(ss, SHEET.meta, [['最後に受け取った日時', p.sentAt || ''], ['アプリの版', p.app || '']]);
  } finally {
    lock.releaseLock();
  }
  return out_({ ok: true });
}

// 記録：届いた日付の行だけ入れ替え、ほかの日付の行は残す
function writeRecords_(ss, byDate) {
  var rows = read_(ss, SHEET.records).filter(function (r) { return !Object.prototype.hasOwnProperty.call(byDate, String(r[0])); });
  Object.keys(byDate).forEach(function (date) {
    (byDate[date] || []).forEach(function (r) { rows.push([date, r.kind, r.label, r.time, r.n, r.state, r.at]); });
  });
  rows.sort(function (a, b) { return String(a[0]) < String(b[0]) ? -1 : String(a[0]) > String(b[0]) ? 1 : 0; });
  replace_(ss, SHEET.records, rows);
}

// 日報：日付ごとに上書き
function writeReports_(ss, reports) {
  var byDate = {};
  read_(ss, SHEET.reports).forEach(function (r) { byDate[String(r[0])] = r; });
  reports.forEach(function (r) { byDate[r.date] = [r.date, r.mood, r.done, r.left, r.tomorrow, r.savedAt]; });
  replace_(ss, SHEET.reports, Object.keys(byDate).sort().map(function (k) { return byDate[k]; }));
}

// タスク：id ごとに上書き。端末から消えたものは行を残し、消えた日時を付ける
function writeTasks_(ss, tasks, sentAt) {
  var seen = {};
  var rows = [];
  var byId = {};
  tasks.forEach(function (t) { byId[t.id] = t; });
  read_(ss, SHEET.tasks).forEach(function (r) {
    var id = String(r[0]);
    var t = byId[id];
    if (t) { rows.push(taskRow_(t)); seen[id] = true; } else { if (!r[7]) r[7] = sentAt; rows.push(r); }
  });
  tasks.forEach(function (t) { if (!seen[t.id]) rows.push(taskRow_(t)); });
  replace_(ss, SHEET.tasks, rows);
}
function taskRow_(t) { return [t.id, t.title, t.due, t.state, t.doneAt, t.createdAt, t.updatedAt, '']; }

// カレンダーの予定を読む（読むだけ）。範囲は最大 130 日
var MAX_RANGE_MS = 130 * 24 * 3600 * 1000;
function events_(from, to) {
  from = Number(from); to = Number(to);
  if (!isFinite(from) || !isFinite(to) || to <= from || to - from > MAX_RANGE_MS) return { error: '読む範囲が正しくありません' };
  var ids = String(PropertiesService.getScriptProperties().getProperty('CALENDAR_IDS') || '')
    .split(',').map(function (x) { return x.trim(); }).filter(function (x) { return x; });
  var cals = ids.length ? ids.map(function (id) { return CalendarApp.getCalendarById(id); }).filter(function (c) { return c; })
    : [CalendarApp.getDefaultCalendar()];
  var events = [];
  cals.forEach(function (cal) {
    cal.getEvents(new Date(from), new Date(to)).forEach(function (ev) {
      events.push({ title: ev.getTitle(), start: ev.getStartTime().getTime(), end: ev.getEndTime().getTime(), allDay: ev.isAllDayEvent() });
    });
  });
  return { ok: true, events: events };
}

// 初めて使うとき・コードを更新したときに、Apps Script の画面でこの関数を選んで「実行」し、カレンダーを読む許可を与える
function checkCalendar() {
  var now = Date.now();
  var r = events_(now, now + 7 * 24 * 3600 * 1000);
  Logger.log(r.error ? r.error : '今日から7日の予定：' + r.events.length + '件');
}

// ---------- 小道具 ----------
function sheet_(ss, def) {
  var sh = ss.getSheetByName(def[0]);
  if (!sh) sh = ss.insertSheet(def[0]);
  return sh;
}
function read_(ss, def) {
  var sh = sheet_(ss, def);
  var n = sh.getLastRow();
  if (n < 2) return [];
  return sh.getRange(2, 1, n - 1, def[1].length).getValues();
}
// 見出し＋行で、シートを書き直す。日付や時刻が勝手に変換されないよう、文字として書く
function replace_(ss, def, rows) {
  var sh = sheet_(ss, def);
  var all = [def[1]].concat(rows.map(function (r) {
    return def[1].map(function (_, i) { return r[i] === undefined || r[i] === null ? '' : String(r[i]); });
  }));
  sh.clearContents();
  var range = sh.getRange(1, 1, all.length, def[1].length);
  range.setNumberFormat('@');
  range.setValues(all);
}
function same_(a, b) {
  if (a.length !== b.length) return false;
  var diff = 0;
  for (var i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
function out_(data) {
  return ContentService.createTextOutput(JSON.stringify(data)).setMimeType(ContentService.MimeType.JSON);
}
