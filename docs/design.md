# デザインの決まりごと

見た目の決まり（色・形・線・文字・地・装飾・動き）は `docs/visual_rules.md`（CR-*。D-021）を先に読む。

画面を作る・直すときの決まりごと。根拠のルールは `docs/ui_knowledge.md`（ルール ID 付き）にある。

## 画面の原則

1. **主役を一番強く**（V1-01）：各画面で最も目立つ要素を、その画面の主目的と一致させる。ホームの主役は「キャラクターとセリフ」。
2. **触るものは下半分**（I1-02）：記録ボタンは、画面の下半分に置く。見るだけの要素（立ち絵・日付）は上半分。
3. **金の塗りは 1 画面に 1 つ、金の使い道は限定**（V3-02, V3-08, CR-C02。金の細線は装飾として使ってよい）：金（`--color-accent`）の塗りは「今押すもの」1 つだけ。ほかに金を使ってよいのは、選択中のタブ、名前欄、フォーカスリング（斜めの部品では縁）、通知から開いた直後のセリフの面の上辺に限る（D-024）。
4. **状態は色以外でも示す**（V3-05）：未再生／再生中、未記録／記録済み、有効／失敗は、色に加えて文言・アイコン・形でも分かるようにする。
5. **開発用の文言を出さない**（I4-02）：「未再生」「フェーズ3〜4で追加」「（ここにセリフが出ます）」「APP_TOKEN」などは通常画面に出さない。確認用の情報は設定画面の「起動状態（確認用）」に限る。読み上げ専用の状態テキストは `.sr-only` で残してよい。
6. **裏から戻ったら判定し直す**（P1-11）：ホーム画面のアプリは再読み込みされずに再開されることが多い。表示に戻ったとき（`visibilitychange`／`pageshow`）に、セリフ・主ボタン・通知から開いた状態・記録済みの表示・時間帯を判定し直す。
7. **追加は区分の下の点線の欄**（I6-06, CR-G07。D-070 で「一覧の上の金のボタン」から変えた）：タスクは各優先度の見出しの下に「追加」の欄を置き、押した欄にフォームを開く。ふだんの画面に金の塗りは置かない。
8. **スクロールする画面はステータスバーの下に帯**（P1-14, CR-B04）：中身を時計・電池の表示の下に通さない。ホームには出さない。
9. **同じ並びの中で役割が違うものは見た目を変える**（V1-03, CR-G06）：予定のリストでは、毎日の時刻を控えめにして予定を浮かせる（行は詰めない）。

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

値の正本は `app/style.css` の `:root`。役割の説明は `docs/ui_knowledge.md` §2 と `docs/visual_rules.md`（CR-*。v7 で追加したもの）。

| 名前 | メモ | 値 |
| --- | --- | --- |
| `--color-bg` |  | `#183a2f` |
| `--color-bg-deep` | タブバー・入力欄・名前欄の地 | `#0a1512` |
| `--color-surface-1` | カード・次の予定の帯 | `#10231d` |
| `--color-surface-2` | 控えめなボタン・トースト | `#1a3229` |
| `--color-scrim` | セリフの面（bg に重ねると約 #0f221c） | `rgba(7, 15, 12, 0.9)` |
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
| `--color-success` |  | `#b9e35f` |
| `--color-danger` | 旧 #ff9a8a はカード上 4.40:1 で不足 | `#ffb3a6` |
| `--font-sans` |  | `-apple-system, "Hiragino Sans", "Hiragino Kaku Gothic ProN", "Noto Sans JP", sans-serif` |
| `--fs-caption2` | 11 タブのラベル専用 | `0.6875rem` |
| `--fs-caption` | 12 | `0.75rem` |
| `--fs-footnote` | 13 | `0.8125rem` |
| `--fs-subhead` | 15 | `0.9375rem` |
| `--fs-callout` | 16 入力欄・既定 | `1rem` |
| `--fs-body` | 17 セリフ・本文 | `1.0625rem` |
| `--fs-title3` | 20 | `1.25rem` |
| `--fs-title2` | 22 次の予定の時刻 | `1.375rem` |
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
| `--switch-w` | スイッチの溝の幅（CR-F07） | `52px` |
| `--switch-h` | スイッチの溝の高さ | `30px` |
| `--switch-knob` | スイッチのつまみ | `22px` |
| `--switch-gap` | 溝の端とつまみの間 | `4px` |
| `--size-record` |  | `52px` |
| `--size-btn-primary` |  | `48px` |
| `--size-icon` |  | `24px` |
| `--size-icon-s` |  | `16px` |
| `--portrait-max-h` |  | `420px` |
| `--stage-min-h` |  | `160px` |
| `--home-min-h` |  | `520px` |
| `--tabbar-h` |  | `56px` |
| `--color-field` | 入力欄・月のタグの地（CR-F01, CR-F04） | `rgba(244, 241, 232, 0.05)` |
| `--z-tabbar` | タブバーの重なり順（CR-F06） | `20` |
| `--size-ring` | タイマーの輪の直径（CR-G02） | `232px` |
| `--ring-w` | 輪の線の太さ | `3px` |
| `--size-mood` | 調子の印（CR-G03） | `14px` |
| `--size-mood-s` | 凡例の印 | `10px` |
| `--dur-quick` | 輪の書き換えの動き | `180ms` |
| `--blur-dialogue` |  | `6px` |
| `--shadow-raised` |  | `0 6px 24px rgba(0, 0, 0, 0.35)` |
| `--dur-fast` |  | `120ms` |
| `--dur-base` |  | `200ms` |
| `--ease-out` |  | `cubic-bezier(0.2, 0.8, 0.2, 1)` |
| `--color-bg-top` | 地のグラデーション上端 | `#1f4738` |
| `--color-bg-bottom` | 地のグラデーション下端（足元ほど黒） | `#0b1914` |
| `--color-ink` | いちばん奥の黒：タブバー・控えめボタンの地 | `#070f0c` |
| `--color-line` | 斜め角ボタンの縁。地の全域に 3:1 以上 | `#64897b` |
| `--color-gold-line` | 金の細線 | `rgba(232, 196, 92, 0.55)` |
| `--color-gold-faint` | 金のごく薄い線・縁取り文字 | `rgba(232, 196, 92, 0.18)` |
| `--color-lime` | 差し色（耳飾り）。面積は画面の 2% 以内 | `#b9e35f` |
| `--color-ember` | 差し色（ズボンの橙） | `#f2a14a` |
| `--color-sky` | 差し色（ズボン・ブーツの青） | `#62b8e0` |
| `--color-canopy-light` | 昼：樹冠から差す光 | `rgba(185, 227, 95, 0.12)` |
| `--color-ember-glow` | 夜：足元の火 | `rgba(242, 161, 74, 0.1)` |
| `--color-strip-from` |  | `rgba(7, 15, 12, 0.6)` |
| `--color-strip-to` |  | `rgba(7, 15, 12, 0.12)` |
| `--color-card` |  | `rgba(7, 15, 12, 0.55)` |
| `--bg-glow` |  | `radial-gradient(120% 55% at 50% -12%, var(--color-canopy-light), transparent 62%)` |
| `--tex-grain` |  | `url("img/grain.svg")` |
| `--size-grain` |  | `160px` |
| `--cut-s` |  | `6px` |
| `--cut-m` |  | `10px` |
| `--cut-l` |  | `14px` |
| `--cut-fix` | 斜めに落とす角の量 | `0.5px` |
| `--fs-display` | 48 時刻だけ大きく細く（ジャンプ率 約 2.8） | `3rem` |
| `--fs-mark` | 72 舞台の縦書き英字の上限 | `4.5rem` |
| `--track-label` | 英字の小見出しの字間 | `0.18em` |
| `--size-fret-h` |  | `8px` |
| `--size-fret-w` | 段々の帯 | `20px` |
| `--size-bead` | 数珠の幅 | `3px` |
| `--size-diamond` | 名前の前の菱形 | `6px` |
| `--size-tab-mark` | 選択中タブの金の線 | `20px` |
| `--size-emblem` | 紋章の最大の高さ | `260px` |
| `--shift-hook` | セリフが入るときの移動量 | `12px` |
| `--dur-hook` |  | `260ms` |
| `--ease-hook` | 減速して止まる（300ms 以内） | `cubic-bezier(0.05, 0.7, 0.1, 1)` |
| `--safe-top` |  | `env(safe-area-inset-top, 0px)` |
| `--safe-bottom` |  | `env(safe-area-inset-bottom, 0px)` |

## 夜の上書き（D-019 Q5, D-021 CR-C05）

22〜4時は `body[data-period="night"]` で次のトークンを上書きする。

| 名前 | 夜の値 |
| --- | --- |
| `--color-bg` | `#10261f` |
| `--color-bg-top` | `#142f26` |
| `--color-bg-bottom` | `#060d0b` |
| `--color-surface-1` | `#0c1b16` |
| `--color-surface-2` | `#142820` |
| `--color-bg-deep` | `#08120f` |
| `--bg-glow` | `radial-gradient(90% 40% at 50% 108%, var(--color-ember-glow), transparent 70%)` |

## コントラスト表

`python3 scripts/contrast_check.py` の出力（WCAG 2.x の相対輝度。`scrim` は `bg` に重ねた色で計算）。基準：文字 4.5、部品の境界 3.0（V3-01, V3-03, CR-A01）。

| 文字・部品 | 下地 | 基準 | 昼 | 夜 |
| --- | --- | --- | --- | --- |
| text | bg | 4.5 | 11.03 | 14.10 |
| text | surface-1 | 4.5 | 14.52 | 15.70 |
| text | surface-2 | 4.5 | 12.14 | 13.73 |
| text | scrim | 4.5 | 16.70 | 16.93 |
| text-secondary | bg | 4.5 | 8.15 | 10.41 |
| text-secondary | surface-1 | 4.5 | 10.73 | 11.60 |
| text-secondary | surface-2 | 4.5 | 8.96 | 10.14 |
| text-tertiary | bg | 4.5 | 6.46 | 8.25 |
| text-tertiary | surface-1 | 4.5 | 8.50 | 9.19 |
| text-tertiary | bg-deep | 4.5 | 9.64 | 9.86 |
| accent | bg-deep | 4.5 | 11.06 | 11.31 |
| on-accent | accent | 4.5 | 9.91 | 9.91 |
| success | bg | 4.5 | 8.44 | 10.78 |
| success | surface-1 | 4.5 | 11.10 | 12.01 |
| danger | surface-1 | 4.5 | 9.57 | 10.35 |
| danger | scrim | 4.5 | 11.00 | 11.15 |
| border | bg | 3.0 | 4.10 | 5.23 |
| border | surface-1 | 3.0 | 5.39 | 5.83 |
| border | scrim | 3.0 | 6.20 | 6.28 |
| text | bg-top | 4.5 | 9.22 | 12.70 |
| text-secondary | bg-top | 4.5 | 6.81 | 9.38 |
| text-tertiary | bg-bottom | 4.5 | 9.35 | 10.17 |
| text-tertiary | ink | 4.5 | 10.05 | 10.05 |
| accent | scrim | 4.5 | 11.21 | 11.36 |
| accent | ink | 4.5 | 11.53 | 11.53 |
| success | ink | 4.5 | 13.13 | 13.13 |
| line | bg | 3.0 | 3.21 | 4.10 |
| line | bg-bottom | 3.0 | 4.65 | 5.05 |
| line | surface-1 | 3.0 | 4.22 | 4.57 |
| text | field | 4.5 | 9.61 | 12.35 |
| border | field | 3.0 | 3.57 | 4.59 |
| text-tertiary | surface-1 | 4.5 | 8.50 | 9.19 |
| text-secondary | surface-1 | 4.5 | 10.73 | 11.60 |
| lime | bg-bottom | 3.0 | 12.22 | 13.28 |
| sky | bg-bottom | 3.0 | 8.12 | 8.83 |
| ember | bg-bottom | 3.0 | 8.57 | 9.32 |
