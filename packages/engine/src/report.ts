/**
 * Итоговый отчёт по варианту (экран «Итог»): максимальная цена участка, «что, если цена продаж или ставка изменится»,
 * график продаж и окупаемость. Пробные расчёты — полный расчёт варианта (computeProject) с изменённым вводным; их
 * итоги передаются в формулы F.VAR.LAND_MAX и F.VAR.SENSITIVITY. Каждый пробный расчёт — шаг генератора, чтобы
 * экран не замирал (ядро чистое: как часто делать шаги, решает интерфейс).
 */
import Decimal from "decimal.js";
import type { FormulaId, ParameterId, SpecAssumptionVersion as AssumptionVersion } from "@fm/spec";
import { Engine } from "./context";
import { computeProject, projectInput, projectValue, SPEC_ASSUMPTIONS, type CalcProject, type ProjectModel } from "./project";
import { ANALYSIS_FORMULAS } from "./registry";
import { variantProject, type VariantSummary } from "./analysis";
import { signChange, type Probe } from "./lib/solve";
import { monthDiff, type IsoDate } from "./lib/dates";
import { aggregate } from "./explain/periods";
import type { LandMax, LandTrial, Sensitivity, SensTrial } from "./modules/variant";
import type { RowSeries } from "./modules/sales";
import type { CalcMessage } from "./types";

export type { LandMax, Sensitivity } from "./modules/variant";

const ZERO = new Decimal(0);

/** График продаж по кварталам: стоимость заключённых договоров и накопленная доля проданной площади. */
export interface SalesChart {
  keys: string[];
  /** Стоимость договоров за квартал, руб (F.SALES.CONTRACT_VALUE). */
  value: number[];
  /** Доля проданной площади на конец квартала (F.SALES.SOLD_AREA к запасу площади плана продаж). */
  soldShare: number[];
}

/** Окупаемость: накопленный поток акционера по месяцам и его точки (F.CF.FCFE, F.KPI.PEAK_EQUITY). */
export interface CashChart {
  dates: IsoDate[];
  cumulative: number[];
  peak: number | null;
  peakDate: IsoDate | null;
  payback: IsoDate | null;
  /** Месяцев от даты начала модели до окупаемости. */
  paybackMonths: number | null;
}

export interface VariantReport {
  variant: string;
  sales: SalesChart | null;
  cash: CashChart | null;
  land: LandMax | null;
  sens: Sensitivity | null;
  /** Почему не посчитаны максимальная цена участка и «что, если» (нет NPV или ошибка расчёта). */
  blocked: string | null;
  messages: CalcMessage[];
}

/** Ход расчёта отчёта: сколько пробных расчётов сделано и сколько примерно всего. */
export interface ReportProgress {
  done: number;
  total: number;
}

const val = <T>(m: ProjectModel, id: FormulaId): T | null => (m.result.formulas[id]?.value as T | undefined) ?? null;

const sumRows = (rows: RowSeries | null, keep: (name: string) => boolean = () => true): Decimal[] => {
  const out: Decimal[] = [];
  for (const [name, xs] of Object.entries(rows ?? {})) {
    if (!keep(name)) continue;
    xs.forEach((x, t) => (out[t] = (out[t] ?? ZERO).add(x)));
  }
  return out;
};

/** График продаж по кварталам из расчёта варианта. */
export function salesChart(m: ProjectModel): SalesChart | null {
  const dates = val<IsoDate[]>(m, "F.TIME.DATE");
  const value = val<RowSeries>(m, "F.SALES.CONTRACT_VALUE");
  const sold = val<RowSeries>(m, "F.SALES.SOLD_AREA");
  if (!dates || !value || !sold) return null;
  // Доля проданного — по площади: машино-места и кладовые продаются штуками и в долю не входят
  const products = (m.input.values["SALES.PRODUCTS"] as { name: string; stock_area?: number | null }[] | undefined) ?? [];
  const byArea = new Set(products.filter((p) => typeof p.stock_area === "number").map((p) => p.name));
  const stock = products.reduce((s, p) => (typeof p.stock_area === "number" ? s.add(p.stock_area) : s), ZERO);
  const monthly = sumRows(value).map((x) => x.toNumber());
  let acc = ZERO;
  const cum = sumRows(sold, (n) => byArea.has(n)).map((x) => {
    acc = acc.add(x);
    return stock.isZero() ? 0 : acc.div(stock).toNumber();
  });
  const q = aggregate(monthly, dates, "quarter");
  const share = aggregate(cum, dates, "quarter", "last");
  // Без кварталов до первой и после последней продажи
  const first = q.sums.findIndex((x) => x !== 0);
  if (first < 0) return null;
  const last = q.sums.length - [...q.sums].reverse().findIndex((x) => x !== 0);
  return { keys: q.keys.slice(first, last), value: q.sums.slice(first, last), soldShare: share.sums.slice(first, last) };
}

/** Окупаемость: накопленный поток акционера из расчёта варианта. */
export function cashChart(m: ProjectModel): CashChart | null {
  const dates = val<IsoDate[]>(m, "F.TIME.DATE");
  const fcfe = val<Decimal[]>(m, "F.CF.FCFE");
  const pe = val<{ peak_equity: Decimal; peak_date: IsoDate | null; payback_date: IsoDate | null }>(m, "F.KPI.PEAK_EQUITY");
  if (!dates || !fcfe || !pe) return null;
  let acc = ZERO;
  const cumulative = fcfe.map((x) => {
    acc = acc.add(x);
    return acc.toNumber();
  });
  const start = m.input.values["GEN.MODEL_START_DATE"];
  const from = typeof start === "string" ? start : (dates[0] as IsoDate);
  return {
    dates,
    cumulative,
    peak: pe.peak_date ? pe.peak_equity.toNumber() : null,
    peakDate: pe.peak_date,
    payback: pe.payback_date,
    paybackMonths: pe.payback_date ? monthDiff(from, pe.payback_date) : null,
  };
}

// ---------- пробные расчёты ----------

type Values = Partial<Record<ParameterId, unknown>>;

/** Ключевая ставка на весь срок, сдвинутая на dr (текущая и по годам). */
export function shiftKeyRate(path: unknown, dr: number): unknown {
  if (dr === 0) return path;
  const add = (v: number) => new Decimal(v).add(dr).toNumber();
  if (typeof path === "number") return add(path);
  if (path && typeof path === "object") {
    const p = path as { current?: number; by_year?: Record<string, number> };
    return {
      ...p,
      ...(typeof p.current === "number" ? { current: add(p.current) } : {}),
      ...(p.by_year ? { by_year: Object.fromEntries(Object.entries(p.by_year).map(([y, v]) => [y, add(v)])) } : {}),
    };
  }
  return path;
}

/** Цены плана продаж × (1 + dp). */
export function shiftPrices(products: unknown, dp: number): unknown {
  if (dp === 0 || !Array.isArray(products)) return products;
  return products.map((r: Record<string, unknown>) => (typeof r.start_price === "number" ? { ...r, start_price: new Decimal(r.start_price).mul(1 + dp).toNumber() } : r));
}

function trialOf(project: CalcProject, values: Values, versions: AssumptionVersion[]): { npv: number | null; irr: number | null } {
  const m = computeProject({ ...project, input: { ...project.input, values: { ...project.input.values, ...values } } }, versions);
  const npv = val<{ npv_equity: Decimal | null }>(m, "F.KPI.NPV")?.npv_equity ?? null;
  const irr = val<{ irr_equity: Decimal | null }>(m, "F.KPI.IRR")?.irr_equity ?? null;
  return { npv: npv === null ? null : npv.toNumber(), irr: irr === null ? null : irr.toNumber() };
}

function runFormula<T>(project: CalcProject, versions: AssumptionVersion[], values: Values, id: FormulaId): { value: T | null; messages: CalcMessage[] } {
  const base = projectInput(project, versions);
  const r = new Engine({ ...base, values: { ...base.values, ...values } }, ANALYSIS_FORMULAS).run([id]);
  return { value: (r.formulas[id]?.value as T | undefined) ?? null, messages: r.messages };
}

/** Шаги проверки «что, если» из справочника проекта. */
function sensSteps(project: CalcProject, versions: AssumptionVersion[]): { price: number; rate: number; n: number } {
  const num = (id: ParameterId) => Number(projectValue(project, id, versions));
  return { price: num("VAL.SENS_PRICE_STEP"), rate: num("VAL.SENS_RATE_STEP"), n: num("VAL.SENS_STEPS") };
}

/** Сколько примерно пробных расчётов займёт отчёт: таблица и по два поиска на цену участка и на «что, если». */
export function reportTotal(project: CalcProject, versions: AssumptionVersion[] = SPEC_ASSUMPTIONS): number {
  const { n } = sensSteps(project, versions);
  const side = n + n + 1;
  return side * side + side + side;
}

/**
 * Итоговый отчёт по варианту. Генератор: после каждого пробного расчёта отдаёт ход расчёта, в конце — отчёт.
 * s — итоги варианта (computeVariant), project — проект участка, на котором посчитан вариант.
 */
export function* variantReport(project: CalcProject, s: VariantSummary, versions: AssumptionVersion[] = SPEC_ASSUMPTIONS): Generator<ReportProgress, VariantReport> {
  const report: VariantReport = { variant: s.variant.id, sales: null, cash: null, land: null, sens: null, blocked: null, messages: [] };
  if (!s.model) return { ...report, blocked: "Вариант не посчитан полностью" };
  report.sales = salesChart(s.model);
  report.cash = cashChart(s.model);
  if (s.npv === null) return { ...report, blocked: "Максимальная цена участка и проверка «что, если» считаются по NPV акционера, а он не посчитан: нужна ставка дисконтирования" };
  const vp = variantProject(project, s.variant, versions).project;
  if (!vp) return { ...report, blocked: "Вариант не посчитан полностью" };

  const total = reportTotal(project, versions);
  let done = 0;
  const tick = (): ReportProgress => ({ done: ++done, total: Math.max(total, done) });

  // ----- «что, если»: таблица и точки, где NPV становится нулём -----
  const steps = sensSteps(project, versions);
  const keyRate = projectValue(vp, "FIN.KEY_RATE_PATH", versions);
  const products = vp.input.values["SALES.PRODUCTS"];
  const sens = new Map<string, SensTrial>();
  const sensAt = (dp: number, dr: number): number | null => {
    const k = `${dp}|${dr}`;
    let t = sens.get(k);
    if (!t) {
      const r = trialOf(vp, { "SALES.PRODUCTS": shiftPrices(products, dp), "FIN.KEY_RATE_PATH": shiftKeyRate(keyRate, dr) }, versions);
      t = { price_shift: dp, rate_shift: dr, npv: r.npv };
      sens.set(k, t);
    }
    return t.npv;
  };
  const idx = Array.from({ length: steps.n + steps.n + 1 }, (_, i) => i - steps.n);
  // Шаги как в формуле: i × шаг в десятичной арифметике, чтобы совпадали ключи проб
  const stepOf = (i: number, step: number) => new Decimal(step).mul(i).toNumber();
  for (const i of idx) {
    for (const j of idx) {
      sensAt(stepOf(i, steps.price), stepOf(j, steps.rate));
      yield tick();
    }
  }
  const base = sensAt(0, 0);
  if (base !== null) {
    const up = base >= 0 ? -1 : 1;
    // Цена продаж: от −100 % (выручки нет) до +100 %; ставка — до ±100 п.п.
    const byPrice: Probe = (dp) => sensAt(dp, 0);
    const byRate: Probe = (dr) => sensAt(0, dr);
    const g1 = signChange(byPrice, 0, base, stepOf(up, steps.price), up);
    for (let r = g1.next(); !r.done; r = g1.next()) yield tick();
    const g2 = signChange(byRate, 0, base, stepOf(-up, steps.rate), -up);
    for (let r = g2.next(); !r.done; r = g2.next()) yield tick();
  }
  const sensRun = runFormula<Sensitivity>(vp, versions, { "VAR.SENS_RESULTS": [...sens.values()] }, "F.VAR.SENSITIVITY");
  report.sens = sensRun.value;

  // ----- максимальная цена участка -----
  const land = new Map<number, LandTrial>();
  const landAt = (price: number): LandTrial => {
    let t = land.get(price);
    if (!t) {
      t = { price, ...trialOf(vp, { "LAND.PURCHASE_PRICE": price }, versions) };
      land.set(price, t);
    }
    return t;
  };
  const asked = projectValue(vp, "LAND.PURCHASE_PRICE", versions);
  const zero = landAt(0);
  yield tick();
  if (zero.npv !== null && zero.npv >= 0) {
    const first = typeof asked === "number" && asked > 0 ? asked : zero.npv;
    const g = signChange((p) => landAt(p).npv, 0, zero.npv, first);
    for (let r = g.next(); !r.done; r = g.next()) yield tick();
  }
  const hurdle = projectValue(vp, "VAL.HURDLE_IRR", versions);
  if (typeof hurdle === "number" && zero.irr !== null && zero.irr >= hurdle) {
    const h = hurdle;
    const g = signChange((p) => {
      const irr = landAt(p).irr;
      return irr === null ? null : irr - h;
    }, 0, zero.irr - h, typeof asked === "number" && asked > 0 ? asked : Math.max(zero.npv ?? 0, 1));
    for (let r = g.next(); !r.done; r = g.next()) yield tick();
  }
  const landRun = runFormula<LandMax>(vp, versions, { "VAR.LAND_TRIALS": [...land.values()] }, "F.VAR.LAND_MAX");
  report.land = landRun.value;
  report.messages = [...sensRun.messages, ...landRun.messages];
  return report;
}

/** Отчёт целиком, без шагов (тесты, выгрузка). */
export function variantReportSync(project: CalcProject, s: VariantSummary, versions: AssumptionVersion[] = SPEC_ASSUMPTIONS): VariantReport {
  const g = variantReport(project, s, versions);
  for (;;) {
    const r = g.next();
    if (r.done) return r.value;
  }
}
