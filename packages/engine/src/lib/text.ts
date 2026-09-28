/**
 * Числа, даты и единицы для текстов пояснений ядра (панели «Как посчитано», «Продано в месяце»).
 * Только форматирование, без расчёта.
 */
import Decimal from "decimal.js";

/** Число по-русски: пробел в тысячах, запятая в дробях, не больше digits знаков после запятой. */
export function num(value: unknown, digits = 2): string {
  const f = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: digits });
  if (value instanceof Decimal) return f.format(value.toNumber());
  if (typeof value === "number") return f.format(value);
  return String(value);
}

/** «2025-12-31» → «31.12.2025». */
export function date(iso: string | null | undefined): string {
  if (!iso) return "—";
  const [y, m, d] = iso.split("-");
  return `${d}.${m}.${y}`;
}

const UNIT_LABEL: Record<string, string> = { м2: "м²", "руб/м2": "руб/м²", "%годовых": "% год.", "доля/год": "доля в год" };

/** Единица из справочника для текста: «м2» → «м²». */
export function unit(u: string): string {
  return UNIT_LABEL[u] ?? u;
}

/** Склонение: plural(1, ["параметр", "параметра", "параметров"]). */
export function plural(n: number, forms: [string, string, string]): string {
  const a = Math.abs(n) % 100;
  const b = a % 10;
  if (a > 10 && a < 20) return forms[2];
  if (b === 1) return forms[0];
  if (b > 1 && b < 5) return forms[1];
  return forms[2];
}

const MONTHS = ["январь", "февраль", "март", "апрель", "май", "июнь", "июль", "август", "сентябрь", "октябрь", "ноябрь", "декабрь"];
const MONTHS_GEN = ["января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа", "сентября", "октября", "ноября", "декабря"];
const MONTHS_DAT = ["январю", "февралю", "марту", "апрелю", "маю", "июню", "июлю", "августу", "сентябрю", "октябрю", "ноябрю", "декабрю"];
const MONTHS_PREP = ["январе", "феврале", "марте", "апреле", "мае", "июне", "июле", "августе", "сентябре", "октябре", "ноябре", "декабре"];

/** «2026-03-31» → «март 2026»; падеж: «с марта 2026» (gen), «в марте 2026» (prep), «к марту 2026» (dat). */
export function monthName(iso: string | undefined, form: "nom" | "gen" | "prep" | "dat" = "nom"): string {
  if (!iso) return "—";
  const [y, m] = iso.split("-");
  const names = form === "gen" ? MONTHS_GEN : form === "prep" ? MONTHS_PREP : form === "dat" ? MONTHS_DAT : MONTHS;
  return `${names[Number(m) - 1]} ${y}`;
}
