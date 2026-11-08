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
        self.assertIn("ready", page.get_attribute("#play-voice", "class"))

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
                  const v = document.getElementById('play-voice').getBoundingClientRect();
                  const acts = [...document.querySelectorAll('.act')].map((b) => {
                    const lh = parseFloat(getComputedStyle(b).lineHeight) || parseFloat(getComputedStyle(b).fontSize) * 1.3;
                    return { h: b.getBoundingClientRect().height, sw: b.scrollWidth, cw: b.clientWidth, top: b.getBoundingClientRect().top };
                  });
                  return { sh: document.documentElement.scrollHeight, ih: innerHeight,
                           vTop: v.top, vH: v.height, acts };
                }""")
                self.assertLessEqual(m["sh"], m["ih"], f"{size} ではみ出している")
                self.assertGreaterEqual(m["vH"], 44)
                self.assertGreater(m["vTop"], m["ih"] / 2, "声を聞くは下半分に（I1-02）")
                for a in m["acts"]:
                    self.assertLessEqual(a["sw"], a["cw"], "記録ボタンのラベルが収まっていない")
                    self.assertGreater(a["top"], m["ih"] / 2)

    def test_clock_size_matches_decision(self):
        page = self.clock_page(9, 3)
        size = page.eval_on_selector("#clock-time", "e => parseFloat(getComputedStyle(e).fontSize)")
        self.assertEqual(size, 28)

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
                self.assertNotIn("ready", page.get_attribute("#play-voice", "class") or "")

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

    # ---------- 声を聞く（T06） ----------
    def test_voice_label_resets_on_new_line(self):
        page = self.clock_page(12, 41, "&source=webpush&trigger=midday_check.meal_overdue&line=0")
        page.wait_for_function("document.getElementById('bubble-text').textContent.includes('飯')", timeout=3_000)
        self.assertEqual(page.get_attribute("#play-voice", "data-state"), "idle")
        self.assertEqual(page.text_content("#play-voice .voice-label"), "声を聞く")
        page.click("#play-voice")
        page.clock.run_for(3_000)
        page.wait_for_function("document.getElementById('play-voice').dataset.state === 'ended'", timeout=5_000)
        self.assertEqual(page.text_content("#play-voice .voice-label"), "もう一度聞く")
        self.assertNotIn("ready", page.get_attribute("#play-voice", "class"))
        page.click(".act[data-record=work_start]")
        self.assertEqual(page.get_attribute("#play-voice", "data-state"), "idle")
        self.assertEqual(page.text_content("#play-voice .voice-label"), "声を聞く")

    # ---------- 主ボタンは 1 つ（T08, D-019 Q7=保存する） ----------
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
        self.assertEqual(self.primaries(page), [])
        self.assertIn("ready", page.get_attribute("#play-voice", "class"))

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
        # 通知から開いた直後（12:41）：塗りは「声を聞く」だけ、枠は名前欄・セリフの面・声を聞くだけ
        page = self.clock_page(12, 41, "&source=webpush&trigger=midday_check.meal_overdue&line=0")
        page.wait_for_function("document.body.classList.contains('from-notification')", timeout=3_000)
        r = page.evaluate(self.ACCENT_SCAN, [".nameplate", ".dialogue", "#play-voice"])
        self.assertEqual(r["bg"], ["play-voice"], r)
        self.assertEqual(r["borderBad"], [], r)


if __name__ == "__main__":
    unittest.main()
