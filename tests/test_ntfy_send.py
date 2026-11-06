"""ntfy_send.py の検証。本物の ntfy には送らず、ローカルの偽サーバーで受け取った内容を確認する。"""
import json
import sys
import threading
import unittest
from datetime import datetime
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))
import ntfy_send  # noqa: E402


class FakeNtfy(BaseHTTPRequestHandler):
    received = []

    def do_POST(self):
        body = self.rfile.read(int(self.headers["Content-Length"]))
        FakeNtfy.received.append({"path": self.path, "headers": dict(self.headers), "body": json.loads(body)})
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(json.dumps({"id": "fake123", "time": 1_800_000_000}).encode())

    def log_message(self, *a):
        pass


class NtfySendTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = HTTPServer(("127.0.0.1", 0), FakeNtfy)
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()
        cls.env = {
            "NTFY_TOPIC": "test-topic",
            "NTFY_SERVER": f"http://127.0.0.1:{cls.server.server_port}",
            "APP_URL": "https://example.invalid/app/index.html",
        }

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()

    def setUp(self):
        FakeNtfy.received.clear()

    def test_immediate_send_with_click_url(self):
        payload = ntfy_send.build_payload(self.env, "タイトル", "本文")
        result = ntfy_send.send(self.env, payload)
        self.assertEqual(result["id"], "fake123")
        got = FakeNtfy.received[0]
        self.assertEqual(got["path"], "/")
        self.assertEqual(got["body"]["topic"], "test-topic")
        self.assertEqual(got["body"]["title"], "タイトル")  # 日本語がそのまま届く
        self.assertEqual(got["body"]["click"], "https://example.invalid/app/index.html?source=ntfy")
        self.assertNotIn("delay", got["body"])
        self.assertNotIn("Authorization", got["headers"])

    def test_token_header_when_set(self):
        env = dict(self.env, NTFY_TOKEN="tk_dummy")
        ntfy_send.send(env, ntfy_send.build_payload(env, "t", "m"))
        self.assertEqual(FakeNtfy.received[0]["headers"]["Authorization"], "Bearer tk_dummy")

    def test_missing_topic_stops(self):
        with self.assertRaises(SystemExit):
            ntfy_send.build_payload({}, "t", "m")


if __name__ == "__main__":
    unittest.main()
