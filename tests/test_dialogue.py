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


if __name__ == "__main__":
    unittest.main()
