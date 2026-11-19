// 各画面が共通で使う画面部品（確認ダイアログ・取り消しの表示・ごみ箱・画面を開いたときの描き直し）。

// 変わったときだけ書き換える（P3-04）
function setIfChanged(el, text) { if (el.textContent !== text) el.textContent = text; }

// 削除の前の確認（I1-04, D-031）。「やめる」に最初のフォーカスを置く。枠の外を押す・Esc は「やめる」と同じ
// danger を false にすると「OK」を赤にしない（消す操作でない確認。例：タスクを開始で動いているタイマーを置き換える）
function confirmDialog(message, okLabel = '削除する', danger = true) {
  const dlg = document.getElementById('confirm');
  document.getElementById('confirm-text').textContent = message;
  document.getElementById('confirm-ok').textContent = okLabel;
  document.getElementById('confirm-ok').classList.toggle('danger', danger);
  return new Promise((resolve) => {
    dlg.returnValue = '';
    dlg.addEventListener('close', () => resolve(dlg.returnValue === 'ok'), { once: true });
    dlg.showModal();
    document.getElementById('confirm-cancel').focus();
  });
}
document.getElementById('confirm').addEventListener('click', (e) => { if (e.target === e.currentTarget) e.currentTarget.close(); });

// 5秒で消える知らせ。undo を渡すと「取り消す」が付く（I3-02）。渡さなければ文だけ（保存の失敗など）
function makeToast(el) {
  let timer = null;
  let undoAction = null;
  function hide() {
    el.hidden = true;
    undoAction = null;
    clearTimeout(timer);
  }
  function show(message, undo = null) {
    undoAction = undo; // 前の知らせの操作はそのまま確定する
    const msg = document.createElement('span');
    msg.textContent = message;
    const parts = [msg];
    if (undo) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'undo';
      btn.textContent = '取り消す';
      btn.addEventListener('click', () => {
        const fn = undoAction;
        hide();
        if (fn) fn();
      });
      parts.push(btn);
    }
    el.replaceChildren(...parts);
    el.hidden = false;
    clearTimeout(timer);
    timer = setTimeout(hide, 5000);
  }
  return { show, hide };
}

// 画面の一言（1 画面に 1 つ。C10-02）。状況（セリフ集のキー）が変わったときだけ選び直す。開くたびには変えない（D-031 ②）
// say.react(key, vars) … 区切りのよい操作のあとの短い反応（D-059）。状況が変わるまで、反応のセリフを残す
function makeSay(lineEl) {
  let shown = null;
  let reacting = false;
  const say = (key) => {
    if (key === shown) return; // 同じ状況なら選び直さない（反応を出していれば、それを残す）
    shown = key;
    reacting = false;
    dialogueReady.then(() => {
      if (shown !== key || reacting) return;
      const picked = pickLine(key);
      lineEl.textContent = picked ? picked.text : '…';
    });
  };
  say.react = (key, vars = {}) => {
    reacting = true;
    dialogueReady.then(() => {
      const picked = pickLine(key); // 候補が2つ以上なら、続けて同じ言い回しにしない（C1-02）
      if (picked) lineEl.textContent = fillLine(picked.text, vars);
    });
  };
  return say;
}

// ごみ箱のボタン（タスク、利用者が作ったタイマー）
function trashButton(label, onClick) {
  const del = document.createElement('button');
  del.type = 'button';
  del.className = 'task-del';
  del.setAttribute('aria-label', label);
  del.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 7h14M10 7V5h4v2M7 7l1 13h8l1-13"/></svg>';
  del.addEventListener('click', onClick);
  return del;
}

// その画面のタブを開いたときと、裏から戻ったときに描き直す
function onShow(view, render) {
  window.addEventListener('hashchange', () => { if (location.hash === '#' + view) render(); });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') render(); });
}
