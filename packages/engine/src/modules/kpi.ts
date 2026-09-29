/**
 * KPI — показатели (data/formulas.yaml, модуль KPI): ставка дисконтирования, NPV, IRR, прибыль и рентабельность,
 * себестоимость 1 м², пиковые вложения и окупаемость, LTC/LTV, LLCR, выручка после РНВ.
 */
import Decimal from "decimal.js";
import type { FormulaContext } from "../context";
import { CalcError } from "../context";
import { daysBetween, isIsoDate, type IsoDate } from "../lib/dates";
import { xirr } from "../lib/irr";
import type { Debt } from "./fin";
import { products, type Revenue, type RowSeries } from "./sales";
import type { VatPayable } from "./tax";

const ZERO = new Decimal(0);
const ONE = new Decimal(1);
const DAYS_IN_YEAR = 365;

type Series = Partial<Record<string, Decimal[]>>;

const at = (xs: readonly (Decimal | null | undefined)[] | null | undefined, t: number): Decimal => (t >= 0 ? (xs?.[t] ?? ZERO) : ZERO);
const sum = (xs: readonly (Decimal | null | undefined)[] | null | undefined): Decimal => (xs ?? []).reduce((s: Decimal, x) => s.add(x ?? ZERO), ZERO);
const div = (a: Decimal, b: Decimal): Decimal | null => (b.isZero() ? null : a.div(b));

/** Бюджет без возмещаемого НДС: невозмещаемый входящий НДС остаётся в затратах. */
function capexNet(ctx: FormulaContext): Decimal {
  const total = ctx.formula<Decimal>("F.CAPEX.TOTAL");
  const vat = ctx.formula<VatPayable>("F.TAX.VAT_PAYABLE");
  return total.sub(sum(vat.recoverable));
}

function revenueNet(ctx: FormulaContext): Decimal {
  const r = ctx.formula<Revenue>("F.SALES.REVENUE_TOTAL");
  if (r.net === null) throw new CalcError("Выручка без НДС не посчитана: не посчитан НДС с продаж", "TAX.VAT_REGIME");
  return r.net;
}

/** Точка кривой бескупонной доходности: срок, лет, и доходность, доля годовых. */
export interface CurvePoint {
  term: Decimal;
  yield: Decimal;
}

/** Доходность кривой в точке term: по прямой между соседними сроками, за краями — доходность крайнего срока. */
export function curveAt(curve: readonly CurvePoint[], term: Decimal): Decimal | null {
  const pts = [...curve].sort((a, b) => a.term.cmp(b.term));
  const first = pts[0];
  const last = pts[pts.length - 1];
  if (!first || !last) return null;
  if (term.lte(first.term)) return first.yield;
  if (term.gte(last.term)) return last.yield;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1] as CurvePoint;
    const b = pts[i] as CurvePoint;
    if (term.lte(b.term)) return a.yield.add(b.yield.sub(a.yield).mul(term.sub(a.term)).div(b.term.sub(a.term)));
  }
  return last.yield;
}

export interface RiskFree {
  rf: Decimal;
  /** Срок проекта, лет: от даты оценки до последнего потока акционера. */
  term: Decimal;
  /** Дата кривой; null — ставка введена вручную. */
  curve_date: IsoDate | null;
  from_curve: boolean;
}

export function F_KPI_RISK_FREE(ctx: FormulaContext): RiskFree {
  const rows = ctx.param<{ term: number | null; yield: number | null }[]>("VAL.ZCYC") ?? [];
  const curve: CurvePoint[] = rows.flatMap((r) => (r.term === null || r.yield === null ? [] : [{ term: new Decimal(r.term), yield: new Decimal(r.yield) }]));
  // Без кривой нужна ручная ставка: её нехватка — главное, что сообщить
  const manual = curve.length ? null : ctx.requireNum("VAL.RISK_FREE");
  const fcfe = ctx.formula<Decimal[]>("F.CF.FCFE");
  const date = ctx.formula<IsoDate[]>("F.TIME.DATE");
  const v0 = ctx.require<IsoDate>("GEN.VALUATION_DATE");
  if (!isIsoDate(v0)) throw new CalcError("Дата оценки должна быть датой, например 30.09.2026", "GEN.VALUATION_DATE");
  const tLast = fcfe.reduce((last, x, t) => (x.isZero() ? last : t), fcfe.length);
  if (tLast === fcfe.length) throw new CalcError("Срок проекта для безрисковой ставки не определён: в потоке акционера нет денег");
  const term = new Decimal(daysBetween(v0, date[tLast] as IsoDate)).div(DAYS_IN_YEAR);
  const fromCurve = curveAt(curve, term);
  if (fromCurve !== null) return { rf: fromCurve, term, curve_date: ctx.param<IsoDate>("VAL.ZCYC_DATE"), from_curve: true };
  return { rf: manual ?? ctx.requireNum("VAL.RISK_FREE"), term, curve_date: null, from_curve: false };
}

export function F_KPI_DISCOUNT_RATE(ctx: FormulaContext): Decimal {
  return ctx.formula<RiskFree>("F.KPI.RISK_FREE").rf.add(ctx.requireNum("VAL.EQUITY_PREMIUM"));
}

export function F_KPI_NPV(ctx: FormulaContext): { npv_project: Decimal; npv_equity: Decimal } {
  const cfads = ctx.formula<Decimal[]>("F.CF.CFADS");
  const fcfe = ctx.formula<Decimal[]>("F.CF.FCFE");
  const r = ctx.formula<Decimal>("F.KPI.DISCOUNT_RATE");
  const date = ctx.formula<IsoDate[]>("F.TIME.DATE");
  const v0 = ctx.require<IsoDate>("GEN.VALUATION_DATE");
  if (!isIsoDate(v0)) throw new CalcError("Дата оценки должна быть датой, например 30.09.2026", "GEN.VALUATION_DATE");
  const k = ONE.add(r);
  const pv = (xs: Decimal[]) => xs.reduce((s, x, t) => s.add(x.div(k.pow(new Decimal(daysBetween(v0, date[t] as IsoDate)).div(DAYS_IN_YEAR)))), ZERO);
  return { npv_project: pv(cfads), npv_equity: pv(fcfe) };
}

export function F_KPI_IRR(ctx: FormulaContext): { irr_project: Decimal | null; irr_equity: Decimal | null } {
  const cfads = ctx.formula<Decimal[]>("F.CF.CFADS");
  const fcfe = ctx.formula<Decimal[]>("F.CF.FCFE");
  const date = ctx.formula<IsoDate[]>("F.TIME.DATE");
  const irr = (xs: Decimal[]) => {
    const r = xirr(
      xs.map((x) => x.toNumber()),
      date,
    );
    return r === null ? null : new Decimal(r);
  };
  const out = { irr_project: irr(cfads), irr_equity: irr(fcfe) };
  if (out.irr_equity === null) ctx.message("warning", "IRR акционера не считается: в потоке акционера нет вложений и возврата денег одновременно");
  return out;
}

export interface Margin {
  revenue_net: Decimal;
  capex_net: Decimal;
  gross_profit: Decimal;
  net_profit: Decimal;
  gross_margin: Decimal | null;
  net_margin: Decimal | null;
  roi: Decimal | null;
}

export function F_KPI_MARGIN(ctx: FormulaContext): Margin {
  const revenue = revenueNet(ctx);
  const capex = capexNet(ctx);
  const interest = sum(ctx.formula<Decimal[]>("F.FIN.INTEREST"));
  const fees = sum(ctx.formula<Decimal[]>("F.FIN.FEES"));
  const tax = sum(ctx.formula<{ tax: Decimal[] }>("F.TAX.PROFIT_TAX").tax);
  const gross = revenue.sub(capex);
  const net = gross.sub(interest).sub(fees).sub(tax);
  return { revenue_net: revenue, capex_net: capex, gross_profit: gross, net_profit: net, gross_margin: div(gross, revenue), net_margin: div(net, revenue), roi: div(net, capex.add(interest)) };
}

export function F_KPI_COST_PER_M2(ctx: FormulaContext): { cost_m2: Decimal | null; markup: Decimal | null } {
  const capex = capexNet(ctx);
  const interest = sum(ctx.formula<Decimal[]>("F.FIN.INTEREST"));
  const area = ctx.formula<Decimal>("F.TEP.SALEABLE_AREA");
  ctx.formula<Record<string, Decimal | null>>("F.SALES.WAVG_PRICE");
  const value = ctx.formula<RowSeries>("F.SALES.CONTRACT_VALUE");
  const sold = ctx.formula<RowSeries>("F.SALES.SOLD_AREA");
  // Средняя цена по продуктам в м²: машино-места и кладовые продаются штуками и в м² не складываются
  let v = ZERO;
  let q = ZERO;
  for (const p of products(ctx)) {
    if (p.pieces) continue;
    v = v.add(sum(value[p.key]));
    q = q.add(sum(sold[p.key]));
  }
  const cost = div(capex.add(interest), area);
  const price = div(v, q);
  return { cost_m2: cost, markup: cost && price ? price.div(cost).sub(ONE) : null };
}

export function F_KPI_PEAK_EQUITY(ctx: FormulaContext): { peak_equity: Decimal; peak_date: IsoDate | null; payback_date: IsoDate | null } {
  const fcfe = ctx.formula<Decimal[]>("F.CF.FCFE");
  const date = ctx.formula<IsoDate[]>("F.TIME.DATE");
  let cum = ZERO;
  let min = ZERO;
  let tPeak: number | null = null;
  const acc = fcfe.map((x, t) => {
    cum = cum.add(x);
    if (cum.lt(min)) {
      min = cum;
      tPeak = t;
    }
    return cum;
  });
  const peak = tPeak;
  const tPay = peak === null ? null : acc.findIndex((x, t) => t > peak && x.gte(ZERO));
  if (tPay !== null && tPay < 0) ctx.message("warning", "Вложения застройщика не окупаются в пределах расчёта: накопленный поток акционера к концу расчёта отрицательный");
  return { peak_equity: min.neg(), peak_date: peak === null ? null : (date[peak] as IsoDate), payback_date: tPay === null || tPay < 0 ? null : (date[tPay] as IsoDate) };
}

export function F_KPI_LTC_LTV(ctx: FormulaContext): { ltc: (Decimal | null)[]; ltv: (Decimal | null)[] } {
  const debt = ctx.formula<Debt>("F.FIN.DEBT");
  ctx.formula<Decimal[]>("F.FIN.INTEREST");
  const capex = ctx.formula<Series>("F.CAPEX.ITEM_CASH");
  const price = ctx.formula<RowSeries>("F.SALES.PRICE");
  const sold = ctx.formula<RowSeries>("F.SALES.SOLD_AREA");
  const list = products(ctx);
  const stock = new Map(list.map((p) => [p.key, new Decimal((p.pieces ? p.row.stock_units : p.row.stock_area) ?? 0)]));
  const left = new Map(list.map((p) => [p.key, stock.get(p.key) as Decimal]));
  let spent = ZERO;
  const ltc: (Decimal | null)[] = [];
  const ltv: (Decimal | null)[] = [];
  debt.debt.forEach((d, t) => {
    spent = spent.add(Object.values(capex).reduce((s, v) => s.add(at(v, t)), ZERO));
    let unsold = ZERO;
    for (const p of list) {
      const rest = Decimal.max((left.get(p.key) as Decimal).sub(at(sold[p.key], t)), ZERO);
      left.set(p.key, rest);
      unsold = unsold.add(rest.mul(at(price[p.key], t)));
    }
    const owed = d.add(at(debt.accrued, t));
    ltc.push(owed.isZero() ? null : div(owed, spent));
    ltv.push(owed.isZero() ? null : div(owed, unsold));
  });
  return { ltc, ltv };
}

export function F_KPI_LLCR(ctx: FormulaContext): (Decimal | null)[] {
  const cfads = ctx.formula<Decimal[]>("F.CF.CFADS");
  const rate = ctx.formula<Decimal[]>("F.FIN.RATE");
  const debt = ctx.formula<Debt>("F.FIN.DEBT");
  const date = ctx.formula<IsoDate[]>("F.TIME.DATE");
  const owed = debt.debt.map((d, t) => d.add(at(debt.accrued, t)));
  // Месяц погашения: следующий после последнего месяца с долгом (0 — долга нет)
  const maturity = owed.reduce((acc: number, x, t) => (x.gt(ONE) ? t + 1 : acc), 0);
  return owed.map((o, t) => {
    if (!o.gt(ONE) || maturity === 0) return null;
    const span = rate.slice(t, maturity + 1);
    const avg = sum(span).div(span.length || 1);
    let pv = ZERO;
    for (let m = t; m <= maturity && m < cfads.length; m++) {
      pv = pv.add(at(cfads, m).div(ONE.add(avg).pow(new Decimal(daysBetween(date[t] as IsoDate, date[m] as IsoDate)).div(DAYS_IN_YEAR))));
    }
    return pv.div(o);
  });
}

export function F_KPI_UNFORECASTED_REVENUE(ctx: FormulaContext): { dkp_revenue: Decimal; dkp_share: Decimal | null } {
  const value = ctx.formula<RowSeries>("F.SALES.CONTRACT_VALUE");
  const post = ctx.formula<number[][]>("F.TIME.FLAG_POST_RNV");
  let dkp = ZERO;
  let all = ZERO;
  for (const p of products(ctx)) {
    const f = post[p.phaseIndex] ?? [];
    (value[p.key] ?? []).forEach((x, t) => {
      all = all.add(x);
      if (f[t] === 1) dkp = dkp.add(x);
    });
  }
  return { dkp_revenue: dkp, dkp_share: div(dkp, all) };
}

export const KPI_FORMULAS = {
  "F.KPI.RISK_FREE": F_KPI_RISK_FREE,
  "F.KPI.DISCOUNT_RATE": F_KPI_DISCOUNT_RATE,
  "F.KPI.NPV": F_KPI_NPV,
  "F.KPI.IRR": F_KPI_IRR,
  "F.KPI.MARGIN": F_KPI_MARGIN,
  "F.KPI.COST_PER_M2": F_KPI_COST_PER_M2,
  "F.KPI.PEAK_EQUITY": F_KPI_PEAK_EQUITY,
  "F.KPI.LTC_LTV": F_KPI_LTC_LTV,
  "F.KPI.LLCR": F_KPI_LLCR,
  "F.KPI.UNFORECASTED_REVENUE": F_KPI_UNFORECASTED_REVENUE,
} as const;
