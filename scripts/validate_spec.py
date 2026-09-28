"""
Валидатор спецификации. Запускается в CI перед сборкой. Код выхода 1 — ошибки.
Проверяет:
  1. Уникальность ID источников, параметров, формул, статей.
  2. У каждого параметра/формулы/статьи есть source_ids, и все они существуют в sources.yaml.
  3. У источников уровня 1–3 есть URL; scope: global | project (проектные — уровень 4–5, без URL).
  4. depends_on формул ссылается на существующие параметры/формулы; граф без циклов.
  5. Каждый параметр имеет basis; project-параметры без default или с обоснованием.
  6. Карта исходного Excel полная: нет UNMAPPED в legacy/*.csv; все target_id существуют.
  7. regions.yaml: 89 субъектов, коды уникальны.
  8. Контрольные примеры формул (где заданы) пересчитываются.
  9. Справочник допущений компании (company_assumptions.yaml): версии по порядку, параметры существуют и не региональные,
     значения подходят параметру (число в диапазоне / таблица со столбцами параметра).
Перед релизом (предупреждения): пустые значения справочника допущений и значения со статусом check.
Предупреждения (не ошибки): статусы needs_verification, источники verified: false.
"""
import csv, re, sys
from pathlib import Path
import yaml

ROOT = Path(__file__).resolve().parents[1]
D = ROOT / "data"
errors, warns = [], []

src = yaml.safe_load(open(D / "sources.yaml"))["sources"]
params = yaml.safe_load(open(D / "parameters.yaml"))["parameters"]
forms = yaml.safe_load(open(D / "formulas.yaml"))["formulas"]
capex = yaml.safe_load(open(D / "capex_items.yaml"))["items"]
regions = yaml.safe_load(open(D / "regions.yaml"))["regions"]
assumptions = yaml.safe_load(open(D / "company_assumptions.yaml"))["versions"]

def uniq(items, key, what):
    seen = set()
    for it in items:
        k = it[key]
        if k in seen:
            errors.append(f"{what}: дубль ID {k}")
        seen.add(k)
    return seen

S = uniq(src, "id", "sources")
P = uniq(params, "id", "parameters")
F = uniq(forms, "id", "formulas")
C = uniq(capex, "item_id", "capex_items")
PARAMS = {p["id"]: p for p in params}

for s in src:
    if s["level"] in (1, 2, 3) and not s.get("url"):
        errors.append(f"источник {s['id']} уровня {s['level']} без URL")
    if s.get("url") and not re.match(r"^https?://", s["url"]):
        errors.append(f"источник {s['id']}: некорректный URL")
    if s.get("scope") not in ("global", "project"):
        errors.append(f"источник {s['id']}: scope должен быть global или project")
    elif s["scope"] == "project" and (s["level"] < 4 or s.get("url")):
        errors.append(f"источник {s['id']}: проектный источник (scope: project) — только уровень 4–5 и без URL")
    elif s["scope"] == "global" and s["level"] == 5:
        errors.append(f"источник {s['id']}: экспертная оценка (уровень 5) может быть только проектной")
    if s.get("verified") is False:
        warns.append(f"источник {s['id']}: не сверен ({s.get('note', '')})")

def check_sources(owner, ids):
    if not ids:
        errors.append(f"{owner}: нет source_ids")
    for i in ids or []:
        if i not in S:
            errors.append(f"{owner}: источник {i} отсутствует в sources.yaml")

for p in params:
    check_sources(f"параметр {p['id']}", p.get("source_ids"))
    if not p.get("basis"):
        errors.append(f"параметр {p['id']}: нет basis")
    if p.get("status") == "needs_verification":
        warns.append(f"параметр {p['id']}: needs_verification")
    if not p.get("legacy"):
        errors.append(f"параметр {p['id']}: нет поля legacy (связь с исходником или 'new')")

for c in capex:
    check_sources(f"статья {c['item_id']}", c.get("source_ids"))
    if c.get("rate_param") and c["rate_param"] not in P:
        errors.append(f"статья {c['item_id']}: rate_param {c['rate_param']} не найден")
    if c["base"] not in ("фикс", "фикс_в_месяц", "формула") and c["base"] not in P and c["base"] not in F:
        errors.append(f"статья {c['item_id']}: база {c['base']} не является ID параметра/формулы")
    if c["base"] == "формула" and c.get("formula") not in F:
        errors.append(f"статья {c['item_id']}: формула {c.get('formula')} не найдена")
    # НДС и индекс статьи (решение владельца продукта 27.09.2026)
    vat_options = set((PARAMS.get("TAX.VAT_RATE_OPTIONS") or {}).get("default") or [])
    def vat_ok(v):
        return (isinstance(v, (int, float)) and v in vat_options) or (isinstance(v, str) and v == "TAX.VAT_RATE")
    if not vat_ok(c.get("vat_rate")):
        errors.append(f"статья {c['item_id']}: vat_rate {c.get('vat_rate')!r} — допустимо TAX.VAT_RATE или значение из TAX.VAT_RATE_OPTIONS")
    for r in c.get("vat_rules") or []:
        if not vat_ok(r.get("vat_rate")):
            errors.append(f"статья {c['item_id']}: vat_rules — недопустимая ставка {r.get('vat_rate')!r}")
        for pid, val in (r.get("when") or {}).items():
            if pid not in P:
                errors.append(f"статья {c['item_id']}: vat_rules.when — параметр {pid} не найден")
            elif PARAMS[pid].get("options") and val not in PARAMS[pid]["options"]:
                errors.append(f"статья {c['item_id']}: vat_rules.when — {pid} = {val!r} нет среди вариантов {PARAMS[pid]['options']}")
        check_sources(f"статья {c['item_id']} (vat_rules)", r.get("source_ids"))
    share = c.get("vat_taxable_share")
    if share is not None and not ((isinstance(share, (int, float)) and 0 <= share <= 1) or (isinstance(share, str) and share in P)):
        errors.append(f"статья {c['item_id']}: vat_taxable_share — доля 0..1 или ID параметра")
    check_sources(f"статья {c['item_id']} (НДС)", c.get("vat_source_ids"))
    if c.get("index_type") not in ("investment", "cpi", "none"):
        errors.append(f"статья {c['item_id']}: index_type — investment | cpi | none")
    # база «доля от другой суммы» уже проиндексирована или растёт вместе с ценой — повторная индексация даёт двойной счёт
    if c["base"] in ("F.SALES.REVENUE_TOTAL", "F.CAPEX.SMR_TOTAL", "LAND.PURCHASE_PRICE") and c.get("index_type") != "none":
        errors.append(f"статья {c['item_id']}: база {c['base']} — доля от другой суммы, index_type должен быть none")

known = P | F
for f in forms:
    check_sources(f"формула {f['id']}", f.get("source_ids"))
    for dep in f.get("depends_on") or []:
        if dep not in known:
            errors.append(f"формула {f['id']}: зависимость {dep} не найдена")
    for fld in ("rationale", "expr"):
        if not f.get(fld):
            errors.append(f"формула {f['id']}: нет {fld}")
    if "note" in f and not (isinstance(f["note"], str) and f["note"].strip()):
        errors.append(f"формула {f['id']}: note должно быть непустым текстом")
    terms = f.get("terms")
    if terms is not None and not (isinstance(terms, dict) and all(isinstance(k, str) and k.strip() and isinstance(v, str) and v.strip() for k, v in terms.items())):
        errors.append(f"формула {f['id']}: terms — словарь «обозначение: расшифровка» с непустыми строками")
    plain = f.get("plain")
    if not isinstance(plain, dict) or not plain.get("title") or not plain.get("how"):
        errors.append(f"формула {f['id']}: нет plain.title / plain.how — пояснения для панели «Как посчитано»")
    else:
        if re.search(r"[A-Za-z]", plain["how"]):
            errors.append(f"формула {f['id']}: plain.how — без обозначений, кодов и английских слов")
        for token in re.findall(r"\{([^}]+)\}", plain.get("example") or ""):
            ref = token.split("|")[0]
            ref = f["id"] + ref[1:] if ref.startswith("=") else ref
            if not any(ref == k or ref.startswith(k + ".") for k in known):
                errors.append(f"формула {f['id']}: plain.example — неизвестная ссылка {{{token}}}")
    if f.get("status") == "needs_verification":
        warns.append(f"формула {f['id']}: needs_verification")

# циклы: рёбра только между формулами; зависимости за прошлый месяц (lag_depends_on в formulas.yaml, X[t-1])
# разрывают цикл в реализации и в проверке не участвуют
for f in forms:
    for d in f.get("lag_depends_on") or []:
        if d not in (f.get("depends_on") or []):
            errors.append(f"формула {f['id']}: lag_depends_on {d} нет в depends_on")
LAG_OK = {(f["id"], d) for f in forms for d in (f.get("lag_depends_on") or [])}
graph = {f["id"]: [d for d in (f.get("depends_on") or []) if d in F and (f["id"], d) not in LAG_OK] for f in forms}
state = {}
def dfs(n, stack):
    state[n] = 1
    for m in graph.get(n, []):
        if state.get(m) == 1:
            errors.append("цикл без лага: " + " → ".join(stack + [n, m]))
        elif not state.get(m):
            dfs(m, stack + [n])
    state[n] = 2
for n in graph:
    if not state.get(n):
        dfs(n, [])

# legacy
def target_ok(t):
    if t in ("—",):
        return True
    base = t.split("[")[0]
    if base == "CAPEX.ITEMS":
        item = t[t.find("[") + 1:t.find("]")] if "[" in t else None
        return item in C if item else True
    return base in known
for fn, col in (("legacy_values_map.csv", "target_id"), ("legacy_formulas_map.csv", "target_id")):
    path = ROOT / "legacy" / fn
    if not path.exists():
        errors.append(f"нет {fn} — запустите scripts/build_legacy_map.py")
        continue
    rows = list(csv.DictReader(open(path, encoding="utf-8")))
    for r in rows:
        if r[col] == "UNMAPPED":
            errors.append(f"{fn}: не сопоставлено {r.get('sheet')}!{r.get('cell') or r.get('range')}")
        elif not target_ok(r[col]):
            errors.append(f"{fn}: target {r[col]} не существует ({r.get('sheet')}!{r.get('cell') or r.get('range')})")
    if fn == "legacy_values_map.csv":
        clar = [r for r in rows if r["verdict"] == "clarify"]
        for r in clar:
            warns.append(f"исходник {r['sheet']}!{r['cell']} = {r['value']}: требует пояснения автора")

# regions
codes = [r["code"] for r in regions]
if len(codes) != 89:
    errors.append(f"regions.yaml: {len(codes)} субъектов вместо 89")
if len(set(codes)) != len(codes):
    errors.append("regions.yaml: дубли кодов")
for r in regions:
    for key in ("land_tax_source_ids", "ncs_k_per_source_ids"):
        for i in r.get(key) or []:
            if i not in S:
                errors.append(f"регион {r['code']}: источник {i} не найден")
    for i in (r.get("land_tax_rate_housing") or {}).get("source_ids") or []:
        if i not in S:
            errors.append(f"регион {r['code']}: источник ставки земельного налога {i} не найден")
    if (r.get("land_tax_rate_housing") or {}).get("status") == "needs_verification":
        warns.append(f"регион {r['code']}: ставка земельного налога {r['land_tax_rate_housing']['value']} — подтвердить у налогового консультанта")

# справочник допущений компании
def assumption_problem(p, v):
    if v is None:
        return None
    if p["kind"] == "scalar":
        if isinstance(v, bool) or not isinstance(v, (int, float)):
            return "нужно число"
        rng = p.get("range")
        if rng and not (rng[0] <= v <= rng[1]):
            return f"значение {v} вне допустимого диапазона {rng[0]}…{rng[1]}"
        return None
    if p["kind"] == "table":
        if not isinstance(v, list) or not v:
            return "нужна таблица хотя бы из одной строки"
        cols = {c["key"]: c for c in p.get("columns") or []}
        for row in v:
            if not isinstance(row, dict):
                return "строка таблицы — набор «столбец: значение»"
            for k, cell in row.items():
                if k not in cols:
                    return f"столбца {k} нет у параметра"
                if cols[k].get("options") and str(cell) not in cols[k]["options"]:
                    return f"{k} = {cell} нет среди вариантов"
        return None
    return f"вид параметра {p['kind']} в справочнике допущений не поддерживается"

for i, v in enumerate(assumptions):
    owner = f"справочник допущений, версия {v.get('version')}"
    if v.get("version") != i + 1:
        errors.append(f"{owner}: версии нумеруются по порядку с 1, ожидалась {i + 1}")
    seen = set()
    for it in v.get("items") or []:
        pid = it.get("param")
        if pid in seen:
            errors.append(f"{owner}: параметр {pid} указан дважды")
        seen.add(pid)
        if pid not in PARAMS:
            errors.append(f"{owner}: параметр {pid} отсутствует в parameters.yaml")
            continue
        if PARAMS[pid]["scope"] == "region":
            errors.append(f"{owner}: {pid} — региональный параметр, его значения в regions.yaml")
        if it.get("status") not in ("unverified", "check", "approved"):
            errors.append(f"{owner}: {pid} — status: unverified | check | approved")
        if it.get("status") == "check" and not it.get("check"):
            errors.append(f"{owner}: {pid} — статус check без поля check (что проверить)")
        if it.get("group") not in ("sales", "budget", "escrow", "fin"):
            errors.append(f"{owner}: {pid} — group: sales | budget | escrow | fin")
        if not (it.get("from") or {}).get("text"):
            errors.append(f"{owner}: {pid} — нет from.text («Откуда»)")
        if i == len(assumptions) - 1:
            if it.get("value") is None:
                warns.append(f"проверить перед релизом: {pid} — в справочнике допущений не задано, в расчёте не учтено")
            elif it.get("status") == "check":
                warns.append(f"проверить перед релизом: {pid} — {it['check']}")
        prob = assumption_problem(PARAMS[pid], it.get("value"))
        if prob:
            errors.append(f"{owner}: {pid} — {prob}")

# контрольные примеры
def approx(a, b, tol=1e-6):
    return abs(a - b) <= tol * max(1, abs(b))
ex = {f["id"]: f.get("example") for f in forms if f.get("example")}
checks = {
    "F.TEP.GFA_BELOW_EST": lambda e: e["input"]["parking"] * e["input"]["area_per_space"],
    "F.TEP.APT_TYPE_AREA": lambda e: e["input"]["count"] * e["input"]["avg_area"],
    "F.TEP.PARKING_REQUIRED": lambda e: -(-sum(c * n for c, n in zip(e["input"]["counts"], e["input"]["norms"])) // 1),
    "F.LAND.TAX_OR_RENT": lambda e: e["input"]["cad_value"] * e["input"]["rate"] * e["input"]["coef"] / 12,
    "F.FIN.RATE": lambda e: max(e["input"]["pref"] * min(e["input"]["coverage"], 1)
                                 + (e["input"]["key"] + e["input"]["spread"]) * (1 - min(e["input"]["coverage"], 1))
                                 - e["input"]["skr"], e["input"]["min"]),
    "F.TAX.OUTPUT_VAT": lambda e: e["input"]["value"] * e["input"]["rate"] / (1 + e["input"]["rate"]),
    "F.TEP.APT_COUNT": lambda e: (e["input"]["area_share"] * e["input"]["apt_area_total"] / e["input"]["avg_area"]) // 1,
    "F.TEP.PARKING_SPACE_MIN_AREA": lambda e: e["input"]["length"] * e["input"]["width"],
    "F.BENCH.APART_DISCOUNT": lambda e: sorted(1 - a / f for a, f in zip(e["input"]["apart_prices"], e["input"]["flat_prices"]))[1],
    "F.BENCH.COMP_PRICE": lambda e: sum(e["input"]["deal_values"]) / sum(e["input"]["deal_areas"]),
    "F.BENCH.MARKET_PRICE": lambda e: (lambda w: sum(p * x for p, x in zip(e["input"]["prices"], w)) / sum(w))(
        [1 / (1 + a) for a in e["input"]["adj_total"]]),
}
for fid, fn in checks.items():
    e = ex.get(fid)
    if not e:
        continue
    got = fn(e)
    exp = e.get("output", e.get("output_per_month"))
    if not approx(got, exp, 1e-4):
        errors.append(f"пример {fid}: расчёт {got} ≠ {exp}")
e = ex.get("F.CAPEX.SCHEDULE_WEIGHT")
if e:
    N = e["input"]["N"]; C_ = lambda x: 3 * x * x - 2 * x ** 3
    w = [C_((i + 1) / N) - C_(i / N) for i in range(N)]
    if any(not approx(a, b) for a, b in zip(w, e["output"])) or not approx(sum(w), 1):
        errors.append(f"пример F.CAPEX.SCHEDULE_WEIGHT: {w} ≠ {e['output']}")

print(f"Источники: {len(S)}, параметры: {len(P)}, статьи бюджета: {len(C)}, формулы: {len(F)}, регионы: {len(codes)}, версии справочника допущений: {len(assumptions)}")
print(f"Предупреждения: {len(warns)}")
for w in warns:
    print("  WARN", w)
print(f"Ошибки: {len(errors)}")
for e in errors:
    print("  ERROR", e)
sys.exit(1 if errors else 0)
