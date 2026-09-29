/**
 * VAR — варианты освоения участка (data/formulas.yaml, модуль VAR): этажность и классы вариантов, их список, очереди,
 * вехи, план продаж и бюджет варианта, выбор лучшего по итогам полного расчёта каждого варианта.
 */
import Decimal from "decimal.js";
import { getParameter, spec } from "@fm/spec";
import type { FormulaContext } from "../context";
import { CalcError } from "../context";
import { eomonth, isIsoDate } from "../lib/dates";
import { fmt, fmtMln, fmtShare } from "../lib/format";
import { marketKey, type MarketPrice } from "./market";
import type { MilestoneKey, MilestoneRow } from "./time";

const ZERO = new Decimal(0);
const ONE = new Decimal(1);

/** Строка BENCH.HEIGHT_BAND. */
interface HeightBand {
  band: string;
  floors_min: number | null;
  floors_max: number | null;
}

/** Вариант освоения: класс, этажность, есть ли апартаменты. */
export interface Variant {
  id: string;
  housing_class: string;
  floors: number;
  apart: boolean;
}

export const variantId = (cls: string, floors: number, apart: boolean): string => `${cls}-${floors}${apart ? "-апарт" : ""}`;

/** Продукт варианта: как называется в плане продаж и откуда берётся запас. */
const PRODUCTS = [
  { product: "квартиры", title: "Квартиры" },
  { product: "ПСН", title: "ПСН" },
  { product: "апартаменты", title: "Апартаменты" },
  { product: "машино-места", title: "Машино-места" },
] as const;
type Product = (typeof PRODUCTS)[number]["product"];

/** Строки плана продаж варианта (SALES.PRODUCTS, SALES.PACE) и продукты, которые не учтены. */
export interface VariantSales {
  products: Record<string, unknown>[];
  pace: Record<string, unknown>[];
  /** Продукты с запасом, но без цены или темпа по аналогам: в выручку не входят. */
  missing: string[];
}

/** Строка VAR.RESULTS. */
export interface VariantResult {
  variant: string;
  computed: boolean;
  npv?: number | null;
  net_profit?: number | null;
  irr?: number | null;
  peak_debt?: number | null;
  sales_months?: number | null;
  not_counted?: string[] | null;
}

/** Выбор лучшего: лучший вариант (или null) и почему не прошли остальные. */
export interface BestChoice {
  best: string | null;
  criterion: string;
  /** Причины, по которым вариант не проходит условия (пусто — проходит). */
  reasons: Record<string, string[]>;
  /** Почему лучший не выбран (нет прошедших вариантов, не посчитан критерий). */
  blocked: string | null;
}

function window(ctx: FormulaContext): Decimal {
  const w = ctx.requireNum("TIME.CONSTRUCTION_M").sub(ctx.requireNum("TIME.SALES_AFTER_RNS_M"));
  if (w.lte(ZERO)) throw new CalcError("Срок строительства должен быть больше срока от разрешения на строительство до старта продаж", "TIME.CONSTRUCTION_M");
  return w;
}

function aptPace(ctx: FormulaContext): Decimal {
  const cls = ctx.require<string>("GEN.HOUSING_CLASS");
  const pace = ctx.formula<Record<string, Decimal | null>>("F.MARKET.PACE")[marketKey("квартиры", cls)] ?? null;
  if (pace === null || pace.lte(ZERO)) {
    throw new CalcError(`Нет темпа продаж квартир класса «${cls}» по аналогам: добавьте не меньше ${fmt(ctx.requireNum("BENCH.MARKET_MIN_COMPS"))} аналогов с темпом`, "MARKET.ANALOGS");
  }
  return pace;
}

export function F_VAR_FLOORS(ctx: FormulaContext): Decimal[] {
  const max = ctx.requireNum("GPZU.MAX_FLOORS");
  const bands = ctx.require<HeightBand[]>("BENCH.HEIGHT_BAND").filter((b) => b.floors_min !== null);
  const band0 = bands.find((b) => max.gte(b.floors_min as number) && (b.floors_max === null || max.lte(b.floors_max)));
  if (!band0) throw new CalcError(`Предельная этажность ${fmt(max)} не попадает ни в одну группу высотности. Проверьте предельную этажность в ограничениях участка`, "GPZU.MAX_FLOORS");
  const lower = bands
    .filter((b): b is HeightBand & { floors_max: number } => b.floors_max !== null && b.floors_max < (band0.floors_min as number))
    .map((b) => new Decimal(b.floors_max))
    .sort((a, b) => b.cmp(a))
    .slice(0, ctx.requireNum("VAR.LOWER_LEVELS").toNumber());
  return [max, ...lower];
}

export function F_VAR_CLASSES(ctx: FormulaContext): string[] {
  const prices = ctx.formula<Record<string, MarketPrice | null>>("F.MARKET.PRICE");
  const options = getParameter("GEN.HOUSING_CLASS").options ?? [];
  const found = options
    .map((cls) => ({ cls, price: prices[marketKey("квартиры", cls)] ?? null }))
    .filter((x): x is { cls: string; price: MarketPrice } => x.price !== null)
    .sort((a, b) => b.price.n - a.price.n);
  if (found.length === 0) {
    throw new CalcError(`Нет цены квартир ни по одному классу: добавьте не меньше ${fmt(ctx.requireNum("BENCH.MARKET_MIN_COMPS"))} аналогов квартир одного класса с ценой и темпом`, "MARKET.ANALOGS");
  }
  return found.map((x) => x.cls);
}

export function F_VAR_LIST(ctx: FormulaContext): Variant[] {
  const classes = ctx.formula<string[]>("F.VAR.CLASSES");
  const floors = ctx.formula<Decimal[]>("F.VAR.FLOORS").map((f) => f.toNumber());
  const list: Variant[] = classes.flatMap((cls) => floors.map((f) => ({ id: variantId(cls, f, false), housing_class: cls, floors: f, apart: false })));
  const share = ctx.num("TEP.APART_GFA_SHARE");
  if (ctx.param<boolean>("GPZU.APART_ALLOWED") === true && share !== null && share.gt(ZERO) && ctx.num("TEP.APART_EFFICIENCY") !== null) {
    const prices = ctx.formula<Record<string, MarketPrice | null>>("F.MARKET.PRICE");
    const top = Math.max(...floors);
    for (const cls of classes) if (prices[marketKey("апартаменты", cls)]) list.push({ id: variantId(cls, top, true), housing_class: cls, floors: top, apart: true });
  }
  return list.slice(0, ctx.requireNum("VAR.MAX_VARIANTS").toNumber());
}

export function F_VAR_PHASES(ctx: FormulaContext): Decimal {
  const area = ctx.formula<Decimal>("F.TEP.APT_AREA");
  const n = area.div(aptPace(ctx).mul(window(ctx))).ceil();
  return Decimal.max(ONE, n);
}

export function F_VAR_MILESTONES(ctx: FormulaContext): MilestoneRow[] {
  const start = ctx.require<string>("GEN.MODEL_START_DATE");
  if (!isIsoDate(start)) throw new CalcError("Дата начала модели должна быть датой, например 30.09.2026", "GEN.MODEL_START_DATE");
  const phases = ctx.formula<Decimal>("F.VAR.PHASES").toNumber();
  const w = window(ctx).toNumber();
  const pre = ctx.requireNum("TIME.PRE_RNS_M").toNumber();
  const build = ctx.requireNum("TIME.CONSTRUCTION_M").toNumber();
  const lag = ctx.requireNum("TIME.SALES_AFTER_RNS_M").toNumber();
  const land = eomonth(start, 0);
  return Array.from({ length: phases }, (_, i) => {
    const rns = eomonth(start, pre + i * w);
    const rnv = eomonth(rns, build);
    return {
      phase: i + 1,
      land_acquired: land,
      design_start: land,
      expertise_done: rns,
      rns_date: rns,
      construction_start: rns,
      sales_start: eomonth(rns, lag),
      rnv_date: rnv,
      construction_end: rnv,
      handover_start: rnv,
      handover_end: rnv,
    };
  });
}

/** Запас продукта варианта: площадь (м²) или штуки для машино-мест. */
function stockOf(ctx: FormulaContext, product: Product): Decimal {
  switch (product) {
    case "квартиры":
      return ctx.formula<Decimal>("F.TEP.APT_AREA");
    case "ПСН":
      return ctx.formula<Decimal>("F.TEP.COMM_AREA");
    case "апартаменты":
      return ctx.formula<Decimal>("F.TEP.APART_AREA");
    case "машино-места":
      return ctx.formula<Decimal>("F.TEP.PARKING_COUNT");
  }
}

export function F_VAR_PRODUCTS(ctx: FormulaContext): VariantSales {
  const cls = ctx.require<string>("GEN.HOUSING_CLASS");
  const valuation = ctx.require<string>("GEN.VALUATION_DATE");
  if (!isIsoDate(valuation)) throw new CalcError("Дата оценки должна быть датой, например 30.09.2026", "GEN.VALUATION_DATE");
  const aptArea = ctx.formula<Decimal>("F.TEP.APT_AREA");
  if (aptArea.lte(ZERO)) throw new CalcError("Площадь квартир варианта — 0 м²: проверьте долю жилой части и коэффициент выхода площади квартир в справочнике", "TEP.APT_EFFICIENCY");
  const phases = ctx.formula<Decimal>("F.VAR.PHASES").toNumber();
  const perPhase = aptPace(ctx).mul(window(ctx));
  // Доля очереди в запасе: по квартирам, которые рынок продаёт за срок продаж очереди до ввода; последней — остаток
  const shares: Decimal[] = [];
  let left = aptArea;
  for (let p = 1; p <= phases; p++) {
    const apt = p === phases ? left : Decimal.min(perPhase, left);
    shares.push(apt.div(aptArea));
    left = left.sub(apt);
  }
  const prices = ctx.formula<Record<string, MarketPrice | null>>("F.MARKET.PRICE");
  const paces = ctx.formula<Record<string, Decimal | null>>("F.MARKET.PACE");
  const out: VariantSales = { products: [], pace: [], missing: [] };
  for (const { product, title } of PRODUCTS) {
    const stock = stockOf(ctx, product);
    if (stock.lte(ZERO)) continue;
    const price = prices[marketKey(product, cls)] ?? null;
    const pace = paces[marketKey(product, cls)] ?? null;
    if (price === null || pace === null) {
      out.missing.push(title);
      ctx.message("warning", `${title} не учтены в выручке: нет цены или темпа по аналогам класса «${cls}» (нужно не меньше ${fmt(ctx.requireNum("BENCH.MARKET_MIN_COMPS"))} аналогов). Добавьте аналоги на экране «Рынок»`, "MARKET.ANALOGS");
      continue;
    }
    const pieces = product === "машино-места";
    let rest = stock;
    shares.forEach((share, i) => {
      const last = i === shares.length - 1;
      const raw = last ? rest : stock.mul(share);
      const qty = pieces && !last ? raw.floor() : raw;
      rest = rest.sub(qty);
      const name = phases > 1 ? `${title}, очередь ${i + 1}` : title;
      out.products.push({
        name,
        product,
        phase: i + 1,
        ...(pieces ? { stock_units: qty.toNumber() } : { stock_area: qty.toNumber() }),
        start_price: price.price.toNumber(),
        price_date: valuation,
        sale_channel_before_rnv: "ДДУ_эскроу",
        source_ids: ["S_MARKET_ANALOGS"],
      });
      out.pace.push({ name, method: "в_месяц", value: pace.toNumber() });
    });
  }
  return out;
}

/** «Ставка за» строки CAPEX.ESTIMATE_RATES → база статьи бюджета (formulas.yaml → F.VAR.CAPEX). */
const BASE_OF: Record<string, string> = {
  "сумма на проект": "фикс",
  "м² участка": "LAND.AREA",
  "м² наземной ГНС": "F.TEP.GFA_ABOVE",
  "м² общей ГНС": "F.TEP.GFA_TOTAL",
  "м² продаваемой площади": "F.TEP.SALEABLE_AREA",
  "м² благоустройства": "F.TEP.LANDSCAPE_AREA",
};

/** Строка CAPEX.ESTIMATE_RATES. */
interface EstimateRate {
  item: string;
  housing_class?: string | null;
  per: string;
  rate?: number | null;
  price_date?: string | null;
  vat?: string | null;
}

const ALL_CLASSES = "все";

/** Строка CAPEX.CLASS_RATIO. */
interface ClassRatio {
  item?: string | null;
  housing_class?: string | null;
  base_class?: string | null;
  ratio?: number | null;
}

export function F_VAR_CAPEX(ctx: FormulaContext): Record<string, unknown>[] {
  const cls = ctx.require<string>("GEN.HOUSING_CLASS");
  const rates = ctx.param<EstimateRate[]>("CAPEX.ESTIMATE_RATES") ?? [];
  if (!Array.isArray(rates)) throw new CalcError("Ставки статей бюджета: нужен список строк", "CAPEX.ESTIMATE_RATES");
  const first = ctx.formula<MilestoneRow[]>("F.VAR.MILESTONES")[0] as MilestoneRow;
  const chosen = new Map<string, EstimateRate>();
  for (const r of rates) {
    if (typeof r.rate !== "number") continue;
    if (r.housing_class !== cls && r.housing_class !== ALL_CLASSES) continue;
    const had = chosen.get(r.item);
    if (!had || (had.housing_class === ALL_CLASSES && r.housing_class === cls)) chosen.set(r.item, r);
  }
  // Класс без своей ставки статьи: доля от ставки класса-основы (CAPEX.CLASS_RATIO)
  const ratios = ctx.param<ClassRatio[]>("CAPEX.CLASS_RATIO") ?? [];
  for (const q of Array.isArray(ratios) ? ratios : []) {
    if (q.housing_class !== cls || typeof q.ratio !== "number" || !q.item || !q.base_class) continue;
    if (chosen.get(q.item)?.housing_class === cls) continue;
    const base = rates.find((r) => r.item === q.item && r.housing_class === q.base_class && typeof r.rate === "number");
    if (base) chosen.set(q.item, { ...base, housing_class: cls, rate: new Decimal(base.rate as number).mul(q.ratio).toNumber() });
  }
  const rows: Record<string, unknown>[] = [];
  for (const [name, r] of chosen) {
    const c = spec.capexItems.find((x) => x.name === name);
    if (!c) throw new CalcError(`Ставки статей бюджета: статьи «${name}» нет в справочнике статей`, "CAPEX.ESTIMATE_RATES");
    const base = BASE_OF[r.per];
    if (!base) throw new CalcError(`Ставки статей бюджета, «${name}»: неизвестная база «${r.per}»`, "CAPEX.ESTIMATE_RATES");
    const row: Record<string, unknown> = { item_id: c.item_id, base, rate: r.rate, price_date: r.price_date ?? null, vat_included: r.vat === "с НДС" };
    const from = c.schedule_from as MilestoneKey | null | undefined;
    const to = c.schedule_to as MilestoneKey | null | undefined;
    if (c.schedule_rule === "manual") Object.assign(row, { schedule_rule: "at_milestone", schedule_from: "rns_date" });
    else if (from && to && first[from] === first[to]) Object.assign(row, { schedule_rule: "at_milestone", schedule_from: from });
    rows.push(row);
  }
  return rows;
}

// ---------- контроль по НЦС ----------

/** Строка BENCH.NCS_RATES. */
export interface NcsRow {
  floors_min: number | null;
  floors_max: number | null;
  rate: number | null;
}

export interface NcsCheck {
  /** Границы норматива той же этажности, руб/м² наземной ГНС с НДС; null — строк нет. */
  min: Decimal | null;
  max: Decimal | null;
  /** Ставка СМР надземной части варианта, руб/м² наземной ГНС с НДС; null — ставки нет. */
  rate: Decimal | null;
  below: boolean;
}

/** Диапазон НЦС для этажности, пересчитанный коэффициентом k (регион, площади, НДС). */
export function ncsRange(rows: readonly NcsRow[], floors: number, k: Decimal): { min: Decimal; max: Decimal } | null {
  const xs = rows
    .filter((r) => typeof r.rate === "number" && (r.floors_min === null || r.floors_min <= floors) && (r.floors_max === null || floors <= r.floors_max))
    .map((r) => new Decimal(r.rate as number));
  if (xs.length === 0) return null;
  return { min: Decimal.min(...xs).mul(k), max: Decimal.max(...xs).mul(k) };
}

const SMR_ABOVE = "SMR_ABOVE";

export function F_VAR_NCS_CHECK(ctx: FormulaContext): NcsCheck {
  const rows = ctx.require<NcsRow[]>("BENCH.NCS_RATES");
  const floors = ctx.requireNum("GPZU.MAX_FLOORS").toNumber();
  const kPer = ctx.region().ncs_k_per;
  if (kPer === null || kPer === undefined) throw new CalcError(`Контроль по нормативу цены строительства не выполнен: для региона «${ctx.region().name}» нет коэффициента перехода (таблица 1 НЦС 81-02-01-2026)`, "GEN.REGION_CODE");
  const vat = ONE.add(ctx.requireNum("TAX.VAT_RATE"));
  const apt = ctx.formula<Decimal>("F.TEP.APT_AREA");
  const gfa = ctx.formula<Decimal>("F.TEP.GFA_ABOVE");
  if (gfa.isZero()) throw new CalcError("Наземная площадь варианта равна нулю");
  const range = ncsRange(rows, floors, new Decimal(kPer).mul(apt).div(gfa).mul(vat));
  const smr = ctx.formula<Record<string, unknown>[]>("F.VAR.CAPEX").find((r) => r.item_id === SMR_ABOVE);
  const rate = typeof smr?.rate === "number" ? (smr.vat_included ? new Decimal(smr.rate) : new Decimal(smr.rate).mul(vat)) : null;
  const below = !!range && rate !== null && rate.lt(range.min);
  if (below && range && rate) {
    ctx.message("warning", `Ставка СМР надземной части ${fmt(rate.round())} руб/м² ниже норматива цены строительства той же этажности (от ${fmt(range.min.round())} руб/м² с НДС): проверьте ставку класса в справочнике`);
  }
  return { min: range?.min ?? null, max: range?.max ?? null, rate, below };
}

/** Условие отбора: порог, значение варианта и текст причины, если вариант его не проходит. */
function failed(value: number | null | undefined, limit: Decimal | null, ok: (v: Decimal, l: Decimal) => boolean, text: (v: Decimal, l: Decimal) => string, missing: string): string | null {
  if (limit === null) return null;
  if (value === null || value === undefined) return missing;
  const v = new Decimal(value);
  return ok(v, limit) ? null : text(v, limit);
}

const NPV_CRITERION = "NPV";

export function F_VAR_BEST(ctx: FormulaContext): BestChoice {
  const rows = ctx.require<VariantResult[]>("VAR.RESULTS");
  if (!Array.isArray(rows) || rows.length === 0) throw new CalcError("Нет посчитанных вариантов", "VAR.RESULTS");
  const criterion = ctx.require<string>("VAL.SELECT_CRITERION");
  const hurdle = ctx.num("VAL.HURDLE_IRR");
  const maxDebt = ctx.num("VAL.MAX_PEAK_DEBT");
  const maxSales = ctx.num("VAL.MAX_SALES_M");
  const computed = rows.filter((r) => r.computed);
  const common = computed.reduce<Set<string> | null>((acc, r) => {
    const own = new Set(r.not_counted ?? []);
    return acc === null ? own : new Set([...acc].filter((x) => own.has(x)));
  }, null);
  const reasons: Record<string, string[]> = {};
  for (const r of rows) {
    const out: string[] = [];
    if (!r.computed) out.push("не посчитан полностью");
    else {
      const extra = (r.not_counted ?? []).filter((x) => !common?.has(x));
      if (extra.length > 0) out.push(`не учтено то, что учтено в других вариантах: ${extra.join(", ")}`);
      const checks = [
        failed(r.irr, hurdle, (v, l) => v.gte(l), (v, l) => `IRR ${fmtShare(v)} ниже порога ${fmtShare(l)}`, "IRR не посчитана"),
        failed(r.peak_debt, maxDebt, (v, l) => v.lte(l), (v, l) => `пиковый долг ${fmtMln(v)} выше лимита ${fmtMln(l)}`, "пиковый долг не посчитан"),
        failed(r.sales_months, maxSales, (v, l) => v.lte(l), (v, l) => `срок продаж ${fmt(v)} мес. дольше предела ${fmt(l)} мес.`, "срок продаж не посчитан"),
      ];
      out.push(...checks.filter((x): x is string => x !== null));
    }
    reasons[r.variant] = out;
  }
  const passing = rows.filter((r) => (reasons[r.variant] ?? []).length === 0);
  const key = (r: VariantResult) => (criterion === NPV_CRITERION ? r.npv : r.net_profit);
  const label = criterion === NPV_CRITERION ? "NPV" : "прибыль";
  if (passing.length === 0) return { best: null, criterion, reasons, blocked: "Лучший вариант не выбран: ни один вариант не проходит условия отбора" };
  if (passing.some((r) => key(r) === null || key(r) === undefined)) {
    return { best: null, criterion, reasons, blocked: `Лучший вариант не выбран: критерий выбора — ${label}, а он посчитан не у всех вариантов, которые проходят условия` };
  }
  const best = passing.reduce((a, b) => ((key(b) as number) > (key(a) as number) ? b : a));
  return { best: best.variant, criterion, reasons, blocked: null };
}

export const VAR_FORMULAS = {
  "F.VAR.FLOORS": F_VAR_FLOORS,
  "F.VAR.CLASSES": F_VAR_CLASSES,
  "F.VAR.LIST": F_VAR_LIST,
  "F.VAR.NCS_CHECK": F_VAR_NCS_CHECK,
  "F.VAR.PHASES": F_VAR_PHASES,
  "F.VAR.MILESTONES": F_VAR_MILESTONES,
  "F.VAR.PRODUCTS": F_VAR_PRODUCTS,
  "F.VAR.CAPEX": F_VAR_CAPEX,
  "F.VAR.BEST": F_VAR_BEST,
} as const;
