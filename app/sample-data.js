// 予定の取得元。生活の時刻は設定の「毎日の時刻」（routine.js）、カレンダーの予定は仮データ（Google カレンダー連携で置き換える）。
// 本物の予定は使わない。予定画面の縦リストも月表示もホームも、ここ（eventsOn）だけを読む（D-032）。
//   kind … 'routine'＝毎日の生活の時刻（起床・食事など。D-048）／'event'＝カレンダーに入れる予定（仮）
//   allDay … 時刻のない終日の予定
const SampleData = (() => {
  // 仮の予定。毎月この日に置く（days は続く日数）
  const monthly = [
    { day: 3, time: '19:00', title: '読書会' },
    { day: 12, time: '18:00', title: '歯医者' },
    { day: 14, title: '部屋の片づけ' },
    { day: 14, time: '10:00', title: '買い出し' },
    { day: 14, time: '19:00', title: '友人と夕食' },
    { day: 18, title: '定期点検' },
    { day: 20, days: 2, title: '旅行' },
    { day: 26, time: '15:00', title: '美容院' },
    { day: 28, title: '大掃除' },
  ];
  function timeOn(date, hm) {
    const [h, m] = hm.split(':').map(Number);
    const at = new Date(date);
    at.setHours(h, m, 0, 0);
    return at;
  }
  // その日（暦日）の予定。終日が先、あとは時刻順。
  // 生活の時刻は設定の「毎日の時刻」（routine.js。D-048）から。深夜0〜4時の時刻は、前の日の分としてこの日に並ぶ
  function eventsOn(date) {
    const d = date.getDate();
    const day = startOfDay(date);
    const list = [...Routine.eventsFor(addDays(day, -1)), ...Routine.eventsFor(day)].filter((e) => dateStr(e.at) === dateStr(day));
    for (const m of monthly) {
      if (d < m.day || d >= m.day + (m.days || 1)) continue;
      list.push({ at: timeOn(date, m.time || '00:00'), title: m.title, kind: 'event', allDay: !m.time });
    }
    return list.sort((a, b) => (a.allDay !== b.allDay ? (a.allDay ? -1 : 1) : a.at - b.at));
  }
  // 時刻のある予定だけ（ホームの「次の予定」用）
  function todayEvents(now = new Date()) {
    return eventsOn(now).filter((e) => !e.allDay);
  }
  return { eventsOn, todayEvents };
})();
