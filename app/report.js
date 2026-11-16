// 日報画面（D-026 ②, D-027）。1日1件、「今日の調子（3段階）・できたこと・やり残したこと・明日いちばんにやること」。
// 日付の区切りは朝4時（4時より前に書いた日報は前日の分。D-027, D-034）。
// 書きかけは入力のたびに端末に保存し、開き直したら戻す（D-033）。
// 保存は localStorage の db.reports（D-043。形は docs/data_schema.md）。util.js（日付・保存）、dialogue.js（セリフ）、ui.js を使う。

const Report = (() => {
  const KEY = DB.reports;
  const DRAFT_KEY = DB.reportDraft; // { date, mood, done, left, tomorrow } … 保存前の書きかけ（1件だけ）
  const HISTORY_STEP = 7; // 「これまでの日報」は7日分ずつ出す（D-031）。データは消さない
  const MOODS = { good: '元気', normal: 'ふつう', tired: '疲れた' };
  const $ = (id) => document.getElementById(id);

  function load() {
    const r = Store.read(KEY, {});
    return r && typeof r === 'object' && !Array.isArray(r) ? r : {};
  }
  function save(all) { return Store.write(KEY, all); }
  const reportDate = todayKey; // 日報の日付（4時より前は前日）
  function dateLabel(key) { return labelLong(parseDay(key)); }
  function hasContent(e) { return Boolean(e && (e.mood || e.done || e.left || e.tomorrow)); }

  // ---------- 書きかけ（D-033） ----------
  function loadDraft() {
    const d = Store.read(DRAFT_KEY);
    return d && typeof d === 'object' && typeof d.date === 'string' ? d : null;
  }
  function formEntry() {
    return {
      mood,
      done: $('report-done').value.trim(),
      left: $('report-left').value.trim(),
      tomorrow: $('report-tomorrow').value.trim(),
    };
  }
  // 入力のたびに呼ぶ。iPhone は裏に回したアプリをよく終了させるので、保存ボタンを押す前の文も残す
  function saveDraft() {
    if (!shownDate) return;
    Store.write(DRAFT_KEY, { date: shownDate, mood, done: $('report-done').value, left: $('report-left').value, tomorrow: $('report-tomorrow').value });
  }
  // 日付が変わったあとに前の日の書きかけが残っていたら、その日の日報として保存する（消さない）
  function keepOldDraft(today) {
    const d = loadDraft();
    if (!d || d.date === today) return;
    const entry = { mood: d.mood || null, done: String(d.done || '').trim(), left: String(d.left || '').trim(), tomorrow: String(d.tomorrow || '').trim() };
    if (hasContent(entry)) {
      const all = load();
      all[d.date] = { ...entry, savedAt: Date.now() };
      if (!save(all)) return; // 保存できなければ書きかけを残す
    }
    Store.remove(DRAFT_KEY);
  }

  // ---------- 今日の日報のフォーム ----------
  let mood = null;
  function setMood(value) {
    mood = value;
    for (const b of document.querySelectorAll('#report-form .mood')) b.setAttribute('aria-pressed', String(b.dataset.mood === value));
  }
  // 画面を開いたときの一言（Q-A）：今日の分をまだ保存していない／保存済み。保存した直後は、返事（report_saved.*）だけを出す（C10-02）
  const say = makeSay($('report-say-line'));
  function renderSay() {
    const replying = !$('report-reply').hidden;
    $('report-say').hidden = replying;
    if (!replying) say((load()[shownDate] || {}).savedAt ? 'report_status.saved' : 'report_status.not_yet');
  }

  let shownDate = null;
  function fillForm(now = new Date()) {
    const key = reportDate(now);
    if (key === shownDate) return; // 書きかけを消さないよう、日付が変わったときだけ入れ直す
    keepOldDraft(key);
    shownDate = key;
    const saved = load()[key] || {};
    const draft = loadDraft();
    const r = draft || saved; // 書きかけがあれば、そちらを出す
    $('report-date').textContent = `${dateLabel(key)}の日報`;
    setMood(r.mood || null);
    $('report-done').value = r.done || '';
    $('report-left').value = r.left || '';
    $('report-tomorrow').value = r.tomorrow || '';
    $('report-status').textContent = draft ? '書きかけを戻しました（まだ保存していません）' : saved.savedAt ? `保存済み（${hm(new Date(saved.savedAt))}）` : '';
    $('report-status').className = 'status';
    $('report-save').textContent = saved.savedAt ? '更新する' : '保存する';
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
  // 調子の 7 日（CR-G03）：今日（4時区切り）までの 7 日。書いていない日は枠だけ
  const WEEK = ['日', '月', '火', '水', '木', '金', '土'];
  function renderMoodWeek(all, now = new Date()) {
    const base = logicalDay(now);
    const cells = [];
    const spoken = [];
    for (let i = 6; i >= 0; i -= 1) {
      const d = addDays(base, -i);
      const key = dateStr(d);
      const m = all[key] && MOODS[all[key].mood] ? all[key].mood : null;
      const cell = document.createElement('span');
      cell.className = 'mood-day';
      if (m) cell.dataset.mood = m;
      const mark = document.createElement('i');
      const day = document.createElement('b');
      day.textContent = WEEK[d.getDay()];
      cell.append(mark, day);
      cells.push(cell);
      spoken.push(`${d.getMonth() + 1}/${d.getDate()} ${m ? MOODS[m] : '記録なし'}`);
    }
    $('mood-week').replaceChildren(...cells);
    $('mood-week').setAttribute('aria-label', `直近7日の調子：${spoken.join('、')}`);
  }
  let historyShown = HISTORY_STEP;
  function renderHistory(now = new Date()) {
    const all = load();
    const today = shownDate || reportDate(now); // 入力欄に出している日は一覧に出さない
    const every = Object.keys(all).filter((k) => k !== today && /^\d{4}-\d{2}-\d{2}$/.test(k)).sort().reverse();
    const keys = every.slice(0, historyShown);
    $('report-list').replaceChildren(...keys.map((k) => item(k, all[k])));
    renderMoodWeek(all, now);
    const rest = every.length - keys.length;
    $('report-more').hidden = rest === 0;
    $('report-more').textContent = `もっと見る（残り${rest}日分）`;
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
    const entry = formEntry();
    if (!hasContent(entry)) {
      $('report-status').textContent = '今日の調子か、どれか1つの項目を入れてください';
      $('report-status').className = 'status ng';
      return;
    }
    const key = shownDate || reportDate(now); // 画面に出している日付の日報として保存する（4時をまたいで開いていても食い違わない）
    const all = load();
    all[key] = { ...entry, savedAt: now.getTime() };
    if (!save(all)) {
      $('report-status').textContent = '保存できませんでした。もう一度押してください';
      $('report-status').className = 'status ng';
      return;
    }
    Store.remove(DRAFT_KEY);
    $('report-status').textContent = `保存済み（${hm(now)}）`;
    $('report-status').className = 'status ok';
    $('report-save').textContent = '更新する';
    dialogueReady.then(() => {
      const picked = pickLine('report_saved.' + (entry.mood === 'good' || entry.mood === 'tired' ? entry.mood : 'normal'));
      if (!picked) return;
      $('report-reply-line').textContent = picked.text;
      $('report-reply').hidden = false;
      renderSay();
    });
  });
  for (const b of document.querySelectorAll('#report-form .mood')) {
    b.addEventListener('click', () => { setMood(mood === b.dataset.mood ? null : b.dataset.mood); saveDraft(); }); // もう一度押すと解除
  }
  for (const id of ['report-done', 'report-left', 'report-tomorrow']) $(id).addEventListener('input', saveDraft);

  $('report-more').addEventListener('click', () => { historyShown += HISTORY_STEP; renderHistory(); });

  function render(now = new Date()) {
    fillForm(now);
    renderHistory(now);
    renderSay();
  }
  onShow('report', () => render());
  render();

  return { load, reportDate, render };
})();
