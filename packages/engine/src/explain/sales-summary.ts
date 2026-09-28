/**
 * Сводка продаж по продуктам («Продано в месяце»): построено, продано, остаток, срок и темп, выручка и средняя цена,
 * доля, проданная к вводу очереди, и предупреждения с суммой в рублях. Раньше считалось в панели интерфейса
 * старого сервиса (lib/sales-panel.ts); перенесено в ядро.
 *
 * Отличие от старой панели: выручка и цена берутся только из расчёта, для которого строится сводка. Если в расчёте
 * сервиса цена не посчитана, выручки в сводке нет (раньше подставлялась цена исходного Excel).
 */
import Decimal from "decimal.js";
import { fmtRub } from "../lib/format";
import { monthName, num, date as fmtDate } from "../lib/text";
import type { CalcProject, ProjectModel } from "../project";

type Series = Record<string, Decimal[]>;
type Row = Record<string, unknown>;

const ZERO = new Decimal(0);
/** Остаток меньше целого м² (шт) — округление ручного плана: площадь продана вся. */
const WHOLE = 1;
const QTY_DIGITS = 3;

export interface SalesRow {
  key: string;
  unit: "м²" | "шт";
  built: Decimal | null;
  sold: Decimal;
  unsold: Decimal | null;
  /** Месяц, к которому продана вся площадь (остаток меньше целого м² или штуки). */
  soldOut: string | null;
  /** Доля построенного, проданная к вводу своей очереди. */
  byRnvShare: Decimal | null;
  firstMonth: string | null;
  months: number;
  avgPerMonth: Decimal | null;
  /** Очередь продукта и её дата ввода. */
  phase: unknown;
  rnvDate: string | null;
  /** Выручка = продано × цена месяца; null — цена в расчёте не посчитана. */
  revenue: Decimal | null;
  /** Договоры до ввода своей очереди, руб: по ДДУ эти деньги лежат на эскроу до раскрытия. */
  revenueByRnv: Decimal | null;
  avgPrice: Decimal | null;
}

export interface SalesTotal {
  built: Decimal;
  sold: Decimal;
  unsold: Decimal;
  byRnvShare: Decimal | null;
  areaRevenue: Decimal | null;
  areaRevenueByRnv: Decimal | null;
  revenue: Decimal | null;
  revenueByRnv: Decimal | null;
  avgPrice: Decimal | null;
}

export interface SalesWarning {
  key: string;
  text: string;
  /** Сколько выручки не попало в расчёт, руб (0 — выручка не потеряна или цена не посчитана). */
  money: Decimal;
}

const sum = (xs: Decimal[] | undefined) => (xs ?? []).reduce((s, x) => s.add(x), ZERO);
const qty = (d: Decimal) => num(d.toDecimalPlaces(QTY_DIGITS).trunc(), 0);
export const cellQty = (d: Decimal | null, unit?: string) => (d === null ? "—" : unit ? `${qty(d)} ${unit}` : qty(d));

function productRows(project: CalcProject): Row[] {
  const v = project.input.values["SALES.PRODUCTS"];
  return Array.isArray(v) ? (v as Row[]) : [];
}

function milestoneOf(project: CalcProject, phase: unknown): Row | undefined {
  const v = project.input.values["TIME.MILESTONES"];
  return Array.isArray(v) ? (v as Row[]).find((r) => r.phase === phase) : undefined;
}

/** Строки сводки по продуктам; null — продажи в расчёте не посчитаны. */
export function salesRows(project: CalcProject, m: ProjectModel): SalesRow[] | null {
  const sold = m.result.formulas["F.SALES.SOLD_AREA"]?.value as Series | undefined;
  const price = m.result.formulas["F.SALES.PRICE"]?.value as Series | undefined;
  const dates = (m.result.formulas["F.TIME.DATE"]?.value as string[] | undefined) ?? [];
  if (!sold) return null;
  return productRows(project).map((row) => {
    const key = String(row.name ?? row.product);
    const unit = row.product === "машино-места" || row.product === "кладовые" ? "шт" : "м²";
    const s = sold[key] ?? [];
    const total = sum(s);
    const stock = unit === "шт" ? row.stock_units : row.stock_area;
    const built = typeof stock === "number" ? new Decimal(stock) : null;
    const on = s.map((x, t) => (x.isZero() ? -1 : t)).filter((t) => t >= 0);
    const first = on[0];
    const last = on[on.length - 1];
    const unsold = built ? Decimal.max(built.sub(total), ZERO) : null;
    const rnv = milestoneOf(project, row.phase)?.rnv_date;
    const byRnv = (t: number) => typeof rnv === "string" && (dates[t] ?? "") <= rnv;
    const beforeRnv = typeof rnv === "string" ? sum(s.filter((_, t) => byRnv(t))) : null;
    const months = first !== undefined && last !== undefined ? last - first + 1 : 0;
    const p = price?.[key];
    const revenue = p ? s.reduce((a, x, t) => a.add(x.mul(p[t] ?? ZERO)), ZERO) : null;
    const revenueByRnv = p && typeof rnv === "string" ? s.reduce((a, x, t) => (byRnv(t) ? a.add(x.mul(p[t] ?? ZERO)) : a), ZERO) : null;
    return {
      key,
      unit,
      built,
      sold: total,
      unsold,
      soldOut: unsold && unsold.lt(WHOLE) && last !== undefined ? (dates[last] ?? null) : null,
      byRnvShare: built && beforeRnv && !built.isZero() ? beforeRnv.div(built) : null,
      firstMonth: first !== undefined ? (dates[first] ?? null) : null,
      months,
      avgPerMonth: months ? total.div(months) : null,
      phase: row.phase,
      rnvDate: typeof rnv === "string" ? rnv : null,
      revenue,
      revenueByRnv,
      avgPrice: revenue && !total.isZero() ? revenue.div(total) : null,
    };
  });
}

/**
 * Итого: площади и доля к вводу — по м² (машино-места и кладовые в штуках не входят; доля — средневзвешенно
 * по площади), выручка — по всем продуктам.
 */
export function salesTotal(rows: SalesRow[]): SalesTotal {
  const area = rows.filter((r) => r.unit === "м²");
  const built = area.reduce((s, r) => s.add(r.built ?? ZERO), ZERO);
  const sold = area.reduce((s, r) => s.add(r.sold), ZERO);
  const weighted = area.filter((r) => r.byRnvShare && r.built);
  const areaRevenue = area.reduce((s, r) => s.add(r.revenue ?? ZERO), ZERO);
  return {
    built,
    sold,
    unsold: area.reduce((s, r) => s.add(r.unsold ?? ZERO), ZERO),
    byRnvShare: weighted.length ? weighted.reduce((s, r) => s.add(r.byRnvShare!.mul(r.built!)), ZERO).div(weighted.reduce((s, r) => s.add(r.built!), ZERO)) : null,
    areaRevenue: area.some((r) => r.revenue) ? areaRevenue : null,
    areaRevenueByRnv: area.some((r) => r.revenueByRnv) ? area.reduce((s, r) => s.add(r.revenueByRnv ?? ZERO), ZERO) : null,
    revenue: rows.some((r) => r.revenue) ? rows.reduce((s, r) => s.add(r.revenue ?? ZERO), ZERO) : null,
    revenueByRnv: rows.some((r) => r.revenueByRnv) ? rows.reduce((s, r) => s.add(r.revenueByRnv ?? ZERO), ZERO) : null,
    avgPrice: sold.isZero() || areaRevenue.isZero() ? null : areaRevenue.div(sold),
  };
}

/** Есть непроданный остаток (целый м² или штука и больше). */
export const hasUnsold = (rows: SalesRow[]) => rows.some((r) => r.unsold && r.unsold.gte(WHOLE));

/** Строка темпа: «ПСН: в среднем 215 м² в месяц, срок продаж 48 мес.» */
export function paceLine(r: SalesRow): string {
  if (!r.avgPerMonth) return `${r.key}: продаж нет.`;
  return `${r.key}: в среднем ${qty(r.avgPerMonth)} ${r.unit} в месяц, срок продаж ${r.months} мес.`;
}

/**
 * Предупреждения по продажам с суммой в рублях, по убыванию влияния на выручку.
 * plan — расчёт «как в исходном Excel»: его ряд продаж — план продаж как есть (только у проектов из Excel).
 */
export function salesWarnings(project: CalcProject, m: ProjectModel, plan: ProjectModel | null = null): SalesWarning[] {
  const rows = salesRows(project, m);
  const sold = m.result.formulas["F.SALES.SOLD_AREA"]?.value as Series | undefined;
  const planSold = plan?.result.formulas["F.SALES.SOLD_AREA"]?.value as Series | undefined;
  const dates = (m.result.formulas["F.TIME.DATE"]?.value as string[] | undefined) ?? [];
  const wavg = (m.result.formulas["F.SALES.WAVG_PRICE"]?.value ?? {}) as Record<string, Decimal | null>;
  if (!rows || !sold) return [];
  const out: SalesWarning[] = [];
  for (const r of rows) {
    const s = sold[r.key] ?? [];
    const p = planSold?.[r.key];
    const planTotal = p ? sum(p) : null;
    if (r.unsold && r.unsold.gte(WHOLE)) {
      const price = wavg[r.key] ?? null;
      const money = price ? r.unsold.mul(price) : ZERO;
      // план до первого месяца, когда продажи разрешены: продавать ещё нельзя
      const first = s.findIndex((x) => !x.isZero());
      const early = p && first > 0 ? p.slice(0, first).map((x, t) => (x.isZero() ? -1 : t)).filter((t) => t >= 0) : [];
      const start = milestoneOf(project, productRows(project).find((x) => String(x.name ?? x.product) === r.key)?.phase)?.sales_start;
      const firstEarly = early[0];
      const lastEarly = early[early.length - 1];
      const period = firstEarly === undefined ? "" : firstEarly === lastEarly ? monthName(dates[firstEarly]) : `${monthName(dates[firstEarly])} — ${monthName(dates[lastEarly as number])}`;
      const why = early.length
        ? `План продаж на ${period} приходится на месяцы, когда продавать ещё нельзя${typeof start === "string" ? `: старт продаж ${fmtDate(start)}` : ""}.`
        : "По плану продаж продаётся меньше, чем построено.";
      out.push({ key: r.key, money, text: `${r.key}: ${cellQty(r.unsold, r.unit)} не продано к концу расчёта${price ? ` — ≈ ${fmtRub(money)} не попало в выручку` : ""}. ${why}` });
    }
    if (planTotal && r.built && planTotal.trunc().gt(r.built)) {
      out.push({
        key: r.key,
        money: ZERO,
        text: `${r.key}: по плану продаж ${cellQty(planTotal, r.unit)}, построено ${cellQty(r.built, r.unit)}. В расчёт вошло ${cellQty(r.sold, r.unit)}, выручка не потеряна, но темп завышен на ${cellQty(planTotal.trunc().sub(r.built), r.unit)}.`,
      });
    }
  }
  return out.sort((a, b) => b.money.cmp(a.money));
}

/** Машино-мест меньше норматива: от количества зависят затраты на паркинг и выручка. null — не меньше или не посчитано. */
export function parkingWarning(m: ProjectModel): string | null {
  const count = m.result.formulas["F.TEP.PARKING_COUNT"]?.value as Decimal | number | undefined;
  const required = m.result.formulas["F.TEP.PARKING_REQUIRED"]?.value as Decimal | number | undefined;
  if (count === undefined || required === undefined || !new Decimal(count).lt(required)) return null;
  return `Машино-мест ${num(new Decimal(count), 0)}, а по нормативу нужно ${num(new Decimal(required), 0)}. Проверьте количество в ТЭПах — от него зависят затраты на паркинг и выручка.`;
}

/** Подпись продукта: если продукты проекта в разных очередях — с номером очереди. */
export function rowName(r: SalesRow, rows: SalesRow[]): string {
  return new Set(rows.map((x) => x.phase)).size > 1 ? `${r.key}, очередь ${String(r.phase)}` : r.key;
}
