"""Проверки сборщика без сети: python3 -m unittest services/collector/test_collector.py"""
import json
import os
import sys
import threading
import unittest
import urllib.request
from unittest import mock

sys.path.insert(0, os.path.dirname(__file__))
import collector  # noqa: E402


class CollectorTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        collector.TOKEN = "t"
        cls.srv = collector.ThreadingHTTPServer(("127.0.0.1", 0), collector.Handler)
        cls.port = cls.srv.server_address[1]
        threading.Thread(target=cls.srv.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.srv.shutdown()

    def get(self, path, token="t"):
        req = urllib.request.Request(f"http://127.0.0.1:{self.port}{path}",
                                     headers={"X-Collector-Token": token} if token else {})
        try:
            with urllib.request.urlopen(req) as r:
                return r.status, json.loads(r.read())
        except urllib.error.HTTPError as e:
            return e.code, json.loads(e.read())

    def test_health_without_token(self):
        s, j = self.get("/health", token=None)
        self.assertEqual(s, 200)
        self.assertTrue(j["ok"])

    def test_token_required(self):
        self.assertEqual(self.get("/v1/geocode?address=x", token=None)[0], 401)
        self.assertEqual(self.get("/v1/geocode?address=x", token="wrong")[0], 401)

    def test_param_required(self):
        self.assertEqual(self.get("/v1/geocode")[0], 400)

    def test_geocode_and_cache(self):
        rows = [{"lat": "55.75756", "lon": "37.65373", "display_name": "Лялин переулок, 21с2"}]
        with mock.patch.object(collector, "fetch_json", return_value=rows) as f, \
                mock.patch.object(collector.NOMINATIM_PACE, "wait"):
            s, j = self.get("/v1/geocode?address=%D0%9B%D1%8F%D0%BB%D0%B8%D0%BD%2021")
            s2, j2 = self.get("/v1/geocode?address=%D0%9B%D1%8F%D0%BB%D0%B8%D0%BD%2021")
        self.assertEqual(s, 200)
        self.assertEqual(j["source"], "nominatim")
        self.assertAlmostEqual(j["data"][0]["lat"], 55.75756)
        self.assertFalse(j["cached"])
        self.assertTrue(j2["cached"])
        self.assertEqual(f.call_count, 1)

    def test_source_error(self):
        with mock.patch.object(collector, "fetch_json",
                               side_effect=collector.SourceError("источник ответил HTTP 403")):
            s, j = self.get("/v1/geocode?address=x")
        self.assertEqual(s, 502)
        self.assertIn("403", j["error"])


if __name__ == "__main__":
    unittest.main()
