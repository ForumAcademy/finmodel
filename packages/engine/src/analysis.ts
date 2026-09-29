/**
 * Анализ участка: градпотенциал и рынок по аналогам, варианты освоения и выбор лучшего. Для каждого варианта ядро
 * строит его вводные (этажность, класс, пятно, очереди, вехи, план продаж, бюджет — формулы модуля VAR) и считает
 * вариант полным расчётом проекта (computeProject). Экраны только показывают результат.
 */
import Decimal from "decimal.js";
import { getCapexItem, spec, type CapexItemId, type FormulaId, type ParameterId, type SpecAssumptionVersion as AssumptionVersion } from "@fm/spec";
import { Engine } from "./context";
import { computeProject, projectInput, SPEC_ASSUMPTIONS, type CalcProject, type ProjectModel } from "./project";
import { ANALYSIS_FORMULAS } from "./registry";
import type { MarketPrice } from "./modules/market";
import type { MaxGfa } from "./modules/site";
import type { Margin, RiskFree } from "./modules/kpi";
import type { Debt } from "./modules/fin";
import type { Revenue, RowSeries } from "./modules/sales";
import type { BestChoice, NcsCheck, Variant, VariantResult, VariantSales } from "./modules/variant";
import type { CalcMessage, ProjectInput, ResultSet } from "./types";

export type { BestChoice, Variant, VariantResult } from "./modules/variant";
export { marketKey } from "./modules/market";

const ZERO = new Decimal(0);

/** Что показывает анализ участка до вариантов: ограничения, градпотенциал, рынок, список вариантов. */
const SITE_TARGETS: FormulaId[] = [
  "F.SITE.BUILDABLE_AREA",
  "F.SITE.MAX_GFA",
  "F.SITE.FOOTPRINT",
  "F.MARKET.PRICE",
  "F.MARKET.PACE",
  "F.MARKET.CAPACITY",
  "F.VAR.FLOORS",
  "F.VAR.CLASSES",
  "F.VAR.LIST",
];

export interface SiteAnalysis {
  result: ResultSet;
  buildable: Decimal | null;
  maxGfa: MaxGfa | null;
  footprint: Decimal | null;
  prices: Record<string, MarketPrice | null>;
  paces: Record<string, Decimal | null>;
  capacity: Record<string, Decimal>;
  floors: number[];
  classes: string[];
  variants: Variant[];
}

const value = <T>(r: ResultSet, id: FormulaId): T | null => (r.formulas[id]?.value as T | undefined) ?? null;

function engineInput(project: CalcProject, versions: AssumptionVersion[], values: ProjectInput["values"]): ProjectInput {
  const base = projectInput(project, versions);
  return { ...base, values: { ...base.values, ...values } };
}

/** Градпотенциал, рынок и список вариантов проекта. */
export function analyzeSite(project: CalcProject, versions: AssumptionVersion[] = SPEC_ASSUMPTIONS): SiteAnalysis {
  const result = new Engine(engineInput(project, versions, {}), ANALYSIS_FORMULAS).run(SITE_TARGETS);
  return {
    result,
    buildable: value(result, "F.SITE.BUILDABLE_AREA"),
    maxGfa: value(result, "F.SITE.MAX_GFA"),
    footprint: value(result, "F.SITE.FOOTPRINT"),
    prices: value(result, "F.MARKET.PRICE") ?? {},
    paces: value(result, "F.MARKET.PACE") ?? {},
    capacity: value(result, "F.MARKET.CAPACITY") ?? {},
    floors: (value<Decimal[]>(result, "F.VAR.FLOORS") ?? []).map((f) => f.toNumber()),
    classes: value(result, "F.VAR.CLASSES") ?? [],
    variants: value(result, "F.VAR.LIST") ?? [],
  };
}

/** Вводные варианта: класс, этажность, пятно под эту этажность, без апартаментов — доля апартаментов 0. */
function variantOverrides(v: Variant): ProjectInput["values"] {
  return {
    "GEN.PROJECT_STAGE": "оценка участка",
    "GEN.HOUSING_CLASS": v.housing_class,
    "GPZU.MAX_FLOORS": v.floors,
    ...(v.apart ? {} : { "TEP.APART_GFA_SHARE": 0 }),
  };
}

const VARIANT_TARGETS: FormulaId[] = ["F.VAR.PHASES", "F.VAR.MILESTONES", "F.VAR.PRODUCTS", "F.VAR.CAPEX", "F.VAR.NCS_CHECK"];
const NCS_CHECK: FormulaId = "F.VAR.NCS_CHECK";

/** Вариант как проект: вводные для полного расчёта и что из вводных не построилось. */
export interface VariantProject {
  project: CalcProject | null;
  /** Сообщения построения варианта (пятно, очереди, план продаж, бюджет). */
  messages: CalcMessage[];
  phases: number | null;
  footprint: Decimal | null;
  sales: VariantSales | null;
  /** Контроль ставки СМР по НЦС; null — не посчитан (нет коэффициента региона или ставки). */
  ncs: NcsCheck | null;
}

/**
 * Вводные варианта. Пятно считается под этажность варианта (F.SITE.FOOTPRINT), наземная ГНС варианта — пятно ×
 * этажность: предельная ГНС по документу уже учтена в пятне, поэтому в вводные варианта она не передаётся.
 */
export function variantProject(project: CalcProject, v: Variant, versions: AssumptionVersion[] = SPEC_ASSUMPTIONS): VariantProject {
  const own = variantOverrides(v);
  const first = new Engine(engineInput(project, versions, own), ANALYSIS_FORMULAS).run(["F.SITE.FOOTPRINT"]);
  const footprint = value<Decimal>(first, "F.SITE.FOOTPRINT");
  if (footprint === null) return { project: null, messages: first.messages, phases: null, footprint: null, sales: null, ncs: null };
  const tep = { ...own, "TEP.FOOTPRINT_AREA": footprint.toNumber(), "TEP.AVG_FLOORS": v.floors, "GPZU.MAX_GFA_ABOVE": null };
  const second = new Engine(engineInput(project, versions, tep), ANALYSIS_FORMULAS).run(VARIANT_TARGETS);
  const milestones = value<unknown[]>(second, "F.VAR.MILESTONES");
  const sales = value<VariantSales>(second, "F.VAR.PRODUCTS");
  const capex = value<unknown[]>(second, "F.VAR.CAPEX");
  const phases = value<Decimal>(second, "F.VAR.PHASES");
  const ncs = value<NcsCheck>(second, NCS_CHECK);
  // Контроль по НЦС — подсказка, а не условие расчёта: его сообщения показываются через ncs
  const messages = [...first.messages, ...second.messages.filter((x) => x.formulaId !== NCS_CHECK)];
  if (!milestones || !sales || !capex) return { project: null, messages, phases: phases?.toNumber() ?? null, footprint, sales, ncs };
  const values = {
    ...project.input.values,
    ...tep,
    "TIME.MILESTONES": milestones,
    "SALES.PRODUCTS": sales.products,
    "SALES.PACE": sales.pace,
    "CAPEX.ITEMS": capex,
  };
  return {
    project: { ...project, input: { ...project.input, values, mode: "normal" } },
    messages,
    phases: phases?.toNumber() ?? null,
    footprint,
    sales,
    ncs,
  };
}

/** Итоги варианта для карточки и сравнения. null — показатель не посчитан. */
export interface VariantSummary {
  variant: Variant;
  /** Вариант посчитан полной цепочкой: есть прибыль. */
  computed: boolean;
  phases: number | null;
  footprint: Decimal | null;
  gfaAbove: Decimal | null;
  gfaTotal: Decimal | null;
  aptArea: Decimal | null;
  saleable: Decimal | null;
  parking: Decimal | null;
  revenue: Decimal | null;
  capex: Decimal | null;
  netProfit: Decimal | null;
  netMargin: Decimal | null;
  irr: Decimal | null;
  npv: Decimal | null;
  /** Ставка дисконтирования и её безрисковая часть в точке срока варианта. */
  discountRate: Decimal | null;
  riskFree: RiskFree | null;
  /** Контроль ставки СМР надземной части по НЦС. */
  ncs: NcsCheck | null;
  peakDebt: Decimal | null;
  peakEquity: Decimal | null;
  salesMonths: number | null;
  /** Не учтено в расчёте: продукты без цены или темпа, статьи бюджета без ставки. */
  notCounted: string[];
  /** Ошибки, из-за которых вариант не посчитан полностью. */
  errors: CalcMessage[];
  /** Полный расчёт варианта — для пояснений и паспорта показателя. */
  model: ProjectModel | null;
}

const num = <T>(m: ProjectModel, id: FormulaId): T | null => (m.result.formulas[id]?.value as T | undefined) ?? null;

/** Месяцев от первой до последней продажи (включительно); продаж нет — null. */
export function salesMonths(sold: RowSeries | null): number | null {
  if (!sold) return null;
  let first = -1;
  let last = -1;
  const n = Math.max(0, ...Object.values(sold).map((s) => s.length));
  for (let t = 0; t < n; t++) {
    if (Object.values(sold).some((s) => (s[t] ?? ZERO).gt(ZERO))) {
      if (first < 0) first = t;
      last = t;
    }
  }
  return first < 0 ? null : last - first + 1;
}

/** Максимум ряда; пустой — null. */
function peak(xs: readonly Decimal[] | null | undefined): Decimal | null {
  return xs && xs.length ? xs.reduce((a, b) => (b.gt(a) ? b : a)) : null;
}

/** Статьи бюджета, которые не вошли в расчёт варианта. */
function capexNotCounted(m: ProjectModel): string[] {
  const cash = num<Partial<Record<CapexItemId, unknown>>>(m, "F.CAPEX.ITEM_CASH");
  if (!cash) return [];
  return spec.capexItems.filter((c) => !cash[c.item_id]).map((c) => getCapexItem(c.item_id).name);
}

/** Посчитать вариант полностью. */
export function computeVariant(project: CalcProject, v: Variant, versions: AssumptionVersion[] = SPEC_ASSUMPTIONS): VariantSummary {
  const vp = variantProject(project, v, versions);
  const empty: VariantSummary = {
    variant: v,
    computed: false,
    phases: vp.phases,
    footprint: vp.footprint,
    gfaAbove: null,
    gfaTotal: null,
    aptArea: null,
    saleable: null,
    parking: null,
    revenue: null,
    capex: null,
    netProfit: null,
    netMargin: null,
    irr: null,
    npv: null,
    discountRate: null,
    riskFree: null,
    ncs: vp.ncs,
    peakDebt: null,
    peakEquity: null,
    salesMonths: null,
    notCounted: vp.sales?.missing ?? [],
    errors: vp.messages.filter((x) => x.severity === "error"),
    model: null,
  };
  if (!vp.project) return empty;
  const m = computeProject(vp.project, versions);
  const margin = num<Margin>(m, "F.KPI.MARGIN");
  return {
    ...empty,
    computed: margin !== null,
    gfaAbove: num(m, "F.TEP.GFA_ABOVE"),
    gfaTotal: num(m, "F.TEP.GFA_TOTAL"),
    aptArea: num(m, "F.TEP.APT_AREA"),
    saleable: num(m, "F.TEP.SALEABLE_AREA"),
    parking: num(m, "F.TEP.PARKING_COUNT"),
    revenue: num<Revenue>(m, "F.SALES.REVENUE_TOTAL")?.gross ?? null,
    capex: num(m, "F.CAPEX.TOTAL"),
    netProfit: margin?.net_profit ?? null,
    netMargin: margin?.net_margin ?? null,
    irr: num<{ irr_equity: Decimal | null }>(m, "F.KPI.IRR")?.irr_equity ?? null,
    npv: num<{ npv_equity: Decimal }>(m, "F.KPI.NPV")?.npv_equity ?? null,
    discountRate: num<Decimal>(m, "F.KPI.DISCOUNT_RATE"),
    riskFree: num<RiskFree>(m, "F.KPI.RISK_FREE"),
    peakDebt: peak(num<Debt>(m, "F.FIN.DEBT")?.debt),
    peakEquity: num<{ peak_equity: Decimal }>(m, "F.KPI.PEAK_EQUITY")?.peak_equity ?? null,
    salesMonths: salesMonths(num<RowSeries>(m, "F.SALES.SOLD_AREA")),
    notCounted: [...(vp.sales?.missing ?? []), ...capexNotCounted(m)],
    errors: [...empty.errors, ...m.result.messages.filter((x) => x.severity === "error")],
    model: m,
  };
}

/** Строка VAR.RESULTS из итогов варианта. */
export function variantResult(s: VariantSummary): VariantResult {
  const n = (x: Decimal | null) => (x === null ? null : x.toNumber());
  return { variant: s.variant.id, computed: s.computed, npv: n(s.npv), net_profit: n(s.netProfit), irr: n(s.irr), peak_debt: n(s.peakDebt), sales_months: s.salesMonths, not_counted: s.notCounted };
}

/** Выбор лучшего варианта (F.VAR.BEST) по итогам посчитанных вариантов. */
export function chooseBest(project: CalcProject, summaries: readonly VariantSummary[], versions: AssumptionVersion[] = SPEC_ASSUMPTIONS): { choice: BestChoice | null; result: ResultSet } {
  const input = engineInput(project, versions, { "VAR.RESULTS": summaries.map(variantResult) } as Partial<Record<ParameterId, unknown>>);
  const result = new Engine(input, ANALYSIS_FORMULAS).run(["F.VAR.BEST"]);
  return { choice: value(result, "F.VAR.BEST"), result };
}
