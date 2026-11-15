# ui_research round3（2026-11-08）

初見の感想「ダサい・もっさり」「キィニチらしくない」への対応一式。
確認事項 Q-R1〜R5 は 2026-11-08 に決定済み（visual_rules_v7_instructions_for_ai.md §7）。

| ファイル | 種類 | 内容 |
| --- | --- | --- |
| kinich_design_research_for_ai.md | Q1 AI用 | キィニチ（原神）のプロフィール・外見・配色・モチーフ目録・権利の範囲 |
| （Claude Docs）原神・キィニチ デザイン調査（人間用） | Q1 人間用 | 同じ内容を読み物として。リンクはチャットを参照 |
| first_impression_response_flow_for_ai.md | Q2 AI用 | 抽象的な見た目の不満を、属性→原因→打ち手→検証へ落とす手順 |
| visual_rules_v7_instructions_for_ai.md | Q3 AI用 | 診断、コンセプト、アプリ全体の見た目の決まり（CR-*）、トークン、実装タスク R01〜R14、確認事項 |
| reference_impl/phase1-v7_canopy.patch | 参考実装 | phase1-v6（2cea0e1）に `git apply` で当たる差分。全テスト通過済み |
| reference_impl/img/*.svg | 参考実装 | 自作の装飾（紋章・吊り線・段々の帯・粒） |
| images/ | 画像 | v6 と v7 の比較、v7 の各状態（朝・通知直後・記録後・夜・設定・予定・SE）、時刻 40px／48px の比較 |

別チャットの AI には、まず visual_rules_v7_instructions_for_ai.md を渡してください。
