#!/usr/bin/env python3
"""色の明暗差（コントラスト比）を計算する。標準ライブラリだけで動く。

app/style.css の :root（昼）と、あれば body[data-period="night"]（夜。:root に上書き）から
--color-* を読み、docs/ui_knowledge.md §2.4 の組み合わせを WCAG 2.x の式で計算する。
結果を Markdown の表で出し、基準未満が 1 つでもあれば終了コード 1 を返す。

  python3 scripts/contrast_check.py

トークンを追加・変更したら実行し、出力を docs/design.md の「コントラスト表」に貼る（M2-02）。
"""
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CSS = ROOT / "app" / "style.css"

# (文字・部品, 下地, 基準) — ui_knowledge.md §2.4 ＋ 本アプリで実際に使う組み合わせ
PAIRS = [
    ("text", "bg", 4.5),
    ("text", "surface-1", 4.5),
    ("text", "surface-2", 4.5),
    ("text", "scrim", 4.5),
    ("text-secondary", "bg", 4.5),
    ("text-secondary", "surface-1", 4.5),
    ("text-secondary", "surface-2", 4.5),
    ("text-tertiary", "bg", 4.5),
    ("text-tertiary", "surface-1", 4.5),
    ("text-tertiary", "bg-deep", 4.5),
    ("accent", "bg-deep", 4.5),
    ("on-accent", "accent", 4.5),
    ("success", "bg", 4.5),
    ("success", "surface-1", 4.5),
    ("danger", "surface-1", 4.5),
    ("danger", "scrim", 4.5),       # セリフの面の上に注意の文字を出す場合
    ("border", "bg", 3.0),
    ("border", "surface-1", 3.0),
    ("border", "scrim", 3.0),       # セリフの面の上に部品を置く場合
    # D-021（見た目の決まり v7）
    ("text", "bg-top", 4.5),
    ("text-secondary", "bg-top", 4.5),
    ("text-tertiary", "bg-bottom", 4.5),
    ("text-tertiary", "ink", 4.5),       # タブのラベル
    ("accent", "scrim", 4.5),            # 名前
    ("accent", "ink", 4.5),              # 選択中のタブの文字と印（NEXT は金ではない。D-022）
    ("success", "ink", 4.5),             # 記録済みボタン
    ("line", "bg", 3.0),
    ("line", "bg-bottom", 3.0),
    ("line", "surface-1", 3.0),
    # R4（機能画面の決まり CR-F / CR-G）
    ("text", "field", 4.5),              # 入力欄の文字
    ("border", "field", 3.0),            # 入力欄の縁（入力欄だと分かる境界）
    ("text-tertiary", "surface-1", 4.5), # 切り替えの未選択の文字
    ("text-secondary", "surface-1", 4.5),# チップの未選択の文字
    ("lime", "bg-bottom", 3.0),          # 調子の印（図として 3:1）
    ("sky", "bg-bottom", 3.0),
    ("ember", "bg-bottom", 3.0),
]


def block(css, selector_regex):
    m = re.search(selector_regex + r"\s*\{(.*?)\n\}", css, re.S)
    return m.group(1) if m else None


def read_colors(body):
    colors = {}
    for name, value in re.findall(r"--color-([\w-]+)\s*:\s*([^;]+);", body):
        colors[name] = value.strip()
    return colors


def parse(value):
    """'#rrggbb' または 'rgba(r, g, b, a)' を (r, g, b, a) に。0〜255 と 0〜1。"""
    value = value.strip()
    m = re.fullmatch(r"#([0-9a-fA-F]{6})", value)
    if m:
        h = m.group(1)
        return (int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16), 1.0)
    m = re.fullmatch(r"rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)", value)
    if m:
        a = float(m.group(4)) if m.group(4) is not None else 1.0
        return (float(m.group(1)), float(m.group(2)), float(m.group(3)), a)
    raise ValueError(f"色として読めません: {value}")


def over(top, bottom):
    """半透明の色 top を不透明の bottom に重ねた色。"""
    r, g, b, a = top
    br, bg, bb, _ = bottom
    return (r * a + br * (1 - a), g * a + bg * (1 - a), b * a + bb * (1 - a), 1.0)


def luminance(c):
    def ch(v):
        v = v / 255
        return v / 12.92 if v <= 0.04045 else ((v + 0.055) / 1.055) ** 2.4
    r, g, b, _ = c
    return 0.2126 * ch(r) + 0.7152 * ch(g) + 0.0722 * ch(b)


def ratio(fg, bg):
    l1, l2 = sorted((luminance(fg), luminance(bg)), reverse=True)
    return (l1 + 0.05) / (l2 + 0.05)


def resolve(colors, name):
    c = parse(colors[name])
    if c[3] < 1.0:  # 半透明の面（scrim）は背景に重ねた色で判定する
        c = over(c, parse(colors["bg"]))
    return c


def evaluate(colors):
    rows = []
    for fg, bg, need in PAIRS:
        fgc = resolve(colors, fg)
        bgc = resolve(colors, bg)
        if fgc[3] < 1.0:
            fgc = over(fgc, bgc)
        rows.append((fg, bg, need, ratio(fgc, bgc)))
    return rows


def main():
    css = CSS.read_text(encoding="utf-8")
    day = read_colors(block(css, r":root") or "")
    night_body = block(css, r'body\[data-period="night"\]')
    themes = [("昼", day)]
    if night_body:
        themes.append(("夜", {**day, **read_colors(night_body)}))

    results = {name: evaluate(colors) for name, colors in themes}
    names = [n for n, _ in themes]
    print("| 文字・部品 | 下地 | 基準 | " + " | ".join(names) + " |")
    print("| --- | --- | --- | " + " | ".join("---" for _ in names) + " |")
    failed = []
    for i, (fg, bg, need, _) in enumerate(results[names[0]]):
        cells = []
        for n in names:
            r = results[n][i][3]
            ok = r >= need
            cells.append(f"{r:.2f}" + ("" if ok else " ✗"))
            if not ok:
                failed.append(f"{n}: {fg} / {bg} = {r:.2f}（基準 {need}）")
        print(f"| {fg} | {bg} | {need} | " + " | ".join(cells) + " |")
    if failed:
        print("\n基準未満:\n" + "\n".join(failed), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
