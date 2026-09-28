/**
 * ESCROW — счета эскроу по очередям (data/formulas.yaml, модуль ESCROW; 214-ФЗ, ст. 15.4–15.5).
 * Ряды по очередям — в порядке номера очереди в TIME.MILESTONES (как флаги F.TIME.*).
 */
import Decimal from "decimal.js";
import type { FormulaContext } from "../context";
import { stepwise } from "../context";
import { quarterGrid, type Debt } from "./fin";
import { milestones } from "./time";
import { products, type CashIn } from "./sales";

const ZERO = new Decimal(0);
const ONE = new Decimal(1);

export function F_ESC_DEPOSIT(ctx: FormulaContext): Decimal[][] {
  const cash = ctx.formula<CashIn>("F.SALES.CASH_IN");
  const phases = milestones(ctx);
  const list = products(ctx);
  const months = Object.values(cash.ddu)[0]?.length ?? 0;
  return phases.map((_, i) => {
    const out = Array.from({ length: months }, () => ZERO);
    for (const p of list) {
      if (p.phaseIndex !== i) continue;
      (cash.ddu[p.key] ?? []).forEach((x, t) => (out[t] = (out[t] as Decimal).add(x)));
    }
    return out;
  });
}

/** Остаток и раскрытие эскроу по очередям. */
export interface EscrowBalance {
  balance: Decimal[][];
  release: Decimal[][];
}

export function F_ESC_BALANCE(ctx: FormulaContext): EscrowBalance {
  const deposit = ctx.formula<Decimal[][]>("F.ESC.DEPOSIT");
  const flag = ctx.formula<number[][]>("F.TIME.FLAG_ESCROW_RELEASE");
  const balance: Decimal[][] = [];
  const release: Decimal[][] = [];
  deposit.forEach((dep, p) => {
    const f = flag[p] ?? [];
    let bal = ZERO;
    let released = false;
    const b: Decimal[] = [];
    const r: Decimal[] = [];
    dep.forEach((x, t) => {
      // В месяц раскрытия передаётся весь остаток; поступления после раскрытия передаются в том же месяце
      const out = f[t] === 1 ? bal.add(x) : released ? x : ZERO;
      if (f[t] === 1) released = true;
      bal = bal.add(x).sub(out);
      b.push(bal);
      r.push(out);
    });
    balance.push(b);
    release.push(r);
  });
  return { balance, release };
}

/**
 * Покрытие долга остатками эскроу. Считается помесячно вместе с модулем FIN: читает долг того же месяца, а ставка
 * (F.FIN.RATE) берёт покрытие за прошлый месяц. Нет долга — покрытия нет (null).
 */
export const F_ESC_COVERAGE = stepwise(function F_ESC_COVERAGE(ctx: FormulaContext, t: number): Decimal | null {
  const esc = ctx.formula<EscrowBalance>("F.ESC.BALANCE");
  const debt = ctx.formula<Debt>("F.FIN.DEBT");
  const draw = ctx.formula<Decimal[]>("F.FIN.DRAW");
  const kept = ONE.sub(ctx.num("FIN.ESCROW_RESERVE_RATE") ?? ZERO);
  const balance = (m: number) => (m < 0 ? ZERO : esc.balance.reduce((s, b) => s.add(b[m] ?? ZERO), ZERO));
  const at = (xs: Decimal[] | undefined, m: number) => (m < 0 ? ZERO : (xs?.[m] ?? ZERO));
  const avg = (a: Decimal, b: Decimal) => a.add(b).div(ONE.add(ONE));
  if (ctx.mode === "legacy") {
    // CF1!F120:F122 поквартально, знаки как в CF1 (долг и проценты там отрицательные); в первом квартале ячейки
    // столбца E пустые — среднее берётся по одному значению
    const g = quarterGrid(ctx);
    const p = g.prevEnd(t);
    if (!g.isEnd(t) || p < 0) return null;
    const first = g.isFirstColumn(t);
    const escAvg = (first ? balance(t) : avg(balance(p), balance(t))).mul(kept);
    const debtAvg = first ? at(debt.debt, t) : avg(at(debt.debt, p), at(debt.debt, t));
    const den = debtAvg.add(at(debt.accrued, t)).neg();
    return den.isZero() ? null : escAvg.div(den);
  }
  const escAvg = avg(balance(t - 1), balance(t)).mul(kept);
  const den = at(debt.debt, t - 1).add(at(draw, t).div(ONE.add(ONE))).add(at(debt.accrued, t - 1));
  return den.lte(ZERO) ? null : escAvg.div(den);
});

export const ESCROW_FORMULAS = {
  "F.ESC.DEPOSIT": F_ESC_DEPOSIT,
  "F.ESC.BALANCE": F_ESC_BALANCE,
  "F.ESC.COVERAGE": F_ESC_COVERAGE,
} as const;
