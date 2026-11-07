#!/usr/bin/env python3
"""セリフ集 data/dialogue_template.yaml を、PWAが読める app/data/dialogue.json に変換する。

ブラウザにはYAMLの読み込み機能がないため、セリフ集を編集したらこのスクリプトを実行してJSONを作り直す。
（tests/test_dialogue.py が、YAMLとJSONの中身が一致しているかを確認する）

  python3 scripts/build_dialogue.py
"""
import json
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "data" / "dialogue_template.yaml"
DST = ROOT / "app" / "data" / "dialogue.json"


def build():
    data = yaml.safe_load(SRC.read_text(encoding="utf-8"))
    return json.dumps(data, ensure_ascii=False, indent=2) + "\n"


if __name__ == "__main__":
    DST.parent.mkdir(parents=True, exist_ok=True)
    DST.write_text(build(), encoding="utf-8")
    print(f"{DST.relative_to(ROOT)} を作成しました")
