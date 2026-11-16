/**
 * Поиск точки, где дорогая функция (полный пересчёт проекта) меняет знак. Каждое вычисление функции — отдельный шаг
 * генератора (yield), чтобы экран не замирал. Сама точка затем находится формулой по записанным пробам
 * (F.VAR.LAND_MAX, F.VAR.SENSITIVITY: линейная интерполяция между соседними пробами разного знака).
 */

/** Наибольшее число проб на один поиск: и на поиск отрезка со сменой знака, и на его сужение. */
const MAX_STEPS = 8;
/** Отрезок считается сошедшимся, когда его длина не больше этой доли от большего по модулю конца. */
const X_TOL = 1e-4;
const HALF = 0.5;

export type Probe = (x: number) => number | null;

const sameSign = (a: number, b: number) => (a < 0) === (b < 0);

/**
 * От точки x0 со значением y0 в сторону x1: сначала ищется отрезок, где значение меняет знак (секущая, при неудаче —
 * шаг удваивается, не дальше limit), затем отрезок сужается методом Иллинойс. Возвращает, найдена ли смена знака.
 */
export function* signChange(f: Probe, x0: number, y0: number, x1: number, limit: number | null = null): Generator<void, boolean> {
  const clamp = (x: number) => (limit === null ? x : x1 > x0 ? Math.min(x, limit) : Math.max(x, limit));
  let a = x0;
  let fa = y0;
  let b = clamp(x1);
  let fb = f(b);
  yield;
  for (let i = 0; fb !== null && sameSign(fa, fb) && i < MAX_STEPS; i++) {
    if (b === limit) return false;
    const step = b - a;
    const secant = fb - fa === 0 ? NaN : b - (fb * (b - a)) / (fb - fa);
    const ahead = Number.isFinite(secant) && (step > 0 ? secant > b : secant < b);
    const next = clamp(ahead ? Math.min(Math.abs(secant - b), Math.abs(step + step)) * Math.sign(step) + b : b + step + step);
    a = b;
    fa = fb;
    b = next;
    fb = f(b);
    yield;
  }
  if (fb === null || sameSign(fa, fb)) return false;
  // Иллинойс: секущая внутри отрезка; если один конец остаётся на месте, его значение уменьшается вдвое
  for (let i = 0; i < MAX_STEPS && Math.abs(b - a) > X_TOL * Math.max(Math.abs(a), Math.abs(b)); i++) {
    const c = b - (fb * (b - a)) / (fb - fa);
    const fc = f(c);
    yield;
    if (fc === null || fc === 0) return true;
    if (!sameSign(fc, fb)) {
      a = b;
      fa = fb;
    } else fa *= HALF;
    b = c;
    fb = fc;
  }
  return true;
}
