#!/usr/bin/env python3
"""Сборщик данных об участке. Работает на сервере в России (Хостленд).

Зачем: источники по участку (НСПД, открытые данные Москвы, реестр ОКН)
не отвечают зарубежным серверам, а интерфейс и расчёт работают на Vercel.
Сборщик принимает запрос от сервиса, сам обращается к источнику и возвращает
ответ как есть, с отметкой источника и времени. Ничего не рассчитывает:
вся арифметика — в packages/engine (CLAUDE.md).

Только стандартная библиотека Python 3, на сервере ничего ставить не нужно.
Слушает только 127.0.0.1; снаружи доступен через nginx (deploy/server/).

Запросы (все GET, ответ JSON):
  /health                         — жив ли сборщик (без токена)
  /v1/geocode?address=...         — адрес → координаты (OSM Nominatim)
  /v1/nspd/search?query=...       — НСПД: поиск по кадастровому номеру или адресу

Доступ — по заголовку X-Collector-Token (значение в файле ~/collector/.env,
переменная COLLECTOR_TOKEN). Без токена сборщик стал бы открытым прокси.
"""
import hmac
import json
import os
import ssl
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

VERSION = "0.1.0"
HERE = os.path.dirname(os.path.abspath(__file__))
UA = f"finmodel-collector/{VERSION} (+https://finmodel.orientirgpz.com)"

HOST = os.environ.get("COLLECTOR_HOST", "127.0.0.1")
PORT = int(os.environ.get("COLLECTOR_PORT", "3300"))
TOKEN = os.environ.get("COLLECTOR_TOKEN", "")
TIMEOUT = 25  # с, на один запрос к источнику
CACHE_TTL = 24 * 3600  # с; данные участка за сутки не меняются
CACHE_MAX = 500
MAX_BODY = 2_000_000  # байт, предел ответа источника
# Российский корневой сертификат (Минцифры) — только для запросов сборщика,
# в систему не ставится. Скачивается при развёртывании (deploy.sh).
RU_CA = os.path.join(HERE, "certs", "russian_trusted_root_ca.pem")

SOURCES = {
    "nominatim": "OSM Nominatim (nominatim.openstreetmap.org), ODbL",
    "nspd": "НСПД (nspd.gov.ru), публичная кадастровая карта",
}


def ssl_context(ru=False):
    ctx = ssl.create_default_context()
    if ru and os.path.exists(RU_CA):
        ctx.load_verify_locations(RU_CA)
    return ctx


class Cache:
    def __init__(self, ttl=CACHE_TTL, size=CACHE_MAX):
        self.ttl, self.size, self.d, self.lock = ttl, size, {}, threading.Lock()

    def get(self, k):
        with self.lock:
            v = self.d.get(k)
            if v and time.time() - v[0] < self.ttl:
                return v[1]
            self.d.pop(k, None)
            return None

    def put(self, k, val):
        with self.lock:
            if len(self.d) >= self.size:
                self.d.pop(min(self.d, key=lambda x: self.d[x][0]))
            self.d[k] = (time.time(), val)


class Pace:
    """Не чаще одного запроса в interval секунд к одному источнику (правила Nominatim)."""

    def __init__(self, interval):
        self.interval, self.last, self.lock = interval, 0.0, threading.Lock()

    def wait(self):
        with self.lock:
            dt = time.time() - self.last
            if dt < self.interval:
                time.sleep(self.interval - dt)
            self.last = time.time()


CACHE = Cache()
NOMINATIM_PACE = Pace(1.0)


class SourceError(Exception):
    def __init__(self, msg, status=502):
        super().__init__(msg)
        self.status = status


def fetch_json(url, headers=None, ru=False):
    h = {"User-Agent": UA, "Accept": "application/json"}
    h.update(headers or {})
    req = urllib.request.Request(url, headers=h)
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT, context=ssl_context(ru)) as r:
            body = r.read(MAX_BODY + 1)
    except urllib.error.HTTPError as e:
        raise SourceError(f"источник ответил HTTP {e.code}")
    except (urllib.error.URLError, OSError) as e:
        raise SourceError(f"источник недоступен: {getattr(e, 'reason', e)}"[:200], 504)
    if len(body) > MAX_BODY:
        raise SourceError("ответ источника слишком большой")
    try:
        return json.loads(body)
    except ValueError:
        raise SourceError("источник вернул не JSON (возможно, защита от ботов)")


def envelope(source, url, data):
    return {"source": source, "source_name": SOURCES[source], "url": url,
            "fetched_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "data": data}


def cached(key, fn):
    v = CACHE.get(key)
    if v is not None:
        return {**v, "cached": True}
    v = fn()
    CACHE.put(key, v)
    return {**v, "cached": False}


def geocode(address):
    q = urllib.parse.urlencode({"q": address, "format": "jsonv2", "limit": 5,
                                "addressdetails": 1, "countrycodes": "ru"})
    url = f"https://nominatim.openstreetmap.org/search?{q}"

    def run():
        NOMINATIM_PACE.wait()
        rows = fetch_json(url)
        items = [{"lat": float(x["lat"]), "lon": float(x["lon"]),
                  "display_name": x.get("display_name", ""),
                  "type": x.get("type", ""), "address": x.get("address", {})} for x in rows]
        return envelope("nominatim", url, items)

    return cached(("geo", address.strip().lower()), run)


def nspd_search(query):
    q = urllib.parse.urlencode({"query": query})
    url = f"https://nspd.gov.ru/api/geoportal/v2/search/geoportal?{q}"

    def run():
        data = fetch_json(url, headers={"Referer": "https://nspd.gov.ru/map"}, ru=True)
        return envelope("nspd", url, data)

    return cached(("nspd", query.strip().lower()), run)


ROUTES = {
    "/v1/geocode": ("address", geocode),
    "/v1/nspd/search": ("query", nspd_search),
}


class Handler(BaseHTTPRequestHandler):
    server_version = f"finmodel-collector/{VERSION}"

    def send(self, status, obj):
        b = json.dumps(obj, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(b)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(b)

    def do_GET(self):
        u = urllib.parse.urlparse(self.path)
        if u.path == "/health":
            return self.send(200, {"ok": True, "version": VERSION,
                                   "ru_ca": os.path.exists(RU_CA)})
        route = ROUTES.get(u.path)
        if not route:
            return self.send(404, {"error": "нет такого запроса"})
        given = self.headers.get("X-Collector-Token", "")
        if not TOKEN or not hmac.compare_digest(given, TOKEN):
            return self.send(401, {"error": "нужен токен доступа"})
        param, fn = route
        value = (urllib.parse.parse_qs(u.query).get(param) or [""])[0].strip()
        if not value or len(value) > 300:
            return self.send(400, {"error": f"параметр {param} обязателен, до 300 символов"})
        try:
            return self.send(200, fn(value))
        except SourceError as e:
            return self.send(e.status, {"error": str(e)})

    def log_message(self, fmt, *args):
        # В журнал — только путь без параметров: адреса участков не пишем.
        sys.stderr.write("%s %s\n" % (self.command, urllib.parse.urlparse(self.path).path))


def main():
    if not TOKEN:
        print("COLLECTOR_TOKEN не задан: запросы к источникам будут отклоняться", file=sys.stderr)
    srv = ThreadingHTTPServer((HOST, PORT), Handler)
    srv.daemon_threads = True
    print(f"finmodel-collector {VERSION} на {HOST}:{PORT}", file=sys.stderr, flush=True)
    srv.serve_forever()


if __name__ == "__main__":
    main()
