#!/usr/bin/env python3
"""Проверка с сервера в России: где взять площадь строений по адресу (для площади сноса).
Только чтение, стандартная библиотека. Ключ портала Москвы — из ~/web/.env, в вывод не попадает.
НСПД не запрашивается (решение пользователя: в пилоте не использовать).
"""
import json, os, re, signal, ssl, time, urllib.error, urllib.parse, urllib.request

ADDRESSES = ["Москва, Рябиновая улица, 28А с1", "Москва, Рябиновая улица, 28А", "Москва, Лялин переулок, 21 с2"]
WORDS = re.compile(r"здан|строен|адресн|недвиж|нежил|жил.*фонд|многоквартир|БТИ|капитальн|сооружен|снос|площад", re.I)


def fetch(url, data=None, headers=None, limit=6_000_000):
    h = {"User-Agent": "finmodel-ocenka/1.0 (+https://ocenka.orientirgpz.com)", "Accept": "application/json"}
    h.update(headers or {})
    def _a(*_):
        raise TimeoutError("hard limit")
    signal.signal(signal.SIGALRM, _a)
    signal.alarm(90)
    try:
        with urllib.request.urlopen(urllib.request.Request(url, data=data, headers=h), timeout=75, context=ssl.create_default_context()) as r:
            return r.status, r.read(limit)
    except urllib.error.HTTPError as e:
        return e.code, e.read(3000)
    except Exception as e:
        return None, f"{type(e).__name__}: {e}".encode()[:300]
    finally:
        signal.alarm(0)


def key():
    try:
        for line in open(os.path.expanduser("~/web/.env"), encoding="utf-8"):
            if line.startswith("DATA_MOS_API_KEY="):
                return line.split("=", 1)[1].strip()
    except OSError:
        pass
    return ""


def short(v, n=160):
    s = json.dumps(v, ensure_ascii=False) if not isinstance(v, str) else v
    return s if len(s) <= n else s[:n] + "…"


def main():
    k = key()
    print("ключ портала:", "есть" if k else "нет")
    points = {}
    print("\n### Геокодер")
    for a in ADDRESSES:
        st, b = fetch("https://nominatim.openstreetmap.org/search?" + urllib.parse.urlencode({"q": a, "format": "jsonv2", "limit": 5, "addressdetails": 1, "extratags": 1, "polygon_geojson": 1, "countrycodes": "ru"}))
        try:
            rows = json.loads(b)
        except Exception:
            print(a, st, short(b.decode("utf-8", "replace"))); continue
        print(f"{a}: {st}, найдено {len(rows)}")
        for r in rows:
            g = r.get("geojson") or {}
            print("  ", r.get("display_name"), r.get("lat"), r.get("lon"), r.get("category"), r.get("type"), "osm", r.get("osm_type"), r.get("osm_id"), "контур:", g.get("type"), "теги:", short(r.get("extratags"), 300))
            points.setdefault(a, (float(r["lat"]), float(r["lon"])))
        time.sleep(1.2)
    p = points.get(ADDRESSES[0]) or points.get(ADDRESSES[1]) or (55.7, 37.4)

    print("\n### Overpass: здания у точки", p)
    oq = f"[out:json][timeout:40];way(around:120,{p[0]},{p[1]})[building];out tags geom;"
    st, b = fetch("https://overpass-api.de/api/interpreter", data=urllib.parse.urlencode({"data": oq}).encode())
    try:
        for e in json.loads(b).get("elements", [])[:30]:
            print("  way", e.get("id"), short(e.get("tags"), 400), "точек:", len(e.get("geometry") or []))
    except Exception:
        print("  ", st, short(b.decode("utf-8", "replace")))

    if not k:
        return
    print("\n### Каталог портала Москвы: наборы про здания")
    st, b = fetch(f"https://apidata.mos.ru/v1/datasets?api_key={urllib.parse.quote(k)}", limit=30_000_000)
    try:
        cat = json.loads(b)
    except Exception:
        print(st, short(b.decode("utf-8", "replace"))); cat = []
    if isinstance(cat, dict):
        cat = cat.get("Items") or cat.get("items") or cat.get("value") or []
    found = []
    for d in cat:
        cap = str(d.get("Caption") or d.get("caption") or "")
        if WORDS.search(cap):
            found.append(d)
            print(f"  {d.get('Id')} | {cap} | гео: {d.get('ContainsGeodata')} | записей: {d.get('ItemsCount')} | архив: {d.get('IsArchive')}")
    print("всего наборов в каталоге:", len(cat), "подходящих:", len(found))

    geo = [d for d in found if d.get("ContainsGeodata") and not d.get("IsArchive")]
    ids = [60562] + [d.get("Id") for d in geo if d.get("Id") != 60562]
    bb = ",".join(f"{x:.6f}" for x in (p[1] - 0.002, p[0] - 0.002, p[1] + 0.002, p[0] + 0.002))
    for i in ids[:25]:
        st, b = fetch(f"https://apidata.mos.ru/v1/datasets/{i}/features?bbox={bb}&api_key={urllib.parse.quote(k)}")
        try:
            feats = json.loads(b).get("features", [])
        except Exception:
            print(f"\n#### набор {i}: {st} {short(b.decode('utf-8', 'replace'))}"); continue
        print(f"\n#### набор {i}: {st}, объектов у точки: {len(feats)}")
        for f in feats[:6]:
            pr = f.get("properties") or {}
            at = pr.get("attributes") or pr.get("Attributes")
            print("   ", (f.get("geometry") or {}).get("type"), short(at, 900))
    # Набор 60562 без гео-фильтра: поля записи по адресу
    st, b = fetch(f"https://apidata.mos.ru/v1/datasets/60562/rows?$top=3&$filter=" + urllib.parse.quote("Cells/SIMPLE_ADDRESS eq 'Рябиновая улица, дом 28А, строение 1'") + f"&api_key={urllib.parse.quote(k)}")
    print("\n#### 60562 rows по адресу:", st, short(b.decode("utf-8", "replace"), 3000))


if __name__ == "__main__":
    main()
