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


def main():
    if not KEY:
        print("Ключа DATA_MOS_API_KEY нет в ~/web/.env — запустите «Сайт на сервер» после добавления секрета")
        return 1
    st, cat = get("/datasets")
    if isinstance(cat, dict):
        print(f"Каталог — объект, поля: {list(cat.keys())[:20]}")
        cat = next((v for k, v in cat.items() if isinstance(v, list)), cat)
    print(f"Каталог: ответ {st}, наборов {len(cat) if isinstance(cat, list) else '—'}")
    if not isinstance(cat, list):
        return 1
    found = [d for d in cat if WORDS.search(str(d.get("Caption", "")))]
    print(f"Похожих наборов: {len(found)}\n")
    for d in found:
        print(f"[{d.get('Id')}] {d.get('Caption')} | геоданные: {d.get('ContainsGeodata')} | архив: {d.get('IsArchive')}")
    print()
    bbox = f"{LON - D},{LAT - D},{LON + D},{LAT + D}"
    for d in found[:15]:
        if not d.get("ContainsGeodata") or d.get("IsArchive"):
            continue
        i = d.get("Id")
        st, fc = get(f"/datasets/{i}/features", bbox=bbox)
        feats = fc.get("features", []) if isinstance(fc, dict) else []
        print(f"== [{i}] {d.get('Caption')}: ответ {st}, объектов рядом с участком: {len(feats)}")
        for f in feats[:5]:
            g = f.get("geometry") or {}
            attrs = (f.get("properties") or {}).get("Attributes") or f.get("properties") or {}
            keys = list(attrs.keys())[:25]
            short = {k: (str(v)[:80]) for k, v in attrs.items() if k in keys[:12]}
            print(f"   {g.get('type')}: {json.dumps(short, ensure_ascii=False)}")
        if feats:
            a = (feats[0].get("properties") or {}).get("Attributes") or feats[0].get("properties") or {}
            print(f"   поля: {', '.join(list(a.keys()))}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
