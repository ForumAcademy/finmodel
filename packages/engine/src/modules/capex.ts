/**
 * CAPEX — бюджет и график затрат (data/formulas.yaml, модуль CAPEX; справочник статей — data/capex_items.yaml).
 * Сумма статьи = ставка × база (F.CAPEX.ITEM_TOTAL) → график по правилу (F.CAPEX.SCHEDULE_WEIGHT) →
 * индекс цен (F.CAPEX.INDEX) → платёж с НДС (F.CAPEX.ITEM_CASH) → итог (F.CAPEX.TOTAL).
 *
 * Статья, которую нельзя посчитать (не заполнена ставка, не посчитана база или выручка),
 * не останавливает остальные: по ней выдаётся сообщение, в итог она не входит, и это видно в сообщении итога.
 */
import Decimal from "decimal.js";
import { getCapexItem, getParameter, isFormulaId, isParameterId, spec, type CapexItemId, type ParameterId, type SpecCapexItem } from "@fm/spec";
import type { FormulaContext } from "../context";
import { CalcError, DependencyError, MissingInputError } from "../context";
import { dayBefore, daysBetween, eomonth, isIsoDate, monthDiff, overlapDays, yearEnd, yearOf, type IsoDate } from "../lib/dates";
import { sCurve } from "../lib/curves";
import { fmtShare } from "../lib/format";
import { isMilestoneKey, milestone, milestoneName, milestones, type MilestoneKey, type MilestoneRow } from "./time";

const ZERO = new Decimal(0);
const ONE = new Decimal(1);

/** Группы, из которых складывается F.CAPEX.SMR_TOTAL (formulas.yaml → expr). */
const SMR_GROUPS = new Set(["СМР", "сети", "благоустройство", "соцобъекты"]);

type Amounts = Partial<Record<CapexItemId, Decimal>>;
type Series = Partial<Record<CapexItemId, Decimal[]>>;

/** Ручной график: from — дата конца первого периода, step_months — длина периода, weights — доли периодов. */
interface ManualSchedule {
  from: IsoDate;
  step_months: number;
  weights: number[];
}

/** Строка CAPEX.ITEMS проекта: то, что задано, заменяет значение справочника capex_items.yaml. */
interface ItemRow {
  item_id: string;
  base?: string;
  rate?: number | null;
  price_date?: IsoDate | null;
  vat_included?: boolean | null;
  vat_rate?: number | null;
  schedule_rule?: string;
  schedule_from?: string | null;
  schedule_to?: string | null;
  schedule_manual?: ManualSchedule | null;
}

/** Статья бюджета: справочник + строка проекта. */
interface Item {
  id: CapexItemId;
  name: string;
  group: string;
  base: string;
  ratePrm: ParameterId | null;
  rate: number | null;
  priceDate: IsoDate | null;
  vatIncluded: boolean;
  vatRate: number | null;
  rule: string;
  from: MilestoneKey | null;
  to: MilestoneKey | null;
  manual: ManualSchedule | null;
  /** Статья есть в CAPEX.ITEMS проекта. */
  hasRow: boolean;
  catalogue: SpecCapexItem;
}

function merge(c: SpecCapexItem, row: ItemRow | undefined): Item {
  const from = row?.schedule_from ?? c.schedule_from ?? null;
  const to = row?.schedule_to ?? c.schedule_to ?? null;
  const ratePrm = c.rate_param ?? null;
  return {
    id: c.item_id,
    name: c.name,
    group: c.group,
    base: row?.base ?? c.base,
    ratePrm,
    rate: row?.rate ?? null,
    priceDate: row?.price_date ?? null,
    vatIncluded: row?.vat_included === true,
    vatRate: row?.vat_rate ?? null,
    rule: row?.schedule_rule ?? c.schedule_rule,
    from: isMilestoneKey(from) ? from : null,
    to: isMilestoneKey(to) ? to : null,
    manual: row?.schedule_manual ?? null,
    hasRow: row !== undefined,
    catalogue: c,
  };
}

/** Все статьи справочника с поправками проекта (CAPEX.ITEMS). */
function items(ctx: FormulaContext): Item[] {
  const raw = ctx.param<ItemRow[] | string>("CAPEX.ITEMS");
  // Значение по умолчанию в parameters.yaml — текстовая ссылка на справочник: строк проекта нет
  const rows = typeof raw === "string" ? null : raw;
  if (rows !== null && !Array.isArray(rows)) throw new CalcError("CAPEX.ITEMS: нужен список строк статей", "CAPEX.ITEMS");
  const byId = new Map<string, ItemRow>();
  for (const row of rows ?? []) {
    if (!spec.capexItems.some((c) => c.item_id === row.item_id)) throw new CalcError(`CAPEX.ITEMS: статьи «${row.item_id}» нет в справочнике`, "CAPEX.ITEMS");
    byId.set(row.item_id, row);
  }
  return spec.capexItems.map((c) => merge(c, byId.get(c.item_id)));
}

/**
 * Посчитать по статье; ошибка статьи → сообщение, статья пропускается (null).
 * Ошибка формулы-зависимости уже выдана там — здесь только отметка, что статья из-за неё не посчитана.
 */
function guard<T>(ctx: FormulaContext, item: Item, fn: () => T): T | null {
  try {
    return fn();
  } catch (e) {
    if (e instanceof MissingInputError) ctx.message("error", `«${item.name}»: заполните «${getParameter(e.parameterId).name}» (${e.parameterId})`, e.parameterId);
    else if (e instanceof CalcError) ctx.message("error", `«${item.name}»: ${e.message}`, e.parameterId ?? "CAPEX.ITEMS");
    else if (e instanceof DependencyError) ctx.message("warning", `«${item.name}» не посчитана: не посчитана формула ${e.formulaId}`);
    else throw e;
    return null;
  }
}

/** Объём базы статьи: параметр, формула или 1 для фиксированной суммы. */
function baseQty(ctx: FormulaContext, item: Item): Decimal {
  const base = item.base;
  if (base === "фикс") return ONE;
  if (isParameterId(base)) return ctx.requireNum(base);
  if (isFormulaId(base)) {
    const v = ctx.formula<unknown>(base);
    // Благоустройство: база — площадь благоустройства из состава F.TEP.LANDSCAPE_AREA
    if (v && typeof v === "object" && "landscape" in v) return (v as { landscape: Decimal }).landscape;
    // Статьи-доли выручки: база — выручка с НДС (F.SALES.REVENUE_TOTAL → revenue_gross)
    if (v && typeof v === "object" && "gross" in v) return (v as { gross: Decimal }).gross;
    if (v instanceof Decimal) return v;
    throw new CalcError(`база ${base} — не число`);
  }
  throw new CalcError(`неизвестная база «${base}»`, "CAPEX.ITEMS");
}

/** Ставка статьи: строка CAPEX.ITEMS, иначе параметр rate_param. */
function rate(ctx: FormulaContext, item: Item): Decimal {
  if (item.rate !== null) return new Decimal(item.rate);
  if (item.ratePrm) return ctx.requireNum(item.ratePrm);
  throw new CalcError("заполните ставку статьи (CAPEX.ITEMS → rate)", "CAPEX.ITEMS");
}

/** Интервал статьи по вехам: самая ранняя веха «с» и самая поздняя веха «по» среди очередей. */
function interval(item: Item, rows: MilestoneRow[]): { from: IsoDate; to: IsoDate } {
  if (!item.from || !item.to) throw new CalcError("не заданы вехи «с» и «по» графика статьи", "CAPEX.ITEMS");
  const froms = rows.map((r) => milestone(r, item.from as MilestoneKey));
  const tos = rows.map((r) => milestone(r, item.to as MilestoneKey));
  const from = froms.reduce((a, b) => (b < a ? b : a));
  const to = tos.reduce((a, b) => (b > a ? b : a));
  if (to <= from) throw new CalcError(`веха «${milestoneName(item.to)}» должна быть позже вехи «${milestoneName(item.from)}»`, "TIME.MILESTONES");
  return { from, to };
}

/** Доли дней месяцев внутри [from; to): ключ — дата конца месяца. Первый и последний месяцы — неполные. */
function dayShares(from: IsoDate, to: IsoDate): { end: IsoDate; share: Decimal }[] {
  const out: { end: IsoDate; share: Decimal }[] = [];
  const a = dayBefore(from);
  const b = dayBefore(to);
  for (let k = 0; ; k++) {
    const end = eomonth(from, k);
    const prev = eomonth(from, k - 1);
    const days = overlapDays(a, b, prev, end);
    if (days > 0) out.push({ end, share: new Decimal(days).div(daysBetween(prev, end)) });
    if (end >= b) return out;
  }
}

/** Сумма статьи в ценах даты расценки (F.CAPEX.ITEM_TOTAL для одной статьи). */
function itemTotal(ctx: FormulaContext, item: Item, rows: () => MilestoneRow[]): Decimal {
  if (item.base === "формула") {
    const f = item.catalogue.formula;
    if (!f) throw new CalcError("база «формула» без формулы в справочнике", "CAPEX.ITEMS");
    const v = ctx.formula<Decimal | Decimal[]>(f);
    return Array.isArray(v) ? v.reduce((s, x) => s.add(x), ZERO) : v;
  }
  if (item.base === "фикс_в_месяц") {
    const { from, to } = interval(item, rows());
    return rate(ctx, item).mul(dayShares(from, to).reduce((s, d) => s.add(d.share), ZERO));
  }
  const qty = baseQty(ctx, item);
  return rate(ctx, item).mul(qty);
}

export function F_CAPEX_ITEM_TOTAL(ctx: FormulaContext): Amounts {
  const out: Amounts = {};
  let rows: MilestoneRow[] | null = null;
  const lazyRows = () => (rows ??= milestones(ctx));
  for (const item of items(ctx)) {
    const v = guard(ctx, item, () => itemTotal(ctx, item, lazyRows));
    if (v !== null) out[item.id] = v;
  }
  return out;
}

/** Индекс месяца модели для даты (месяц, в который она попадает). */
function monthIndex(date: IsoDate[], d: IsoDate): number {
  return monthDiff(date[0] as IsoDate, d);
}

/** Ручной ряд → веса по месяцам модели: доля периода делится поровну между его месяцами. */
function manualWeights(m: ManualSchedule, date: IsoDate[]): Decimal[] {
  if (!isIsoDate(m.from) || !Number.isInteger(m.step_months) || m.step_months < 1 || !Array.isArray(m.weights)) {
    throw new CalcError("ручной график: нужны from (дата), step_months (целое ≥ 1) и weights (доли)", "CAPEX.ITEMS");
  }
  const w = date.map(() => ZERO);
  const firstEnd = monthIndex(date, m.from);
  m.weights.forEach((share, p) => {
    const part = new Decimal(share).div(m.step_months);
    const end = firstEnd + p * m.step_months;
    for (let t = end - m.step_months + 1; t <= end; t++) if (t >= 0 && t < w.length) w[t] = (w[t] as Decimal).add(part);
  });
  return w;
}

/** Веса по правилу статьи (кроме follow_smr — они считаются после, от платежей СМР). */
function ruleWeights(ctx: FormulaContext, item: Item, date: IsoDate[], rows: () => MilestoneRow[]): Decimal[] {
  const w = date.map(() => ZERO);
  const put = (d: IsoDate, v: Decimal) => {
    const t = monthIndex(date, d);
    if (t >= 0 && t < w.length) w[t] = (w[t] as Decimal).add(v);
  };
  switch (item.rule) {
    case "manual": {
      if (!item.manual) throw new CalcError("правило manual: заполните ручной график (CAPEX.ITEMS → schedule_manual)", "CAPEX.ITEMS");
      return manualWeights(item.manual, date);
    }
    case "formula": {
      const f = item.catalogue.formula;
      if (!f) throw new CalcError("правило formula без формулы в справочнике", "CAPEX.ITEMS");
      const pay = ctx.formula<Decimal[]>(f);
      const total = pay.reduce((s, x) => s.add(x), ZERO);
      return total.isZero() ? w : pay.map((x) => x.div(total));
    }
    case "at_milestone": {
      if (!item.from) throw new CalcError("правило at_milestone: не задана веха", "CAPEX.ITEMS");
      put(rows().map((r) => milestone(r, item.from as MilestoneKey)).reduce((a, b) => (b < a ? b : a)), ONE);
      return w;
    }
    case "uniform": {
      const { from, to } = interval(item, rows());
      if (item.base === "фикс_в_месяц") {
        const shares = dayShares(from, to);
        const sum = shares.reduce((s, d) => s.add(d.share), ZERO);
        for (const d of shares) put(d.end, d.share.div(sum));
        return w;
      }
      const t0 = monthIndex(date, from);
      const n = monthIndex(date, to) - t0;
      for (let k = 0; k < n; k++) put(eomonth(from, k), ONE.div(n));
      return w;
    }
    case "s_curve": {
      const { from, to } = interval(item, rows());
      const n = monthIndex(date, to) - monthIndex(date, from);
      for (let k = 0; k < n; k++) put(eomonth(from, k), sCurve(new Decimal(k + 1).div(n)).sub(sCurve(new Decimal(k).div(n))));
      return w;
    }
    case "follow_sales": {
      // Доля выручки месяца: стоимость договоров месяца по всем продуктам / итого
      const value = ctx.formula<Record<string, Decimal[]>>("F.SALES.CONTRACT_VALUE");
      for (const s of Object.values(value)) s.forEach((x, t) => (w[t] = (w[t] as Decimal).add(x)));
      const total = w.reduce((s, x) => s.add(x), ZERO);
      if (total.isZero()) throw new CalcError("график по продажам: продаж нет");
      return w.map((x) => x.div(total));
    }
    default:
      throw new CalcError(`неизвестное правило графика «${item.rule}»`, "CAPEX.ITEMS");
  }
}

export function F_CAPEX_SCHEDULE_WEIGHT(ctx: FormulaContext): Series {
  const date = ctx.formula<IsoDate[]>("F.TIME.DATE");
  const totals = ctx.formula<Amounts>("F.CAPEX.ITEM_TOTAL");
  const tol = ctx.requireNum("CAPEX.SCHEDULE_SUM_TOLERANCE");
  let rows: MilestoneRow[] | null = null;
  const lazyRows = () => (rows ??= milestones(ctx));
  const all = items(ctx).filter((i) => totals[i.id] !== undefined);
  const out: Series = {};
  const check = (item: Item, w: Decimal[]) => {
    const sum = w.reduce((s, x) => s.add(x), ZERO);
    if (sum.sub(ONE).abs().gte(tol)) {
      // Расчёт «как в исходном Excel» повторяет исходник: ряд берётся как есть, расхождение — предупреждение
      if (ctx.mode === "legacy") {
        ctx.message("warning", `«${item.name}»: в денежный поток попадает ${fmtShare(sum)} суммы бюджета — так в исходнике; в расчёте сервиса график равен 100%`, "CAPEX.ITEMS", `CAPEX.SCHEDULE_SUM:${item.id}`);
        return;
      }
      ctx.message("error", `«${item.name}»: в денежный поток за срок расчёта попадает ${fmtShare(sum)} суммы статьи вместо 100%. Проверьте, что график не выходит за срок расчёта и ручной ряд в сумме даёт 100%.`, "CAPEX.ITEMS");
    }
  };
  for (const item of all) {
    // Статья с нулевой суммой графика не требует
    if ((totals[item.id] as Decimal).isZero()) out[item.id] = date.map(() => ZERO);
    else if (item.rule !== "follow_smr") {
      const w = guard(ctx, item, () => ruleWeights(ctx, item, date, lazyRows));
      if (w) {
        check(item, w);
        out[item.id] = w;
      }
    }
  }
  // smr_cash[t]: платежи статей групп СМР по их собственным графикам (сумма × вес), без статей follow_smr
  const smr = date.map(() => ZERO);
  for (const item of all) {
    const w = out[item.id];
    if (!SMR_GROUPS.has(item.group) || item.rule === "follow_smr" || !w) continue;
    w.forEach((x, t) => (smr[t] = (smr[t] as Decimal).add(x.mul(totals[item.id] as Decimal))));
  }
  const smrSum = smr.reduce((s, x) => s.add(x), ZERO);
  for (const item of all) {
    if (item.rule !== "follow_smr" || out[item.id]) continue;
    const w = guard(ctx, item, () => {
      if (smrSum.isZero()) throw new CalcError("график «вслед за СМР»: платежей по СМР нет");
      return smr.map((x) => x.div(smrSum));
    });
    if (w) {
      check(item, w);
      out[item.id] = w;
    }
  }
  return out;
}

/** Годовой индекс: {by_year: {2026: 0.065, …}, after_last: last}. */
interface YearSeries {
  by_year: Record<string, number>;
  after_last?: string;
}

export function growth(ctx: FormulaContext, id: ParameterId): (year: number) => Decimal {
  const s = ctx.require<YearSeries>(id);
  const years = Object.keys(s?.by_year ?? {}).map(Number).sort((a, b) => a - b);
  if (years.length === 0) throw new CalcError(`${id}: нет значений по годам`, id);
  const first = Math.min(...years);
  const last = Math.max(...years);
  return (y) => {
    if (y < first) throw new CalcError(`${id}: нет значения индекса за ${y} год`, id);
    const key = y > last ? (s.after_last === "last" ? last : null) : y;
    if (key === null || s.by_year[key] === undefined) throw new CalcError(`${id}: нет значения индекса за ${y} год`, id);
    return new Decimal(s.by_year[key] as number);
  };
}

/** Множитель роста цен за полуинтервал (a; b], a <= b: Π_y (1 + g[y]) ^ (дней года y в интервале / дней в году y). */
function factor(g: (y: number) => Decimal, a: IsoDate, b: IsoDate): Decimal {
  let k = ONE;
  for (let y = yearOf(a); y <= yearOf(b); y++) {
    const days = overlapDays(a, b, yearEnd(y - 1), yearEnd(y));
    if (days > 0) k = k.mul(ONE.add(g(y)).pow(new Decimal(days).div(daysBetween(yearEnd(y - 1), yearEnd(y)))));
  }
  return k;
}

/** index[t] = рост цен от даты уровня цен p до конца месяца t (при t раньше p — обратный пересчёт). */
function indexSeries(g: (y: number) => Decimal, date: IsoDate[], p: IsoDate): Decimal[] {
  return date.map((d) => (d >= p ? factor(g, p, d) : ONE.div(factor(g, d, p))));
}

export function F_CAPEX_INDEX(ctx: FormulaContext): Series {
  const date = ctx.formula<IsoDate[]>("F.TIME.DATE");
  const ones = date.map(() => ONE);
  const series = new Map<string, Decimal[]>();
  const out: Series = {};
  for (const item of items(ctx)) {
    const type = item.catalogue.index_type;
    // Расчёт «как в исходном Excel» — без индексации: суммы исходника в ценах исходника (сверка с Excel)
    if (type === "none" || ctx.mode === "legacy") {
      out[item.id] = ones;
      continue;
    }
    // Статья без строки в CAPEX.ITEMS и без параметра-ставки не посчитается (ошибка «заполните ставку» — в F.CAPEX.ITEM_TOTAL)
    if (!item.hasRow && !item.ratePrm) continue;
    const v = guard(ctx, item, () => {
      const p = item.priceDate;
      if (!isIsoDate(p)) throw new CalcError("заполните дату уровня цен ставки (CAPEX.ITEMS → price_date)", "CAPEX.ITEMS");
      const key = `${type}:${p}`;
      if (!series.has(key)) series.set(key, indexSeries(growth(ctx, type === "investment" ? "CAPEX.COST_INDEX" : "CAPEX.OPEX_INDEX"), date, p));
      return series.get(key) as Decimal[];
    });
    if (v) out[item.id] = v;
  }
  return out;
}

/** Числовое значение ставки из справочника: число или ID параметра (TAX.VAT_RATE, OPEX.OVERHEAD_VAT_SHARE). */
function numOrParam(ctx: FormulaContext, v: number | string): Decimal {
  if (typeof v === "number") return new Decimal(v);
  if (!isParameterId(v)) throw new CalcError(`неизвестный параметр «${v}» в справочнике статей`);
  return ctx.requireNum(v);
}

/** Ставка НДС статьи: договор (CAPEX.ITEMS → vat_rate) → первое подходящее правило vat_rules → vat_rate справочника. */
function vatRate(ctx: FormulaContext, item: Item): Decimal {
  if (item.vatRate !== null) {
    const options = ctx.require<number[]>("TAX.VAT_RATE_OPTIONS");
    if (!options.includes(item.vatRate)) throw new CalcError(`ставка НДС ${item.vatRate} не из допустимых (${options.join(" / ")})`, "CAPEX.ITEMS");
    return new Decimal(item.vatRate);
  }
  for (const rule of item.catalogue.vat_rules ?? []) {
    const hit = Object.entries(rule.when).every(([id, expected]) => {
      if (!isParameterId(id)) throw new CalcError(`неизвестный параметр «${id}» в условии ставки НДС`);
      return ctx.require<string>(id) === expected;
    });
    if (hit) {
      if (!rule.verified) ctx.message("warning", `«${item.name}»: ставка НДС по правилу не сверена — ${rule.note ?? "подтвердить"}`);
      return numOrParam(ctx, rule.vat_rate);
    }
  }
  return numOrParam(ctx, item.catalogue.vat_rate);
}

/** Ставка НДС статьи с учётом облагаемой доли — как в F.CAPEX.ITEM_CASH. */
function effectiveVat(ctx: FormulaContext, item: Item): Decimal {
  return vatRate(ctx, item).mul(item.catalogue.vat_taxable_share === undefined ? ONE : numOrParam(ctx, item.catalogue.vat_taxable_share));
}

/**
 * Входящий НДС в платежах статей по месяцам: item_cash × r / (1 + r) (F.TAX.VAT_PAYABLE). Статьи, которые не
 * посчитались в F.CAPEX.ITEM_CASH или у которых не определяется ставка НДС, здесь отсутствуют (весь платёж — затраты).
 */
export function inputVat(ctx: FormulaContext, cash: Series): Series {
  const out: Series = {};
  for (const item of items(ctx)) {
    const c = cash[item.id];
    if (!c) continue;
    // Ставка статьи не определяется (не заполнена облагаемая доля) — сообщение, входящий НДС статьи не выделяется
    const r = guard(ctx, item, () => effectiveVat(ctx, item));
    if (r) out[item.id] = c.map((x) => x.mul(r).div(ONE.add(r)));
  }
  return out;
}

export function F_CAPEX_ITEM_CASH(ctx: FormulaContext): Series {
  const totals = ctx.formula<Amounts>("F.CAPEX.ITEM_TOTAL");
  const weights = ctx.formula<Series>("F.CAPEX.SCHEDULE_WEIGHT");
  const index = ctx.formula<Series>("F.CAPEX.INDEX");
  const out: Series = {};
  for (const item of items(ctx)) {
    const total = totals[item.id];
    const w = weights[item.id];
    const k = index[item.id];
    if (total === undefined || !w || !k) continue;
    const v = guard(ctx, item, () => {
      const vatK = item.vatIncluded ? ONE : ONE.add(effectiveVat(ctx, item));
      return w.map((x, t) => total.mul(x).mul(k[t] as Decimal).mul(vatK));
    });
    if (v) out[item.id] = v;
  }
  return out;
}

export function F_CAPEX_SMR_TOTAL(ctx: FormulaContext): Decimal {
  let sum = ZERO;
  for (const item of items(ctx)) {
    if (!SMR_GROUPS.has(item.group)) continue;
    if (item.base === "фикс_в_месяц" || item.base === "формула" || item.base === "F.CAPEX.SMR_TOTAL") {
      throw new CalcError(`«${item.name}»: у статьи группы «${item.group}» база должна быть ставка × объём (не «${item.base}»)`, "CAPEX.ITEMS");
    }
    try {
      sum = sum.add(rate(ctx, item).mul(baseQty(ctx, item)));
    } catch (e) {
      if (e instanceof CalcError) throw new CalcError(`«${item.name}»: ${e.message}`, e.parameterId);
      throw e;
    }
  }
  return sum;
}

export function F_CAPEX_SMR_PROGRESS(ctx: FormulaContext): Decimal[] {
  const date = ctx.formula<IsoDate[]>("F.TIME.DATE");
  let rows: MilestoneRow[] | null = null;
  const lazyRows = () => (rows ??= milestones(ctx));
  const smr = date.map(() => ZERO);
  for (const item of items(ctx)) {
    if (!SMR_GROUPS.has(item.group) || item.rule === "follow_smr") continue;
    try {
      // График по продажам замкнул бы расчёт: цена ← готовность ← продажи
      if (item.rule === "follow_sales" || item.rule === "formula") throw new CalcError(`у статьи группы «${item.group}» график не может быть «${item.rule}»`, "CAPEX.ITEMS");
      const total = rate(ctx, item).mul(baseQty(ctx, item));
      if (total.isZero()) continue;
      ruleWeights(ctx, item, date, lazyRows).forEach((w, t) => (smr[t] = (smr[t] as Decimal).add(w.mul(total))));
    } catch (e) {
      if (e instanceof CalcError) throw new CalcError(`«${item.name}»: ${e.message}`, e.parameterId);
      throw e;
    }
  }
  const sum = smr.reduce((s, x) => s.add(x), ZERO);
  if (sum.isZero()) throw new CalcError("Готовность строительства не считается: в бюджете нет платежей по СМР", "CAPEX.ITEMS");
  let acc = ZERO;
  return smr.map((x) => (acc = acc.add(x)).div(sum));
}

export function F_CAPEX_NCS_BENCH(ctx: FormulaContext): Decimal | null {
  // Показатели НЦС 81-02-01-2026 по классу и этажности в справочник не выписаны (status: needs_verification):
  // контроль не считается, а не подменяется выдуманным значением (CLAUDE.md, правило 8).
  ctx.message("warning", "Контроль СМР по НЦС пока недоступен: показатели НЦС 81-02-01-2026 по классу и этажности не выписаны в справочник");
  return null;
}

export function F_CAPEX_INDEX_EFFECT(ctx: FormulaContext): Decimal {
  const cash = ctx.formula<Series>("F.CAPEX.ITEM_CASH");
  const index = ctx.formula<Series>("F.CAPEX.INDEX");
  let effect = ZERO;
  for (const [id, s] of Object.entries(cash) as [CapexItemId, Decimal[]][]) {
    const k = index[id] as Decimal[];
    s.forEach((x, t) => (effect = effect.add(x.mul(ONE.sub(ONE.div(k[t] as Decimal))))));
  }
  return effect;
}

export function F_CAPEX_TOTAL(ctx: FormulaContext): Decimal {
  const cash = ctx.formula<Series>("F.CAPEX.ITEM_CASH");
  let total = ZERO;
  for (const s of Object.values(cash)) for (const x of s ?? []) total = total.add(x);
  const missing = spec.capexItems.filter((c) => !cash[c.item_id]).map((c) => getCapexItem(c.item_id).name);
  if (missing.length > 0) ctx.message("warning", `В итог бюджета не вошли статьи: ${missing.join(", ")}`);
  return total;
}

export const CAPEX_FORMULAS = {
  "F.CAPEX.ITEM_TOTAL": F_CAPEX_ITEM_TOTAL,
  "F.CAPEX.INDEX": F_CAPEX_INDEX,
  "F.CAPEX.SCHEDULE_WEIGHT": F_CAPEX_SCHEDULE_WEIGHT,
  "F.CAPEX.ITEM_CASH": F_CAPEX_ITEM_CASH,
  "F.CAPEX.SMR_TOTAL": F_CAPEX_SMR_TOTAL,
  "F.CAPEX.SMR_PROGRESS": F_CAPEX_SMR_PROGRESS,
  "F.CAPEX.NCS_BENCH": F_CAPEX_NCS_BENCH,
  "F.CAPEX.INDEX_EFFECT": F_CAPEX_INDEX_EFFECT,
  "F.CAPEX.TOTAL": F_CAPEX_TOTAL,
} as const;

