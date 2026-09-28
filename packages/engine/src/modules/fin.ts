/**
 * FIN — проектное финансирование (data/formulas.yaml, модуль FIN).
 *
 * Комиссии → потребность → взнос застройщика → выдача → ставка → проценты → погашение → долг связаны через прошлый
 * месяц (lag_depends_on), поэтому формулы считаются помесячно (stepwise): ядро вызывает их для месяца t по порядку,
 * затем для t + 1. Значение ряда другой формулы группы доступно по месяц t, если она посчитана раньше в этом месяце,
 * иначе по t − 1.
 *
 * «Как в исходном Excel» — поквартально, как лист CF1 (строки 88–132), вместе с ошибками исходника: значение квартала
 * стоит в последнем месяце квартала, в остальных месяцах потоки 0. Знаки — как в ядре (выдача, проценты, погашение —
 * положительные); там, где исходник ошибается знаком (покрытие, поток по кредиту), расчёт повторяет его и выдаёт
 * предупреждение.
 */
import Decimal from "decimal.js";
import type { FormulaContext } from "../context";
import { CalcError, stepwise } from "../context";
import { yearOf, type IsoDate } from "../lib/dates";
import { fmt, fmtQuarter, fmtShare } from "../lib/format";
import { irr, xirr } from "../lib/irr";
import { annualizeQuarterly, QuarterGrid } from "../lib/quarters";
import type { EscrowBalance } from "./escrow";
import type { CashIn } from "./sales";

const ZERO = new Decimal(0);
const ONE = new Decimal(1);
const DAYS_IN_YEAR = 365;

type Series = Partial<Record<string, Decimal[]>>;

/** Потребность и свободные деньги проекта на начало месяца (F.FIN.FUNDING_NEED). */
export interface FundingNeed {
  need: Decimal[];
  cash_bop: (Decimal | null)[];
}
/** Взнос застройщика: всего и из него сверх лимита кредита (F.FIN.EQUITY_IN). */
export interface EquityIn {
  total: Decimal[];
  gap: Decimal[];
}
/** Погашение кредита (F.FIN.REPAYMENT). */
export interface Repayment {
  interest_paid: Decimal[];
  principal: Decimal[];
  from_escrow: Decimal[];
  from_dkp: Decimal[];
}
/** Остатки на конец месяца: основной долг и неоплаченные проценты (F.FIN.DEBT). */
export interface Debt {
  debt: Decimal[];
  accrued: Decimal[];
}

const at = (xs: readonly (Decimal | null | undefined)[] | null | undefined, t: number): Decimal => (t >= 0 ? (xs?.[t] ?? ZERO) : ZERO);
const sumTo = (xs: readonly (Decimal | null | undefined)[] | null | undefined, n: number): Decimal => {
  let s = ZERO;
  for (let i = 0; i < n; i++) s = s.add(xs?.[i] ?? ZERO);
  return s;
};
const half = (x: Decimal) => x.div(ONE.add(ONE));
const isLast = (ctx: FormulaContext, t: number) => t === (ctx.horizonMonths ?? 0) - 1;

/** Периоды CF1 для расчёта «как в исходном Excel». */
export function quarterGrid(ctx: FormulaContext): QuarterGrid {
  return new QuarterGrid(ctx.formula<IsoDate[]>("F.TIME.DATE"));
}

/** Месяцы раскрытия эскроу очередей (F.TIME.FLAG_ESCROW_RELEASE); очередь без раскрытия в горизонте — Infinity. */
function releaseMonths(ctx: FormulaContext): number[] {
  const flags = ctx.formula<number[][]>("F.TIME.FLAG_ESCROW_RELEASE");
  return flags.map((f) => {
    const i = f.indexOf(1);
    return i < 0 ? Infinity : i;
  });
}

function capexAt(cash: Series, t: number): Decimal {
  let s = ZERO;
  for (const v of Object.values(cash)) s = s.add(v?.[t] ?? ZERO);
  return s;
}

function releaseAt(esc: EscrowBalance, t: number): Decimal {
  return esc.release.reduce((s, r) => s.add(r[t] ?? ZERO), ZERO);
}

/** Поступления по договорам купли-продажи: всё, что мимо эскроу. */
function dkpAt(cash: CashIn, t: number): Decimal {
  let s = ZERO;
  for (const [k, v] of Object.entries(cash.total)) s = s.add(v?.[t] ?? ZERO).sub(cash.ddu[k]?.[t] ?? ZERO);
  return s;
}

// ---------------------------------------------------------------------------------------------------------------

export function F_FIN_EQUITY_REQUIRED(ctx: FormulaContext): Decimal | null {
  // В исходнике требуемого собственного участия нет: собственные средства — доля расходов каждого квартала (CF1!F132)
  if (ctx.mode === "legacy") return null;
  return ctx.requireNum("FIN.EQUITY_SHARE").mul(ctx.formula<Decimal>("F.CAPEX.TOTAL"));
}

export function F_FIN_LIMIT(ctx: FormulaContext): Decimal {
  if (ctx.mode === "legacy") return ctx.requireNum("FIN.LEGACY_LIMIT");
  const limit = ctx.formula<Decimal>("F.CAPEX.TOTAL").sub(ctx.formula<Decimal>("F.FIN.EQUITY_REQUIRED"));
  return Decimal.max(limit, ZERO);
}

export const F_FIN_FEES = stepwise(function F_FIN_FEES(ctx: FormulaContext, t: number): Decimal {
  const limit = ctx.formula<Decimal>("F.FIN.LIMIT");
  const arrangement = ctx.num("FIN.FEE_ARRANGEMENT");
  if (arrangement === null) ctx.message("warning", "Комиссия за выдачу кредита не задана и в расчёт не входит. Возьмите ставку из кредитного решения банка", "FIN.FEE_ARRANGEMENT");
  if (ctx.mode === "legacy") {
    const g = quarterGrid(ctx);
    // CF1!F111 = D111 × Бюджет!F67 в первом квартале, комиссии за резервирование нет (CF1!F112:AS112 пустые)
    if (t === 0) {
      ctx.message(
        "warning",
        `Комиссия за выдачу в исходнике ${fmtShare(arrangement ?? ZERO)} × ${fmt(limit)} руб. = ${fmt(limit.mul(arrangement ?? ZERO))} руб. считается от «лимита» Бюджет!F67, в который входят участок и налоги, и платится в первом квартале, до выдач. Проверьте лимит по кредитному решению банка`,
        "FIN.LEGACY_LIMIT",
        "LEGACY.FIN_FEE_BASE",
      );
    }
    return g.isEnd(t) && g.isFirstColumn(t) && arrangement ? arrangement.mul(limit) : ZERO;
  }
  const req = ctx.formula<Decimal>("F.FIN.EQUITY_REQUIRED");
  const equity = ctx.formula<EquityIn | null>("F.FIN.EQUITY_IN");
  const draw = ctx.formula<Decimal[] | null>("F.FIN.DRAW");
  const days = ctx.formula<number[]>("F.TIME.DAYS");
  const last = Math.max(...releaseMonths(ctx));
  const isOpen = (m: number) => m >= 0 && m <= last && sumTo(equity?.total, m).gte(req);
  const open = isOpen(t);
  const commitment = ctx.num("FIN.FEE_COMMITMENT");
  let fee = ZERO;
  if (open && !isOpen(t - 1) && arrangement) fee = fee.add(arrangement.mul(limit));
  if (open && commitment) {
    const undrawn = Decimal.max(limit.sub(sumTo(draw, t)), ZERO);
    fee = fee.add(commitment.mul(undrawn).mul(days[t] ?? 0).div(DAYS_IN_YEAR));
  }
  return fee;
});

export const F_FIN_FUNDING_NEED = stepwise(function F_FIN_FUNDING_NEED(ctx: FormulaContext, t: number): { need: Decimal; cash_bop: Decimal | null } {
  const capex = ctx.formula<Series>("F.CAPEX.ITEM_CASH");
  if (ctx.mode === "legacy") {
    // CF1!F98: кредит считается от расходов квартала (строка 18)
    const g = quarterGrid(ctx);
    return { need: g.isEnd(t) ? g.sum(Array.from({ length: t + 1 }, (_, m) => capexAt(capex, m)), t) : ZERO, cash_bop: null };
  }
  // Налоги (F.TAX.PAYMENTS) — этап 6: до этого в потребность не входят
  ctx.message("info", "Налоги в потребность в финансировании пока не входят: их расчёт появится на следующем этапе");
  const fees = ctx.formula<Decimal[]>("F.FIN.FEES");
  let cash = ZERO;
  if (t > 0) {
    const p = t - 1;
    const own = ctx.own<FundingNeed>();
    const equity = ctx.formula<EquityIn>("F.FIN.EQUITY_IN");
    const draw = ctx.formula<Decimal[]>("F.FIN.DRAW");
    const rep = ctx.formula<Repayment>("F.FIN.REPAYMENT");
    const esc = ctx.formula<EscrowBalance>("F.ESC.BALANCE");
    const cashIn = ctx.formula<CashIn>("F.SALES.CASH_IN");
    cash = at(own?.cash_bop, p)
      .add(at(equity.total, p))
      .add(at(draw, p))
      .add(releaseAt(esc, p))
      .add(dkpAt(cashIn, p))
      .sub(at(rep.interest_paid, p))
      .sub(at(rep.principal, p))
      .sub(capexAt(capex, p))
      .sub(at(fees, p));
  }
  const need = Decimal.max(capexAt(capex, t).add(at(fees, t)).sub(cash), ZERO);
  return { need, cash_bop: cash };
});

export const F_FIN_EQUITY_IN = stepwise(function F_FIN_EQUITY_IN(ctx: FormulaContext, t: number): { total: Decimal; gap: Decimal } {
  const need = at(ctx.formula<FundingNeed>("F.FIN.FUNDING_NEED").need, t);
  const own = ctx.own<EquityIn>();
  if (ctx.mode === "legacy") {
    const g = quarterGrid(ctx);
    const fees = ctx.formula<Decimal[]>("F.FIN.FEES");
    const share = ctx.requireNum("FIN.EQUITY_SHARE");
    if (t === 0) {
      ctx.message(
        "warning",
        `Собственные средства в исходнике — ${fmtShare(share)} расходов каждого квартала (CF1 строка 132), а в первом квартале — только комиссия за выдачу. Банк требует внести собственное участие до первой выдачи; в расчёте сервиса так и считается`,
        "FIN.EQUITY_SHARE",
        "LEGACY.FIN_EQUITY",
      );
    }
    if (!g.isEnd(t)) return { total: ZERO, gap: ZERO };
    return { total: g.isFirstColumn(t) ? at(fees, t) : share.mul(need), gap: ZERO };
  }
  const req = ctx.formula<Decimal>("F.FIN.EQUITY_REQUIRED");
  const limit = ctx.formula<Decimal>("F.FIN.LIMIT");
  const draw = ctx.formula<Decimal[] | null>("F.FIN.DRAW");
  const last = Math.max(...releaseMonths(ctx));
  const restReq = Decimal.max(req.sub(sumTo(own?.total, t)), ZERO);
  const upfront = Decimal.min(need, restReq);
  const open = upfront.eq(restReq) && t <= last;
  const credit = open ? Decimal.min(need.sub(upfront), Decimal.max(limit.sub(sumTo(draw, t)), ZERO)) : ZERO;
  const gap = need.sub(upfront).sub(credit);
  if (isLast(ctx, t)) {
    const totalGap = sumTo(own?.gap, t).add(gap);
    if (totalGap.gt(ONE)) {
      ctx.message(
        "warning",
        `Кредита не хватает на ${fmt(totalGap)} руб.: эти деньги вносит застройщик сверх собственного участия. Проверьте лимит кредита и даты раскрытия эскроу`,
        "FIN.EQUITY_SHARE",
      );
    }
  }
  return { total: upfront.add(gap), gap };
});

export const F_FIN_DRAW = stepwise(function F_FIN_DRAW(ctx: FormulaContext, t: number): Decimal {
  const need = at(ctx.formula<FundingNeed>("F.FIN.FUNDING_NEED").need, t);
  const equity = at(ctx.formula<EquityIn>("F.FIN.EQUITY_IN").total, t);
  if (ctx.mode === "legacy") {
    // CF1!F98 = −(F18 + F132) × F8: расходы квартала плюс собственные средства, пока продажи идут на эскроу
    const dduEnd = ctx.require<IsoDate>("TIME.LEGACY_ESCROW_DEPOSIT_END");
    const date = ctx.formula<IsoDate[]>("F.TIME.DATE");
    return quarterGrid(ctx).isEnd(t) && (date[t] as IsoDate) <= dduEnd ? need.add(equity) : ZERO;
  }
  // Лимит и очерёдность учтены во взносе застройщика (F.FIN.EQUITY_IN): кредит — остальное
  ctx.formula<Decimal>("F.FIN.LIMIT");
  return need.sub(equity);
});

/** Ключевая ставка на дату: {current, by_year?} — значение года или текущее; число — на весь срок. «Как в исходном Excel» — одна ставка. */
function keyRate(ctx: FormulaContext, date: IsoDate): Decimal {
  // В исходнике одна ключевая ставка на весь срок (CF1!D115)
  if (ctx.mode === "legacy") return ctx.requireNum("FIN.LEGACY_KEY_RATE");
  const v = ctx.require<unknown>("FIN.KEY_RATE_PATH");
  if (typeof v === "number" || typeof v === "string") return new Decimal(v);
  if (v && typeof v === "object") {
    const path = v as { current?: number; by_year?: Record<string, number> };
    const years = Object.keys(path.by_year ?? {}).map(Number).sort((a, b) => a - b);
    const y = yearOf(date);
    const key = years.filter((x) => x <= y).pop();
    if (key !== undefined && path.by_year) return new Decimal(path.by_year[String(key)] as number);
    if (typeof path.current === "number") return new Decimal(path.current);
  }
  throw new CalcError("Траектория ключевой ставки: нужно текущее значение или значения по годам", "FIN.KEY_RATE_PATH");
}

export const F_FIN_RATE = stepwise(function F_FIN_RATE(ctx: FormulaContext, t: number): Decimal {
  const coverage = ctx.formula<(Decimal | null)[] | null>("F.ESC.COVERAGE");
  const date = ctx.formula<IsoDate[]>("F.TIME.DATE");
  const legacy = ctx.mode === "legacy";
  const prev = legacy ? quarterGrid(ctx).prevEnd(t) : t - 1;
  const c = prev >= 0 ? (coverage?.[prev] ?? null) : null;
  const key = keyRate(ctx, date[t] as IsoDate);
  const base = key.add(ctx.requireNum("FIN.RATE_BASE_SPREAD"));
  const k1 = c === null ? ZERO : Decimal.min(c, ONE);
  // скидка — только если она есть в договоре банка (поправка задана)
  const coef = ctx.num("FIN.RATE_DISCOUNT_COEF");
  const skr = c === null || coef === null ? ZERO : Decimal.max(c.sub(ONE).mul(key.add(coef)), ZERO);
  const rate = Decimal.max(ctx.requireNum("FIN.RATE_PREFERENTIAL").mul(k1).add(base.mul(ONE.sub(k1))).sub(skr), ctx.requireNum("FIN.RATE_MIN"));
  if (legacy && isLast(ctx, t)) {
    const own = [...(ctx.own<Decimal[]>() ?? []), rate];
    const max = own.reduce((m, x) => Decimal.max(m, x), ZERO);
    const tMax = own.findIndex((x) => x.eq(max));
    if (max.gt(base)) {
      ctx.message(
        "warning",
        `Ставка кредита в исходнике доходит до ${fmtShare(max)} годовых (${fmtQuarter(date[tMax] as IsoDate)}) при базовой ${fmtShare(base)}: покрытие долга эскроу (CF1 строка 122) получается отрицательным, потому что проценты в CF1 записаны со знаком минус. Ставка должна быть между льготной и базовой`,
        "FIN.RATE_BASE_SPREAD",
        "LEGACY.FIN_RATE",
      );
    }
  }
  return rate;
});

export const F_FIN_INTEREST = stepwise(function F_FIN_INTEREST(ctx: FormulaContext, t: number): Decimal {
  const rate = at(ctx.formula<Decimal[]>("F.FIN.RATE"), t);
  const draw = at(ctx.formula<Decimal[]>("F.FIN.DRAW"), t);
  const debt = ctx.formula<Debt | null>("F.FIN.DEBT");
  const days = ctx.formula<number[]>("F.TIME.DAYS");
  const yearDays = new Decimal(DAYS_IN_YEAR);
  if (ctx.mode === "legacy") {
    const g = quarterGrid(ctx);
    if (!g.isEnd(t)) return ZERO;
    const p = g.prevEnd(t);
    const own = ctx.own<Decimal[]>();
    // CF1!F107 = (AVERAGE(F97; F97 + F98) + E107) × ставка × дни / 365: в первом квартале F97 пустая — выдача целиком;
    // прибавляются проценты прошлого квартала, а не накопленные
    const base = g.isFirstColumn(t) ? draw : at(debt?.debt, p).add(half(draw));
    const periodDays = g.sum(days, t);
    const interest = base.add(at(own, p)).mul(rate).mul(periodDays).div(yearDays);
    if (isLast(ctx, t)) legacyInterestWarning(ctx, [...(own ?? []), interest], debt);
    return interest;
  }
  return at(debt?.debt, t - 1).add(half(draw)).add(at(debt?.accrued, t - 1)).mul(rate).mul(days[t] ?? 0).div(yearDays);
});

function legacyInterestWarning(ctx: FormulaContext, interest: Decimal[], debt: Debt | null) {
  const total = interest.reduce((s, x) => s.add(x), ZERO);
  const maxDebt = (debt?.debt ?? []).reduce((m, x) => Decimal.max(m, x.abs()), ZERO);
  if (total.gt(ONE) && maxDebt.lt(ONE)) {
    ctx.message(
      "warning",
      `Проценты в исходнике начислены на ${fmt(total)} руб., хотя долг на конец каждого квартала 0 (CF1 строка 106): проценты считаются от половины выдачи квартала (в первом квартале — от всей выдачи, ячейка F97 пустая) плюс проценты прошлого квартала вместо накопленных (CF1 строка 107). Проценты должны начисляться на остаток долга`,
      "FIN.RATE_BASE_SPREAD",
      "LEGACY.FIN_INTEREST",
    );
  }
}

export const F_FIN_REPAYMENT = stepwise(function F_FIN_REPAYMENT(
  ctx: FormulaContext,
  t: number,
): { interest_paid: Decimal; principal: Decimal; from_escrow: Decimal; from_dkp: Decimal } {
  const esc = ctx.formula<EscrowBalance>("F.ESC.BALANCE");
  const draw = at(ctx.formula<Decimal[]>("F.FIN.DRAW"), t);
  const interest = ctx.formula<Decimal[]>("F.FIN.INTEREST");
  const debt = ctx.formula<Debt | null>("F.FIN.DEBT");
  ctx.formula<number[][]>("F.TIME.FLAG_ESCROW_RELEASE");
  const none = { interest_paid: ZERO, principal: ZERO, from_escrow: ZERO, from_dkp: ZERO };
  if (ctx.mode === "legacy") {
    const g = quarterGrid(ctx);
    if (!g.isEnd(t)) return none;
    const reserve = ctx.num("FIN.ESCROW_RESERVE_RATE") ?? ZERO;
    const rel = g.sum(Array.from({ length: t + 1 }, (_, m) => releaseAt(esc, m)), t).div(ONE.sub(reserve));
    // CF1!F108: в квартале раскрытия «оплачены» все проценты с начала (SUM($F$107:F107)); CF1!F100 = MAX(F93 / (1 − ФОР) + F108; −F97 − F98)
    const interestPaid = rel.gt(ZERO) ? sumTo(interest, t + 1) : ZERO;
    const principal = Decimal.max(rel.neg().sub(interestPaid), at(debt?.debt, g.prevEnd(t)).add(draw));
    if (interestPaid.gt(ZERO)) {
      const date = ctx.formula<IsoDate[]>("F.TIME.DATE");
      ctx.message(
        "warning",
        `При раскрытии эскроу (${fmtQuarter(date[t] as IsoDate)}) исходник «оплачивает» проценты ${fmt(interestPaid)} руб. (CF1 строка 108), но из-за знака они попадают в поток по кредиту (строка 113) со знаком плюс — как поступление денег проекту, а не платёж банку. Раскрытое эскроу ${fmt(rel)} руб. на погашение не идёт (строка 100). Из договоров купли-продажи кредит не гасится: флаг CF1 строка 9 всегда 0`,
        "TIME.LEGACY_ESCROW_RELEASE_DATE",
        "LEGACY.FIN_PIK_SIGN",
      );
    }
    return { interest_paid: interestPaid, principal, from_escrow: principal, from_dkp: ZERO };
  }
  const cashIn = ctx.formula<CashIn>("F.SALES.CASH_IN");
  const first = Math.min(...releaseMonths(ctx));
  const rel = releaseAt(esc, t);
  const owedInt = at(debt?.accrued, t - 1).add(at(interest, t));
  const owedDebt = at(debt?.debt, t - 1).add(draw);
  const intEsc = Decimal.min(rel, owedInt);
  const debtEsc = Decimal.min(rel.sub(intEsc), owedDebt);
  let intDkp = ZERO;
  let debtDkp = ZERO;
  if (t > first) {
    const dkp = dkpAt(cashIn, t);
    intDkp = Decimal.max(Decimal.min(dkp, owedInt.sub(intEsc)), ZERO);
    debtDkp = Decimal.max(Decimal.min(dkp.sub(intDkp), owedDebt.sub(debtEsc)), ZERO);
  }
  return { interest_paid: intEsc.add(intDkp), principal: debtEsc.add(debtDkp), from_escrow: intEsc.add(debtEsc), from_dkp: intDkp.add(debtDkp) };
});

export const F_FIN_DEBT = stepwise(function F_FIN_DEBT(ctx: FormulaContext, t: number): { debt: Decimal; accrued: Decimal } {
  const draw = at(ctx.formula<Decimal[]>("F.FIN.DRAW"), t);
  const interest = at(ctx.formula<Decimal[]>("F.FIN.INTEREST"), t);
  const rep = ctx.formula<Repayment>("F.FIN.REPAYMENT");
  const own = ctx.own<Debt>();
  const debt = at(own?.debt, t - 1).add(draw).sub(at(rep.principal, t));
  const accrued = at(own?.accrued, t - 1).add(interest).sub(at(rep.interest_paid, t));
  if (isLast(ctx, t)) {
    const drawn = sumTo(ctx.formula<Decimal[]>("F.FIN.DRAW"), t + 1);
    if (ctx.mode === "legacy") {
      const maxDebt = [...(own?.debt ?? []), debt].reduce((m, x) => Decimal.max(m, x.abs()), ZERO);
      if (drawn.gt(ONE) && maxDebt.lt(ONE)) {
        ctx.message(
          "warning",
          `Кредит в исходнике выдаётся на все расходы квартала плюс собственные средства (CF1 строка 98) и гасится в том же квартале (строка 100), поэтому долг на конец каждого квартала 0 (строка 106). Выдано и погашено ${fmt(drawn)} руб. Кредит должен гаситься из раскрытого эскроу`,
          "TIME.LEGACY_ESCROW_RELEASE_DATE",
          "LEGACY.FIN_DRAW_REPAID",
        );
      }
    } else if (debt.abs().gt(ONE) || accrued.abs().gt(ONE)) {
      ctx.message(
        "warning",
        `Кредит не погашен к концу расчёта: основной долг ${fmt(debt)} руб., проценты ${fmt(accrued)} руб. Проверьте даты раскрытия эскроу и горизонт расчёта`,
        "TIME.ESCROW_RELEASE_LAG_M",
      );
    }
  }
  return { debt, accrued };
});

export function F_FIN_EFFECTIVE_RATE(ctx: FormulaContext): Decimal | null {
  const draw = ctx.formula<Decimal[]>("F.FIN.DRAW");
  const rep = ctx.formula<Repayment>("F.FIN.REPAYMENT");
  const fees = ctx.formula<Decimal[]>("F.FIN.FEES");
  const date = ctx.formula<IsoDate[]>("F.TIME.DATE");
  if (ctx.mode === "legacy") {
    // CF1!D128 = (1 + IRR(F127:AS127))^4 − 1, поток для банка F127 = −(F98 + F99 − F108 − F109), без комиссий
    const g = quarterGrid(ctx);
    const flows: number[] = [];
    date.forEach((_, t) => {
      if (t > 0 && g.isEnd(t)) flows.push(at(draw, t).sub(at(rep.principal, t)).add(at(rep.interest_paid, t)).neg().toNumber());
    });
    const r = irr(flows);
    if (r === null) {
      ctx.message(
        "warning",
        "Эффективная ставка кредита в исходнике не считается (CF1!D128 = #NUM!): в потоке по кредиту для банка нет выдач и погашений разного знака, потому что выдачи гасятся в том же квартале, а проценты при раскрытии записаны как поступление",
        "TIME.LEGACY_ESCROW_RELEASE_DATE",
        "LEGACY.FIN_EFF_RATE",
      );
      return null;
    }
    return new Decimal(annualizeQuarterly(r));
  }
  const flows = date.map((_, t) => at(draw, t).sub(at(rep.principal, t)).sub(at(rep.interest_paid, t)).sub(at(fees, t)).toNumber());
  const used = flows.map((x, t) => [x, t] as const).filter(([x]) => x !== 0);
  if (used.length === 0) return null;
  const r = xirr(
    used.map(([x]) => x),
    used.map(([, t]) => date[t] as IsoDate),
  );
  if (r === null) {
    ctx.message("warning", "Полная стоимость кредита не считается: кредит выдан, но не погашен в горизонте расчёта");
    return null;
  }
  // Поток со стороны заёмщика: выдачи «+», платежи «−»; ставка та же, что для банка
  return new Decimal(r);
}

export const FIN_FORMULAS = {
  "F.FIN.EQUITY_REQUIRED": F_FIN_EQUITY_REQUIRED,
  "F.FIN.LIMIT": F_FIN_LIMIT,
  "F.FIN.FEES": F_FIN_FEES,
  "F.FIN.FUNDING_NEED": F_FIN_FUNDING_NEED,
  "F.FIN.EQUITY_IN": F_FIN_EQUITY_IN,
  "F.FIN.DRAW": F_FIN_DRAW,
  "F.FIN.RATE": F_FIN_RATE,
  "F.FIN.INTEREST": F_FIN_INTEREST,
  "F.FIN.REPAYMENT": F_FIN_REPAYMENT,
  "F.FIN.DEBT": F_FIN_DEBT,
  "F.FIN.EFFECTIVE_RATE": F_FIN_EFFECTIVE_RATE,
} as const;
