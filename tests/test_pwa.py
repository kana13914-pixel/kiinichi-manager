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

# 設定済み（ready）の状態を作る
READY = "localStorage.setItem('setup.done','1')"
# ヘッドレスChromeは本物のプッシュ購読ができない（外部通信が必要）ため、購読処理だけ偽物にする
FAKE_PUSH = """
PushManager.prototype.getSubscription = async () => null;
PushManager.prototype.subscribe = async () => ({
  options: {},
  toJSON: () => ({ endpoint: 'https://web.push.apple.com/fake', keys: { p256dh: 'BBBB', auth: 'AAAA' } }),
});
"""


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

    def new_page(self, permissions=None, init_script=None):
        ctx = self.browser.new_context(permissions=permissions or [])
        if init_script:
            ctx.add_init_script(init_script)
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
        page.wait_for_selector("#sw-status.ok", state="attached", timeout=10_000)
        self.assertEqual(page.text_content("#sw-status"), "登録済み")
        self.assertEqual(page.text_content("#source"), "URLを直接開いた")
        # 画面の版と sw.js のキャッシュ版が一致している（更新し忘れ防止）
        sw = (APP_DIR / "sw.js").read_text(encoding="utf-8")
        self.assertIn(f"const CACHE_VERSION = '{page.text_content('#app-version')}'", sw)

    def test_opened_from_notification_is_detected(self):
        page = self.new_page()
        page.goto(self.base + "index.html?source=ntfy")
        self.assertEqual(page.text_content("#source"), "通知（ntfy）のタップ")

    def test_one_tap_plays_audio_after_opening_from_notification(self):
        page = self.new_page(permissions=["notifications"], init_script=READY)
        page.goto(self.base + "index.html?source=webpush&mode=standalone")
        self.assertEqual(page.get_attribute("body", "data-state"), "ready")
        self.assertEqual(page.text_content("#audio-status"), "未再生")
        page.click("#play-voice")  # ボタン1回
        page.wait_for_selector("#audio-status.ok", timeout=5_000)
        page.wait_for_function("document.getElementById('audio-status').textContent === '再生完了'", timeout=5_000)

    def test_send_page_posts_scheduled_notification_to_ntfy(self):
        page = self.new_page()
        sent = []

        def fake_ntfy(route):
            sent.append(route.request)
            route.fulfill(status=200, content_type="application/json",
                          headers={"Access-Control-Allow-Origin": "*"},
                          body='{"id":"fake","time":1800000000}')

        page.route("https://ntfy.sh/", fake_ntfy)
        page.goto(self.base + "send.html")
        self.assertTrue(page.input_value("#click").endswith("/index.html?source=ntfy"))
        page.click("#send")  # トピック未入力
        self.assertIn("トピック名を入力", page.text_content("#send-status"))
        page.fill("#topic", "test-topic")
        page.select_option("#delay", "5")
        page.click("#send")
        page.wait_for_selector("#send-status.ok", timeout=5_000)
        self.assertEqual(len(sent), 1)
        body = json.loads(sent[0].post_data)
        self.assertEqual(body["topic"], "test-topic")
        self.assertTrue(body["delay"].isdigit())
        self.assertIn("予定", body["message"])
        # application/json を付けるとCORSの事前確認が必要になるため、付けていないことを確認
        self.assertNotIn("json", sent[0].headers.get("content-type", ""))

    def test_generated_topic_is_random_and_remembered(self):
        page = self.new_page()
        page.goto(self.base + "send.html")
        page.click("#gen-topic")
        t1 = page.input_value("#topic")
        self.assertRegex(t1, r"^kiinichi-[0-9a-f]{24}$")
        page.reload()
        self.assertEqual(page.input_value("#topic"), t1)

    def test_send_page_web_push_calls_worker_with_token(self):
        page = self.new_page()
        calls = []

        def fake_worker(route):
            calls.append(route.request)
            if route.request.method == "OPTIONS":
                route.fulfill(status=204, headers={"Access-Control-Allow-Origin": "*",
                                                   "Access-Control-Allow-Headers": "Authorization, Content-Type",
                                                   "Access-Control-Allow-Methods": "GET, POST, OPTIONS"})
                return
            route.fulfill(status=200, content_type="application/json",
                          headers={"Access-Control-Allow-Origin": "*"},
                          body='{"ok":true,"scheduled":true,"at":1800000000000}')

        page.route("https://kiinichi.example.workers.dev/**", fake_worker)
        page.goto(self.base + "send.html")
        # 送信サーバーのURLは最初から入っている（D-014）。合言葉は空
        self.assertEqual(page.input_value("#wp-worker-url"), "https://kiinichi-push.satoukana13914.workers.dev")
        self.assertEqual(page.input_value("#wp-token"), "")
        page.click("#wp-send")
        self.assertIn("合言葉", page.text_content("#wp-status"))  # 合言葉が未入力なら入力を促す
        page.fill("#wp-worker-url", "https://kiinichi.example.workers.dev/")
        page.dispatch_event("#wp-worker-url", "change")
        page.fill("#wp-token", "tok-123")
        page.dispatch_event("#wp-token", "change")
        page.select_option("#delay", "5")
        page.click("#wp-send")
        page.wait_for_selector("#wp-status.ok", timeout=5_000)
        self.assertIn("予約しました", page.text_content("#wp-status"))
        post = [c for c in calls if c.method == "POST"][0]
        self.assertEqual(post.url, "https://kiinichi.example.workers.dev/api/send")
        self.assertEqual(post.headers["authorization"], "Bearer tok-123")
        body = json.loads(post.post_data)
        self.assertEqual(body["delaySeconds"], 300)
        self.assertTrue(body["url"].endswith("/index.html?source=webpush"))
        # 声掛けの種類を選ぶと、タップ先URLに trigger が付く
        page.select_option("#wp-trigger", "midday_check.meal_overdue")
        page.select_option("#delay", "0")
        page.click("#wp-send")
        # 偽サーバーは常に「予約済み」と返すので、表示ではなく2回目の送信が届いたことで待つ
        deadline = 50
        while len([c for c in calls if c.method == "POST"]) < 2 and deadline:
            page.wait_for_timeout(100)
            deadline -= 1
        post2 = [c for c in calls if c.method == "POST"][-1]
        body2 = json.loads(post2.post_data)
        self.assertTrue(body2["url"].endswith("?source=webpush&trigger=midday_check.meal_overdue"))
        self.assertNotIn("delaySeconds", body2)
        page.reload()  # 設定は端末に保存される
        self.assertEqual(page.input_value("#wp-worker-url"), "https://kiinichi.example.workers.dev/")

    def test_safari_shows_only_add_to_home_screen_guide(self):
        page = self.new_page()
        page.goto(self.base + "index.html")
        self.assertEqual(page.get_attribute("body", "data-state"), "safari")
        self.assertTrue(page.is_visible("#onboard-safari"))
        self.assertFalse(page.is_visible("#main"))
        self.assertFalse(page.is_visible("#onboard-setup"))

    def test_first_launch_setup_registers_and_moves_to_ready(self):
        page = self.new_page(permissions=["notifications"], init_script=FAKE_PUSH)
        calls = []

        def fake_worker(route):
            req = route.request
            calls.append(req)
            cors = {"Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Authorization, Content-Type",
                    "Access-Control-Allow-Methods": "GET, POST, OPTIONS"}
            if req.method == "OPTIONS":
                route.fulfill(status=204, headers=cors)
            elif req.url.endswith("/api/vapid-public-key"):
                route.fulfill(status=200, content_type="application/json", headers=cors,
                              body='{"publicKey":"BHwerwZnkkro38y8e_YA6eiURgYes1c4BxSzHrU8kWsGJcOF7AvYnH2mievzMzSHhWWTG2DdGjnPDcDXpwrbsYM"}')
            else:
                route.fulfill(status=200, content_type="application/json", headers=cors, body='{"ok":true}')

        page.route("https://kiinichi-push.satoukana13914.workers.dev/**", fake_worker)
        page.goto(self.base + "index.html?mode=standalone")
        self.assertEqual(page.get_attribute("body", "data-state"), "setup")
        self.assertFalse(page.is_visible("#main"))
        page.wait_for_selector("#sw-status.ok", state="attached", timeout=10_000)
        # 合言葉なし → 入力を促し、状態は setup のまま
        page.click("#setup-start")
        page.wait_for_function("document.getElementById('setup-status').textContent.includes('合言葉')", timeout=5_000)
        self.assertEqual(page.get_attribute("body", "data-state"), "setup")
        # 合言葉あり → 登録して ready へ
        page.fill("#setup-token", "tok-xyz")
        page.dispatch_event("#setup-token", "change")
        page.click("#setup-start")
        page.wait_for_function("document.body.dataset.state === 'ready'", timeout=10_000)
        self.assertTrue(page.is_visible("#main"))
        sub = [c for c in calls if c.method == "POST" and c.url.endswith("/api/subscribe")][0]
        self.assertEqual(sub.headers["authorization"], "Bearer tok-xyz")
        self.assertEqual(json.loads(sub.post_data)["endpoint"], "https://web.push.apple.com/fake")
        page.reload()  # 次に開いたときは ready のまま
        self.assertEqual(page.get_attribute("body", "data-state"), "ready")

    def test_phase0_users_with_saved_token_skip_setup(self):
        page = self.new_page(permissions=["notifications"],
                             init_script="localStorage.setItem('phase0.appToken','old-token')")
        page.goto(self.base + "index.html?mode=standalone")
        self.assertEqual(page.get_attribute("body", "data-state"), "ready")

    def test_mode_param_is_ignored_outside_localhost(self):
        app_js = (APP_DIR / "app.js").read_text(encoding="utf-8")
        self.assertIn("['localhost', '127.0.0.1'].includes(location.hostname)", app_js)

    def test_webpush_source_is_detected(self):
        page = self.new_page()
        page.goto(self.base + "index.html?source=webpush")
        self.assertEqual(page.text_content("#source"), "通知（Web Push）のタップ")

    # ---------- ホーム（D-018） ----------
    def ready_page(self, query=""):
        page = self.new_page(permissions=["notifications"], init_script=READY)
        page.goto(self.base + "index.html?mode=standalone" + query)
        return page

    def test_home_shows_clock_next_event_and_portrait_within_3_seconds(self):
        import time
        page = self.new_page(permissions=["notifications"], init_script=READY)
        t0 = time.monotonic()
        page.goto(self.base + "index.html?mode=standalone")
        page.wait_for_function(
            "/^\\d{2}:\\d{2}$/.test(document.getElementById('clock-time').textContent)"
            " && document.getElementById('next-event').textContent.trim() !== '-'", timeout=3_000)
        self.assertLess(time.monotonic() - t0, 3.0)
        self.assertTrue(page.is_visible("#portrait"))
        self.assertTrue(page.is_visible("#view-home"))
        self.assertFalse(page.is_visible("#view-settings"))

    def test_next_event_picks_first_future_item(self):
        page = self.ready_page()
        titles = page.evaluate("""() => {
          const at = (h, m) => { const d = new Date(); d.setHours(h, m, 0, 0); return d; };
          const pick = (now) => (SampleData.todayEvents(now).find((e) => e.at > now) || {}).title || null;
          return [pick(at(8, 0)), pick(at(12, 0)), pick(at(23, 45))];
        }""")
        self.assertEqual(titles, ["仕事開始", "休憩", None])

    def test_opened_from_notification_shows_that_triggers_line(self):
        page = self.ready_page("&source=webpush&trigger=midday_check.meal_overdue")
        page.wait_for_function("document.getElementById('bubble-text').textContent.includes('飯の時間')", timeout=3_000)
        self.assertIn("ready", page.get_attribute("#play-voice", "class"))

    def test_record_button_shows_template_line(self):
        page = self.ready_page()
        page.wait_for_function("document.getElementById('bubble-text').textContent.includes('セリフが出ます')", timeout=3_000)
        page.click("text=仕事開始")
        line = page.text_content("#bubble-text")
        self.assertIn(line, ["わかった。何かあったら声をかけてくれ。", "了解。進捗、気になったらこっちから聞く。"])

    def test_tabbar_switches_views(self):
        page = self.ready_page()
        page.click(".tabbar a[data-view=settings]")
        page.wait_for_selector("#view-settings", state="visible", timeout=3_000)
        self.assertFalse(page.is_visible("#view-home"))
        self.assertEqual(page.text_content("#app-version"), page.evaluate("APP_VERSION"))
        page.click(".tabbar a[data-view=home]")
        page.wait_for_selector("#view-home", state="visible", timeout=3_000)

    def test_inputs_are_16px_or_larger(self):
        # 16px 未満の入力欄は iOS がフォーカス時に画面を拡大する（V2-04）
        page = self.new_page(permissions=["notifications"], init_script=READY)
        page.goto(self.base + "index.html?mode=standalone#settings")
        sizes = page.eval_on_selector_all("input", "els => els.map(e => parseFloat(getComputedStyle(e).fontSize))")
        self.assertTrue(sizes)
        self.assertTrue(all(sz >= 16 for sz in sizes), sizes)


if __name__ == "__main__":
    unittest.main()
