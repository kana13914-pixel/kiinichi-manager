// 輪に置いた時間（D-112）：「1日」の輪の空いている所に置いた、タスクをやる時間・自由時間・そのほか。
// Google カレンダーには入れず、この端末に置く（db.blocks。スプレッドシートには控えを送る）。通知はしない。
// 形：[ { id, date: 'YYYY-MM-DD'（暦日）, start: 'HH:MM', end: 'HH:MM'（start より後。同じ日の中）, kind: 'task'|'free'|'other',
//        title, taskId（タスクのとき）, color（そのほかのとき。RING_COLORS のキー）, createdAt, updatedAt } ]
// util.js・routine.js の後、schedule.js・summary.js・sync.js・settings の前に読み込む。

const BLOCK_KINDS = { task: 'タスク', free: '自由時間', other: 'そのほか' };
const Blocks = {
  KEEP_DAYS: 60, // これより前の日のものは消す
  load() {
    const list = Store.read(DB.blocks, []);
    return Array.isArray(list) ? list.filter((b) => b && b.id && /^\d{4}-\d{2}-\d{2}$/.test(b.date) && ROUTINE_TIME.test(b.start)
      && ROUTINE_TIME.test(b.end) && b.end > b.start && BLOCK_KINDS[b.kind]) : [];
  },
  on(date) { const key = dateStr(date); return this.load().filter((b) => b.date === key).sort((a, b) => a.start.localeCompare(b.start)); },
  // 足す・直す。保存できたらその1件、できなければ null
  put(b) {
    const list = this.load();
    const now = Date.now();
    const i = list.findIndex((x) => x.id === b.id);
    const item = { ...(i >= 0 ? list[i] : { id: newId(), createdAt: now }), ...b, updatedAt: now };
    if (i >= 0) list[i] = item; else list.push(item);
    return Store.write(DB.blocks, list) ? item : null;
  },
  remove(id) { return Store.write(DB.blocks, this.load().filter((b) => b.id !== id)); },
  prune(now = new Date()) {
    const limit = dateStr(addDays(logicalDay(now), -this.KEEP_DAYS));
    const list = this.load();
    const kept = list.filter((b) => b.date >= limit);
    if (kept.length !== list.length) Store.write(DB.blocks, kept);
  },
  // その日の時点（ミリ秒）の範囲
  range(b) {
    const d = parseDay(b.date);
    const at = (hhmm) => { const [h, m] = hhmm.split(':').map(Number); const x = new Date(d); x.setHours(h, m, 0, 0); return x.getTime(); };
    return { start: at(b.start), end: at(b.end) };
  },
};
Blocks.prune();

// ---------- 輪の色（D-111） ----------
// 選べる色は8つだけ（このアプリの地に合い、白い文字が読める濃さ。自由な色は作らない）。キーは style.css の --ring-c1〜c8
const RING_COLORS = {
  c1: '深い青緑', c2: '青緑', c3: '明るい青緑', c4: '淡い青緑', c5: '金', c6: '淡い金', c7: '琥珀', c8: '空色',
};
// 項目と、はじめの色：毎日のルーティンは青緑の濃淡、自分で入れたものは金の系統
const RING_ITEMS = [
  ['sleep', '睡眠', 'c1'], ['work', '仕事', 'c2'], ['meal', '食事', 'c3'], ['bath', '入浴', 'c4'],
  ['event', '予定', 'c5'], ['task', 'タスク', 'c6'], ['free', '自由時間', 'c7'],
];
const RingColors = {
  of(kind) {
    const item = RING_ITEMS.find(([k]) => k === kind);
    const mine = Prefs.get('ringColors');
    const c = mine && typeof mine === 'object' ? mine[kind] : null;
    return RING_COLORS[c] ? c : item ? item[2] : 'c6';
  },
  set(kind, c) {
    const mine = { ...(Prefs.get('ringColors') || {}) };
    if (c === null) delete mine[kind]; else mine[kind] = c;
    return Prefs.set('ringColors', mine);
  },
};
