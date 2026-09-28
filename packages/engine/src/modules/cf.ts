/**
 * CF — денежный поток (data/formulas.yaml, модуль CF): поток проекта до кредита, поток акционера, остаток денег,
 * длина расчёта.
 */
import Decimal from "decimal.js";
import type { FormulaContext } from "../context";
import { type IsoDate } from "../lib/dates";
import { fmt } from "../lib/format";
import type { EscrowBalance } from "./escrow";
import type { Debt, EquityIn, Repayment } from "./fin";
import type { CashIn, RowSeries } from "./sales";
import type { TaxPayments } from "./tax";

const ZERO = new Decimal(0);
const ONE = new Decimal(1);

type Series = Partial<Record<string, Decimal[]>>;

const at = (xs: readonly (Decimal | null | undefined)[] | null | undefined, t: number): Decimal => (t >= 0 ? (xs?.[t] ?? ZERO) : ZERO);
/** Число месяцев по последний месяц с ненулевым значением включительно (0 — таких нет). */
const monthsTo = (xs: readonly Decimal[]): number => xs.reduce((acc: number, x, t) => (x.abs().gt(ONE) ? t + 1 : acc), 0);

export function F_CF_CFADS(ctx: FormulaContext): Decimal[] {
  const esc = ctx.formula<EscrowBalance>("F.ESC.BALANCE");
  const cash = ctx.formula<CashIn>("F.SALES.CASH_IN");
  const capex = ctx.formula<Series>("F.CAPEX.ITEM_CASH");
  const taxes = ctx.formula<TaxPayments>("F.TAX.PAYMENTS");
  const date = ctx.formula<IsoDate[]>("F.TIME.DATE");
  return date.map((_, t) => {
    const release = esc.release.reduce((s, r) => s.add(at(r, t)), ZERO);
    let dkp = ZERO;
    for (const [k, v] of Object.entries(cash.total)) dkp = dkp.add(at(v, t)).sub(at(cash.ddu[k], t));
    const spend = Object.values(capex).reduce((s, v) => s.add(at(v, t)), ZERO);
    return release.add(dkp).sub(spend).sub(at(taxes.total, t));
  });
}

export function F_CF_FCFE(ctx: FormulaContext): Decimal[] {
  const cfads = ctx.formula<Decimal[]>("F.CF.CFADS");
  const draw = ctx.formula<Decimal[]>("F.FIN.DRAW");
  const rep = ctx.formula<Repayment>("F.FIN.REPAYMENT");
  const fees = ctx.formula<Decimal[]>("F.FIN.FEES");
  return cfads.map((x, t) => x.add(at(draw, t)).sub(at(rep.principal, t)).sub(at(rep.interest_paid, t)).sub(at(fees, t)));
}

export function F_CF_CASH_BALANCE(ctx: FormulaContext): Decimal[] {
  const fcfe = ctx.formula<Decimal[]>("F.CF.FCFE");
  const equity = ctx.formula<EquityIn>("F.FIN.EQUITY_IN");
  const date = ctx.formula<IsoDate[]>("F.TIME.DATE");
  let cash = ZERO;
  let worst = ZERO;
  let worstDate: IsoDate | null = null;
  const out = fcfe.map((x, t) => {
    // Выплаты акционеру до конца расчёта не моделируются: свободные деньги остаются в проекте
    cash = cash.add(x).add(at(equity.total, t));
    if (cash.lt(worst)) {
      worst = cash;
      worstDate = date[t] as IsoDate;
    }
    return cash;
  });
  if (worst.lt(ONE.neg())) {
    ctx.message("warning", `Остаток денег проекта уходит в минус: ${fmt(worst)} руб. на ${worstDate}. Эти деньги должен внести застройщик сверх взносов; проверьте лимит кредита и сроки налогов`, "FIN.EQUITY_SHARE");
  }
  return out;
}

export function F_CF_HORIZON(ctx: FormulaContext): number {
  const sold = ctx.formula<RowSeries>("F.SALES.SOLD_AREA");
  const flags = ctx.formula<number[][]>("F.TIME.FLAG_ESCROW_RELEASE");
  const debt = ctx.formula<Debt>("F.FIN.DEBT");
  const tax = ctx.formula<{ tax: Decimal[] }>("F.TAX.PROFIT_TAX");
  const tail = ctx.requireNum("TIME.HORIZON_TAIL_M").toNumber();
  const warn = ctx.requireNum("TIME.HORIZON_WARN_M").toNumber();
  // Всё — в месяцах от начала модели по месяц события включительно
  const lastSale = Math.max(0, ...Object.values(sold).map(monthsTo));
  const lastRelease = Math.max(0, ...flags.map((f) => f.lastIndexOf(1) + 1));
  const owed = debt.debt.map((d, t) => d.add(at(debt.accrued, t)));
  const repaid = monthsTo(owed) + 1;
  const payMonth = ctx.requireNum("TAX.PROFIT_TAX_PAY_MONTH").toNumber();
  // Налог за год считается в январе и платится в месяце payMonth того же года
  const lastTax = monthsTo(tax.tax);
  const taxPaid = lastTax === 0 ? 0 : lastTax + payMonth - 1;
  const end = Math.max(lastSale, lastRelease, repaid, taxPaid) + tail;
  if (end > warn) ctx.message("warning", `Расчёт длится ${end} мес. — дольше ${warn} мес.: вероятно, не распродан остаток или не погашен кредит`, "TIME.HORIZON_WARN_M");
  if (ctx.horizonMonths !== null && end > ctx.horizonMonths) {
    ctx.message("warning", `Последнее событие проекта позже конца расчёта: нужно ${end} мес., а посчитано ${ctx.horizonMonths}. Платежи после конца расчёта в итоги не попали`, "TIME.HORIZON_TAIL_M");
  }
  return end;
}

export const CF_FORMULAS = {
  "F.CF.CFADS": F_CF_CFADS,
  "F.CF.FCFE": F_CF_FCFE,
  "F.CF.CASH_BALANCE": F_CF_CASH_BALANCE,
  "F.CF.HORIZON": F_CF_HORIZON,
} as const;
