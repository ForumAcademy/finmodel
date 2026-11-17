/**
 * LAND — земельные платежи (data/formulas.yaml, модуль LAND).
 * Правила, которых нет в спецификации, не додумываются: расчёт останавливается с понятной ошибкой.
 */
import Decimal from "decimal.js";
import type { SpecRegion } from "@fm/spec";
import type { FormulaContext } from "../context";
import { CalcError } from "../context";
import { dayBefore, daysBetween, eomonth, isIsoDate, prevMonthEnd, maxDate, minDate, monthDiff, overlapDays, quarterMonthEnds, type IsoDate } from "../lib/dates";
import { fmt } from "../lib/format";
import type { GfaSplit } from "./tep";
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

export type UpksTable = NonNullable<SpecRegion["cadastral_value_estimate"]>;

/** Средний УПКС квартала по группе, иначе — кадастрового района; null — нет значения. */
export function upksFor(t: UpksTable, quarter: string, group: string): { value: number; where: string } | null {
  const i = t.groups.findIndex((g) => g.key === group);
  if (i < 0) return null;
  const q = t.quarters[quarter];
  const qv = q?.values[i] ?? null;
  if (q && qv !== null) return { value: qv, where: `квартал ${quarter}, стр. ${q.page} приложения` };
  const district = quarter.slice(0, quarter.lastIndexOf(":"));
  const dv = t.districts[district]?.[i] ?? null;
  return dv === null ? null : { value: dv, where: `кадастровый район ${district} (квартала нет в таблице или в нём нет значения)` };
}

/** Оценка кадастровой стоимости: площадь × средний УПКС группы; нет данных — null. */
function cadastralEstimate(ctx: FormulaContext, group: (t: UpksTable) => string | null): { value: Decimal; text: string } | null {
  const t = ctx.param<UpksTable>("LAND.UPKS_TABLE");
  const quarter = ctx.param<string>("GEN.CADASTRAL_QUARTER");
  const area = ctx.num("LAND.AREA");
  if (t === null || quarter === null || area === null) return null;
  const g = group(t);
  if (g === null) return null;
  const u = upksFor(t, quarter, g);
  if (u === null) return null;
  const title = t.groups.find((x) => x.key === g)?.title ?? g;
  return { value: area.mul(u.value), text: `${fmt(area)} м² × ${fmt(new Decimal(u.value))} руб/м² — средний УПКС группы «${title}», ${u.where}, распоряжение ДГИ № 214856 на ${t.valuation_date}` };
}

/** Кадастровая стоимость из проекта или оценка; null — нет ни того, ни другого (её потребует платёж, которому она нужна). */
export function F_LAND_CADASTRAL_VALUE_EST(ctx: FormulaContext): Decimal | null {
  const own = ctx.num("LAND.CADASTRAL_VALUE");
  if (own !== null) return own;
  const codes = ctx.param<string[]>("LAND.VRI_CODES") ?? [];
  const est = cadastralEstimate(ctx, (t) => codes.map((c) => t.vri_groups[c]).find((g): g is string => g !== undefined) ?? null);
  if (est === null) return null;
  ctx.message("warning", `Кадастровая стоимость участка — оценка ${fmt(est.value)} руб: ${est.text}. Введите стоимость из выписки ЕГРН, когда она будет`, "LAND.CADASTRAL_VALUE", "LAND.CADASTRAL_VALUE_EST");
  return est.value;
}

/** Кадастровая стоимость после смены ВРИ из проекта или оценка; null — нет ни того, ни другого. */
export function F_LAND_CADASTRAL_VALUE_AFTER_VRI_EST(ctx: FormulaContext): Decimal | null {
  const own = ctx.num("LAND.CADASTRAL_VALUE_AFTER_VRI");
  if (own !== null) return own;
  const est = cadastralEstimate(ctx, (t) => t.residential_group);
  if (est === null) return null;
  ctx.message("warning", `Кадастровая стоимость после смены ВРИ — оценка ${fmt(est.value)} руб: ${est.text}`, "LAND.CADASTRAL_VALUE_AFTER_VRI", "LAND.CADASTRAL_VALUE_AFTER_VRI_EST");
  return est.value;
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
  const cad = ctx.formula<Decimal | null>("F.LAND.CADASTRAL_VALUE_EST") ?? ctx.requireNum("LAND.CADASTRAL_VALUE");
  const cadAfter = vri === null ? null : (ctx.formula<Decimal | null>("F.LAND.CADASTRAL_VALUE_AFTER_VRI_EST") ?? ctx.requireNum("LAND.CADASTRAL_VALUE_AFTER_VRI"));
  const rate = ctx.requireNum("TAX.LAND_RATE");
  const coef = ctx.formula<Decimal[]>("F.LAND.TAX_COEF");
  const { from, to } = landPeriod(ctx, rows, true);
  return date.map((d, t) => {
    if (d < from || d > to) return ZERO;
    const value = cadAfter !== null && vri !== null && d >= vri ? cadAfter : cad;
    return value.mul(rate).mul(coef[t] as Decimal).div(MONTHS_PER_YEAR);
  });
}

type RentRules = NonNullable<SpecRegion["land_rent"]>;

function landRent(ctx: FormulaContext, rows: MilestoneRow[], date: IsoDate[]): Decimal[] {
  const freq = ctx.require<string>("LAND.RENT_PAYMENT_FREQ");
  const endKey = ctx.require<string>("LAND.RENT_END_MILESTONE");
  if (!isMilestoneKey(endKey)) throw new CalcError(`Неизвестная веха окончания аренды «${endKey}»`, "LAND.RENT_END_MILESTONE");
  const acquired = minDate(rows.map((r) => milestone(r, "land_acquired")));
  const rentEnd = minDate(rows.map((r) => milestone(r, endKey)));
  const firstMonth = eomonth(acquired, 0);
  // Доля месяца с концом d внутри аренды [acquired; rent_end)
  const share = (d: IsoDate): Decimal => {
    const prev = prevMonthEnd(d);
    const days = overlapDays(dayBefore(acquired), dayBefore(rentEnd), prev, d);
    return days === 0 ? ZERO : new Decimal(days).div(daysBetween(prev, d));
  };
  const annual = ctx.num("LAND.RENT_ANNUAL");
  const rules = ctx.param<RentRules>("LAND.RENT_RULES");
  let rentMonth: (d: IsoDate) => Decimal;
  let lump = ZERO;
  if (annual !== null || rules === null) {
    // По договору: годовая сумма с индексацией раз в год с даты приобретения
    const amount = ctx.requireNum("LAND.RENT_ANNUAL");
    const indexation = ctx.requireNum("LAND.RENT_INDEXATION");
    rentMonth = (d) => amount.mul(ONE.add(indexation).pow(fullYears(acquired, d))).div(MONTHS_PER_YEAR).mul(share(d));
  } else {
    // По акту региона (Москва — 273-ПП): ставка по году срока аренды от кадастровой стоимости
    const vri = vriDate(ctx, rows);
    const cad = ctx.formula<Decimal | null>("F.LAND.CADASTRAL_VALUE_EST") ?? ctx.requireNum("LAND.CADASTRAL_VALUE");
    const cadAfter = vri === null ? null : (ctx.formula<Decimal | null>("F.LAND.CADASTRAL_VALUE_AFTER_VRI_EST") ?? ctx.requireNum("LAND.CADASTRAL_VALUE_AFTER_VRI"));
    const cadAt = (d: IsoDate) => (cadAfter !== null && vri !== null && d >= vri ? cadAfter : cad);
    const rnvFirst = minDate(rows.map((r) => milestone(r, "rnv_date")));
    const yearRow = (year: number) => rules.year_rates.find((r) => r.year === year);
    const rateAt = (d: IsoDate): { rate: number; firstYear: boolean } => {
      if (d > rnvFirst) return { rate: rules.after_commissioning_rate, firstYear: false };
      const year = fullYears(acquired, d) + 1;
      if (year > rules.lease_years) return { rate: rules.after_term_rate, firstYear: false };
      const row = yearRow(year);
      if (!row) throw new CalcError(`Нет ставки аренды за ${year}-й год срока аренды в справочнике региона`, "LAND.RENT_RULES");
      return { rate: row.rate, firstYear: row.plus_first_year === true };
    };
    rentMonth = (d) => {
      const part = share(d);
      if (part.isZero()) return ZERO;
      const { rate, firstYear } = rateAt(d);
      return firstYear ? ZERO : cadAt(d).mul(rate).div(MONTHS_PER_YEAR).mul(part);
    };
    const first = rateAt(firstMonth);
    if (first.firstYear) lump = cadAt(firstMonth).mul(first.rate).add(ctx.formula<Decimal>("F.LAND.RENT_FIRST_YEAR"));
  }
  const quarterSum = (d: IsoDate) => quarterMonthEnds(d).reduce((s, m) => s.add(rentMonth(m)), ZERO);
  const isQuarterStart = (d: IsoDate) => quarterMonthEnds(d)[0] === d;
  /** Аренда с месяца d до конца его квартала. */
  const sumFrom = (d: IsoDate) => quarterMonthEnds(d).filter((m) => m >= d).reduce((s, m) => s.add(rentMonth(m)), ZERO);
  let pay: Decimal[];
  // Месяц начала аренды: если аренда начинается внутри квартала, платёж за неполный первый квартал — в этот месяц
  if (freq === "ежемесячно") pay = date.map(rentMonth);
  else if (freq === "поквартально авансом") pay = date.map((d) => (d === firstMonth ? sumFrom(d) : d > firstMonth && isQuarterStart(d) ? quarterSum(d) : ZERO));
  else if (freq === "поквартально по окончании квартала") pay = date.map((d) => (isQuarterStart(eomonth(d, 1)) ? quarterSum(d) : ZERO));
  else throw new CalcError(`Неизвестная периодичность арендной платы «${freq}»`, "LAND.RENT_PAYMENT_FREQ");
  // Первый год по акту региона — разом в месяц начала аренды (273-ПП, п. 3.2.2)
  return lump.isZero() ? pay : pay.map((v, t) => (date[t] === firstMonth ? v.add(lump) : v));
}

export function F_LAND_RENT_FIRST_YEAR(ctx: FormulaContext): Decimal {
  if (ctx.param<string>("LAND.TENURE") !== "аренда" || ctx.num("LAND.RENT_ANNUAL") !== null) return ZERO;
  const rules = ctx.param<RentRules>("LAND.RENT_RULES");
  if (rules === null) return ZERO;
  const quarter = ctx.param<string>("GEN.CADASTRAL_QUARTER");
  if (quarter === null) throw new CalcError("Для арендной платы первого года нужен кадастровый квартал участка — введите кадастровый номер или квартал", "GEN.CADASTRAL_QUARTER");
  const row = rules.first_year.quarters[quarter];
  if (!row) throw new CalcError(`Квартала ${quarter} нет в таблице 273-ПП (приложение 8) — введите арендную плату по договору`, "LAND.RENT_ANNUAL");
  const [pRes, pHotel, k] = row;
  const { k1, k2, divisor } = rules.first_year;
  if (k1 === null) throw new CalcError("Нет коэффициента изменения цен ДГИ (k1) в справочнике региона — введите арендную плату по договору", "LAND.RENT_ANNUAL");
  const split = ctx.formula<GfaSplit>("F.TEP.GFA_SPLIT");
  const price = (p: number | null, area: Decimal, what: string): Decimal => {
    if (area.isZero()) return ZERO;
    if (p === null) throw new CalcError(`В квартале ${quarter} нет стоимостного показателя для «${what}» (273-ПП, приложение 8) — введите арендную плату по договору`, "LAND.RENT_ANNUAL");
    return area.mul(p);
  };
  return price(pRes, split.res, "жильё").add(price(pHotel, split.apart, "временное проживание")).mul(k).mul(k1).mul(k2).div(divisor);
}

export function F_LAND_TAX_OR_RENT(ctx: FormulaContext): Decimal[] {
  const tenure = ctx.require<string>("LAND.TENURE");
  const rows = milestones(ctx);
  const date = ctx.formula<IsoDate[]>("F.TIME.DATE");
  if (tenure === "собственность") return landTax(ctx, rows, date);
  if (tenure === "аренда") return landRent(ctx, rows, date);
  throw new CalcError(`Неизвестная форма права «${tenure}»`, "LAND.TENURE");
}

interface VriFeeRate {
  min_density: number;
  max_density: number | null;
  rate: number;
}

export function F_LAND_VRI_FEE(ctx: FormulaContext): Decimal {
  // Смена ВРИ не нужна — платы нет
  if (ctx.param<boolean>("LAND.VRI_CHANGE") === false) return ZERO;
  const region = ctx.region();
  if (region.vri_fee.exists === false) return ZERO;
  // Плата только за участок в собственности (Москва — 593-ПП); при аренде — арендная плата первого года
  if (region.vri_fee.owned_only === true && ctx.param<string>("LAND.TENURE") === "аренда") return ZERO;
  // Сумма из расчёта ДГИ заменяет расчёт
  const manual = ctx.num("LAND.VRI_FEE");
  if (manual !== null) return manual;
  const rates = ctx.param<VriFeeRate[]>("LAND.VRI_FEE_RATES");
  const after = ctx.num("LAND.CADASTRAL_VALUE_AFTER_VRI");
  const maxGfa = ctx.num("GPZU.MAX_GFA_ABOVE");
  if (rates === null || after === null || maxGfa === null) {
    // Не хватает данных для формулы региона — обязательный ручной ввод с документом (CLAUDE.md, правило 7)
    return ctx.requireNum("LAND.VRI_FEE");
  }
  const density = maxGfa.div(ctx.requireNum("LAND.AREA"));
  const growth = after.sub(ctx.requireNum("LAND.CADASTRAL_VALUE"));
  if (growth.isNegative()) throw new CalcError("Кадастровая стоимость после смены ВРИ меньше текущей — проверьте значение", "LAND.CADASTRAL_VALUE_AFTER_VRI");
  const inside = rates.find((r) => density.gte(r.min_density) && (r.max_density === null || density.lte(r.max_density)));
  if (inside) return growth.mul(inside.rate);
  // Плотность между строками таблицы: верхняя строка (осторожно), сумма по нижней — в предупреждении
  const upper = rates.filter((r) => density.lt(r.min_density)).reduce<VriFeeRate | null>((b, r) => (b === null || r.min_density < b.min_density ? r : b), null);
  const lower = rates.filter((r) => r.max_density !== null && density.gt(r.max_density)).reduce<VriFeeRate | null>((b, r) => (b === null || (r.max_density ?? 0) > (b.max_density ?? 0) ? r : b), null);
  if (upper === null) throw new CalcError(`Нет ставки платы за изменение ВРИ для плотности застройки ${density.toString()} в справочнике региона «${region.name}»`, "LAND.VRI_FEE_RATES");
  const fee = growth.mul(upper.rate);
  ctx.message(
    "warning",
    `Плотность застройки по ГПЗУ ${fmt(density)} — между строками таблицы ставок 593-ПП. В расчёте бо́льшая ставка (от ${fmt(upper.min_density)}): ${fmt(fee.round())} руб.${lower ? ` По меньшей ставке (до ${fmt(lower.max_density ?? 0)}) — ${fmt(growth.mul(lower.rate).round())} руб.` : ""} Уточните у ДГИ`,
    "LAND.VRI_FEE_RATES",
    "LAND.VRI_FEE_DENSITY_GAP",
  );
  return fee;
}

export const LAND_FORMULAS = {
  "F.LAND.CADASTRAL_VALUE_EST": F_LAND_CADASTRAL_VALUE_EST,
  "F.LAND.CADASTRAL_VALUE_AFTER_VRI_EST": F_LAND_CADASTRAL_VALUE_AFTER_VRI_EST,
  "F.LAND.TAX_COEF": F_LAND_TAX_COEF,
  "F.LAND.TAX_OR_RENT": F_LAND_TAX_OR_RENT,
  "F.LAND.RENT_FIRST_YEAR": F_LAND_RENT_FIRST_YEAR,
  "F.LAND.VRI_FEE": F_LAND_VRI_FEE,
} as const;

