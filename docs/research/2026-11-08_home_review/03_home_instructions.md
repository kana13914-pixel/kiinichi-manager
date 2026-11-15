# AI用指示書：ホーム画面の改善（phase1-v6）改訂2

- 宛先：`kana13914-pixel/kiinichi-manager` を開発している Claude
- 基準の版：`main` の `a143654`（phase1-v5）。この時点の自動テストは Python 27 件・Node 17 件
- 作成日：2026-11-08（改訂2。改訂1からの変更は §11）
- 位置づけ：`docs/roadmap.md` フェーズ1「ホーム画面のレイアウトを決める」の実機確認手順 5（見た目・配置・文字の大きさで直したいところ）への回答。D-018（仮決定）を置き換える D-019 を作る
- 同梱物：
  - `02_AI_ui_knowledge_base.md`（改訂2）… 本指示書の根拠ルール（ID 付き）。リポジトリに `docs/ui_knowledge.md` として置く
  - `reference_impl/` … 改訂1の指示書で試作した見本（`phase1-v6_reference.patch` と、適用後のファイル一式）。**構造の参考にとどめる**。改訂2と違う部分は §8 の一覧どおりに直す
  - `images/compare_home.png` ほか … 見本の画面。配置の参考のみ。色・文言・細部は本指示書が優先
- 食い違ったときの優先順位：`CLAUDE.md` ＞ `docs/spec.md` ＞ `docs/decisions.md` ＞ 本指示書 ＞ 知識ベース ＞ 見本・画像・人間学習用教本。本指示書が上位の文書と食い違っていたら、作業を止めてユーザーに聞く

---

## 0. 進め方の約束

1. 最初に `CLAUDE.md` の作業ルールに従うこと。小さい単位でコミットする。`APP_VERSION` と `sw.js` の `CACHE_VERSION` を同じ値に上げる。`docs/roadmap.md` に実機確認手順を書く。決定は理由とともに `docs/decisions.md` に記録する。迷ったら `NEEDS_HUMAN.md`。
2. 最初に §1 の 7 問を、チャットでまとめてユーザーに聞く。選択肢を出せる仕組みがあれば使い、推奨を先頭に置く。
3. 全問の回答が揃うまで、進めてよいのは T01 だけ。回答が揃ったら、T02 に入る前に §1 の「D-019 に書く内容」を `docs/decisions.md` に追記してコミットする。知識ベースの【回答依存】ルールは、この D-019 を参照する。
4. 回答が揃わないまま作業を終える場合は、未回答の質問を H-013 として `NEEDS_HUMAN.md` に追記して止まる（`NEEDS_HUMAN.md` の規則どおり）。推奨案を勝手に採用しない。
5. 見本をそのまま 1 コミットで当てない。§3 のタスク単位で、実装・テスト・コミットする。見本を当ててから分ける場合も、§8 の差分を必ず直す。
6. コミットメッセージに、根拠のルール ID（例 `根拠: V3-02, C4-02`）と、関係する回答（例 `D-019 Q2=A`）を書く。
7. 既存のテストを変える場合は、理由をコミットメッセージに書く（変更が必要なテストは §4）。
8. 迷ったら、まず知識ベースのルール、次に本指示書の受け入れ条件を見る。それでも決まらなければ止まってユーザーに聞く。

---

## 1. 着手前にユーザーへ確認すること

質問文はそのまま使ってよい。回答は、T02 に入る前に `docs/decisions.md` の D-019 に記録する（下の「D-019 に書く内容」）。

| # | 質問 | 推奨 | 別案 | 影響するタスク・ルール |
| --- | --- | --- | --- | --- |
| Q1 | 下のタブを 5 個（ホーム・予定・タスク・タイマー・日報）にして、「設定」はホーム右上のアイコンから開く形にしてよいですか | 5 個＋右上のアイコン | 設定を含む 6 個のまま（各タブにアイコンは付ける） | T04 / I2-01 |
| Q2 | 立ち絵とセリフの配置はどちらにしますか。A：立ち絵が上、セリフの窓が下（ノベルゲーム型）。B：今と同じく立ち絵の横に吹き出し（画面の下寄りに移すので、上部に空きができます）。どちらもセリフの面は暗い色にします | A | B | T03, T06 / C1-05, C2-01 |
| Q3 | 時計を小さく（28px の見出し行に）してよいですか | 28px | 今の 51px | T03 / V1-02 |
| Q4 | 通知や記録がないとき、時間帯の一言を出しますか。出す場合は、§5 の仮案 8 本を直してください | 出す（文言はユーザーが直す） | 出さない（「…」を出す） | T05 / C1-01 |
| Q5 | 夜（22 時〜5 時）は背景を一段暗くしてよいですか | 暗くする | 変えない | T11 / C9-02 |
| Q6 | iPhone の「設定 → 画面表示と明るさ → テキストサイズ」を、標準より大きくしていますか | していない → 文字サイズ設定に追従しない | している → 追従する（文字を大きくしたときだけ、ホームのスクロールを許す） | T02 / V2-08 |
| Q7 | 「起きた」などを押した記録を、今日の分だけこの iPhone に保存してよいですか（正式な保存の仕組みはフェーズ2で作り直します） | 保存する | 保存しない（その場合、時間帯に合わせて記録ボタンを金色にする機能もフェーズ2まで入れない） | T08, T09, T10 / C4-02, C6-01 |

- Q4 で「出す」の場合、ユーザーが直した文言を使う。直しがなければ §5 の仮案をそのまま使い、`description` に「仮案。ユーザー確認待ち」と残す。
- Q7 の保存は、フェーズ2の「ローカル保存のデータ構造」を先取りしない一時的な保存として、D-019 に仮決定で記録する。

**D-019 に書く内容**（`docs/decisions.md` の末尾に追記する。上書きしない。状態は「仮決定（実機確認後に確定）」）：

- D-018 を置き換えること
- Q1〜Q7 の回答
- ホームの構成（A または B の順番）
- 主ボタンは 1 つ、金の使い道（知識ベース V3-08）
- 時間帯の区分（C9-01）、記録ボタンの受付時間帯 `wake 4-11` / `work_start 7-13`（仮）
- 「開いたとき」の判定し直しの基準 `RESUME_REFRESH_MS` = 10 分（仮）
- 通知の URL の `line` パラメータ（C5-05）
- Q7 = 保存する場合は `records.today` の形（仮、フェーズ2で置き換え）
- Q1 = 推奨の場合、設定を右上に移す理由（日常的に開かない。D-018 の「片手で届く下部」は日常の操作に当てはめる）
- 根拠のルール ID

---

## 2. 変更一覧

| ID | 内容 | 主なファイル | 根拠 | 依存する回答 |
| --- | --- | --- | --- | --- |
| T01 | 知識ベースと `docs/design.md` を置く | `docs/ui_knowledge.md`, `docs/design.md`, `CLAUDE.md` | M2-01, M2-02 | なし（回答前に進めてよい） |
| T02 | デザイントークン、全体の不具合修正、コントラスト確認スクリプト | `app/style.css`, `app/app.js`, `scripts/contrast_check.py`, `tests/test_style.py`, `docs/design.md`, `CLAUDE.md` | V2-04, V3-01, V3-04, V4-03, P1-*, I3-01, P2-04, M2-01, M2-02 | Q6 |
| T03 | ホームの構造（上＝見る／下＝触る） | `app/index.html`, `app/style.css`, `app/app.js` | V1-01〜04, I1-02, I4-04, C1-05, C2-01, C7-02, C7-03 | Q2, Q3 |
| T04 | タブとナビゲーション | `app/index.html`, `app/app.js`, `app/style.css` | I2-01〜05, P2-02, C8-04 | Q1 |
| T05 | セリフの選び方（時間帯の一言、重複回避、`line` 指定）と spec.md の更新 | `data/dialogue_template.yaml`, `app/data/dialogue.json`, `app/app.js`, `docs/spec.md` | C1-01, C1-02, C5-05, C8-03, C8-05〜07, C9-01 | Q4 |
| T06 | 「声を聞く」の状態表示 | `app/index.html`, `app/app.js`, `app/style.css` | C2-02, V3-05, V3-08, I4-02 | Q2（置き場所のみ） |
| T07 | 送信ページ：本文＝セリフ、URL に `line` | `app/send.js` | C5-04, C5-05 | なし |
| T08 | 主ボタンは 1 つ、通知から開いた状態 | `app/index.html`, `app/app.js`, `app/style.css` | V3-02, V3-08, C4-02, C5-03 | Q7 |
| T09 | 記録の完了表示・取り消し・当日分の保存 | `app/index.html`, `app/app.js`, `app/style.css` | I3-02, C6-01 | Q7 |
| T10 | 「開いたとき」の判定し直しと、通知タップの補い | `app/app.js`, `app/sw.js`, `tests/sw.test.mjs` | P1-11, P1-12, C5-03 | Q4, Q7（中身だけ） |
| T11 | 夜の配色 | `app/app.js`, `app/style.css` | C9-02 | Q5 |
| T12 | 仕上げ（版・roadmap・decisions・NEEDS_HUMAN） | `app/app.js`, `app/sw.js`, `docs/*`, `NEEDS_HUMAN.md` | M1-01 | 全部 |

- 作業の順番は ID の順（T01 → T12）。テストは各タスクのコミットに含める。
- push は原則、T12 の後に 1 回だけ行い、版は `phase1-v6` にする。途中で push する場合は push ごとに版を上げ（`phase1-v6`, `phase1-v7`, …）、その都度 roadmap に実機確認手順を書く。§6 の「版」は、最後に push した版に読み替える。

---

## 3. タスク詳細

### T01 知識ベースと `docs/design.md` を置く（回答前に進めてよい）

1. `02_AI_ui_knowledge_base.md` を `docs/ui_knowledge.md` として追加する（内容は変更しない）。
2. `docs/design.md` を新規作成し、次の 3 節を書く（トークン表とコントラスト表は T02 で追加する）。
   - 「画面の原則」：①主役を一番強く（V1-01）②触るものは下半分（I1-02）③金の塗りは 1 画面 1 つ、金の使い道は限定（V3-02, V3-08）④状態は色以外でも（V3-05）⑤開発用の文言を出さない（I4-02）⑥裏から戻ったら判定し直す（P1-11）
   - 「キャラクターの声とシステムの声」：C8-01, C8-02, C8-05〜07 の要約
   - 「変更手順」：トークンの値は `app/style.css` の `:root` が正本。追加・変更したら `python3 scripts/contrast_check.py` を実行し、出力を本ファイルのコントラスト表に貼る
3. `CLAUDE.md` の「ドキュメント一覧」に次の 2 行を追加する。技術構成の表は変更しない（D-006）。
   - `docs/ui_knowledge.md — UI/UX の知識ベース（ルール ID 付き）。画面を作る・直す前に読む`
   - `docs/design.md — デザインの決まりごと（トークン・原則・コントラスト表）`
- 受け入れ条件：3 ファイルがコミットされ、`CLAUDE.md` から 2 文書へ辿れる。

### T02 デザイントークンと全体の修正（Q6 の回答後）

1. `app/style.css` の先頭を次の `:root` に置き換え、既存の生の値（色コード・px・rem・`opacity` による文字色）をすべてトークンに置き換える（M2-01）。

```css
:root {
  color-scheme: dark; /* P1-08 */

  /* 色：面（奥ほど暗い） */
  --color-bg: #1e4034;
  --color-bg-deep: #163128;             /* タブバー・入力欄・名前欄の地 */
  --color-surface-1: #2a4b3f;           /* カード・次の予定の帯 */
  --color-surface-2: #355749;           /* 控えめなボタン・トースト */
  --color-scrim: rgba(13, 31, 25, 0.9); /* セリフの面（bg に重ねると約 #0f221c） */
  /* 色：文字（半透明は使わない。V3-04） */
  --color-text: #f4f1e8;
  --color-text-secondary: #c8d4cb;
  --color-text-tertiary: #adbfb3;
  /* 色：役割 */
  --color-accent: #e8c45c;              /* 使い道は V3-08 */
  --color-on-accent: #1e1e1e;
  --color-accent-soft: rgba(232, 196, 92, 0.14);
  --color-accent-glow: rgba(232, 196, 92, 0.5);
  --color-border: #7f9a8c;
  --color-border-subtle: rgba(244, 241, 232, 0.12);
  --color-stage-glow: rgba(244, 241, 232, 0.06);
  --color-success: #8fe3a5;
  --color-danger: #ffb3a6;              /* 旧 #ff9a8a はカード上 4.40:1 で不足 */

  /* 文字（iOS の文字段階。rem = 16px） */
  --font-sans: -apple-system, "Hiragino Sans", "Hiragino Kaku Gothic ProN", "Noto Sans JP", sans-serif;
  --fs-caption2: 0.6875rem; /* 11 タブのラベル専用 */
  --fs-caption: 0.75rem;    /* 12 */
  --fs-footnote: 0.8125rem; /* 13 */
  --fs-subhead: 0.9375rem;  /* 15 */
  --fs-callout: 1rem;       /* 16 入力欄・既定 */
  --fs-body: 1.0625rem;     /* 17 セリフ・本文 */
  --fs-title3: 1.25rem;     /* 20 */
  --fs-title1: 1.75rem;     /* 28 */
  --lh-tight: 1.25;
  --lh-body: 1.7;

  /* 余白・角丸 */
  --space-1: 4px; --space-2: 8px; --space-3: 12px; --space-4: 16px; --space-5: 24px; --space-6: 32px;
  --radius-xs: 4px; --radius-s: 8px; --radius-m: 12px; --radius-l: 16px; --radius-pill: 999px;

  /* 寸法 */
  --tap: 44px;
  --size-record: 52px;
  --size-btn-primary: 48px;
  --size-icon: 24px;
  --size-icon-s: 16px;
  --portrait-max-h: 420px;
  --stage-min-h: 160px;
  --home-min-h: 520px;
  --tabbar-h: 56px;

  /* 効果・動き */
  --blur-dialogue: 6px;
  --shadow-raised: 0 6px 24px rgba(0, 0, 0, 0.35);
  --dur-fast: 120ms; --dur-base: 200ms; --ease-out: cubic-bezier(0.2, 0.8, 0.2, 1);

  /* セーフエリア（CSS では env() を直接書かずこれを使う。テストで上書きする。M1-04） */
  --safe-top: env(safe-area-inset-top, 0px);
  --safe-bottom: env(safe-area-inset-bottom, 0px);
}
```

   - Q3 で「今の 51px」を選んだ場合は、`--fs-display: 3.2rem; /* 51.2 Q3 */` を追加する（T03 で使う）。
   - Q6 で「追従する」を選んだ場合は、さらに次を行う（V2-08）。
     - `:root` の前に `html { font-size: 106.25%; }` と `@supports (font: -apple-system-body) { html { font: -apple-system-body; } }` を置く。
     - 文字トークンを 17px 基準に換算する：`--fs-caption2: 0.6471rem; --fs-caption: 0.7059rem; --fs-footnote: 0.7647rem; --fs-subhead: 0.8824rem; --fs-callout: 0.9412rem; --fs-body: 1rem; --fs-title3: 1.1765rem; --fs-title1: 1.6471rem;`（`--fs-display` を使う場合は `3.0118rem`）。
     - `--fs-input-min: 16px;` を追加し、入力欄は `font-size: max(var(--fs-callout), var(--fs-input-min))` にする。
     - `body` で `font-family: var(--font-sans)` を指定し直す。

2. 全体の修正：
   - `[hidden] { display: none !important; }` — P1-10
   - `html { -webkit-text-size-adjust: 100%; -webkit-tap-highlight-color: transparent; }`
   - `body { min-height: 100dvh; overscroll-behavior: none; padding-top: max(var(--safe-top), var(--space-3)); font-family: var(--font-sans); font-size: var(--fs-callout); }` — V4-03, P1-01, P1-09
   - `body[data-state="ready"] { padding-bottom: calc(var(--tabbar-h) + var(--safe-bottom) + var(--space-4)); }`
   - `input, .field { font-size: var(--fs-callout); min-height: var(--tap); }`（設定画面の `#app-token` は今 13.3px）— V2-04
   - `button:active { transform: scale(0.97); filter: brightness(0.92); }` と `:focus-visible { outline: 2px solid var(--color-accent); outline-offset: 2px; }` — I3-06, P2-04
   - `.ng` を `--color-danger` に — V3-01
   - 補足の文字の `opacity` 指定（`.note`, `.tag`, `dt`, `.clock-date`, `.next-rest`, タブ）を固定色トークンに置き換える — V3-04
   - `@media (prefers-reduced-motion: reduce)` で `animation` / `transition` を無効にし、`button:active` の `transform` も止める — I3-04
   - 読み上げ専用の `.sr-only` クラスを追加する
   - `app/app.js` に 1 行：`document.addEventListener('touchstart', () => {}, { passive: true });`（コメント：iOS Safari で :active を有効にするため）— I3-01
3. `scripts/contrast_check.py` を作る（標準ライブラリだけで書く）。
   - `app/style.css` の `:root` と、あれば `body[data-period="night"]` のブロックから `--color-*` を読む（`#rrggbb` と `rgba()`）。
   - 知識ベース §2.4 の表の組み合わせを、昼と（ブロックがあれば）夜で計算する。`--color-scrim` は `--color-bg` に重ねた色で計算する。
   - 結果を Markdown の表で出力し、基準未満があれば終了コード 1。
4. `tests/test_style.py` を作る。
   - `test_contrast_check_passes`：`scripts/contrast_check.py` が終了コード 0。
   - `test_css_uses_tokens`：`app/style.css` から `:root { … }` と `body[data-period=…] { … }` のブロックを除いた残りに、`#` で始まる色コード、`rgba(` / `hsla(`、`1px`・`1.5px`・`2px` 以外の `px`、`rem` が無い（M2-01）。
5. `docs/design.md` に「トークン表」（名前・役割・値）と「コントラスト表」（手順 3 の出力）を追加する。`CLAUDE.md` のドキュメント一覧に `scripts/contrast_check.py — 色の明暗差を計算する（トークンを変えたら実行）` を追加する。
- 受け入れ条件：
  - 設定画面の入力欄の computed `font-size` が 16px 以上
  - `test_style.py` の 2 件が通る
  - 既存テストがすべて通る（この時点では見た目以外の挙動は変わらない）

### T03 ホームの構造（Q2・Q3 の回答後）

共通の決まり：

- 既存テストのため、ID（`clock-time`, `clock-date`, `portrait`, `bubble-text`, `play-voice`, `audio-status`, `next-event`）は残す。
- `#view-home:not([hidden])` は `display: flex; flex-direction: column; gap: var(--space-3);`。高さは `height: calc(100dvh - max(var(--safe-top), var(--space-3)) - var(--tabbar-h) - var(--safe-bottom) - var(--space-4)); min-height: var(--home-min-h);`（ホームはスクロールしない。V4-02）。Q6 で「追従する」場合は T02 の V2-08 と、下の受け入れ条件に従う。
- 記録ボタンの下にあった開発用の注記「食事・休憩・入浴などの記録はフェーズ3〜4で追加」は削除する（roadmap には残す）— I4-02
- 「仮データ」タグは「仮」に短くする。`title` 属性は付けない（P1-13）。
- 次の予定の帯（`.next-strip`）：
  - 見出し行：左に「次の予定」と「仮」タグ（`--fs-caption`, `--color-text-tertiary`）、右に `#next-rest`「あと N 時間 M 分」（1 時間未満は「あと M 分」。`--fs-footnote`, `--color-text-secondary`）— C7-02
  - 本体 `#next-event`：（翌日なら「明日」）＋時刻（`--fs-title3`, 太字）＋内容（`--fs-body`、はみ出したら「…」で省略）。時刻と残り時間は `tabular-nums`（V2-05）。
  - 今日の予定が尽きたら、翌日の最初の予定を「明日」付きで出し、残り時間も翌日の予定までで計算する — C7-03
  - DOM は表示が変わるときだけ書き換える（毎秒作り直さない）— P3-04
- 記録（`.record-dock`）：ボタンを 1 行に並べる（`grid-template-columns: repeat(auto-fit, minmax(0, 1fr))`）。各ボタンは `min-height: var(--size-record)`、`white-space: nowrap`。各ボタンに `data-trigger`, `data-label`, `data-record`, `data-hours` を付ける（T08, T09 で使う）。

```html
<button type="button" class="act" data-trigger="morning_wake.on_time" data-label="起きた" data-record="wake" data-hours="4-11">起きた</button>
<button type="button" class="act" data-trigger="work_start.default" data-label="仕事開始" data-record="work_start" data-hours="7-13">仕事開始</button>
```

- 取り消しの表示用に、ホームの最後に `<div id="toast" class="toast" role="status" hidden></div>` を置く（中身は T09）。
- 立ち絵：`-webkit-touch-callout: none; user-select: none;`（P1-07）、`role="img" aria-label="キィニチの立ち絵（仮）"`（P2-05）、破線の枠は `--color-border`。
- セリフ `#bubble-text`：`class="line" role="status"`、`font-size: var(--fs-body); line-height: var(--lh-body); min-height: calc(2em * var(--lh-body)); line-break: strict; text-wrap: pretty;` — V2-02, V2-07, P2-01, P3-02
- 「声を聞く」は、今のボタン（`▶ 声を聞く`）をそのままセリフの面の右下へ移す。中身と見た目は T06 で変える。`#audio-status` は `.sr-only` にしてボタンの手前に置く（文言「未再生」は既存テストのため残す）。

**Q2 = A（立ち絵が上、会話ウィンドウが下）**

```html
<section id="view-home" class="view home">
  <header class="home-header">
    <div class="clock">
      <span id="clock-time" class="clock-time">--:--</span>
      <span id="clock-date" class="clock-date">-</span>
    </div>
    <!-- Q1 推奨の場合、T04 で設定アイコンをここに置く -->
  </header>
  <div class="stage">
    <div id="portrait" class="portrait" role="img" aria-label="キィニチの立ち絵（仮）">立ち絵<br>（仮）</div>
  </div>
  <section class="dialogue" aria-label="キィニチのセリフ">
    <div class="nameplate" aria-hidden="true">キィニチ</div>
    <p id="bubble-text" class="line" role="status">…</p>
    <div class="dialogue-foot">
      <span id="audio-status" class="sr-only">未再生</span>
      <button id="play-voice" type="button" class="voice">▶ 声を聞く</button>
    </div>
  </section>
  <section class="next-strip" aria-label="次の予定">
    <div class="next-head"><span class="next-label">次の予定 <small class="tag">仮</small></span><span id="next-rest" class="next-rest"></span></div>
    <div id="next-event" class="next-event">-</div>
  </section>
  <section class="record-dock" aria-label="記録"><!-- 記録ボタン 2 つ --></section>
  <div id="toast" class="toast" role="status" hidden></div>
</section>
```

- 舞台 `.stage`：`flex: 1 1 auto; min-height: var(--stage-min-h); display: flex; align-items: flex-end; justify-content: center;`。背景に `radial-gradient(… var(--color-stage-glow), transparent …)` のぼかしを置いてよい（金にしない。V3-08）。
- 立ち絵 `.portrait`：`height: 100%; max-height: var(--portrait-max-h); aspect-ratio: 3 / 4;`、枠は下辺なし、角丸は上だけ `--radius-l`。
- 会話ウィンドウ `.dialogue`：`margin-top: calc(var(--space-6) * -1)`（立ち絵の足元に重ねる）、`background: var(--color-scrim); border: 1px solid var(--color-border-subtle); border-radius: var(--radius-l); padding: var(--space-4) var(--space-4) var(--space-3);`、`backdrop-filter: blur(var(--blur-dialogue))`（`-webkit-` 付きも）— C2-01
- 名前欄 `.nameplate`：左上に `top: calc(var(--space-3) * -1); left: var(--space-4);` で載せる。地は `--color-bg-deep`、文字と枠は accent、`--fs-footnote` 太字。

**Q2 = B（立ち絵の横に吹き出し）**

- 見出し行・次の予定の帯・記録・トーストは A と同じ。舞台の中に立ち絵と吹き出しを横に並べ、会話ウィンドウの独立した塊は作らない。

```html
<div class="stage stage--side">
  <div id="portrait" class="portrait" role="img" aria-label="キィニチの立ち絵（仮）">立ち絵<br>（仮）</div>
  <section class="dialogue dialogue--bubble" aria-label="キィニチのセリフ">
    <p id="bubble-text" class="line" role="status">…</p>
    <div class="dialogue-foot">
      <span id="audio-status" class="sr-only">未再生</span>
      <button id="play-voice" type="button" class="voice">▶ 声を聞く</button>
    </div>
  </section>
</div>
```

- `.stage--side`：`flex: 1 1 auto; min-height: var(--stage-min-h); display: flex; align-items: flex-end; gap: var(--space-3);`（中身は下揃え。舞台の上部は空きになる）
- `.stage--side .portrait`：`flex: 0 0 34%; aspect-ratio: 3 / 4; max-height: var(--portrait-max-h);`、枠は四辺とも破線、角丸 `--radius-l`。
- `.dialogue--bubble`：`flex: 1;`、面と角丸は A の `.dialogue` と同じ（暗い面。V3-06）。左側に立ち絵を指すしっぽ（`::before`、色は `--color-scrim`、大きさは `--space-2`）。名前欄は付けない。

**Q3（時計）**

- 28px：見出し行を横 1 行にする（時刻 `--fs-title1` 太字＋日付 `--fs-subhead` `--color-text-secondary`、`align-items: baseline`）。
- 51px：時刻（`--fs-display` 太字）と日付を縦に並べ、中央に寄せる。Q1 推奨の設定アイコンは、見出し行の右上に重ねて置く。

- 受け入れ条件（A・B 共通）：
  - `test_home_fits_without_scrolling`：§4 の 3 機種（セーフエリア込み）で `scrollHeight <= innerHeight`。`#play-voice` は高さ 44px 以上で、上端の y が `innerHeight / 2` より大きい。記録ボタンのラベルが 1 行に収まる。
  - 3 秒以内表示の既存テストが通る。
  - 時計の computed `font-size` が Q3 の回答（28px または 51.2px）と一致する。
  - DOM の順番が「見出し行 → 舞台 →（A のみ会話ウィンドウ）→ 次の予定の帯 → 記録」。
  - Q6 で「追従する」の場合：`html` の文字を 34px（200%）にしても、ホームの要素が切れず、スクロールですべて見られ、タブバーと重ならない（`test_home_large_text_not_clipped`）。
  - 配置は `images/compare_home.png` の右側（A 配置の見本）を参考にしてよい。色・文言は本指示書に従う。

### T04 タブとナビゲーション（Q1 の回答後）

**Q1 = 推奨（5 個＋右上のアイコン）**

- タブを 5 個（ホーム・予定・タスク・タイマー・日報）にする。各タブにオリジナルの線画 SVG（`--size-icon`、`stroke: currentColor; stroke-width: 1.8; fill: none`）と、`--fs-caption2` のラベルを付ける。見本の SVG を使ってよい（単純な図形で、特定の製品のアイコンを写していない）— I2-02, M3-01
- タブバー：`height: calc(var(--tabbar-h) + var(--safe-bottom)); padding-bottom: var(--safe-bottom);`、背景 `--color-bg-deep`。非選択は `--color-text-tertiary`、選択中は accent＋太字＋線幅 2.2（I2-03）。
- `showView()` で `.active` クラスの代わりに `aria-current="page"` を付け外しする。`VIEWS` には `settings` を残す — I2-03
- ホームの見出し行の右に設定ボタン：`<a class="icon-btn" href="#settings" data-view="settings" aria-label="設定">`（44×44px、スライダー型の線画アイコン、色は `--color-text-secondary`）。歯車は簡略化すると太陽に見えるため使わない — P2-02
- 設定画面の先頭に `<header class="sub-header"><a href="#home" class="back">‹ ホーム</a><h1>設定</h1></header>`。戻るリンクは `--color-text-secondary` — I2-04
- 受け入れ条件：`.tabbar a` が 5 個。ホームで `.tabbar a[data-view=home]` が `aria-current="page"`。右上のアイコンで設定が開き、「‹ ホーム」で戻れる。

**Q1 = 別案（6 個のまま）**

- 設定を含む 6 個のタブにする。アイコン・色・`aria-current` は上と同じ（設定のアイコンはスライダー型）。見出し行のアイコンと「‹ ホーム」は作らない。
- 受け入れ条件：`.tabbar a` が 6 個。ホームで `.tabbar a[data-view=home]` が `aria-current="page"`。設定タブで設定が開く。

**どちらの場合も**

- 設定画面と初回導線の「合言葉（APP_TOKEN）」を「合言葉」にする — C8-04

### T05 セリフの選び方と spec.md（Q4 の回答後）

1. Q4 = 出す：`data/dialogue_template.yaml` に `idle_greeting` を `evening_suggestion` の前に追加する（ユーザーが直した文言。直しがなければ §5 の仮案）。`python3 scripts/build_dialogue.py` で JSON を作り直す — C8-03
2. Q4 = 出す：`docs/spec.md` の「トリガーと返答方式」の表に次の行を追加する（spec.md が知識ベースより上位のため。C1-01）。
   - `| ホームを開いたとき | 通知のセリフ・記録の反応がない | セリフ集（idle_greeting）。画面に出すだけで、通知はしない |`
3. `app/app.js`：
   - `periodOf(now)`：morning 5–9 時 / day 10–16 時 / evening 17–21 時 / night 22–4 時（C9-01）。`tick()` で `document.body.dataset.period` を更新する（値が変わったときだけ書き換える）。
   - `pickLine(key, { index } = {})`：候補の配列から 1 つ選び、`{ text, index }` を返す。
     - `index` が整数かつ範囲内なら、その候補を選ぶ（C5-05）。
     - それ以外は、候補が 2 本以上なら、そのキーで直前に出したものを除いてランダムに選ぶ（C1-02）。キーごとに直前のセリフを覚えておく。
   - `showLine(key, { index, ready = false } = {})`：セリフを `#bubble-text` に表示し、`ready` に応じて `#play-voice` の `.ready` を付け外しする。表示できたら `true`。
   - `showIdle(now)`：Q4 = 出すなら `showLine('idle_greeting.' + periodOf(now))`。出さない、または表示できなければ「…」を出し、`.ready` を外す。
   - URL の `line` は `params.has('line')` のときだけ数値にする（`Number(null)` は 0 になるため、`has` を確かめずに変換しない）。
   - 開いたときの処理を `applyOpenParams(params)` にまとめる：`trigger` があり `showLine(trigger, { index: line, ready: source === 'webpush' })` が成功したらそのまま（通知から開いた状態は T08 で足す）。そうでなければ `showIdle()`。
   - 「（ここにセリフが出ます）」は廃止する — C1-01, I4-02
- 受け入れ条件：
  - Q4 = 出す：7 時・13 時・19 時・23 時に開くと、それぞれの時間帯の候補のどれかが出て、`body[data-period]` が morning / day / evening / night、`#play-voice` に `.ready` が付かない（`test_idle_line_follows_time_of_day`）。
  - Q4 = 出さない：トリガーなしで開くと「…」が出る（`test_home_shows_ellipsis_without_trigger`）。
  - 同じキーを 2 回続けて選ぶと、候補 2 本以上なら違う文になる（`test_line_is_not_repeated`。`page.evaluate` で `pickLine` を直接呼んでよい）。
  - `?source=webpush&trigger=work_start.default&line=1` で 2 本目が出る。`line=9` では候補のどれかが出る（`test_notification_line_param_is_used`）。
  - `tests/test_dialogue.py` が通る。

### T06 「声を聞く」の状態表示

1. ボタンの中身を `<svg 再生の三角 aria-hidden="true"/> <span class="voice-label">声を聞く</span>` にし、HTML の初期値を `data-state="idle"` にする。
2. 状態は知識ベース C2-02 の表どおり（`idle`「声を聞く」/ `playing`「再生中」/ `ended`「もう一度聞く」/ `error`「再生できません」）。`setVoiceState(state)` で `data-state` とラベルを一緒に変える。
   - `showLine()` は、セリフを表示するたびに `setVoiceState('idle')` を呼ぶ（新しいセリフが出たのに「もう一度聞く」のまま、を防ぐ）。
   - 音声の `playing` → `playing`、`ended` → `ended`、`play()` の失敗 → `error`。`error` で押すと再試行する。
3. `#audio-status` は `.sr-only` の読み上げ専用にする。既存の `setText()` は `className` を上書きして `.sr-only` を消してしまうので、音声の状態は専用の関数で、文言と `classList` の `ok` / `ng` だけを変える（文言は今と同じ「再生中」「再生完了」「再生失敗: …」）— I4-02
4. 見た目（V3-08）：
   - 通常：背景なし、`border: 1px solid var(--color-border)`、文字 `--color-text`、`min-height: var(--tap)`、角丸 `--radius-pill`、`--fs-subhead` 太字、アイコン `--size-icon-s`。金は使わない。
   - `.ready`：accent の塗り＋`--color-on-accent`（主ボタン。T08）。
   - `playing`：背景 `--color-accent-soft`、枠 accent、文字 `--color-text`（CSS では `.ready` より後に書き、再生中はこちらの見た目にする）。
   - `error`：文字と枠を `--color-danger`。
5. 再生が終わったら `.ready` を外す。T08 で、この処理から `endNotificationState()` も呼ぶようにする。
- 受け入れ条件：
  - 既存テスト `test_one_tap_plays_audio_after_opening_from_notification` が変更なしで通る。
  - 通知から開いて再生 →「もう一度聞く」→ 記録ボタンを押して新しいセリフが出ると「声を聞く」・`data-state="idle"` に戻る（`test_voice_label_resets_on_new_line`）。

### T07 送信ページ：本文＝セリフ、URL に `line`

1. `app/send.js` は読み込み時に `data/dialogue.json` を取得する。送信のクリック処理では、取得の完了を待ってから送信内容を作る。
2. `buildWebPushRequest(minutes, now, trigger, dialogue)`：`trigger` が選ばれていて候補が見つかったら、
   - 候補からランダムに 1 つ選び、URL に `&line=<番号>` を付ける（0 始まり）。
   - 本文 `body` をそのセリフにする（予約のときは今と同じく末尾に「（予定 HH:MM:SS）」を足す）。
   - タイトルは `キィニチ（テスト）`（検証ページの送信だと分かるように。フェーズ2の本番の通知は「キィニチ」。C5-04）。
   - 候補が見つからないときは、今の動作（「（テスト）種類名」、`line` なし）のままにする。
3. ntfy の送信部分は変えない（D-009）。
- 受け入れ条件：`test_send_page_web_push_calls_worker_with_token` で、声掛けの種類「食事の時間を過ぎた」の送信内容の URL が `?source=webpush&trigger=midday_check.meal_overdue&line=0` で終わり、本文が「そろそろ飯の時間、過ぎてるぞ。」になる（§4 の変更内容）。

### T08 主ボタンは 1 つ、通知から開いた状態（Q7 の回答後）

1. `data-hours`（T03 で付けた「4-11」「7-13」）は仮決定。D-019 に記録する（C4-06）。
2. `markPrimary(now)`（C4-02）：
   - `body.from-notification` があるときは、記録ボタンを主にしない。
   - Q7 = 保存する：記録済み（`.done`）でない記録ボタンのうち、今の「時」が `data-hours` に入る最初の 1 つだけに `.primary`（金の塗り）を付け、ほかからは外す。`data-hours` が無いボタンは主にしない。
   - Q7 = 保存しない：記録ボタンには `.primary` を付けない。
   - 呼ぶ時：開いたとき（T05 の処理の後、T10）、記録したとき・取り消したとき（T09）、再生が終わったとき（T06）、時計の更新で「時」が変わったとき。
3. 通知から開いた状態（C5-03）：`applyOpenParams()` で `source=webpush` かつ `trigger` のセリフを表示できたときだけ `startNotificationState()` を呼ぶ。
   - `body.from-notification` を付け、`#play-voice` に `.ready` を付け、`markPrimary()` を呼ぶ。
   - `source=ntfy` は対象外（D-009 のとおり PWA では開かない）。
   - `endNotificationState()`：`body.from-notification` と `.ready` を外し、`markPrimary()` を呼ぶ。再生が終わったとき（T06 の手順 5 の処理に呼び出しを足す）と、T10 の判定で使う。
4. 見た目：`body.from-notification .dialogue { border-color: var(--color-accent); }`。`body.from-notification button.voice.ready` に `box-shadow` の脈動を 2 回（影の色は `--color-accent-glow`）。`prefers-reduced-motion` では止める — I3-04
5. 記録ボタンを押したときの反応のセリフは `ready: false` で表示する（主ボタンが 2 つになるのを防ぐ）。
6. 記録ボタンの見た目：通常は `--color-surface-2` の面、`--color-text`、`border: 1px solid var(--color-border)`。`.primary` は accent の塗り＋`--color-on-accent`。
- 受け入れ条件（`test_only_one_primary_action`）：
  - Q7 = 保存する：7:12 に開くと `.act.primary` は 1 個で「起きた」。11:30 に開くと「仕事開始」。
  - Q7 = 保存しない：7:12 に開くと `.act.primary` は 0 個。
  - どちらでも：12:41 に `?source=webpush&trigger=midday_check.meal_overdue&line=0` で開くと `.act.primary` は 0 個、`#play-voice` は `.ready`、`body` は `.from-notification`。
  - `test_accent_usage_on_home`（V3-08）が通る。

### T09 記録の完了表示・取り消し・当日分の保存（Q7 の回答後）

1. 未記録のボタンを押したとき：
   - 押す前のセリフを覚えておく。
   - `showLine(btn.dataset.trigger, { ready: false })` で反応のセリフを出す。
   - ボタンに `.done` を付け、文字を `✓ 起きた 07:12`（`✓ ` ＋ `data-label` ＋ 時刻）に変える。`.done` の見た目は背景なし・文字 `--color-success`・破線の枠、文字は `--fs-subhead`（1 行に収めるため）。
   - Q7 = 保存する：記録を保存する（手順 4）。
   - `markPrimary()` を呼び、トーストを出す（手順 3）。
2. 記録済みのボタンを押したとき：新しい記録はしない。そのボタンのトーストをもう一度 5 秒出す（I3-02）。
3. トースト `#toast`：「「起きた」を記録しました」と「取り消す」ボタン（44px 以上）を 5 秒出す — I3-02, I1-01
   - 位置：`position: fixed;` で記録ボタンの真上。`bottom: calc(var(--tabbar-h) + var(--safe-bottom) + var(--space-4) + var(--size-record) + var(--space-2));`
   - 見た目：面 `--color-surface-2`、枠 `--color-border`、影 `--shadow-raised`、文字 `--fs-subhead`。「取り消す」は背景なし、文字 `--color-text`、太字、下線（金は使わない。V3-08）。
   - トーストを出している間に別の記録ボタンを押したら、前の記録はそのまま確定し、トーストは新しい記録のものに置き換える。
   - 「取り消す」を押したら：ボタンを元に戻し（`.done` を外し、文字を `data-label` に）、保存した記録を消し、トーストを消し、`markPrimary()` を呼ぶ。押した直後のトーストからの取り消しで、セリフがまだ反応のセリフのままなら、押す前のセリフに戻し、`setVoiceState('idle')` を呼ぶ。手順 2 で出し直したトーストからの取り消しでは、セリフは変えない。
4. 保存（Q7 = 保存する）：
   - `localStorage` のキー `records.today` に `{"date":"YYYY-MM-DD","items":{"wake":"07:12"}}` の形で保存する（日付は端末の日付。`items` のキーは `data-record`）。読み書きは `try/catch` で囲み、失敗しても画面は動かす。
   - 開いたとき・日付が変わったときに読み込み、記録済みのボタンを `.done` にする（日付が今日でなければ空として扱う）。
   - 正式なデータ構造はフェーズ2で決める。コードに「仮の保存（D-019）。フェーズ2で置き換える」とコメントする。
   - 記録による通知予約の取り消し（D-015）はフェーズ2。今は行わない。
5. Q7 = 保存しない：手順 4 は行わない。記録済みの表示はページを開いている間だけ（コメントに「保存はフェーズ2」）。
- 受け入れ条件：
  - 7:12 に「起きた」を押すと「✓ 起きた 07:12」とトーストが出る。「取り消す」で元に戻り、トーストが消え、セリフが押す前のものに戻る（`test_record_shows_done_state_and_can_be_undone`）。
  - 記録済みのボタンを押すとトーストが再び出る（`test_tapping_done_button_reopens_undo`）。
  - Q7 = 保存する：押してから読み込み直しても記録済みのまま。翌日の日付で開くと未記録（`test_record_persists_for_today`）。

### T10 「開いたとき」の判定し直しと、通知タップの補い

1. 表示の復帰（P1-11、知識ベース §7「開いたとき」）：
   - `const RESUME_REFRESH_MS = 10 * 60 * 1000; // 仮決定（D-019）`
   - `visibilitychange` で `hidden` になった時刻を覚え、`visible` に戻ったら `onResume(裏にあった時間)` を呼ぶ。`pageshow` で `event.persisted` が真のときも `onResume(Infinity)` を呼ぶ。
   - `onResume(away)`：
     - Q7 = 保存する：記録を読み直し、表示に反映する（T09 の手順 4）。
     - `away >= RESUME_REFRESH_MS` のとき：`endNotificationState()`、`showIdle(now)`。
     - 常に：`periodOf` を反映し、`markPrimary(now)`。
2. 時計の更新 `tick()`：
   - 時計と次の予定は、表示が変わるとき（分が変わったとき）だけ書き換える（P3-04）。
   - 「時」が変わったら `markPrimary(now)`。日付が変わったら記録を読み直す（Q7 = 保存する）。
3. 通知タップの補い（P1-12）：`app/sw.js` の `notificationclick` で、開いている画面があるとき、
   - `await c.focus()` の後、`c.navigate(url)` を試す。例外、または戻り値が `null` なら、`c.postMessage({ type: 'open-url', url })` を送る。
   - 開いている画面がなければ、今と同じく `clients.openWindow(url)`。
4. 画面側：`navigator.serviceWorker` の `message` で `type === 'open-url'` を受けたら、セリフ集の読み込みを待ってから `applyOpenParams(new URL(data.url).searchParams)` を呼ぶ（T05・T08 と同じ処理）。`navigator.serviceWorker.startMessages` があれば呼ぶ。
- 受け入れ条件：
  - 7:12 に通知から開き、裏に回して 15 時間後に戻すと、`body[data-period=night]`、`body.from-notification` なし、`.ready` なし、セリフは夜の一言（Q4 = 出さないなら「…」）（`test_resume_after_long_hide_refreshes_home`）。
  - 裏にあったのが 5 分なら、セリフは変わらない（`test_short_hide_keeps_line`）。
  - `navigator.serviceWorker` に `open-url` のメッセージを送ると、通知から開いたときと同じ表示になる（`test_sw_message_fallback_applies_trigger`）。
  - Node：既存の「開いている画面があれば前面に出して移動する」テストが変更なしで通る。新しく「`navigate` が例外なら `postMessage`」「`navigate` が `null` なら `postMessage`」の 2 件が通る。

### T11 夜の配色（Q5 の回答後）

- Q5 = 暗くする：`body[data-period="night"] { --color-bg: #142c24; --color-surface-1: #1f3a30; --color-surface-2: #29473b; --color-bg-deep: #0f221b; }`
  - `--color-bg-deep` も下げて、タブバーが背景より暗い関係を保つ（C9-02）。
  - `python3 scripts/contrast_check.py` を実行し、夜の値も基準を満たすことを確かめ、`docs/design.md` のコントラスト表を更新する（夜の想定値は知識ベース §2.4）。
- Q5 = 変えない：このタスクは行わない（`body[data-period]` は T05 で付いているので、そのままでよい）。
- 受け入れ条件（Q5 = 暗くする）：23:48 に開くと `body[data-period=night]` で、`body` の computed `background-color` が `rgb(20, 44, 36)`。`test_style.py` が通る。

### T12 仕上げ

1. `APP_VERSION` と `CACHE_VERSION` を同じ値（`phase1-v6`）に上げる。
2. 着手前に書いた D-019 の内容が、実装と合っているか確かめる。実装中に変えたことがあれば、D-019 は上書きせず、D-020 として理由とともに追記する。
3. `docs/roadmap.md` のホーム画面タスクに、実装済みの内容と §6 の実機確認手順を追記する。
4. `NEEDS_HUMAN.md` に H-013 を書いていた場合は「完了」にする（削除しない）。
5. `CLAUDE.md` のドキュメント一覧は T01・T02 で更新済みであることを確かめる。

---

## 4. テストの変更と追加

自動テストはヘッドレス Chrome で動く。時刻は `page.clock.install()` で固定する（Playwright 1.45 以降）。

テスト用の補助（`tests/test_pwa.py`）：

- 時刻と画面の大きさを決めて開く `clock_page(hour, minute, query="", size=(393, 852), safe=None)`。`safe=(上, 下)` を渡したら、読み込み後に `page.add_style_tag(content=":root{--safe-top:%dpx;--safe-bottom:%dpx}")` でセーフエリアを模す。
- 機種の値：`(375, 667)` は `safe=(20, 0)`、`(393, 852)` と `(430, 932)` は `safe=(59, 34)`（知識ベース V4-02）。
- 裏に回す操作の模し方：初期化スクリプトで `Object.defineProperty(Document.prototype, 'visibilityState', { configurable: true, get() { return window.__vis || 'visible'; } })` を定義する。`window.__vis = 'hidden'` にして `visibilitychange` を発火 → `page.clock.fast_forward(...)` → `'visible'` に戻して再び発火。

変更が必要な既存テスト：

| テスト | 理由 | 変更内容 |
| --- | --- | --- |
| `test_record_button_shows_template_line` | 「（ここにセリフが出ます）」がなくなる。「仕事開始」の文字は次の予定の帯にも出る | 待ち条件を「セリフ集を読み込んだ（`dialogue !== null`）」に変える。押すボタンは `.act[data-record=work_start]` で指定する |
| `test_tabbar_switches_views` | Q1 でタブの構成が変わる | Q1 = 推奨：タブ 5 個・`aria-current` を確かめ、設定は `.home-header a[data-view=settings]` から開き、`#view-settings .back` で戻る。Q1 = 別案：タブ 6 個・`aria-current` を確かめ、設定はタブから開く |
| `test_send_page_web_push_calls_worker_with_token` | 送信内容に `line` とセリフが入る（T07） | 2 回目の送信内容の URL が `?source=webpush&trigger=midday_check.meal_overdue&line=0` で終わり、本文が「そろそろ飯の時間、過ぎてるぞ。」 |

変更しない既存テスト（そのまま通ること）：`test_one_tap_plays_audio_after_opening_from_notification`、`test_opened_from_notification_shows_that_triggers_line`、`test_home_shows_clock_next_event_and_portrait_within_3_seconds`、`tests/test_dialogue.py`、Node の既存 17 件。

追加するテスト：

| テスト | 確認すること | 回答 | ルール |
| --- | --- | --- | --- |
| `test_style.py::test_contrast_check_passes` | コントラスト確認スクリプトが終了コード 0 | 全部 | V3-01 |
| `test_style.py::test_css_uses_tokens` | トークン以外の生の値がない | 全部 | M2-01 |
| `test_home_fits_without_scrolling` | 3 機種（セーフエリア込み）ではみ出さない。`#play-voice` が 44px 以上で下半分。記録ボタンのラベルが 1 行（SE の幅で、記録した後の「✓ 仕事開始 09:03」も） | 全部 | V4-02, I1-01, I1-02, I4-04 |
| `test_clock_size_matches_decision` | 時計の文字が 28px または 51.2px | Q3 | V1-02 |
| `test_home_large_text_not_clipped` | `html` 34px でも切れず、スクロールで全部見られ、タブバーと重ならない | Q6 = 追従 | V2-08, P2-03 |
| `test_inputs_are_16px_or_larger` | 設定の入力欄が 16px 以上 | 全部 | V2-04 |
| `test_idle_line_follows_time_of_day` | 7 / 13 / 19 / 23 時の一言が候補内、`body[data-period]` が正しい、`.ready` なし | Q4 = 出す | C1-01, C9-01 |
| `test_home_shows_ellipsis_without_trigger` | トリガーなしで「…」 | Q4 = 出さない | C1-01 |
| `test_line_is_not_repeated` | 同じキーで続けて同じ文にならない | 全部 | C1-02 |
| `test_notification_line_param_is_used` | `line=1` で 2 本目、範囲外は候補のどれか | 全部 | C5-05 |
| `test_voice_label_resets_on_new_line` | 新しいセリフで「声を聞く」・`idle` に戻る | 全部 | C2-02 |
| `test_only_one_primary_action` | T08 の受け入れ条件 | Q7 | V3-02, C4-02, C5-03 |
| `test_accent_usage_on_home` | 下の判定方法 | 全部 | V3-08 |
| `test_record_shows_done_state_and_can_be_undone` | 完了表示とトースト、取り消しで元に戻る（セリフも） | 全部 | I3-02 |
| `test_tapping_done_button_reopens_undo` | 記録済みを押すとトーストが再び出る | 全部 | I3-02, C6-01 |
| `test_record_persists_for_today` | 読み込み直しても記録済み、翌日は未記録 | Q7 = 保存 | C6-01 |
| `test_next_event_shows_tomorrow_after_last_item` | 23:48 に「明日」「07:00」「起床」と「あと7時間12分」 | 全部 | C7-03 |
| `test_resume_after_long_hide_refreshes_home` | T10 の受け入れ条件 | 全部 | P1-11 |
| `test_short_hide_keeps_line` | 5 分ならセリフは変わらない | 全部 | P1-11 |
| `test_sw_message_fallback_applies_trigger` | `open-url` のメッセージで通知から開いた表示になる | 全部 | P1-12 |
| `sw.test.mjs`：navigate が例外なら postMessage | `{ type: 'open-url', url }` が送られる | 全部 | P1-12 |
| `sw.test.mjs`：navigate が null なら postMessage | 同上 | 全部 | P1-12 |

`test_accent_usage_on_home` の判定方法：

- 7:12（通常）に `#view-home` と `.tabbar` の中の全要素を調べる。
  - computed `background-color` が accent（`rgb(232, 196, 92)`）の要素は、ちょうど 1 個（Q7 = 保存しないなら 0 個）。
  - computed `color` または枠の色（4 辺のどれか）が accent の要素は、次を除いて 0 個：`.nameplate`、`.tabbar a[aria-current]` とその中身、背景が accent の要素自身の枠。
- 12:41 に通知から開いた状態では、背景が accent の要素は `#play-voice` だけ。枠が accent の要素は、`.nameplate`・`.dialogue`・`#play-voice` を除いて 0 個。

`tests/test_dialogue.py`（YAML と JSON の一致）は、T05 で JSON を作り直せばそのまま通る。

---

## 5. 時間帯の一言（仮案・ユーザー確認用）

既存のセリフ（「〜だな」「〜しておけ」「〜か」、称賛しない、提案で終える）と、知識ベースの C8-02・C8-05〜07・C9-03 に合わせた仮案。一人称は使っていない。ユーザーの修正を優先すること。

```yaml
idle_greeting:
  description: "ホームを開いたとき、通知のセリフや記録の反応がなければ出す時間帯の一言（仮案。ユーザー確認待ち）"
  conditions:
    - id: morning
      when: "5:00〜9:59"
      lines:
        - "朝か。今日の予定、先に目を通しておけ。"
        - "起きたなら、まず水でも飲んでおけ。"
    - id: day
      when: "10:00〜16:59"
      lines:
        - "急ぎの用がなければ、こっちは黙っておく。"
        - "次の予定まで、自分のペースで進めればいい。"
    - id: evening
      when: "17:00〜21:59"
      lines:
        - "そろそろ一日の締めだな。"
        - "夕方か。残りは無理のない分だけでいい。"
    - id: night
      when: "22:00〜4:59"
      lines:
        - "夜だな。続けるか休むかは、自分で決めればいい。"
        - "遅い時間だ。無理はするなよ。"
```

改訂1の仮案から変えたもの：

| 改訂1の仮案 | 変えた理由 |
| --- | --- |
| 用があれば呼べ。ここにいる。 | 今は呼ぶ手段がない（C8-06） |
| 進み具合はどうだ。無理はするなよ。 | 返事の手段がない問いかけ（C8-05） |
| そろそろ一日の締めだな。残りは何だ。 | 後半が返事できない問いかけ（C8-05） |
| 飯は済んだか。まだなら先に食っておけ。 | 記録を見ずに食事を促している（C8-07。spec の「日中は基本は干渉しない」） |
| まだ起きてるのか。明日に響くぞ。 | 仮の予定では 22 時台はまだ起きている時間（C9-03）。責める調子（C3-01） |
| 今日はもう休め。続きは明日でいい。 | 休むかどうかの判断を本人に返していない（C8-02, spec の「最終判断を断定しない」） |

ユーザーが直すときの目安：1 文 30 字前後・1 回 2 文まで（V2-07）。問いかけない（C8-05）。記録や進捗を知っているように言わない（C8-06）。食事・休憩・就寝を促さない（C8-07）。

---

## 6. 実機確認手順（roadmap に追記する文面の案）

1. ホーム画面のアプリを上スワイプで終了してから開き直す → 設定を開き（Q1 = 推奨なら右上のアイコン、別案なら設定タブ）、「版：phase1-v6」を確認 → ホームに戻る（Q1 = 推奨なら「‹ ホーム」）。
2. ホームを 5 秒だけ見て閉じる →「キィニチの今のセリフ」「次の予定とあと何分か」「今押すボタン」の 3 つを言えるか（参考程度。言えなければ伝える）。
3. 片手（親指だけ）で「声を聞く」「記録ボタン」「タブ」をすべて押せること。
4. 朝（10 時前）に開く →（Q7 = 保存するなら）「起きた」だけが金色。押す → ボタンが「✓ 起きた HH:MM」に変わり、上に「取り消す」が 5 秒出る →「取り消す」で元に戻り、セリフも押す前に戻る。
5. もう一度「起きた」を押す → アプリを上スワイプで終了して開き直す →（Q7 = 保存するなら）「✓ 起きた HH:MM」のまま。記録済みのボタンを押すと「取り消す」が再び出る。
6. 送信ページ（…/app/send.html）の「Web Push で送る」で「食事の時間を過ぎた」「今すぐ」を送る → **アプリを上スワイプで終了した状態で**通知をタップ → 通知の本文と同じセリフが出て、セリフの面が金の枠になり、「声を聞く」だけが金色。押すと「再生中」→「もう一度聞く」に変わり、テスト音が鳴る。
7. 手順 6 と同じ送信をもう一度行い、今度は**アプリを開いたままホーム画面に戻った状態（裏に残した状態）で**通知をタップ → 手順 6 と同じ表示になること（ならなければ、どう表示されたかを伝える）。
8. アプリを開いたまま 10 分以上ホーム画面に置いてから開く → 金の枠が消え、今の時間帯の一言（Q4 = 出さないなら「…」）になっている。朝に開いて夜に見るなど、時間帯をまたいで確かめられるとよりよい。
9. 夜（22 時以降）に暗い部屋で開く →（Q5 = 暗くするなら）背景が一段暗く、眩しくないか。
10. 設定の合言葉欄をタップ → 画面が拡大されないこと。
11. iPhone の「設定 → アクセシビリティ → 動作 → 視差効果を減らす」をオンにして手順 6 → 「声を聞く」の脈動が出ないこと。
12. （Q6 = 追従する場合）iPhone のテキストサイズを大きくして開く → 文字が大きくなり、切れずにスクロールで全部見られること。
13. 気になった点（文字の大きさ・眩しさ・押しにくさ・セリフの言い回し）を伝える → D-019 を確定にする。

---

## 7. 後続フェーズへの申し送り

本指示書の範囲外だが、同じ原則で作ること。

- **予定・タスク・タイマー・日報の各画面**：画面上部にタイトル（`--fs-title3`）、主な操作は画面下部に 1 つだけ金の塗り（V3-02, I1-02）。一覧の行は高さ 52px 以上で、行全体を押せるように（I1-01）。空の状態にはキャラクターの一言を出す（C1-01）。
- **記録ボタンを増やすとき**（食事・休憩・入浴・歯磨きなど）：ホームに同時に出すのは 3 個まで（I4-04）。その時間帯に関係するものだけを出し、それ以外は「ほかの記録」ボタンから開く一覧で扱う。
- **記録ボタンの受付時間帯と時間帯の区分**：フェーズ2以降は予定（起床・就寝予定など）から決める（C4-06, C9-03）。spec の「起床予定時刻との差で早い／定刻／遅いに分岐」（今は常に `on_time`）もこのときに入れる。
- **記録の保存**：Q7 = 保存するの場合、フェーズ2のデータ構造を決めるときに `records.today` から移すか捨てるかを決める。記録したら通知の予約を取り消す（D-015）。
- **通知の予約（フェーズ2、D-015）**：本文はセリフそのもの、タイトル「キィニチ」、URL は `?source=webpush&trigger=<キー>&line=<番号>`（C5-04, C5-05）。同一トリガーの再通知は 1 回まで（C5-02）。
- **今日の調子（疲労度 3 段階）**：朝の「起きた」の後、セリフの面の中に選択肢ボタン 3 つ（例「良い」「普通」「しんどい」）として出す。専用の入力画面は作らない（C2-05, C6-03）。文言はユーザー確認。
- **立ち絵が用意できたら（H-005 関連）**：透過 WebP（または PNG）、縦横比 3:4、長辺 1,200px 以下（P3-03）。A 配置では足元が会話ウィンドウに 32px 重なる前提で、下端に余白を作らない。表情差分はセリフ集の `expression` で切り替える（C2-03）。公式素材は使わない（M3-01）。
- **セリフ集の拡充**：各条件 3 本以上を目標に（C1-03）。変更は YAML → JSON の作り直し（C8-03）。C8-05〜07 に反しないこと。

---

## 8. 見本（reference_impl）との差分

見本は改訂1の指示書で作ったため、次の点が改訂2と違う。見本を使う場合は、右の列のとおりに直すこと。

| 項目 | 見本 | 改訂2（本指示書） |
| --- | --- | --- |
| CSS の生の値 | `52px`, `48px`, `520px`, `420px`, `160px`, `6px`, `4px`, `0.6875rem`, `rgba(...)` などを直書き（30 か所ほど） | トークンを経由（T02、`test_css_uses_tokens`） |
| セーフエリア | `env(safe-area-inset-*)` を直書き | `--safe-top` / `--safe-bottom` |
| 「声を聞く」の通常時 | 金の枠＋金の文字 | 金を使わない（V3-08） |
| 舞台のぼかし | 金（`--color-accent-soft`） | `--color-stage-glow`（金にしない） |
| 新しいセリフが出たときの「声を聞く」 | 「もう一度聞く」のまま | `idle`「声を聞く」に戻す（C2-02） |
| 初期の `data-state` | なし | `idle` |
| 通知から開いた判定 | `webpush` と `ntfy` | `webpush` だけ（D-009） |
| 通知の URL の `line` | なし | あり（T05, T07, C5-05） |
| 送信ページの本文 | 「（テスト）種類名」 | セリフそのもの（T07） |
| 裏から戻ったとき | 何もしない | 判定し直す（T10, P1-11） |
| 通知タップの移動の失敗 | 黙って捨てる | `postMessage` で補う（T10, P1-12） |
| 記録済みの保存 | なし | Q7 に従う（T09） |
| 記録済みのボタンを押す | 何も起きない | 「取り消す」を出し直す（T09） |
| 取り消したときのセリフ | 反応のセリフのまま | 押す前のセリフに戻す（T09） |
| トーストの「取り消す」 | 金の文字 | `--color-text`・下線（V3-08） |
| `data-hours` が無いボタン | 終日対象（`0-24` 扱い） | 主にしない（T08） |
| 主ボタンの判定し直し | 開いたとき・記録・再生終了のみ | 加えて「時」が変わったとき・裏から戻ったとき（T08, T10） |
| 次の予定の DOM | 毎秒作り直す | 表示が変わるときだけ（P3-04） |
| 「仮」タグ | `title` 属性で説明 | `title` なし（P1-13） |
| 時間帯の一言 | 改訂1の仮案 | §5 の改訂案（またはユーザーの修正） |
| 夜の配色 | `--color-bg-deep` を変えない | `--color-bg-deep` も暗くする（T11） |
| タブ 6 個・横並び配置・時計 51px・文字サイズ追従・保存しない | 見本にない | Q1〜Q7 の別案として T02〜T09 に記載 |
| コメント | 「ホーム右上の歯車から開く」 | 「設定アイコン」（歯車は使わない） |

`images/compare_*.png` も見本の画面なので、上の違い（特に「声を聞く」の色）は反映されていない。

## 9. 人間学習用教本との違い

人間学習用教本（ユーザー向けの解説）と違う場合は、本指示書と知識ベースに従う。

- 「声を聞く」の切り替え：教本は「▶ 声を聞く／■ 止める」。本指示書は「声を聞く／再生中／もう一度聞く／再生できません」で、止める機能は作らない（C2-02）。
- 記録後の表示：教本は「✓ 07:12 記録した」。本指示書は「✓ 起きた 07:12」。
- 立ち絵の大きさ：教本は幅 800px 程度。本指示書は長辺 1,200px 以下（P3-03）。
- 設定のアイコン：教本は歯車。本指示書はスライダー型。
- 基準の版：教本は `94222ca`。本指示書は `a143654`（その直後のテスト修正のみで、アプリの中身は同じ）。

## 10. 完了の定義

- §1 の回答が `docs/decisions.md` の D-019 に記録されている（未回答が残った場合は H-013 があり、回答に依存するタスクが未着手である）
- T01〜T12 のうち、回答で不要になったもの以外がコミット・push 済み
- `python3 -m unittest discover -s tests` と `node --test tests/worker.test.mjs tests/sw.test.mjs` がすべて通る
- `docs/spec.md`（Q4 = 出すの場合）と `docs/design.md` が更新されている
- `docs/roadmap.md` に §6 の実機確認手順があり、ユーザーに「版：phase1-v6」（または最後に push した版）で確認を依頼した

## 11. 改訂履歴

改訂2（2026-11-08）。独立レビューの指摘を反映した。

- 質問を 7 問にした（Q7 記録の保存を追加。Q2 に配置 B の具体案、Q6 に判断の材料を追加）。未回答のときに推奨案を採用する扱いをやめ、全問の回答の後に着手する形にした
- 「確認不要」としていた「声を聞く」・主ボタン・記録のタスクに、配置 A・B のどちらでも作れる指示を付けた
- 追加：通知の本文とセリフの一致（T05, T07）、裏から戻ったときの判定し直しと通知タップの補い（T10）、記録の当日分の保存（T09）、金の使い道のテスト、トークン化のテスト、コントラスト確認スクリプト（T02）、spec.md の更新（T05）
- 状態の移り変わりを決めた（「声を聞く」の状態表、取り消しの範囲、連続して押したとき、記録済みを押したとき）
- 仮の一言 8 本のうち 6 本を書き直した（§5）
- 実機確認に「アプリを裏に残した状態で通知をタップ」「10 分以上裏に置いてから開く」「終了して開き直しても記録済み」を追加した
- タスクを作業順に番号を振り直した（T01〜T06 は改訂1と同じ。改訂1の T07 → T08、T08 → T09、T09 → T11、T11 → T12。改訂1の T10「テスト」は各タスクに含めた。T07・T10 は新規）
- D-019 の記録を最後（改訂1の T11）から、回答直後・T02 の前に移した（知識ベースの【回答依存】ルールが参照できるように）
- 見本・教本との違いを §8・§9 に一覧にした
