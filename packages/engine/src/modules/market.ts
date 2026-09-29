/**
 * MARKET — рынок по ручной таблице аналогов (data/formulas.yaml, модуль MARKET): цена продукта по классам, темп
 * проекта и ёмкость локации. С подключением ЕИСЖС таблицу заменит выборка сделок (модуль BENCH).
 */
import Decimal from "decimal.js";
import type { FormulaContext } from "../context";
import { CalcError } from "../context";
import { median } from "../lib/stats";

const ZERO = new Decimal(0);

/** Строка MARKET.ANALOGS (столбцы — parameters.yaml). */
export interface AnalogRow {
  name: string;
  product: string;
  housing_class: string;
  distance_km?: number | null;
  stage?: string | null;
  price?: number | null;
  pace?: number | null;
  sold_share?: number | null;
  url?: string | null;
  date?: string | null;
}

/** Ключ группы аналогов: продукт и класс. */
export const marketKey = (product: string, housingClass: string): string => `${product}|${housingClass}`;

/** Цена группы по аналогам: средняя с весом по темпу, диапазон и число аналогов. */
export interface MarketPrice {
  price: Decimal;
  min: Decimal;
  max: Decimal;
  n: number;
}

/** Строки с ценой и темпом по группам «продукт | класс». */
function groups(ctx: FormulaContext): Map<string, { price: Decimal; pace: Decimal }[]> {
  const rows = ctx.param<AnalogRow[]>("MARKET.ANALOGS") ?? [];
  if (!Array.isArray(rows)) throw new CalcError("Аналоги: нужен список строк", "MARKET.ANALOGS");
  const out = new Map<string, { price: Decimal; pace: Decimal }[]>();
  for (const r of rows) {
    if (typeof r.price !== "number" || typeof r.pace !== "number" || r.pace < 0) continue;
    const k = marketKey(r.product, r.housing_class);
    const list = out.get(k) ?? [];
    list.push({ price: new Decimal(r.price), pace: new Decimal(r.pace) });
    out.set(k, list);
  }
  return out;
}

export function F_MARKET_PRICE(ctx: FormulaContext): Record<string, MarketPrice | null> {
  const min = ctx.requireNum("BENCH.MARKET_MIN_COMPS").toNumber();
  const out: Record<string, MarketPrice | null> = {};
  for (const [k, list] of groups(ctx)) {
    const pace = list.reduce((s, x) => s.add(x.pace), ZERO);
    if (list.length < min || pace.isZero()) {
      out[k] = null;
      continue;
    }
    const prices = list.map((x) => x.price);
    out[k] = {
      price: list.reduce((s, x) => s.add(x.price.mul(x.pace)), ZERO).div(pace),
      min: Decimal.min(...prices),
      max: Decimal.max(...prices),
      n: list.length,
    };
  }
  return out;
}

export function F_MARKET_PACE(ctx: FormulaContext): Record<string, Decimal | null> {
  const min = ctx.requireNum("BENCH.MARKET_MIN_COMPS").toNumber();
  const out: Record<string, Decimal | null> = {};
  for (const [k, list] of groups(ctx)) out[k] = list.length < min ? null : median(list.map((x) => x.pace));
  return out;
}

export function F_MARKET_CAPACITY(ctx: FormulaContext): Record<string, Decimal> {
  const out: Record<string, Decimal> = {};
  for (const [k, list] of groups(ctx)) out[k] = list.reduce((s, x) => s.add(x.pace), ZERO);
  return out;
}

export const MARKET_FORMULAS = {
  "F.MARKET.PRICE": F_MARKET_PRICE,
  "F.MARKET.PACE": F_MARKET_PACE,
  "F.MARKET.CAPACITY": F_MARKET_CAPACITY,
} as const;
