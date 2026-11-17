// Google カレンダーの予定（D-053, D-054）。スプレッドシートへの控えと同じ GAS のウェブアプリ（gas/Code.gs）から予定を読み、
// 予定画面から足す・直す・消す（足すのは既定のカレンダー。繰り返しの予定と招待された予定は直せない）。
// 送り先の URL と合言葉は「スプレッドシートへの控え」の設定（db.sync）を使う。取った予定は端末に控え（db.calendar）、
// 開いたとき・表示に戻ったとき・予定画面を開いたときに、5分以上たっていれば取り直す（spec：反映の遅れは5分以内）。
// 一度も取れていないあいだは、予定画面とホームは仮の予定（sample-data.js）を出す。util.js の後、sample-data.js の前に読み込む。

const Calendar = (() => {
  const REFRESH_MS = 5 * 60 * 1000;
  // 取る範囲：先月の1日から、再来月の終わりまで（月表示で前後に動かしても見えるように）
  function range(now = new Date()) {
    const from = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const to = new Date(now.getFullYear(), now.getMonth() + 3, 1);
    return { from: from.getTime(), to: to.getTime() };
  }
  function cache() { const c = Store.read(DB.calendar); return c && Array.isArray(c.events) ? c : null; }
  function conf() { const c = Store.read(DB.sync, {}); return c && typeof c === 'object' ? c : {}; }
  // カレンダーの予定を出せるか（一度でも取れたか）
  function ready() { return Boolean(cache()); }

  // その暦日の予定（予定画面の kind 'event' の形）。終日は日をまたぐものも日ごとに出す（終わりの日は含まない）
  function eventsOn(date) {
    const c = cache();
    if (!c) return [];
    const start = startOfDay(date).getTime();
    const end = addDays(startOfDay(date), 1).getTime();
    const out = [];
    for (const ev of c.events) {
      if (ev.allDay) {
        if (ev.start < end && ev.end > start) out.push({ at: new Date(start), title: ev.title, kind: 'event', allDay: true, ref: ev });
      } else if (ev.start >= start && ev.start < end) {
        out.push({ at: new Date(ev.start), title: ev.title, kind: 'event', allDay: false, ref: ev });
      }
    }
    return out;
  }

  let fetching = null;
  let triedAt = 0; // 最後に取ろうとした時点（この画面を開いている間だけ覚える）
  // 取り直す。force は時間をおかずに取る
  function refresh(force = false) {
    if (fetching) return fetching;
    const s = conf();
    if (!s.url || !s.token || !/^https:\/\//.test(s.url)) return Promise.resolve(false);
    const c = cache();
    // 前に取った（または取ろうとして失敗した）ときから5分たっていなければ取らない。失敗したあと毎分取り直し続けないように
    const last = Math.max(c ? c.fetchedAt : 0, triedAt);
    if (!force && Date.now() - last < REFRESH_MS) return Promise.resolve(Boolean(c));
    triedAt = Date.now();
    const r = range();
    fetching = (async () => {
      try {
        // Content-Type を付けない（text/plain の単純な送信）。GAS が答えられない事前確認を避ける
        const res = await fetch(s.url, { method: 'POST', body: JSON.stringify({ action: 'events', token: s.token, from: r.from, to: r.to }) });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || data.error || !Array.isArray(data.events)) throw new Error(data.error || 'HTTP ' + res.status);
        const events = data.events.filter((e) => e && typeof e.title === 'string' && Number.isFinite(e.start) && Number.isFinite(e.end))
          .map((e) => ({ id: e.id || '', calendarId: e.calendarId || '', title: e.title || '（名前なし）', start: e.start, end: e.end,
            allDay: e.allDay === true, editable: e.editable === true && Boolean(e.id) }));
        Store.write(DB.calendar, { fetchedAt: Date.now(), from: r.from, to: r.to, events, error: '' });
        window.dispatchEvent(new Event('calendarchange'));
        return true;
      } catch (e) {
        const old = cache();
        if (old) Store.write(DB.calendar, { ...old, error: e.message === 'Failed to fetch' ? '通信できません' : e.message });
        else Store.write(DB.calendarError, e.message === 'Failed to fetch' ? '通信できません' : e.message);
        window.dispatchEvent(new Event('calendarstatus'));
        return false;
      } finally {
        fetching = null;
      }
    })();
    return fetching;
  }
  // 予定を足す・直す・消す（D-054）。action は 'add' / 'update' / 'remove'。できたら読み直す。できなければ理由の文で例外
  async function change(action, data) {
    const s = conf();
    if (!s.url || !s.token) throw new Error('スプレッドシートへの控えの送り先が未設定です（設定 → 仕様関連）');
    let res;
    try {
      res = await fetch(s.url, { method: 'POST', body: JSON.stringify({ action, token: s.token, ...data }) });
    } catch (_) {
      throw new Error('通信できません。つながってから、もう一度押してください');
    }
    const out = await res.json().catch(() => ({}));
    if (!res.ok || out.error || !out.ok) throw new Error(out.error || 'HTTP ' + res.status);
    await refresh(true);
    return out;
  }

  // 設定の「仕様関連」に出す状態
  function statusText() {
    const s = conf();
    if (!s.url || !s.token) return 'カレンダー：未設定（送り先の URL と合言葉を入れると読みます）';
    const c = cache();
    if (c && c.error) return `カレンダー：取れませんでした（${c.error}）。${hm(new Date(c.fetchedAt))} に取った分を出しています`;
    if (c) return `カレンダー：${dateStr(new Date(c.fetchedAt))} ${hm(new Date(c.fetchedAt))} に取りました（${c.events.length}件）`;
    const err = Store.read(DB.calendarError);
    return err ? `カレンダー：取れませんでした（${err}）` : 'カレンダー：まだ取っていません';
  }

  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') refresh(); });
  window.addEventListener('hashchange', () => { if (location.hash === '#schedule' || location.hash === '#home' || location.hash === '') refresh(); });
  setInterval(() => { if (document.visibilityState === 'visible') refresh(); }, 60 * 1000);
  setTimeout(() => refresh(), 0);
  // 今日（朝4時区切り）のこのあとの、時刻のある予定（予定の前の声掛け用）
  function timedBetween(from, to) {
    const c = cache();
    return c ? c.events.filter((e) => !e.allDay && e.start >= from && e.start < to) : [];
  }
  return { ready, eventsOn, refresh, statusText, range, change, timedBetween };
})();
