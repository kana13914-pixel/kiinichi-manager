// 週次サマリー（D-102。docs/weekly_summary_design.md の段階2）。ホーム右上の入口から開く別の画面（#summary）。
//   ① 今週の振り返り：日報を書いた日・記録できた割合・完了したタスク・調子の並び（数字だけ。AI の文は今ある「先週のひとこと」を出す）
//   ② 来週の予定：月曜〜日曜を1日1行（予定の数・起きている間の空き・気になる点の数）。押すとその日の中身を開く
//   ③ 気になる点：予定の重なり・予定の間の短さ（移動・準備）・毎日の時刻との重なり・休憩をはさめない続き
// 判断は端末の中の決まりだけで行い、外には送らない。
// 調整案（D-103。段階4のうち今のデータでできる分）：食事・入浴の時刻と予定が重なる日は「この日だけ◯◯を（予定の終わり）にする」を出す。
// 選んだ案だけを、確かめてから反映する（毎日の時刻の「その日だけの変更」。取り消せる）。カレンダーの予定は動かさない（仮の答え A1）。
// Google カレンダーをつないでいないときは、仮の予定では判断しない。
// util.js・routine.js・calendar.js・app.js（Records・RECORD_KINDS）・tasks.js・report.js の後に読み込む。

const Summary = (() => {
  const $ = (id) => document.getElementById(id);
  const GAP_MIN = 15;    // 予定と予定の間がこれより短いと、移動・準備が足りないかもしれない（仮の答え C1）
  const BREAK_RUN = 90;  // 仕事の時間に、空きなく続く予定がこれを超えると休憩をはさめない（休憩の声掛けと同じ 90 分。D-049）
  const MOODS = { good: '元気', normal: 'ふつう', tired: '疲れた' };
  const ROUTINE_CHECK = [['breakfast', '朝食'], ['lunch', '昼食'], ['dinner', '夕食'], ['bath', '入浴']]; // 予定と重なると困る毎日の時刻
  const MIN = 60000;

  const weekStart = (day) => addDays(day, -((day.getDay() + 6) % 7)); // 月曜はじまり（日報の週と同じ）
  const weekOf = (start) => Array.from({ length: 7 }, (_, i) => addDays(start, i));
  // 'HH:MM' → その日（朝4時区切り）の時点。深夜0〜4時は次の暦日
  function atOf(day, hhmm) {
    if (!hhmm) return null;
    const [h, m] = hhmm.split(':').map(Number);
    const d = new Date(day);
    if (h < DAY_STARTS_AT) d.setDate(d.getDate() + 1);
    d.setHours(h, m, 0, 0);
    return d.getTime();
  }
  function dur(ms) {
    const mins = Math.round(ms / MIN);
    const h = Math.floor(mins / 60), m = mins % 60;
    return h ? `${h}時間${m ? `${m}分` : ''}` : `${m}分`;
  }
  const span = (e) => `${hm(new Date(e.start))}〜${hm(new Date(e.end))}`;

  // その日の時刻のある予定（カレンダー）。終わりが始まりより前のものは始まりにそろえる
  function timedEvents(day) {
    return Calendar.eventsOn(day).filter((e) => !e.allDay && e.ref)
      .map((e) => ({ title: e.title, start: e.ref.start, end: Math.max(e.ref.end, e.ref.start) }))
      .sort((a, b) => a.start - b.start || a.end - b.end);
  }
  // 重なる・続く区間をまとめる（joinMs 未満の間はつなぐ）
  function merge(list, joinMs = 0) {
    const out = [];
    for (const e of list) {
      const last = out[out.length - 1];
      if (last && e.start - last.end < joinMs) last.end = Math.max(last.end, e.end);
      else out.push({ start: e.start, end: e.end });
    }
    return out;
  }

  // その日を調べる。events は timedEvents の形、times は毎日の時刻（Routine.timesFor）
  // 返す値：{ busy（起きている間の予定の時間）, free（空き）, problems: [{ kind, text, impact }] }
  function analyze(day, events, times) {
    const problems = [];
    const add = (kind, text, impact, fix = null) => problems.push({ kind, text, impact, fix });
    const sleep = atOf(day, times.sleep);
    const wake = atOf(day, times.wake);
    // 予定の重なり
    for (let i = 0; i < events.length; i++) {
      for (let j = i + 1; j < events.length; j++) {
        const a = events[i], b = events[j];
        if (b.start >= a.end) continue;
        const over = Math.min(a.end, b.end) - b.start;
        if (over > 0) add('overlap', `「${a.title}」（${span(a)}）と「${b.title}」（${span(b)}）が${dur(over)}重なっています`, 'どちらかに遅れるか、出られないかもしれません');
      }
    }
    // 予定の間が短い（移動・準備）。重なっていないものだけ
    const merged0 = merge(events);
    for (let i = 0; i < events.length - 1; i++) {
      const a = events[i], b = events[i + 1];
      const gap = b.start - a.end;
      if (gap >= 0 && gap < GAP_MIN * MIN) {
        add('gap', `「${a.title}」が終わってから「${b.title}」まで${gap ? dur(gap) : '間が'}${gap ? 'しかありません' : 'ありません'}`, '移動や準備が間に合わないかもしれません');
      }
    }
    // 毎日の時刻との重なり（食事・入浴）。就寝より遅い・起床より早い予定
    for (const [id, label] of ROUTINE_CHECK) {
      const t = atOf(day, times[id]);
      if (t === null) continue;
      const hit = events.find((e) => e.start <= t && t < e.end);
      if (!hit) continue;
      // 案：予定が終わった時刻（5分単位に切り上げ）にずらす。就寝より後になるなら案は出さない
      const to = Math.ceil(hit.end / (5 * MIN)) * 5 * MIN;
      const fix = sleep === null || to < sleep ? { id, label, day: dateStr(day), from: times[id], value: hm(new Date(to)) } : null;
      add('routine', `「${hit.title}」（${span(hit)}）が${label}の時刻（${times[id]}）と重なっています`, `${label}が遅れるか、取れないかもしれません`, fix);
    }
    const late = sleep === null ? null : events.find((e) => e.end > sleep);
    if (late) add('routine', `「${late.title}」（${span(late)}）が就寝の時刻（${times.sleep}）より遅くまであります`, '寝る時間が短くなります');
    const early = wake === null ? null : events.find((e) => e.start < wake);
    if (early) add('routine', `「${early.title}」（${span(early)}）が起床の時刻（${times.wake}）より前に始まります`, '起きる時間を早める必要があります');
    // 休憩をはさめない続き（仕事の時間の中だけ）
    const ws = atOf(day, times.work_start), we = atOf(day, times.work_end);
    if (ws !== null && we !== null) {
      const inWork = events.map((e) => ({ start: Math.max(e.start, ws), end: Math.min(e.end, we) })).filter((e) => e.end > e.start);
      for (const run of merge(inWork, GAP_MIN * MIN)) {
        if (run.end - run.start > BREAK_RUN * MIN) {
          add('break', `${hm(new Date(run.start))}〜${hm(new Date(run.end))}の${dur(run.end - run.start)}、休憩をはさむ空きがありません`, '集中が切れやすく、疲れがたまります');
        }
      }
    }
    // 起きている間（起床〜就寝）の予定の時間と空き
    let busy = 0, free = 0;
    if (wake !== null && sleep !== null && sleep > wake) {
      busy = merged0.reduce((s, e) => s + Math.max(0, Math.min(e.end, sleep) - Math.max(e.start, wake)), 0);
      free = sleep - wake - busy;
    }
    return { busy, free, problems };
  }

  // ---------- 今週の振り返り（数字だけ） ----------
  function review(now = new Date()) {
    const today = logicalDay(now);
    const days = weekOf(weekStart(today)).filter((d) => d <= today);
    const reports = Report.load();
    const records = Records.all();
    let planned = 0, done = 0;
    for (const d of days) {
      const times = Routine.timesFor(d);
      const rec = records[dateStr(d)] || {};
      for (const k of RECORD_KINDS) {
        if (k.repeat || k.id === 'brush' || !times[k.id]) continue; // 予定の時刻がある項目だけ数える
        planned++;
        if (rec[k.id] && (rec[k.id].time || rec[k.id].skipped)) done++;
      }
    }
    const from = days[0].getTime(), to = addDays(today, 1).getTime();
    const tasksDone = Tasks.load().filter((t) => t.done && t.doneAt >= from && t.doneAt < to).length;
    const moods = days.map((d) => ({ day: d, mood: (reports[dateStr(d)] || {}).mood || null }));
    return { days, reportDays: days.filter((d) => reports[dateStr(d)]).length, planned, done, tasksDone, moods };
  }

  // ---------- 描く ----------
  const openDays = new Set(); // 中身を開いている来週の日（開き直すとたたむ）
  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }
  function renderReview(now) {
    const r = review(now);
    const rate = r.planned ? Math.round((r.done / r.planned) * 100) : null;
    const facts = [
      ['日報', `${r.reportDays} / ${r.days.length}日`],
      ['記録', rate === null ? '—' : `${rate}%（${r.done} / ${r.planned}）`],
      ['完了したタスク', `${r.tasksDone}件`],
    ];
    $('summary-facts').replaceChildren(...facts.flatMap(([k, v]) => [el('dt', '', k), el('dd', '', v)]));
    $('summary-moods').replaceChildren(...r.moods.map(({ day, mood }) => {
      const li = el('li', 'summary-mood' + (mood ? ' ' + mood : ''));
      li.append(el('span', 'summary-mood-day', WEEK_LABELS[day.getDay()]), el('span', 'summary-mood-word', mood ? MOODS[mood] : '—'));
      return li;
    }));
    // AI のひとこと：今ある「先週のひとこと」のうち、いちばん新しいもの（日報の画面と同じ文。D-058）
    const weekly = Store.read(DB.weekly, {}) || {};
    const key = Object.keys(weekly).filter((k) => weekly[k] && weekly[k].text).sort().pop();
    $('summary-comment').hidden = !key;
    if (key) $('summary-comment-text').textContent = weekly[key].text;
  }
  function dayRow(day, result, now) {
    const key = dateStr(day);
    const open = openDays.has(key);
    const li = el('li', 'summary-day' + (result.problems.length ? ' has-problem' : ''));
    li.dataset.date = key;
    const btn = el('button', 'summary-day-btn');
    btn.type = 'button';
    btn.setAttribute('aria-expanded', String(open));
    const events = Calendar.eventsOn(day);
    const typeLabel = Routine.typeOf(day) === 'holiday' ? '休日' : '平日';
    // 日付 ｜ 1行目「予定◯件 ・ 空き◯」、2行目「気になる点 ◯」（あるときだけ）
    const body = el('span', 'summary-day-body');
    body.append(el('span', 'summary-day-info', `予定${events.length}件 ・ 空き${dur(result.free)}`));
    if (result.problems.length) body.append(el('span', 'summary-day-flag', `気になる点 ${result.problems.length}`));
    btn.append(el('span', 'summary-day-date', labelShort(day)), body);
    btn.append(el('span', 'summary-day-mark', open ? '▴' : '▾'));
    btn.querySelector('.summary-day-mark').setAttribute('aria-hidden', 'true');
    btn.addEventListener('click', () => { if (openDays.has(key)) openDays.delete(key); else openDays.add(key); render(now); });
    li.append(btn);
    if (open) {
      const ul = el('ul', 'summary-day-items');
      const times = Routine.timesFor(day);
      const first = ROUTINE_ITEMS.find(([id]) => times[id]);
      const last = [...ROUTINE_ITEMS].reverse().find(([id]) => times[id]);
      if (first) ul.append(el('li', 'summary-item routine', `毎日の時刻（${typeLabel}）：${first[1]} ${times[first[0]]} 〜 ${last[1]} ${times[last[0]]}`));
      for (const e of events) ul.append(el('li', 'summary-item', e.allDay ? `終日　${e.title}` : `${span(e.ref)}　${e.title}`));
      for (const t of Tasks.load().filter((x) => !x.done && x.due === key)) ul.append(el('li', 'summary-item task', `期限　${t.title}`));
      if (!ul.children.length) ul.append(el('li', 'summary-item', '予定なし'));
      li.append(ul);
    }
    return li;
  }
  function render(now = new Date()) {
    renderReview(now);
    const days = weekOf(addDays(weekStart(logicalDay(now)), 7));
    $('summary-next-title').textContent = `来週の予定（${labelShort(days[0])}〜${labelShort(days[6])}）`;
    const ready = Calendar.ready();
    $('summary-no-calendar').hidden = ready;
    $('summary-next').hidden = !ready;
    $('summary-problems-section').hidden = !ready;
    if (!ready) return;
    const results = days.map((d) => ({ day: d, ...analyze(d, timedEvents(d), Routine.timesFor(d)) }));
    $('summary-next').replaceChildren(...results.map((r) => dayRow(r.day, r, now)));
    const all = results.flatMap((r) => r.problems.map((p) => ({ ...p, day: r.day })));
    $('summary-problems-count').textContent = String(all.length);
    // 選んでいる案のうち、今も出ているものだけ残す
    const fixes = all.filter((p) => p.fix).map((p) => fixKey(p.fix));
    for (const k of [...chosen]) if (!fixes.includes(k)) chosen.delete(k);
    $('summary-problems').replaceChildren(...(all.length ? all.map((p) => {
      const li = el('li', 'summary-problem ' + p.kind);
      li.append(el('p', 'summary-problem-day', labelShort(p.day)), el('p', 'summary-problem-text', p.text), el('p', 'summary-problem-impact', p.impact));
      if (p.fix) {
        const k = fixKey(p.fix);
        const b = el('button', 'cut-btn quiet chip summary-fix', `案：この日だけ${p.fix.label}を${p.fix.value}にする`);
        b.type = 'button';
        b.dataset.fix = k;
        b.setAttribute('aria-pressed', String(chosen.has(k)));
        b.addEventListener('click', () => { if (chosen.has(k)) chosen.delete(k); else chosen.add(k); render(now); });
        li.append(b);
      }
      return li;
    }) : [el('li', 'summary-problem none', '来週の予定に、気になる点は見つかりませんでした。')]));
    lastFixes = all.filter((p) => p.fix).map((p) => p.fix);
    $('summary-apply').hidden = !fixes.length;
    $('summary-apply').disabled = chosen.size === 0;
    $('summary-apply').textContent = chosen.size ? `選んだ案を反映する（${chosen.size}件）` : '案を選ぶと反映できます';
  }

  // ---------- 調整案の反映（D-103） ----------
  const chosen = new Set(); // 選んでいる案（fixKey）
  let lastFixes = [];
  const fixKey = (f) => `${f.day}|${f.id}|${f.value}`;
  const toast = makeToast($('summary-toast'));
  $('summary-apply').addEventListener('click', async () => {
    const picked = lastFixes.filter((f) => chosen.has(fixKey(f)));
    if (!picked.length) return;
    const list = picked.map((f) => `・${labelShort(parseDay(f.day))} ${f.label} ${f.from} → ${f.value}`).join('\n');
    if (!(await confirmDialog(`毎日の時刻を、その日だけ次のように変えます。\n${list}`, '反映する', false))) return;
    const before = picked.map((f) => ({ f, prev: Routine.overrideOf(parseDay(f.day), f.id) }));
    const ok = picked.every((f) => Routine.setOverride(parseDay(f.day), f.id, f.value));
    chosen.clear();
    window.dispatchEvent(new Event('routinechange')); // 予定・ホーム・声掛けを決め直す
    render();
    if (!ok) { toast.show(SAVE_FAILED); return; }
    toast.show(`${picked.length}件を反映しました`, () => {
      for (const { f, prev } of before) Routine.setOverride(parseDay(f.day), f.id, prev ? prev.value : undefined);
      window.dispatchEvent(new Event('routinechange'));
      render();
    });
  });

  // ホームの入口：日曜の16時から月曜の終わりまでは目立たせる（週の変わり目。仮の答え D1）
  function markEntry(now = new Date()) {
    const d = logicalDay(now).getDay(); // 深夜0〜4時は前の日（日曜の夜の続き）
    const h = now.getHours();
    $('summary-entry').classList.toggle('attention', d === 1 || (d === 0 && (h >= 16 || h < DAY_STARTS_AT)));
  }

  onShow('summary', () => render());
  if (location.hash === '#summary') render(); // 週次サマリーのまま開き直したとき
  window.addEventListener('calendarchange', () => { if (location.hash === '#summary') render(); });
  markEntry();
  setInterval(() => markEntry(), 60 * 1000);
  return { analyze, review, render, markEntry };
})();
