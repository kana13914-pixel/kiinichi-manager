// キィニチに触ったときの反応と、ホームを開いたときの場面（D-083）。
// 文面はセリフ集（data/dialogue_template.yaml）の touch・hold・first_launch・home・rare。話し方ごとの文は D-082。
// 文面がまだない場面は何も言わずに次の候補へ進む（pickLine が null）。セリフは文字で出す（声の再生はしない。D-023）。
// app.js（showLine・periodOf・todayMood・Records）、stats.js、tasks.js、report.js、portrait.js の後に読み込む。

// ---------- 触ったとき ----------
// 段階は場所を問わず共通：通常 → 連続（3秒以内に3回）→ 注意 → 注意後も → 打ち切り（しばらく黙る。続けて打ち切りになるほど長く）→ 時間をおいて再訪。
// 通常タッチ・長押しだけ場所（頭・顔・首・手・体・足）ごと。通常タッチは時間帯のセリフと場所のセリフを交互に出す。
// 打ち切りのあいだ・夕方の提案中・部品（セリフの面・ボタンなど）の上を触ったときは何も言わない。
const Touch = (() => {
  // 数は仮の決め（D-083）。触り心地を見て直す
  const RAPID_N = 3;                  // この回数を
  const RAPID_MS = 3000;              // この時間のうちに触ると「連続」
  const STEP_TAPS = 2;                // 連続のあと、この回数触るごとに一段上がる（注意 → 注意後も → 打ち切り）
  const KEEP_MS = 10 * 1000;          // この間触らなければ、段階は通常に戻る（打ち切りのあとは別）
  // 打ち切りのあと黙る時間：5分。続けてまた打ち切りになるたびに倍（5 → 10 → 20 → 40 → 60分まで）。1時間触らなければ5分に戻る（D-087）
  const MUTE_MS = 5 * 60 * 1000;
  const MUTE_MAX_MS = 60 * 60 * 1000;
  const CALM_MS = 60 * 60 * 1000;
  const RETURN_MS = 60 * 60 * 1000;   // 黙る時間が明けてからこの時間のうちにまた触ったら「時間をおいて再訪」
  const HOLD_MS = 600;                // 長押し
  const MOVE_PX = 12;                 // これより動いたら、触ったのではなく動かした
  const STAGES = ['rapid', 'warn', 'after_warn', 'stop'];
  const PARTS = ['head', 'face', 'neck', 'hand', 'body', 'foot'];
  const $ = (id) => document.getElementById(id);

  let taps = [];        // 最近触った時刻
  let stage = -1;       // -1 は通常。0〜3 は STAGES の番号
  let inStage = 0;      // 今の段階に入ってから触った回数
  let mutedUntil = 0;
  let stoppedAt = 0;
  let muteLevel = 0;    // 続けて打ち切りになった回数（黙る時間を延ばす）
  let lastAt = 0;       // 最後に触った時刻
  // 打ち切りの黙る時間は、アプリを閉じても覚えておく（開き直しで5分に戻らないように。D-088）
  (() => {
    const s = Store.read(DB.touch, {}) || {};
    mutedUntil = Number(s.mutedUntil) || 0; stoppedAt = Number(s.stoppedAt) || 0;
    muteLevel = Number(s.muteLevel) || 0; lastAt = Number(s.lastAt) || 0;
  })();
  const remember = () => Store.write(DB.touch, { mutedUntil, stoppedAt, muteLevel, lastAt });
  let placeFirst = true; // 通常タッチで、場所のセリフを先に出すか（交互）

  const say = (key, vars) => showLine(key, { vars });
  // 時間帯のセリフの候補（夕方は、夕方の文がなければ夜の文）
  function periodKeys(now) {
    const p = periodOf(new Date(now));
    return p === 'evening' ? ['touch.evening', 'touch.night'] : ['touch.' + p];
  }
  function sayFirst(keys) {
    for (const k of keys) if (say(k)) return k;
    return null;
  }
  // 通常のタッチ・長押し
  function normal(part, hold, now) {
    if (hold && part && say('hold.' + part)) return 'hold.' + part;
    const time = periodKeys(now);
    if (!part) return sayFirst(time);
    const place = 'touch.' + part;
    const keys = placeFirst ? [place, ...time] : [...time, place];
    placeFirst = !placeFirst;
    return sayFirst(keys);
  }
  // 触った（hold は長押し）。出したセリフのキー、黙ったときは null
  function touch(part = null, hold = false, now = Date.now()) {
    try { return touchStep(part, hold, now); } finally { remember(); }
  }
  function touchStep(part, hold, now) {
    if (lastAt && now - lastAt > CALM_MS) muteLevel = 0; // しばらく触らなかった：黙る時間は5分に戻る
    lastAt = now;
    if (now < mutedUntil) return null; // 打ち切りのあいだは黙る
    if (stoppedAt) { // 打ち切りのあと、時間をおいてまた触った
      const back = now - mutedUntil <= RETURN_MS;
      stoppedAt = 0; stage = -1; taps = [];
      if (back) { taps.push(now); return say('touch.return') ? 'touch.return' : null; }
    }
    const last = taps.length ? taps[taps.length - 1] : 0;
    if (stage >= 0 && now - last > KEEP_MS) stage = -1; // しばらく触らなかった：通常に戻る
    taps = taps.filter((t) => now - t <= KEEP_MS).concat(now);
    if (stage < 0) {
      if (taps.filter((t) => now - t <= RAPID_MS).length < RAPID_N) return normal(part, hold, now);
      stage = 0; inStage = 0;
    } else if (++inStage >= STEP_TAPS && stage < STAGES.length - 1) {
      stage += 1; inStage = 0;
    }
    const name = STAGES[stage];
    if (name === 'stop') {
      mutedUntil = now + Math.min(MUTE_MS * 2 ** muteLevel, MUTE_MAX_MS);
      muteLevel += 1;
      stoppedAt = now; taps = []; stage = -1;
    }
    return say('touch.' + name) ? 'touch.' + name : null;
  }

  // ---------- どこを触ったか ----------
  // 写真の立ち絵：画像の上の位置（0〜1）で、部位の印（db.portrait.spots）に入っていればその部位。印の大きさは画像の幅に対する割合
  function partAt(fx, fy, rect) {
    const spots = Portrait.spots();
    let best = null;
    for (const part of PARTS) {
      for (const s of [].concat(spots[part] || [])) { // 手と足は2つまで
        const d = Math.hypot((fx - s.x) * rect.width, (fy - s.y) * rect.height);
        if (d <= s.r * rect.width && (!best || d < best.d)) best = { part, d };
      }
    }
    return best ? best.part : null;
  }
  // 触ってよい所か。部品（ボタン・セリフの面・次の予定・記録）の上・夕方の提案中・立ち絵の外は null。立ち絵の上なら { part }。
  // 時計の文字の上は触ってよい（全画面の立ち絵では、頭が時計の後ろに来ることが多いため）
  function hit(e) {
    if (document.body.dataset.state !== 'ready' || $('view-home').hidden) return null;
    const t = e.target;
    if (!(t instanceof Element) || t.closest('button, a, input, textarea, select, label, dialog, .dialogue, .next-strip, .record-dock, .toast, .portrait-editor')) return null;
    if (!$('bubble-choices').hidden || !$('bubble-mood').hidden) return null; // 夕方の提案中
    const x = e.clientX, y = e.clientY;
    if (!$('portrait-layer').hidden) {
      const r = $('portrait-photo').getBoundingClientRect();
      const fx = (x - r.left) / r.width, fy = (y - r.top) / r.height;
      if (!(fx >= 0 && fx <= 1 && fy >= 0 && fy <= 1)) return null;
      return { part: partAt(fx, fy, r) };
    }
    const r = $('portrait').getBoundingClientRect(); // 紋章（または同梱の立ち絵）：場所なし
    return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom ? { part: null } : null;
  }

  let down = null;
  function cancel() { if (down) clearTimeout(down.timer); down = null; }
  const home = $('view-home');
  home.addEventListener('pointerdown', (e) => {
    if (!e.isPrimary) return;
    cancel();
    const h = hit(e);
    if (!h) return;
    down = { x: e.clientX, y: e.clientY, part: h.part, held: false };
    down.timer = setTimeout(() => { if (down) { down.held = true; touch(down.part, true); } }, HOLD_MS);
  });
  home.addEventListener('pointermove', (e) => { if (down && Math.hypot(e.clientX - down.x, e.clientY - down.y) > MOVE_PX) cancel(); });
  home.addEventListener('pointerup', () => {
    if (!down) return;
    clearTimeout(down.timer);
    if (!down.held) touch(down.part, false);
    down = null;
  });
  home.addEventListener('pointercancel', cancel);
  // 長押しで文字の選択や画像の保存の一覧が出ないように（iPhone）
  home.addEventListener('contextmenu', (e) => { if (hit(e)) e.preventDefault(); });

  return { touch, partAt, PARTS };
})();

// ---------- ホームを開いたときの場面（D-083 ④の優先順） ----------
// 通知から開いた ＞ 夕方の提案 ＞ 初回起動 ＞ 翌日の再訪・疲れた日 ＞ 記録のくせ ＞ 節目 ＞ タスクの進み具合 ＞ レア ＞ 時間帯の一言。
// 通知と夕方の提案は app.js（applyOpenParams・offerEvening）、時間帯の一言は app.js の showIdle が受け持つ。ここはその間
const Scenes = (() => {
  const MILESTONES = [7, 30, 100];   // 使い始めて何日目か（使い始めた日を1日目）
  const LATE_MIN = 30;               // 就寝の記録が予定よりこの分を超えて遅ければ「遅かった」
  const RARE = 1 / 50;               // ホームを開いたときのレアの確率（1日1回まで）

  function load() {
    const s = Store.read(DB.scenes, {});
    return s && typeof s === 'object' && !Array.isArray(s) ? { shown: {}, ...s, shown: s.shown && typeof s.shown === 'object' ? s.shown : {} } : { shown: {} };
  }
  function save(s) { return Store.write(DB.scenes, s); }
  const yesterdayKey = (now) => dateStr(addDays(logicalDay(now), -1));

  // 使い始めた日：記録・日報・タスクのいちばん古い日（なければ今日）。一度決めたら覚える
  function since(s, now) {
    if (s.since) return s.since;
    const days = [...Object.keys(Records.all()), ...Object.keys(Report.load())].filter((k) => /^\d{4}-\d{2}-\d{2}$/.test(k));
    for (const t of Tasks.load()) if (t.createdAt) days.push(todayKey(new Date(t.createdAt)));
    days.push(todayKey(now));
    s.since = days.sort()[0];
    return s.since;
  }
  // 初回起動：はじめにの画面のあと、ホームで1回だけ。この仕組みより前から使っている人には出さない（記録・日報・タスクがある）
  function firstLaunch(s, now) {
    if (s.first) return null;
    const used = Object.keys(Records.all()).length || Object.keys(Report.load()).length || Tasks.load().length;
    s.first = todayKey(now);
    return used ? null : 'first_launch.default';
  }
  // 翌日の再訪・疲れた日（それぞれ1日1回）
  function careKeys(now) {
    const keys = [];
    const y = yesterdayKey(now);
    const yr = Report.load()[y];
    if (yr && yr.mood === 'tired') keys.push('home.after_tired');
    const sleep = Records.all()[y] && Records.all()[y].sleep;
    const planned = Routine.timesFor(parseDay(y)).sleep;
    if (sleep && sleep.time && planned && routineMinutes(sleep.time) > routineMinutes(planned) + LATE_MIN) keys.push('home.after_late');
    if (todayMood(now) === 'tired') keys.push('home.tired_today');
    return keys;
  }
  // 節目：使い始めて 7・30・100 日目（その日1回）
  function milestone(s, now) {
    const n = Math.round((parseDay(todayKey(now)) - parseDay(since(s, now))) / 86400000) + 1;
    return MILESTONES.includes(n) ? `rare.day${n}` : null;
  }
  // タスクの進み具合：今日（朝4時区切り）完了した数が、前にホームを見たときより増えていたら
  function tasksProgress(s, now) {
    const today = todayKey(now);
    const list = Tasks.load();
    const done = list.filter((t) => t.done && t.doneAt && todayKey(new Date(t.doneAt)) === today).length;
    const seen = s.tasksSeen && s.tasksSeen.date === today ? s.tasksSeen.done : null;
    s.tasksSeen = { date: today, done };
    if (seen === null || done <= seen) return null;
    const left = list.filter((t) => !t.done && t.due && t.due <= today).length;
    return { key: left ? 'home.tasks_some' : 'home.tasks_all', vars: { done, left } };
  }
  const shownToday = (s, key, now) => s.shown[key] === todayKey(now);
  function mark(s, key, now) { s.shown[key] = todayKey(now); }

  // ホームを開いたとき（app.js の showIdle から）。出したら true
  function show(now = new Date()) {
    const s = load();
    try {
      const first = firstLaunch(s, now);
      if (first && showLine(first)) return true;
      for (const key of careKeys(now)) {
        if (!shownToday(s, key, now) && showLine(key)) { mark(s, key, now); return true; }
      }
      const pattern = typeof Stats !== 'undefined' ? Stats.patternLine(now) : null; // 記録のくせ（D-060 ⑩）
      if (pattern && showLine(pattern)) { Stats.markShown(pattern, now); return true; }
      const ms = milestone(s, now);
      if (ms && !s.shown[ms] && showLine(ms)) { s.shown[ms] = todayKey(now); return true; }
      const tp = tasksProgress(s, now);
      if (tp && showLine(tp.key, { vars: tp.vars })) return true;
      if (!shownToday(s, 'rare.open', now) && Math.random() < RARE && showLine('rare.open')) { mark(s, 'rare.open', now); return true; }
      return false;
    } finally {
      save(s);
    }
  }
  // タスクの画面などからホームに戻ったとき：タスクの進み具合だけを見る（夕方の提案・通知の強調中は出さない）
  function backHome(now = new Date()) {
    if (!document.getElementById('bubble-choices').hidden || !document.getElementById('bubble-mood').hidden) return false;
    if (document.body.classList.contains('from-notification')) return false;
    const s = load();
    const tp = tasksProgress(s, now);
    save(s);
    return Boolean(tp && showLine(tp.key, { vars: tp.vars }));
  }
  window.addEventListener('hashchange', () => { if (location.hash === '#home' || location.hash === '') backHome(); });
  return { show, backHome, load };
})();
