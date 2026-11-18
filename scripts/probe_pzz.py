#!/usr/bin/env python3
"""Проверка карты ПЗЗ Москвы (ИАИС ОГД) с сервера в России: открывается ли портал
и какие адреса данных он использует. Только чтение, стандартная библиотека.

Использование:  python3 probe_pzz.py
"""
import re
import sys
import urllib.parse

if True:
    import signal, socket, ssl, time, urllib.error, urllib.request

    def fetch(url, data=None, headers=None):
        h = {"User-Agent": "Mozilla/5.0 (finmodel-pzz-probe)", "Accept": "*/*"}
        h.update(headers or {})
        req = urllib.request.Request(url, data=data, headers=h)
        t0 = time.time()
        res = {"status": None, "ms": 0, "bytes": 0, "ctype": "", "error": "", "final": url}
        body = b""
        def _a(*_):
            raise TimeoutError("hard limit")
        signal.signal(signal.SIGALRM, _a)
        signal.alarm(60)
        try:
            with urllib.request.urlopen(req, timeout=45, context=ssl.create_default_context()) as r:
                body = r.read(3_000_000)
                res["status"], res["ctype"], res["final"] = r.status, r.headers.get("Content-Type", ""), r.geturl()
        except urllib.error.HTTPError as e:
            res["status"] = e.code
            try:
                body = e.read(5000)
            except Exception:
                pass
        except Exception as e:
            res["error"] = f"{type(e).__name__}: {getattr(e, 'reason', e)}"[:200]
        finally:
            signal.alarm(0)
        res["ms"] = int((time.time() - t0) * 1000)
        res["bytes"] = len(body)
        return res, body

LAT, LON = 55.8076, 37.7426  # Рябиновая ул. — примерная точка, только для проверки ответа

URLS = [
    "https://isogd.mos.ru/",
    "https://isogd.mos.ru/isogd-portal/home",
    "https://isogd.mos.ru/isogd-portal/gis/none/none",
    "https://isogd.mos.ru/isogd-portal/gisByProfile/none/none/11",
    "http://isogd.mos.ru/",
    "https://gisogd.mos.ru/",
    "https://egip.mos.ru/",
    "https://mka.mos.ru/",
    "https://www.mos.ru/mka/",
    "https://rgis.mosreg.ru/",
]


def show(url, res, body):
    ans = f"HTTP {res['status']}" if res["status"] else res["error"]
    print(f"\n## {url}\n{ans}, {res['ms']} мс, {res['bytes']} байт, {res.get('ctype','')}, итог: {res.get('final', url)}")
    txt = body[:1500].decode("utf-8", "ignore")
    print(re.sub(r"\s+", " ", txt)[:700])


def main():
    js = set()
    for u in URLS:
        r, b = fetch(u)
        show(u, r, b)
        if "isogd" in u and b:
            for m in re.findall(r'(?:src|href)="([^"]+\.js[^"]*)"', b.decode("utf-8", "ignore")):
                js.add(urllib.parse.urljoin(r.get("final", u), m))
    print("\n# Скрипты портала и адреса данных в них")
    for u in sorted(js)[:15]:
        r, b = fetch(u)
        t = b.decode("utf-8", "ignore")
        found = sorted(set(re.findall(r'["\'`]((?:https?:)?/[^"\'`\s]{0,80}(?:api|wms|wfs|geoserver|arcgis|rest|ows|identify|pzz|zone|layer)[^"\'`\s]{0,80})["\'`]', t, re.I)))
        print(f"\n## {u}: HTTP {r['status']}, {r['bytes']} байт, адресов: {len(found)}")
        for f in found[:80]:
            print("  ", f)


if __name__ == "__main__":
    main()
