#!/usr/bin/env python3
"""Проверка доступности открытых источников для анализа участка.

Запускается с двух мест (workflow probe-sources.yml): с сервера в России и с
зарубежного сервера GitHub. Нужна, чтобы понять, какие источники сервис может
опрашивать сам, а какие закрыты (геоблок, защита от ботов, требуется вход).

Только стандартная библиотека Python 3 — на сервере ничего ставить не нужно.
Ничего не сохраняет и не меняет: только GET/POST-запросы на чтение.

Использование:  python3 probe_sources.py --label server --address "..."
"""
import argparse
import json
import socket
import ssl
import time
import urllib.error
import urllib.parse
import urllib.request

UA = "finmodel-source-probe/0.1"
TIMEOUT = 20


def fetch(url, data=None, headers=None):
    """Один запрос. Возвращает dict: статус, время, размер, тип, тело (до 200 КБ), ошибка."""
    h = {"User-Agent": UA, "Accept": "*/*"}
    h.update(headers or {})
    req = urllib.request.Request(url, data=data, headers=h)
    t0 = time.time()
    res = {"url": url, "status": None, "ms": None, "bytes": 0, "ctype": "", "error": ""}
    body = b""
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT, context=ssl.create_default_context()) as r:
            body = r.read(200_000)
            res["status"] = r.status
            res["ctype"] = r.headers.get("Content-Type", "")
    except urllib.error.HTTPError as e:
        res["status"] = e.code
        res["ctype"] = e.headers.get("Content-Type", "") if e.headers else ""
        try:
            body = e.read(20_000)
        except Exception:
            pass
    except (urllib.error.URLError, socket.timeout, ssl.SSLError, ConnectionError, OSError) as e:
        res["error"] = f"{type(e).__name__}: {getattr(e, 'reason', e)}"[:160]
    res["ms"] = int((time.time() - t0) * 1000)
    res["bytes"] = len(body)
    return res, body


def captcha_hint(body):
    low = body[:20_000].decode("utf-8", "ignore").lower()
    for w in ("captcha", "капча", "ddos-guard", "qrator", "servicepipe", "access denied", "доступ запрещ"):
        if w in low:
            return w
    return ""


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--label", default="local")
    ap.add_argument("--address", default="Москва, Лялин переулок, 21 с2")
    a = ap.parse_args()

    rows = []

    def add(name, purpose, res, body, note=""):
        hint = captcha_hint(body) if body else ""
        if hint:
            note = (note + "; " if note else "") + f"похоже на защиту от ботов ({hint})"
        rows.append({"source": name, "purpose": purpose, **res, "note": note})

    # Публичный IP и страна сервера (чтобы понимать, откуда шёл запрос)
    r, b = fetch("https://ipinfo.io/json")
    where = ""
    try:
        j = json.loads(b)
        where = f"{j.get('ip', '')} {j.get('country', '')} {j.get('org', '')}".strip()
    except Exception:
        where = r["error"] or f"HTTP {r['status']}"

    # 1. Геокодер OSM (Nominatim): адрес → координаты
    q = urllib.parse.urlencode({"q": a.address, "format": "jsonv2", "limit": 1})
    r, b = fetch(f"https://nominatim.openstreetmap.org/search?{q}")
    lat = lon = None
    note = ""
    try:
        j = json.loads(b)
        if j:
            lat, lon = float(j[0]["lat"]), float(j[0]["lon"])
            note = f"{j[0].get('display_name', '')[:90]} → {lat:.5f}, {lon:.5f}"
        else:
            note = "адрес не найден"
    except Exception:
        pass
    add("OSM Nominatim", "адрес → координаты", r, b, note)

    # 2. Overpass (OSM): здания в радиусе 60 м от точки
    if lat is not None:
        oq = f"[out:json][timeout:15];way(around:60,{lat},{lon})[building];out tags;"
        r, b = fetch("https://overpass-api.de/api/interpreter",
                     data=urllib.parse.urlencode({"data": oq}).encode())
        note = ""
        try:
            note = f"зданий рядом: {len(json.loads(b).get('elements', []))}"
        except Exception:
            pass
        add("OSM Overpass", "контуры и этажность зданий", r, b, note)

    # 3. Москва и федеральные сайты: только доступность главной/корня API
    simple = [
        ("Открытые данные Москвы, API", "реестры города (по ключу)", "https://apidata.mos.ru/v1/datasets"),
        ("Портал открытых данных Москвы", "реестры города", "https://data.mos.ru/"),
        ("ИАИС ОГД (isogd.mos.ru)", "ПЗЗ, зоны ОКН, ГПЗУ", "https://isogd.mos.ru/"),
        ("mos.ru", "акты Правительства Москвы", "https://www.mos.ru/"),
        ("НСПД", "кадастр, границы, зоны", "https://nspd.gov.ru/"),
        ("Росреестр", "кадастр (справочно)", "https://rosreestr.gov.ru/"),
        ("Минкультуры, открытые данные", "реестр ОКН", "https://opendata.mkrf.ru/"),
        ("наш.дом.рф", "новостройки-аналоги, цены", "https://xn--80az8a.xn--d1aqf.xn--p1ai/"),
        ("pravo.gov.ru", "тексты законов", "http://publication.pravo.gov.ru/"),
        ("КонсультантПлюс", "редакции актов", "https://www.consultant.ru/"),
        ("Гарант", "редакции актов", "https://base.garant.ru/"),
        ("Банк России", "ключевая ставка", "https://www.cbr.ru/scripts/XML_daily.asp"),
        ("Яндекс Геокодер", "адрес → координаты (по ключу)", "https://geocode-maps.yandex.ru/1.x/?format=json&geocode=test"),
    ]
    for name, purpose, url in simple:
        r, b = fetch(url)
        add(name, purpose, r, b)

    # 4. НСПД: поиск по адресу (неофициальный API карты; только проверка доступа)
    q = urllib.parse.urlencode({"query": a.address})
    r, b = fetch(f"https://nspd.gov.ru/api/geoportal/v2/search/geoportal?{q}",
                 headers={"Accept": "application/json", "Referer": "https://nspd.gov.ru/map"})
    add("НСПД, поиск по адресу", "кадастровый номер по адресу", r, b,
        "данные НСПД в пилоте не используются, проверяется только доступ")

    # 5. Мосбиржа: доходности ОФЗ (для ставки дисконтирования)
    r, b = fetch("https://iss.moex.com/iss/engines/stock/markets/bonds/boards/TQOB/securities.json"
                 "?iss.meta=off&iss.only=marketdata&marketdata.columns=SECID,YIELD")
    note = ""
    try:
        note = f"выпусков ОФЗ: {len(json.loads(b)['marketdata']['data'])}"
    except Exception:
        pass
    add("Мосбиржа ISS", "доходность ОФЗ", r, b, note)

    out = {"label": a.label, "where": where, "address": a.address,
           "time_utc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "rows": rows}
    print("JSON:" + json.dumps(out, ensure_ascii=False))

    print(f"\n### Запуск: {a.label} ({where}), {out['time_utc']}\n")
    print("| Источник | Для чего | Ответ | мс | Байт | Примечание |")
    print("|---|---|---|---|---|---|")
    for x in rows:
        ans = f"HTTP {x['status']}" if x["status"] else (x["error"] or "нет ответа")
        print(f"| {x['source']} | {x['purpose']} | {ans} | {x['ms']} | {x['bytes']} | {x['note']} |")


if __name__ == "__main__":
    main()
