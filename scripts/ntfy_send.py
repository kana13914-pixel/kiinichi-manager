#!/usr/bin/env python3
"""フェーズ0 検証用：ntfy に通知を送る（標準ライブラリのみ）。

使い方:
  python3 scripts/ntfy_send.py init            # .env を作成（推測不能なトピック名を生成）
  python3 scripts/ntfy_send.py send            # 今すぐ通知
  python3 scripts/ntfy_send.py send --in 5m    # 5分後に通知（サーバー側で予約）
  python3 scripts/ntfy_send.py send --at 21:30 # 指定時刻に通知（サーバー側で予約）
  python3 scripts/ntfy_send.py send --dry-run  # 送らずに送信内容だけ表示

設定は .env（リポジトリには含めない）:
  NTFY_TOPIC   トピック名。パスワード相当なので他人に見せない（必須）
  NTFY_SERVER  既定 https://ntfy.sh
  APP_URL      通知タップで開くPWAのURL（例 https://example.github.io/kiinichi/app/index.html）
  NTFY_TOKEN   アクセストークン（任意。公開トピックなら不要）

JSON形式で送るため、日本語のタイトル・本文もそのまま扱える。
予約（--at/--in）は ntfy サーバーが保持して配信するので、PWAや送信元PCを閉じていても届く。
"""
import argparse
import json
import os
import secrets
import sys
import urllib.request
from datetime import datetime, timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
ENV_PATH = ROOT / ".env"


def load_env(path=ENV_PATH):
    env = {}
    if path.exists():
        for line in path.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                env[k.strip()] = v.strip().strip('"').strip("'")
    # 環境変数が設定されていればそちらを優先
    for k in ("NTFY_TOPIC", "NTFY_SERVER", "APP_URL", "NTFY_TOKEN"):
        if os.environ.get(k):
            env[k] = os.environ[k]
    return env


def cmd_init(_args):
    if ENV_PATH.exists():
        print(f"{ENV_PATH} は既にあります。上書きしません。")
        return 1
    topic = "kiinichi-" + secrets.token_urlsafe(18).replace("-", "x").replace("_", "y")
    ENV_PATH.write_text(
        "# このファイルはコミットしない（.gitignore 済み）\n"
        f"NTFY_TOPIC={topic}\n"
        "NTFY_SERVER=https://ntfy.sh\n"
        "APP_URL=\n",
        encoding="utf-8",
    )
    print(f"{ENV_PATH} を作成しました。中の NTFY_TOPIC を iPhone の ntfy アプリで購読してください。")
    return 0


def resolve_at(value, now=None):
    """'21:30' のような時刻表記を Unix 時刻に変換する。過ぎていれば翌日。それ以外はそのまま返す。"""
    now = now or datetime.now()
    try:
        t = datetime.strptime(value, "%H:%M")
    except ValueError:
        return value  # '10m' や Unix 時刻などは ntfy に解釈を任せる
    target = now.replace(hour=t.hour, minute=t.minute, second=0, microsecond=0)
    if target <= now:
        target += timedelta(days=1)
    return str(int(target.timestamp()))


def build_payload(env, title, message, at=None, in_=None, click=None, now=None):
    if not env.get("NTFY_TOPIC"):
        raise SystemExit("NTFY_TOPIC が未設定です。先に `init` を実行するか .env を確認してください。")
    payload = {"topic": env["NTFY_TOPIC"], "title": title, "message": message}
    click = click or env.get("APP_URL")
    if click:
        sep = "&" if "?" in click else "?"
        payload["click"] = f"{click}{sep}source=ntfy"
    if at and in_:
        raise SystemExit("--at と --in は同時に指定できません。")
    if at:
        payload["delay"] = resolve_at(at, now)
    elif in_:
        payload["delay"] = in_
    return payload


def send(env, payload, opener=urllib.request.urlopen):
    server = env.get("NTFY_SERVER") or "https://ntfy.sh"
    req = urllib.request.Request(
        server.rstrip("/") + "/",
        data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    if env.get("NTFY_TOKEN"):
        req.add_header("Authorization", "Bearer " + env["NTFY_TOKEN"])
    with opener(req, timeout=15) as res:
        return json.loads(res.read().decode("utf-8"))


def cmd_send(args):
    env = load_env()
    payload = build_payload(env, args.title, args.message, args.at, args.in_, args.click)
    shown = dict(payload, topic="(非表示)")
    if args.dry_run:
        print(json.dumps(shown, ensure_ascii=False, indent=2))
        return 0
    result = send(env, payload)
    when = result.get("time")
    when_s = datetime.fromtimestamp(when).strftime("%Y-%m-%d %H:%M:%S") if when else "?"
    print(f"送信しました（id={result.get('id')}、配信予定 {when_s}）")
    return 0


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="cmd", required=True)
    sub.add_parser("init").set_defaults(func=cmd_init)
    s = sub.add_parser("send")
    s.add_argument("--title", default="キィニチくん（検証）")
    s.add_argument("--message", default="通知テストだ。タップして開いてみろ。")
    s.add_argument("--at", help="配信時刻。'21:30'、Unix時刻、ntfyの自然言語表記など")
    s.add_argument("--in", dest="in_", help="配信までの時間。'30s'、'5m'、'2h' など（10秒〜3日）")
    s.add_argument("--click", help="タップで開くURL（省略時は APP_URL）")
    s.add_argument("--dry-run", action="store_true")
    s.set_defaults(func=cmd_send)
    args = p.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
