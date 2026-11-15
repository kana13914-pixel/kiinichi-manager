"""PWAの検証（ヘッドレスChrome）。localhost で app/ を配信し、PWAとして最低限成立しているかを見る。
iOS固有の挙動（ホーム画面追加・通知許可）はここでは確認できないため、実機手順は docs/roadmap.md を参照。
"""
import functools
from datetime import datetime
import json
import threading
import unittest
from http.server import HTTPServer, SimpleHTTPRequestHandler
from pathlib import Path

from playwright.sync_api import sync_playwright

APP_DIR = Path(__file__).resolve().parent.parent / "app"

# iPhone の 3 機種（V4-02）：(幅, 高さ), (上, 下のセーフエリア)
DEVICES = [((375, 667), (20, 0)), ((393, 852), (59, 34)), ((430, 932), (59, 34))]
# 裏に回す操作を模す（window.__vis を 'hidden' にして visibilitychange を発火する）
VISIBILITY = """
Object.defineProperty(Document.prototype, 'visibilityState', { configurable: true, get() { return window.__vis || 'visible'; } });
Object.defineProperty(Document.prototype, 'hidden', { configurable: true, get() { return (window.__vis || 'visible') === 'hidden'; } });
"""
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
        self.assertEqual(body2["body"], "そろそろ飯の時間、過ぎてるぞ。")
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

    def clock_page(self, hour, minute, query="", size=(393, 852), safe=None, day=9, init_script=None):
        """時刻と画面の大きさを決めて、設定済みの状態でホームを開く。safe=(上, 下) でセーフエリアを模す。"""
        ctx = self.browser.new_context(permissions=["notifications"], viewport={"width": size[0], "height": size[1]})
        self.addCleanup(ctx.close)
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
            page.add_style_tag(content=":root{--safe-top:%dpx;--safe-bottom:%dpx}" % safe)
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
        # 声の再生は見送り（D-023）。通知のセリフはセリフの面の上辺を金にして示す（D-024）
        self.assertTrue(page.evaluate("document.body.classList.contains('from-notification')"))
        top = page.eval_on_selector(".dialogue", "e => getComputedStyle(e).getPropertyValue('--dlg-top')")
        self.assertIn("e8c45c", top.lower())

    def test_record_button_shows_template_line(self):
        page = self.ready_page()
        page.wait_for_function("dialogue !== null", timeout=3_000)
        page.click(".act[data-record=work_start]")
        line = page.text_content("#bubble-text")
        self.assertIn(line, ["わかった。何かあったら声をかけてくれ。", "了解。進捗、気になったらこっちから聞く。"])

    def test_tabbar_switches_views(self):
        # D-019 Q1：タブは5個、設定はホーム右上のアイコンから開き「‹ ホーム」で戻る
        page = self.ready_page()
        self.assertEqual(len(page.query_selector_all(".tabbar a")), 5)
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
        page = self.clock_page(14, 20)
        self.assertEqual(page.text_content(".next-title"), "休憩")
        self.assertEqual(page.text_content("#next-rest"), "あと40分")
        self.assertEqual(page.query_selector(".next-day"), None)

    # ---------- セリフの選び方（T05, D-019 Q4=出す） ----------
    def idle_lines(self, period):
        data = json.loads((APP_DIR / "data" / "dialogue.json").read_text(encoding="utf-8"))
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
        self.assertEqual(json.loads(page.evaluate("localStorage.getItem('records.today')"))["items"], {})

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
        self.assertEqual(self.primaries(page), ["work_start"])  # 起きたは記録済みなので次が主
        saved = page.evaluate("localStorage.getItem('records.today')")
        # 翌日の日付で開くと未記録
        page2 = self.clock_page(7, 12, day=10, init_script="localStorage.setItem('records.today', %s)" % json.dumps(saved))
        self.assertEqual(page2.text_content(".act[data-record=wake]"), "起きた")
        self.assertEqual(self.primaries(page2), ["wake"])

    def test_done_label_fits_on_small_screen(self):
        page = self.clock_page(9, 3, size=(375, 667), safe=(20, 0))
        page.click(".act[data-record=work_start]")
        self.assertEqual(page.text_content(".act[data-record=work_start]"), "✓ 仕事開始 09:03")
        sw, cw = page.eval_on_selector(".act[data-record=work_start]", "e => [e.scrollWidth, e.clientWidth]")
        self.assertLessEqual(sw, cw)

    def lines_of(self, trigger, cond_id):
        data = json.loads((APP_DIR / "data" / "dialogue.json").read_text(encoding="utf-8"))
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
        self.assertEqual(page.text_content("#bubble-text"), "そろそろ飯の時間、過ぎてるぞ。")
        self.assertEqual(self.primaries(page), ["work_start"])

    def test_records_reload_when_date_changes(self):
        # 1日の区切りは朝4時（D-034）。0時をまたいでも記録は残り、4時をまたぐと消える
        page = self.clock_page(23, 58)
        page.click(".act[data-record=wake]")
        self.assertIn("done", page.get_attribute(".act[data-record=wake]", "class"))
        page.clock.run_for(3 * 60 * 1000)  # 0:01 になる
        self.assertIn("done", page.get_attribute(".act[data-record=wake]", "class"))
        page.clock.fast_forward(4 * 3600 * 1000)  # 4:01 になる
        page.clock.run_for(1500)
        self.assertEqual(page.text_content(".act[data-record=wake]"), "起きた")

    def test_records_before_4am_belong_to_previous_day(self):
        saved = json.dumps({"date": "2026-11-09", "items": {"wake": "07:12"}})
        page = self.clock_page(1, 30, day=10, init_script="localStorage.setItem('records.today', %s)" % json.dumps(saved))
        self.assertEqual(page.text_content(".act[data-record=wake]"), "✓ 起きた 07:12")
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
        page = self.clock_page(13, 30)  # 主ボタンなしの時間
        page.keyboard.press("Tab")
        page.focus(".act[data-record=work_start]")
        page.keyboard.press("Shift+Tab")
        page.keyboard.press("Tab")
        bg = page.eval_on_selector(".act[data-record=work_start]",
                                   "e => e.matches(':focus-visible') ? getComputedStyle(e).backgroundColor : 'not-focus-visible'")
        self.assertEqual(bg, "rgb(232, 196, 92)")

    def test_portrait_shows_when_image_is_placed(self):
        import base64
        png = base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=")
        ctx = self.browser.new_context(permissions=["notifications"])
        self.addCleanup(ctx.close)
        ctx.add_init_script(READY)
        page = ctx.new_page()
        page.route("**/img/portrait.webp", lambda r: r.fulfill(status=200, content_type="image/png", body=png))
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

    # ---------- タスク画面（D-026 ①） ----------
    def tasks_page(self, hour=10, minute=0, day=9, tasks=None, size=(393, 852)):
        init = None
        if tasks is not None:
            init = "localStorage.setItem('tasks.v1', %s)" % json.dumps(json.dumps(tasks))
        page = self.clock_page(hour, minute, "#tasks", day=day, init_script=init, size=size)
        page.wait_for_selector("#view-tasks", state="visible", timeout=3_000)
        return page

    def open_titles(self, page):
        return page.eval_on_selector_all("#task-list .task-title", "els => els.map(e => e.textContent)")

    def test_tasks_empty_state_shows_character_line(self):
        page = self.tasks_page()
        page.wait_for_function("document.getElementById('tasks-say-line').textContent !== '…'", timeout=3_000)
        self.assertTrue(page.is_visible("#tasks-say"))
        data = json.loads((APP_DIR / "data" / "dialogue.json").read_text(encoding="utf-8"))
        lines = data["screen_empty"]["conditions"][0]["lines"]
        self.assertIn(page.text_content("#tasks-say-line"), lines)
        self.assertTrue(page.is_hidden("#done-section"))

    def test_add_task_with_due_chip_and_persist(self):
        page = self.tasks_page()
        page.click("#task-add-open")
        self.assertTrue(page.is_hidden("#task-add-open"))
        page.fill("#task-title", "資料を送る")
        page.click("#task-form .chip[data-due=tomorrow]")
        self.assertEqual(page.input_value("#task-due"), "2026-11-10")
        page.click("#task-submit")
        self.assertEqual(self.open_titles(page), ["資料を送る"])
        self.assertEqual(page.text_content("#task-list .task-due"), "明日まで")
        self.assertEqual(page.text_content("#tasks-say-line"), "残りはこれだけだ。一つずつ片づけろ。")  # 0件のときとは別の一言
        self.assertTrue(page.is_visible("#task-add-open"))
        page.reload()
        page.wait_for_selector("#view-tasks", state="visible")
        self.assertEqual(self.open_titles(page), ["資料を送る"])

    def test_empty_title_is_not_added(self):
        page = self.tasks_page()
        page.click("#task-add-open")
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
        page.click("#task-list .task-main")
        self.assertEqual(self.open_titles(page), [])
        self.assertEqual(page.text_content("#done-count"), "1")
        self.assertTrue(page.is_visible("#task-toast"))
        self.assertIn("完了にしました", page.text_content("#task-toast"))
        page.click("#task-toast .undo")
        self.assertEqual(self.open_titles(page), ["洗濯"])
        self.assertTrue(page.is_hidden("#done-section"))
        # 完了→未完了に戻す操作はトーストを出さない
        page.click("#task-list .task-main")
        page.click("#done-section summary")
        page.click("#done-list .task-main")
        self.assertEqual(self.open_titles(page), ["洗濯"])
        self.assertTrue(page.is_hidden("#task-toast"))

    def test_delete_and_undo_restores_position(self):
        tasks = [{"id": k, "title": k, "due": None, "done": False, "createdAt": i} for i, k in enumerate(["一", "二", "三"])]
        page = self.tasks_page(tasks=tasks)
        page.click("#task-list li[data-id='二'] .task-del")
        self.assertEqual(page.text_content("#confirm-text"), "「二」を削除しますか？")
        self.assertEqual(self.open_titles(page), ["一", "二", "三"])  # 確認するまで消えない
        page.click("#confirm-cancel")
        self.assertTrue(page.is_hidden("#confirm"))
        self.assertEqual(self.open_titles(page), ["一", "二", "三"])
        page.click("#task-list li[data-id='二'] .task-del")
        page.click("#confirm-ok")
        page.wait_for_selector("#task-toast", state="visible", timeout=3_000)  # 確認の結果は非同期で届く
        self.assertEqual(self.open_titles(page), ["一", "三"])
        self.assertIn("削除しました", page.text_content("#task-toast"))
        page.click("#task-toast .undo")
        self.assertEqual(self.open_titles(page), ["一", "二", "三"])
        page.click("#task-list li[data-id='三'] .task-del")
        page.click("#confirm-ok")
        page.wait_for_selector("#task-toast", state="visible", timeout=3_000)  # 確認の結果は非同期で届く
        page.clock.run_for(5_100)
        self.assertTrue(page.is_hidden("#task-toast"))
        stored = json.loads(page.evaluate("localStorage.getItem('tasks.v1')"))
        self.assertEqual([t["title"] for t in stored], ["一", "二"])

    def test_tasks_line_follows_situation(self):
        def task(i, due):
            return {"id": str(i), "title": f"t{i}", "due": due, "done": False, "createdAt": i}
        page = self.tasks_page(tasks=[task(1, "2026-11-08"), task(2, "2026-11-09"), task(3, None)])
        page.wait_for_function("document.getElementById('tasks-say-line').textContent !== '…'", timeout=3_000)
        self.assertEqual(page.text_content("#tasks-say-line"), "期限を過ぎたものがある。やるか、期限を引き直すか決めろ。")
        page.click("#task-list li[data-id='1'] .task-main")  # 期限切れを完了にする → 今日までが残る
        page.wait_for_function("document.getElementById('tasks-say-line').textContent.startsWith('今日まで')", timeout=3_000)
        self.assertEqual(page.text_content("#tasks-say-line"), "今日までのものがある。先にそっちだ。")
        page.click("#task-list li[data-id='2'] .task-main")
        page.wait_for_function("document.getElementById('tasks-say-line').textContent.startsWith('残り')", timeout=3_000)
        page.click("#task-list li[data-id='3'] .task-main")  # 全部終わったら 0件のときの一言
        lines = json.loads((APP_DIR / "data" / "dialogue.json").read_text(encoding="utf-8"))["screen_empty"]["conditions"][0]["lines"]
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
        stored = {t["id"]: t for t in json.loads(page.evaluate("localStorage.getItem('tasks.v1')"))}
        self.assertEqual(sorted(stored), ["keep", "nodate", "open"])
        self.assertAlmostEqual(stored["nodate"]["doneAt"], ms(9, 10), delta=5_000)
        self.assertEqual(page.text_content("#done-count"), "2")
        page.click("#done-section summary")
        self.assertIn("11/3(火) に完了", page.text_content("#done-list li[data-id=keep]"))
        self.assertIn("1週間", page.text_content("#done-section .note"))
        page.clock.fast_forward(14 * 3600_000 + 60_000)  # 0:01。朝4時まではまだ 11/9 の続き
        page.evaluate("Tasks.render()")
        self.assertIn("keep", [t["id"] for t in json.loads(page.evaluate("localStorage.getItem('tasks.v1')"))])
        page.clock.fast_forward(4 * 3600_000)  # 4:01。11/10 になり、11/3 完了のものも消える
        page.evaluate("Tasks.render()")
        self.assertEqual(sorted(t["id"] for t in json.loads(page.evaluate("localStorage.getItem('tasks.v1')"))), ["nodate", "open"])

    def test_tasks_screen_one_gold_fill_and_touch_sizes(self):
        tasks = [{"id": "a", "title": "とても長いタスクの名前" * 4, "due": "2026-11-09", "done": False, "createdAt": 1}]
        page = self.tasks_page(tasks=tasks, size=(375, 667))
        fills = page.evaluate("""() => [...document.querySelectorAll('#view-tasks *')]
          .filter((e) => e.getClientRects().length && getComputedStyle(e).backgroundColor === 'rgb(232, 196, 92)')
          .map((e) => e.id || e.className)""")
        self.assertEqual(fills, ["task-add-open"])
        h = page.eval_on_selector("#task-list .task-main", "e => e.getBoundingClientRect().height")
        w = page.eval_on_selector("#task-list .task-del", "e => e.getBoundingClientRect().width")
        self.assertGreaterEqual(h, 52)
        self.assertGreaterEqual(w, 44)
        self.assertLessEqual(page.evaluate("document.documentElement.scrollWidth"), 375)  # 長い名前でも横にはみ出さない
        page.click("#task-add-open")
        self.assertGreaterEqual(page.eval_on_selector("#task-title", "e => parseFloat(getComputedStyle(e).fontSize)"), 16)
        fills = page.evaluate("""() => [...document.querySelectorAll('#view-tasks *')]
          .filter((e) => e.getClientRects().length && getComputedStyle(e).backgroundColor === 'rgb(232, 196, 92)')
          .map((e) => e.id || e.className)""")
        self.assertEqual(fills, ["task-submit"])

    def test_task_toast_fits_on_small_screen(self):
        tasks = [{"id": "a", "title": "とても長いタスクの名前を入れておく", "due": None, "done": False, "createdAt": 1}]
        page = self.tasks_page(tasks=tasks, size=(375, 667))
        page.click("#task-list .task-main")
        undo_h = page.eval_on_selector("#task-toast .undo", "e => e.getBoundingClientRect().height")
        self.assertGreaterEqual(undo_h, 44)
        self.assertEqual(page.eval_on_selector("#task-toast .undo", "e => getComputedStyle(e).whiteSpace"), "nowrap")

    def test_task_form_buttons_visible_after_open(self):
        page = self.tasks_page(tasks=[{"id": k, "title": k, "due": None, "done": False, "createdAt": i} for i, k in enumerate("あいうえおかきくけこさしすせそ")])
        page.click("#task-add-open")
        r = page.evaluate("""() => { const b = document.getElementById('task-submit').getBoundingClientRect();
          const tb = document.querySelector('.tabbar').getBoundingClientRect(); return [b.bottom, tb.top]; }""")
        self.assertLessEqual(r[0], r[1])

    # ---------- 日報画面（D-026 ②, D-027） ----------
    def report_page(self, hour=21, minute=0, day=9, reports=None, size=(393, 852)):
        init = None
        if reports is not None:
            init = "localStorage.setItem('reports.v1', %s)" % json.dumps(json.dumps(reports))
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
        stored = json.loads(page.evaluate("localStorage.getItem('reports.v1')"))["2026-11-09"]
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
        self.assertIsNone(page.evaluate("localStorage.getItem('reports.v1')"))

    def test_report_before_4am_counts_as_previous_day(self):
        page = self.report_page(hour=1, minute=30, day=10)
        self.assertEqual(page.text_content("#report-date"), "11月9日(月)の日報")
        page.fill("#report-done", "夜ふかし")
        page.click("#report-save")
        self.assertIn("2026-11-09", json.loads(page.evaluate("localStorage.getItem('reports.v1')")))

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
        self.assertEqual(len(json.loads(page.evaluate("localStorage.getItem('reports.v1')"))), 16)  # データは消さない

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
            init = "localStorage.setItem('timer.v1', %s)" % json.dumps(json.dumps(state))
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
        if kw.get("state") is not None:
            init += "localStorage.setItem('timer.v1', %s);" % json.dumps(json.dumps(kw["state"]))
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
        return json.loads(page.evaluate("localStorage.getItem('timer.v1')"))

    def test_timer_lists_builtin_timers(self):
        page = self.timer_page()
        rows = page.eval_on_selector_all("#timer-list .task-main", "els => els.map(e => e.textContent)")
        self.assertEqual(rows, ["作業25分", "休憩5分", "入浴20分", "歯磨き3分"])
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
        rows = page.eval_on_selector_all("#timer-list .task-main", "els => els.map(e => e.textContent)")
        self.assertEqual(rows[-1], "ストレッチ10分")
        page.reload()
        page.wait_for_selector("#view-timer", state="visible")
        rows = page.eval_on_selector_all("#timer-list .task-main", "els => els.map(e => e.textContent)")
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
        self.assertTrue(body["url"].endswith("/index.html?source=webpush&trigger=timer_done.work&line=0#timer"), body["url"])
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
        init = "localStorage.setItem('timer.v1', %s)" % json.dumps(json.dumps(state))
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
        self.assertEqual(today[2], ["12:00", "昼食", False, True, "次 ・ あと2時間"])
        self.assertEqual(len(page.query_selector_all("#schedule-days .schedule-row.next")), 1)
        self.assertEqual(len(page.query_selector_all("#schedule-days .schedule-day:not([data-date='2026-11-09']) .schedule-row.past")), 0)
        # 予定のある日：終日が先、あとは時刻順に生活の時刻と混ざる
        sat = [r[:2] for r in self.schedule_rows(page, "2026-11-14")]
        self.assertEqual(sat[0], ["終日", "部屋の片づけ"])
        self.assertEqual(sat[2:4], [["09:00", "仕事開始"], ["10:00", "買い出し"]])
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
        self.assertEqual(self.schedule_rows(page, "2026-11-09")[2][4], "次 ・ あと1分")
        page.clock.run_for(62_000)  # 12:00 を過ぎる
        today = self.schedule_rows(page, "2026-11-09")
        self.assertEqual(today[2][2:], [True, False, None])
        self.assertEqual(today[3], ["15:00", "休憩", False, True, "次 ・ あと3時間"])

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
        self.assertTrue(page.is_hidden("#schedule-empty"))
        # 8日とも予定がない：キィニチの一言
        page.evaluate("SampleData.eventsOn = () => []; Schedule.refresh()")
        page.wait_for_function("document.getElementById('schedule-empty-line').textContent !== '…'", timeout=3_000)
        self.assertTrue(page.is_visible("#schedule-empty"))
        self.assertEqual(page.text_content("#schedule-empty-line"), "予定は入っていない。好きに使えばいい。")
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
        page.click("#task-add-open")
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
        self.assertIsNone(page.evaluate("localStorage.getItem('reports.v1')"))  # まだ日報としては保存していない
        page.click("#report-save")
        self.assertEqual(json.loads(page.evaluate("localStorage.getItem('reports.v1')"))["2026-11-09"]["done"], "書いている途中")
        self.assertIsNone(page.evaluate("localStorage.getItem('reports.draft')"))
        page.reload()
        page.wait_for_function("dialogue !== null")
        self.assertIn("保存済み", page.text_content("#report-status"))

    def test_report_saves_under_shown_date_across_4am(self):
        page = self.report_page(hour=3, minute=50, day=10)
        self.assertEqual(page.text_content("#report-date"), "11月9日(月)の日報")
        page.fill("#report-done", "深夜に書いた")
        page.clock.fast_forward(15 * 60_000)  # 4:05。画面は開いたまま
        page.click("#report-save")
        self.assertEqual(list(json.loads(page.evaluate("localStorage.getItem('reports.v1')"))), ["2026-11-09"])

    def test_report_old_draft_is_kept_as_that_days_report(self):
        page = self.report_page(hour=3, minute=50, day=10)
        page.fill("#report-done", "保存し忘れ")
        self.hide_and_return(page, 15 * 60_000)  # 4:05 に戻る
        self.assertEqual(page.text_content("#report-date"), "11月10日(火)の日報")
        self.assertEqual(page.input_value("#report-done"), "")
        self.assertEqual(json.loads(page.evaluate("localStorage.getItem('reports.v1')"))["2026-11-09"]["done"], "保存し忘れ")
        self.assertIn("保存し忘れ", page.text_content("#report-list"))

    def test_notification_params_are_removed_from_url(self):
        page = self.clock_page(12, 0, "&source=webpush&trigger=midday_check.meal_overdue&line=0#timer")
        self.assertEqual(page.text_content("#bubble-text"), "そろそろ飯の時間、過ぎてるぞ。")
        self.assertTrue(page.evaluate("document.body.classList.contains('from-notification')"))
        self.assertTrue(page.url.endswith("index.html?mode=standalone#timer"), page.url)
        page.reload()
        page.wait_for_function("dialogue !== null")
        self.assertFalse(page.evaluate("document.body.classList.contains('from-notification')"))
        self.assertNotEqual(page.text_content("#bubble-text"), "そろそろ飯の時間、過ぎてるぞ。")

    def test_timer_retries_cancel_that_did_not_reach_server(self):
        calls, offline = [], {"cancel": True}
        handler = self.worker_handler(calls, lambda path, m: None if path == "cancel" and offline["cancel"] else (200, {"ok": True, "subscribed": True}))
        page = self.routed_timer_page(calls, handler=handler)
        page.click("#timer-list li[data-id=work] .task-main")
        page.wait_for_selector("#timer-notify.ok", timeout=3_000)
        page.click("#timer-stop")
        page.wait_for_function("JSON.parse(localStorage.getItem('timer.v1')).cancelPending === true", timeout=3_000)
        offline["cancel"] = False
        page.reload()  # 開き直したときにやり直す
        page.wait_for_function("JSON.parse(localStorage.getItem('timer.v1')).cancelPending === false", timeout=3_000)
        self.assertEqual([c for c in calls if c != "status"], ["schedule", "cancel", "cancel"])

    def test_timer_pending_cancel_does_not_cancel_new_timer(self):
        calls, offline = [], {"cancel": True}
        handler = self.worker_handler(calls, lambda path, m: None if path == "cancel" and offline["cancel"] else (200, {"ok": True, "subscribed": True}))
        page = self.routed_timer_page(calls, handler=handler)
        page.click("#timer-list li[data-id=work] .task-main")
        page.wait_for_selector("#timer-notify.ok", timeout=3_000)
        page.click("#timer-stop")
        page.wait_for_function("JSON.parse(localStorage.getItem('timer.v1')).cancelPending === true", timeout=3_000)
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
        page.click("#task-add-open")
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
