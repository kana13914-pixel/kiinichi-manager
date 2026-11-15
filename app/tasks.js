// タスク画面（D-026 ①, D-031）。1件は「名前・期限（日付。なくてもよい）・完了」。
// 完了したタスクは完了日を持ち、完了日から7日たつと自動で消す。削除は確認してから行う。
// 保存は仮に localStorage（D-026 ⑤）。フェーズ2のデータ設計で移すか捨てるかを決める。
// app.js の pad / dateStr / pickLine / dialogueReady を使うため、app.js の後に読み込む。

const Tasks = (() => {
  const KEY = 'tasks.v1';
  const DONE_SHOWN = 30; // 完了したものは新しい順にここまで表示する
  const KEEP_DONE_DAYS = 7; // 完了したタスクを残す日数（完了日を1日目として7日間。D-031）

  // ---------- 保存 ----------
  function load() {
    try {
      const list = JSON.parse(localStorage.getItem(KEY) || '[]');
      return Array.isArray(list) ? list.filter((t) => t && typeof t.title === 'string') : [];
    } catch (_) { return []; }
  }
  function save(list) {
    try { localStorage.setItem(KEY, JSON.stringify(list)); } catch (_) {} // 失敗しても画面は動かす
  }
  function newId() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  }

  // ---------- 期限 ----------
  function addDays(d, n) { const x = new Date(d); x.setDate(x.getDate() + n); return x; }
  // 期限の表示：期限切れ / 今日 / 明日 / 11/20(金)
  function dueInfo(due, now = new Date()) {
    if (!due) return null;
    const today = dateStr(now);
    const tomorrow = dateStr(addDays(now, 1));
    const [y, m, d] = due.split('-').map(Number);
    const label = new Date(y, m - 1, d).toLocaleDateString('ja-JP', { month: 'numeric', day: 'numeric', weekday: 'short' });
    if (due < today) return { text: `期限切れ（${label}）`, overdue: true };
    if (due === today) return { text: '今日まで', overdue: false };
    if (due === tomorrow) return { text: '明日まで', overdue: false };
    return { text: `${label}まで`, overdue: false };
  }
  // 完了日から7日たったものを除く。完了日のない完了済み（古いデータ）は今日完了したことにする
  function tidy(list, now = new Date()) {
    const limit = dateStr(addDays(now, -KEEP_DONE_DAYS)); // この日までに完了したものを消す
    let changed = false;
    const kept = list.filter((t) => {
      if (!t.done) return true;
      if (!t.doneAt) { t.doneAt = now.getTime(); changed = true; }
      return dateStr(new Date(t.doneAt)) > limit;
    });
    return { list: kept, changed: changed || kept.length !== list.length };
  }
  function dayLabel(ms) {
    return new Date(ms).toLocaleDateString('ja-JP', { month: 'numeric', day: 'numeric', weekday: 'short' });
  }
  // 未完了の並び：期限切れ・期限の近い順、期限なしは最後、同じなら作った順
  function sortOpen(list) {
    return list.filter((t) => !t.done).sort((a, b) => {
      if (a.due && b.due && a.due !== b.due) return a.due < b.due ? -1 : 1;
      if (!!a.due !== !!b.due) return a.due ? -1 : 1;
      return (a.createdAt || 0) - (b.createdAt || 0);
    });
  }
  function sortDone(list) {
    return list.filter((t) => t.done).sort((a, b) => (b.doneAt || 0) - (a.doneAt || 0)).slice(0, DONE_SHOWN);
  }

  // ---------- 表示 ----------
  const $ = (id) => document.getElementById(id);

  function row(task, now) {
    const li = document.createElement('li');
    li.className = 'task-row' + (task.done ? ' done' : '');
    li.dataset.id = task.id;

    const main = document.createElement('button');
    main.type = 'button';
    main.className = 'task-main';
    main.setAttribute('aria-pressed', String(!!task.done)); // 押すと完了／未完了が切り替わる
    const box = document.createElement('span');
    box.className = 'task-check';
    box.setAttribute('aria-hidden', 'true');
    box.textContent = task.done ? '✓' : '';
    const body = document.createElement('span');
    body.className = 'task-body';
    const title = document.createElement('span');
    title.className = 'task-title';
    title.textContent = task.title;
    body.append(title);
    const info = dueInfo(task.due, now);
    if (info && !task.done) {
      const due = document.createElement('span');
      due.className = 'task-due' + (info.overdue ? ' overdue' : '');
      due.textContent = info.text;
      body.append(due);
    }
    if (task.done && task.doneAt) {
      const at = document.createElement('span');
      at.className = 'task-due';
      at.textContent = `${dayLabel(task.doneAt)} に完了`;
      body.append(at);
    }
    main.append(box, body);
    main.addEventListener('click', () => toggle(task.id));

    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'task-del';
    del.setAttribute('aria-label', `「${task.title}」を削除`);
    del.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 7h14M10 7V5h4v2M7 7l1 13h8l1-13"/></svg>';
    del.addEventListener('click', () => remove(task.id));

    li.append(main, del);
    return li;
  }

  // 一言の条件：0件 → 期限切れあり → 今日まであり → それ以外
  function sayKey(open, now) {
    if (open.length === 0) return 'screen_empty.tasks';
    const today = dateStr(now);
    if (open.some((t) => t.due && t.due < today)) return 'tasks_status.overdue';
    if (open.some((t) => t.due === today)) return 'tasks_status.today';
    return 'tasks_status.open';
  }
  let shownSay = null;
  function render(now = new Date()) {
    const tidied = tidy(load(), now);
    if (tidied.changed) save(tidied.list);
    const list = tidied.list;
    const open = sortOpen(list);
    const done = sortDone(list);
    $('task-list').replaceChildren(...open.map((t) => row(t, now)));
    $('done-list').replaceChildren(...done.map((t) => row(t, now)));
    $('done-count').textContent = String(list.filter((t) => t.done).length);
    $('done-section').hidden = done.length === 0;
    const key = sayKey(open, now);
    if (key !== shownSay) { // 状況が変わったときだけセリフを選び直す（開くたびに変わらないように）
      shownSay = key;
      dialogueReady.then(() => {
        if (shownSay !== key) return;
        const picked = pickLine(key);
        $('tasks-say-line').textContent = picked ? picked.text : '…';
      });
    }
  }

  // ---------- 取り消し（5秒） ----------
  let toastTimer = null;
  let undoAction = null;
  function hideToast() {
    $('task-toast').hidden = true;
    undoAction = null;
    clearTimeout(toastTimer);
  }
  function showToast(message, undo) {
    undoAction = undo;
    const toast = $('task-toast');
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
    toast.replaceChildren(msg, btn);
    toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(hideToast, 5000);
  }

  // ---------- 操作 ----------
  function update(id, fn) {
    const list = load();
    const t = list.find((x) => x.id === id);
    if (!t) return null;
    const before = { ...t };
    fn(t);
    save(list);
    render();
    return before;
  }
  function toggle(id) {
    const before = update(id, (t) => { t.done = !t.done; t.doneAt = t.done ? Date.now() : null; });
    if (!before) return;
    if (!before.done) {
      showToast(`「${before.title}」を完了にしました`, () => update(id, (t) => { t.done = false; t.doneAt = null; }));
    } else {
      hideToast(); // 完了→未完了に戻すのは、それ自体が取り消しなのでトーストは出さない
    }
  }
  async function remove(id) {
    const target = load().find((x) => x.id === id);
    if (!target || !(await confirmDialog(`「${target.title}」を削除しますか？`))) return;
    const list = load();
    const index = list.findIndex((x) => x.id === id);
    if (index < 0) return;
    const [removed] = list.splice(index, 1);
    save(list);
    render();
    showToast(`「${removed.title}」を削除しました`, () => {
      const now = load();
      now.splice(Math.min(index, now.length), 0, removed);
      save(now);
      render();
    });
  }
  function add(title, due) {
    const list = load();
    list.push({ id: newId(), title, due: due || null, done: false, doneAt: null, createdAt: Date.now() });
    save(list);
    render();
  }

  // ---------- 追加フォーム ----------
  let chosenDue = null; // 'YYYY-MM-DD' または null
  function setChip(kind) {
    for (const c of document.querySelectorAll('#task-form .chip')) c.setAttribute('aria-pressed', String(c.dataset.due === kind));
  }
  function openForm() {
    $('task-add-open').hidden = true;
    $('task-form').hidden = false;
    $('task-title').value = '';
    $('task-due').value = '';
    $('task-form-status').textContent = '';
    chosenDue = null;
    setChip('none');
    $('task-title').focus();
    $('task-form').scrollIntoView({ block: 'end' }); // フォームの下端（追加ボタン）まで見えるように
  }
  function closeForm() {
    $('task-form').hidden = true;
    $('task-add-open').hidden = false;
  }
  $('task-add-open').addEventListener('click', openForm);
  $('task-cancel').addEventListener('click', closeForm);
  for (const chip of document.querySelectorAll('#task-form .chip')) {
    chip.addEventListener('click', () => {
      const now = new Date();
      chosenDue = chip.dataset.due === 'today' ? dateStr(now) : chip.dataset.due === 'tomorrow' ? dateStr(addDays(now, 1)) : null;
      $('task-due').value = chosenDue || '';
      setChip(chip.dataset.due);
    });
  }
  $('task-due').addEventListener('change', () => {
    chosenDue = $('task-due').value || null;
    setChip(chosenDue ? '' : 'none');
  });
  $('task-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const title = $('task-title').value.trim();
    if (!title) {
      $('task-form-status').textContent = 'やることを入力してください';
      return;
    }
    add(title.slice(0, 100), chosenDue);
    closeForm();
  });

  // 画面を開いたとき・日付が変わりうるときに描き直す（期限の表示が日付に依存するため）
  window.addEventListener('hashchange', () => { if (location.hash === '#tasks') render(); });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') render(); });
  render();

  return { load, dueInfo, sortOpen, tidy, render };
})();
