# 引き継ぎ資料（別のチャットで作業を続けるとき）

最終更新：2026-11-15（版 phase1-v11 の公開直後）

この資料には、**ほかのファイルに書かれていないことだけ**を書く。仕様・決定・タスク・手順は該当ファイルを参照する。内容が古くなったら、作業を終えるたびにこのファイルを直す。

## 1. 最初に読むもの

`docs/README.md` の「作業の種類ごとに、最初に読むもの」に従う（`CLAUDE.md` → `docs/README.md` → `docs/roadmap.md` → `NEEDS_HUMAN.md`）。

## 2. 現在地

| 項目 | 状態 | 詳しくは |
| --- | --- | --- |
| フェーズ | フェーズ1（画面設計）の「各機能画面」 | `docs/roadmap.md` の「フェーズ1」 |
| 公開中の版 | `phase1-v11`（`app/app.js` の `APP_VERSION`） | 公開 URL は `NEEDS_HUMAN.md` の H-010 |
| ホーム | 完了・実機確認済み | `docs/decisions.md` D-019〜D-025 |
| タスク画面 | 完了・実機確認済み（phase1-v9） | roadmap「タスク画面」、D-026 ① |
| 日報画面 | 完了・実機確認済み（phase1-v10） | roadmap「日報画面」、D-026 ②、D-027 |
| タイマー画面 | 完了・実機確認済み（phase1-v11。終了の通知つき。セリフは phase1-v12 で確定） | roadmap「タイマー画面」、D-028、D-029 |
| 次の作業 | タイマーの実機確認が OK なら **予定画面** | D-026 ④、下の「3」 |
| 人間待ち | H-013（立ち絵。受け入れ準備は済み） | `NEEDS_HUMAN.md` |
| 利用者の確認待ちのセリフ（仮案） | `idle_greeting`、`screen_empty.*`、`report_saved.*`（`timer_done.*` は確定済み。D-029） | `data/dialogue_template.yaml` の description に「仮案」と書いてある項目 |

## 3. 次の作業の要点（予定画面）

- 項目は D-026 ④：フェーズ2で Google カレンダーとつなぐまでは `app/sample-data.js` の仮の予定を一覧で見るだけ（実際のカレンダーには触れない）
- タイマーの実機確認で直しが出たら、そちらを先に片づける。「問題なし」なら roadmap に実機結果を書き、H-014 を完了にする
- 通知予約の API（`/api/schedule`・`/api/cancel`。D-028）はタイマーで先に作った。フェーズ2の食事・休憩などの声掛けも同じ API に乗せる（キーは `meal_check:2026-11-07` のように種類と日付）
- 各画面の共通の作り（上部のタイトル、金の塗りは1つ、行の高さ52px以上、空のときのキャラクターの一言）は roadmap の「後続フェーズへの申し送り（ホーム指示書 §7）」にある

## 4. 利用者との進め方（ファイルに書いていない約束）

- 会話は日本語
- **1画面ずつ**作り、公開して実機確認を頼み、「問題なし」の返事をもらってから次へ進む
- 実機確認の頼み方：設定画面に出る版（例「版：phase1-v10」）を最初に確かめてもらう。手順の全文は roadmap に書き、チャットには要点だけを書く。結果を受け取ったら roadmap の該当画面に「実機結果（日付）」を書き足してコミットする
- 選択肢を出すときは、推奨を1つめに置き「（推奨）」と書く。利用者はこれまで推奨をそのまま選ぶことが多い
- 仮のセリフ（仮案）は利用者が言い回しを確かめるまで「仮案」のままにする。作った画面の確認を頼むときに、仮案がどこに出るかも伝える
- 合言葉（APP_TOKEN）・ntfy のトピック名・利用者のメールアドレスは、チャットにもリポジトリにも書かない（D-008、`docs/cloudflare_setup.md`）

## 5. 1画面を作るときの手順（毎回やること）

1. 画面の中身：`app/index.html` の該当 `view`、画面ごとの JS（`app/tasks.js` や `app/report.js` を手本にした IIFE）、`app/style.css` の「各機能画面の共通部品」の後ろにその画面の節を足す。色・大きさはトークンだけを使う（`tests/test_style.py` が確かめる）
2. セリフを足したら `python3 scripts/build_dialogue.py` で JSON を作り直す
3. 版を上げる：`app/app.js` の `APP_VERSION` と `app/sw.js` の `CACHE_VERSION` を同じ値にする。新しい JS は `app/sw.js` の `ASSETS` にも足す
4. 新しいファイルは `docs/README.md` の表に足す（載っていないと `tests/test_docs_index.py` が落ちる）
5. 決めたことは `docs/decisions.md` に追記する。**新しい行は最後の D 行のすぐ後（「## 記入例」より前）に入れる**
6. テストを足す：`tests/test_pwa.py` の `clock_page(hour, minute, query, size, safe, day, init_script)` で時刻と保存データを決めて開ける（例：`tasks_page`、`report_page`）。最低限：保存と再読み込み後の保持、空入力の扱い、金の塗りが1つ、入力欄の文字16px以上、幅375pxで横にはみ出さない
7. 2つのテストを両方とも通す（コマンドは `CLAUDE.md` の末尾）
8. 画面写真で見た目を確かめる（Playwright で幅375と393。`full_page=True` で撮ると下のタブバーが写真の途中に写るが、固定表示のための見え方で不具合ではない）
9. roadmap の該当画面に「実装済み・自動テスト・実機確認手順」を書く
10. コミット（1コミット＝1つの検証可能な変更）して push、公開を確かめてから利用者に実機確認を頼む

## 6. 作業環境のくせ・つまずいたこと

- **公開の確認**：`gh api` の Pages API はプロキシで止められる。push の約1分後に、WebFetch で `https://kana13914-pixel.github.io/kiinichi-manager/app/sw.js?check=<版>` を読み、`CACHE_VERSION` が新しい版になっているかで確かめる（`?check=` を変えるとキャッシュを避けられる）
- **画面テスト**：Playwright と Chrome（`/usr/bin/google-chrome`）は入っている。パッケージの追加（pip・npm）はネットワーク設定で止められていることがある
- **変更を一時的に戻して試すとき**は `git stash` を使わない（未コミットの `app/style.css` の変更を一度失いかけた）。ファイルを `/tmp` にコピーして戻す
- **Node のテスト**で vm の中で作ったオブジェクトを `deepEqual` で比べると、見た目が同じでも失敗する。`JSON.parse(JSON.stringify(x))` にしてから比べる
- **斜めに切った部品**（`clip-path`）は `border`・`box-shadow`・`outline` が欠ける。縁や強調の描き方は `docs/visual_rules.md` の CR-S02、CR-S05
- **iPhone で入力欄を押すと拡大される**のを防ぐため、入力欄（`input`・`textarea`）の文字は16px以上にする（`app/style.css` の `input, textarea, .field` の規則）
- **Cloudflare のコネクタ**（利用者がチャットにつないだ場合）は読み取り用。`workers_get_worker_code` に `kiinichi-push` を渡すと、デプロイ中のコードが新しい版かを確かめられる。デプロイはできない（D-029 ③）
- **送信サーバーを変えたとき**は、利用者に Cloudflare への貼り付け直しを頼む（`docs/cloudflare_setup.md` の 7）。PWA 側は、古い送信サーバーでも困らない作りにする（新しい API は 404 になるので、それを画面に出す）
- **フォームが下のタブバーに隠れる**ことがある。タスク画面では `scroll-margin-bottom` と `scrollIntoView` で直した（`app/tasks.js`）
- **コミットの末尾**に付ける行はチャットの指示に従う（これまでは `Co-Authored-By:` と `Claude-Session:` の2行）

## 7. 残っている課題（ほかのファイルにあるもの）

- 予約済み通知の `line` 番号とセリフの並び順がずれうる問題 → roadmap「後続フェーズへの申し送り」の「注意」
- `records.today` などの仮の保存先をフェーズ2でどうするか → roadmap「後続フェーズへの申し送り」、D-026 ⑤
- フェーズ2以降のタスク → roadmap「フェーズ2」以降

## 8. 新しいチャットに貼り付ける文

```
キィニチくん専属マネージャーアプリ（PWA）の開発を、別のチャットから引き継いで続けてください。
会話は日本語でお願いします。

リポジトリ：GitHub の kana13914-pixel/kiinichi-manager（Claude が直接 push してよい。force push は禁止）

最初に次の順で読んでください。
1. CLAUDE.md（常時ルール）
2. docs/handoff.md（引き継ぎ資料：現在地・進め方の約束・作業環境のくせ）
3. docs/README.md（ファイルの目次。ほかの資料はここから探す）
4. docs/roadmap.md と NEEDS_HUMAN.md

現在地は docs/handoff.md の「2. 現在地」のとおりです。
読み終えたら、現在地と次にやることを3行ほどでまとめて教えてください。
そのうえで私からのタイマー画面の実機確認の結果を待ち、問題なしなら予定画面に進んでください。
```
