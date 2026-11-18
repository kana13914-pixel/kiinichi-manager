// 内部の記録（D-060 ⑩）：日ごとの、声掛けの通知の数・予定の時刻があったのに記録が無かった数・「今日はなし」の数。利用者には見せない。
// 使い道：①週次コメントの材料（数だけを送る。report.js の weekSummary）②ホームのセリフの選び分け（同じ食事の記録なしが3日続いたら）。
// 形は docs/data_schema.md の db.stats。app.js（Records・RECORD_KINDS）、routine.js の後、notify.js の前に読み込む。

const Stats = (() => {
  const KEEP_DAYS = 400;
  const FIRST_BACK = 14; // 初めて数えるときは、さかのぼってこの日数まで
  // 予定の時刻があれば数える記録（休憩は数えない）。歯磨きは就寝の時刻で決まる
  const COUNTED = ['wake', 'breakfast', 'work_start', 'lunch', 'work_end', 'dinner', 'bath', 'brush', 'sleep'];
  const MEALS = ['breakfast', 'lunch', 'dinner'];
  const PATTERN_DAYS = 3;

  function load() {
    const s = Store.read(DB.stats, {});
    const ok = s && typeof s === 'object' && !Array.isArray(s);
    return { days: ok && s.days && typeof s.days === 'object' ? s.days : {}, closedThrough: ok ? s.closedThrough || null : null, lineShown: ok && s.lineShown ? s.lineShown : {} };
  }
  function save(s) { return Store.write(DB.stats, s); }
  function dayOf(s, key) { return (s.days[key] = s.days[key] || {}); }

  // 声掛けの予約が、取り消されないまま時刻を過ぎた＝送った（notify.js から呼ぶ）。キーは meal:日付:種類 など
  function countNotified(key) {
    const [kind, date] = key.split(':');
    if (!kind || !/^\d{4}-\d{2}-\d{2}$/.test(date || '')) return;
    const s = load();
    const d = dayOf(s, date);
    d.notified = { ...(d.notified || {}), [kind]: ((d.notified || {})[kind] || 0) + 1 };
    save(s);
  }

  // 終わった日の、記録が無かった分と「今日はなし」を数える（朝4時を過ぎてから。開いたときに呼ぶ）
  function close(now = new Date()) {
    const s = load();
    const yesterday = addDays(logicalDay(now), -1);
    let day = s.closedThrough ? addDays(parseDay(s.closedThrough), 1) : addDays(yesterday, -(FIRST_BACK - 1));
    if (day > yesterday) return;
    const records = Records.all();
    for (; day <= yesterday; day = addDays(day, 1)) {
      const key = dateStr(day);
      const rec = records[key] || {};
      const d = dayOf(s, key);
      delete d.missed; delete d.skipped; delete d.unused;
      if (!Object.keys(rec).length) { d.unused = true; continue; } // 使わなかった日は「全部忘れた日」にしない
      const times = Routine.timesFor(day);
      for (const id of COUNTED) {
        const planned = id === 'brush' ? times.sleep : times[id];
        if (!planned) continue;
        const st = Records.status(id, rec).state;
        if (st === 'none') d.missed = { ...(d.missed || {}), [id]: 1 };
        if (st === 'skipped') d.skipped = { ...(d.skipped || {}), [id]: 1 };
      }
      if (!Object.keys(d).length) delete s.days[key];
    }
    s.closedThrough = dateStr(yesterday);
    const limit = dateStr(addDays(yesterday, -KEEP_DAYS));
    for (const k of Object.keys(s.days)) if (k < limit) delete s.days[k];
    save(s);
  }

  // 週の合計（週次コメントの材料。数だけ）
  const KIND_WORDS = { meal: '食事', break: '休憩', night: '夜', sleep: '就寝前', event: '予定の前' };
  function weekLines(days) {
    close();
    const s = load();
    const notified = {}, missed = {};
    let unused = 0;
    for (const day of days) {
      const d = s.days[dateStr(day)] || {};
      for (const [k, n] of Object.entries(d.notified || {})) notified[k] = (notified[k] || 0) + n;
      for (const k of Object.keys(d.missed || {})) missed[k] = (missed[k] || 0) + 1;
      if (d.unused) unused++;
    }
    const label = (id) => (kindOf(id) || {}).label || id;
    const n = Object.entries(notified).map(([k, v]) => `${KIND_WORDS[k] || k}${v}回`).join('、');
    const m = COUNTED.filter((k) => missed[k]).map((k) => `${label(k)}${missed[k]}日`).join('、');
    return [`この週の声掛けの通知：${n || 'なし'}`, `予定の時刻があったのに記録が無かった分：${m || 'なし'}`, `アプリを使わなかった日：${unused}日`];
  }

  // ホームのセリフの選び分け：同じ食事の記録なしが3日続いたら、その日1回だけ（最初に当てはまったもの）
  function patternLine(now = new Date()) {
    close(now);
    const s = load();
    const today = todayKey(now);
    const last = [1, 2, 3].slice(0, PATTERN_DAYS).map((i) => s.days[dateStr(addDays(logicalDay(now), -i))] || {});
    for (const meal of MEALS) {
      const key = `pattern_check.${meal}_missed`;
      if (s.lineShown[key] === today) continue;
      if (last.every((d) => !d.unused && d.missed && d.missed[meal])) return key;
    }
    return null;
  }
  function markShown(key, now = new Date()) {
    const s = load();
    s.lineShown = { ...s.lineShown, [key]: todayKey(now) };
    save(s);
  }

  close();
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') close(); });
  return { load, countNotified, close, weekLines, patternLine, markShown };
})();
