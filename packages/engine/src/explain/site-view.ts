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
import { ZCYC_PAGE } from "../zcyc";
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
    const parts = (r.parking_norm.values as { max_area: number | null; per_apt: number }[]).map((x, i, all) => {
      const prev = all[i - 1]?.max_area;
      return x.max_area === null ? `больше${prev ? ` ${num(prev)} м²` : ""} — ${num(x.per_apt)}` : `до ${num(x.max_area)} м² — ${num(x.per_apt)}`;
    });
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
  const standard = VARIANT_STANDARDS.map((param) => standardRow(p, versions, param));
  return { region, standard };
}

/** Стандартное значение справочника, на котором строятся варианты. */
function standardRow(p: LandProject, versions: readonly AssumptionVersion[], param: ParameterId): ViewRow {
  const version = p.assumptionsSnapshot ?? versionOf([...versions], p.assumptionsVersion);
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
}

// ---------- ставка дисконтирования ----------

/** Значение или диапазон по вариантам: «15,3 %» или «15,1 % – 15,3 %». */
function span(xs: readonly Decimal[], f: (d: Decimal) => string): string {
  const lo = f(Decimal.min(...xs));
  const hi = f(Decimal.max(...xs));
  return lo === hi ? lo : `${lo} – ${hi}`;
}

/**
 * Ставка дисконтирования для NPV: кривая доходности ОФЗ на дату оценки (или ручная безрисковая ставка, если кривая
 * не загружена) и премия за риск из справочника.
 */
export function rateRows(p: LandProject, versions: readonly AssumptionVersion[], summaries: readonly VariantSummary[]): ViewRow[] {
  const curve = siteOf(p).curve;
  const rows: ViewRow[] = [
    {
      label: "Кривая доходности ОФЗ",
      value: curve ? `на ${date(curve.date)}, сроки от ${num(curve.points[0]?.term ?? 0)} до ${num(curve.points.at(-1)?.term ?? 0)} лет` : "не загружена",
      origin: curve ? "source" : null,
      basis: { title: getSource("S_MOEX_ZCYC").title, url: ZCYC_PAGE },
      tone: curve ? "grn" : "yel",
      note: curve ? undefined : "Загрузите кривую на дату оценки. Если биржа недоступна, введите безрисковую ставку вручную",
    },
  ];
  if (curve) {
    const rfs = summaries.flatMap((s) => (s.riskFree?.from_curve ? [s.riskFree] : []));
    rows.push({
      label: "Безрисковая ставка",
      value: rfs.length ? `${span(rfs.map((x) => x.rf), pct)} на срок ${span(rfs.map((x) => x.term), (d) => num(d.toNumber(), 1))} года` : "посчитается с вариантами",
      origin: "source",
      basis: { title: getSource("S_MOEX_ZCYC").title, url: ZCYC_PAGE },
      note: "Точка кривой, равная сроку варианта: от даты оценки до последнего потока акционера",
    });
  } else rows.push(ownRow(p, "riskFree", "Безрисковая ставка", "Доходность ОФЗ со сроком, равным сроку проекта, на дату оценки, с документом", { title: getSource("S_MOEX_ZCYC").title, url: ZCYC_PAGE }));
  // Премия — надбавка к ставке: в п.п., а не в % годовых
  const premium = standardRow(p, versions, "VAL.EQUITY_PREMIUM");
  const v = (p.assumptionsSnapshot ?? versionOf([...versions], p.assumptionsVersion))?.items.find((i) => i.param === "VAL.EQUITY_PREMIUM")?.value;
  rows.push(typeof v === "number" ? { ...premium, value: `${num(v * PERCENT, 2)} п.п.` } : premium);
  return rows;
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
    { label: "Ставка дисконтирования", value: rateText(s) },
    { label: "Пиковый долг, млн руб", value: mln(s.peakDebt) },
    { label: "Срок продаж", value: s.salesMonths === null ? "—" : `${s.salesMonths} мес` },
  ];
}

const THOUSAND = 1000;
const thous = (d: Decimal): string => num(d.div(THOUSAND), 1);

/**
 * Контроль ставки СМР надземной части по НЦС 81-02-01-2026 той же этажности (руб/м² наземной площади с НДС).
 * Красный — ставка ниже норматива; null — норматив для региона или ставка не заданы.
 */
export function ncsLine(s: VariantSummary): { text: string; tone: Tone } | null {
  const c = s.ncs;
  if (!c || c.min === null || c.max === null || c.rate === null) return null;
  const norm = c.min.eq(c.max) ? thous(c.min) : `${thous(c.min)}–${thous(c.max)}`;
  const head = `Ставка СМР надземной части ${thous(c.rate)} тыс. руб/м², норматив цены строительства той же этажности ${norm} тыс. руб/м² (с НДС)`;
  return c.below
    ? { text: `${head}: ставка ниже норматива, проверьте долю от ставки бизнес-класса в справочнике.`, tone: "red" }
    : { text: `${head}: не ниже норматива.`, tone: "grn" };
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

/** Премия за риск берётся из справочника; безрисковая ставка — из кривой доходности ОФЗ проекта (F.KPI.RISK_FREE). */
const RISK_FREE: ParameterId = "VAL.RISK_FREE";
const PREMIUM: ParameterId = "VAL.EQUITY_PREMIUM";

const inputValue = (s: VariantSummary, id: ParameterId): unknown => {
  const input = s.model?.input;
  return input?.values[id] ?? input?.standard?.[id] ?? null;
};

/** Чего не хватает в справочнике для критерия выбора (NPV): параметры, из-за которых он не посчитан. */
export function criterionMissing(summaries: readonly VariantSummary[]): string[] {
  const names = new Set<string>();
  for (const s of summaries) {
    for (const e of s.errors) {
      if (!e.formulaId.startsWith("F.KPI.") || !e.parameterId) continue;
      if (e.formulaId === "F.KPI.DISCOUNT_RATE" || e.formulaId === "F.KPI.RISK_FREE") {
        if (inputValue(s, PREMIUM) === null) names.add(getParameter(PREMIUM).name);
      } else if (e.parameterId !== RISK_FREE) names.add(getParameter(e.parameterId).name);
    }
  }
  return [...names];
}

/** NPV не посчитан, потому что нет безрисковой ставки: кривая доходности не загружена и ставка не введена. */
export function riskFreeMissing(summaries: readonly VariantSummary[]): boolean {
  return summaries.some((s) => s.errors.some((e) => e.formulaId.startsWith("F.KPI.") && e.parameterId === RISK_FREE));
}

/** Ставка дисконтирования варианта для таблицы сравнения: «24,3 %». */
export function rateText(s: VariantSummary): string {
  return pct(s.discountRate);
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
  /** Для NPV не хватает безрисковой ставки: загрузите кривую доходности ОФЗ или введите ставку. */
  needsRiskFree: boolean;
  /** Причины по вариантам, которые не прошли условия. */
  reasons: { title: string; text: string }[];
}

/** Таблица «Сравнение»: показатели по вариантам и почему выбран лучший. */
export function compareTable(summaries: readonly VariantSummary[], choice: BestChoice | null, criterionApproved = false): CompareTable {
  const facts = summaries.map(variantFacts);
  const labels = facts[0]?.map((f) => f.label) ?? [];
  const byNpv = choice?.criterion === "NPV";
  const criterion = byNpv ? "NPV акционера" : "чистая прибыль";
  const metric = (s: VariantSummary): Decimal | null => (byNpv ? s.npv : s.netProfit);
  const best = summaries.find((s) => s.variant.id === choice?.best) ?? null;
  const bestValue = best ? metric(best) : null;
  // Прошли отбор, но уступили лучшему по критерию: разница в млн руб
  const losers = summaries.filter((s) => s !== best && (choice?.reasons[s.variant.id] ?? []).length === 0 && metric(s) !== null && bestValue !== null);
  let why: string;
  if (!choice) why = "Лучший вариант не выбран: не посчитаны итоги вариантов.";
  else if (best && bestValue !== null) {
    const next = [...losers].sort((a, b) => (metric(b) as Decimal).cmp(metric(a) as Decimal))[0];
    const second = next ? ` У следующего, «${variantTitle(next.variant)}», — ${mln(metric(next))} млн руб.` : "";
    const confirm = criterionApproved ? "" : ` Критерий выбора (${criterion}) руководитель ещё не утвердил: справочник, раздел «Оценка участка».`;
    why = `Лучший — «${variantTitle(best.variant)}»: ${criterion} ${mln(bestValue)} млн руб, ${byNpv ? "наибольший" : "наибольшая"} среди вариантов, которые проходят условия отбора и сопоставимы по составу затрат и продаж.${second}${confirm}`;
  } else {
    const missing = criterionMissing(summaries);
    const rf = riskFreeMissing(summaries) ? " Загрузите кривую доходности ОФЗ на дату оценки (блок «Ставка дисконтирования» ниже) или введите безрисковую ставку вручную." : "";
    why = `${choice.blocked ?? "Лучший вариант не выбран"}.${rf}${missing.length ? ` Заполните в справочнике, раздел «Оценка участка»: ${missing.map((m) => `«${m}»`).join(", ")}.` : ""}`;
  }
  const failed = summaries.filter((s) => (choice?.reasons[s.variant.id] ?? []).length > 0).map((s) => ({ title: variantTitle(s.variant), text: (choice?.reasons[s.variant.id] ?? []).join("; ") }));
  const lost = losers.map((s) => ({
    title: variantTitle(s.variant),
    text: `${criterion} ${mln(metric(s))} млн руб — на ${mln((bestValue as Decimal).sub(metric(s) as Decimal))} млн руб меньше, чем у лучшего`,
  }));
  return {
    headers: summaries.map((s) => variantTitle(s.variant)),
    rows: labels.map((label, i) => ({ label, cells: facts.map((f) => f[i]?.value ?? "—") })),
    best: choice?.best ?? null,
    why,
    needsReference: !choice?.best && criterionMissing(summaries).length > 0,
    needsRiskFree: !choice?.best && riskFreeMissing(summaries),
    reasons: [...failed, ...lost],
  };
}

/** Критерий выбора лучшего утверждён в справочнике проекта (статус «утверждено»). */
export function criterionApproved(p: LandProject, versions: readonly AssumptionVersion[]): boolean {
  const version = p.assumptionsSnapshot ?? versionOf([...versions], p.assumptionsVersion);
  return version?.items.find((i) => i.param === "VAL.SELECT_CRITERION")?.status === "approved";
}

/** Итоги для карточки проекта в списке. */
export function snapshotOf(summaries: readonly VariantSummary[], choice: BestChoice | null, at: string): AnalysisSnapshot {
  const best = summaries.find((s) => s.variant.id === choice?.best) ?? null;
  const byNpv = choice?.criterion === "NPV";
  return {
    at,
    best: best?.variant.id ?? null,
    bestTitle: best ? variantTitle(best.variant) : null,
    netProfit: best?.netProfit?.toString() ?? null,
    ...(byNpv && best?.npv ? { npv: best.npv.toString() } : {}),
    variants: summaries.length,
  };
}

/** Строка карточки проекта: «Лучший вариант: Бизнес, 24 этажа · NPV акционера 1 234,5 млн руб · прибыль 2 345,6 млн руб». */
export function snapshotText(s: AnalysisSnapshot | null): string | null {
  if (!s) return null;
  if (!s.bestTitle) return `Посчитано вариантов: ${s.variants}, лучший не выбран · ${date(s.at.slice(0, 10))}`;
  const npv = s.npv ? ` · NPV акционера ${mln(new Decimal(s.npv))} млн руб` : "";
  return `Лучший вариант: ${s.bestTitle}${npv}${s.netProfit ? ` · прибыль ${mln(new Decimal(s.netProfit))} млн руб` : ""}`;
}
