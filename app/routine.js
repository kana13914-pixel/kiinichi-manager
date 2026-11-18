// 毎日の時刻（D-048）。起床・食事・仕事・入浴・就寝の予定時刻を、平日と休日の2つ持つ。
// ホームの記録ボタンの時間帯（app.js）、予定の一覧の生活の時刻（sample-data.js）、起床の早い／遅い、声掛けの時刻の基準になる。
// 保存は db.routine（同期の対象）。その日だけの変更は db.routineOverrides（D-060 ⑭）で、平日・休日の時刻より先に見る。
// 設定の画面は予定の画面に移した（「毎日の時刻」のボタンで開く。D-060 ⑭）。util.js の後、sample-data.js・app.js の前に読み込む。

const ROUTINE_ITEMS = [
  ['wake', '起床'], ['breakfast', '朝食'], ['work_start', '仕事開始'], ['lunch', '昼食'],
  ['work_end', '仕事終わり'], ['dinner', '夕食'], ['bath', '入浴'], ['sleep', '就寝'],
];
const ROUTINE_TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const WEEK_LABELS = ['日', '月', '火', '水', '木', '金', '土'];

// 'HH:MM' → 朝4時を区切りにした分（深夜1時 → 25 * 60）。なしは null
function routineMinutes(hhmm) {
  if (!hhmm) return null;
  const [h, m] = hhmm.split(':').map(Number);
  return (h < DAY_STARTS_AT ? h + 24 : h) * 60 + m;
}
// 朝4時を区切りにした、今の分
function logicalMinutes(now = new Date()) {
  const h = now.getHours();
  return (h < DAY_STARTS_AT ? h + 24 : h) * 60 + now.getMinutes();
}

const Routine = {
  // 既定値：平日は今までの仮データの時刻。休日は同じ時刻で仕事なし。休日は土日
  defaults() {
    const weekday = { wake: '07:00', breakfast: '07:30', work_start: '09:00', lunch: '12:00', work_end: '18:30', dinner: '19:30', bath: '22:30', sleep: '23:30' };
    return { weekday, holiday: { ...weekday, work_start: null, work_end: null }, holidays: [0, 6] };
  },
  load() {
    const d = this.defaults();
    const r = Store.read(DB.routine);
    if (!r || typeof r !== 'object') return d;
    const pattern = (p, base) => {
      const out = {};
      for (const [id] of ROUTINE_ITEMS) {
        if (p && Object.prototype.hasOwnProperty.call(p, id)) out[id] = p[id] === null || ROUTINE_TIME.test(p[id]) ? p[id] : base[id];
        else out[id] = base[id];
      }
      return out;
    };
    return {
      weekday: pattern(r.weekday, d.weekday),
      holiday: pattern(r.holiday, d.holiday),
      holidays: Array.isArray(r.holidays) ? [...new Set(r.holidays.filter((n) => Number.isInteger(n) && n >= 0 && n <= 6))].sort() : d.holidays,
    };
  },
  save(r) { return Store.write(DB.routine, { ...r, updatedAt: Date.now() }); },
  // その日（0時の Date。1日の区切りは朝4時なので logicalDay() の値を渡す）が平日か休日か
  typeOf(day) { return this.load().holidays.includes(day.getDay()) ? 'holiday' : 'weekday'; },
  // その日だけの変更 { 'YYYY-MM-DD': { wake: '08:30', breakfast: null } }（D-060 ⑭）
  overrides() {
    const o = Store.read(DB.routineOverrides, {});
    return o && typeof o === 'object' && !Array.isArray(o) ? o : {};
  },
  overrideOf(day, id) {
    const o = this.overrides()[dateStr(day)];
    return o && Object.prototype.hasOwnProperty.call(o, id) && (o[id] === null || ROUTINE_TIME.test(o[id])) ? { value: o[id] } : null;
  },
  // その日だけ変える（value は 'HH:MM' か null＝この日はなし）。value に undefined を渡すと元に戻す
  setOverride(day, id, value) {
    const all = this.overrides();
    const key = dateStr(day);
    const o = { ...(all[key] || {}) };
    if (value === undefined) delete o[id]; else o[id] = value;
    if (Object.keys(o).length) all[key] = o; else delete all[key];
    return Store.write(DB.routineOverrides, all);
  },
  // 60日より前の上書きを消す
  prune(now = new Date()) {
    const all = this.overrides();
    const limit = dateStr(addDays(logicalDay(now), -60));
    const keys = Object.keys(all).filter((k) => k < limit);
    if (keys.length) { keys.forEach((k) => delete all[k]); Store.write(DB.routineOverrides, all); }
  },
  // 平日・休日の時刻（その日だけの変更を入れない）
  baseTimesFor(day) { return this.load()[this.typeOf(day)]; },
  // その日の予定時刻 { wake: '07:00', work_start: null, … }。その日だけの変更を先に見る
  timesFor(day) {
    const base = this.baseTimesFor(day);
    const o = this.overrides()[dateStr(day)];
    if (!o) return base;
    const out = { ...base };
    for (const [id] of ROUTINE_ITEMS) if (this.overrideOf(day, id)) out[id] = o[id];
    return out;
  },
  // その日の生活の時刻を予定の形で（深夜0〜4時の時刻は次の暦日の時点にする）
  eventsFor(day) {
    const times = this.timesFor(day);
    return ROUTINE_ITEMS.filter(([id]) => times[id]).map(([id, title]) => {
      const [h, m] = times[id].split(':').map(Number);
      const at = new Date(day);
      if (h < DAY_STARTS_AT) at.setDate(at.getDate() + 1);
      at.setHours(h, m, 0, 0);
      return { at, title, kind: 'routine', id, allDay: false, day: dateStr(day), overridden: Boolean(this.overrideOf(day, id)) };
    });
  },
  // 「なし」にした項目も含めた、その日の生活の時刻の一覧（予定のリストで、この日だけ「なし」にしたものも直せるように）
  skippedFor(day) {
    const o = this.overrides()[dateStr(day)] || {};
    return ROUTINE_ITEMS.filter(([id]) => o[id] === null && this.baseTimesFor(day)[id]).map(([id, title]) => ({ id, title, day: dateStr(day) }));
  },
};
Routine.prune();

// ---------- 設定の「毎日の時刻」 ----------
(() => {
  const $ = (id) => document.getElementById(id);
  if (!$('routine-list')) return;
  let mode = 'weekday';
  function changed(message) {
    $('routine-status').textContent = message;
    window.dispatchEvent(new Event('routinechange')); // ホームの記録ボタン・予定・声掛け（notify.js）を決め直す
  }
  function update(fn) {
    const r = Routine.load();
    fn(r);
    if (!Routine.save(r)) { $('routine-status').textContent = SAVE_FAILED; return false; }
    changed(`保存しました（${hm(new Date())}）`);
    return true;
  }
  function render() {
    const r = Routine.load();
    const times = r[mode];
    $('routine-mode-weekday').setAttribute('aria-pressed', String(mode === 'weekday'));
    $('routine-mode-holiday').setAttribute('aria-pressed', String(mode === 'holiday'));
    $('routine-list').replaceChildren(...ROUTINE_ITEMS.map(([id, label]) => {
      const li = document.createElement('li');
      li.className = 'routine-row';
      const name = document.createElement('label');
      name.htmlFor = 'routine-' + id;
      name.textContent = label;
      const input = document.createElement('input');
      input.type = 'time';
      input.id = 'routine-' + id;
      input.value = times[id] || '';
      input.addEventListener('change', () => {
        const v = input.value || null;
        if (v !== null && !ROUTINE_TIME.test(v)) return;
        update((x) => { x[mode][id] = v; });
        render();
      });
      const none = document.createElement('button');
      none.type = 'button';
      none.className = 'cut-btn quiet chip';
      none.textContent = 'なし';
      none.setAttribute('aria-pressed', String(!times[id]));
      none.setAttribute('aria-label', `${mode === 'weekday' ? '平日' : '休日'}の${label}をなしにする`);
      none.addEventListener('click', () => {
        if (!times[id]) { input.focus(); return; } // なしのときは時刻を入れてもらう
        update((x) => { x[mode][id] = null; });
        render();
      });
      li.append(name, input, none);
      return li;
    }));
    $('routine-holidays').replaceChildren(...WEEK_LABELS.map((w, n) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'cut-btn quiet chip';
      b.textContent = w;
      b.setAttribute('aria-pressed', String(r.holidays.includes(n)));
      b.setAttribute('aria-label', `${w}曜日を休日にする`);
      b.addEventListener('click', () => {
        update((x) => { x.holidays = x.holidays.includes(n) ? x.holidays.filter((k) => k !== n) : [...x.holidays, n].sort(); });
        render();
      });
      return b;
    }));
  }
  $('routine-mode-weekday').addEventListener('click', () => { mode = 'weekday'; render(); });
  $('routine-mode-holiday').addEventListener('click', () => { mode = 'holiday'; render(); });
  // 予定の画面の「毎日の時刻」のボタンで開く・閉じる（D-060 ⑭）
  $('routine-open').addEventListener('click', () => {
    const open = $('routine-panel').hidden;
    $('routine-panel').hidden = !open;
    $('routine-open').setAttribute('aria-expanded', String(open));
    if (open) { render(); $('routine-panel').scrollIntoView({ block: 'nearest' }); }
  });
  render();
})();

// ---------- その日だけ変える（D-060 ⑭）。予定のリストの生活の時刻の行から開く ----------
const RoutineDay = (() => {
  const $ = (id) => document.getElementById(id);
  const dlg = $('routine-day');
  let target = null; // { id, title, day: 'YYYY-MM-DD' }
  function done(message) {
    dlg.close();
    window.dispatchEvent(new Event('routinechange'));
    if (message) window.dispatchEvent(new CustomEvent('routineday', { detail: message }));
  }
  function apply(value) {
    if (!Routine.setOverride(parseDay(target.day), target.id, value)) { $('routine-day-status').textContent = SAVE_FAILED; return; }
    const d = labelShort(parseDay(target.day));
    done(value === undefined ? `${d}の${target.title}を元に戻しました` : value === null ? `${d}の${target.title}をなしにしました` : `${d}の${target.title}を${value}にしました`);
  }
  function open(ev) {
    target = { id: ev.id, title: ev.title, day: ev.day };
    const day = parseDay(ev.day);
    const base = Routine.baseTimesFor(day)[ev.id];
    const over = Routine.overrideOf(day, ev.id);
    $('routine-day-title').textContent = `${labelShort(day)}の${ev.title}`;
    $('routine-day-base').textContent = `${Routine.typeOf(day) === 'holiday' ? '休日' : '平日'}の時刻：${base || 'なし'}${over ? `（この日だけ${over.value === null ? 'なし' : over.value}にしています）` : ''}`;
    $('routine-day-time').value = (over ? over.value : base) || base || '';
    $('routine-day-reset').hidden = !over;
    $('routine-day-status').textContent = '';
    dlg.showModal();
    $('routine-day-time').focus();
  }
  $('routine-day-close').addEventListener('click', () => dlg.close());
  dlg.addEventListener('click', (e) => { if (e.target === e.currentTarget) dlg.close(); });
  $('routine-day-save').addEventListener('click', () => {
    const v = $('routine-day-time').value;
    if (!ROUTINE_TIME.test(v)) { $('routine-day-status').textContent = '時刻を入れてください'; return; }
    const base = Routine.baseTimesFor(parseDay(target.day))[target.id];
    apply(v === base ? undefined : v); // 平日・休日の時刻と同じなら、上書きを消す
  });
  $('routine-day-none').addEventListener('click', () => apply(null));
  $('routine-day-reset').addEventListener('click', () => apply(undefined));
  return { open };
})();
