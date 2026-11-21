"""セリフ集のYAMLとPWA用JSONが一致しているか、構造が正しいかを確認する。"""
import json
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))
import build_dialogue  # noqa: E402


class DialogueTest(unittest.TestCase):
    def test_json_is_up_to_date(self):
        self.assertEqual(
            (ROOT / "app" / "data" / "dialogue.json").read_text(encoding="utf-8"),
            build_dialogue.build(),
            "セリフ集を編集したら python3 scripts/build_dialogue.py を実行してください",
        )

    def test_every_template_trigger_has_lines(self):
        data = json.loads(build_dialogue.build())
        for trigger, body in data.items():
            if "prompt_guidance" in body:  # LLMを使う場面はセリフ集を持たない
                continue
            for cond in body["conditions"]:
                self.assertTrue(cond["lines"], f"{trigger}/{cond['id']} にセリフがない")

    def test_every_scene_has_three_tones(self):
        """利用者の文面（D-085）：どの場面も依頼人版・友人版・甘やかし版がそろい、触ったとき・開いたときの場面もある"""
        data = json.loads(build_dialogue.build())
        for trigger, body in data.items():
            for cond in body.get("conditions", []):
                for k in ("lines", "lines_friend", "lines_sweet"):
                    self.assertTrue(cond.get(k), f"{trigger}/{cond['id']} の {k}")
        ids = lambda t: [c["id"] for c in data[t]["conditions"]]
        self.assertEqual(ids("touch"), ["rapid", "warn", "after_warn", "stop", "return", "morning", "day", "evening", "night", "head", "face", "neck", "hand", "body", "foot"])
        self.assertEqual(ids("hold"), ["head", "face", "neck", "hand", "body", "foot"])
        self.assertEqual(ids("home"), ["tasks_some", "tasks_all", "tired_today", "after_tired", "after_late"])
        self.assertEqual(ids("rare"), ["open", "day7", "day30", "day100"])
        self.assertEqual(ids("first_launch"), ["default"])
        text = json.dumps(data, ensure_ascii=False)
        self.assertNotIn("{meal}", text)  # 記録のくせは朝・昼・夜を入れて3つに分けた
        for word in ("オレ", "〜ぜ"):  # アハウの話し方は「／ アハウ：」の後ろだけ
            for trigger, body in data.items():
                for cond in body.get("conditions", []):
                    for k in ("lines", "lines_friend", "lines_sweet"):
                        for line in cond[k]:
                            self.assertNotIn(word, line.split("／ アハウ：")[0], f"{trigger}/{cond['id']}")

    def test_tone_lines_are_known_and_not_empty(self):
        """話し方ごとの文（D-082）は lines_friend・lines_sweet だけ。書くなら空にしない"""
        data = json.loads(build_dialogue.build())
        for trigger, body in data.items():
            for cond in body.get("conditions", []):
                for k, v in cond.items():
                    if k.startswith("lines_"):
                        self.assertIn(k, ("lines_friend", "lines_sweet"), f"{trigger}/{cond['id']} の {k}")
                        self.assertTrue(isinstance(v, list) and v and all(isinstance(x, str) and x for x in v), f"{trigger}/{cond['id']} の {k}")


if __name__ == "__main__":
    unittest.main()
