// 日報画面（D-026 ②, D-027）。1日1件、「今日の調子（3段階）・できたこと・やり残したこと・明日いちばんにやること」。
// 日付の区切りは朝4時（4時より前に書いた日報は前日の分。夜の時間帯 22〜4時と合わせる）。
// 保存は仮に localStorage（D-026 ⑤）。app.js の pad / dateStr / pickLine / dialogueReady を使う。

const Report = (() => {
  const KEY = 'reports.v1';
  const DAY_STARTS_AT = 4; // 時
  const HISTORY_SHOWN = 60;
  const MOODS = { good: '元気', normal: 'ふつう', tired: '疲れた' };
  const $ = (id) => document.getElementById(id);

  function load() {
    try {
      const r = JSON.parse(localStorage.getItem(KEY) || '{}');
      return r && typeof r === 'object' && !Array.isArray(r) ? r : {};
    } catch (_) { return {}; }
  }
  function save(all) {
    try { localStorage.setItem(KEY, JSON.stringify(all)); return true; } catch (_) { return false; }
  }
  // 日報の日付（4時より前は前日）
  function reportDate(now = new Date()) {
    const d = new Date(now);
    if (d.getHours() < DAY_STARTS_AT) d.setDate(d.getDate() - 1);
    return dateStr(d);
  }
  function dateLabel(key) {
    const [y, m, d] = key.split('-').map(Number);
    return new Date(y, m - 1, d).toLocaleDateString('ja-JP', { month: 'long', day: 'numeric', weekday: 'short' });
  }

  // ---------- 今日の日報のフォーム ----------
  let mood = null;
  function setMood(value) {
    mood = value;
    for (const b of document.querySelectorAll('#report-form .mood')) b.setAttribute('aria-pressed', String(b.dataset.mood === value));
  }
  let shownDate = null;
  function fillForm(now = new Date()) {
    const key = reportDate(now);
    if (key === shownDate) return; // 書きかけを消さないよう、日付が変わったときだけ入れ直す
    shownDate = key;
    const r = load()[key] || {};
    $('report-date').textContent = `${dateLabel(key)}の日報`;
    setMood(r.mood || null);
    $('report-done').value = r.done || '';
    $('report-left').value = r.left || '';
    $('report-tomorrow').value = r.tomorrow || '';
    $('report-status').textContent = r.savedAt ? `保存済み（${hm(new Date(r.savedAt))}）` : '';
    $('report-status').className = 'status';
    $('report-save').textContent = r.savedAt ? '更新する' : '保存する';
    $('report-reply').hidden = true;
  }

  // ---------- これまでの日報 ----------
  function item(key, r) {
    const li = document.createElement('li');
    const det = document.createElement('details');
    det.className = 'report-item';
    const sum = document.createElement('summary');
    const date = document.createElement('span');
    date.className = 'report-item-date';
    date.textContent = dateLabel(key);
    sum.append(date);
    if (r.mood && MOODS[r.mood]) {
      const m = document.createElement('span');
      m.className = 'report-item-mood';
      m.textContent = MOODS[r.mood];
      sum.append(m);
    }
    det.append(sum);
    const dl = document.createElement('dl');
    for (const [label, value] of [['できたこと', r.done], ['やり残したこと', r.left], ['明日いちばんにやること', r.tomorrow]]) {
      if (!value) continue;
      const dt = document.createElement('dt'); dt.textContent = label;
      const dd = document.createElement('dd'); dd.textContent = value;
      dl.append(dt, dd);
    }
    det.append(dl);
    li.append(det);
    return li;
  }
  function renderHistory(now = new Date()) {
    const all = load();
    const today = reportDate(now);
    const keys = Object.keys(all).filter((k) => k !== today && /^\d{4}-\d{2}-\d{2}$/.test(k)).sort().reverse().slice(0, HISTORY_SHOWN);
    $('report-list').replaceChildren(...keys.map((k) => item(k, all[k])));
    const empty = keys.length === 0;
    $('report-history-empty').hidden = !empty;
    if (empty) {
      dialogueReady.then(() => {
        const picked = pickLine('screen_empty.reports');
        $('report-history-empty').textContent = picked ? `キィニチ「${picked.text}」` : 'まだありません';
      });
    }
  }

  // ---------- 保存 ----------
  $('report-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const now = new Date();
    const entry = {
      mood,
      done: $('report-done').value.trim(),
      left: $('report-left').value.trim(),
      tomorrow: $('report-tomorrow').value.trim(),
    };
    if (!entry.mood && !entry.done && !entry.left && !entry.tomorrow) {
      $('report-status').textContent = '今日の調子か、どれか1つの項目を入れてください';
      $('report-status').className = 'status ng';
      return;
    }
    const key = reportDate(now);
    const all = load();
    all[key] = { ...entry, savedAt: now.getTime() };
    if (!save(all)) {
      $('report-status').textContent = '保存できませんでした。もう一度押してください';
      $('report-status').className = 'status ng';
      return;
    }
    $('report-status').textContent = `保存済み（${hm(now)}）`;
    $('report-status').className = 'status ok';
    $('report-save').textContent = '更新する';
    dialogueReady.then(() => {
      const picked = pickLine('report_saved.' + (entry.mood === 'good' || entry.mood === 'tired' ? entry.mood : 'normal'));
      if (!picked) return;
      $('report-reply-line').textContent = picked.text;
      $('report-reply').hidden = false;
    });
  });
  for (const b of document.querySelectorAll('#report-form .mood')) {
    b.addEventListener('click', () => setMood(mood === b.dataset.mood ? null : b.dataset.mood)); // もう一度押すと解除
  }

  function render(now = new Date()) {
    fillForm(now);
    renderHistory(now);
  }
  window.addEventListener('hashchange', () => { if (location.hash === '#report') render(); });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') render(); });
  render();

  return { load, reportDate, render };
})();
