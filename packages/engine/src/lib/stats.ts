import Decimal from "decimal.js";

/** Медиана (MEDIAN в Excel): при чётном числе значений — среднее двух средних. */
export function median(xs: readonly Decimal[]): Decimal {
  if (xs.length === 0) throw new Error("Медиана пустого списка");
  const s = [...xs].sort((a, b) => a.comparedTo(b));
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? (s[mid] as Decimal) : (s[mid - 1] as Decimal).add(s[mid] as Decimal).div(2);
}
