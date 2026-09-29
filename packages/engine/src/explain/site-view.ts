/**
 * Строки экранов анализа участка: нормативы, градпотенциал, рынок, итоги вариантов и сравнение. Только подпись и
 * форматирование результатов ядра; экраны показывают эти строки как есть.
 */
import Decimal from "decimal.js";
import { getParameter, getRegion, getSource, isRegionCode, type ParameterId, type SourceId, type SpecAssumptionVersion as AssumptionVersion } from "@fm/spec";
import { versionOf } from "../project";
import { formatValue } from "../reference";
import { date, num, plural } from "../lib/text";
import type { Origin } from "../plot";
import { siteDisplay, siteOf, siteValue, variantTitle, HOUSING_CLASSES, ANALOG_PRODUCTS, analogPaceUnit, analogPriceUnit, type AnalysisSnapshot, type SiteFieldKey } from "../site";
import type { LandProject } from "../plot";
import type { SiteAnalysis, VariantSummary, BestChoice } from "../analysis";
import type { GfaLimit } from "../modules/site";
import { marketKey } from "../modules/market";

export type Tone = "yel" | "red" | "grn" | "gry";

export interface ViewRow {
  label: string;
  value: string;
  origin: Origin | null;
  basis: { title: string; url: string | null } | null;
  tone?: Tone | undefined;
  note?: string | undefined;
  /** Поле, которое финансист вводит сам (открывает правку). */
  edit?: SiteFieldKey;
}

const MILLION = new Decimal(1_000_000);
const PERCENT = 100;

/** Деньги в таблицах анализа — в млн руб, один масштаб. */
export const mln = (d: Decimal | null): string => (d === null ? "—" : num(d.div(MILLION), 1));
const pct = (d: Decimal | null): string => (d === null ? "—" : `${num(d.mul(PERCENT), 1)} %`);
const m2 = (d: Decimal | null): string => (d === null ? "—" : `${num(d, 0)} м²`);

const sourceLink = (id: SourceId | undefined): ViewRow["basis"] => {
  if (!id) return null;
  const s = getSource(id);
  return { title: s.title, url: s.url ?? null };
};

// ---------- нормативы ----------

/** Параметры справочника, на которых строятся варианты: показываются во вкладке «Нормативы». */
const VARIANT_STANDARDS: readonly ParameterId[] = [
  "TEP.RES_GFA_SHARE",
  "TEP.APT_EFFICIENCY",
  "TEP.COMM_EFFICIENCY",
  "TEP.PARKING_AREA_PER_SPACE",
  "TEP.LANDSCAPE_SHARE",
  "TIME.PRE_RNS_M",
  "TIME.CONSTRUCTION_M",
  "TIME.SALES_AFTER_RNS_M",
  "SALES.PRICE_MARKET_GROWTH",
];

function refText(param: ParameterId, v: unknown): string | null {
  const f = formatValue(getParameter(param), v);
  if (!f) return null;
  if (f.text) return f.text;
  return f.table ? f.table.rows.map((r) => r.join(" — ")).join("; ") : null;
}

function ownRow(p: LandProject, key: SiteFieldKey, label: string, note: string, link: ViewRow["basis"]): ViewRow {
  const v = siteValue(p, key);
  return {
    label,
    value: v.value === null ? "нет значения" : siteDisplay(key, v.value),
    origin: v.origin,
    basis: v.basis ? { title: v.basis.title, url: v.basis.url ?? null } : link,
    tone: v.value === null ? "yel" : undefined,
    note: v.value === null ? note : undefined,
    edit: key,
  };
}

/** Нормативы региона и стандартные значения компании, на которых строятся варианты. */
export function normRows(p: LandProject, versions: readonly AssumptionVersion[]): { region: ViewRow[]; standard: ViewRow[] } {
  const code = p.plot.regionCode.value;
  const region: ViewRow[] = [];
  const r = code && isRegionCode(code) ? getRegion(code) : null;
  if (r?.parking_norm.values) {
    const parts = (r.parking_norm.values as { max_area: number | null; per_apt: number }[]).map((x) =>
      x.max_area === null ? `больше — ${num(x.per_apt)}` : `до ${num(x.max_area)} м² — ${num(x.per_apt)}`,
    );
    region.push({
      label: "Норматив машино-мест на квартиру",
      value: parts.join("; "),
      origin: "source",
      basis: sourceLink(r.parking_norm.source_ids[0] as SourceId | undefined),
      tone: r.parking_norm.status === "verified" ? "grn" : "red",
    });
  } else {
    const link = code === "50" ? sourceLink("S_MO_NGP_713") : null;
    region.push(ownRow(p, "parkingPerApt", "Норматив машино-мест на квартиру", "В справочнике регионов норматива нет: введите по нормативам градостроительного проектирования с документом.", link));
  }
  const tax = r?.land_tax_rate_housing ?? null;
  if (tax && typeof tax.value === "number") {
    region.push({
      label: "Ставка земельного налога",
      value: `${num(tax.value * PERCENT, 2)} %`,
      origin: "source",
      basis: sourceLink(tax.source_ids[0] as SourceId | undefined),
      tone: tax.status === "needs_verification" ? "red" : "grn",
      note: tax.status === "needs_verification" ? "Перепроверить у налогового консультанта" : undefined,
    });
  } else {
    region.push(ownRow(p, "landTaxRate", "Ставка земельного налога", "Ставка устанавливается муниципалитетом: введите по решению с документом.", sourceLink("S_FNS_RATES")));
  }
  const version = p.assumptionsSnapshot ?? versionOf([...versions], p.assumptionsVersion);
  const standard = VARIANT_STANDARDS.map((param): ViewRow => {
    const item = version?.items.find((i) => i.param === param);
    const text = item ? refText(param, item.value) : null;
    return {
      label: getParameter(param).name,
      value: text ?? "нет значения",
      origin: text ? "reference" : null,
      basis: item ? { title: item.from.text, url: item.from.url ?? null } : null,
      tone: text ? (item?.status === "approved" ? "grn" : item?.status === "check" ? "red" : "gry") : "yel",
      note: text ? undefined : "Заполните в справочнике, раздел «Оценка участка»",
    };
  });
  return { region, standard };
}

// ---------- градпотенциал ----------

const LIMIT_LABEL: Record<GfaLimit, string> = {
  gfa: "Предельная наземная площадь по ГПЗУ",
  density: "По плотности застройки: площадь участка × плотность",
  share: "По проценту застройки и этажности: площадь под застройку × процент × этажность",
};

export interface PotentialRow {
  label: string;
  value: string;
  /** Самое жёсткое ограничение. */
  binding?: boolean;
}

/** Градпотенциал: площадь под застройку, ограничения объёма, пятно, этажность и классы вариантов. */
export function potentialRows(p: LandProject, sa: SiteAnalysis): PotentialRow[] {
  const area = p.plot.area.value === null ? null : new Decimal(p.plot.area.value);
  const rows: PotentialRow[] = [{ label: "Площадь участка", value: m2(area) }];
  if (area && sa.buildable) {
    rows.push({ label: "В зонах, где строить нельзя", value: m2(area.sub(sa.buildable)) });
    rows.push({ label: "Площадь под застройку", value: m2(sa.buildable) });
  }
  if (sa.maxGfa) {
    for (const [k, v] of Object.entries(sa.maxGfa.limits) as [GfaLimit, Decimal][]) rows.push({ label: LIMIT_LABEL[k], value: m2(v), binding: k === sa.maxGfa.limit });
    rows.push({ label: "Максимальная наземная площадь", value: m2(sa.maxGfa.value) });
  }
  if (sa.footprint) rows.push({ label: "Пятно застройки при предельной этажности", value: m2(sa.footprint) });
  if (sa.floors.length) rows.push({ label: "Этажность вариантов", value: sa.floors.map((f) => `${f} ${plural(f, ["этаж", "этажа", "этажей"])}`).join(", ") });
  if (sa.classes.length) rows.push({ label: "Классы с ценой по аналогам", value: sa.classes.join(", ") });
  return rows;
}

// ---------- рынок ----------

export interface MarketRow {
  product: string;
  housingClass: string;
  analogs: number;
  price: string;
  range: string;
  pace: string;
  capacity: string;
  /** Аналогов хватает для цены и темпа. */
  enough: boolean;
}

/** Цена, темп и ёмкость по продуктам и классам. */
export function marketRows(p: LandProject, sa: SiteAnalysis): MarketRow[] {
  const analogs = siteOf(p).analogs;
  const rows: MarketRow[] = [];
  for (const product of ANALOG_PRODUCTS) {
    for (const cls of HOUSING_CLASSES) {
      const n = analogs.filter((a) => a.product === product && a.housingClass === cls).length;
      if (n === 0) continue;
      const k = marketKey(product, cls);
      const price = sa.prices[k] ?? null;
      const pace = sa.paces[k] ?? null;
      const cap = sa.capacity[k] ?? null;
      rows.push({
        product,
        housingClass: cls,
        analogs: n,
        price: price ? `${num(price.price, 0)} ${analogPriceUnit(product)}` : "—",
        range: price ? `${num(price.min, 0)}–${num(price.max, 0)}` : "—",
        pace: pace ? `${num(pace, 0)} ${analogPaceUnit(product)}` : "—",
        capacity: cap ? `${num(cap, 0)} ${analogPaceUnit(product)}` : "—",
        enough: price !== null && pace !== null,
      });
    }
  }
  return rows;
}

// ---------- варианты ----------

export interface Fact {
  label: string;
  value: string;
}

/** Итоги варианта для карточки: площади, выручка, затраты, прибыль, доходность, долг, срок продаж. */
export function variantFacts(s: VariantSummary): Fact[] {
  return [
    { label: "Очередей", value: s.phases === null ? "—" : num(s.phases) },
    { label: "Наземная площадь", value: m2(s.gfaAbove) },
    { label: "Площадь квартир", value: m2(s.aptArea) },
    { label: "Машино-мест", value: s.parking === null ? "—" : num(s.parking, 0) },
    { label: "Выручка, млн руб", value: mln(s.revenue) },
    { label: "Затраты, млн руб", value: mln(s.capex) },
    { label: "Чистая прибыль, млн руб", value: mln(s.netProfit) },
    { label: "Рентабельность продаж", value: pct(s.netMargin) },
    { label: "IRR акционера", value: pct(s.irr) },
    { label: "NPV акционера, млн руб", value: mln(s.npv) },
    { label: "Пиковый долг, млн руб", value: mln(s.peakDebt) },
    { label: "Срок продаж", value: s.salesMonths === null ? "—" : `${s.salesMonths} мес` },
  ];
}

/** Почему вариант не посчитан полностью: первые ошибки, по одной на параметр. */
export function variantProblems(s: VariantSummary, limit = 3): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const e of s.errors) {
    const k = e.parameterId ?? e.text;
    if (seen.has(k)) continue;
    seen.add(k);
    // Технические обозначения в скобках («(CAPEX.ITEMS → rate)») финансисту не нужны
    out.push(e.text.replace(/\s*\([^()]*[A-Z][A-Z_]*\.[^()]*\)/g, ""));
  }
  return out.slice(0, limit);
}

/** Ставка дисконтирования = безрисковая ставка + премия за риск (F.KPI.DISCOUNT_RATE): обе нужны для NPV. */
const DISCOUNT_PARAMS: readonly ParameterId[] = ["VAL.RISK_FREE", "VAL.EQUITY_PREMIUM"];

/** Чего не хватает для критерия выбора (NPV): параметры, из-за которых он не посчитан. */
export function criterionMissing(summaries: readonly VariantSummary[]): string[] {
  const names = new Set<string>();
  for (const s of summaries) {
    for (const e of s.errors) {
      if (!e.formulaId.startsWith("F.KPI.") || !e.parameterId) continue;
      if (e.formulaId === "F.KPI.DISCOUNT_RATE") {
        const input = s.model?.input;
        for (const id of DISCOUNT_PARAMS) if ((input?.values[id] ?? input?.standard?.[id] ?? null) === null) names.add(getParameter(id).name);
      } else names.add(getParameter(e.parameterId).name);
    }
  }
  return [...names];
}

/** Что не учтено во всех вариантах сразу — показывается один раз над карточками. */
export function commonNotCounted(summaries: readonly VariantSummary[]): string[] {
  const computed = summaries.filter((s) => s.model !== null);
  if (computed.length === 0) return [];
  return (computed[0] as VariantSummary).notCounted.filter((x) => computed.every((s) => s.notCounted.includes(x)));
}

/** Что не учтено в варианте сверх общего списка. */
export function ownNotCounted(s: VariantSummary, common: readonly string[]): string[] {
  return s.notCounted.filter((x) => !common.includes(x));
}

export interface CompareTable {
  headers: string[];
  rows: { label: string; cells: string[] }[];
  best: string | null;
  /** Почему выбран лучший или почему не выбран. */
  why: string;
  /** Для выбора не хватает значений справочника. */
  needsReference: boolean;
  /** Причины по вариантам, которые не прошли условия. */
  reasons: { title: string; text: string }[];
}

/** Таблица «Сравнение»: показатели по вариантам и почему выбран лучший. */
export function compareTable(summaries: readonly VariantSummary[], choice: BestChoice | null): CompareTable {
  const facts = summaries.map(variantFacts);
  const labels = facts[0]?.map((f) => f.label) ?? [];
  const title = (id: string) => {
    const s = summaries.find((x) => x.variant.id === id);
    return s ? variantTitle(s.variant) : id;
  };
  const criterion = choice?.criterion === "NPV" ? "NPV акционера" : "чистая прибыль";
  let why: string;
  if (!choice) why = "Лучший вариант не выбран: не посчитаны итоги вариантов.";
  else if (choice.best) why = `Лучший — «${title(choice.best)}»: наибольшая ${criterion} среди вариантов, которые проходят условия отбора и сопоставимы по составу затрат и продаж.`;
  else {
    const missing = criterionMissing(summaries);
    why = `${choice.blocked ?? "Лучший вариант не выбран"}.${missing.length ? ` Заполните в справочнике, раздел «Оценка участка»: ${missing.map((m) => `«${m}»`).join(", ")}.` : ""}`;
  }
  return {
    headers: summaries.map((s) => variantTitle(s.variant)),
    rows: labels.map((label, i) => ({ label, cells: facts.map((f) => f[i]?.value ?? "—") })),
    best: choice?.best ?? null,
    why,
    needsReference: !choice?.best && criterionMissing(summaries).length > 0,
    reasons: summaries.filter((s) => (choice?.reasons[s.variant.id] ?? []).length > 0).map((s) => ({ title: variantTitle(s.variant), text: (choice?.reasons[s.variant.id] ?? []).join("; ") })),
  };
}

/** Итоги для карточки проекта в списке. */
export function snapshotOf(summaries: readonly VariantSummary[], choice: BestChoice | null, at: string): AnalysisSnapshot {
  const best = summaries.find((s) => s.variant.id === choice?.best) ?? null;
  return { at, best: best?.variant.id ?? null, bestTitle: best ? variantTitle(best.variant) : null, netProfit: best?.netProfit?.toString() ?? null, variants: summaries.length };
}

/** Строка карточки проекта: «Лучший вариант: Комфорт, 17 этажей · прибыль 1 234,5 млн руб». */
export function snapshotText(s: AnalysisSnapshot | null): string | null {
  if (!s) return null;
  if (!s.bestTitle) return `Посчитано вариантов: ${s.variants}, лучший не выбран · ${date(s.at.slice(0, 10))}`;
  return `Лучший вариант: ${s.bestTitle}${s.netProfit ? ` · прибыль ${mln(new Decimal(s.netProfit))} млн руб` : ""}`;
}
