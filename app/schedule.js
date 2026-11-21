// 予定画面（D-026 ④, D-030, D-032）。Google カレンダーをつないでいれば、予定を足す・直す・消す（D-054）。表示は2つで、上のボタンで切り替える（選んだ表示は端末に覚える）。
//   リスト … 今日から7日先まで（8日分）を日付ごとに区切って時刻順に並べる。過ぎた予定は薄く、次の予定に金の線と「あと何分」
//   月     … マス目に日付を並べ、その日の予定（kind が event のもの）をタグで出す。マスを押すと下にその日の予定を出す
// データはどちらも SampleData.eventsOn（フェーズ2で Google カレンダーに置き換える）だけを読む。
// 日付は暦どおり（0時区切り）。朝4時区切り（D-034）は使わない。
// util.js（日付）、dialogue.js（セリフ）、app.js の restText / nextEvent を使う。

const Schedule = (() => {
  const LIST_DAYS = 8;   // 今日を含めて8日分
  const CELL_TAGS = 2;   // 月表示の1マスに出すタグの数。入りきらない分は「+n」
  const MODE_KEY = 'schedule.view';
  const WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土'];
  const $ = (id) => document.getElementById(id);

  function dayAt(d, n) { return addDays(startOfDay(d), n); } // n 日後の 0 時
  const dayLabel = labelLong;
  function sameEvent(a, b) { return a && b && a.at.getTime() === b.at.getTime() && a.title === b.title; }

  let mode = 'list';
  try { if (localStorage.getItem(MODE_KEY) === 'month') mode = 'month'; } catch (_) {}
  let cursor = null;   // 月表示で見ている月の1日
  let selected = null; // 月表示で選んでいる日

  // 予定1件の行（リストと、月表示の下の一覧で共通）
  function row(ev, now, next) {
    const li = document.createElement('li');
    const isNext = !ev.allDay && sameEvent(ev, next);
    const past = !ev.allDay && ev.at <= now;
    li.className = 'schedule-row' + (past ? ' past' : '') + (isNext ? ' next' : '');
    const time = document.createElement('span');
    time.className = 'schedule-time' + (ev.allDay ? ' allday' : '');
    time.textContent = ev.allDay ? '終日' : hm(ev.at);
    const title = document.createElement('span');
    title.className = 'schedule-title';
    title.textContent = ev.title;
    li.append(time, title);
    if (ev.kind === 'routine' && ev.overridden) { // その日だけ変えた生活の時刻（D-060 ⑭）
      const tag = document.createElement('small');
      tag.className = 'tag routine-tag';
      tag.textContent = 'この日だけ';
      title.append(tag);
    }
    if (ev.kind === 'routine' && ev.day) routineRow(li, ev);
    if (past) { // 色だけで伝えない（V3-07）
      const done = document.createElement('span');
      done.className = 'sr-only';
      done.textContent = '（過ぎた予定）';
      li.append(done);
    }
    if (isNext) {
      const rest = document.createElement('span');
      rest.className = 'schedule-rest';
      rest.textContent = `次 ・ ${restText(ev.at - now)}`;
      li.append(rest);
    }
    if (ev.ref && ev.ref.editable) { // カレンダーの予定は直せる（繰り返し・招待された予定は除く。D-054）
      const edit = document.createElement('button');
      edit.type = 'button';
      edit.className = 'event-edit';
      edit.setAttribute('aria-label', `「${ev.title}」を直す`);
      edit.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20h4L19 9l-4-4L4 16z"/><path d="M13 7l4 4"/></svg>';
      edit.addEventListener('click', () => openForm(ev.ref));
      li.append(edit);
    }
    return li;
  }
  // 生活の時刻の行は、押すとその日だけ変えられる（D-060 ⑭）。鉛筆は押せることを示す印（行のどこを押してもよい）
  function routineRow(li, ev) {
    li.classList.add('routine-row-item');
    li.tabIndex = 0;
    li.setAttribute('role', 'button');
    li.setAttribute('aria-label', `${ev.title}${ev.skipped ? '（この日はなし）' : ` ${hm(ev.at)}`}。この日だけ変える`);
    const mark = document.createElement('span');
    mark.className = 'routine-edit';
    mark.setAttribute('aria-hidden', 'true');
    mark.innerHTML = '<svg viewBox="0 0 24 24"><path d="M4 20h4L19 9l-4-4L4 16z"/><path d="M13 7l4 4"/></svg>';
    li.append(mark);
    const go = () => RoutineDay.open(ev);
    li.addEventListener('click', go);
    li.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); } });
  }
  // この日だけ「なし」にした生活の時刻の行（押すと元に戻せる）
  function skippedRow(s) {
    const li = document.createElement('li');
    li.className = 'schedule-row past routine-skipped';
    const time = document.createElement('span');
    time.className = 'schedule-time allday';
    time.textContent = 'なし';
    const title = document.createElement('span');
    title.className = 'schedule-title';
    title.textContent = s.title;
    const tag = document.createElement('small');
    tag.className = 'tag routine-tag';
    tag.textContent = 'この日だけ';
    title.append(tag);
    li.append(time, title);
    routineRow(li, { ...s, skipped: true });
    return li;
  }

  function noneRow() {
    const li = document.createElement('li');
    li.className = 'schedule-row none';
    li.textContent = '予定なし';
    return li;
  }

  // ---------- 一言（Q-A, D-041）：8日とも予定なし → 今日は予定なし → 今日の予定が残っている → 今日の予定は過ぎた ----------
  // 数えるのはカレンダーに入れる予定（kind が event）だけ。毎日の生活の時刻（起床・就寝など）は予定に数えない（月表示と同じ）
  const say = makeSay($('schedule-say-line'));
  function plans(date) { return SampleData.eventsOn(date).filter((e) => e.kind === 'event'); }
  function sayKey(now) {
    let total = 0;
    for (let i = 0; i < LIST_DAYS; i++) total += plans(dayAt(now, i)).length;
    if (total === 0) return 'screen_empty.schedule';
    const today = plans(now);
    if (today.length === 0) return 'schedule_status.today_none';
    // 終日の予定は「残っている」に数えない。時刻のある予定がこの先にあるときだけ残っている（終日だけの日は済んだ側。D-093）
    return today.some((e) => !e.allDay && e.at > now) ? 'schedule_status.today_left' : 'schedule_status.today_done';
  }

  // ---------- リスト ----------
  function renderList(now) {
    const next = nextEvent(now);
    const days = [];
    for (let i = 0; i < LIST_DAYS; i++) {
      const date = dayAt(now, i);
      const events = SampleData.eventsOn(date);
      const skipped = Routine.skippedFor(date);
      const sec = document.createElement('section');
      sec.className = 'schedule-day';
      sec.dataset.date = dateStr(date);
      const h = document.createElement('h2');
      h.className = 'schedule-day-title';
      h.textContent = (i === 0 ? '今日 ' : i === 1 ? '明日 ' : '') + dayLabel(date);
      const ul = document.createElement('ul');
      ul.className = 'schedule-list';
      ul.append(...(events.length ? events.map((e) => row(e, now, next)) : [noneRow()]), ...skipped.map(skippedRow));
      sec.append(h, ul);
      days.push(sec);
    }
    $('schedule-days').replaceChildren(...days);
  }

  // ---------- 月 ----------
  function cell(date, now) {
    const events = SampleData.eventsOn(date).filter((e) => e.kind === 'event');
    const b = document.createElement('button');
    b.type = 'button';
    const today = dateStr(date) === dateStr(now);
    const picked = dateStr(date) === dateStr(selected);
    b.className = 'cal-cell' + (date.getMonth() !== cursor.getMonth() ? ' out' : '') + (today ? ' today' : '');
    b.dataset.date = dateStr(date);
    b.setAttribute('aria-pressed', String(picked));
    b.setAttribute('aria-label', `${today ? '今日 ' : ''}${dayLabel(date)} 予定${events.length}件`);
    const num = document.createElement('span');
    num.className = 'cal-date';
    num.textContent = String(date.getDate());
    b.append(num);
    for (const e of events.slice(0, CELL_TAGS)) {
      const tag = document.createElement('span');
      tag.className = 'cal-tag';
      tag.textContent = e.title;
      b.append(tag);
    }
    if (events.length > CELL_TAGS) {
      const more = document.createElement('span');
      more.className = 'cal-more';
      more.textContent = `+${events.length - CELL_TAGS}`;
      b.append(more);
    }
    b.addEventListener('click', () => {
      selected = date;
      if (date.getMonth() !== cursor.getMonth()) cursor = new Date(date.getFullYear(), date.getMonth(), 1);
      render(new Date(), true);
    });
    return b;
  }
  function renderMonth(now) {
    $('cal-title').textContent = `${cursor.getFullYear()}年${cursor.getMonth() + 1}月`;
    const first = dayAt(cursor, -cursor.getDay()); // 日曜はじまり
    const daysInMonth = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 0).getDate();
    const weeks = Math.ceil((cursor.getDay() + daysInMonth) / 7);
    const cells = [];
    for (let i = 0; i < weeks * 7; i++) cells.push(cell(dayAt(first, i), now));
    $('cal-grid').replaceChildren(...cells);

    const events = SampleData.eventsOn(selected).filter((e) => e.kind === 'event');
    const next = nextEvent(now);
    $('cal-day-title').textContent = dayLabel(selected);
    $('cal-day-list').replaceChildren(...(events.length ? events.map((e) => row(e, now, next)) : [noneRow()]));
  }
  function moveMonth(n, now = new Date()) {
    cursor = new Date(cursor.getFullYear(), cursor.getMonth() + n, 1);
    // 今月なら今日、ほかの月なら1日を選ぶ
    selected = cursor.getFullYear() === now.getFullYear() && cursor.getMonth() === now.getMonth() ? startOfDay(now) : new Date(cursor);
    render(now, true);
  }

  // ---------- 切り替えと描き直し ----------
  let shownKey = null;
  function render(now = new Date(), force = false) {
    if (!cursor) { cursor = new Date(now.getFullYear(), now.getMonth(), 1); selected = startOfDay(now); }
    // 分が変わるか、表示・月・選んだ日が変わったときだけ作り直す（P3-04）
    const key = [mode, hm(now), dateStr(now), dateStr(cursor), dateStr(selected)].join('|');
    if (key === shownKey && !force) return;
    shownKey = key;
    $('schedule-list-view').hidden = mode !== 'list';
    $('schedule-month-view').hidden = mode !== 'month';
    $('schedule-mode-list').setAttribute('aria-pressed', String(mode === 'list'));
    $('schedule-mode-month').setAttribute('aria-pressed', String(mode === 'month'));
    say(sayKey(now));
    if (mode === 'list') renderList(now); else renderMonth(now);
  }
  function setMode(next) {
    mode = next;
    try { localStorage.setItem(MODE_KEY, mode); } catch (_) {}
    render(new Date(), true);
  }

  // ---------- 予定を足す・直す・消す（D-054） ----------
  let editing = null; // 直している予定（Calendar の控えの1件）。足すときは null
  let allDay = false;
  const MAX_ALLDAY_DAYS = 31; // 終日の予定の長さの上限（GAS の MAX_EVENT_MS と同じ。D-077）
  const isDay = (v) => /^\d{4}-\d{2}-\d{2}$/.test(v);
  const daysBetween = (a, b) => Math.round((parseDay(b) - parseDay(a)) / 86400000);
  function setAllDay(on) {
    allDay = on;
    $('event-allday').setAttribute('aria-checked', String(on));
    $('event-allday').textContent = on ? 'オン' : 'オフ';
    $('event-times').hidden = on;
    // 終日のときは、始まりの日と終わりの日で期間を入れる（D-077）
    $('event-days').hidden = !on;
    $('event-date-label').textContent = on ? '始まりの日' : '日付';
    const start = $('event-date').value;
    if (on && isDay(start) && (!isDay($('event-end-date').value) || $('event-end-date').value < start)) $('event-end-date').value = start;
  }
  // 始まりの日を動かしたら、終わりの日も同じ日数だけ動かす（期間の長さを保つ）
  let shownStart = '';
  function followStart() {
    const start = $('event-date').value;
    const end = $('event-end-date').value;
    if (isDay(start) && isDay(shownStart) && isDay(end)) $('event-end-date').value = dateStr(addDays(parseDay(end), daysBetween(shownStart, start)));
    if (isDay(start)) shownStart = start;
  }
  // iPhone は選んでいる途中に input、閉じたときに change が来る。両方で呼んでも、2回目は動かす日数が 0 になる
  $('event-date').addEventListener('input', followStart);
  $('event-date').addEventListener('change', followStart);
  function openForm(ref = null) {
    editing = ref;
    const now = new Date();
    $('event-form-title').textContent = ref ? '予定を直す' : '予定を足す';
    $('event-delete').hidden = !ref;
    $('event-form-status').textContent = '';
    $('event-status').textContent = '';
    if (ref) {
      const st = new Date(ref.start);
      const en = new Date(ref.end);
      $('event-title').value = ref.title;
      $('event-date').value = dateStr(st);
      $('event-start').value = ref.allDay ? '' : hm(st);
      $('event-end').value = ref.allDay ? '' : hm(en);
      // 終日の終わりは次の日の0時で届く（含まない）。画面では含む日で出す
      $('event-end-date').value = ref.allDay ? dateStr(addDays(startOfDay(new Date(Math.max(ref.start + 1, ref.end))), -1)) : dateStr(st);
      setAllDay(ref.allDay);
    } else {
      const day = mode === 'month' && selected ? selected : now;
      const h = Math.min(22, now.getHours() + 1);
      $('event-title').value = '';
      $('event-date').value = dateStr(day);
      $('event-end-date').value = dateStr(day);
      $('event-start').value = `${pad(h)}:00`;
      $('event-end').value = `${pad(h + 1)}:00`;
      setAllDay(false);
    }
    shownStart = $('event-date').value;
    $('event-add-open').hidden = true;
    $('event-form').hidden = false;
    $('event-title').focus();
    $('event-form').scrollIntoView({ block: 'end' });
  }
  function closeForm() {
    editing = null;
    $('event-form').hidden = true;
    $('event-add-open').hidden = false;
  }
  // 入力から始まりと終わり（ミリ秒）を作る。終わりが始まり以前なら翌日とみなす。
  // 終日は始まりの日から終わりの日まで（終わりの日を含む。送るときは次の日の0時を終わりにする。D-077）。期間がおかしければ { error }
  function formTimes() {
    if (!isDay($('event-date').value)) return null;
    const day = parseDay($('event-date').value);
    if (allDay) {
      const last = $('event-end-date').value;
      if (!isDay(last)) return null;
      const days = daysBetween($('event-date').value, last) + 1;
      if (days < 1) return { error: '終わりの日は、始まりの日と同じか後の日にしてください' };
      if (days > MAX_ALLDAY_DAYS) return { error: `終日の予定は${MAX_ALLDAY_DAYS}日までです` };
      return { start: day.getTime(), end: addDays(day, days).getTime() };
    }
    const [sh, sm] = ($('event-start').value || '').split(':').map(Number);
    const [eh, em] = ($('event-end').value || '').split(':').map(Number);
    if (![sh, sm, eh, em].every(Number.isFinite)) return null;
    const start = new Date(day); start.setHours(sh, sm, 0, 0);
    const end = new Date(day); end.setHours(eh, em, 0, 0);
    if (end <= start) end.setDate(end.getDate() + 1);
    return { start: start.getTime(), end: end.getTime() };
  }
  async function submit(action, data, done) {
    $('event-save').disabled = true;
    $('event-delete').disabled = true;
    $('event-form-status').className = 'status';
    $('event-form-status').textContent = '保存しています…';
    try {
      await Calendar.change(action, data);
      closeForm();
      $('event-status').textContent = done;
      render(new Date(), true);
    } catch (e) {
      $('event-form-status').className = 'status ng';
      $('event-form-status').textContent = e.message;
    } finally {
      $('event-save').disabled = false;
      $('event-delete').disabled = false;
    }
  }
  $('event-add-open').addEventListener('click', () => openForm());
  $('event-cancel').addEventListener('click', closeForm);
  $('event-allday').addEventListener('click', () => setAllDay(!allDay));
  $('event-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const title = $('event-title').value.trim();
    if (!title) { $('event-form-status').textContent = '予定の名前を入れてください'; return; }
    const t = formTimes();
    if (!t) { $('event-form-status').textContent = allDay ? '始まりの日と終わりの日を入れてください' : '日付と時刻を入れてください'; return; }
    if (t.error) { $('event-form-status').textContent = t.error; return; }
    const data = { title: title.slice(0, 200), allDay, ...t };
    if (editing) submit('update', { ...data, id: editing.id, calendarId: editing.calendarId }, `「${data.title}」を直しました`);
    else submit('add', data, `「${data.title}」を足しました`);
  });
  $('event-delete').addEventListener('click', async () => {
    if (!editing) return;
    const target = editing;
    if (!(await confirmDialog(`「${target.title}」を Google カレンダーから消しますか？`))) return;
    editing = target;
    submit('remove', { id: target.id, calendarId: target.calendarId }, `「${target.title}」を消しました`);
  });

  $('schedule-mode-list').addEventListener('click', () => setMode('list'));
  $('schedule-mode-month').addEventListener('click', () => setMode('month'));
  $('cal-prev').addEventListener('click', () => moveMonth(-1));
  $('cal-next').addEventListener('click', () => moveMonth(1));
  $('cal-today').addEventListener('click', () => { cursor = null; render(new Date(), true); });

  onShow('schedule', () => render());
  setInterval(() => { if (location.hash === '#schedule') render(); }, 1000);
  window.addEventListener('routinechange', () => render(new Date(), true)); // 毎日の時刻を変えたら描き直す
  window.addEventListener('routineday', (e) => { $('routine-msg').textContent = e.detail; }); // その日だけ変えた知らせ // 「あと何分」と過ぎた予定を、分が変わったら直す
  render();

  return { render, refresh: () => render(new Date(), true) };
})();
