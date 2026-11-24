// スプレッドシートへの控え（D-050）。端末のデータ（記録・日報・タスク・毎日の時刻・タイマー）を、GAS のウェブアプリ（gas/Code.gs）に送る。
// 端末が正本で、送るだけ（受け取らない）。変わったら 5 秒待ってまとめて送り、送り直しは 1 分に 1 回まで。中身が同じなら送らない。
// 通信できなかったら、次に変わったとき・開いたとき・裏から戻ったときにやり直す。
// 送り先の URL と合言葉は、利用者が設定で入れて端末にだけ保存する（D-014 と同じ考え）。util.js・routine.js・app.js の後に読み込む。

const Sync = (() => {
  const WAIT_MS = 5000;
  const MIN_GAP_MS = 60 * 1000;
  const $ = (id) => document.getElementById(id);
  const MOODS = { good: '元気', normal: 'ふつう', tired: '疲れた' };
  const PRIORITY_LABELS = { high: '高', mid: '中', low: '低' }; // タスクの優先度（D-070）。ないものは「なし」

  function conf() { const c = Store.read(DB.sync, {}); return c && typeof c === 'object' ? c : {}; }
  function setConf(change) { const c = { ...conf(), ...change }; Store.write(DB.sync, c); return c; }
  function stamp(ms) { if (!ms) return ''; const d = new Date(ms); return `${dateStr(d)} ${hm(d)}`; }

  // 送る中身（合言葉と送った時刻を除く）
  function payload() {
    const records = {};
    for (const [date, day] of Object.entries(Records.all())) {
      const rows = [];
      for (const k of RECORD_KINDS) {
        const v = day[k.id];
        const done = (r) => (r.manual ? '記録（手入力）' : '記録'); // 時刻を手で入れたもの（D-079）
        if (Array.isArray(v)) v.forEach((r, i) => rows.push({ kind: k.id, label: k.label, time: r.time, n: i + 1, state: done(r), at: stamp(r.at) }));
        else if (v && v.skipped) rows.push({ kind: k.id, label: k.label, time: '', n: '', state: '今日はなし', at: stamp(v.at) });
        else if (v && v.time) rows.push({ kind: k.id, label: k.label, time: v.time, n: 1, state: done(v), at: stamp(v.at) });
      }
      records[date] = rows;
    }
    const reportsAll = Store.read(DB.reports, {}) || {};
    const reports = Object.keys(reportsAll).sort().map((date) => {
      const r = reportsAll[date] || {};
      return { date, mood: MOODS[r.mood] || '', done: r.done || '', left: r.left || '', tomorrow: r.tomorrow || '', savedAt: stamp(r.savedAt) };
    });
    const taskList = (Store.read(DB.tasks, []) || []).filter((t) => t && t.id);
    const tasks = taskList.map((t) => ({
      id: t.id, title: t.title, due: t.due || '', state: t.done ? '完了' : '未完了',
      doneAt: stamp(t.doneAt), createdAt: stamp(t.createdAt), updatedAt: stamp(t.updatedAt),
      priority: PRIORITY_LABELS[t.priority] || 'なし', // D-070
    }));
    // ミニタスクは別のシート（D-070）。親の id と名前を添える
    const subtasks = taskList.flatMap((t) => (Array.isArray(t.subtasks) ? t.subtasks : []).filter((x) => x && x.id).map((x) => ({
      parentId: t.id, parentTitle: t.title, id: x.id, title: x.title, state: x.done ? '済み' : '未完了', doneAt: stamp(x.doneAt),
    })));
    const r = Routine.load();
    const row = (name, times) => [name, ...ROUTINE_ITEMS.map(([id]) => times[id] || 'なし')];
    const routine = [row('平日', r.weekday), row('休日', r.holiday), ['休日の曜日', r.holidays.map((n) => WEEK_LABELS[n]).join('・')], ['祝日', r.publicHolidays ? '休日' : '平日のまま']];
    // その日だけ変えた時刻（今日以降。D-060 ⑭）。変えていない項目は空
    const today = todayKey();
    for (const [date, o] of Object.entries(Routine.overrides()).filter(([d]) => d >= today).sort()) {
      routine.push([`${date} だけ`, ...ROUTINE_ITEMS.map(([id]) => (id in o ? o[id] || 'なし' : ''))]);
    }
    const timer = Timer.load();
    const timers = [
      ...Timer.builtins(timer).map((t) => [t.name, t.minutes, t.minutes === t.base ? '用途別' : `用途別（初めは${t.base}分）`]),
      ...timer.custom.map((t) => [t.name, t.minutes, '自分で作った']),
    ];
    return { app: APP_VERSION, records, reports, tasks, subtasks, routine, timers };
  }

  function show() {
    const c = conf();
    if (!$('sync-status')) return;
    let text = '未設定';
    let cls = 'status';
    if (c.url && c.token) {
      if (c.error) { text = `送れませんでした（${c.error}）。次に変わったときにやり直します`; cls = 'status ng'; }
      else if (c.lastAt) { text = `${stamp(c.lastAt)} に送りました`; cls = 'status ok'; }
      else text = 'まだ送っていません';
    }
    $('sync-status').textContent = text;
    $('sync-status').className = cls;
    // 失敗は設定のいちばん上にも出す（CR-F11。仕様関連を開かないと気づけないため）
    const alert = $('sync-alert');
    if (alert) {
      alert.hidden = !(c.url && c.token && c.error);
      alert.textContent = alert.hidden ? '' : `スプレッドシートへの控えが送れていません（${c.error}）。「仕様関連」で確かめられます`;
    }
  }

  let sending = null;
  let waitTimer = null;
  // 送る。force は「今すぐ送る」（中身が同じでも、間隔が短くても送る）
  async function send(force = false) {
    if (sending) return sending;
    const c = conf();
    if (!c.url || !c.token || !/^https:\/\//.test(c.url)) return false;
    if (!force && c.lastAt && Date.now() - c.lastAt < MIN_GAP_MS) { later(MIN_GAP_MS - (Date.now() - c.lastAt)); return false; }
    const body = payload();
    const sig = JSON.stringify(body);
    if (!force && !c.dirty && c.lastSig === sig) return true;
    sending = (async () => {
      try {
        // Content-Type を付けない（text/plain の単純な送信）ことで、GAS が答えられない事前確認を避ける
        const res = await fetch(c.url, { method: 'POST', body: JSON.stringify({ ...body, token: c.token, sentAt: stamp(Date.now()) }) });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || data.error || !data.ok) throw new Error(data.error || 'HTTP ' + res.status);
        setConf({ lastAt: Date.now(), lastSig: sig, dirty: false, error: '' });
        return true;
      } catch (e) {
        setConf({ dirty: true, error: e.message === 'Failed to fetch' ? '通信できません' : e.message });
        return false;
      } finally {
        sending = null;
        show();
      }
    })();
    return sending;
  }
  function later(ms = WAIT_MS) {
    clearTimeout(waitTimer);
    waitTimer = setTimeout(() => send(), ms);
  }

  // 端末のデータが変わったら（util.js の Store.write が知らせる）、少し待って送る
  window.addEventListener('datachange', () => { if (!conf().dirty) setConf({ dirty: true }); later(); });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && conf().dirty) later(); });

  // ---------- 設定 ----------
  if ($('sync-url')) {
    $('sync-url').value = conf().url || '';
    $('sync-token').value = conf().token || '';
    $('sync-url').addEventListener('change', () => { setConf({ url: $('sync-url').value.trim(), dirty: true, error: '' }); show(); });
    $('sync-token').addEventListener('change', () => { setConf({ token: $('sync-token').value.trim(), dirty: true, error: '' }); show(); });
    $('sync-now').addEventListener('click', async () => {
      const c = conf();
      if (!c.url || !c.token) { $('sync-status').textContent = '送り先の URL と合言葉を入れてください'; $('sync-status').className = 'status ng'; return; }
      if (!/^https:\/\//.test(c.url)) { $('sync-status').textContent = 'URL は https:// で始まるものを入れてください'; $('sync-status').className = 'status ng'; return; }
      $('sync-status').textContent = '送っています…';
      $('sync-status').className = 'status';
      await send(true);
    });
    show();
  }
  if (conf().dirty) later();
  return { payload, send, conf };
})();
