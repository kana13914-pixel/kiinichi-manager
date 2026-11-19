# ファイルの案内（目次）

このリポジトリのファイルと、**いつ読むか**の一覧。ファイルを追加・移動したらこの表も直す（`tests/test_docs_index.py` が、載っていないファイルを見つける）。

## 作業の種類ごとに、最初に読むもの

| やること | 読む順 |
| --- | --- |
| 何をするにも | `CLAUDE.md` → この目次 → `docs/roadmap.md`（今のタスク）→ `NEEDS_HUMAN.md`（人間待ちの作業） |
| 別のチャットから引き継ぐ | `docs/handoff.md`（現在地・進め方の約束・作業環境のくせ。末尾に新しいチャットに貼り付ける文）→ 上の「何をするにも」 |
| 機能・会話を作る | `docs/spec.md` → `docs/decisions.md` → `docs/data_schema.md`（保存の形）→ `data/dialogue_template.yaml` |
| 画面の見た目を作る・直す | `docs/visual_rules.md`（CR-*）→ `docs/ui_knowledge.md`（V1〜M3）→ `docs/design.md`（トークン・コントラスト表）→ `app/style.css` の `:root` |
| キャラクターらしさを判断する | `docs/research/2026-11-08_round3_visual/kinich_design_research_for_ai.md`（事実と権利の範囲） |
| 見た目の不満に対応する | `docs/feedback/README.md`（原文）→ `docs/research/2026-11-08_round3_visual/first_impression_response_flow_for_ai.md`（手順） |
| 通知・送信サーバー | `docs/cloudflare_setup.md` → `worker/worker.js` → `app/sw.js` |
| スプレッドシートへの控え | `docs/gas_setup.md` → `gas/Code.gs` → `app/sync.js` |
| 決まったことを確かめる | `docs/decisions.md`（D-001〜。上書きせず追記） |

## ルート

| パス | 内容 |
| --- | --- |
| `CLAUDE.md` | 常時ルール（技術構成・禁止事項・人間に聞く場面） |
| `NEEDS_HUMAN.md` | 人間への依頼キュー（H-001〜） |
| `.env.example` | PC から ntfy に送るときの設定例（`.env` はコミットしない） |
| `.gitignore` | コミットしないファイル |
| `requirements-dev.txt` | 自動テストに必要な道具（`pip install -r requirements-dev.txt`） |
| `.github/workflows/test.yml` | push のたびに自動テストを両方とも走らせる設定（GitHub Actions。D-033） |

## docs/ — 仕様・決定・手順

| パス | 内容 | いつ読むか |
| --- | --- | --- |
| `docs/README.md` | この目次 | 最初に |
| `docs/spec.md` | 機能と会話設計の仕様 | 機能を作る前 |
| `docs/decisions.md` | 決定事項と理由（D-001〜） | 判断に迷ったとき、決定を変える前 |
| `docs/data_schema.md` | 端末に保存するデータの形（キー・項目・版の履歴。D-043） | 保存するデータを足す・変える前 |
| `docs/handoff.md` | 引き継ぎ資料（ほかのファイルにない、現在地・利用者との進め方・作業環境のくせだけ。貼り付ける文つき） | 別のチャットで作業を始めるとき、作業を終えるとき（内容を最新にする） |
| `docs/roadmap.md` | フェーズ別タスク、完了条件、実機確認手順、申し送り | 作業の始めと終わり |
| `docs/visual_rules.md` | 見た目の決まり CR-*（色・形・線・文字・地・気配・動き） | 画面を作る・直す前 |
| `docs/ui_knowledge.md` | UI/UX の知識ベース（ルール ID V1〜M3。原文のまま） | 画面を作る・直す前 |
| `docs/design.md` | 画面の原則、キャラクターの声とシステムの声、トークン表、コントラスト表 | トークンを変えるとき |
| `docs/cloudflare_setup.md` | 送信サーバー（Cloudflare Workers）の設定手順 | 送信サーバーを変えるとき |
| `docs/gas_setup.md` | スプレッドシートへの控え（Google Apps Script）の設定手順（D-050） | 控えの仕組みを変えるとき、利用者に設定を頼むとき |
| `docs/feedback/README.md` | 利用者の感想の原文（1 件 1 行） | 見た目・使い心地の対応をするとき |
| `docs/research/2026-11-08_home_review/` | ホーム改訂（D-019）の元資料：`01_knowledge_map.md`（知識領域マップ）、`03_home_instructions.md`（指示書）。知識ベース本体は `docs/ui_knowledge.md` | D-019 の経緯を確かめるとき |
| `docs/research/2026-11-19_tasks_priority/` | タスクの優先度とミニタスク（D-070 予定）の元資料：`README.md`（案の中身）、`images/`（参考の Tiimo の画面、改善前と後の比べ画像、追加のしかたの 2 案。1 倍の JPEG） | タスクの優先度・ミニタスクを直すとき |
| `docs/research/2026-11-18_round6_review/` | 全画面の見た目のレビュー（D-064。phase3-v7 → v8）の元資料：`README.md`（問題点・対応・直していないものと理由）、`images/`（改善前と後の比べ画像、見送った案。1 倍の JPEG） | R6 の経緯、CR-F12・CR-G06・CR-B04 の理由を確かめるとき |
| `docs/research/2026-11-18_round5_phase3/` | フェーズ3（phase3-v2）までのレビュー（CR-F07〜F11・CR-G05、知識ベース改訂4）の元資料：`README.md`、`01_knowledge_map_v3.md`（知識領域マップ改訂3）、`round5_review_for_ai.md`（問題点と指示）、`round5_app.patch`（参考実装・未適用）、`images/`（今と改善案の画面。半分の大きさの JPEG） | スイッチ・設定・通知・週次コメントを直すとき、R5 の経緯を確かめるとき |
| `docs/research/2026-11-16_round4_functions/` | 機能画面の見た目（CR-F・CR-G、知識ベース改訂3）の元資料：`README.md`、`01_knowledge_map_v2.md`（知識領域マップ改訂）、`round4_function_screens_for_ai.md`（診断と指示）、`round4_app.patch`（参考実装・未適用）、`images/`（v16 と改善案の画面。半分の大きさの JPEG） | 機能画面を直すとき、R4 の経緯を確かめるとき |
| `docs/research/2026-11-08_round3_visual/` | 見た目 v7（D-021）の元資料：`README.md`、`kinich_design_research_for_ai.md`（R3-Q1 事実）、`first_impression_response_flow_for_ai.md`（R3-Q2 手順）、`visual_rules_v7_instructions_for_ai.md`（R3-Q3 指示）、`phase1-v7_canopy.patch`（参考実装）、`images/`（v6・v7 の画面。容量を抑えるため半分の大きさの JPEG） | D-021 の経緯、キャラクターの事実を確かめるとき |

## app/ — PWA 本体（GitHub Pages で公開）

| パス | 内容 |
| --- | --- |
| `app/index.html` | 本体の画面（初回導線・ホーム・各タブ・設定・仕様関連（`#system`。D-051）） |
| `app/util.js` | 共通の小道具（日付、1日の区切り＝朝4時 `todayKey`：D-034、端末内の保存 `Store`、保存の形 `DB` と引き継ぎ `migrateData`：D-043）。最初に読み込む |
| `app/dialogue.js` | セリフ集から選ぶ（`pickLine`・`dialogueReady`） |
| `app/ui.js` | 共通の画面部品（確認ダイアログ・取り消しの表示 `makeToast`・画面の一言 `makeSay`・ごみ箱・画面を開いたときの描き直し `onShow`） |
| `app/app.js` | 本体の動き（画面切替・時計・セリフの表示・主ボタン・記録（10種類 `RECORD_KINDS`・時間帯で出し分け・「…」の一覧：D-046）・復帰時の判定・通知の購読と登録し直し。声の再生はなし：D-023）。`APP_VERSION` |
| `app/style.css` | 見た目。`:root` がトークンの正本 |
| `app/tasks.js` | タスク画面（追加・完了・削除（確認つき）・取り消し・期限の表示・状況に合わせた一言。完了したタスクは完了日から7日で自動で消す。「今日」は朝4時区切り。仮に localStorage の `tasks.v1`。D-026, D-031, D-034） |
| `app/report.js` | 日報画面（1日1件・4項目。朝4時で日付を区切る。これまでの日報は7日分ずつ表示。書きかけは `reports.draft` に残す。仮に localStorage の `reports.v1`。D-026, D-027, D-031, D-033） |
| `app/timer.js` | タイマー画面（用途別（時間は変えられる：D-044）・時間を指定・利用者が作るタイマー。同時に1つ。終了の通知を予約・取り消し（届かなかった取り消しはやり直す）。仮に localStorage の `timer.v1`。D-026, D-028, D-033） |
| `app/schedule.js` | 予定画面（見るだけ。リスト＝今日から7日先まで／月＝マス目にタグ、を切り替える。フェーズ2までは `app/sample-data.js` の仮データ。D-026, D-030, D-032） |
| `app/stats.js` | 内部の記録（声掛けの数・記録が無かった分。利用者には見せない。週次コメントの材料とホームのセリフの選び分けに使う。D-060 ⑩） |
| `app/notify.js` | 声掛けの通知予約（食事・休憩・夜・就寝前。毎日の時刻と記録から、今日このあと送るものを作り直して送信サーバーに予約・取り消し。D-015, D-049） |
| `app/portrait.js` | 立ち絵（設定で写真から1枚選び、ホームの画面いっぱいに敷く。位置・大きさ・部品の透け具合はホームの上で合わせる（D-067）。画像は IndexedDB、置き方は `db.portrait`。なければ `img/portrait.webp`・`.png`、それもなければ紋章：D-066、D-022 ④） |
| `app/sync.js` | スプレッドシートへの控え（端末のデータを GAS のウェブアプリに送る。送るだけ。設定の「スプレッドシートへの控え」。D-050） |
| `app/settings.js` | 送信サーバーの URL（既定値。D-035）と合言葉（端末内保存） |
| `app/routine.js` | 毎日の時刻（平日・休日の予定時刻と休日の曜日。`db.routine`。設定の「毎日の時刻」の画面も。D-048） |
| `app/calendar.js` | Google カレンダーの予定を読む・足す・直す・消す（スプレッドシートの控えと同じ GAS のウェブアプリから。5分ごとに取り直し、端末に控える。D-053, D-054） |
| `app/sample-data.js` | 予定の仮データ（毎日の生活の時刻＋仮の予定）。ホーム・予定のリスト・月表示が共通で読む `eventsOn(日付)`（フェーズ 2 で置き換え。D-032） |
| `app/sw.js` | Service Worker（キャッシュ・遅い回線ではキャッシュを先に返す・通知の表示とタップ）。`CACHE_VERSION` は `APP_VERSION` と同じにする |
| `app/manifest.webmanifest` | ホーム画面に追加したときの名前・色・アイコン |
| `app/send.html`, `app/send.js` | 検証用の送信ページ（ntfy と Web Push） |
| `app/data/dialogue.json` | セリフ集（`data/dialogue_template.yaml` から生成。直接編集しない） |
| `app/img/` | 装飾の SVG（紋章・吊り線・段々の帯・粒、各画面の一言の面の小さな紋章 `mini-emblem.svg`：D-059）。立ち絵を置く場所（`portrait.webp`） |
| `app/icons/` | アプリのアイコン |

## その他のフォルダ

| パス | 内容 |
| --- | --- |
| `data/dialogue_template.yaml` | セリフ集の正本。編集したら `python3 scripts/build_dialogue.py` |
| `worker/worker.js` | 送信サーバー（Cloudflare のダッシュボードに貼り付けて使う）。即時送信・予約（`/api/send`）、キー付きの予約と取り消し（`/api/schedule`・`/api/cancel`。D-015, D-028）、送れなかった予約のやり直しと送信結果の記録（D-033） |
| `gas/Code.gs` | スプレッドシートへの控えの受け口（Google Apps Script。スプレッドシートの「拡張機能 → Apps Script」に貼り付けて使う。D-050） |
| `worker/package.json` | テストで読み込むための設定（デプロイには不要） |
| `scripts/build_dialogue.py` | セリフ集の YAML → JSON |
| `scripts/contrast_check.py` | 色の明暗差の計算（トークンを変えたら実行し、`docs/design.md` に貼る） |
| `scripts/ntfy_send.py` | PC から ntfy に通知を送る（予備経路） |
| `tests/` | 自動テスト。`python3 -m unittest discover -s tests` と `node --test tests/worker.test.mjs tests/sw.test.mjs tests/gas.test.mjs` |
| `tests/test_pwa.py` | 画面の動き（ヘッドレス Chrome） |
| `tests/test_style.py` | トークン・コントラスト・装飾画像のキャッシュ |
| `tests/test_dialogue.py` | セリフ集の YAML と JSON の一致 |
| `tests/test_ntfy_send.py` | ntfy 送信スクリプト |
| `tests/test_docs_index.py` | この目次にすべてのファイルが載っているか |
| `tests/worker.test.mjs` | 送信サーバー（暗号化・予約・認証・キー付きの予約と取り消し） |
| `tests/gas.test.mjs` | スプレッドシートへの控えの受け口（合言葉、記録・日報・タスクを消さずに書く） |
| `tests/sw.test.mjs` | Service Worker（通知の表示とタップ・キャッシュの取り方） |
