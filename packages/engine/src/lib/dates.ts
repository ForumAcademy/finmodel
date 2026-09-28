/**
 * Даты модели — строки ISO «ГГГГ-ММ-ДД» (docs/00: «даты — только даты»). Вся арифметика — в UTC,
 * чтобы результат не зависел от часового пояса сервера.
 */
export type IsoDate = string;

const ISO = /^(\d{4})-(\d{2})-(\d{2})$/;
const MS_PER_DAY = 86_400_000;
const MONTHS_PER_YEAR = 12;

function parts(date: IsoDate): [number, number, number] {
  const m = ISO.exec(date);
  if (!m) throw new Error(`Некорректная дата «${date}»: нужен формат ГГГГ-ММ-ДД`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

function fromUtc(ms: number): IsoDate {
  return new Date(ms).toISOString().slice(0, 10);
}

export function isIsoDate(value: unknown): value is IsoDate {
  return typeof value === "string" && ISO.test(value);
}

/** EOMONTH Excel: последний день месяца, отстоящего от date на months месяцев. */
export function eomonth(date: IsoDate, months: number): IsoDate {
  const [y, m] = parts(date);
  return fromUtc(Date.UTC(y, m - 1 + months + 1, 0));
}

/** EDATE Excel: та же дата через months месяцев (с поправкой на длину месяца). */
export function edate(date: IsoDate, months: number): IsoDate {
  const [y, m, d] = parts(date);
  const last = Number(eomonth(fromUtc(Date.UTC(y, m - 1 + months, 1)), 0).slice(8, 10));
  return fromUtc(Date.UTC(y, m - 1 + months, Math.min(d, last)));
}

/** Число дней между датами (b − a). */
export function daysBetween(a: IsoDate, b: IsoDate): number {
  const [ya, ma, da] = parts(a);
  const [yb, mb, db] = parts(b);
  return Math.round((Date.UTC(yb, mb - 1, db) - Date.UTC(ya, ma - 1, da)) / MS_PER_DAY);
}

/** Номер дня в месяце. */
export function dayOfMonth(date: IsoDate): number {
  return parts(date)[2];
}

/** Разница в календарных месяцах между месяцами дат (b − a), без учёта дней. */
export function monthDiff(a: IsoDate, b: IsoDate): number {
  const [ya, ma] = parts(a);
  const [yb, mb] = parts(b);
  return (yb - ya) * MONTHS_PER_YEAR + (mb - ma);
}

export function minDate(dates: IsoDate[]): IsoDate {
  return dates.reduce((a, b) => (b < a ? b : a));
}

export function maxDate(dates: IsoDate[]): IsoDate {
  return dates.reduce((a, b) => (b > a ? b : a));
}

/** Дата через days дней. */
export function addDays(date: IsoDate, days: number): IsoDate {
  const [y, m, d] = parts(date);
  return fromUtc(Date.UTC(y, m - 1, d + days));
}

/** Год даты. */
export function yearOf(date: IsoDate): number {
  return parts(date)[0];
}

/** Номер месяца даты (1–12). */
export function monthOf(date: IsoDate): number {
  return parts(date)[1];
}

/** Предыдущий день. */
export function dayBefore(date: IsoDate): IsoDate {
  return addDays(date, -1);
}

/** Последний день месяца перед месяцем даты. */
export function prevMonthEnd(date: IsoDate): IsoDate {
  return eomonth(date, -1);
}

/** Последний день года. */
export function yearEnd(year: number): IsoDate {
  return fromUtc(Date.UTC(year, MONTHS_PER_YEAR, 0));
}

/** Число дней пересечения полуинтервалов (a; b] и (c; d] — даты-границы, как у daysBetween. */
export function overlapDays(a: IsoDate, b: IsoDate, c: IsoDate, d: IsoDate): number {
  const from = a > c ? a : c;
  const to = b < d ? b : d;
  return to > from ? daysBetween(from, to) : 0;
}

const MONTHS_PER_QUARTER = 3;

/** Концы трёх месяцев календарного квартала, в который попадает дата. */
export function quarterMonthEnds(date: IsoDate): IsoDate[] {
  const m = parts(date)[1] - 1;
  const first = m - (m % MONTHS_PER_QUARTER);
  return Array.from({ length: MONTHS_PER_QUARTER }, (_, i) => eomonth(date, first - m + i));
}
