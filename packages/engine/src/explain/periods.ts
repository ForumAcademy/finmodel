/**
 * Отчёты по периодам: помесячный ряд расчёта → месяц, квартал или год. Раньше считалось в интерфейсе старого
 * сервиса (lib/model.ts); перенесено в ядро.
 */
export type Period = "quarter" | "year" | "month";
export const PERIOD_LABEL: Record<Period, string> = { quarter: "Квартал", year: "Год", month: "Месяц" };

const MONTHS_PER_QUARTER = 3;
const YEAR = [0, 4] as const;
const MONTH = [5, 7] as const;

/** Ключ периода для даты конца месяца: «02.2026», «1 кв 2026», «2026». */
export function periodKey(date: string, period: Period): string {
  const y = date.slice(...YEAR);
  const m = date.slice(...MONTH);
  if (period === "month") return `${m}.${y}`;
  if (period === "year") return y;
  return `${Math.floor((Number(m) - 1) / MONTHS_PER_QUARTER) + 1} кв ${y}`;
}

/**
 * Помесячный ряд по периодам: потоки суммируются (mode = "sum"); остатки и цены берутся на конец периода
 * (mode = "last").
 */
export function aggregate(values: number[], dates: string[], period: Period, mode: "sum" | "last" = "sum"): { keys: string[]; sums: number[] } {
  const keys: string[] = [];
  const sums: number[] = [];
  dates.forEach((d, t) => {
    const k = periodKey(d, period);
    if (keys.at(-1) !== k) {
      keys.push(k);
      sums.push(0);
    }
    sums[sums.length - 1] = mode === "last" ? (values[t] ?? 0) : (sums.at(-1) ?? 0) + (values[t] ?? 0);
  });
  return { keys, sums };
}
