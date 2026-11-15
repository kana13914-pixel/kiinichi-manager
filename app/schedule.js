// 予定画面（D-026 ④, D-030）。フェーズ2で Google カレンダーとつなぐまでは、仮の予定（sample-data.js）を一覧で見るだけ。
// 今日と明日を出し、過ぎた予定は薄く、次の予定には金の線と「あと何分」を付ける。操作はない。
// app.js の hm / restText / nextEvent / pickLine / dialogueReady と sample-data.js の SampleData を使う。

const Schedule = (() => {
  const $ = (id) => document.getElementById(id);

  function dayLabel(d) {
    return d.toLocaleDateString('ja-JP', { month: 'long', day: 'numeric', weekday: 'short' });
  }
  function row(ev, now, next) {
    const li = document.createElement('li');
    const isNext = next !== null && ev.at.getTime() === next.at.getTime() && ev.title === next.title;
    const past = ev.at <= now;
    li.className = 'schedule-row' + (past ? ' past' : '') + (isNext ? ' next' : '');
    const time = document.createElement('span');
    time.className = 'schedule-time';
    time.textContent = hm(ev.at);
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

  let shownKey = null;
  let emptyShown = false;
  function render(now = new Date()) {
    const tomorrow = new Date(now);
    tomorrow.setDate(tomorrow.getDate() + 1);
    const today = SampleData.todayEvents(now);
    const tmr = SampleData.todayEvents(tomorrow);
    const next = nextEvent(now);
    // 分が変わるか、予定が変わったときだけ作り直す（P3-04）
    const key = JSON.stringify([hm(now), now.toDateString(), today.map((e) => [e.at.getTime(), e.title]), tmr.map((e) => [e.at.getTime(), e.title])]);
    if (key === shownKey) return;
    shownKey = key;

    $('schedule-today-title').textContent = `今日 ${dayLabel(now)}`;
    $('schedule-tomorrow-title').textContent = `明日 ${dayLabel(tomorrow)}`;
    $('schedule-today').replaceChildren(...today.map((e) => row(e, now, next)));
    $('schedule-tomorrow').replaceChildren(...tmr.map((e) => row(e, now, next)));
    $('schedule-today-none').hidden = today.length > 0;
    $('schedule-tomorrow-none').hidden = tmr.length > 0;

    const empty = today.length === 0 && tmr.length === 0;
    $('schedule-empty').hidden = !empty;
    if (empty && !emptyShown) { // 空になったときだけセリフを選び直す
      dialogueReady.then(() => {
        const picked = pickLine('screen_empty.schedule');
        $('schedule-empty-line').textContent = picked ? picked.text : '…';
      });
    }
    emptyShown = empty;
  }

  window.addEventListener('hashchange', () => { if (location.hash === '#schedule') render(); });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') render(); });
  setInterval(() => { if (location.hash === '#schedule') render(); }, 1000); // 「あと何分」と過ぎた予定を、分が変わったら直す
  render();

  return { render };
})();
