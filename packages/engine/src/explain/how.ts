/**
 * Пояснение «Как посчитано»: одна строка примера на цифрах текущего проекта, строка «В исходном Excel»,
 * поля ввода, которые влияют на результат, и короткие названия источников. Раньше считалось в панели интерфейса
 * старого сервиса (lib/how-example.ts); перенесено в ядро, экран только показывает строки.
 * Пример: своё описание для показателей-рядов (продажи, эскроу, бюджет, даты) → шаблон plain.example из
 * formulas.yaml с подстановкой {ID}, {ID.ключ|единица} и {=} (результат) → результат коротко.
 */
import Decimal from "decimal.js";
import { getCapexItem, getFormula, getParameter, isCapexItemId, isFormulaId, isParameterId, type FormulaId, type ParameterId } from "@fm/spec";
import { fmtRub } from "../lib/format";
import * as fmt from "../lib/text";
import { monthName } from "../lib/text";
import type { CalcProject, ProjectModel } from "../project";


type Series = Record<string, Decimal[]>;
type Row = Record<string, unknown>;

const ZERO = new Decimal(0);
const HUNDRED = 100;
const SMALL_SHARE = 0.01;
const SHARE_DIGITS_SMALL = 4;
const COEF_DIGITS = 4;
const INDEX_DIGITS = 3;
/** Относительная разница, ниже которой режимы считаются совпавшими (ошибки округления). */
const SAME_EPS = 1e-6;
/** Сколько строк показывать в примере по умолчанию, остальные — «ещё N». */
const DIFF_ROWS = 2;
/** Сколько полей показывать в «Что влияет». */
const INPUT_FIELDS = 5;
const sum = (xs: Decimal[] | undefined) => (xs ?? []).reduce((s, x) => s.add(x), ZERO);
const isDec = (v: unknown): v is Decimal => v instanceof Decimal;
const isSeries = (v: unknown): v is Decimal[] => Array.isArray(v) && v.length > 0 && v.every(isDec);

/** Число с единицей: рубли — коротко (млн, млрд), доли — в процентах, площади, штуки и цены за м² — целыми. */
export function amount(v: Decimal | number, unit: string): string {
  const d = new Decimal(v);
  if (unit === "руб") return `${d.isNeg() ? "−" : ""}${fmtRub(d)}`;
  if (unit === "доля") return `${fmt.num(d.mul(HUNDRED), d.abs().lt(SMALL_SHARE) && !d.isZero() ? SHARE_DIGITS_SMALL : 2)} %`;
  if (unit === "коэф") return fmt.num(d, COEF_DIGITS);
  // площади и штуки — целыми вниз, как в предупреждениях расчёта: «продано 10 888 м²» при 10 888,61
  if (unit === "м2" || unit === "шт") return `${fmt.num(d.trunc(), 0)} ${fmt.unit(unit)}`;
  if (unit === "руб/м2" || unit === "руб/шт") return `${fmt.num(d, 0)} ${fmt.unit(unit)}`;
  return `${fmt.num(d, 2)} ${fmt.unit(unit)}`.trim();
}

interface Ctx {
  m: ProjectModel;
  legacy: boolean;
  f: (id: FormulaId) => unknown;
  p: (id: ParameterId) => unknown;
  dates: string[];
}

function context(project: CalcProject, m: ProjectModel): Ctx {
  return {
    m,
    legacy: project.input.mode === "legacy",
    f: (x) => m.result.formulas[x]?.value,
    p: (x) => m.result.parameters[x]?.value ?? project.input.values[x] ?? getParameter(x).default,
    dates: (m.result.formulas["F.TIME.DATE"]?.value as string[] | undefined) ?? [],
  };
}

function productRows(c: Ctx): Row[] {
  const v = c.p("SALES.PRODUCTS");
  return Array.isArray(v) ? (v as Row[]) : [];
}

const unitOf = (row: Row | undefined) => (row && (row.product === "машино-места" || row.product === "кладовые") ? "шт" : "м²");
const perUnit = (row: Row | undefined) => (unitOf(row) === "шт" ? "руб/шт" : "руб/м²");
const whole = (d: Decimal | number) => fmt.num(new Decimal(d), 0);
/** Площадь или штуки — целыми вниз, как в предупреждениях расчёта. */
const qty = (d: Decimal | number) => fmt.num(new Decimal(d).trunc(), 0);
const nonZero = (xs: Decimal[]) => xs.map((x, t) => (x.isZero() ? -1 : t)).filter((t) => t >= 0);
const argMax = (xs: Decimal[]) => xs.reduce((best, x, i) => (x.gt(xs[best]!) ? i : best), 0);
const upper = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** «с марта 2027 по июнь 2031» по первому и последнему месяцу. */
function span(c: Ctx, months: number[]): string {
  return `с ${monthName(c.dates[months[0]!], "gen")} по ${monthName(c.dates[months[months.length - 1]!])}`;
}

/** Продукт для примера: с предупреждением о превышении запаса, иначе с наибольшей выручкой. */
function pickProduct(c: Ctx): string | null {
  const over = c.m.result.messages.find((x) => x.key?.startsWith("SALES.OVER_STOCK:"));
  if (over?.key) return over.key.split(":")[1] ?? null;
  const value = (c.f("F.SALES.CONTRACT_VALUE") ?? {}) as Series;
  const best = Object.entries(value).sort((a, b) => sum(b[1]).cmp(sum(a[1])))[0];
  return best?.[0] ?? null;
}

function soldArea(c: Ctx): string | null {
  const sold = (c.f("F.SALES.SOLD_AREA") ?? {}) as Series;
  const k = pickProduct(c);
  if (!k || !sold[k]) return null;
  const row = productRows(c).find((r) => r.name === k);
  const u = unitOf(row);
  const built = Number((u === "шт" ? row?.stock_units : row?.stock_area) ?? NaN);
  const months = nonZero(sold[k]);
  const total = sum(sold[k]);
  const head = Number.isFinite(built) ? `${k} ${qty(built)} ${u}.` : `${k}.`;
  if (!months.length) return `${head} Продаж в расчёте нет.`;
  const start = `Продажи начинаются в ${monthName(c.dates[months[0]!], "prep")} года`;
  const last = monthName(c.dates[months[months.length - 1]!], "dat");
  const left = Number.isFinite(built) ? new Decimal(built).sub(total) : ZERO;
  // остаток меньше целого м² (шт) — округление ручного плана, площадь продана вся
  if (left.lt(1)) return `${head} ${start}, вся площадь продана к ${last} года.`;
  return `${head} ${start}, к ${last} года продано ${qty(total)} ${u}, осталось продать ${qty(left)} ${u}.`;
}

function price(c: Ctx): string | null {
  const price = (c.f("F.SALES.PRICE") ?? {}) as Series;
  const sold = (c.f("F.SALES.SOLD_AREA") ?? {}) as Series;
  const k = pickProduct(c);
  if (!k || !price[k] || !sold[k]) return null;
  const u = perUnit(productRows(c).find((r) => r.name === k));
  const months = nonZero(sold[k]);
  if (!months.length) return null;
  const a = months[0]!;
  const b = months[months.length - 1]!;
  const pa = price[k][a]!;
  const pb = price[k][b]!;
  return `${k}: ${whole(pa)} ${u} в ${monthName(c.dates[a], "prep")}, ${whole(pb)} ${u} в ${monthName(c.dates[b], "prep")} (+${fmt.num(pb.div(pa).sub(1).mul(HUNDRED), 1)} %).`;
}

function contractValue(c: Ctx): string | null {
  const value = (c.f("F.SALES.CONTRACT_VALUE") ?? {}) as Series;
  const sold = (c.f("F.SALES.SOLD_AREA") ?? {}) as Series;
  const price = (c.f("F.SALES.PRICE") ?? {}) as Series;
  const k = pickProduct(c);
  if (!k || !value[k]) return null;
  const t = argMax(value[k]);
  const row = productRows(c).find((r) => r.name === k);
  return `${k}, ${monthName(c.dates[t])}: ${qty(sold[k]?.[t] ?? 0)} ${unitOf(row)} × ${whole(price[k]?.[t] ?? 0)} ${perUnit(row)} = ${fmtRub(value[k][t]!)}.`;
}

function cashIn(c: Ctx): string | null {
  const cash = c.f("F.SALES.CASH_IN") as { total: Series; ddu: Series } | undefined;
  const value = (c.f("F.SALES.CONTRACT_VALUE") ?? {}) as Series;
  if (!cash) return null;
  const all = (s: Series) => Object.values(s).reduce((a, x) => a.add(sum(x)), ZERO);
  return `Договоры на ${fmtRub(all(value))}, поступило ${fmtRub(all(cash.total))}, из них на эскроу ${fmtRub(all(cash.ddu))}.`;
}

function wavgPrice(c: Ctx): string | null {
  const value = (c.f("F.SALES.CONTRACT_VALUE") ?? {}) as Series;
  const sold = (c.f("F.SALES.SOLD_AREA") ?? {}) as Series;
  const k = pickProduct(c);
  if (!k || !value[k] || !sold[k]) return null;
  const row = productRows(c).find((r) => r.name === k);
  const s = sum(sold[k]);
  if (s.isZero()) return null;
  return `${k}: ${fmtRub(sum(value[k]))} ÷ ${qty(s)} ${unitOf(row)} = ${whole(sum(value[k]).div(s))} ${perUnit(row)}.`;
}

function endPrice(c: Ctx): string | null {
  const price = (c.f("F.SALES.PRICE") ?? {}) as Series;
  const sold = (c.f("F.SALES.SOLD_AREA") ?? {}) as Series;
  const k = pickProduct(c);
  if (!k || !sold[k] || !price[k]) return null;
  const months = nonZero(sold[k]);
  const b = months[months.length - 1];
  if (b === undefined) return null;
  return `${k}: последняя продажа в ${monthName(c.dates[b], "prep")} по ${whole(price[k][b]!)} ${perUnit(productRows(c).find((r) => r.name === k))}.`;
}

function revenueTotal(c: Ctx): string | null {
  const r = c.f("F.SALES.REVENUE_TOTAL") as { gross: Decimal; byRow?: Record<string, Decimal> } | undefined;
  if (!r) return null;
  const rows = Object.entries(r.byRow ?? {}).filter(([, v]) => !v.isZero());
  return rows.length ? `${rows.map(([k, v]) => `${k} ${fmtRub(v)}`).join(" + ")} = ${fmtRub(r.gross)}.` : null;
}

function escrowDeposit(c: Ctx): string | null {
  const dep = c.f("F.ESC.DEPOSIT") as Decimal[][] | undefined;
  if (!dep) return null;
  const rows = dep.map((s, p) => (nonZero(s).length ? `очередь ${p + 1} — ${fmtRub(sum(s))} ${span(c, nonZero(s))}` : null)).filter(Boolean);
  return rows.length ? `${upper(rows.join("; "))}.` : null;
}

function escrowBalance(c: Ctx): string | null {
  const v = c.f("F.ESC.BALANCE") as { balance: Decimal[][]; release: Decimal[][] } | undefined;
  if (!v) return null;
  const rows = v.balance
    .map((b, p) => {
      const t = (v.release[p] ?? []).findIndex((x) => !x.isZero());
      if (t < 0) return null;
      return `очередь ${p + 1} — до ${fmtRub(b.reduce((m, x) => (x.gt(m) ? x : m), ZERO))}, раскрытие в ${monthName(c.dates[t], "prep")}`;
    })
    .filter(Boolean);
  return rows.length ? `${upper(rows.join("; "))}.` : null;
}

const itemName = (id: string) => (isCapexItemId(id) ? getCapexItem(id).name : id);
/** Подпись строки значения: статья бюджета — её названием в кавычках, продукт или очередь — как есть. */
const rowLabel = (k: string) => (isCapexItemId(k) ? `«${getCapexItem(k).name}»` : k);

function largestItem(c: Ctx): string | null {
  const cash = c.f("F.CAPEX.ITEM_CASH") as Series | undefined;
  return cash ? (Object.entries(cash).sort((a, b) => sum(b[1]).cmp(sum(a[1])))[0]?.[0] ?? null) : null;
}

function itemTotal(c: Ctx): string | null {
  const v = c.f("F.CAPEX.ITEM_TOTAL") as Record<string, Decimal> | undefined;
  if (!v) return null;
  const rows = Object.entries(v).filter(([, x]) => !x.isZero()).sort((a, b) => b[1].cmp(a[1]));
  const [k, x] = rows[0] ?? [];
  if (!k || !x) return null;
  return `Всего ${rows.length} статей на ${fmtRub(rows.reduce((s, [, y]) => s.add(y), ZERO))}, крупнейшая — «${itemName(k)}» ${fmtRub(x)}.`;
}

function itemCash(c: Ctx): string | null {
  const k = largestItem(c);
  const s = k ? (c.f("F.CAPEX.ITEM_CASH") as Series)[k] : undefined;
  if (!k || !s || !nonZero(s).length) return null;
  const t = argMax(s);
  return `«${itemName(k)}»: ${fmtRub(sum(s))} ${span(c, nonZero(s))}, больше всего в ${monthName(c.dates[t], "prep")} — ${fmtRub(s[t]!)}.`;
}

function scheduleWeight(c: Ctx): string | null {
  const w = c.f("F.CAPEX.SCHEDULE_WEIGHT") as Series | undefined;
  const k = largestItem(c);
  const s = k && w ? w[k] : undefined;
  if (!k || !s || !nonZero(s).length) return null;
  const t = argMax(s);
  return `«${itemName(k)}»: ${nonZero(s).length} мес. ${span(c, nonZero(s))}, больше всего ${fmt.num(s[t]!.mul(HUNDRED), 2)} % в ${monthName(c.dates[t], "prep")}.`;
}

function capexIndex(c: Ctx): string | null {
  if (c.legacy) return "Индекс всех статей равен 1: суммы в ценах исходного файла.";
  const idx = c.f("F.CAPEX.INDEX") as Series | undefined;
  const k = largestItem(c);
  const s = k && idx ? idx[k] : undefined;
  if (!k || !s?.length) return null;
  return `«${itemName(k)}»: в ${monthName(c.dates[s.length - 1], "prep")} цены выше в ${fmt.num(s[s.length - 1]!, INDEX_DIGITS)} раза.`;
}

function flags(c: Ctx, id: FormulaId): string | null {
  const v = c.f(id) as number[][] | undefined;
  if (!v) return null;
  const rows = v.map((s, p) => {
    const on = s.map((x, t) => (x ? t : -1)).filter((t) => t >= 0);
    if (!on.length) return `очередь ${p + 1} — нет`;
    return on.length === 1 ? `очередь ${p + 1} — ${monthName(c.dates[on[0]!])}` : `очередь ${p + 1} — ${span(c, on)}`;
  });
  return `${upper(rows.join("; "))}.`;
}

const CUSTOM: Partial<Record<FormulaId, (c: Ctx) => string | null>> = {
  "F.SALES.SOLD_AREA": soldArea,
  "F.SALES.PRICE": price,
  "F.SALES.CONTRACT_VALUE": contractValue,
  "F.SALES.CASH_IN": cashIn,
  "F.SALES.WAVG_PRICE": wavgPrice,
  "F.SALES.END_PRICE": endPrice,
  "F.SALES.REVENUE_TOTAL": revenueTotal,
  "F.ESC.DEPOSIT": escrowDeposit,
  "F.ESC.BALANCE": escrowBalance,
  "F.CAPEX.ITEM_TOTAL": itemTotal,
  "F.CAPEX.ITEM_CASH": itemCash,
  "F.CAPEX.SCHEDULE_WEIGHT": scheduleWeight,
  "F.CAPEX.INDEX": capexIndex,
  "F.TIME.DATE": (c) => (c.dates.length ? `${upper(span(c, [0, c.dates.length - 1]))}, ${c.dates.length} мес.` : null),
  "F.TIME.DAYS": (c) => {
    const d = c.f("F.TIME.DAYS") as number[] | undefined;
    return d && d.length > 1 ? `${upper(monthName(c.dates[0]))} — ${d[0]} дн., ${monthName(c.dates[1])} — ${d[1]} дн.` : null;
  },
  "F.TIME.FLAG_CONSTRUCTION": (c) => flags(c, "F.TIME.FLAG_CONSTRUCTION"),
  "F.TIME.FLAG_PRESALE": (c) => flags(c, "F.TIME.FLAG_PRESALE"),
  "F.TIME.FLAG_POST_RNV": (c) => flags(c, "F.TIME.FLAG_POST_RNV"),
  "F.TIME.FLAG_ESCROW_RELEASE": (c) => flags(c, "F.TIME.FLAG_ESCROW_RELEASE"),
};

/** Значение для подстановки {ID}, {ID.ключ}, {ID.ключ|единица}: число — с единицей, ряд — сумма. */
function resolve(c: Ctx, raw: string): { text: string; zero: boolean } | null {
  const [token = "", unitOverride] = raw.split("|");
  const parts = token.split(".");
  // ID формулы/параметра содержит точки: ищем самый длинный известный префикс
  for (let n = parts.length; n >= 2; n--) {
    const id = parts.slice(0, n).join(".");
    let v: unknown;
    let unit: string;
    if (isFormulaId(id)) {
      v = c.f(id);
      unit = getFormula(id).unit;
    } else if (isParameterId(id)) {
      v = c.p(id);
      unit = getParameter(id).unit;
    } else continue;
    for (const k of parts.slice(n)) v = v && typeof v === "object" ? (v as Record<string, unknown>)[k] : undefined;
    if (unitOverride) unit = unitOverride;
    if (isSeries(v)) v = sum(v);
    if (isDec(v) || typeof v === "number") return { text: amount(v, unit), zero: new Decimal(v).isZero() };
    if (typeof v === "string") return { text: /^\d{4}-\d{2}-\d{2}$/.test(v) ? fmt.date(v) : v, zero: false };
    return null;
  }
  return null;
}

/** Подставляет значения в шаблон; в сумме «a + b + c = d» нулевые слагаемые не пишутся. */
function fill(c: Ctx, id: FormulaId, template: string): string | null {
  let ok = true;
  const sub = (part: string) => {
    let zero = false;
    const text = part.replace(/\{([^}]+)\}/g, (_, token: string) => {
      const v = resolve(c, token.startsWith("=") ? `${id}${token.slice(1)}` : token);
      if (v === null) ok = false;
      if (v?.zero) zero = true;
      return v?.text ?? "—";
    });
    return { text, zero };
  };
  const eq = template.lastIndexOf(" = ");
  let out: string;
  if (eq > 0 && template.slice(0, eq).includes(" + ")) {
    const terms = template.slice(0, eq).split(" + ").map(sub);
    const kept = terms.filter((t) => !t.zero);
    out = upper(`${(kept.length ? kept : terms).map((t) => t.text).join(" + ")}${sub(template.slice(eq)).text}`);
  } else out = sub(template).text;
  return ok ? out : null;
}

/** Шаблон plain.example с подставленными значениями; null — шаблона нет или какое-то значение не посчитано. */
export function templateExample(id: FormulaId, project: CalcProject, m: ProjectModel): string | null {
  const t = getFormula(id).plain?.example;
  return t ? fill(context(project, m), id, t) : null;
}

/** Результат коротко, если нет своего описания и шаблона. */
function generic(c: Ctx, id: FormulaId): string | null {
  const v = c.f(id);
  const unit = getFormula(id).unit;
  if (v === undefined || v === null) return null;
  if (isDec(v) || typeof v === "number") return `В проекте: ${amount(v, unit)}.`;
  const rows = [...totals(v)].filter(([, x]) => !x.isZero());
  if (!rows.length) return null;
  const shown = rows.slice(0, DIFF_ROWS + 1).map(([k, x]) => `${k ? `${rowLabel(k)} ` : ""}${amount(x, unit)}`);
  return `В проекте: ${shown.join("; ")}${rows.length > shown.length ? `; ещё ${rows.length - shown.length}` : ""}.`;
}

/** Продукт, на котором построен пример (для строки «В исходном Excel»). */
export function exampleFocus(project: CalcProject, m: ProjectModel): string | null {
  return pickProduct(context(project, m));
}

/** Одна строка примера на цифрах проекта; null — показатель ещё не посчитан. */
export function howExample(id: FormulaId, project: CalcProject, m: ProjectModel): string | null {
  const c = context(project, m);
  if (c.f(id) === undefined) return null;
  return CUSTOM[id]?.(c) ?? templateExample(id, project, m) ?? generic(c, id);
}

/** Итоги значения по строкам: число → себе, ряд → сумма, строки → по строкам, очереди → «очередь N». */
function totals(v: unknown): Map<string, Decimal> {
  const out = new Map<string, Decimal>();
  if (isDec(v)) out.set("", v);
  else if (isSeries(v)) out.set("", sum(v));
  else if (Array.isArray(v) && v.length && v.every(isSeries)) v.forEach((s, p) => out.set(`очередь ${p + 1}`, sum(s as Decimal[])));
  else if (v && typeof v === "object" && !Array.isArray(v)) {
    const o = v as Record<string, unknown>;
    const src = o.total && typeof o.total === "object" && !isDec(o.total) ? (o.total as Record<string, unknown>) : o;
    for (const [k, x] of Object.entries(src)) {
      if (isDec(x)) out.set(k, x);
      else if (isSeries(x)) out.set(k, sum(x));
    }
  }
  return out;
}

/**
 * Строка «В исходном Excel»: только если результат расчёта «как в исходном Excel» отличается от расчёта сервиса.
 * legacy — расчёт как в исходном Excel, normal — расчёт сервиса; focus — строка из примера (продукт), она первая.
 */
export function compatDiff(id: FormulaId, legacy: ProjectModel, normal: ProjectModel, focus?: string | null): string | null {
  const unit = getFormula(id).unit;
  const lv = legacy.result.formulas[id]?.value;
  // доли и коэффициенты по месяцам не складываются: сумма ряда ничего не значит
  if ((unit === "доля" || unit === "коэф") && !(lv instanceof Decimal) && typeof lv !== "number") return null;
  // расчёт сервиса не посчитан — причину показывают предупреждения
  if (!normal.result.formulas[id]) return null;
  const a = totals(lv);
  const b = totals(normal.result.formulas[id]?.value);
  const rows: { k: string; text: string }[] = [];
  for (const [k, x] of a) {
    const y = b.get(k);
    if (!y || x.sub(y).abs().lte(x.abs().add(1).mul(SAME_EPS))) continue;
    if (id === "F.SALES.SOLD_AREA" && x.gt(y)) rows.push({ k, text: `${k} продано ${amount(x, unit)} — больше, чем построено` });
    else if (id === "F.SALES.SOLD_AREA") rows.push({ k, text: `${k} продано ${amount(x, unit)}, в расчёте сервиса ${amount(y, unit)}` });
    else rows.push({ k, text: `${k ? `${rowLabel(k)} ` : ""}${amount(x, unit)}, в расчёте сервиса ${amount(y, unit)}` });
  }
  if (!rows.length) return null;
  if (focus) rows.sort((x, y) => Number(y.k === focus) - Number(x.k === focus));
  // одна строка: по продукту из примера или по первой отличающейся строке
  return `В исходном Excel ${rows[0]!.text}.`;
}

/** Служебные поля: по смыслу не меняют результат показателя или нужны только для расчёта «как в исходном Excel». */
const TECHNICAL = new Set<string>(["GEN.MODEL_START_DATE", "GEN.PROJECT_NAME", "GEN.REPORT_STEP", "GEN.PROJECT_STAGE", "CAPEX.SCHEDULE_SUM_TOLERANCE"]);

/** «Что влияет»: поля, которые вводит пользователь, — ближайшие к показателю по следу расчёта, не больше limit. */
export function inputFields(id: FormulaId, m: ProjectModel | null, limit = INPUT_FIELDS): ParameterId[] {
  const seen = new Set<string>([id]);
  const params: ParameterId[] = [];
  let level: FormulaId[] = [id];
  while (level.length && params.length < limit) {
    const next: FormulaId[] = [];
    for (const f of level) {
      const deps = m?.result.formulas[f]?.inputs ?? (getFormula(f).depends_on as (ParameterId | FormulaId)[]);
      for (const d of deps) {
        if (seen.has(d)) continue;
        seen.add(d);
        if (isParameterId(d)) {
          if (getParameter(d).scope === "project" && !d.includes("LEGACY") && !TECHNICAL.has(d)) params.push(d);
        } else if (isFormulaId(d)) next.push(d);
      }
    }
    level = next;
  }
  return params.slice(0, limit);
}

/** Короткое название акта: «Приказ Росреестра от 23.10.2020 № П/0393 (ред. …) — …» → «Приказ Росреестра П/0393». */
export function shortSource(title: string): string {
  const head = title.split(/ — | «| \(|: /)[0]!;
  return head
    .replace(/\s+от \d{1,2}\.\d{2}\.\d{4}( г\.)?/g, "")
    .replace(/№\s*/g, "")
    .replace(/ России(?=\s|$)/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}
