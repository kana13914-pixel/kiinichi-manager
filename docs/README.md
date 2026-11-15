# ファイルの案内（目次）

このリポジトリのファイルと、**いつ読むか**の一覧。ファイルを追加・移動したらこの表も直す（`tests/test_docs_index.py` が、載っていないファイルを見つける）。

## 作業の種類ごとに、最初に読むもの

| やること | 読む順 |
| --- | --- |
| 何をするにも | `CLAUDE.md` → この目次 → `docs/roadmap.md`（今のタスク）→ `NEEDS_HUMAN.md`（人間待ちの作業） |
| 機能・会話を作る | `docs/spec.md` → `docs/decisions.md` → `data/dialogue_template.yaml` |
| 画面の見た目を作る・直す | `docs/visual_rules.md`（CR-*）→ `docs/ui_knowledge.md`（V1〜M3）→ `docs/design.md`（トークン・コントラスト表）→ `app/style.css` の `:root` |
| キャラクターらしさを判断する | `docs/research/2026-11-08_round3_visual/kinich_design_research_for_ai.md`（事実と権利の範囲） |
| 見た目の不満に対応する | `docs/feedback/README.md`（原文）→ `docs/research/2026-11-08_round3_visual/first_impression_response_flow_for_ai.md`（手順） |
| 通知・送信サーバー | `docs/cloudflare_setup.md` → `worker/worker.js` → `app/sw.js` |
| 決まったことを確かめる | `docs/decisions.md`（D-001〜。上書きせず追記） |

## ルート

| パス | 内容 |
| --- | --- |
| `CLAUDE.md` | 常時ルール（技術構成・禁止事項・人間に聞く場面） |
| `NEEDS_HUMAN.md` | 人間への依頼キュー（H-001〜） |
| `.env.example` | PC から ntfy に送るときの設定例（`.env` はコミットしない） |
| `.gitignore` | コミットしないファイル |

## docs/ — 仕様・決定・手順

| パス | 内容 | いつ読むか |
| --- | --- | --- |
| `docs/README.md` | この目次 | 最初に |
| `docs/spec.md` | 機能と会話設計の仕様 | 機能を作る前 |
| `docs/decisions.md` | 決定事項と理由（D-001〜） | 判断に迷ったとき、決定を変える前 |
| `docs/roadmap.md` | フェーズ別タスク、完了条件、実機確認手順、申し送り | 作業の始めと終わり |
| `docs/visual_rules.md` | 見た目の決まり CR-*（色・形・線・文字・地・気配・動き） | 画面を作る・直す前 |
| `docs/ui_knowledge.md` | UI/UX の知識ベース（ルール ID V1〜M3。原文のまま） | 画面を作る・直す前 |
| `docs/design.md` | 画面の原則、キャラクターの声とシステムの声、トークン表、コントラスト表 | トークンを変えるとき |
| `docs/cloudflare_setup.md` | 送信サーバー（Cloudflare Workers）の設定手順 | 送信サーバーを変えるとき |
| `docs/feedback/README.md` | 利用者の感想の原文（1 件 1 行） | 見た目・使い心地の対応をするとき |
| `docs/research/2026-11-08_home_review/` | ホーム改訂（D-019）の元資料：`01_knowledge_map.md`（知識領域マップ）、`03_home_instructions.md`（指示書）。知識ベース本体は `docs/ui_knowledge.md` | D-019 の経緯を確かめるとき |
| `docs/research/2026-11-08_round3_visual/` | 見た目 v7（D-021）の元資料：`README.md`、`kinich_design_research_for_ai.md`（R3-Q1 事実）、`first_impression_response_flow_for_ai.md`（R3-Q2 手順）、`visual_rules_v7_instructions_for_ai.md`（R3-Q3 指示）、`phase1-v7_canopy.patch`（参考実装）、`images/`（v6・v7 の画面。容量を抑えるため半分の大きさの JPEG） | D-021 の経緯、キャラクターの事実を確かめるとき |

## app/ — PWA 本体（GitHub Pages で公開）

| パス | 内容 |
| --- | --- |
| `app/index.html` | 本体の画面（初回導線・ホーム・各タブ・設定） |
| `app/app.js` | 本体の動き（画面切替・時計・セリフ・主ボタン・記録・復帰時の判定・通知の購読・立ち絵の自動表示。声の再生はなし：D-023）。`APP_VERSION` |
| `app/style.css` | 見た目。`:root` がトークンの正本 |
| `app/settings.js` | 送信サーバーの URL と合言葉（端末内保存） |
| `app/sample-data.js` | 次の予定の仮データ（フェーズ 2 で置き換え） |
| `app/sw.js` | Service Worker（キャッシュ・通知の表示とタップ）。`CACHE_VERSION` は `APP_VERSION` と同じにする |
| `app/manifest.webmanifest` | ホーム画面に追加したときの名前・色・アイコン |
| `app/send.html`, `app/send.js` | 検証用の送信ページ（ntfy と Web Push） |
| `app/data/dialogue.json` | セリフ集（`data/dialogue_template.yaml` から生成。直接編集しない） |
| `app/img/` | 装飾の SVG（紋章・吊り線・段々の帯・粒）。立ち絵を置く場所（`portrait.webp`） |
| `app/icons/` | アプリのアイコン |

## その他のフォルダ

| パス | 内容 |
| --- | --- |
| `data/dialogue_template.yaml` | セリフ集の正本。編集したら `python3 scripts/build_dialogue.py` |
| `worker/worker.js` | 送信サーバー（Cloudflare のダッシュボードに貼り付けて使う） |
| `worker/package.json` | テストで読み込むための設定（デプロイには不要） |
| `scripts/build_dialogue.py` | セリフ集の YAML → JSON |
| `scripts/contrast_check.py` | 色の明暗差の計算（トークンを変えたら実行し、`docs/design.md` に貼る） |
| `scripts/ntfy_send.py` | PC から ntfy に通知を送る（予備経路） |
| `tests/` | 自動テスト。`python3 -m unittest discover -s tests` と `node --test tests/worker.test.mjs tests/sw.test.mjs` |
| `tests/test_pwa.py` | 画面の動き（ヘッドレス Chrome） |
| `tests/test_style.py` | トークン・コントラスト・装飾画像のキャッシュ |
| `tests/test_dialogue.py` | セリフ集の YAML と JSON の一致 |
| `tests/test_ntfy_send.py` | ntfy 送信スクリプト |
| `tests/test_docs_index.py` | この目次にすべてのファイルが載っているか |
| `tests/worker.test.mjs` | 送信サーバー（暗号化・予約・認証） |
| `tests/sw.test.mjs` | Service Worker（通知の表示とタップ・キャッシュの取り方） |
