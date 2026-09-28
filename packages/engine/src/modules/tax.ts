/**
 * TAX — налоги (data/formulas.yaml, модуль TAX): НДС с продаж и к уплате, налог на прибыль, налоговые платежи месяца.
 *
 * Налог на прибыль и платежи месяца считаются помесячно вместе с кредитом (FIN): налоговые платежи входят в потребность
 * в финансировании, а проценты и комиссии уменьшают налог. Связь идёт через прошлые периоды: налог за год — в первом
 * месяце следующего года, уплата — в марте (п.1 ст.287 НК РФ), НДС — в месяцы после квартала (п.1 ст.174 НК РФ).
 *
 * «Как в исходном Excel» налоги не считаются (0): налоги исходника переносятся вместе с разделом «Расхождения».
 */
import Decimal from "decimal.js";
import type { FormulaContext } from "../context";
import { CalcError, stepwise } from "../context";
import { isIsoDate, monthDiff, monthOf, yearOf, type IsoDate } from "../lib/dates";
import { fmt } from "../lib/format";
import { isQuarterEnd } from "../lib/quarters";
import { inputVat } from "./capex";
import { products, type Revenue, type RowSeries } from "./sales";
import { milestones } from "./time";

const ZERO = new Decimal(0);
const ONE = new Decimal(1);

type Series = Partial<Record<string, Decimal[]>>;

/** Строка TAX.VAT_REGIME. */
interface RegimeRow {
  product: string;
  channel: string;
  taxable: boolean;
}

const CHANNEL_DDU = "ДДУ";
const CHANNEL_DKP = "ДКП";

const zeros = (n: number) => Array.from({ length: n }, () => ZERO);
const sum = (xs: readonly Decimal[]) => xs.reduce((s, x) => s.add(x), ZERO);
const at = (xs: readonly (Decimal | null | undefined)[] | null | undefined, t: number): Decimal => (t >= 0 ? (xs?.[t] ?? ZERO) : ZERO);

function months(ctx: FormulaContext): number {
  return ctx.formula<IsoDate[]>("F.TIME.DATE").length;
}

/** Договор месяца t продукта заключён по ДДУ (до РНВ очереди), иначе — ДКП. Как в F.SALES.CASH_IN. */
function dduFlags(ctx: FormulaContext): (phaseIndex: number) => (t: number) => boolean {
  const post = ctx.formula<number[][]>("F.TIME.FLAG_POST_RNV");
  return (p) => (t) => (post[p] ?? [])[t] !== 1;
}

/** НДС с реализации по строкам продуктов и доля договоров ДДУ — для базы налога на прибыль. */
export interface OutputVat {
  byRow: RowSeries;
}

export function F_TAX_OUTPUT_VAT(ctx: FormulaContext): OutputVat {
  const value = ctx.formula<RowSeries>("F.SALES.CONTRACT_VALUE");
  if (ctx.mode === "legacy") return { byRow: Object.fromEntries(Object.entries(value).map(([k, s]) => [k, s.map(() => ZERO)])) };
  const rate = ctx.requireNum("TAX.VAT_RATE");
  const regime = ctx.require<RegimeRow[]>("TAX.VAT_REGIME");
  if (!Array.isArray(regime)) throw new CalcError("Режим НДС: нужен список строк «продукт — канал — облагается»", "TAX.VAT_REGIME");
  const ddu = dduFlags(ctx);
  const k = rate.div(ONE.add(rate));
  const byRow: RowSeries = {};
  for (const p of products(ctx)) {
    const rule = (channel: string) => {
      const r = regime.find((x) => x.product === p.row.product && x.channel === channel);
      if (!r) throw new CalcError(`Нет правила НДС для продукта «${p.row.product}» по каналу ${channel}`, "TAX.VAT_REGIME");
      return r.taxable ? k : ZERO;
    };
    const isDdu = ddu(p.phaseIndex);
    const kDdu = rule(CHANNEL_DDU);
    const kDkp = rule(CHANNEL_DKP);
    byRow[p.key] = (value[p.key] ?? []).map((x, t) => x.mul(isDdu(t) ? kDdu : kDkp));
  }
  return { byRow };
}

export function F_TAX_INPUT_VAT_SHARE(ctx: FormulaContext): Decimal {
  const manual = ctx.num("TAX.INPUT_VAT_RECOVERABLE");
  if (manual !== null) return manual;
  const out = ctx.formula<OutputVat>("F.TAX.OUTPUT_VAT");
  const rev = ctx.formula<Revenue>("F.SALES.REVENUE_TOTAL");
  if (ctx.mode === "legacy") return ZERO;
  const rate = ctx.requireNum("TAX.VAT_RATE");
  // Облагаемая выручка без НДС = НДС / ставка
  const taxableNet = sum(Object.values(out.byRow).map(sum)).div(rate);
  const net = rev.net ?? rev.gross;
  return net.isZero() ? ZERO : taxableNet.div(net);
}

/** НДС по кварталам (в месяце конца квартала) и платежи по месяцам. */
export interface VatPayable {
  /** НДС к уплате (+) или возмещению (−) за квартал — в последнем месяце квартала. */
  quarter: Decimal[];
  paid: Decimal[];
  refund: Decimal[];
  /** Входящий НДС месяца: весь и к вычету. */
  input: Decimal[];
  recoverable: Decimal[];
}

export function F_TAX_VAT_PAYABLE(ctx: FormulaContext): VatPayable {
  const n = months(ctx);
  const cash = ctx.formula<Series>("F.CAPEX.ITEM_CASH");
  if (ctx.mode === "legacy") return { quarter: zeros(n), paid: zeros(n), refund: zeros(n), input: zeros(n), recoverable: zeros(n) };
  const date = ctx.formula<IsoDate[]>("F.TIME.DATE");
  const out = ctx.formula<OutputVat>("F.TAX.OUTPUT_VAT");
  const share = ctx.formula<Decimal>("F.TAX.INPUT_VAT_SHARE");
  const payMonths = ctx.requireNum("TAX.VAT_PAY_MONTHS").toNumber();
  const refundLag = ctx.requireNum("TAX.VAT_REFUND_LAG_M").toNumber();
  if (!Number.isInteger(payMonths) || payMonths < 1) throw new CalcError("Число месяцев уплаты НДС — целое ≥ 1", "TAX.VAT_PAY_MONTHS");
  const vatIn = Object.values(inputVat(ctx, cash));
  const input = date.map((_, t) => vatIn.reduce((s, xs) => s.add(at(xs, t)), ZERO));
  const recoverable = input.map((x) => x.mul(share));
  const outRows = Object.values(out.byRow);
  const output = date.map((_, t) => outRows.reduce((s, xs) => s.add(at(xs, t)), ZERO));
  const quarter = zeros(n);
  const paid = zeros(n);
  const refund = zeros(n);
  let acc = ZERO;
  date.forEach((d, t) => {
    acc = acc.add(output[t] as Decimal).sub(recoverable[t] as Decimal);
    if (!isQuarterEnd(d) && t !== n - 1) return;
    quarter[t] = acc;
    if (acc.gt(ZERO)) {
      const part = acc.div(payMonths);
      for (let m = t + 1; m <= t + payMonths && m < n; m++) paid[m] = (paid[m] as Decimal).add(part);
    } else if (acc.lt(ZERO) && t + refundLag < n) {
      refund[t + refundLag] = (refund[t + refundLag] as Decimal).sub(acc);
    }
    acc = ZERO;
  });
  return { quarter, paid, refund, input, recoverable };
}

/** База налога на прибыль по месяцам (без процентов и комиссий — они вычитаются в налоге за год). */
export function F_TAX_PROFIT_BASE(ctx: FormulaContext): Decimal[] {
  const n = months(ctx);
  const value = ctx.formula<RowSeries>("F.SALES.CONTRACT_VALUE");
  if (ctx.mode === "legacy") return zeros(n);
  const date = ctx.formula<IsoDate[]>("F.TIME.DATE");
  const out = ctx.formula<OutputVat>("F.TAX.OUTPUT_VAT");
  const vat = ctx.formula<VatPayable>("F.TAX.VAT_PAYABLE");
  const capex = ctx.formula<Decimal>("F.CAPEX.TOTAL");
  const phases = milestones(ctx);
  const ddu = dduFlags(ctx);
  const list = products(ctx);
  const cost = capex.sub(sum(vat.recoverable));
  const total = list.reduce((s, p) => s.add(sum(value[p.key] ?? [])), ZERO);
  const base = zeros(n);
  if (total.isZero()) return base;
  const costOf = (v: Decimal) => cost.mul(v).div(total);
  const economy = phases.map(() => ZERO);
  for (const p of list) {
    const isDdu = ddu(p.phaseIndex);
    (value[p.key] ?? []).forEach((v, t) => {
      const net = v.sub(at(out.byRow[p.key], t));
      const profit = net.sub(costOf(v));
      if (isDdu(t)) economy[p.phaseIndex] = (economy[p.phaseIndex] as Decimal).add(profit);
      else base[t] = (base[t] as Decimal).add(profit);
    });
  }
  phases.forEach((row, i) => {
    const e = economy[i] as Decimal;
    if (e.isZero()) return;
    let when = row.handover_end;
    if (!isIsoDate(when)) {
      when = row.rnv_date;
      if (!isIsoDate(when)) throw new CalcError(`Очередь ${row.phase}: заполните веху «окончание передачи по актам» или «РНВ» — от неё зависит, когда признаётся экономия по ДДУ`, "TIME.MILESTONES");
      ctx.message(
        "warning",
        `Очередь ${row.phase}: дата окончания передачи квартир не задана, поэтому экономия по ДДУ ${fmt(e)} руб. признана в месяц РНВ. Заполните веху «окончание передачи по актам»`,
        "TIME.MILESTONES",
        `TAX.HANDOVER_END_MISSING:${row.phase}`,
      );
    }
    const t = monthDiff(date[0] as IsoDate, when);
    const m = Math.min(Math.max(t, 0), n - 1);
    base[m] = (base[m] as Decimal).add(e);
  });
  return base;
}

/** Налог на прибыль: за год — в первом месяце следующего года; убытки к переносу на конец месяца. */
export interface ProfitTax {
  tax: Decimal;
  /** База года после процентов и комиссий (null — в этом месяце год не закрывается). */
  base: Decimal | null;
  loss_cf: Decimal;
}

export const F_TAX_PROFIT_TAX = stepwise(function F_TAX_PROFIT_TAX(ctx: FormulaContext, t: number): ProfitTax {
  const date = ctx.formula<IsoDate[]>("F.TIME.DATE");
  const own = ctx.own<{ loss_cf: Decimal[] }>();
  const lossPrev = at(own?.loss_cf, t - 1);
  const none = { tax: ZERO, base: null, loss_cf: lossPrev };
  if (ctx.mode === "legacy") return none;
  const base = ctx.formula<Decimal[]>("F.TAX.PROFIT_BASE");
  const interest = ctx.formula<Decimal[]>("F.FIN.INTEREST");
  const fees = ctx.formula<Decimal[]>("F.FIN.FEES");
  const y = yearOf(date[t] as IsoDate);
  if (t === 0 || yearOf(date[t - 1] as IsoDate) === y) return none;
  // Первый месяц года: закрываем прошлый год (проценты и комиссии по t − 1 известны)
  let yearBase = ZERO;
  for (let m = t - 1; m >= 0 && yearOf(date[m] as IsoDate) === y - 1; m--) {
    yearBase = yearBase.add(at(base, m)).sub(at(interest, m)).sub(at(fees, m));
  }
  const limit = ctx.requireNum("TAX.LOSS_CARRYFORWARD_LIMIT");
  const rate = ctx.requireNum("TAX.PROFIT_RATE");
  const positive = Decimal.max(yearBase, ZERO);
  const used = Decimal.min(lossPrev, positive.mul(limit));
  const tax = positive.sub(used).mul(rate);
  return { tax, base: yearBase, loss_cf: lossPrev.sub(used).add(Decimal.max(yearBase.neg(), ZERO)) };
});

/** Налоговые платежи месяца и их части. */
interface TaxPaymentsMonth {
  total: Decimal;
  vat_paid: Decimal;
  vat_refund: Decimal;
  profit_tax_paid: Decimal;
}

/** Налоговые платежи по месяцам (результат F.TAX.PAYMENTS: ряды по полям). */
export type TaxPayments = { [K in keyof TaxPaymentsMonth]: Decimal[] };

export const F_TAX_PAYMENTS = stepwise(function F_TAX_PAYMENTS(ctx: FormulaContext, t: number): TaxPaymentsMonth {
  const vat = ctx.formula<VatPayable>("F.TAX.VAT_PAYABLE");
  const date = ctx.formula<IsoDate[]>("F.TIME.DATE");
  const profit = ctx.formula<{ tax: Decimal[] } | null>("F.TAX.PROFIT_TAX");
  const month = ctx.requireNum("TAX.PROFIT_TAX_PAY_MONTH").toNumber();
  const d = date[t] as IsoDate;
  let profitPaid = ZERO;
  if (monthOf(d) === month) {
    // Налог за прошлый год посчитан в январе этого года
    for (let m = t - 1; m >= 0 && yearOf(date[m] as IsoDate) === yearOf(d); m--) profitPaid = profitPaid.add(at(profit?.tax, m));
  }
  const paid = at(vat.paid, t);
  const refund = at(vat.refund, t);
  return { total: paid.sub(refund).add(profitPaid), vat_paid: paid, vat_refund: refund, profit_tax_paid: profitPaid };
});

export const TAX_FORMULAS = {
  "F.TAX.OUTPUT_VAT": F_TAX_OUTPUT_VAT,
  "F.TAX.INPUT_VAT_SHARE": F_TAX_INPUT_VAT_SHARE,
  "F.TAX.VAT_PAYABLE": F_TAX_VAT_PAYABLE,
  "F.TAX.PROFIT_BASE": F_TAX_PROFIT_BASE,
  "F.TAX.PROFIT_TAX": F_TAX_PROFIT_TAX,
  "F.TAX.PAYMENTS": F_TAX_PAYMENTS,
} as const;
