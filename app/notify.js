// 声掛けの通知予約（D-015, D-049）。アプリは閉じている間に動けないので、記録や毎日の時刻が変わるたびに、
// 「今日このあと送る通知」を作り直して送信サーバーに予約・更新・取り消しする。サーバーは時刻が来たら送るだけ。
//   食事   meal:<日付>:<朝食|昼食|夕食>  予定時刻の30分後。記録か「今日はなし」で取り消す
//   休憩   break:<日付>                 仕事開始（または最後の休憩）から90分後。仕事終わりの予定より前だけ
//   夜     night:<日付>                 就寝の1時間前。夕食・入浴・歯磨きの残りの数でセリフを変える。残りがなければ送らない
//   就寝前 sleep:<日付>                 就寝の予定時刻。就寝を記録したら取り消す
//   予定   event:<日付>:<印>            カレンダーの時刻のある予定の30分前（D-054）。予定の名前を本文に差し込む
// 通知の種類（tag）はキーの最初の「:」より前（worker.js）。同じ種類は新しい通知で置き換わる。
// app.js（Records・plannedMinutes・repairPush）、routine.js、dialogue.js、settings.js の後に読み込む。

const Voice = (() => {
  const MEAL_AFTER = 30;   // 分
  const BREAK_AFTER = 90;  // 分
  const NIGHT_BEFORE = 60; // 分
  const EVENT_BEFORE = 30; // 分
  const MIN_LEAD_MS = 60 * 1000; // これより近い時刻の予約は作らない（届くのが間に合わない）
  const MEALS = [['breakfast', '朝食'], ['lunch', '昼食'], ['dinner', '夕食']];

  // 朝4時区切りの分 → その日の時点（ミリ秒）
  function atOf(now, minutes) {
    const d = logicalDay(now);
    d.setMinutes(minutes);
    return d.getTime();
  }
  // セリフ集から1本（同じキーなら同じ候補。通知の本文と、開いたときのセリフをそろえる）
  function lineFor(trigger, key) {
    const lines = candidates(trigger);
    if (!lines) return null;
    let h = 0;
    for (const c of key) h = (h * 31 + c.charCodeAt(0)) >>> 0;
    const index = h % lines.length;
    return { text: lines[index], index, trigger };
  }
  function item(key, at, trigger, vars = null) {
    const line = lineFor(trigger, key);
    if (!line) return null;
    const extra = vars && vars.title ? `&title=${encodeURIComponent(vars.title)}` : '';
    const url = new URL(`index.html?source=webpush&trigger=${trigger}&line=${line.index}&h=${lineHash(line.text)}${extra}`, location.href).href;
    return [key, { at, title: 'キィニチ', body: kinichOnly(fillLine(line.text, vars || {})), url }]; // 通知にはアハウを入れない（D-085）
  }
  // 予定の印（キーに使える文字だけ。id がなければ名前と時刻から）
  function mark(ev) {
    let h = 0;
    for (const c of `${ev.id}|${ev.title}|${ev.start}`) h = (h * 31 + c.charCodeAt(0)) >>> 0;
    return h.toString(36);
  }

  // 今日このあと送る通知 { キー: { at, title, body, url } }
  function plan(now = new Date()) {
    const out = {};
    if (!Prefs.get('voice')) return out;
    const date = todayKey(now);
    const day = Records.day(now);
    const planned = plannedMinutes(now);
    const st = (id) => Records.status(id, day).state; // none / done / skipped
    const add = (entry) => { if (entry && entry[1].at > now.getTime() + MIN_LEAD_MS) out[entry[0]] = entry[1]; };
    for (const [id] of MEALS) {
      if (planned[id] !== null && st(id) === 'none') add(item(`meal:${date}:${id}`, atOf(now, planned[id] + MEAL_AFTER), 'midday_check.meal_overdue'));
    }
    if (planned.work_start !== null && planned.work_end !== null && st('work_start') === 'done' && st('work_end') === 'none') {
      const v = day.break;
      const lastBreak = Array.isArray(v) && v.length ? v[v.length - 1].at : 0;
      const base = Math.max(day.work_start.at, lastBreak);
      const at = base + BREAK_AFTER * 60000;
      if (at < atOf(now, planned.work_end)) add(item(`break:${date}`, at, 'midday_check.break_overdue'));
    }
    if (planned.sleep !== null && st('sleep') === 'none') {
      const left = ['dinner', 'bath', 'brush'].filter((id) => (id === 'brush' || planned[id] !== null) && st(id) === 'none').length;
      if (left > 0) add(item(`night:${date}`, atOf(now, planned.sleep - NIGHT_BEFORE), left >= 3 ? 'night_check.many_left' : 'night_check.some_left'));
      add(item(`sleep:${date}`, atOf(now, planned.sleep), 'before_sleep.default'));
    }
    // カレンダーの時刻のある予定（今日のこのあと。朝4時まで）の30分前（D-054）
    const dayEnd = atOf(now, (24 + DAY_STARTS_AT) * 60);
    for (const ev of Calendar.timedBetween(now.getTime(), dayEnd)) {
      add(item(`event:${date}:${mark(ev)}`, ev.start - EVENT_BEFORE * 60000, 'event_before.default', { title: ev.title.slice(0, 60) }));
    }
    return out;
  }

  // ---------- 送信サーバーとのすり合わせ ----------
  // db.notify = { 予約したキー: { at, body } }。届かなかった呼び出しは、次にすり合わせるときにやり直す
  function sent() { const s = Store.read(DB.notify, {}); return s && typeof s === 'object' && !Array.isArray(s) ? s : {}; }
  let chain = Promise.resolve();
  let timer = null;
  function sync(now = new Date()) {
    chain = chain.then(async () => {
      if (document.body.dataset.state !== 'ready' || !Settings.get('appToken').trim()) return;
      const want = plan(now);
      const have = sent();
      let lost = false;
      for (const [key, v] of Object.entries(want)) {
        if (have[key] && have[key].at === v.at && have[key].body === v.body) continue;
        try {
          const r = await Settings.api('/api/schedule', { method: 'POST', body: { key, ...v } });
          have[key] = { at: v.at, body: v.body };
          Store.write(DB.notify, have);
          if (r.subscribed === false) lost = true;
        } catch (_) { return; } // 通信できない：次の機会にやり直す
      }
      if (lost) repairPush(); // 購読が切れていたら登録し直す（D-033）
      for (const key of Object.keys(have)) {
        if (want[key]) continue;
        if (have[key].at > Date.now()) {
          try { await Settings.api('/api/cancel', { method: 'POST', body: { key } }); } catch (_) { return; }
        }
        else Stats.countNotified(key); // 取り消されないまま時刻を過ぎた＝送った（内部の記録。D-060 ⑩）
        delete have[key]; // 過ぎたものは取り消さずに忘れる
        Store.write(DB.notify, have);
      }
    }).catch(() => {});
    return chain;
  }
  // 記録を続けて押したときにまとめるため、少し待ってからすり合わせる
  function soon() {
    clearTimeout(timer);
    timer = setTimeout(() => sync(), 800);
  }
  window.addEventListener('recordschange', soon);
  window.addEventListener('routinechange', soon);
  window.addEventListener('calendarchange', soon); // 予定が変わったら、予定の前の声掛けを付け替える
  window.addEventListener('tonechange', soon); // 話し方を変えたら、通知の文をその話し方で選び直す（D-082）
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') soon(); });
  dialogueReady.then(() => sync());
  return { plan, sync };
})();
