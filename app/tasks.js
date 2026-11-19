// タスク画面（D-026 ①, D-031, D-070）。1件は「名前・期限（日付。なくてもよい）・優先度・完了・ミニタスク」。
// 一覧は優先度ごと（▲高・●中・▼低・なし）の見出しで区切り、同じ優先度の中は期限の近い順（D-070）。
// 完了は行の右の四角を押す。行のそれ以外を押すと、下から操作の一覧（編集・削除）が出る。
// ミニタスクは親の中に1段だけ（名前と完了だけ、10個まで）。親を完了にすると残りも済んだ扱い（取り消しで戻る）。
// 完了したタスクは完了日を持ち、完了日から7日たつと自動で消す。削除は確認してから行う。
// 「完了したら日報に入れる」をオンにしたタスクは、完了したときにその日の日報の「できたこと」に「・名前」を足す（D-059。report.js）。
// 「今日」「完了日」は朝4時で区切る（D-034）。
// 保存は localStorage の db.tasks（D-043。形は docs/data_schema.md）。
// util.js（日付・保存）、dialogue.js（セリフ）、ui.js（確認・取り消しの表示・ごみ箱）を使う。

const Tasks = (() => {
  const KEY = DB.tasks;
  const DONE_SHOWN = 30; // 完了したものは新しい順にここまで表示する
  const KEEP_DONE_DAYS = 7; // 完了したタスクを残す日数（完了日を1日目として7日間。D-031）

  // ---------- 保存 ----------
  const PRIORITIES = ['high', 'mid', 'low'];
  const SUB_MAX = 10; // 1つの親に足せるミニタスクの数（D-070）
  // 優先度・ミニタスクのない古いデータは「なし」「ミニタスクなし」として読む（D-070）
  function normalize(t) {
    t.priority = PRIORITIES.includes(t.priority) ? t.priority : null;
    t.subtasks = Array.isArray(t.subtasks)
      ? t.subtasks.filter((s) => s && typeof s.title === 'string' && s.id).map((s) => ({ id: s.id, title: s.title, done: !!s.done, doneAt: s.doneAt || null }))
      : [];
    return t;
  }
  function load() {
    const list = Store.read(KEY, []);
    return Array.isArray(list) ? list.filter((t) => t && typeof t.title === 'string').map(normalize) : [];
  }
  // 保存できたら true。失敗したら画面に知らせて false（黙って消えたように見せない。D-033）
  function save(list) {
    if (Store.write(KEY, list)) return true;
    toast.show(SAVE_FAILED);
    return false;
  }

  // ---------- 期限 ----------
  // 期限の表示：期限切れ / 今日 / 明日 / 11/20(金)
  function dueInfo(due, now = new Date()) {
    if (!due) return null;
    const today = todayKey(now);
    const tomorrow = dateStr(addDays(logicalDay(now), 1));
    const label = labelShort(parseDay(due));
    if (due < today) return { text: `期限切れ（${label}）`, overdue: true };
    if (due === today) return { text: '今日まで', overdue: false };
    if (due === tomorrow) return { text: '明日まで', overdue: false };
    return { text: `${label}まで`, overdue: false };
  }
  // 完了日から7日たったものを除く。完了日のない完了済み（古いデータ）は今日完了したことにする
  function tidy(list, now = new Date()) {
    const limit = dateStr(addDays(logicalDay(now), -KEEP_DONE_DAYS)); // この日までに完了したものを消す
    let changed = false;
    const kept = list.filter((t) => {
      if (!t.done) return true;
      if (!t.doneAt) { t.doneAt = now.getTime(); changed = true; }
      return todayKey(new Date(t.doneAt)) > limit;
    });
    return { list: kept, changed: changed || kept.length !== list.length };
  }
  function dayLabel(ms) { return labelShort(logicalDay(new Date(ms))); }
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

  function checkButton(cls, done, label) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = cls;
    btn.setAttribute('aria-pressed', String(!!done));
    btn.setAttribute('aria-label', label);
    const box = document.createElement('span');
    box.className = 'task-check';
    box.setAttribute('aria-hidden', 'true');
    box.textContent = done ? '✓' : '';
    btn.append(box);
    return btn;
  }
  const subOpen = new Set(); // ミニタスクを開いている親（開き直すとたたむ）
  function row(task, now) {
    const li = document.createElement('li');
    li.className = 'task-item' + (task.done ? ' done' : '');
    li.dataset.id = task.id;
    const line = document.createElement('div');
    line.className = 'task-row' + (task.done ? ' done' : '');

    // 行のそれ以外を押すと、操作の一覧（編集・削除）
    const main = document.createElement('button');
    main.type = 'button';
    main.className = 'task-main';
    main.setAttribute('aria-haspopup', 'dialog');
    const body = document.createElement('span');
    body.className = 'task-body';
    const title = document.createElement('span');
    title.className = 'task-title';
    title.textContent = task.title;
    body.append(title);
    const info = dueInfo(task.due, now);
    if ((info || task.toReport) && !task.done) {
      const due = document.createElement('span');
      due.className = 'task-due' + (info && info.overdue ? ' overdue' : '');
      due.textContent = [info && info.text, task.toReport && '完了したら日報へ'].filter(Boolean).join(' ・ ');
      body.append(due);
    }
    if (task.done && task.doneAt) {
      const at = document.createElement('span');
      at.className = 'task-due';
      at.textContent = `${dayLabel(task.doneAt)} に完了`;
      body.append(at);
    }
    main.append(body);
    main.addEventListener('click', () => openActions(task.id));
    // 完了は右の四角（D-070）
    const check = checkButton('task-done-btn', task.done, task.done ? `「${task.title}」を未完了に戻す` : `「${task.title}」を完了にする`);
    check.addEventListener('click', () => toggle(task.id));
    line.append(main, check);
    li.append(line);
    if (!task.done && task.subtasks.length) li.append(...subBlock(task));
    return li;
  }
  // ミニタスク：進み具合の細い帯と ▾。開くと親の下に並び、最後に「＋ ミニタスクを追加」
  function subBlock(task) {
    const subs = task.subtasks;
    const n = subs.filter((x) => x.done).length;
    const open = subOpen.has(task.id);
    const bar = document.createElement('button');
    bar.type = 'button';
    bar.className = 'sub-bar';
    bar.setAttribute('aria-expanded', String(open));
    bar.setAttribute('aria-label', `ミニタスク ${subs.length}個中 ${n}個 済み。${open ? 'たたむ' : '開く'}`);
    bar.innerHTML = '<span class="sub-track" aria-hidden="true"><span class="sub-fill"></span></span><span class="sub-count" aria-hidden="true"></span><span class="sub-caret" aria-hidden="true">▾</span>';
    bar.querySelector('.sub-fill').style.width = `${(100 * n) / subs.length}%`;
    bar.querySelector('.sub-count').textContent = `${n}/${subs.length}`;
    bar.addEventListener('click', () => {
      if (open) { subOpen.delete(task.id); if (subFormAt === task.id) subFormAt = null; } else subOpen.add(task.id);
      render();
    });
    if (!open) return [bar];
    const ul = document.createElement('ul');
    ul.className = 'sub-list';
    ul.setAttribute('aria-label', `「${task.title}」のミニタスク`);
    for (const sub of subs) {
      const li = document.createElement('li');
      li.className = 'sub-row' + (sub.done ? ' done' : '');
      li.dataset.sub = sub.id;
      const name = document.createElement('span');
      name.className = 'sub-title';
      name.textContent = sub.title;
      const check = checkButton('sub-check', sub.done, sub.done ? `「${sub.title}」を未完了に戻す` : `「${sub.title}」を済みにする`);
      check.addEventListener('click', () => toggleSub(task.id, sub.id));
      li.append(name, check);
      ul.append(li);
    }
    if (subs.length < SUB_MAX) ul.append(subAddRow(task.id));
    return [bar, ul];
  }
  // 「＋ ミニタスクを追加」の行。押すとその場で名前を入れる欄になり、足したあとも続けて入れられる。空のまま「追加」で閉じる
  let subFormAt = null; // 名前の欄を開いている親の id
  function focusSubInput(id) {
    const input = document.querySelector(`#task-list .task-item[data-id="${id}"] .sub-add-form input`);
    if (input) input.focus();
  }
  function subAddRow(id) {
    const li = document.createElement('li');
    li.className = 'sub-add';
    if (subFormAt !== id) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'sub-add-btn';
      btn.textContent = '＋ ミニタスクを追加';
      btn.addEventListener('click', () => { subFormAt = id; render(); focusSubInput(id); });
      li.append(btn);
      return li;
    }
    const form = document.createElement('form');
    form.className = 'sub-add-form';
    const input = document.createElement('input');
    input.type = 'text';
    input.maxLength = 100;
    input.enterKeyHint = 'done';
    input.setAttribute('aria-label', 'ミニタスクの名前（空のまま「追加」で閉じる）');
    input.autocomplete = 'off';
    const ok = document.createElement('button');
    ok.type = 'submit';
    ok.className = 'cut-btn quiet chip';
    ok.textContent = '追加';
    form.append(input, ok);
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const title = input.value.trim();
      if (!title) { subFormAt = null; render(); return; }
      if (addSub(id, title.slice(0, 100))) focusSubInput(id); // 10個に届いたら欄ごと消える
    });
    li.append(form);
    return li;
  }

  // 一言の条件：0件 → 期限切れあり → 今日まであり → それ以外
  function sayKey(open, now) {
    if (open.length === 0) return 'screen_empty.tasks';
    const today = todayKey(now);
    if (open.some((t) => t.due && t.due < today)) return 'tasks_status.overdue';
    if (open.some((t) => t.due === today)) return 'tasks_status.today';
    return 'tasks_status.open';
  }
  // 優先度ごとの見出し（D-070、CR-G07）：記号＋文字の小さな札に件数と ▾。押すとたたむ。下に点線の「追加」の欄
  const GROUPS = [['high', '▲', '高'], ['mid', '●', '中'], ['low', '▼', '低'], [null, '', 'なし']];
  // 点線の欄の文字（H-024 で利用者が決めた）
  const SLOT_TEXT = { high: '集中が必要', mid: '通常の作業', low: '簡単な作業', none: 'タスクを追加' };
  // たたんでいる優先度（'high' など。なしは 'none'）。アプリを閉じても覚えておく（db.prefs.taskFolded。この端末だけ）
  const folded = new Set([].concat(Prefs.get('taskFolded')).filter((k) => typeof k === 'string'));
  const saveFolded = () => Prefs.set('taskFolded', [...folded]); // 覚えられなくても、たたむこと自体はできる
  const groupKey = (p) => p || 'none';
  function withGroups(open, now) {
    const out = [];
    for (const [id, mark, label] of GROUPS) {
      const key = groupKey(id);
      const items = open.filter((t) => t.priority === id);
      const isFolded = folded.has(key);
      const head = document.createElement('li');
      head.className = 'task-group';
      head.dataset.priority = key;
      const tag = document.createElement('button');
      tag.type = 'button';
      tag.className = 'prio-tag';
      tag.setAttribute('aria-expanded', String(!isFolded));
      tag.innerHTML = '<span class="prio-chip"><span class="prio-mark" aria-hidden="true"></span><span class="prio-name"></span><span class="prio-caret" aria-hidden="true">▾</span></span>';
      tag.querySelector('.prio-mark').textContent = mark;
      tag.querySelector('.prio-name').textContent = `${label}${items.length ? `（${items.length}）` : ''}`;
      if (!mark) tag.querySelector('.prio-mark').remove();
      tag.setAttribute('aria-label', `優先度 ${label}、${items.length}件。${isFolded ? '開く' : 'たたむ'}`);
      tag.addEventListener('click', () => {
        if (isFolded) folded.delete(key); else folded.add(key);
        if (!isFolded && formAt === key) closeForm(); // たたむ欄でフォームを開いていたら閉じる
        saveFolded();
        render();
      });
      head.append(tag);
      out.push(head);
      if (isFolded) continue;
      if (!items.length) { out.push(addSlot(id)); continue; } // 空の優先度は点線の欄
      // タスクがある優先度は、見出しの右（完了の四角の上）に小さな ＋。フォームは見出しのすぐ下に開く（2026-11-19 利用者の依頼）
      if (formAt !== key) head.append(addPlus(id));
      else { const li = document.createElement('li'); li.className = 'task-slot'; li.dataset.priority = key; li.append($('task-form')); out.push(li); }
      out.push(...items.map((t) => row(t, now)));
    }
    return out;
  }
  const slotLabel = (priority) => (priority ? `${SLOT_TEXT[priority]}（優先度 ${GROUPS.find((x) => x[0] === priority)[2]}）のタスクを追加` : '優先度なしのタスクを追加');
  function addPlus(priority) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'add-plus';
    btn.textContent = '＋';
    btn.setAttribute('aria-label', slotLabel(priority));
    btn.addEventListener('click', () => openForm(priority, groupKey(priority)));
    return btn;
  }
  // 点線の「追加」の欄。押すと、その優先度を選んだ追加のフォームがここに開く
  function addSlot(priority) {
    const li = document.createElement('li');
    li.className = 'task-slot';
    li.dataset.priority = groupKey(priority);
    if (formAt === groupKey(priority)) { li.append($('task-form')); return li; }
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'add-slot';
    btn.innerHTML = '<span></span><span class="add-slot-plus" aria-hidden="true">＋</span>';
    btn.firstChild.textContent = SLOT_TEXT[groupKey(priority)];
    btn.setAttribute('aria-label', slotLabel(priority));
    btn.addEventListener('click', () => openForm(priority, groupKey(priority)));
    li.append(btn);
    return li;
  }
  const say = makeSay($('tasks-say-line'));
  function render(now = new Date()) {
    const tidied = tidy(load(), now);
    if (tidied.changed) Store.write(KEY, tidied.list); // 整理の保存は、失敗しても次に開いたときにやり直せる
    const list = tidied.list;
    const open = sortOpen(list);
    const done = sortDone(list);
    if (formAt) $('task-add').append($('task-form')); // 描き直す前に外へ（消えないように）
    $('task-list').replaceChildren(...withGroups(open, now));
    $('done-list').replaceChildren(...done.map((t) => row(t, now)));
    $('done-count').textContent = String(list.filter((t) => t.done).length);
    $('done-section').hidden = done.length === 0;
    say(sayKey(open, now));
  }

  const toast = makeToast($('task-toast')); // 取り消し（5秒）と、保存の失敗の知らせ

  // ---------- 操作 ----------
  function update(id, fn, { later = false } = {}) {
    const list = load();
    const t = list.find((x) => x.id === id);
    if (!t) return null;
    const before = { ...t };
    fn(t);
    t.updatedAt = Date.now(); // 同期のときに「どちらが新しいか」を決めるため（D-043）
    if (!save(list)) return null;
    if (!later) render();
    return before;
  }
  // 完了にしたときだけの小さな反応（Q-B, C10-04, CR-M02）：押した行のチェックの印が入るのを見せてから、完了の一覧へ移す。
  // 開き直したとき・未完了に戻すときは動かさない。動きを減らす設定では待たずに移す
  const CHECK_HOLD_MS = 320; // 印が入る 180ms（--dur-quick）＋見える間
  let moveTimer = null;
  function showCheck(id) {
    const li = [...document.querySelectorAll('#task-list .task-item')].find((el) => el.dataset.id === id);
    if (!li || window.matchMedia('(prefers-reduced-motion: reduce)').matches) { render(); return; }
    li.classList.add('done');
    li.querySelector('.task-row').classList.add('done');
    li.querySelector('.task-done-btn').setAttribute('aria-pressed', 'true');
    const box = li.querySelector('.task-done-btn .task-check');
    box.textContent = '✓';
    box.classList.add('check-enter');
    clearTimeout(moveTimer);
    moveTimer = setTimeout(render, CHECK_HOLD_MS);
  }
  // 未完了に戻す。日報に入れていたら、その行を日報から外す（D-059）
  // subs を渡したら、ミニタスクも完了にする前の状態に戻す（完了の取り消し。D-070）
  function reopen(id, subs = null) {
    const before = update(id, (t) => { t.done = false; t.doneAt = null; if (subs) t.subtasks = subs; });
    if (before && before.toReport && before.done && before.doneAt) Report.removeDone(before.title, new Date(before.doneAt));
    return before;
  }
  function toggle(id) {
    const current = load().find((x) => x.id === id) || {};
    if (current.done) { // 完了→未完了に戻すのは、それ自体が取り消しなのでトーストは出さない
      reopen(id);
      toast.hide();
      return;
    }
    const at = Date.now();
    const subsBefore = (current.subtasks || []).map((x) => ({ ...x }));
    // 親を完了にしたら、残りのミニタスクも済んだ扱い（D-070）
    const before = update(id, (t) => { t.done = true; t.doneAt = at; t.subtasks = t.subtasks.map((x) => (x.done ? x : { ...x, done: true, doneAt: at })); }, { later: true });
    if (!before) return;
    showCheck(id);
    say.react('task_done.default'); // 区切りのよい操作への短い反応（D-059）
    if (before.toReport) Report.addDone(before.title, new Date(at)); // 日報の「できたこと」に足す（D-059）
    toast.show(`「${before.title}」を完了にしました${before.toReport ? '（日報に入れました）' : ''}`, () => reopen(id, subsBefore));
  }
  async function remove(id) {
    const target = load().find((x) => x.id === id);
    if (!target || !(await confirmDialog(`「${target.title}」を削除しますか？`))) return;
    const list = load();
    const index = list.findIndex((x) => x.id === id);
    if (index < 0) return;
    const [removed] = list.splice(index, 1);
    if (!save(list)) return;
    render();
    toast.show(`「${removed.title}」を削除しました`, () => {
      const now = load();
      now.splice(Math.min(index, now.length), 0, removed);
      save(now);
      render();
    });
  }
  // ミニタスクを済み／未完了に（キィニチは何も言わない。チェックの動きだけ。D-070）
  function toggleSub(id, subId) {
    let nowDone = false;
    const before = update(id, (t) => {
      const sub = t.subtasks.find((x) => x.id === subId);
      if (!sub) return;
      sub.done = !sub.done;
      sub.doneAt = sub.done ? Date.now() : null;
      nowDone = sub.done;
    });
    if (!before || !nowDone || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const box = document.querySelector(`#task-list .task-item[data-id="${id}"] .sub-row[data-sub="${subId}"] .task-check`);
    if (box) box.classList.add('check-enter');
  }
  function addSub(id, title) {
    let added = false;
    update(id, (t) => {
      if (t.subtasks.length >= SUB_MAX) return;
      t.subtasks.push({ id: newId(), title, done: false, doneAt: null });
      added = true;
    });
    return added;
  }
  function add(title, due, toReport = false, priority = null) {
    const list = load();
    const at = Date.now();
    list.push({ id: newId(), title, due: due || null, priority: PRIORITIES.includes(priority) ? priority : null, subtasks: [], done: false, doneAt: null, createdAt: at, updatedAt: at, toReport });
    if (!Store.write(KEY, list)) return false;
    render();
    return true;
  }

  // ---------- 追加フォーム ----------
  let chosenDue = null; // 'YYYY-MM-DD' または null
  let chosenPriority = null; // 'high' | 'mid' | 'low' | null
  let formAt = null; // フォームを開いている優先度の欄（'high'・'mid'・'low'・'none'）
  function setPriorityChip(scope, p) {
    for (const c of document.querySelectorAll(`${scope} .prio-chips .chip`)) c.setAttribute('aria-pressed', String((c.dataset.priority || null) === (p || null)));
  }
  let toReport = false; // 完了したら日報に入れる（D-059）。作るたびにオフから
  function setToReport(on) {
    toReport = on;
    $('task-report').setAttribute('aria-checked', String(on));
    $('task-report').textContent = on ? 'オン' : 'オフ';
  }
  $('task-report').addEventListener('click', () => setToReport(!toReport));
  function setChip(kind) {
    for (const c of document.querySelectorAll('#task-form .due-chips .chip')) c.setAttribute('aria-pressed', String(c.dataset.due === kind));
  }
  function openForm(priority, at) {
    formAt = at;
    chosenPriority = priority;
    $('task-form').hidden = false;
    render(); // その優先度の欄にフォームを置く
    $('task-title').value = '';
    $('task-due').value = '';
    $('task-form-status').textContent = '';
    chosenDue = null;
    setChip('none');
    setPriorityChip('#task-form', priority);
    setToReport(false);
    $('task-title').focus();
    $('task-form').scrollIntoView({ block: 'nearest' }); // 見えていれば動かさない
  }
  function closeForm() {
    $('task-form').hidden = true;
    const was = formAt;
    formAt = null;
    $('task-add').append($('task-form'));
    if (was) render();
  }
  for (const chip of document.querySelectorAll('#task-form .prio-chips .chip')) {
    chip.addEventListener('click', () => { chosenPriority = chip.dataset.priority || null; setPriorityChip('#task-form', chosenPriority); });
  }
  $('task-cancel').addEventListener('click', closeForm);
  for (const chip of document.querySelectorAll('#task-form .due-chips .chip')) {
    chip.addEventListener('click', () => {
      const now = new Date();
      chosenDue = chip.dataset.due === 'today' ? todayKey(now) : chip.dataset.due === 'tomorrow' ? dateStr(addDays(logicalDay(now), 1)) : null;
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
    if (!add(title.slice(0, 100), chosenDue, toReport, chosenPriority)) { // 入力を残したまま知らせる
      $('task-form-status').textContent = SAVE_FAILED;
      return;
    }
    closeForm();
  });

  // ---------- 操作の一覧（行のチェック以外を押したとき。D-070） ----------
  let actionId = null;
  function openActions(id) {
    const t = load().find((x) => x.id === id);
    if (!t) return;
    actionId = id;
    $('task-actions-title').textContent = t.title;
    $('task-act-start').hidden = t.done; // 完了したタスクは始めない
    $('task-act-start-min').textContent = `作業のタイマー ${Timer.workMinutes()}分`;
    $('task-actions').showModal();
  }
  $('task-actions-close').addEventListener('click', () => $('task-actions').close());
  $('task-actions').addEventListener('click', (e) => { if (e.target === e.currentTarget) $('task-actions').close(); });
  $('task-act-edit').addEventListener('click', () => { $('task-actions').close(); openEdit(actionId); });
  // タスクを開始（D-071）：タスクの名前で作業のタイマーを始め、タイマーの画面へ。動いているタイマーがあれば確かめてから置き換える
  $('task-act-start').addEventListener('click', async () => {
    $('task-actions').close();
    const t = load().find((x) => x.id === actionId);
    if (!t) return;
    const running = Timer.runningName();
    if (running && !(await confirmDialog(`動いているタイマー「${running}」を止めて、「${t.title}」を始めますか？`, '始める', false))) return;
    if (Timer.startFor(t.title)) location.hash = '#timer';
  });
  $('task-act-delete').addEventListener('click', () => { $('task-actions').close(); remove(actionId); });

  // ---------- 編集（名前・期限・優先度・完了したら日報へ・ミニタスク） ----------
  let editId = null;
  let editDue = null;
  let editPriority = null;
  let editReport = false;
  let editSubs = []; // { id, title, done, doneAt }
  const editChips = () => document.querySelectorAll('#task-edit .due-chips .chip');
  function setEditDueChip(kind) { for (const c of editChips()) c.setAttribute('aria-pressed', String(c.dataset.due === kind)); }
  function dueKind(due, now = new Date()) {
    if (!due) return 'none';
    if (due === todayKey(now)) return 'today';
    return due === dateStr(addDays(logicalDay(now), 1)) ? 'tomorrow' : '';
  }
  function setEditReport(on) {
    editReport = on;
    $('edit-report').setAttribute('aria-checked', String(on));
    $('edit-report').textContent = on ? 'オン' : 'オフ';
  }
  function renderEditSubs() {
    const ul = $('edit-subs');
    ul.replaceChildren(...editSubs.map((sub, i) => {
      const li = document.createElement('li');
      li.className = 'edit-sub';
      const input = document.createElement('input');
      input.type = 'text';
      input.maxLength = 100;
      input.value = sub.title;
      input.setAttribute('aria-label', `ミニタスク ${i + 1} の名前`);
      input.addEventListener('input', () => { sub.title = input.value; });
      li.append(input, trashButton(`ミニタスク「${sub.title}」を消す`, () => { editSubs.splice(i, 1); renderEditSubs(); }));
      return li;
    }));
    $('edit-sub-add').hidden = editSubs.length >= SUB_MAX;
    $('edit-sub-count').textContent = `${editSubs.length}/${SUB_MAX}`;
  }
  function openEdit(id) {
    const t = load().find((x) => x.id === id);
    if (!t) return;
    editId = id;
    editDue = t.due || null;
    editPriority = t.priority;
    editSubs = t.subtasks.map((x) => ({ ...x }));
    $('edit-title').value = t.title;
    $('edit-due').value = editDue || '';
    setEditDueChip(dueKind(editDue));
    setPriorityChip('#task-edit', editPriority);
    setEditReport(!!t.toReport);
    $('task-edit-status').textContent = '';
    renderEditSubs();
    $('task-edit').showModal();
  }
  for (const chip of editChips()) {
    chip.addEventListener('click', () => {
      const now = new Date();
      editDue = chip.dataset.due === 'today' ? todayKey(now) : chip.dataset.due === 'tomorrow' ? dateStr(addDays(logicalDay(now), 1)) : null;
      $('edit-due').value = editDue || '';
      setEditDueChip(chip.dataset.due);
    });
  }
  $('edit-due').addEventListener('change', () => { editDue = $('edit-due').value || null; setEditDueChip(dueKind(editDue)); });
  for (const chip of document.querySelectorAll('#task-edit .prio-chips .chip')) {
    chip.addEventListener('click', () => { editPriority = chip.dataset.priority || null; setPriorityChip('#task-edit', editPriority); });
  }
  $('edit-report').addEventListener('click', () => setEditReport(!editReport));
  $('edit-sub-add').addEventListener('click', () => {
    if (editSubs.length >= SUB_MAX) return;
    editSubs.push({ id: newId(), title: '', done: false, doneAt: null });
    renderEditSubs();
    const inputs = $('edit-subs').querySelectorAll('input');
    inputs[inputs.length - 1].focus();
  });
  $('task-edit-cancel').addEventListener('click', () => $('task-edit').close());
  $('task-edit-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const title = $('edit-title').value.trim();
    if (!title) { $('task-edit-status').textContent = 'やることを入力してください'; return; }
    const subs = editSubs.map((x) => ({ ...x, title: x.title.trim().slice(0, 100) })).filter((x) => x.title).slice(0, SUB_MAX);
    const ok = update(editId, (t) => {
      t.title = title.slice(0, 100);
      t.due = editDue;
      t.priority = editPriority;
      t.toReport = editReport;
      t.subtasks = subs;
    });
    if (!ok) { $('task-edit-status').textContent = SAVE_FAILED; return; }
    $('task-edit').close();
  });

  // 画面を開いたとき・日付が変わりうるときに描き直す（期限の表示が日付に依存するため）
  onShow('tasks', render);
  render();

  // 今日まで（期限切れを含む）の未完了のタスクの数と、それを明日に回す（仕事終わりの提案。D-059）
  function dueLeft(now = new Date()) {
    const today = todayKey(now);
    return load().filter((t) => !t.done && t.due && t.due <= today).length;
  }
  function postponeToTomorrow(now = new Date()) {
    const today = todayKey(now);
    const tomorrow = dateStr(addDays(logicalDay(now), 1));
    const list = load();
    let n = 0;
    for (const t of list) {
      if (!t.done && t.due && t.due <= today) { t.due = tomorrow; t.updatedAt = Date.now(); n++; }
    }
    if (n && !save(list)) return -1;
    render(now);
    return n;
  }
  return { load, dueInfo, sortOpen, tidy, render, dueLeft, postponeToTomorrow };
})();
