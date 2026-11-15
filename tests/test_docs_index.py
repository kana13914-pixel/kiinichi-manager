"""docs/README.md（ファイルの目次）に、リポジトリのすべてのファイルが載っているかを確かめる。

ファイル自身のパス、またはそれを含むフォルダのパス（末尾 /）が目次に書かれていれば載っているとみなす。
"""
import subprocess
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


class DocsIndexTest(unittest.TestCase):
    def test_every_file_is_listed(self):
        index = (ROOT / "docs" / "README.md").read_text(encoding="utf-8")
        files = subprocess.run(["git", "ls-files", "--cached", "--others", "--exclude-standard"],
                               cwd=ROOT, capture_output=True, text=True, check=True).stdout.split()
        missing = []
        for f in files:
            parts = f.split("/")
            candidates = [f] + ["/".join(parts[:i]) + "/" for i in range(1, len(parts))]
            if not any(f"`{c}`" in index or f"`{c}" in index and c.endswith("/") for c in candidates):
                missing.append(f)
        self.assertEqual(missing, [], "docs/README.md に載っていないファイル:\n" + "\n".join(missing))


if __name__ == "__main__":
    unittest.main()
