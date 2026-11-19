// タイマー画面（D-026 ③, D-028）。用途別のタイマー（作業・休憩・入浴・歯磨き。時間は変えられる：D-044）、時間を指定、利用者が作るタイマー。
// 動かせるのは同時に1つ。終了時刻を保存するので、アプリを閉じても残り時間は正しく進む。
// アプリを閉じている間の終了は、開始時に通知を予約して知らせる（D-015。送信サーバーの /api/schedule・/api/cancel）。
// 保存は localStorage の db.timer（D-043。形は docs/data_schema.md）。util.js（保存）、dialogue.js（セリフ）、ui.js（確認・取り消しの表示・ごみ箱）、
// settings.js の Settings、app.js の repairPush（購読の登録し直し）を使う。

const Timer = (() => {
  const KEY = DB.timer;
  const NOTIFY_KEY = 'timer'; // 通知予約のキー。動かせるのは1つなので固定（同じキーは上書きされる）
  const MAX_MINUTES = 600;
  const NAME_MAX = 30;
  const FALLBACK_LINE = '時間だ。';
  // 用途別のタイマー（D-026 ③）。kind は終了時のセリフ（timer_done.*）の条件
  const BUILTIN = [
    { id: 'work', name: '作業', minutes: 25, kind: 'work' },
    { id: 'break', name: '休憩', minutes: 5, kind: 'break' },
    { id: 'bath', name: '入浴', minutes: 20, kind: 'bath' },
    { id: 'brush', name: '歯磨き', minutes: 3, kind: 'brush' },
  ];
  const $ = (id) => document.getElementById(id);

  // ---------- 保存 ----------
  // { custom: [{ id, name, minutes }], builtin: { 用途別の id: 変えた分数 }, running: { name, minutes, kind, endAt, line, text, notify, notifyError } | null, done: { … } | null,
  //   cancelPending: 取り消しがまだ送信サーバーに届いていない }
  function load() {
    let s = Store.read(KEY);
    if (!s || typeof s !== 'object' || Array.isArray(s)) s = {};
    return {
      custom: Array.isArray(s.custom) ? s.custom.filter((t) => t && typeof t.name === 'string' && validMinutes(t.minutes)) : [],
      running: s.running && Number.isFinite(s.running.endAt) ? s.running : null,
      done: s.done && Number.isFinite(s.done.endAt) ? s.done : null,
      cancelPending: s.cancelPending === true,
      builtin: validBuiltin(s.builtin),
    };
  }
  // 用途別のタイマーの、利用者が変えた時間（D-044）。{ work: 50 } のように、変えたものだけ持つ
  function validBuiltin(b) {
    const out = {};
    if (b && typeof b === 'object') {
      for (const t of BUILTIN) if (validMinutes(b[t.id]) && b[t.id] !== t.minutes) out[t.id] = b[t.id];
    }
    return out;
  }
  // 用途別のタイマーの一覧（変えた時間を反映。base は初めの時間）
  function builtins(state) {
    return BUILTIN.map((t) => ({ ...t, base: t.minutes, minutes: state.builtin[t.id] || t.minutes }));
  }
  // 保存できたら true。失敗したら画面に知らせて false（D-033）
  function save(state) {
    if (Store.write(KEY, state)) return true;
    toast.show(SAVE_FAILED);
    return false;
  }
  function validMinutes(n) { return Number.isInteger(n) && n >= 1 && n <= MAX_MINUTES; }
  // 入力欄の文字から分数を読む。1〜600 の整数でなければ null
  function parseMinutes(text) {
    const n = Number(String(text).trim());
    return validMinutes(n) ? n : null;
  }

  // ---------- 通知の予約（D-015） ----------
  // 開始・停止を続けて押しても順番どおりに届くよう、送信サーバーへの呼び出しは1つずつ行う
  let apiChain = Promise.resolve();
  function setNotify(endAt, notify, notifyError) {
    const state = load();
    if (!state.running || state.running.endAt !== endAt) return; // その間に止めた・別のタイマーを始めた
    state.running.notify = notify;
    state.running.notifyError = notifyError || '';
    save(state);
    render();
  }
  function reserve(run) {
    const query = run.line === null ? '' : `&trigger=timer_done.${run.kind}&line=${run.line}&h=${lineHash(run.text)}`; // h は文の印（D-081）
    const body = {
      key: NOTIFY_KEY, at: run.endAt, notBefore: true, // 終わる前には届けない
      title: 'キィニチ', body: run.text,
      url: new URL('index.html?source=webpush' + query + '#timer', location.href).href,
    };
    apiChain = apiChain.then(() => Settings.api('/api/schedule', { method: 'POST', body }))
      // 購読が切れていたら（予約はできても届かない）、登録し直す（D-033）
      .then((r) => (r.subscribed === false ? repairPush() : true))
      .then((ok) => (ok ? setNotify(run.endAt, 'ok') : setNotify(run.endAt, 'ng', '通知の登録が切れています。設定の「通知を有効にする」を押してください')))
      .catch((e) => setNotify(run.endAt, 'ng', e.message === 'Not found' ? '送信サーバーの更新が必要です' : e.message));
  }
  // 取り消しは、送信サーバーに届くまで「取り消し待ち」として保存しておく。
  // 通信の失敗やアプリの終了で届かなかったときは、次に開いたとき・表示に戻ったときにやり直す（止めたタイマーの通知が届かないように。D-033）
  function setCancelPending(value) {
    const state = load();
    if (state.cancelPending === value) return;
    state.cancelPending = value;
    Store.write(KEY, state);
  }
  function cancelReserve() {
    setCancelPending(true);
    sendCancel();
  }
  function sendCancel() {
    apiChain = apiChain.then(() => {
      const state = load();
      // 別のタイマーが動いているなら、同じキーの予約は新しいタイマーのもの。取り消さない
      if (!state.cancelPending || state.running) return null;
      return Settings.api('/api/cancel', { method: 'POST', body: { key: NOTIFY_KEY } }).then(() => setCancelPending(false));
    }).catch(() => {}); // 届かなかったら「取り消し待ち」のまま残す
  }
  function retryCancel() {
    const state = load();
    if (state.cancelPending && !state.running) sendCancel();
  }

  // ---------- 開始・停止・終了 ----------
  function start(name, minutes, kind) {
    const picked = pickLine('timer_done.' + kind); // 通知の本文と、終了の画面に出すセリフを同じにする
    const state = load();
    state.running = {
      name, minutes, kind, endAt: Date.now() + minutes * 60000,
      line: picked ? picked.index : null, text: picked ? picked.text : FALLBACK_LINE,
      notify: 'pending', notifyError: '',
    };
    state.done = null;
    state.cancelPending = false; // 同じキーの予約を上書きするので、前の取り消しは要らない
    if (!save(state)) return false; // 保存できなければ始めない（閉じると消えるタイマーになるため）
    toast.hide();
    reserve(state.running);
    render();
    say.react('timer_start.default', { min: minutes }); // 区切りのよい操作への短い反応（D-059）
    return true;
  }
  // タスクの「タスクを開始」（D-071）：タスクの名前で、作業のタイマー（変えた時間があればその時間）を始める
  const workMinutes = () => builtins(load()).find((t) => t.id === 'work').minutes;
  const startFor = (name) => start(name, workMinutes(), 'work');
  const runningName = () => { const r = load().running; return r ? r.name : null; };
  function stop() {
    const state = load();
    if (!state.running) return;
    state.running = null;
    save(state);
    cancelReserve();
    render();
  }
  function closeDone() {
    const state = load();
    state.done = null;
    save(state);
    render();
  }
  // 時刻が来ていたら「終了」に移す。画面を見ているなら、同じ知らせが後から届かないよう通知の予約を取り消す
  function settle(state, now) {
    let changed = false;
    if (state.running && now >= state.running.endAt) {
      state.done = { ...state.running, cleared: false };
      state.running = null;
      changed = true;
    }
    let cancel = false;
    if (state.done && !state.done.cleared && document.visibilityState === 'visible') {
      state.done.cleared = true;
      state.cancelPending = true;
      cancel = true;
      changed = true;
    }
    if (changed) Store.write(KEY, state);
    if (cancel) sendCancel();
  }

  // ---------- 表示 ----------
  function clockText(ms) {
    const s = Math.max(0, Math.ceil(ms / 1000));
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    return h ? `${h}:${pad(m)}:${pad(sec)}` : `${pad(m)}:${pad(sec)}`;
  }
  const setIf = setIfChanged;

  // 1行：名前（押すと開始）｜時間（押すと変える。D-044）｜▶（押すと開始）｜（自分で作ったものは）ごみ箱
  function row(t, custom) {
    const li = document.createElement('li');
    li.className = 'task-row';
    li.dataset.id = t.id;
    const begin = () => start(t.name, t.minutes, t.kind || 'default');
    const main = document.createElement('button');
    main.type = 'button';
    main.className = 'task-main timer-start';
    main.setAttribute('aria-label', `「${t.name}」${t.minutes}分を開始`);
    const name = document.createElement('span');
    name.className = 'task-title';
    name.textContent = t.name;
    main.append(name);
    main.addEventListener('click', begin);
    const min = document.createElement('button');
    min.type = 'button';
    min.className = 'timer-min';
    min.setAttribute('aria-label', `「${t.name}」の時間を変える（今は${t.minutes}分）`);
    const minText = document.createElement('span');
    minText.textContent = `${t.minutes}分`;
    min.append(minText);
    min.addEventListener('click', () => openForm({ id: t.id, custom }));
    const go = document.createElement('button'); // 押すと始まることを見た目で示す（Q-D）。名前のボタンと同じ働きなので、読み上げとキー操作からは外す
    go.type = 'button';
    go.className = 'timer-go';
    go.setAttribute('aria-hidden', 'true');
    go.tabIndex = -1;
    go.textContent = '▶';
    go.addEventListener('click', begin);
    li.append(main, min, go);
    if (custom) li.append(trashButton(`「${t.name}」を削除`, () => removeCustom(t.id)));
    return li;
  }

  const NOTIFY_TEXT = {
    pending: ['通知を予約しています…', 'status'],
    ok: ['アプリを閉じていても、終わったら通知で知らせます', 'status ok'],
  };
  const say = makeSay($('timer-say-line')); // 画面を開いたときの一言（Q-A）。終了のときは終了のセリフ（timer_done.*）だけを出す
  let listKey = null;
  let ticker = null;
  function render(now = Date.now()) {
    const state = load();
    settle(state, now);
    const mode = state.running ? 'running' : state.done ? 'done' : 'idle';
    $('timer-idle').hidden = mode !== 'idle';
    $('timer-running').hidden = mode !== 'running';
    $('timer-done').hidden = mode !== 'done';
    $('timer-say').hidden = mode === 'done'; // 一言は 1 画面に 1 つ（C10-02）
    if (mode !== 'done') say('timer_status.' + mode);

    if (mode === 'idle') {
      const key = JSON.stringify([state.custom, state.builtin]);
      if (key !== listKey) { // 一覧が変わったときだけ作り直す
        listKey = key;
        $('timer-list').replaceChildren(...builtins(state).map((t) => row(t, false)), ...state.custom.map((t) => row(t, true)));
      }
    } else if (mode === 'running') {
      const r = state.running;
      setIf($('timer-name'), `${r.name}（${r.minutes}分）`);
      setIf($('timer-rest'), clockText(r.endAt - now));
      // 残りの割合で輪を減らす（CR-G02）。周の長さは HTML の stroke-dasharray
      const arc = $('timer-arc');
      const total = r.minutes * 60000;
      const left = Math.min(1, Math.max(0, (r.endAt - now) / total));
      arc.setAttribute('stroke-dashoffset', String(Number(arc.getAttribute('stroke-dasharray')) * (1 - left)));
      setIf($('timer-end'), `${hm(new Date(r.endAt))} に終わる`);
      const [text, cls] = NOTIFY_TEXT[r.notify]
        || [`通知を予約できませんでした（${r.notifyError || '理由不明'}）。アプリを開いている間だけ、ここに終了を表示します`, 'status ng'];
      setIf($('timer-notify'), text);
      if ($('timer-notify').className !== cls) $('timer-notify').className = cls;
    } else {
      const d = state.done;
      setIf($('timer-done-title'), `${d.name}（${d.minutes}分）が終わった`);
      setIf($('timer-done-at'), `${hm(new Date(d.endAt))} に終了`);
      setIf($('timer-done-line'), d.text || FALLBACK_LINE);
    }

    // 動いている間だけ、残り時間を書き換える
    if (mode === 'running' && ticker === null) ticker = setInterval(() => render(), 250);
    if (mode !== 'running' && ticker !== null) { clearInterval(ticker); ticker = null; }
  }

  const toast = makeToast($('timer-toast')); // 取り消し（5秒）と、保存の失敗の知らせ

  // ---------- 利用者が作るタイマー ----------
  async function removeCustom(id) {
    const target = load().custom.find((t) => t.id === id);
    if (!target || !(await confirmDialog(`「${target.name}」を削除しますか？`))) return;
    const state = load();
    const index = state.custom.findIndex((t) => t.id === id);
    if (index < 0) return;
    const [removed] = state.custom.splice(index, 1);
    if (!save(state)) return;
    render();
    toast.show(`「${removed.name}」を削除しました`, () => {
      const now = load();
      now.custom.splice(Math.min(index, now.custom.length), 0, removed);
      save(now);
      render();
    });
  }
  // 作るフォームは、時間を変えるときにも使う（D-044）。editing = null（新しく作る）／{ id, custom }（変える）
  let editing = null;
  function openForm(target = null) {
    const state = load();
    const t = target && (target.custom ? state.custom.find((x) => x.id === target.id) : builtins(state).find((x) => x.id === target.id));
    editing = t ? target : null;
    $('timer-new-open').hidden = true;
    $('timer-quick').hidden = true; // 金の塗りを「保存」1つにする
    $('timer-form').hidden = false;
    $('timer-form-title').textContent = !t ? 'タイマーを作る' : target.custom ? `「${t.name}」を変える` : `「${t.name}」の時間を変える`;
    const fixedName = Boolean(t) && !target.custom; // 用途別のタイマーは名前を変えられない
    $('timer-new-name').hidden = fixedName;
    $('timer-new-name-label').hidden = fixedName;
    $('timer-new-name').value = t ? t.name : '';
    $('timer-new-min').value = t ? String(t.minutes) : '';
    // 用途別のタイマーの時間を変えてあるときだけ、初めの時間に戻すボタンを出す
    const changed = fixedName && t.minutes !== t.base;
    $('timer-new-reset').hidden = !changed;
    if (changed) $('timer-new-reset').textContent = `初めの時間（${t.base}分）に戻す`;
    $('timer-form-status').textContent = '';
    (t ? $('timer-new-min') : $('timer-new-name')).focus();
    if (t) $('timer-new-min').select();
    $('timer-form').scrollIntoView({ block: 'end' }); // フォームの下端（保存ボタン）まで見えるように
  }
  function closeForm() {
    editing = null;
    $('timer-form').hidden = true;
    $('timer-quick').hidden = false;
    $('timer-new-open').hidden = false;
  }
  // 用途別のタイマーの時間を保存する。初めの時間と同じなら、変えた印を消す
  function setBuiltinMinutes(state, id, minutes) {
    const base = BUILTIN.find((b) => b.id === id).minutes;
    if (minutes === base) delete state.builtin[id]; else state.builtin[id] = minutes;
  }
  $('timer-new-open').addEventListener('click', () => openForm());
  $('timer-new-cancel').addEventListener('click', closeForm);
  $('timer-new-reset').addEventListener('click', () => {
    if (!editing || editing.custom) return;
    const state = load();
    delete state.builtin[editing.id];
    if (!Store.write(KEY, state)) { $('timer-form-status').textContent = SAVE_FAILED; return; }
    closeForm();
    render();
  });
  $('timer-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const name = $('timer-new-name').value.trim().slice(0, NAME_MAX);
    const minutes = parseMinutes($('timer-new-min').value);
    const fixedName = editing && !editing.custom;
    if (!fixedName && !name) { $('timer-form-status').textContent = '名前を入力してください'; return; }
    if (minutes === null) { $('timer-form-status').textContent = `時間は1〜${MAX_MINUTES}分で入力してください`; return; }
    const state = load();
    if (fixedName) {
      setBuiltinMinutes(state, editing.id, minutes);
    } else if (editing) {
      const t = state.custom.find((x) => x.id === editing.id);
      if (t) { t.name = name; t.minutes = minutes; }
    } else {
      state.custom.push({ id: newId(), name, minutes });
    }
    if (!Store.write(KEY, state)) { $('timer-form-status').textContent = SAVE_FAILED; return; } // 入力を残したまま知らせる
    closeForm();
    render();
  });

  // ---------- 時間を指定して開始 ----------
  $('timer-quick').addEventListener('submit', (e) => {
    e.preventDefault();
    const minutes = parseMinutes($('timer-quick-min').value);
    if (minutes === null) { $('timer-quick-status').textContent = `時間は1〜${MAX_MINUTES}分で入力してください`; return; }
    $('timer-quick-status').textContent = '';
    $('timer-quick-min').value = '';
    start('タイマー', minutes, 'default');
  });

  $('timer-stop').addEventListener('click', stop);
  $('timer-close').addEventListener('click', closeDone);

  onShow('timer', () => render());
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') retryCancel(); });
  // セリフ集を読み終える前に終わっていても表示は出す。予約の途中で閉じられていたら予約し直す
  const first = load();
  if (first.running && first.running.notify === 'pending' && Date.now() < first.running.endAt) reserve(first.running);
  render();
  retryCancel(); // 前回届かなかった取り消しをやり直す

  return { load, builtins, parseMinutes, clockText, render, startFor, workMinutes, runningName };
})();
