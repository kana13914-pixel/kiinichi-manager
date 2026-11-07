// 仮データ（フェーズ1の画面確認用）。フェーズ2でローカル保存・Googleカレンダー連携に置き換える。
// 本物の予定は使わない。時刻は「今日」の日付で作る。
const SampleData = (() => {
  const items = [
    ['07:00', '起床'],
    ['09:00', '仕事開始'],
    ['12:00', '昼食'],
    ['15:00', '休憩'],
    ['18:30', '仕事終わり'],
    ['19:30', '夕食'],
    ['22:30', '入浴'],
    ['23:30', '就寝'],
  ];
  function todayEvents(now = new Date()) {
    return items.map(([hm, title]) => {
      const [h, m] = hm.split(':').map(Number);
      const at = new Date(now);
      at.setHours(h, m, 0, 0);
      return { at, title };
    });
  }
  return { todayEvents };
})();
