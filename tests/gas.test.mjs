// スプレッドシートへの控え（gas/Code.gs）の検証。GAS の道具（SpreadsheetApp など）を偽物にして、Node で実行する。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

function makeSheet(name) {
  let cells = [];
  return {
    name, cells: () => cells,
    getLastRow: () => cells.length,
    clearContents() { cells = []; },
    getRange(row, col, nrows, ncols) {
      return {
        setNumberFormat() { return this; },
        setValues(values) {
          assert.equal(values.length, nrows);
          values.forEach((v, i) => { assert.equal(v.length, ncols); cells[row - 1 + i] = v.slice(); });
          return this;
        },
        getValues() { return cells.slice(row - 1, row - 1 + nrows).map((r) => r.slice(col - 1, col - 1 + ncols)); },
      };
    },
  };
}
function loadGas(token = 'sync-secret') {
  const sheets = {};
  const ss = { getSheetByName: (n) => sheets[n] || null, insertSheet: (n) => (sheets[n] = makeSheet(n)) };
  const ctx = {
    SpreadsheetApp: { getActiveSpreadsheet: () => ss },
    PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => (k === 'SYNC_TOKEN' ? token : null) }) },
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
    ContentService: { MimeType: { JSON: 'json' }, createTextOutput: (s) => ({ text: s, setMimeType() { return this; } }) },
  };
  vm.runInNewContext(readFileSync(new URL('../gas/Code.gs', import.meta.url), 'utf8'), ctx);
  const post = (body) => JSON.parse(ctx.doPost({ postData: { contents: JSON.stringify(body) } }).text);
  const rows = (n) => sheets[n].cells().slice(1);
  return { ctx, post, rows, sheets };
}
const base = (over = {}) => ({ token: 'sync-secret', sentAt: '2026-11-17 10:00', app: 'phase2-v7', records: {}, reports: [], tasks: [], ...over });

test('合言葉が違う・形式が違うときは書き込まない', () => {
  const g = loadGas();
  assert.match(g.post(base({ token: 'wrong' })).error, /合言葉/);
  assert.deepEqual(g.sheets, {});
  assert.match(JSON.parse(g.ctx.doPost({ postData: { contents: '{' } }).text).error, /形式/);
  assert.match(loadGas(null).post(base()).error, /SYNC_TOKEN/);
});

test('記録：届いた日付の行だけ入れ替え、ほかの日付は残す（端末を入れ直しても消えない）', () => {
  const g = loadGas();
  const r = (kind, time, n = 1) => ({ kind, label: kind, time, n, state: '記録', at: '2026-11-09 ' + time });
  assert.equal(g.post(base({ records: { '2026-11-09': [r('wake', '07:10')], '2026-11-10': [r('wake', '07:00'), r('break', '15:00', 1), r('break', '16:00', 2)] } })).ok, true);
  assert.equal(g.rows('記録').length, 4);
  g.post(base({ records: { '2026-11-10': [r('wake', '07:00')] } })); // 10日の休憩を取り消した。9日は届いていない
  assert.deepEqual(JSON.parse(JSON.stringify(g.rows('記録').map((x) => [x[0], x[1], x[3]]))), [['2026-11-09', 'wake', '07:10'], ['2026-11-10', 'wake', '07:00']]);
  assert.deepEqual(JSON.parse(JSON.stringify(g.sheets['記録'].cells()[0])), ['日付', '種類', '名前', '時刻', '回目', '状態', '記録した日時']);
});

test('日報は日付ごとに上書き、タスクは id ごとに上書きして消えたものに日時を付ける', () => {
  const g = loadGas();
  const t = (id, title, state = '未完了') => ({ id, title, due: '', state, doneAt: '', createdAt: '', updatedAt: '' });
  g.post(base({ reports: [{ date: '2026-11-09', mood: '元気', done: 'a', left: '', tomorrow: '', savedAt: '' }], tasks: [t('a', '洗濯'), t('b', '買い物')] }));
  g.post(base({ sentAt: '2026-11-18 09:00', reports: [{ date: '2026-11-10', mood: '疲れた', done: 'b', left: '', tomorrow: '', savedAt: '' }], tasks: [t('a', '洗濯', '完了')] }));
  assert.deepEqual(JSON.parse(JSON.stringify(g.rows('日報').map((x) => [x[0], x[1]]))), [['2026-11-09', '元気'], ['2026-11-10', '疲れた']]);
  assert.deepEqual(JSON.parse(JSON.stringify(g.rows('タスク').map((x) => [x[0], x[3], x[7]]))), [['a', '完了', ''], ['b', '未完了', '2026-11-18 09:00']]);
  g.post(base({ sentAt: '2026-11-19 09:00', tasks: [t('a', '洗濯', '完了')] })); // 消えた日時は最初のまま
  assert.equal(g.rows('タスク')[1][7], '2026-11-18 09:00');
});

test('タスクの優先度は最後の列、ミニタスクは別のシートに書き直す（D-070）', () => {
  const g = loadGas();
  const t = { id: 'a', title: '旅行', due: '', state: '未完了', doneAt: '', createdAt: '', updatedAt: '', priority: '高' };
  const sub = (id, title, state = '未完了') => ({ parentId: 'a', parentTitle: '旅行', id, title, state, doneAt: '' });
  g.post(base({ tasks: [t], subtasks: [sub('s1', '宿', '済み'), sub('s2', '切符')] }));
  assert.equal(g.sheets['タスク'].cells()[0][8], '優先度');
  assert.equal(g.rows('タスク')[0][8], '高');
  assert.deepEqual(JSON.parse(JSON.stringify(g.sheets['ミニタスク'].cells()[0])), ['親のid', '親のやること', 'id', '名前', '状態', '済みにした日時']);
  assert.deepEqual(JSON.parse(JSON.stringify(g.rows('ミニタスク').map((x) => [x[0], x[3], x[4]]))), [['a', '宿', '済み'], ['a', '切符', '未完了']]);
  g.post(base({ tasks: [t], subtasks: [sub('s2', '切符')] })); // 消したミニタスクは残さない
  assert.deepEqual(JSON.parse(JSON.stringify(g.rows('ミニタスク').map((x) => x[2]))), ['s2']);
  g.post(base({ tasks: [t] })); // 古いアプリ（ミニタスクを送らない）からは書き換えない
  assert.equal(g.rows('ミニタスク').length, 1);
});

test('毎日の時刻・タイマー・同期の控えは書き直す', () => {
  const g = loadGas();
  g.post(base({ routine: [['平日', '07:00', '07:30', '09:00', '12:00', '18:30', '19:30', '22:30', '23:30']], timers: [['作業', 50, '用途別（初めは25分）']] }));
  assert.equal(g.rows('毎日の時刻')[0][1], '07:00');
  assert.deepEqual(JSON.parse(JSON.stringify(g.rows('タイマー'))), [['作業', '50', '用途別（初めは25分）']]);
  assert.deepEqual(JSON.parse(JSON.stringify(g.rows('同期'))), [['最後に受け取った日時', '2026-11-17 10:00'], ['アプリの版', 'phase2-v7']]);
});

test('カレンダーの予定を読む（読むだけ。合言葉が必要、範囲は130日まで、CALENDAR_IDS があればそのカレンダー）', () => {
  const ev = (title, s, e, allDay = false) => ({ getId: () => title + '@g', getTitle: () => title, getStartTime: () => new Date(s), getEndTime: () => new Date(e), isAllDayEvent: () => allDay, isRecurringEvent: () => false, isOwnedByMe: () => true });
  const asked = [];
  const cal = (name, list) => ({ getId: () => name, getEvents: (from, to) => { asked.push([name, from.getTime(), to.getTime()]); return list; } });
  const g = loadGas();
  g.ctx.CalendarApp = {
    getDefaultCalendar: () => cal('default', [ev('歯医者', 1000, 2000), ev('旅行', 0, 86400000, true)]),
    getCalendarById: (id) => (id === 'work@example.com' ? cal('work', [ev('会議', 3000, 4000)]) : null),
  };
  const day = 86400000;
  const r = g.post({ token: 'sync-secret', action: 'events', from: 0, to: 40 * day });
  assert.deepEqual(JSON.parse(JSON.stringify(r)), { ok: true, events: [
    { id: '歯医者@g', calendarId: 'default', title: '歯医者', start: 1000, end: 2000, allDay: false, editable: true },
    { id: '旅行@g', calendarId: 'default', title: '旅行', start: 0, end: day, allDay: true, editable: true }] });
  assert.deepEqual(asked, [['default', 0, 40 * day]]);
  assert.deepEqual(g.sheets, {}); // 読むだけ。シートには書かない
  assert.match(g.post({ token: 'wrong', action: 'events', from: 0, to: day }).error, /合言葉/);
  assert.match(g.post({ token: 'sync-secret', action: 'events', from: 0, to: 200 * day }).error, /範囲/);
  // CALENDAR_IDS
  const g2 = loadGas();
  g2.ctx.PropertiesService = { getScriptProperties: () => ({ getProperty: (k) => ({ SYNC_TOKEN: 'sync-secret', CALENDAR_IDS: 'work@example.com, nothing' }[k] || null) }) };
  g2.ctx.CalendarApp = g.ctx.CalendarApp;
  assert.deepEqual(g2.post({ token: 'sync-secret', action: 'events', from: 0, to: day }).events.map((e) => e.title), ['会議']);
});

test('予定を足す・直す・消す（既定のカレンダー。繰り返し・招待された予定は変えない）', () => {
  const store = {};
  let n = 0;
  const mk = (title, s, e, allDay, extra = {}) => {
    const ev = { id: 'ev' + (++n), title, s, e, allDay, recurring: false, mine: true, deleted: false, ...extra };
    store[ev.id] = ev;
    return {
      getId: () => ev.id, getTitle: () => ev.title, getStartTime: () => new Date(ev.s), getEndTime: () => new Date(ev.e),
      isAllDayEvent: () => ev.allDay, isRecurringEvent: () => ev.recurring, isOwnedByMe: () => ev.mine,
      setTitle: (t) => { ev.title = t; }, setTime: (a, b) => { ev.s = a.getTime(); ev.e = b.getTime(); ev.allDay = false; },
      setAllDayDates: (a, b) => { ev.s = a.getTime(); ev.e = b.getTime(); ev.allDay = true; }, deleteEvent: () => { ev.deleted = true; },
    };
  };
  const handles = {};
  const cal = {
    getId: () => 'me@example.com',
    createEvent: (t, a, b) => { const h = mk(t, a.getTime(), b.getTime(), false); handles[h.getId()] = h; return h; },
    createAllDayEvent: (t, a, b) => { const h = mk(t, a.getTime(), b.getTime(), true); handles[h.getId()] = h; return h; },
    getEventById: (id) => handles[id] || null,
  };
  const g = loadGas();
  g.ctx.CalendarApp = { getDefaultCalendar: () => cal, getCalendarById: (id) => (id === 'me@example.com' ? cal : null) };
  const post = (b) => JSON.parse(JSON.stringify(g.post({ token: 'sync-secret', ...b })));
  const a = post({ action: 'add', title: ' 歯医者 ', start: 1000, end: 2000, allDay: false });
  assert.deepEqual(a.event, { id: 'ev1', calendarId: 'me@example.com', title: '歯医者', start: 1000, end: 2000, allDay: false, editable: true });
  const b = post({ action: 'add', title: '旅行', start: 0, end: 2 * 86400000, allDay: true });
  assert.equal(store[b.event.id].allDay, true);
  assert.equal(post({ action: 'update', id: 'ev1', calendarId: 'me@example.com', title: '歯医者（変更）', start: 3000, end: 4000 }).event.title, '歯医者（変更）');
  assert.deepEqual([store.ev1.s, store.ev1.e], [3000, 4000]);
  assert.equal(post({ action: 'remove', id: 'ev1', calendarId: 'me@example.com' }).ok, true);
  assert.equal(store.ev1.deleted, true);
  // 入力の誤り・見つからない・繰り返し・招待
  assert.match(post({ action: 'add', title: '', start: 1, end: 2 }).error, /名前/);
  assert.match(post({ action: 'add', title: 'x', start: 2, end: 1 }).error, /日時/);
  assert.match(post({ action: 'remove', id: 'nothing' }).error, /見つかりません/);
  const r = cal.createEvent('毎週の会議', new Date(1), new Date(2)); store[r.getId()].recurring = true;
  assert.match(post({ action: 'remove', id: r.getId() }).error, /直せません/);
  assert.equal(store[r.getId()].deleted, false);
  const i = cal.createEvent('招待', new Date(1), new Date(2)); store[i.getId()].mine = false;
  assert.match(post({ action: 'update', id: i.getId(), title: 'x', start: 1, end: 2 }).error, /直せません/);
  assert.match(g.post({ token: 'wrong', action: 'add', title: 'x', start: 1, end: 2 }).error, /合言葉/);
});
