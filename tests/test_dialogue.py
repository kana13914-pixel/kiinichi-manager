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
