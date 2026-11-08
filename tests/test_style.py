"""スタイルの決まりごとの検証（M2-01, V3-01）。"""
import re
import subprocess
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CSS = ROOT / "app" / "style.css"


def strip_token_blocks(css):
    """:root と body[data-period=…] のブロック（トークンの定義場所）とコメントを除く。"""
    css = re.sub(r"/\*.*?\*/", "", css, flags=re.S)
    css = re.sub(r":root\s*\{.*?\n\}", "", css, flags=re.S)
    css = re.sub(r"body\[data-period=[^\]]*\]\s*\{.*?\n\}", "", css, flags=re.S)
    return css


class StyleTest(unittest.TestCase):
    def test_contrast_check_passes(self):
        r = subprocess.run([sys.executable, str(ROOT / "scripts" / "contrast_check.py")], capture_output=True, text=True)
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)

    def test_css_uses_tokens(self):
        rest = strip_token_blocks(CSS.read_text(encoding="utf-8"))
        problems = []
        for i, line in enumerate(rest.splitlines(), 1):
            if re.search(r"#[0-9a-fA-F]{3,8}\b", line):
                problems.append(f"色コード: {line.strip()}")
            if re.search(r"\b(rgba?|hsla?)\(", line):
                problems.append(f"rgba/hsla: {line.strip()}")
            for num in re.findall(r"(?<![\w.-])(\d*\.?\d+)px\b", line):
                if num not in ("1", "1.5", "2"):
                    problems.append(f"{num}px: {line.strip()}")
            if re.search(r"(?<![\w-])\d*\.?\d+rem\b", line):
                problems.append(f"rem: {line.strip()}")
        self.assertEqual(problems, [], "トークンを使ってください（M2-01）:\n" + "\n".join(problems))


if __name__ == "__main__":
    unittest.main()
