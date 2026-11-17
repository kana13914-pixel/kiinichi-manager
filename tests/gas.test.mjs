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

test('毎日の時刻・タイマー・同期の控えは書き直す', () => {
  const g = loadGas();
  g.post(base({ routine: [['平日', '07:00', '07:30', '09:00', '12:00', '18:30', '19:30', '22:30', '23:30']], timers: [['作業', 50, '用途別（初めは25分）']] }));
  assert.equal(g.rows('毎日の時刻')[0][1], '07:00');
  assert.deepEqual(JSON.parse(JSON.stringify(g.rows('タイマー'))), [['作業', '50', '用途別（初めは25分）']]);
  assert.deepEqual(JSON.parse(JSON.stringify(g.rows('同期'))), [['最後に受け取った日時', '2026-11-17 10:00'], ['アプリの版', 'phase2-v7']]);
});
