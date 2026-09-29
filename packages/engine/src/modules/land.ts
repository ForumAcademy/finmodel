/**
 * LAND — земельные платежи (data/formulas.yaml, модуль LAND).
 * Правила, которых нет в спецификации, не додумываются: расчёт останавливается с понятной ошибкой.
 */
import Decimal from "decimal.js";
import type { FormulaContext } from "../context";
import { CalcError } from "../context";
import { dayBefore, daysBetween, eomonth, isIsoDate, prevMonthEnd, maxDate, minDate, monthDiff, overlapDays, quarterMonthEnds, type IsoDate } from "../lib/dates";
import { isMilestoneKey, milestone, milestones, vriChangeDate, type MilestoneRow } from "./time";

const ONE = new Decimal(1);
const ZERO = new Decimal(0);
const MONTHS_PER_YEAR = 12;

/**
 * Период владения участком для налога: от приобретения до окончания передачи последней очереди. Окончание передачи
 * не заполнено — до РНВ очереди, с предупреждением (как у налога на прибыль, F.TAX.PROFIT_BASE).
 */
function landPeriod(ctx: FormulaContext, rows: MilestoneRow[], warn = false): { from: IsoDate; to: IsoDate } {
  const missing = rows.filter((r) => !isIsoDate(r.handover_end)).map((r) => r.phase);
  if (warn && missing.length > 0) {
    ctx.message("warning", `Земельный налог посчитан до РНВ очередей ${missing.join(", ")}: не заполнено окончание передачи по актам. Заполните его, чтобы налог шёл до передачи квартир`, "TIME.MILESTONES", "LAND.HANDOVER_END_MISSING");
  }
  return {
    from: minDate(rows.map((r) => milestone(r, "land_acquired"))),
    to: maxDate(rows.map((r) => (isIsoDate(r.handover_end) ? r.handover_end : milestone(r, "rnv_date")))),
  };
}

/** Дата смены ВРИ; обязательна, если задана кадастровая стоимость после смены ВРИ (CHECK.ALL → VRI_DATE_REQUIRED). */
function vriDate(ctx: FormulaContext, rows: MilestoneRow[]): IsoDate | null {
  const date = vriChangeDate(rows);
  if (date === null && ctx.num("LAND.CADASTRAL_VALUE_AFTER_VRI") !== null) {
    throw new CalcError("Задана кадастровая стоимость после смены ВРИ — заполните веху «смена ВРИ» в сроках проекта", "TIME.MILESTONES");
  }
  return date;
}

/** Полных лет от даты a до даты b (по месяцам: годовщина — в том же месяце). */
function fullYears(a: IsoDate, b: IsoDate): number {
  return Math.floor(monthDiff(a, b) / MONTHS_PER_YEAR);
}

export function F_LAND_TAX_COEF(ctx: FormulaContext): Decimal[] {
  const date = ctx.formula<IsoDate[]>("F.TIME.DATE");
  if (ctx.param<boolean>("TAX.LAND_COEF_APPLY") === false) return date.map(() => ONE);
  const upTo = ctx.requireNum("TAX.LAND_COEF_UP_TO_3Y");
  const over = ctx.requireNum("TAX.LAND_COEF_OVER_3Y");
  const thresholdMonths = ctx.requireNum("TIME.RNS_TO_RNV_TAX_YEARS").mul(MONTHS_PER_YEAR);
  const rows = milestones(ctx);
  const { from, to } = landPeriod(ctx, rows);
  const vri = vriChangeDate(rows);
  // Коэффициент действует с приобретения участка до госрегистрации прав на объект (≈ окончание передачи последней очереди);
  // до смены ВРИ не применяется — коэффициенты привязаны к ВРИ «жилищное строительство».
  return date.map((d) => {
    if (d < from || d > to || (vri !== null && d < vri)) return ONE;
    return thresholdMonths.gte(monthDiff(from, d)) ? upTo : over;
  });
}

function landTax(ctx: FormulaContext, rows: MilestoneRow[], date: IsoDate[]): Decimal[] {
  const vri = vriDate(ctx, rows);
  const cad = ctx.requireNum("LAND.CADASTRAL_VALUE");
  const cadAfter = vri === null ? null : ctx.requireNum("LAND.CADASTRAL_VALUE_AFTER_VRI");
  const rate = ctx.requireNum("TAX.LAND_RATE");
  const coef = ctx.formula<Decimal[]>("F.LAND.TAX_COEF");
  const { from, to } = landPeriod(ctx, rows, true);
  return date.map((d, t) => {
    if (d < from || d > to) return ZERO;
    const value = cadAfter !== null && vri !== null && d >= vri ? cadAfter : cad;
    return value.mul(rate).mul(coef[t] as Decimal).div(MONTHS_PER_YEAR);
  });
}

function landRent(ctx: FormulaContext, rows: MilestoneRow[], date: IsoDate[]): Decimal[] {
  const annual = ctx.requireNum("LAND.RENT_ANNUAL");
  const indexation = ctx.requireNum("LAND.RENT_INDEXATION");
  const freq = ctx.require<string>("LAND.RENT_PAYMENT_FREQ");
  const endKey = ctx.require<string>("LAND.RENT_END_MILESTONE");
  if (!isMilestoneKey(endKey)) throw new CalcError(`Неизвестная веха окончания аренды «${endKey}»`, "LAND.RENT_END_MILESTONE");
  const acquired = minDate(rows.map((r) => milestone(r, "land_acquired")));
  const rentEnd = minDate(rows.map((r) => milestone(r, endKey)));
  // rent_month: арендная плата за месяц с концом d — пропорционально дням месяца внутри [acquired; rent_end),
  // индексация раз в год с даты приобретения.
  const rentMonth = (d: IsoDate): Decimal => {
    const prev = prevMonthEnd(d);
    const days = overlapDays(dayBefore(acquired), dayBefore(rentEnd), prev, d);
    if (days === 0) return ZERO;
    return annual.mul(ONE.add(indexation).pow(fullYears(acquired, d))).div(MONTHS_PER_YEAR).mul(days).div(daysBetween(prev, d));
  };
  const quarterSum = (d: IsoDate) => quarterMonthEnds(d).reduce((s, m) => s.add(rentMonth(m)), ZERO);
  const isQuarterStart = (d: IsoDate) => quarterMonthEnds(d)[0] === d;
  // Месяц начала аренды: если аренда начинается внутри квартала, платёж за неполный первый квартал — в этот месяц
  const firstMonth = eomonth(acquired, 0);
  if (freq === "ежемесячно") return date.map(rentMonth);
  if (freq === "поквартально авансом") return date.map((d) => (d === firstMonth ? sumFrom(d) : d > firstMonth && isQuarterStart(d) ? quarterSum(d) : ZERO));
  if (freq === "поквартально по окончании квартала") return date.map((d) => (isQuarterStart(eomonth(d, 1)) ? quarterSum(d) : ZERO));
  throw new CalcError(`Неизвестная периодичность арендной платы «${freq}»`, "LAND.RENT_PAYMENT_FREQ");

  /** Аренда с месяца d до конца его квартала. */
  function sumFrom(d: IsoDate): Decimal {
    return quarterMonthEnds(d).filter((m) => m >= d).reduce((s, m) => s.add(rentMonth(m)), ZERO);
  }
}

export function F_LAND_TAX_OR_RENT(ctx: FormulaContext): Decimal[] {
  const tenure = ctx.require<string>("LAND.TENURE");
  const rows = milestones(ctx);
  const date = ctx.formula<IsoDate[]>("F.TIME.DATE");
  if (tenure === "собственность") return landTax(ctx, rows, date);
  if (tenure === "аренда") return landRent(ctx, rows, date);
  throw new CalcError(`Неизвестная форма права «${tenure}»`, "LAND.TENURE");
}

export function F_LAND_VRI_FEE(ctx: FormulaContext): Decimal {
  // Смена ВРИ не нужна — платы нет
  if (ctx.param<boolean>("LAND.VRI_CHANGE") === false) return ZERO;
  const region = ctx.region();
  if (region.vri_fee.exists === false) return ZERO;
  // Формула региона (например, Москва — 593-ПП) в спецификацию не выписана: обязательный ручной ввод с документом (CLAUDE.md, правило 7).
  const fee = ctx.requireNum("LAND.VRI_FEE");
  ctx.message("info", `Плата за изменение ВРИ введена вручную по документу: формула региона «${region.name}» ещё не выписана в справочник`, "LAND.VRI_FEE");
  return fee;
}

export const LAND_FORMULAS = {
  "F.LAND.TAX_COEF": F_LAND_TAX_COEF,
  "F.LAND.TAX_OR_RENT": F_LAND_TAX_OR_RENT,
  "F.LAND.VRI_FEE": F_LAND_VRI_FEE,
} as const;

