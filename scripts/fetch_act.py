#!/usr/bin/env python3
"""Текст нормативного акта с официального или справочно-правового сайта — для выписки формул в data/*.yaml.

Запускается на сервере в России (workflow «Текст акта»): эти сайты не отвечают зарубежным серверам.
Только чтение: скачивает страницу, убирает разметку, печатает текст. Ничего не сохраняет и не устанавливает.
Только стандартная библиотека Python 3. Адреса — только с сайтов из ALLOWED (не открытый прокси).

  python3 fetch_act.py URL [URL ...]
"""
import html
import re
import ssl
import sys
import urllib.parse
import urllib.request

ALLOWED = ("pravo.gov.ru", "mos.ru", "consultant.ru", "garant.ru", "docs.cntd.ru", "kodeks.ru")
UA = "Mozilla/5.0 (X11; Linux x86_64) finmodel-act-fetch/1.0"
LIMIT = 3_000_000  # байт с одной страницы


def allowed(url):
    host = (urllib.parse.urlparse(url).hostname or "").lower()
    return url.startswith(("http://", "https://")) and any(host == d or host.endswith("." + d) for d in ALLOWED)


def text_of(raw, charset):
    s = raw.decode(charset or "utf-8", errors="replace")
    s = re.sub(r"(?is)<(script|style|noscript)[^>]*>.*?</\1>", " ", s)
    s = re.sub(r"(?i)<br\s*/?>|</(p|div|tr|li|h\d|table)>", "\n", s)
    s = html.unescape(re.sub(r"<[^>]+>", " ", s))
    s = re.sub(r"[ \t\xa0]+", " ", s)
    return re.sub(r"\n\s*\n+", "\n\n", s).strip()


def fetch(url):
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept-Language": "ru"})
    with urllib.request.urlopen(req, timeout=40, context=ssl.create_default_context()) as r:
        raw = r.read(LIMIT)
        ct = r.headers.get("Content-Type", "")
        m = re.search(r"charset=([\w-]+)", ct)
        cs = m.group(1) if m else None
        if not cs:
            m = re.search(rb'charset=["\']?([\w-]+)', raw[:4000])
            cs = m.group(1).decode() if m else "utf-8"
        return r.status, ct, text_of(raw, cs)


def main(urls):
    for url in urls:
        print(f"\n===== {url}")
        if not allowed(url):
            print(f"пропущено: сайт не из списка ({', '.join(ALLOWED)})")
            continue
        try:
            status, ct, text = fetch(url)
            print(f"HTTP {status}, {ct}, {len(text)} знаков\n")
            print(text)
        except Exception as e:  # noqa: BLE001 — печатаем причину и идём к следующему адресу
            print(f"ошибка: {type(e).__name__}: {e}"[:300])


if __name__ == "__main__":
    main(sys.argv[1:])
