/**
 * Кривая бескупонной доходности ОФЗ Мосбиржи (КБД, источник S_MOEX_ZCYC): адрес загрузки, разбор ответа биржи
 * и подписи для экрана. Безрисковая ставка в точке срока проекта считается формулой F.KPI.RISK_FREE.
 */
import { addDays, isIsoDate, type IsoDate } from "./lib/dates";
import { date as fmtDate } from "./lib/text";

/** Кривая на дату: сроки в годах, доходности — доли годовых. */
export interface ZcycCurve {
  /** Торговый день, на который взята кривая. */
  date: IsoDate;
  points: { term: number; yield: number }[];
  /** Когда загружена, ISO. */
  loadedAt: string;
}

/** Страница кривой на сайте биржи — ссылка в источнике значения. */
export const ZCYC_PAGE = "https://www.moex.com/ru/marketdata/indices/state/g-curve/";

/** Сколько дней назад искать торговый день, если на дату оценки кривой нет (выходные и праздники). */
export const ZCYC_LOOKBACK_DAYS = 10;

/** Адрес данных кривой на дату в информационной системе биржи. */
export function zcycUrl(d: IsoDate): string {
  return `https://iss.moex.com/iss/engines/stock/zcyc.json?date=${d}&iss.meta=off&iss.only=yearyields`;
}

/** Дата кривой: дата оценки, но не позже сегодняшней — кривой на будущую дату нет. */
export function zcycRequestDate(valuation: IsoDate, today: IsoDate): IsoDate {
  return valuation > today ? today : valuation;
}

/** Даты запроса: от даты оценки назад, пока не найдётся торговый день. */
export function zcycTryDates(valuation: IsoDate, today: IsoDate): IsoDate[] {
  const d0 = zcycRequestDate(valuation, today);
  return Array.from({ length: ZCYC_LOOKBACK_DAYS }, (_, i) => addDays(d0, -i));
}

const PERCENT = 100;

interface IssBlock {
  columns?: unknown;
  data?: unknown;
}

/**
 * Разбор ответа биржи: блок с колонками срока (period) и доходности (value, в %). Нет точек — null.
 * Дата кривой — из колонки tradedate, иначе дата запроса.
 */
export function parseZcyc(json: unknown, requested: IsoDate, loadedAt: string): ZcycCurve | null {
  if (!json || typeof json !== "object") return null;
  for (const block of Object.values(json as Record<string, IssBlock>)) {
    if (!block || !Array.isArray(block.columns) || !Array.isArray(block.data)) continue;
    const cols = block.columns.map((c) => String(c).toLowerCase());
    const iTerm = cols.indexOf("period");
    const iYield = cols.indexOf("value");
    const iDate = cols.indexOf("tradedate");
    if (iTerm < 0 || iYield < 0) continue;
    const points: ZcycCurve["points"] = [];
    let date: IsoDate | null = null;
    for (const row of block.data as unknown[]) {
      if (!Array.isArray(row)) continue;
      const term = Number(row[iTerm]);
      const y = Number(row[iYield]);
      if (!Number.isFinite(term) || !Number.isFinite(y) || term <= 0 || row[iYield] === null) continue;
      points.push({ term, yield: y / PERCENT });
      const d = iDate >= 0 ? String(row[iDate]).slice(0, 10) : "";
      if (!date && isIsoDate(d)) date = d;
    }
    if (points.length) return { date: date ?? requested, points: points.sort((a, b) => a.term - b.term), loadedAt };
  }
  return null;
}

/** Подпись кривой: «Кривая доходности ОФЗ Мосбиржи на 18.09.2026». */
export function zcycLabel(c: ZcycCurve | null): string {
  return c ? `Кривая доходности ОФЗ Мосбиржи на ${fmtDate(c.date)}` : "Кривая доходности ОФЗ не загружена";
}
