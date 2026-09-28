/**
 * Внутренняя норма доходности: по периодам (IRR) и по датам (XIRR, база 365 дней — как в Excel).
 * null — нет платежей разного знака или решение не найдено (в Excel — #NUM!).
 */
import { daysBetween, type IsoDate } from "./dates";

const DAYS_IN_YEAR = 365;
const TOL = 1e-10;
const MAX_ITER = 200;
const LOW = -0.9;
const HIGH = 100;

function hasBothSigns(flows: readonly number[]): boolean {
  return flows.some((x) => x > 0) && flows.some((x) => x < 0);
}

/** Корень монотонной на [LOW, HIGH] функции NPV(r) делением пополам. */
function solve(npv: (r: number) => number): number | null {
  let lo = LOW;
  let hi = HIGH;
  let flo = npv(lo);
  const fhi = npv(hi);
  if (!Number.isFinite(flo) || !Number.isFinite(fhi) || flo * fhi > 0) return null;
  for (let i = 0; i < MAX_ITER; i++) {
    const mid = (lo + hi) / 2;
    const f = npv(mid);
    if (Math.abs(f) < TOL || hi - lo < TOL) return mid;
    if (f * flo > 0) {
      lo = mid;
      flo = f;
    } else hi = mid;
  }
  return (lo + hi) / 2;
}

export function irr(flows: readonly number[]): number | null {
  if (!hasBothSigns(flows)) return null;
  return solve((r) => flows.reduce((s, x, i) => s + x / (1 + r) ** i, 0));
}

export function xirr(flows: readonly number[], dates: readonly IsoDate[]): number | null {
  if (!hasBothSigns(flows) || flows.length !== dates.length) return null;
  const d0 = dates[0] as IsoDate;
  const years = dates.map((d) => daysBetween(d0, d) / DAYS_IN_YEAR);
  return solve((r) => flows.reduce((s, x, i) => s + x / (1 + r) ** (years[i] as number), 0));
}
