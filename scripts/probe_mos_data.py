#!/usr/bin/env python3
"""Какие наборы портала открытых данных Москвы годятся для автозаполнения участка.

Запускается на сервере в России (workflow mos-datasets.yml) от пользователя finmodel.
Ключ берётся из ~/web/.env (DATA_MOS_API_KEY) и никуда не выводится: в журнал идут
только номера наборов, названия, число записей и поля. Только чтение.

Ищет в каталоге наборы про объекты культурного наследия и зоны, затем для наборов
с геоданными смотрит, что лежит рядом с точкой участка (по умолчанию Лялин пер., 21 с2).
"""
import json
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request

API = "https://apidata.mos.ru/v1"
UA = "finmodel-mos-probe/0.1"
LAT, LON = 55.75756, 37.65373  # Лялин пер., 21 с2 — по геокодеру OpenStreetMap с сервера, 16.11.2026
D = 0.004  # полуширина окна поиска, градусы (~300–450 м)
WORDS = re.compile(r"кадастр|стоимост|оценк|земельн|участ|ПЗЗ|землепольз|градостро|ГПЗУ|аренд", re.I)


def key():
    k = os.environ.get("DATA_MOS_API_KEY", "")
    if not k:
        try:
            for line in open(os.path.expanduser("~/web/.env"), encoding="utf-8"):
                if line.startswith("DATA_MOS_API_KEY="):
                    k = line.split("=", 1)[1].strip()
        except OSError:
            pass
    return k


KEY = key()


def get(path, **params):
    params["api_key"] = KEY
    url = f"{API}{path}?{urllib.parse.urlencode(params)}"
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return r.status, json.loads(r.read(30_000_000))
    except urllib.error.HTTPError as e:
        return e.code, None
    except Exception as e:  # адрес с ключом не печатаем
        return type(e).__name__, None


def site_geocode():
    """Поиск по адресу через сам сайт на сервере (127.0.0.1:3400): ответ, время, число мест; журнал службы."""
    import subprocess, time
    for q in ["Москва, Лялин переулок, 21 с2"]:
        url = "http://127.0.0.1:3400/api/geocode?" + urllib.parse.urlencode({"q": q})
        t0 = time.time()
        try:
            with urllib.request.urlopen(url, timeout=90) as r:
                body = r.read(200_000)
                st = r.status
        except urllib.error.HTTPError as e:
            st, body = e.code, e.read(2000)
        except Exception as e:
            st, body = type(e).__name__, b""
        ms = int((time.time() - t0) * 1000)
        try:
            data = json.loads(body)
            info = f"мест: {len(data)}" if isinstance(data, list) else str(data)[:200]
            if isinstance(data, list) and data:
                info += f"; первое: {data[0].get('display_name', '')[:120]}; части адреса: {json.dumps(data[0].get('address', {}), ensure_ascii=False)}"
        except Exception:
            info = body[:200].decode("utf-8", "ignore")
        print(f"Сайт /api/geocode «{q}»: ответ {st}, {ms} мс, {info}")
    try:
        out = subprocess.run(["journalctl", "--user", "-u", "finmodel-web", "-n", "5", "--no-pager", "-o", "cat"],
                             capture_output=True, text=True, timeout=20).stdout
        print("Журнал сайта (последние строки):")
        print(out[-4000:])
    except Exception as e:
        print(f"журнал недоступен: {type(e).__name__}")
    print()


def fetch(url, n=3_000_000):
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 (finmodel-probe)"})
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return r.status, r.read(n).decode("utf-8", "ignore")
    except urllib.error.HTTPError as e:
        return e.code, ""
    except Exception as e:
        return type(e).__name__, ""


def inside(pt, ring):
    x, y = pt
    c = False
    for i in range(len(ring)):
        x1, y1 = ring[i - 1][:2]
        x2, y2 = ring[i][:2]
        if (y1 > y) != (y2 > y) and x < (x2 - x1) * (y - y1) / (y2 - y1 + 1e-15) + x1:
            c = not c
    return c


def covers(geom, pt):
    t, cs = geom.get("type"), geom.get("coordinates") or []
    polys = cs if t == "MultiPolygon" else [cs] if t == "Polygon" else []
    return any(p and inside(pt, p[0]) for p in polys)


def main():
    # 1) Распоряжение ДГИ 214856 (средние УПКС) — где лежит приложение
    for url in ["https://base.garant.ru/411053384/", "https://base.garant.ru/411053384/53f89421bbdaf741eb2d1ecc4ddb4c33/"]:
        st, html = fetch(url)
        links = sorted(set(re.findall(r'(?:href|src|data-url)="([^"]+)"', html)))
        good = [l for l in links if re.search(r"pdf|411053384|files|attach|xls|zip", l, re.I)]
        print(f"{url}: ответ {st}, длина {len(html)}; ссылки: {good[:40]}")
        m = re.findall(r"[^<>]{0,200}(?:кадастров\w* квартал|групп\w* вид)[^<>]{0,200}", html)
        print("  текст:", [x.strip()[:300] for x in m[:8]])
    for url in ["https://www.mos.ru/dgi/documents/", "https://rosreestr.gov.ru/", "https://cipp.mos.ru/", "https://nspd.gov.ru/"]:
        st, html = fetch(url, 200_000)
        print(f"{url}: ответ {st}, длина {len(html)}")
    if not KEY:
        print("Ключа нет")
        return 1
    bbox = f"{LON - D},{LAT - D},{LON + D},{LAT + D}"
    # 2) Участки города (1497): какой содержит точку, все его поля
    st, fc = get("/datasets/1497/features", bbox=bbox)
    feats = fc.get("features", []) if isinstance(fc, dict) else []
    hit = [f for f in feats if covers(f.get("geometry") or {}, (LON, LAT))]
    print(f"\n[1497] участков рядом {len(feats)}, содержат точку: {len(hit)}")
    for f in hit[:3]:
        print("   ", str((f.get("properties") or {}).get("attributes"))[:3000])
    if feats and not hit:
        print("   пример:", str((feats[0].get("properties") or {}).get("attributes"))[:3000])
    # 3) ПЗЗ (61641), реестр ГПЗУ (3012): поля и первые строки
    for i in (61641, 3012):
        st, rows = get(f"/datasets/{i}/rows", **{"$top": 2})
        print(f"\n[{i}] строки: ответ {st}: {json.dumps(rows, ensure_ascii=False)[:2500] if rows else '-'}")
        st, cnt = get(f"/datasets/{i}/count")
        print(f"   записей: {cnt}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
