// 予定画面（D-026 ④, D-030, D-032）。見るだけ。表示は2つで、上のボタンで切り替える（選んだ表示は端末に覚える）。
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
    return today.some((e) => e.allDay || e.at > now) ? 'schedule_status.today_left' : 'schedule_status.today_done';
  }

  // ---------- リスト ----------
  function renderList(now) {
    const next = nextEvent(now);
    const days = [];
    for (let i = 0; i < LIST_DAYS; i++) {
      const date = dayAt(now, i);
      const events = SampleData.eventsOn(date);
      const sec = document.createElement('section');
      sec.className = 'schedule-day';
      sec.dataset.date = dateStr(date);
      const h = document.createElement('h2');
      h.className = 'schedule-day-title';
      h.textContent = (i === 0 ? '今日 ' : i === 1 ? '明日 ' : '') + dayLabel(date);
      const ul = document.createElement('ul');
      ul.className = 'schedule-list';
      ul.append(...(events.length ? events.map((e) => row(e, now, next)) : [noneRow()]));
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

  $('schedule-mode-list').addEventListener('click', () => setMode('list'));
  $('schedule-mode-month').addEventListener('click', () => setMode('month'));
  $('cal-prev').addEventListener('click', () => moveMonth(-1));
  $('cal-next').addEventListener('click', () => moveMonth(1));
  $('cal-today').addEventListener('click', () => { cursor = null; render(new Date(), true); });

  onShow('schedule', () => render());
  setInterval(() => { if (location.hash === '#schedule') render(); }, 1000); // 「あと何分」と過ぎた予定を、分が変わったら直す
  render();

  return { render, refresh: () => render(new Date(), true) };
})();
