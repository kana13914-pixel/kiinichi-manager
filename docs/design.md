# デザインの決まりごと

画面を作る・直すときの決まりごと。根拠のルールは `docs/ui_knowledge.md`（ルール ID 付き）にある。

## 画面の原則

1. **主役を一番強く**（V1-01）：各画面で最も目立つ要素を、その画面の主目的と一致させる。ホームの主役は「キャラクターとセリフ」。
2. **触るものは下半分**（I1-02）：通知から開いた直後に押す「声を聞く」と記録ボタンは、画面の下半分に置く。見るだけの要素（立ち絵・日付）は上半分。
3. **金の塗りは 1 画面に 1 つ、金の使い道は限定**（V3-02, V3-08）：金（`--color-accent`）の塗りは「今押すもの」1 つだけ。ほかに金を使ってよいのは、選択中のタブ、名前欄、フォーカスリング、通知から開いた直後のセリフの面の枠と脈動、再生中の「声を聞く」の枠に限る。
4. **状態は色以外でも示す**（V3-05）：未再生／再生中、未記録／記録済み、有効／失敗は、色に加えて文言・アイコン・形でも分かるようにする。
5. **開発用の文言を出さない**（I4-02）：「未再生」「フェーズ3〜4で追加」「（ここにセリフが出ます）」「APP_TOKEN」などは通常画面に出さない。確認用の情報は設定画面の「起動状態（確認用）」に限る。読み上げ専用の状態テキストは `.sr-only` で残してよい。
6. **裏から戻ったら判定し直す**（P1-11）：ホーム画面のアプリは再読み込みされずに再開されることが多い。表示に戻ったとき（`visibilitychange`／`pageshow`）に、セリフ・主ボタン・通知から開いた状態・記録済みの表示・時間帯を判定し直す。

## キャラクターの声とシステムの声

- **分ける**（C8-01）：「キャラクターの声」はセリフと通知の本文。「システムの声」はラベル・エラー・設定の説明で、「〜です／〜してください」で書く。キャラクターにエラーや通信状態を言わせない。
- **キャラクターの声の規則**（C8-02）：語尾は「〜だな」「〜しておけ」「〜か」「〜ぞ」など短く。命令形は小さな行動の提案までにとどめ、続けるか休むかなどの判断は本人に返す。称賛を重ねない。一人称は使わないか、ユーザーが定めたものだけ。
- **返事の手段がない問いかけをしない**（C8-05）：問いかけるのは、選択肢ボタンを同時に出すときだけ。
- **持っていない情報を知っているように言わない**（C8-06）：記録や進捗を見ずに「順調だな」と言わない。存在しない機能（「用があれば呼べ」など）を示さない。
- **時間帯の一言で特定の行動を促さない**（C8-07）：記録を確かめずに食事・休憩・就寝を促すのは、spec.md のトリガーのセリフの役割。
- セリフはすべて `data/dialogue_template.yaml` に書き、`python3 scripts/build_dialogue.py` で `app/data/dialogue.json` を作り直す（C8-03）。内容はユーザー確認の対象。

## 変更手順

- トークンの**値**の正本は `app/style.css` の `:root`（M2-02）。画面ごとに生の色コード・px・rem を書かない（M2-01）。
- トークンを追加・変更したら `python3 scripts/contrast_check.py` を実行し、その出力を本ファイルの「コントラスト表」に貼る。
- 新しい文字サイズや寸法が必要なときは、先にトークンを追加し、理由を本ファイルに書く（V2-01）。

## トークン表

値の正本は `app/style.css` の `:root`。役割の説明は `docs/ui_knowledge.md` §2。

| 名前 | メモ | 値 |
| --- | --- | --- |
| `--color-bg` |  | `#1e4034` |
| `--color-bg-deep` | タブバー・入力欄・名前欄の地 | `#163128` |
| `--color-surface-1` | カード・次の予定の帯 | `#2a4b3f` |
| `--color-surface-2` | 控えめなボタン・トースト | `#355749` |
| `--color-scrim` | セリフの面（bg に重ねると約 #0f221c） | `rgba(13, 31, 25, 0.9)` |
| `--color-text` |  | `#f4f1e8` |
| `--color-text-secondary` |  | `#c8d4cb` |
| `--color-text-tertiary` |  | `#adbfb3` |
| `--color-accent` | 使い道は V3-08 | `#e8c45c` |
| `--color-on-accent` |  | `#1e1e1e` |
| `--color-accent-soft` |  | `rgba(232, 196, 92, 0.14)` |
| `--color-accent-glow` |  | `rgba(232, 196, 92, 0.5)` |
| `--color-border` |  | `#7f9a8c` |
| `--color-border-subtle` |  | `rgba(244, 241, 232, 0.12)` |
| `--color-stage-glow` |  | `rgba(244, 241, 232, 0.06)` |
| `--color-success` |  | `#8fe3a5` |
| `--color-danger` | 旧 #ff9a8a はカード上 4.40:1 で不足 | `#ffb3a6` |
| `--font-sans` |  | `-apple-system, "Hiragino Sans", "Hiragino Kaku Gothic ProN", "Noto Sans JP", sans-serif` |
| `--fs-caption2` | 11 タブのラベル専用 | `0.6875rem` |
| `--fs-caption` | 12 | `0.75rem` |
| `--fs-footnote` | 13 | `0.8125rem` |
| `--fs-subhead` | 15 | `0.9375rem` |
| `--fs-callout` | 16 入力欄・既定 | `1rem` |
| `--fs-body` | 17 セリフ・本文 | `1.0625rem` |
| `--fs-title3` | 20 | `1.25rem` |
| `--fs-title1` | 28 | `1.75rem` |
| `--lh-tight` |  | `1.25` |
| `--lh-body` |  | `1.7` |
| `--space-1` |  | `4px` |
| `--space-2` |  | `8px` |
| `--space-3` |  | `12px` |
| `--space-4` |  | `16px` |
| `--space-5` |  | `24px` |
| `--space-6` |  | `32px` |
| `--radius-xs` |  | `4px` |
| `--radius-s` |  | `8px` |
| `--radius-m` |  | `12px` |
| `--radius-l` |  | `16px` |
| `--radius-pill` |  | `999px` |
| `--tap` |  | `44px` |
| `--size-record` |  | `52px` |
| `--size-btn-primary` |  | `48px` |
| `--size-icon` |  | `24px` |
| `--size-icon-s` |  | `16px` |
| `--portrait-max-h` |  | `420px` |
| `--stage-min-h` |  | `160px` |
| `--home-min-h` |  | `520px` |
| `--tabbar-h` |  | `56px` |
| `--blur-dialogue` |  | `6px` |
| `--shadow-raised` |  | `0 6px 24px rgba(0, 0, 0, 0.35)` |
| `--dur-fast` |  | `120ms` |
| `--dur-base` |  | `200ms` |
| `--ease-out` |  | `cubic-bezier(0.2, 0.8, 0.2, 1)` |
| `--safe-top` |  | `env(safe-area-inset-top, 0px)` |
| `--safe-bottom` |  | `env(safe-area-inset-bottom, 0px)` |

## コントラスト表

`python3 scripts/contrast_check.py` の出力（WCAG 2.x の相対輝度。`scrim` は `bg` に重ねた色で計算）。基準：文字 4.5、部品の枠 3.0（V3-01, V3-03）。

| 文字・部品 | 下地 | 基準 | 昼 |
| --- | --- | --- | --- |
| text | bg | 4.5 | 10.12 |
| text | surface-1 | 4.5 | 8.54 |
| text | surface-2 | 4.5 | 7.12 |
| text | scrim | 4.5 | 14.66 |
| text-secondary | bg | 4.5 | 7.47 |
| text-secondary | surface-1 | 4.5 | 6.31 |
| text-secondary | surface-2 | 4.5 | 5.26 |
| text-tertiary | bg | 4.5 | 5.92 |
| text-tertiary | surface-1 | 4.5 | 5.00 |
| text-tertiary | bg-deep | 4.5 | 7.23 |
| accent | bg-deep | 4.5 | 8.30 |
| on-accent | accent | 4.5 | 9.91 |
| success | bg | 4.5 | 7.45 |
| success | surface-1 | 4.5 | 6.29 |
| danger | surface-1 | 4.5 | 5.63 |
| danger | scrim | 4.5 | 9.66 |
| border | bg | 3.0 | 3.76 |
| border | surface-1 | 3.0 | 3.17 |
| border | scrim | 3.0 | 5.44 |
