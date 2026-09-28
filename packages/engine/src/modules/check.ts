/**
 * CHECK — проверки модели (data/formulas.yaml, модуль CHECK): свод проверок и предельные параметры ГПЗУ.
 * Проверка, у которой не посчитаны входы, не запускается: статус «ждёт данных», сообщение о входе выдаёт его формула.
 */
import type { ParameterId } from "@fm/spec";
import Decimal from "decimal.js";
import type { FormulaContext } from "../context";
import { CalcError, DependencyError, MissingInputError } from "../context";
import { fmt } from "../lib/format";
import type { EscrowBalance } from "./escrow";
import type { Debt } from "./fin";
import { CHANNEL_DDU, products, type CashIn, type RowSeries } from "./sales";
import type { GfaSplit } from "./tep";
import { milestones } from "./time";

const ZERO = new Decimal(0);
const ONE = new Decimal(1);

export type CheckStatus = "сходится" | "ошибка" | "предупреждение" | "ждёт данных";

export interface CheckResult {
  id: string;
  status: CheckStatus;
}

/** Ключ сообщения проверки: CHECK.<id> (по нему интерфейс связывает сообщение со строкой свода). */
export const checkKey = (id: string): string => `CHECK.${id}`;

const sum = (xs: readonly (Decimal | null | undefined)[] | null | undefined): Decimal => (xs ?? []).reduce((s: Decimal, x) => s.add(x ?? ZERO), ZERO);
const last = (xs: readonly Decimal[]): Decimal => xs[xs.length - 1] ?? ZERO;

type Found = { severity: "error" | "warning"; text: string; param?: ParameterId | undefined };

/** Запустить одну проверку: список найденного → статус и сообщения; нет входов → «ждёт данных». */
function run(ctx: FormulaContext, id: string, fn: () => Found[] | null): CheckResult {
  let found: Found[] | null;
  try {
    found = fn();
  } catch (e) {
    if (e instanceof MissingInputError || e instanceof DependencyError || e instanceof CalcError) return { id, status: "ждёт данных" };
    throw e;
  }
  if (found === null) return { id, status: "ждёт данных" };
  // Расчёт «как в исходном Excel» повторяет исходник как есть: найденное — справка, расхождения исходника — в своём разделе
  for (const f of found) ctx.message(ctx.mode === "legacy" ? "info" : f.severity, f.text, f.param, checkKey(id));
  const status: CheckStatus = found.some((f) => f.severity === "error") ? "ошибка" : found.length > 0 ? "предупреждение" : "сходится";
  return { id, status };
}

/** Жилая, апартаментная и нежилая ГНС вместе — не больше наземной ГНС. */
function gfaSplit(ctx: FormulaContext): Found[] {
  const split = ctx.formula<GfaSplit>("F.TEP.GFA_SPLIT");
  const above = ctx.formula<Decimal>("F.TEP.GFA_ABOVE");
  const parts = split.res.add(split.apart).add(split.nonres);
  if (parts.sub(above).lte(ONE)) return [];
  // Пока предел не подтверждён ГПЗУ проекта, расхождение — предупреждение: разбивку уточняют у автора ТЭП
  // (решение владельца продукта 28.09.2026); с ГПЗУ в проекте — ошибка
  const gpzu = ctx.num("GPZU.MAX_GFA_ABOVE") !== null;
  return [
    {
      severity: gpzu ? "error" : "warning",
      text: `Жилая, апартаментная и нежилая ГНС вместе ${fmt(parts)} м² — больше наземной ГНС ${fmt(above)} м² на ${fmt(parts.sub(above))} м². ${gpzu ? "Проверьте разбивку ГНС в ТЭП" : "Уточните у автора ТЭП, что входит в нежилую ГНС, или приложите ГПЗУ"}`,
      param: "TEP.GFA_ABOVE",
    },
  ];
}

/** Продажи по ДДУ — не раньше РНС очереди (ст.3 214-ФЗ: привлекать деньги дольщиков можно после получения РНС). */
function dduAfterRns(ctx: FormulaContext): Found[] | null {
  const out: Found[] = [];
  let checked = false;
  const ddu = new Set(products(ctx).filter((p) => (p.row.sale_channel_before_rnv ?? CHANNEL_DDU) === CHANNEL_DDU).map((p) => p.row.phase));
  for (const row of milestones(ctx)) {
    if (!ddu.has(row.phase) || !row.sales_start || !row.rns_date) continue;
    checked = true;
    if (row.sales_start < row.rns_date) {
      out.push({ severity: "error", text: `Очередь ${row.phase}: старт продаж по ДДУ ${row.sales_start} раньше РНС ${row.rns_date}. Сдвиньте старт продаж на дату РНС или позже`, param: "TIME.MILESTONES" });
    }
  }
  return checked ? out : null;
}

/** Продукты разложены по очередям: у каждой очереди есть продукты, у каждого продукта окно продаж не пустое. */
function phaseWindows(ctx: FormulaContext): Found[] {
  const list = products(ctx);
  const phases = milestones(ctx);
  const out: Found[] = [];
  for (const row of phases) {
    if (!list.some((p) => p.row.phase === row.phase)) {
      out.push({ severity: "warning", text: `Очередь ${row.phase}: к ней не отнесён ни один продукт — выручки и эскроу у неё нет. Разложите продукты по очередям`, param: "SALES.PRODUCTS" });
    }
  }
  if (ctx.mode === "legacy") return out;
  const presale = ctx.formula<number[][]>("F.TIME.FLAG_PRESALE");
  const postRnv = ctx.formula<number[][]>("F.TIME.FLAG_POST_RNV");
  for (const p of list) {
    const open = (presale[p.phaseIndex] ?? []).includes(1) || (postRnv[p.phaseIndex] ?? []).includes(1);
    if (!open) out.push({ severity: "error", text: `«${p.key}»: в сроке расчёта нет ни одного месяца продаж очереди ${p.row.phase}. Проверьте старт продаж и РНВ очереди`, param: "TIME.MILESTONES" });
  }
  return out;
}

/** Выручка = деньги в потоке (раскрытое эскроу + продажи после ввода) + остаток эскроу + дебиторка на конец. */
function revenueEqCf(ctx: FormulaContext): Found[] {
  const value = ctx.formula<RowSeries>("F.SALES.CONTRACT_VALUE");
  const cash = ctx.formula<CashIn>("F.SALES.CASH_IN");
  const esc = ctx.formula<EscrowBalance>("F.ESC.BALANCE");
  const revenue = Object.values(value).reduce((s, v) => s.add(sum(v)), ZERO);
  const received = Object.values(cash.total).reduce((s, v) => s.add(sum(v)), ZERO);
  const ddu = Object.values(cash.ddu).reduce((s, v) => s.add(sum(v)), ZERO);
  const released = esc.release.reduce((s, r) => s.add(sum(r)), ZERO);
  const escrowLeft = esc.balance.reduce((s, b) => s.add(last(b)), ZERO);
  const receivable = revenue.sub(received);
  const diff = revenue.sub(released.add(received.sub(ddu)).add(escrowLeft).add(receivable));
  const out: Found[] = [];
  if (diff.abs().gt(ONE)) {
    out.push({ severity: "error", text: `Выручка ${fmt(revenue)} руб. не равна деньгам в потоке, остатку эскроу и дебиторке вместе: расхождение ${fmt(diff)} руб. Сообщите разработчику расчёта` });
  }
  if (escrowLeft.gt(ONE)) out.push({ severity: "warning", text: `К концу расчёта на эскроу остаётся ${fmt(escrowLeft)} руб.: они не раскрыты и в поток не попали. Проверьте даты РНВ и срок расчёта`, param: "TIME.MILESTONES" });
  if (receivable.gt(ONE)) out.push({ severity: "warning", text: `К концу расчёта не поступило ${fmt(receivable)} руб. выручки (рассрочка после конца расчёта). Сократите рассрочку или продлите расчёт`, param: "SALES.PAYMENT_MIX" });
  return out;
}

function escrowNonneg(ctx: FormulaContext): Found[] {
  const esc = ctx.formula<EscrowBalance>("F.ESC.BALANCE");
  const min = esc.balance.reduce((m, b) => b.reduce((x, y) => Decimal.min(x, y), m), ZERO);
  return min.lt(ONE.neg()) ? [{ severity: "error", text: `Остаток эскроу уходит в минус (${fmt(min)} руб.). Сообщите разработчику расчёта` }] : [];
}

function debtLeLimit(ctx: FormulaContext): Found[] {
  const draw = sum(ctx.formula<Decimal[]>("F.FIN.DRAW"));
  const limit = ctx.formula<Decimal>("F.FIN.LIMIT");
  return draw.sub(limit).gt(ONE) ? [{ severity: "error", text: `Кредита выбрано ${fmt(draw)} руб. — больше лимита ${fmt(limit)} руб. Увеличьте лимит или долю взноса застройщика`, param: "FIN.EQUITY_SHARE" }] : [];
}

function debtRepaid(ctx: FormulaContext): Found[] {
  const debt = ctx.formula<Debt>("F.FIN.DEBT");
  const owed = last(debt.debt).add(last(debt.accrued));
  return owed.gt(ONE) ? [{ severity: "error", text: `К концу расчёта кредит не погашен: ${fmt(owed)} руб. с процентами. Продлите расчёт или проверьте поступления` }] : [];
}

/** Задана кадастровая стоимость после смены ВРИ → нужна дата смены ВРИ. */
function vriDate(ctx: FormulaContext): Found[] | null {
  if (ctx.param("LAND.CADASTRAL_VALUE_AFTER_VRI") === null) return null;
  const has = milestones(ctx).some((r) => typeof r.vri_change_date === "string" && r.vri_change_date !== "");
  return has ? [] : [{ severity: "error", text: "Задана кадастровая стоимость после смены ВРИ, но нет даты смены ВРИ. Заполните веху «смена ВРИ»", param: "TIME.MILESTONES" }];
}

/** Участок в аренде → нужен тип арендодателя (от него зависит НДС арендной платы). */
function lessor(ctx: FormulaContext): Found[] | null {
  const tenure = ctx.param<string>("LAND.TENURE");
  if (tenure === null) return null;
  if (tenure !== "аренда") return [];
  return ctx.param("LAND.LESSOR_TYPE") === null ? [{ severity: "error", text: "Участок в аренде, но не указан арендодатель (орган власти или частный собственник): от этого зависит НДС арендной платы. Заполните арендодателя", param: "LAND.LESSOR_TYPE" }] : [];
}

/** Итог проверки ГПЗУ — из своей формулы (сообщения выданы там). */
function gpzu(ctx: FormulaContext): CheckResult {
  try {
    return ctx.formula<CheckResult>("F.CHECK.GPZU_LIMITS");
  } catch (e) {
    if (e instanceof DependencyError) return { id: "GPZU_LIMITS", status: "ждёт данных" };
    throw e;
  }
}

export function F_CHECK_ALL(ctx: FormulaContext): CheckResult[] {
  return [
    run(ctx, "GFA_SPLIT_LE_ABOVE", () => gfaSplit(ctx)),
    gpzu(ctx),
    run(ctx, "DDU_AFTER_RNS", () => dduAfterRns(ctx)),
    run(ctx, "PHASE_WINDOWS", () => phaseWindows(ctx)),
    run(ctx, "REVENUE_EQ_CF", () => revenueEqCf(ctx)),
    // Ёмкость рынка — из аналогов (F.BENCH.MARKET_PACE); пока аналогов нет, проверка ждёт данных
    { id: "SOLD_LE_MARKET", status: "ждёт данных" },
    run(ctx, "ESCROW_NONNEG", () => escrowNonneg(ctx)),
    run(ctx, "DEBT_LE_LIMIT", () => debtLeLimit(ctx)),
    run(ctx, "DEBT_REPAID", () => debtRepaid(ctx)),
    run(ctx, "VRI_DATE_REQUIRED", () => vriDate(ctx)),
    run(ctx, "LESSOR_REQUIRED", () => lessor(ctx)),
  ];
}

/** Предел по ГПЗУ с учётом решения об отклонении (ст.40 ГрК РФ). */
function limitOf(ctx: FormulaContext, id: "GPZU.MAX_GFA_ABOVE" | "GPZU.MAX_FLOORS" | "GPZU.MAX_HEIGHT_M" | "GPZU.MAX_BUILT_SHARE"): Decimal | null {
  const permits = ctx.param<{ limit: string; permitted_value?: number | null }[]>("GPZU.DEVIATION_PERMIT") ?? [];
  const p = Array.isArray(permits) ? permits.find((x) => x.limit === id && typeof x.permitted_value === "number") : undefined;
  return p ? new Decimal(p.permitted_value as number) : ctx.num(id);
}

export function F_CHECK_GPZU_LIMITS(ctx: FormulaContext): CheckResult {
  return run(ctx, "GPZU_LIMITS", () => {
    const out: Found[] = [];
    let checked = false;
    const cmp = (name: string, value: Decimal | null, limit: Decimal | null, unit: string, param: Found["param"]) => {
      if (value === null || limit === null) return;
      checked = true;
      if (value.gt(limit)) out.push({ severity: "error", text: `${name} ${fmt(value)} ${unit} — больше предела по ГПЗУ ${fmt(limit)} ${unit}. Уменьшите ${name.toLowerCase()} или приложите решение об отклонении от предельных параметров`, param });
    };
    const gfaLimit = limitOf(ctx, "GPZU.MAX_GFA_ABOVE");
    const gfa = gfaLimit === null ? null : ctx.formula<Decimal>("F.TEP.GFA_ABOVE");
    cmp("Наземная ГНС", gfa, gfaLimit, "м²", "GPZU.MAX_GFA_ABOVE");
    cmp("Этажность", ctx.num("TEP.MAX_FLOORS") ?? ctx.num("TEP.AVG_FLOORS"), limitOf(ctx, "GPZU.MAX_FLOORS"), "эт.", "GPZU.MAX_FLOORS");
    cmp("Высота", ctx.num("TEP.BUILDING_HEIGHT_M"), limitOf(ctx, "GPZU.MAX_HEIGHT_M"), "м", "GPZU.MAX_HEIGHT_M");
    const footprint = ctx.num("TEP.FOOTPRINT_AREA");
    const area = ctx.num("LAND.AREA");
    cmp("Доля застройки", footprint && area && !area.isZero() ? footprint.div(area) : null, limitOf(ctx, "GPZU.MAX_BUILT_SHARE"), "", "GPZU.MAX_BUILT_SHARE");
    const underuse = ctx.num("BENCH.GPZU_UNDERUSE_SHARE");
    const gpzuGfa = ctx.num("GPZU.MAX_GFA_ABOVE");
    if (gfa !== null && gpzuGfa !== null && underuse !== null && gfa.lt(gpzuGfa.mul(underuse))) {
      ctx.message("info", `Резерв площади по ГПЗУ: наземная ГНС ${fmt(gfa)} м² из разрешённых ${fmt(gpzuGfa)} м²`, "GPZU.MAX_GFA_ABOVE", checkKey("GPZU_UNDERUSE"));
    }
    return checked ? out : null;
  });
}

export const CHECK_FORMULAS = {
  "F.CHECK.ALL": F_CHECK_ALL,
  "F.CHECK.GPZU_LIMITS": F_CHECK_GPZU_LIMITS,
} as const;
