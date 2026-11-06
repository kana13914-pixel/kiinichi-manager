"""PWAの検証（ヘッドレスChrome）。localhost で app/ を配信し、PWAとして最低限成立しているかを見る。
iOS固有の挙動（ホーム画面追加・通知許可）はここでは確認できないため、実機手順は docs/roadmap.md を参照。
"""
import functools
import json
import threading
import unittest
from http.server import HTTPServer, SimpleHTTPRequestHandler
from pathlib import Path

from playwright.sync_api import sync_playwright

APP_DIR = Path(__file__).resolve().parent.parent / "app"


class QuietHandler(SimpleHTTPRequestHandler):
    extensions_map = {**SimpleHTTPRequestHandler.extensions_map, ".webmanifest": "application/manifest+json"}

    def log_message(self, *a):
        pass


class PwaTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        handler = functools.partial(QuietHandler, directory=str(APP_DIR))
        cls.server = HTTPServer(("127.0.0.1", 0), handler)
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()
        cls.base = f"http://127.0.0.1:{cls.server.server_port}/"
        cls.pw = sync_playwright().start()
        cls.browser = cls.pw.chromium.launch(
            executable_path="/usr/bin/google-chrome",
        )

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls.pw.stop()
        cls.server.shutdown()

    def new_page(self):
        ctx = self.browser.new_context()
        self.addCleanup(ctx.close)
        page = ctx.new_page()
        errors = []
        page.on("pageerror", lambda e: errors.append(str(e)))
        self.addCleanup(lambda: self.assertEqual(errors, [], "JSエラーが出ている"))
        return page

    def test_manifest_is_installable_shape(self):
        m = json.loads((APP_DIR / "manifest.webmanifest").read_text(encoding="utf-8"))
        self.assertEqual(m["display"], "standalone")
        sizes = {i["sizes"] for i in m["icons"]}
        self.assertTrue({"192x192", "512x512"} <= sizes)
        for icon in m["icons"]:
            self.assertTrue((APP_DIR / icon["src"]).exists(), icon["src"])
        self.assertTrue((APP_DIR / "icons/icon-180.png").exists())  # apple-touch-icon

    def test_page_loads_and_service_worker_registers(self):
        page = self.new_page()
        page.goto(self.base + "index.html")
        page.wait_for_selector("#sw-status.ok", timeout=10_000)
        self.assertEqual(page.text_content("#sw-status"), "登録済み")
        self.assertEqual(page.text_content("#source"), "URLを直接開いた")

    def test_opened_from_notification_is_detected(self):
        page = self.new_page()
        page.goto(self.base + "index.html?source=ntfy")
        self.assertEqual(page.text_content("#source"), "通知（ntfy）のタップ")

    def test_one_tap_plays_audio_after_opening_from_notification(self):
        page = self.new_page()
        page.goto(self.base + "index.html?source=ntfy")
        self.assertEqual(page.text_content("#audio-status"), "未再生")
        page.click("#play-voice")  # ボタン1回
        page.wait_for_selector("#audio-status.ok", timeout=5_000)
        page.wait_for_function("document.getElementById('audio-status').textContent === '再生完了'", timeout=5_000)


if __name__ == "__main__":
    unittest.main()
