// タイマー画面（D-026 ③, D-028）。用途別のタイマー（作業・休憩・入浴・歯磨き）、時間を指定、利用者が作るタイマー。
// 動かせるのは同時に1つ。終了時刻を保存するので、アプリを閉じても残り時間は正しく進む。
// アプリを閉じている間の終了は、開始時に通知を予約して知らせる（D-015。送信サーバーの /api/schedule・/api/cancel）。
// 保存は仮に localStorage（D-026 ⑤）。app.js の pad / hm / pickLine / dialogueReady と settings.js の Settings を使う。

const Timer = (() => {
  const KEY = 'timer.v1';
  const NOTIFY_KEY = 'timer'; // 通知予約のキー。動かせるのは1つなので固定（同じキーは上書きされる）
  const MAX_MINUTES = 600;
  const NAME_MAX = 30;
  const FALLBACK_LINE = '時間だ。タイマーが終わった。';
  // 用途別のタイマー（D-026 ③）。kind は終了時のセリフ（timer_done.*）の条件
  const BUILTIN = [
    { id: 'work', name: '作業', minutes: 25, kind: 'work' },
    { id: 'break', name: '休憩', minutes: 5, kind: 'break' },
    { id: 'bath', name: '入浴', minutes: 20, kind: 'bath' },
    { id: 'brush', name: '歯磨き', minutes: 3, kind: 'brush' },
  ];
  const $ = (id) => document.getElementById(id);

  // ---------- 保存 ----------
  // { custom: [{ id, name, minutes }], running: { name, minutes, kind, endAt, line, text, notify, notifyError } | null, done: { … } | null }
  function load() {
    let s = null;
    try { s = JSON.parse(localStorage.getItem(KEY) || 'null'); } catch (_) {}
    if (!s || typeof s !== 'object' || Array.isArray(s)) s = {};
    return {
      custom: Array.isArray(s.custom) ? s.custom.filter((t) => t && typeof t.name === 'string' && validMinutes(t.minutes)) : [],
      running: s.running && Number.isFinite(s.running.endAt) ? s.running : null,
      done: s.done && Number.isFinite(s.done.endAt) ? s.done : null,
    };
  }
  function save(state) {
    try { localStorage.setItem(KEY, JSON.stringify(state)); } catch (_) {} // 失敗しても画面は動かす
  }
  function validMinutes(n) { return Number.isInteger(n) && n >= 1 && n <= MAX_MINUTES; }
  // 入力欄の文字から分数を読む。1〜600 の整数でなければ null
  function parseMinutes(text) {
    const n = Number(String(text).trim());
    return validMinutes(n) ? n : null;
  }
  function newId() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }

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
    const query = run.line === null ? '' : `&trigger=timer_done.${run.kind}&line=${run.line}`;
    const body = {
      key: NOTIFY_KEY, at: run.endAt, notBefore: true, // 終わる前には届けない
      title: 'キィニチ', body: run.text,
      url: new URL('index.html?source=webpush' + query + '#timer', location.href).href,
    };
    apiChain = apiChain.then(() => Settings.api('/api/schedule', { method: 'POST', body }))
      .then(() => setNotify(run.endAt, 'ok'))
      .catch((e) => setNotify(run.endAt, 'ng', e.message === 'Not found' ? '送信サーバーの更新が必要です' : e.message));
  }
  function cancelReserve() {
    apiChain = apiChain.then(() => Settings.api('/api/cancel', { method: 'POST', body: { key: NOTIFY_KEY } })).catch(() => {});
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
    save(state);
    hideToast();
    reserve(state.running);
    render();
  }
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
    if (state.done && !state.done.cleared && document.visibilityState === 'visible') {
      state.done.cleared = true;
      cancelReserve();
      changed = true;
    }
    if (changed) save(state);
  }

  // ---------- 表示 ----------
  function clockText(ms) {
    const s = Math.max(0, Math.ceil(ms / 1000));
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    return h ? `${h}:${pad(m)}:${pad(sec)}` : `${pad(m)}:${pad(sec)}`;
  }
  function setIf(el, text) { if (el.textContent !== text) el.textContent = text; } // 変わったときだけ書き換える（P3-04）

  function row(t, custom) {
    const li = document.createElement('li');
    li.className = 'task-row';
    li.dataset.id = t.id;
    const main = document.createElement('button');
    main.type = 'button';
    main.className = 'task-main timer-start';
    main.setAttribute('aria-label', `「${t.name}」${t.minutes}分を開始`);
    const name = document.createElement('span');
    name.className = 'task-title';
    name.textContent = t.name;
    const min = document.createElement('span');
    min.className = 'timer-min';
    min.textContent = `${t.minutes}分`;
    main.append(name, min);
    main.addEventListener('click', () => start(t.name, t.minutes, t.kind || 'default'));
    li.append(main);
    if (custom) {
      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'task-del';
      del.setAttribute('aria-label', `「${t.name}」を削除`);
      del.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 7h14M10 7V5h4v2M7 7l1 13h8l1-13"/></svg>';
      del.addEventListener('click', () => removeCustom(t.id));
      li.append(del);
    }
    return li;
  }

  const NOTIFY_TEXT = {
    pending: ['通知を予約しています…', 'status'],
    ok: ['アプリを閉じていても、終わったら通知で知らせます', 'status ok'],
  };
  let listKey = null;
  let ticker = null;
  function render(now = Date.now()) {
    const state = load();
    settle(state, now);
    const mode = state.running ? 'running' : state.done ? 'done' : 'idle';
    $('timer-idle').hidden = mode !== 'idle';
    $('timer-running').hidden = mode !== 'running';
    $('timer-done').hidden = mode !== 'done';

    if (mode === 'idle') {
      const key = JSON.stringify(state.custom);
      if (key !== listKey) { // 一覧が変わったときだけ作り直す
        listKey = key;
        $('timer-list').replaceChildren(...BUILTIN.map((t) => row(t, false)), ...state.custom.map((t) => row(t, true)));
      }
    } else if (mode === 'running') {
      const r = state.running;
      setIf($('timer-name'), `${r.name}（${r.minutes}分）`);
      setIf($('timer-rest'), clockText(r.endAt - now));
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

  // ---------- 取り消し（5秒） ----------
  let toastTimer = null;
  let undoAction = null;
  function hideToast() {
    $('timer-toast').hidden = true;
    undoAction = null;
    clearTimeout(toastTimer);
  }
  function showToast(message, undo) {
    undoAction = undo;
    const msg = document.createElement('span');
    msg.textContent = message;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'undo';
    btn.textContent = '取り消す';
    btn.addEventListener('click', () => {
      const fn = undoAction;
      hideToast();
      if (fn) fn();
    });
    $('timer-toast').replaceChildren(msg, btn);
    $('timer-toast').hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(hideToast, 5000);
  }

  // ---------- 利用者が作るタイマー ----------
  function removeCustom(id) {
    const state = load();
    const index = state.custom.findIndex((t) => t.id === id);
    if (index < 0) return;
    const [removed] = state.custom.splice(index, 1);
    save(state);
    render();
    showToast(`「${removed.name}」を削除しました`, () => {
      const now = load();
      now.custom.splice(Math.min(index, now.custom.length), 0, removed);
      save(now);
      render();
    });
  }
  function openForm() {
    $('timer-new-open').hidden = true;
    $('timer-quick').hidden = true; // 金の塗りを「保存」1つにする
    $('timer-form').hidden = false;
    $('timer-new-name').value = '';
    $('timer-new-min').value = '';
    $('timer-form-status').textContent = '';
    $('timer-new-name').focus();
    $('timer-form').scrollIntoView({ block: 'end' }); // フォームの下端（保存ボタン）まで見えるように
  }
  function closeForm() {
    $('timer-form').hidden = true;
    $('timer-quick').hidden = false;
    $('timer-new-open').hidden = false;
  }
  $('timer-new-open').addEventListener('click', openForm);
  $('timer-new-cancel').addEventListener('click', closeForm);
  $('timer-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const name = $('timer-new-name').value.trim().slice(0, NAME_MAX);
    const minutes = parseMinutes($('timer-new-min').value);
    if (!name) { $('timer-form-status').textContent = '名前を入力してください'; return; }
    if (minutes === null) { $('timer-form-status').textContent = `時間は1〜${MAX_MINUTES}分で入力してください`; return; }
    const state = load();
    state.custom.push({ id: newId(), name, minutes });
    save(state);
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

  window.addEventListener('hashchange', () => { if (location.hash === '#timer') render(); });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') render(); });
  // セリフ集を読み終える前に終わっていても表示は出す。予約の途中で閉じられていたら予約し直す
  const first = load();
  if (first.running && first.running.notify === 'pending' && Date.now() < first.running.endAt) reserve(first.running);
  render();

  return { load, parseMinutes, clockText, render };
})();
