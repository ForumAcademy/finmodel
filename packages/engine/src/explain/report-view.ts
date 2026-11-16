/**
 * Тексты итогового отчёта (экран «Итог»): максимальная цена участка, «что, если», график продаж, окупаемость.
 * Только форматирование итогов report.ts, без расчёта.
 */
import Decimal from "decimal.js";
import type { CashChart, LandMax, SalesChart, Sensitivity } from "../report";
import type { VariantSummary } from "../analysis";
import { monthName, num, plural } from "../lib/text";
import { periodKey } from "./periods";

const PERCENT = 100;
const MILLION = 1e6;
const MINUS = "−";

const sign = (x: number) => (x < 0 ? MINUS : x > 0 ? "+" : "");
const mln = (x: Decimal | number) => {
  const v = new Decimal(x).div(MILLION).toNumber();
  return `${v < 0 ? MINUS : ""}${num(Math.abs(v), 0)} млн руб`;
};
const pct = (x: Decimal, digits = 1) => `${num(x.abs().mul(PERCENT), digits)} %`;
const pp = (x: Decimal, digits = 1) => `${num(x.abs().mul(PERCENT), digits)} п.п.`;

export interface LandView {
  /** Максимальная цена участка или «невыгоден при любой цене». */
  value: string;
  unprofitable: boolean;
  asked: string | null;
  /** «запас 71 млн руб · 3 %» или «не хватает …»; null — цена продавца не введена. */
  reserve: string | null;
  reserveOk: boolean;
  irr: { label: string; value: string } | null;
  how: string;
}

export function landReportView(land: LandMax, rate: Decimal | null, hurdle: Decimal | null = null): LandView {
  const max = land.max_price;
  const how = `Цена участка, при которой NPV акционера равен нулю${rate ? ` при ставке дисконтирования ${pct(rate)}` : ""}: проект приносит ровно требуемую доходность. При каждой пробной цене вариант пересчитан целиком, с кредитом, процентами и налогом на прибыль.`;
  const reserve = land.reserve;
  return {
    value: land.unprofitable ? "проект невыгоден при любой цене" : max === null ? "не найдена" : mln(max),
    unprofitable: land.unprofitable,
    asked: land.asked === null ? null : mln(land.asked),
    reserve: reserve === null ? null : `${reserve.isNeg() ? "не хватает" : "запас"} ${mln(reserve.abs())}${land.reserve_share ? ` · ${pct(land.reserve_share, 0)}` : ""}`,
    reserveOk: reserve !== null && !reserve.isNeg(),
    irr: land.max_price_irr === null ? null : { label: `при целевой IRR${hurdle ? ` ${pct(hurdle, 0)}` : ""}`, value: mln(land.max_price_irr) },
    how,
  };
}

export interface SensCell {
  text: string;
  /** NPV меньше нуля — проект невыгоден. */
  neg: boolean;
  /** Расчёт без изменений. */
  base: boolean;
}

export interface SensView {
  cols: string[];
  rows: { label: string; cells: SensCell[] }[];
  priceLine: string;
  rateLine: string;
}

const stepLabel = (x: Decimal, unit: "%" | "п.п.") => (x.isZero() ? "0" : `${sign(x.toNumber())}${num(x.abs().mul(PERCENT), 1)} ${unit}`);

export function sensView(s: Sensitivity): SensView {
  const mid = s.grid[Math.floor(s.grid.length / 2)]?.[Math.floor(s.rate_steps.length / 2)] ?? null;
  const ok = mid !== null && !mid.isNeg();
  const pb = s.price_breakeven;
  const rb = s.rate_breakeven;
  const priceLine =
    pb === null
      ? ok
        ? "Проект остаётся выгодным при любом снижении цены продаж в проверке"
        : "Проект невыгоден и при росте цены продаж в проверке"
      : pb.isNeg() || pb.isZero()
        ? `Цена продаж может упасть на ${pct(pb)}, пока проект выгоден`
        : `Чтобы проект стал выгоден, цена продаж должна вырасти на ${pct(pb)}`;
  const rateLine =
    rb === null
      ? ok
        ? "Рост ключевой ставки почти не влияет на проект: он остаётся выгодным"
        : "Снижение ключевой ставки не делает проект выгодным"
      : rb.isNeg()
        ? `Чтобы проект стал выгоден, ключевая ставка должна снизиться на ${pp(rb)}`
        : `Ключевая ставка может вырасти на ${pp(rb)}, пока проект выгоден`;
  return {
    cols: s.rate_steps.map((x) => stepLabel(x, "п.п.")),
    rows: s.price_steps.map((dp, i) => ({
      label: stepLabel(dp, "%"),
      cells: s.rate_steps.map((dr, j) => {
        const v = s.grid[i]?.[j] ?? null;
        return { text: v === null ? "—" : mln(v).replace(" млн руб", ""), neg: v !== null && v.isNeg(), base: dp.isZero() && dr.isZero() };
      }),
    })),
    priceLine,
    rateLine,
  };
}

export interface SalesView {
  bars: { key: string; value: number; text: string; share: number; shareText: string }[];
  /** Наибольшая стоимость договоров за квартал, млн руб (верх шкалы). */
  max: number;
  total: string;
}

export function salesView(s: SalesChart | null): SalesView | null {
  if (!s) return null;
  const bars = s.keys.map((key, i) => {
    const v = (s.value[i] ?? 0) / MILLION;
    const share = s.soldShare[i] ?? 0;
    return { key, value: v, text: `${num(v, 0)} млн руб`, share, shareText: `${num(share * PERCENT, 0)} %` };
  });
  const total = s.value.reduce((a, b) => a + b, 0);
  return { bars, max: Math.max(0, ...bars.map((b) => b.value)), total: mln(total) };
}

export interface CashView {
  points: { date: string; value: number }[];
  min: number;
  max: number;
  peak: string | null;
  peakDate: string | null;
  payback: string | null;
  paybackMonths: string | null;
  /** Годы для подписей оси: первая дата каждого года. */
  years: { date: string; label: string }[];
}

export function cashView(c: CashChart | null): CashView | null {
  if (!c) return null;
  const points = c.dates.map((d, i) => ({ date: d, value: (c.cumulative[i] ?? 0) / MILLION }));
  const years: { date: string; label: string }[] = [];
  for (const d of c.dates) {
    const y = periodKey(d, "year");
    if (years.at(-1)?.label !== y) years.push({ date: d, label: y });
  }
  return {
    points,
    min: Math.min(0, ...points.map((p) => p.value)),
    max: Math.max(0, ...points.map((p) => p.value)),
    peak: c.peak === null ? null : mln(c.peak),
    peakDate: c.peakDate ? monthName(c.peakDate) : null,
    payback: c.payback ? monthName(c.payback) : null,
    paybackMonths: c.paybackMonths === null ? null : `${c.paybackMonths} ${plural(c.paybackMonths, ["месяц", "месяца", "месяцев"])}`,
    years,
  };
}

export interface ClarifyLine {
  label: string;
  note: string;
  /** Куда перейти: экран вариантов или справочник. */
  link: "variants" | "reference";
}

/**
 * «Уточнить перед решением»: что не учтено в расчёте варианта и какие значения взяты экспертно, а не по документу.
 * Премия за риск — ставка дисконтирования варианта минус безрисковая ставка; hurdle — целевая IRR.
 */
export function clarifyLines(s: VariantSummary, hurdle: Decimal | null): ClarifyLine[] {
  const premium = s.discountRate && s.riskFree ? s.discountRate.sub(s.riskFree.rf) : null;
  const out: ClarifyLine[] = s.notCounted.length
    ? [{ label: `Не учтено в расчёте: ${s.notCounted.length} ${plural(s.notCounted.length, ["статья", "статьи", "статей"])} затрат и продаж`, note: `Нет цены и темпа по аналогам или ставки в справочнике, прибыль и цена участка — без них: ${s.notCounted.join(", ")}`, link: "variants" }]
    : [];
  if (premium !== null) out.push({ label: `Премия за риск ${pp(premium, 1)} — Экспертное значение`, note: "От неё зависят NPV и максимальная цена участка", link: "reference" });
  if (hurdle === null) out.push({ label: "Целевая IRR акционера не задана", note: "Без неё нет цены участка при целевой доходности, а варианты не проверяются по IRR", link: "reference" });
  return out;
}

export interface Tile {
  label: string;
  value: string;
  note: string;
}

/** Плитки отчёта: прибыль, IRR, NPV, окупаемость лучшего варианта. */
export function reportTiles(s: VariantSummary, cash: CashChart | null): Tile[] {
  const c = cashView(cash);
  return [
    { label: "Чистая прибыль", value: s.netProfit ? mln(s.netProfit) : "—", note: s.netMargin ? `рентабельность продаж ${pct(s.netMargin)}` : "" },
    { label: "IRR акционера", value: s.irr ? pct(s.irr) : "—", note: s.discountRate ? `ставка дисконтирования ${pct(s.discountRate)}` : "нет ставки дисконтирования" },
    { label: "NPV акционера", value: s.npv ? mln(s.npv) : "—", note: s.npv ? (s.npv.isNeg() ? "проект не окупает требуемую доходность" : "на дату оценки") : "нужна ставка дисконтирования" },
    { label: "Окупаемость", value: c?.paybackMonths ?? "не окупается в расчёте", note: c?.payback ? `${c.payback}, после пика вложений ${c.peak ?? ""}` : "" },
  ];
}
