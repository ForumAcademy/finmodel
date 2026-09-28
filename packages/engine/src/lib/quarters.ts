/**
 * Кварталы листа CF1 исходного Excel для расчёта «как в исходном Excel»: помесячная шкала ядра → периоды CF1.
 * Месяц 0 (дата начала модели) — столбец E листа CF1: отдельный период без потоков. Дальше периоды заканчиваются
 * в последнем месяце календарного квартала (март, июнь, сентябрь, декабрь) или в последнем месяце горизонта.
 */
import Decimal from "decimal.js";
import { monthOf, type IsoDate } from "./dates";

const MONTHS_PER_QUARTER = 3;
export const QUARTERS_PER_YEAR = 4;

/** Дата — последний месяц календарного квартала (март, июнь, сентябрь, декабрь). */
export function isQuarterEnd(date: IsoDate): boolean {
  return monthOf(date) % MONTHS_PER_QUARTER === 0;
}

export class QuarterGrid {
  /** Для месяца t — месяц конца его периода. */
  private readonly endOf: number[];
  /** Для месяца t — месяц конца предыдущего периода (−1 — предыдущего нет). */
  private readonly prevEndOf: number[];

  constructor(dates: readonly IsoDate[]) {
    const n = dates.length;
    const isEnd = dates.map((d, t) => t === 0 || t === n - 1 || Number(d.slice(5, 7)) % MONTHS_PER_QUARTER === 0);
    this.endOf = new Array<number>(n);
    this.prevEndOf = new Array<number>(n);
    let next = n - 1;
    for (let t = n - 1; t >= 0; t--) {
      if (isEnd[t]) next = t;
      this.endOf[t] = next;
    }
    let prev = -1;
    for (let t = 0; t < n; t++) {
      this.prevEndOf[t] = prev;
      if (isEnd[t]) prev = t;
    }
  }

  /** Месяц t — последний месяц своего периода (здесь стоит значение квартала CF1). */
  isEnd(t: number): boolean {
    return this.endOf[t] === t;
  }

  /** Месяц конца предыдущего периода: −1 — нет (столбец E). */
  prevEnd(t: number): number {
    return this.prevEndOf[t] ?? -1;
  }

  /** Первый столбец CF1 (F): период сразу после месяца начала модели. В исходнике у него пустые ячейки столбца E. */
  isFirstColumn(t: number): boolean {
    return this.prevEnd(t) === 0;
  }

  /** Сумма помесячного ряда за период, который заканчивается в месяце t. */
  sum(series: readonly (Decimal | number | null | undefined)[], t: number): Decimal {
    let s = new Decimal(0);
    for (let m = this.prevEnd(t) + 1; m <= t; m++) s = s.add(series[m] ?? 0);
    return s;
  }
}

/** Квартальная ставка → годовая: (1 + r)^4 − 1 (как в исходнике CF1!D128). */
export function annualizeQuarterly(r: number): number {
  return (1 + r) ** QUARTERS_PER_YEAR - 1;
}
