# 端末に保存するデータの形

決定は `docs/decisions.md` の D-043。コードの正本は `app/util.js` の `DB`（キーの一覧）と `MIGRATIONS`（形を変えるときの引き継ぎ）。
形を変えたら、このファイルと `SCHEMA`（版）を一緒に直す。

## 方針

- 保存先は端末の localStorage（ホーム画面のアプリの中だけ。Safari とは別。D-009）。読み書きは必ず `Store`（`app/util.js`）を通す。
- データのキーは `db.*`。`db.meta.schema` に形の版を持つ（今は 2）。アプリを開くたびに `migrateData()` が版を確かめ、古ければ引き継ぐ。
- 日付は `'YYYY-MM-DD'`。**1日の区切りは朝4時**（D-034。`todayKey()`）。時刻は `'HH:MM'`、時点は 1970 年からのミリ秒。
- 記録・日報は消さずに残す。完了したタスクだけ、完了日から7日で消す（D-031）。
- 量の見込み：記録は1日あたり約 0.5KB、日報は1件あたり約 1KB。10年分でも 5MB の上限に届かない。2MB を超えるようになったら保存先（IndexedDB）を見直す。

## データ（スプレッドシートに同期する対象。D-050 で送り始めた。送るだけ）

| キー | 形 | 説明 |
| --- | --- | --- |
| `db.tasks` | `[ { id, title, due, done, doneAt, createdAt, updatedAt } ]` | タスク。`due` は日付か `null`。`updatedAt` は最後に変えた時点（同期で「どちらが新しいか」を決める） |
| `db.reports` | `{ 日付: { mood, done, left, tomorrow, savedAt } }` | 日報。1日1件。`mood` は `good`／`normal`／`tired`／`null` |
| `db.records` | `{ 日付: { 種類: 値 } }` | 毎日の記録。値はふつう `{ time, at }`（`time` は押した時刻、`at` はその時点）、休憩は `[ { time, at }, … ]`（押した回数だけ）、「今日はなし」は `{ skipped: true, at }`（D-046）。種類は下の表 |
| `db.routine` | `{ weekday: { 項目: 'HH:MM' か null }, holiday: { … }, holidays: [曜日の番号], updatedAt }` | 毎日の時刻（D-048）。項目は `wake`・`breakfast`・`work_start`・`lunch`・`work_end`・`dinner`・`bath`・`sleep`。曜日は 0＝日〜6＝土 |
| `db.timer` の `custom` | `[ { id, name, minutes } ]` | 利用者が作ったタイマー |
| `db.timer` の `builtin` | `{ 用途別の id: 分数 }` | 用途別のタイマー（`work`・`break`・`bath`・`brush`）のうち、利用者が時間を変えたものだけ（D-044）。ないものは初めの時間 |

### 記録の種類（`db.records` の「種類」）

| 種類 | 表示 | ホームに出す時間帯 |
| --- | --- | --- |
| `wake` | 起きた | 4〜11時 |
| `breakfast` | 朝食 | 5〜11時 |
| `work_start` | 仕事開始 | 7〜13時 |
| `lunch` | 昼食 | 11〜15時 |
| `break` | 休憩（1日に何度でも） | 10〜19時 |
| `work_end` | 仕事終わり | 16〜23時 |
| `dinner` | 夕食 | 17〜23時 |
| `bath` | 入浴 | 19〜翌4時 |
| `brush` | 歯磨き | 20〜翌4時 |
| `sleep` | 就寝 | 21〜翌4時 |

右の列はホームに出す時間帯（既定の毎日の時刻のとき。D-046）。実際は設定の「毎日の時刻」の前後で決まる（D-048）。コードの正本は `app/app.js` の `RECORD_KINDS`。

## この端末だけのもの（同期しない）

| キー | 説明 |
| --- | --- |
| `db.meta` | `{ schema, migratedAt }` 形の版 |
| `db.reportDraft` | 日報の書きかけ（D-033） |
| `db.prefs` | 端末ごとの好み。`screenLines`（キィニチの一言を出すか。既定 true。D-047）、`voice`（声掛けの通知。既定 true。D-049）、`weekly`（週次コメント。既定 true。D-058） |
| `db.sync` | `{ url, token, lastAt, lastSig, dirty, error }` スプレッドシートへの控えの送り先・合言葉・最後に送った時点・まだ送っていない変更があるか（D-050） |
| `db.calendar` | `{ fetchedAt, from, to, events: [ { id, calendarId, title, start, end, allDay, editable } ], error }` Google カレンダーの予定の控え（D-053。読むだけ。同期しない）。`db.calendarError` は一度も取れていないときの理由 |
| `db.weekly` | `{ 週の初め（月曜）の日付: { text, at } }` 週次コメント（D-058）。スプレッドシートにはまだ送らない |
| `db.notify` | `{ キー: { at, body } }` 送信サーバーに予約した声掛け（D-049）。変わったものだけ送り直すための控え |
| `db.timer` の `running`・`done`・`cancelPending` | 動いているタイマー、終わったタイマー、届いていない取り消し（D-028, D-033） |
| `schedule.view` | 予定画面の表示（リスト／月） |
| `setup.done` | 初回の設定が済んだ印 |
| `phase0.appToken` | 送信サーバーの合言葉（D-014）。名前は検証のときのまま（変えると入れ直しになる危険があるため） |
| `workerUrl.v2` | 送信サーバーの URL を自分で変えたときだけ（D-035） |

## これから足すもの（決まったら上の表に移す）

- 同期のための印：タスクを消したことを伝える印（`deletedAt`）、最後に同期した時点。スプレッドシート同期を作るときに決める。

## 版の履歴

| 版 | 内容 |
| --- | --- |
| 1 | フェーズ1の仮の保存先（`tasks.v1`・`reports.v1`・`reports.draft`・`timer.v1`・`records.today`） |
| 2 | キーを `db.*` に移す。記録を当日分だけから日付ごとの履歴にする。タスクに `updatedAt` を足す（D-043。版 phase2-v1） |
