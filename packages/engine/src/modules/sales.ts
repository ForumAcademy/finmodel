/**
 * SALES — план продаж (data/formulas.yaml, модуль SALES).
 * Темп (F.SALES.SOLD_AREA) × цена (F.SALES.PRICE) = договоры (F.SALES.CONTRACT_VALUE) → поступления по структуре
 * оплат (F.SALES.CASH_IN) → итоги (F.SALES.REVENUE_TOTAL, F.SALES.WAVG_PRICE, F.SALES.END_PRICE).
 *
 * Строка продукта k — строка SALES.PRODUCTS; её ключ — название (name), а если его нет — продукт.
 * Ряды по строкам — объект {название строки: значения по месяцам}.
 */
import Decimal from "decimal.js";
import type { FormulaContext } from "../context";
import { CalcError, DependencyError } from "../context";
import { isIsoDate, monthDiff, yearOf, type IsoDate } from "../lib/dates";
import { fmt, fmtQuarter, parsePercent } from "../lib/format";
import { growth } from "./capex";
import { milestone, milestones, type MilestoneRow } from "./time";

const ZERO = new Decimal(0);
const ONE = new Decimal(1);
const MONTHS_PER_YEAR = 12;

/** Ряд по строкам продуктов: название строки → значения по месяцам. */
export type RowSeries = Record<string, Decimal[]>;

/** Продукты, которые продаются штуками (машино-места, кладовые); остальные — квадратными метрами. */
const PIECE_PRODUCTS = new Set(["машино-места", "кладовые"]);
export const CHANNEL_DDU = "ДДУ_эскроу";

/** Строка SALES.PRODUCTS (столбцы — parameters.yaml). */
interface ProductRow {
  name?: string | null;
  product: string;
  phase: number;
  stock_area?: number | null;
  stock_units?: number | null;
  start_price?: number | null;
  price_date?: IsoDate | null;
  sale_channel_before_rnv?: string | null;
}

/** Продукт с ключом строки и индексом очереди в TIME.MILESTONES. */
export interface Product {
  key: string;
  row: ProductRow;
  pieces: boolean;
  /** Индекс очереди в вехах (порядок номера очереди) — индекс в рядах флагов F.TIME.*. */
  phaseIndex: number;
  milestone: MilestoneRow;
}

interface ManualPace {
  from: IsoDate;
  step_months: number;
  values: number[];
}

const PACE_METHODS: string[] = ["доля_остатка", "в_месяц", "ручной"];

/** Строка SALES.PACE. */
interface PaceRow {
  name: string;
  method: "доля_остатка" | "в_месяц" | "ручной";
  value?: number | null;
  manual?: ManualPace | null;
}

/** Строка SALES.PAYMENT_MIX. */
interface MixRow {
  product: string;
  mortgage_share: number;
  mortgage_down_payment?: number | null;
  full_payment_share: number;
  installment_share: number;
  installment_months?: number | null;
  installment_down_payment?: number | null;
}

/** Строки продуктов с проверкой названий и очередей. */
export function products(ctx: FormulaContext): Product[] {
  const rows = ctx.require<ProductRow[]>("SALES.PRODUCTS");
  if (!Array.isArray(rows) || rows.length === 0) throw new CalcError("Заполните продукты: хотя бы одну строку", "SALES.PRODUCTS");
  const phases = milestones(ctx);
  const seen = new Set<string>();
  return rows.map((row) => {
    const key = (row.name ?? "").trim() || row.product;
    if (!key) throw new CalcError("У строки продукта нет ни названия, ни продукта", "SALES.PRODUCTS");
    if (seen.has(key)) throw new CalcError(`Строка «${key}» повторяется: у строк одного продукта нужны разные названия`, "SALES.PRODUCTS");
    seen.add(key);
    const phaseIndex = phases.findIndex((m) => m.phase === row.phase);
    if (phaseIndex < 0) throw new CalcError(`«${key}»: очереди ${row.phase} нет в вехах`, "SALES.PRODUCTS");
    return { key, row, pieces: PIECE_PRODUCTS.has(row.product), phaseIndex, milestone: phases[phaseIndex] as MilestoneRow };
  });
}

function unitName(p: Product): string {
  return p.pieces ? "шт" : "м²";
}

/** Индекс месяца модели для даты (месяц, в который она попадает). */
function monthIndex(date: IsoDate[], d: IsoDate): number {
  return monthDiff(date[0] as IsoDate, d);
}

/** Ручной ряд темпа → продажи по месяцам: объём периода поровну между его месяцами. */
function manualPace(p: Product, m: ManualPace | null | undefined, date: IsoDate[]): Decimal[] {
  if (!m || !isIsoDate(m.from) || !Number.isInteger(m.step_months) || m.step_months < 1 || !Array.isArray(m.values)) {
    throw new CalcError(`«${p.key}»: ручной темп — нужны from (дата), step_months (целое ≥ 1) и values (продажи за период)`, "SALES.PACE");
  }
  const out = date.map(() => ZERO);
  const firstEnd = monthIndex(date, m.from);
  let lost = ZERO;
  m.values.forEach((v, k) => {
    const part = new Decimal(v).div(m.step_months);
    const end = firstEnd + k * m.step_months;
    for (let t = end - m.step_months + 1; t <= end; t++) {
      if (t >= 0 && t < out.length) out[t] = (out[t] as Decimal).add(part);
      else lost = lost.add(part);
    }
  });
  if (!lost.isZero()) throw new CalcError(`«${p.key}»: ручной темп выходит за срок расчёта на ${fmt(lost)} ${unitName(p)}`, "SALES.PACE");
  return out;
}

function stockOf(p: Product): Decimal | null {
  const v = p.pieces ? p.row.stock_units : p.row.stock_area;
  return typeof v === "number" ? new Decimal(v) : null;
}

export function F_SALES_SOLD_AREA(ctx: FormulaContext): RowSeries {
  const date = ctx.formula<IsoDate[]>("F.TIME.DATE");
  const list = products(ctx);
  const pace = ctx.require<PaceRow[]>("SALES.PACE");
  if (!Array.isArray(pace)) throw new CalcError("Темп продаж: нужен список строк", "SALES.PACE");
  const legacy = ctx.mode === "legacy";
  // Допуск на погрешность округления: ручной ряд делится поровну по месяцам периода
  const tol = ctx.requireNum("CAPEX.SCHEDULE_SUM_TOLERANCE");
  const presale = legacy ? null : ctx.formula<number[][]>("F.TIME.FLAG_PRESALE");
  const postRnv = legacy ? null : ctx.formula<number[][]>("F.TIME.FLAG_POST_RNV");
  const out: RowSeries = {};
  for (const p of list) {
    const rowPace = pace.find((r) => r.name === p.key);
    if (!rowPace) throw new CalcError(`Заполните темп продаж для «${p.key}»`, "SALES.PACE");
    const stock = stockOf(p);
    // Расчёт «как в исходном Excel»: ряд исходника как есть (Excel не ограничивает продажи запасом и периодом)
    if (legacy) {
      if (rowPace.method !== "ручной") throw new CalcError(`«${p.key}»: в расчёте «как в исходном Excel» темп — ручной ряд исходника`, "SALES.PACE");
      const sold = manualPace(p, rowPace.manual, date);
      const total = sold.reduce((s, x) => s.add(x), ZERO);
      if (stock !== null && total.gt(stock.mul(ONE.add(tol)))) {
        const u = unitName(p);
        ctx.message("warning", `По плану продаж ${p.key} получается ${fmt(total.trunc())} ${u}, а построено ${fmt(stock)} ${u}. В расчёте «как в исходном Excel» лишние ${fmt(total.trunc().sub(stock))} ${u} остаются в расчёте, как в Excel; в расчёте сервиса они в расчёт не попадают. Уменьшите темп или проверьте площадь ${p.key} в ТЭПах.`, "SALES.PACE", `SALES.OVER_STOCK:${p.key}`);
      }
      out[p.key] = sold;
      continue;
    }
    if (stock === null) throw new CalcError(`«${p.key}»: заполните, сколько построено к продаже (${p.pieces ? "шт" : "м²"})`, "SALES.PRODUCTS");
    if (!PACE_METHODS.includes(rowPace.method)) throw new CalcError(`«${p.key}»: неизвестный способ темпа «${rowPace.method}»`, "SALES.PACE");
    const manual = rowPace.method === "ручной" ? manualPace(p, rowPace.manual, date) : null;
    const value = rowPace.value;
    if (rowPace.method !== "ручной" && (typeof value !== "number" || value < 0)) throw new CalcError(`«${p.key}»: заполните темп — неотрицательное число`, "SALES.PACE");
    if (rowPace.method === "доля_остатка" && (value as number) > 1) throw new CalcError(`«${p.key}»: доля остатка в месяц — не больше 1`, "SALES.PACE");
    const ddu = (p.row.sale_channel_before_rnv ?? CHANNEL_DDU) === CHANNEL_DDU;
    let remaining = stock;
    // сколько из ручного плана не продано: сверх построенного и в месяцы, когда продавать нельзя
    let overStock = ZERO;
    let offPeriod = ZERO;
    // ручной план до первого разрешённого месяца переносится на него (квартал старта продаж — целиком)
    let carry = ZERO;
    let started = false;
    const sold = date.map((_, t) => {
      const allowed = (ddu && presale?.[p.phaseIndex]?.[t] === 1) || postRnv?.[p.phaseIndex]?.[t] === 1;
      let want = manual ? (manual[t] as Decimal) : rowPace.method === "доля_остатка" ? remaining.mul(value as number) : new Decimal(value as number);
      if (!allowed) {
        if (manual && !started) carry = carry.add(want);
        else offPeriod = offPeriod.add(manual ? want : ZERO);
        return ZERO;
      }
      if (!started) {
        started = true;
        want = want.add(carry);
      }
      const s = Decimal.min(want, remaining);
      if (manual) overStock = overStock.add(want.sub(s));
      remaining = remaining.sub(s);
      return s;
    });
    const u = unitName(p);
    if (manual && overStock.gt(stock.mul(tol))) {
      const plan = manual.reduce((a, x) => a.add(x), ZERO).sub(offPeriod).trunc();
      ctx.message("warning", `По плану продаж ${p.key} получается ${fmt(plan)} ${u}, а построено ${fmt(stock)} ${u}. Лишние ${fmt(plan.sub(stock))} ${u} в расчёт не попали. Уменьшите темп или проверьте площадь ${p.key} в ТЭПах.`, "SALES.PACE", `SALES.OVER_STOCK:${p.key}`);
    }
    const left = remaining.gt(stock.mul(tol)) ? remaining.toDecimalPlaces(0) : null;
    if (manual && offPeriod.gt(stock.mul(tol))) {
      const cutText = `по плану продаж ${fmt(offPeriod.toDecimalPlaces(0))} ${u} приходится на месяцы, когда продавать нельзя, и в расчёт не попали`;
      ctx.message("warning", left ? `«${p.key}»: не продано к концу расчёта ${fmt(left)} ${u} — ${cutText}. Сдвиньте план продаж или проверьте даты старта продаж и ввода дома.` : `«${p.key}»: ${cutText}. Сдвиньте план продаж или проверьте даты старта продаж и ввода дома.`, "SALES.PACE");
    } else if (left) ctx.message("warning", `«${p.key}»: не продано к концу расчёта ${fmt(left)} ${u}. Увеличьте темп или горизонт расчёта.`, "SALES.PACE");
    out[p.key] = sold;
  }
  return out;
}

/** Строка SALES.PRICE_STAGE_UPLIFT. */
interface UpliftRow {
  stage: string;
  uplift: number;
}

const STAGE_START = "старт продаж";
const STAGE_PIT = "котлован";
const STAGE_RNV = "РНВ";

/** Условие «стадия пройдена к месяцу t» по готовности и дате РНВ очереди. */
function stageTest(stage: string): ((progress: Decimal, afterRnv: boolean) => boolean) | null {
  if (stage === STAGE_START) return null;
  if (stage === STAGE_PIT) return (x) => x.gt(0);
  if (stage === STAGE_RNV) return (_, rnv) => rnv;
  const share = parsePercent(stage);
  if (share === null) throw new CalcError(`неизвестная стадия «${stage}»`, "SALES.PRICE_STAGE_UPLIFT");
  return (x) => x.gte(share);
}

/** Расчёт «как в исходном Excel»: рост цены ступенькой (SALES.LEGACY_PRICE_GROWTH). */
interface LegacyGrowth {
  rate: number;
  step_months: number;
}

/** Ключ отметки «рост по стадиям не учтён». */
export const STAGE_UPLIFT_NOT_COUNTED = "SALES.STAGE_UPLIFT_NOT_COUNTED";

export function F_SALES_PRICE(ctx: FormulaContext): RowSeries {
  const date = ctx.formula<IsoDate[]>("F.TIME.DATE");
  const list = products(ctx);
  const start = ctx.require<IsoDate>("GEN.MODEL_START_DATE");
  const out: RowSeries = {};
  const startPrice = (p: Product) => {
    const v = p.row.start_price;
    if (typeof v !== "number" || v <= 0) throw new CalcError(`«${p.key}»: заполните стартовую цену`, "SALES.PRODUCTS");
    return new Decimal(v);
  };
  const priceDate = (p: Product) => {
    const d = p.row.price_date ?? start;
    if (!isIsoDate(d)) throw new CalcError(`«${p.key}»: дата цены должна быть датой (ГГГГ-ММ-ДД)`, "SALES.PRODUCTS");
    return d;
  };

  if (ctx.mode === "legacy") {
    // Таблица из одной строки; допускается и сама строка
    const raw = ctx.require<LegacyGrowth | LegacyGrowth[]>("SALES.LEGACY_PRICE_GROWTH");
    const g = Array.isArray(raw) ? raw[0] : raw;
    if (!g || typeof g.rate !== "number" || !Number.isInteger(g.step_months) || g.step_months < 1) {
      throw new CalcError("Рост цены исходника: нужны рост за период (доля) и длина периода в месяцах (целое ≥ 1)", "SALES.LEGACY_PRICE_GROWTH");
    }
    const k = ONE.add(g.rate);
    for (const p of list) {
      const base = startPrice(p);
      const pd = priceDate(p);
      out[p.key] = date.map((d) => base.mul(k.pow(Math.max(0, Math.floor((monthDiff(pd, d) - 1) / g.step_months)))));
    }
    return out;
  }

  const market = growth(ctx, "SALES.PRICE_MARKET_GROWTH");
  const gMonth = new Map<number, Decimal>();
  const monthly = (y: number) => {
    if (!gMonth.has(y)) gMonth.set(y, ONE.add(market(y)).pow(ONE.div(MONTHS_PER_YEAR)));
    return gMonth.get(y) as Decimal;
  };
  // Пустая надбавка — «не учтено»: цена растёт только по рынку, в сообщениях отметка (решение владельца продукта 28.09.2026)
  const uplift = ctx.param<UpliftRow[]>("SALES.PRICE_STAGE_UPLIFT") ?? [];
  if (ctx.param("SALES.PRICE_STAGE_UPLIFT") === null) {
    ctx.message("warning", "Рост цены по стадиям готовности не учтён: надбавка не заполнена, цена растёт только по рынку. Заполните надбавку по стадиям.", "SALES.PRICE_STAGE_UPLIFT", STAGE_UPLIFT_NOT_COUNTED);
  }
  if (!Array.isArray(uplift)) throw new CalcError("Рост цены по стадиям: нужен список строк", "SALES.PRICE_STAGE_UPLIFT");
  const stages = uplift
    .map((r) => ({ test: stageTest(r.stage), k: ONE.add(r.uplift ?? 0) }))
    .filter((s): s is { test: (x: Decimal, rnv: boolean) => boolean; k: Decimal } => s.test !== null && !s.k.eq(1));
  const needsProgress = uplift.some((r) => r.stage !== STAGE_START && r.stage !== STAGE_RNV && (r.uplift ?? 0) !== 0);
  const progress = needsProgress ? ctx.formula<Decimal[]>("F.CAPEX.SMR_PROGRESS") : null;

  for (const p of list) {
    const base = startPrice(p);
    const pd = priceDate(p);
    const rnv = stages.length > 0 ? milestone(p.milestone, "rnv_date") : null;
    let market_k = ONE;
    out[p.key] = date.map((d, t) => {
      if (d > pd) market_k = market_k.mul(monthly(yearOf(d)));
      const x = progress ? (progress[t] as Decimal) : ZERO;
      const stage_k = stages.reduce((k, s) => (s.test(x, rnv !== null && d >= rnv) ? k.mul(s.k) : k), ONE);
      return base.mul(market_k).mul(stage_k);
    });
  }
  return out;
}

export function F_SALES_CONTRACT_VALUE(ctx: FormulaContext): RowSeries {
  const sold = ctx.formula<RowSeries>("F.SALES.SOLD_AREA");
  const price = ctx.formula<RowSeries>("F.SALES.PRICE");
  const out: RowSeries = {};
  for (const [key, s] of Object.entries(sold)) {
    const pr = price[key] as Decimal[];
    out[key] = s.map((x, t) => x.mul(pr[t] as Decimal));
  }
  return out;
}

/** Поступления по строкам: всего и по договорам ДДУ (до РНВ очереди — на эскроу). */
export interface CashIn {
  total: RowSeries;
  ddu: RowSeries;
}

function mixFor(rows: MixRow[], p: Product): { now: Decimal; down: Decimal; rest: Decimal; n: number } {
  const m = rows.find((r) => r.product === p.row.product);
  if (!m) throw new CalcError(`Заполните структуру оплат для продукта «${p.row.product}»`, "SALES.PAYMENT_MIX");
  const shares = [m.mortgage_share, m.full_payment_share, m.installment_share];
  if (shares.some((x) => typeof x !== "number" || x < 0)) throw new CalcError(`«${p.row.product}»: доли оплат — неотрицательные числа`, "SALES.PAYMENT_MIX");
  const own = m.mortgage_down_payment;
  if (own !== undefined && own !== null && (typeof own !== "number" || own < 0 || own > m.mortgage_share)) throw new CalcError(`«${p.row.product}»: первоначальный взнос по ипотеке — доля выручки от 0 до доли ипотечных сделок`, "SALES.PAYMENT_MIX");
  const sum = shares.reduce((s, x) => s.add(x), ZERO);
  if (!sum.eq(ONE)) throw new CalcError(`«${p.row.product}»: сумма долей ипотеки, 100% оплаты и рассрочки ${fmt(sum)} — должна быть 1`, "SALES.PAYMENT_MIX");
  const inst = new Decimal(m.installment_share);
  const n = inst.isZero() ? 0 : Number(m.installment_months);
  if (!inst.isZero() && (!Number.isInteger(n) || n < 1)) throw new CalcError(`«${p.row.product}»: срок рассрочки — целое число месяцев ≥ 1`, "SALES.PAYMENT_MIX");
  const down = inst.mul(m.installment_down_payment ?? 0);
  return { now: new Decimal(m.mortgage_share).add(m.full_payment_share).add(down), down, rest: inst.sub(down), n };
}

export function F_SALES_CASH_IN(ctx: FormulaContext): CashIn {
  const value = ctx.formula<RowSeries>("F.SALES.CONTRACT_VALUE");
  const mix = ctx.require<MixRow[]>("SALES.PAYMENT_MIX");
  if (!Array.isArray(mix)) throw new CalcError("Структура оплат: нужен список строк по продуктам", "SALES.PAYMENT_MIX");
  // Расчёт «как в исходном Excel»: ДДУ — сделки по дату из исходника (CF1!F8:AS8), поступления после SALES.LEGACY_CASH_IN_END
  // в CF не попадают (CF1!F15:AH15) — Excel один в один
  const legacy = ctx.mode === "legacy";
  const date = legacy ? ctx.formula<IsoDate[]>("F.TIME.DATE") : [];
  const dduEnd = legacy ? ctx.require<IsoDate>("TIME.LEGACY_ESCROW_DEPOSIT_END") : null;
  const cashEnd = legacy ? ctx.param<IsoDate>("SALES.LEGACY_CASH_IN_END") : null;
  const postRnv = legacy ? [] : ctx.formula<number[][]>("F.TIME.FLAG_POST_RNV");
  const lastT = cashEnd && date[0] ? monthDiff(date[0], cashEnd) : Infinity;
  const total: RowSeries = {};
  const ddu: RowSeries = {};
  let lost = ZERO;
  for (const p of products(ctx)) {
    const v = value[p.key] as Decimal[];
    const m = mixFor(mix, p);
    const all = v.map(() => ZERO);
    const toEscrow = v.map(() => ZERO);
    const flags = postRnv[p.phaseIndex] ?? [];
    const lostBefore = lost;
    v.forEach((x, tau) => {
      if (x.isZero()) return;
      const isDdu = legacy ? (date[tau] as IsoDate) <= (dduEnd as IsoDate) : flags[tau] !== 1;
      const add = (t: number, amount: Decimal) => {
        if (t >= all.length) return;
        if (t > lastT) {
          lost = lost.add(amount);
          return;
        }
        all[t] = (all[t] as Decimal).add(amount);
        if (isDdu) toEscrow[t] = (toEscrow[t] as Decimal).add(amount);
      };
      add(tau, x.mul(m.now));
      for (let t = tau + 1; t <= tau + m.n; t++) add(t, x.mul(m.rest).div(m.n));
    });
    const got = all.reduce((s, x) => s.add(x), ZERO).add(lost.sub(lostBefore));
    const due = v.reduce((s, x) => s.add(x), ZERO);
    if (due.sub(got).gt(ONE)) ctx.message("warning", `«${p.key}»: платежи по рассрочке на ${fmt(due.sub(got))} руб. приходятся на месяцы после горизонта модели`, "SALES.PAYMENT_MIX");
    total[p.key] = all;
    ddu[p.key] = toEscrow;
  }
  if (!lost.isZero()) {
    const revenue = Object.values(value).reduce((s, v) => s.add(sum(v)), ZERO);
    ctx.message(
      "warning",
      `Строка доходов CF1 обрывается после ${fmtQuarter(cashEnd as string)}: ${fmt(lost)} руб. выручки в денежный поток не попадают (в CF ${fmt(revenue.sub(lost))} руб. против ${fmt(revenue)} руб. по плану продаж). Расчёт «как в исходном Excel» повторяет исходник, в расчёте сервиса учитываются все поступления`,
      "SALES.LEGACY_CASH_IN_END",
      "SALES.CASH_IN_CUT",
    );
  }
  return { total, ddu };
}

function sum(xs: Decimal[]): Decimal {
  return xs.reduce((s, x) => s.add(x), ZERO);
}

export function F_SALES_WAVG_PRICE(ctx: FormulaContext): Record<string, Decimal | null> {
  const value = ctx.formula<RowSeries>("F.SALES.CONTRACT_VALUE");
  const sold = ctx.formula<RowSeries>("F.SALES.SOLD_AREA");
  const out: Record<string, Decimal | null> = {};
  for (const [key, s] of Object.entries(sold)) {
    const q = sum(s);
    out[key] = q.isZero() ? null : sum(value[key] as Decimal[]).div(q);
  }
  return out;
}

export function F_SALES_END_PRICE(ctx: FormulaContext): Record<string, Decimal | null> {
  const price = ctx.formula<RowSeries>("F.SALES.PRICE");
  const sold = ctx.formula<RowSeries>("F.SALES.SOLD_AREA");
  const out: Record<string, Decimal | null> = {};
  for (const [key, s] of Object.entries(sold)) {
    let last = s.length - 1;
    while (last >= 0 && (s[last] as Decimal).isZero()) last--;
    out[key] = last < 0 ? null : ((price[key] as Decimal[])[last] as Decimal);
  }
  return out;
}

/** Выручка с НДС и без НДС (null — НДС с продаж не посчитан). */
export interface Revenue {
  gross: Decimal;
  net: Decimal | null;
  byRow: Record<string, Decimal>;
}

export function F_SALES_REVENUE_TOTAL(ctx: FormulaContext): Revenue {
  const value = ctx.formula<RowSeries>("F.SALES.CONTRACT_VALUE");
  const byRow = Object.fromEntries(Object.entries(value).map(([k, s]) => [k, sum(s)]));
  const gross = Object.values(byRow).reduce((s, x) => s.add(x), ZERO);
  // Выручка — база статей-долей бюджета: без НДС с продаж она всё равно считается, net остаётся пустым
  let net: Decimal | null = null;
  try {
    const vat = ctx.formula<{ byRow: RowSeries }>("F.TAX.OUTPUT_VAT");
    net = gross.sub(Object.values(vat.byRow).reduce((s, xs) => s.add(sum(xs)), ZERO));
  } catch (e) {
    if (!(e instanceof DependencyError)) throw e;
  }
  return { gross, net, byRow };
}

export const SALES_FORMULAS = {
  "F.SALES.SOLD_AREA": F_SALES_SOLD_AREA,
  "F.SALES.PRICE": F_SALES_PRICE,
  "F.SALES.CONTRACT_VALUE": F_SALES_CONTRACT_VALUE,
  "F.SALES.CASH_IN": F_SALES_CASH_IN,
  "F.SALES.WAVG_PRICE": F_SALES_WAVG_PRICE,
  "F.SALES.END_PRICE": F_SALES_END_PRICE,
  "F.SALES.REVENUE_TOTAL": F_SALES_REVENUE_TOTAL,
} as const;
