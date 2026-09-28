import Decimal from "decimal.js";

const PERCENT = 100;
const RU = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 2 });

/** Число для текста сообщения: «143 560,39». */
export function fmt(value: Decimal | number): string {
  return RU.format(new Decimal(value).toNumber());
}

/** Доля как процент для текста сообщения: 0,012 → «1,2%». */
export function fmtShare(value: Decimal): string {
  return `${RU.format(value.mul(PERCENT).toNumber())}%`;
}

/** Процент из текста справочника: «25%» → 0,25; не процент — null. */
export function parsePercent(text: string): Decimal | null {
  const m = /^\s*(\d+(?:[.,]\d+)?)\s*%\s*$/.exec(text);
  return m ? new Decimal((m[1] as string).replace(",", ".")).div(PERCENT) : null;
}

/** Квартал для текста сообщения: «2033-03-31» → «1 кв 2033». */
export function fmtQuarter(iso: string): string {
  const [y, m] = iso.split("-");
  const monthsInQuarter = 3;
  return `${Math.ceil(Number(m) / monthsInQuarter)} кв ${y}`;
}

const THOUSAND = 1e3;
const MILLION = 1e6;
const BILLION = 1e9;
const SHORT = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 2 });
const SHORT1 = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 1 });

/** Сумма коротко для пояснений: 7 533 738 473 → «7,53 млрд ₽», 60 249 127 → «60,2 млн ₽». */
export function fmtRub(value: Decimal | number): string {
  const x = Math.abs(new Decimal(value).toNumber());
  if (x >= BILLION) return `${SHORT.format(x / BILLION)} млрд ₽`;
  if (x >= MILLION) return `${SHORT1.format(x / MILLION)} млн ₽`;
  if (x >= THOUSAND) return `${SHORT1.format(x / THOUSAND)} тыс. ₽`;
  return `${RU.format(x)} ₽`;
}
