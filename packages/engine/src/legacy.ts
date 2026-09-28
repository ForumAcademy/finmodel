/**
 * Расчёт «как в исходном Excel»: входы кейса tests/cases/*_legacy.yaml → ProjectInput.
 * Чтение файла — у вызывающего кода (тесты, сид демо-проекта), ядро остаётся без файловой системы.
 */
import Decimal from "decimal.js";
import { getCapexItem, getParameter, isCapexItemId, isParameterId, type ParameterId } from "@fm/spec";
import type { ProjectInput } from "./types";

/** Статья бюджета исходника (capex_legacy кейса): расценка, объём, вбитая сумма и ручной квартальный ряд CF1. */
export interface LegacyCapexItem {
  item_id: string;
  budget_row: number | null;
  rate_D?: number | null;
  qty_E?: number | null;
  amount_F?: number | null;
  manual_schedule_quarterly?: { cf_row: number; values_F_to_AS: number[]; sum: number };
  /** Суммы CF1 по кварталам — для статей со своей формулой без ряда «темп» (аренда/налог ЗУ, CF1!F24:AH24). */
  cf_amounts_quarterly?: { cf_row: number; values_F_to_AS: number[]; sum: number };
}

/** Кейс исходного Excel (структура tests/cases/*_legacy.yaml). */
export interface LegacyCase {
  case_id: string;
  description: string;
  project_inputs: Record<string, unknown>;
  reconciliation_targets: Record<string, unknown>;
  capex_legacy?: LegacyCapexItem[];
  /** Концы кварталов столбцов F…AS листа CF1. */
  timeline_quarters_F_to_AS?: string[];
  /** План продаж исходника: темп по кварталам с 1 кв 2026 (шт; для ПСН — лоты) и рост цены за квартал. */
  sales_legacy?: { pace_units_quarterly_from_1q2026: Record<string, number[]>; price_growth_quarterly: number };
  /** Ячейки исходника для проверок расчёта «как в исходном Excel» (scripts/build_legacy_case.py → legacy_checks). */
  legacy_checks?: LegacyChecks;
}

/** Ячейки исходника для проверок: ряды CF1 — по кварталам F…AS, ряд плана продаж — с 1 кв 2026. */
export interface LegacyChecks {
  tep: {
    apt_area_C22: number;
    psn_stock_C23: number;
    saleable_area_C35: number;
    saleable_area_C35_formula: string | null;
    psn_stock_C48: number;
    psn_lot_D48: number;
    escrow_release_C12: unknown;
  };
  sales_plan: { revenue_row25_from_1q2026: number[]; psn_lots_row43_sum: number };
  budget: {
    marketing_rate_D51: number;
    marketing_F51: number;
    marketing_F51_formula: string;
    brokerage_rate_D52: number;
    brokerage_F52: number;
    contingency_D42: number;
    contingency_E42: number;
    contingency_F42: number;
    contingency_F42_formula: string;
  };
  cf1: {
    revenue_row15: number[];
    revenue_row15_last_formula_col: number;
    brokerage_row78: number[];
    marketing_row79: number[];
    escrow_release_row6: number[];
    escrow_release_row6_typed: number[];
    escrow_deposit_row8: number[];
    escrow_date_D6_formula: string;
  };
  /** Кредит CF1 (строки 98–132, по кварталам F…AS; знаки — как в CF1) и лимит Бюджет!F67. */
  fin?: {
    limit_F67: number;
    limit_F67_formula: string;
    draw_row98: number[];
    repaid_escrow_row100: number[];
    debt_row106: number[];
    interest_row107: number[];
    pik_paid_row108: number[];
    accrued_row110: number[];
    fee_row111: number[];
    flow_row113: number[];
    k1_row122: number[];
    rate_row125: number[];
    equity_row132: number[];
    eff_rate_D128: unknown;
  };
}

/** Месяцев в квартале ручных рядов CF1: доля квартала делится поровну на три месяца (F.CAPEX.SCHEDULE_WEIGHT). */
const LEGACY_STEP_MONTHS = 3;

/**
 * Бюджет исходника → CAPEX.ITEMS, Excel один в один (решение владельца продукта 27.09.2026: расчёт «как в исходном Excel» воспроизводит
 * исходник вместе с ошибками, исправления живут в расчёте сервиса, расхождения — предупреждения):
 * - сумма статьи — вбитая сумма Бюджет!F (база «фикс»; для статей с параметром-суммой — сам параметр); пустая — 0;
 *   резерв — как в исходнике E42 + D42, маркетинг — вбитое число F51;
 * - сумма с НДС — допущение CAPEX.LEGACY_AMOUNTS_WITH_VAT (S_EXPERT): в исходнике не указано; без индексации (F.CAPEX.INDEX);
 * - график — как в CF1: ряд «темп» как есть, даже если его доли не равны 100% (прочие СМР — 0%, резерв — 124,6%);
 *   у статей без ряда «темп» (аренда/налог ЗУ, маркетинг, брокеридж) — суммы CF1 по кварталам / сумма бюджета;
 *   статья с суммой, но без строки в CF1 (УДС), в денежный поток не попадает.
 */
function legacyCapex(c: LegacyCase, values: Partial<Record<ParameterId, unknown>>): Record<string, unknown>[] {
  const start = c.project_inputs["GEN.MODEL_START_DATE"];
  const quarters = c.timeline_quarters_F_to_AS ?? [];
  const withVat = getParameter("CAPEX.LEGACY_AMOUNTS_WITH_VAT").default === true;
  const rows: Record<string, unknown>[] = [];
  for (const lg of c.capex_legacy ?? []) {
    if (!isCapexItemId(lg.item_id)) continue;
    const item = getCapexItem(lg.item_id);
    const row: Record<string, unknown> = { item_id: lg.item_id, price_date: start, vat_included: withVat };
    const amount = typeof lg.amount_F === "number" ? lg.amount_F : 0;
    if (item.rate_param && item.base === "фикс") values[item.rate_param] = amount;
    else Object.assign(row, { base: "фикс", rate: amount });
    const weights = lg.manual_schedule_quarterly
      ? lg.manual_schedule_quarterly.values_F_to_AS
      : lg.cf_amounts_quarterly && amount !== 0
        ? lg.cf_amounts_quarterly.values_F_to_AS.map((v) => new Decimal(v).div(amount).toNumber())
        : amount !== 0
          ? quarters.map(() => 0)
          : null;
    if (weights && quarters[0]) Object.assign(row, { schedule_rule: "manual", schedule_manual: { from: quarters[0], step_months: LEGACY_STEP_MONTHS, weights } });
    rows.push(row);
  }
  return rows;
}

/** Месяцев в квартале плана продаж исходника: ряд — поквартальный, объём квартала — поровну на три месяца. */
const LEGACY_QUARTER_MONTHS = 3;
const QUARTERS_PER_YEAR = 4;
const PERCENT = 100;

/**
 * Значение расчёта сервиса, временно перенесённое из исходного файла без обоснования рынком (решение владельца
 * продукта 28.09.2026). Метка — «Экспертное значение», источник — исходный файл, статус — «не подтверждено».
 */
export interface LegacyAssumption {
  param: ParameterId;
  value: unknown;
  /** Ячейки исходного файла, из которых взято значение. */
  cells: string;
  /** Как значение получено из ячеек, словами. */
  derivation: string;
  status: "не подтверждено";
  note: string;
}

const FROM_FILE_NOTE = "Перенесено из исходного файла, без обоснования рынком, требует подтверждения";

/**
 * Рыночный рост цен для расчёта сервиса из исходного файла: 2% в квартал → (1 + 0,02)^4 − 1 = 8,24% в год, на весь
 * срок (after_last = last). Рост по стадиям готовности (SALES.PRICE_STAGE_UPLIFT) — отдельный параметр, отсюда не
 * заполняется: в исходнике рост рынка и надбавка за готовность не разделены.
 */
function legacyMarketGrowth(c: LegacyCase): LegacyAssumption | null {
  const q = c.sales_legacy?.price_growth_quarterly;
  const start = c.project_inputs["GEN.MODEL_START_DATE"];
  if (typeof q !== "number" || typeof start !== "string") return null;
  const annual = new Decimal(1).add(q).pow(QUARTERS_PER_YEAR).sub(1).toNumber();
  return {
    param: "SALES.PRICE_MARKET_GROWTH",
    value: { by_year: { [start.slice(0, 4)]: annual }, after_last: "last" },
    cells: "План продаж!E30,E35,E40,E45,E50,E55",
    derivation: `рост цены ${new Decimal(q).mul(PERCENT).toString()}% в квартал, пересчитан в годовой: (1 + ${q})^4 − 1`,
    status: "не подтверждено",
    note: FROM_FILE_NOTE,
  };
}

/** Значения расчёта сервиса, временно перенесённые из исходного файла (см. LegacyAssumption). */
export function legacyAssumptions(c: LegacyCase): LegacyAssumption[] {
  return [legacyMarketGrowth(c)].filter((x): x is LegacyAssumption => x !== null);
}

/**
 * План продаж исходника → SALES.PRODUCTS, SALES.PACE, SALES.LEGACY_PRICE_GROWTH, SALES.PAYMENT_MIX:
 * - строки: типы квартир (ТЭП: запас = кол-во × средняя площадь, цена ТЭПы!G41:G43), ПСН, машино-места;
 * - темп — ручной квартальный ряд с 1 кв 2026: квартиры шт × средняя площадь, ПСН лоты × площадь лота, м/м — шт;
 * - цена машино-места за штуку = 270 000 руб/м² × 40,945 м² (как в исходнике);
 * - очередь — последняя: в исходнике продажи по очередям не разделены;
 * - структура оплат исходника: ипотека 0,7 — кредит, ПВ 0,2 — первоначальный взнос по ипотеке, 100% оплата 0,1, рассрочки нет →
 *   ипотечные сделки 0,9, из них взнос 0,2, 100% оплата 0,1; в CF1 вся выручка поступает в квартал сделки (CF1!F15);
 * - эскроу и поступления — как в CF1: сделки на эскроу по последний квартал с единицей в CF1!F8:AS8, раскрытие —
 *   квартал с единицей в CF1!F6:AS6 (вбита руками), поступления — по последний столбец с формулой в CF1!F15:AS15.
 */
function legacySales(c: LegacyCase, values: Partial<Record<ParameterId, unknown>>): void {
  const sl = c.sales_legacy;
  const quarters = c.timeline_quarters_F_to_AS ?? [];
  if (!sl || !quarters[0]) return;
  const pi = c.project_inputs;
  const start = pi["GEN.MODEL_START_DATE"];
  const phase = Math.max(...((pi["TIME.MILESTONES"] as { phase: number }[] | undefined) ?? [{ phase: 1 }]).map((r) => r.phase));
  const mix = pi["TEP.APT_MIX"] as { type_name: string; count: number; avg_area: number; start_price: number }[];
  const psn = pi["SALES.PRODUCTS.ПСН"] as { stock_area: number; avg_lot: number; start_price: number };
  const parking = pi["SALES.PRODUCTS.машино-места"] as { price_per_space_calc: number };
  const paceOf = (label: string) => {
    const series = sl.pace_units_quarterly_from_1q2026[label];
    if (!series) throw new Error(`В плане продаж исходника нет ряда «${label}»`);
    return series;
  };
  const products: Record<string, unknown>[] = [];
  const pace: Record<string, unknown>[] = [];
  const add = (row: Record<string, unknown>, values: number[]) => {
    products.push({ phase, price_date: start, sale_channel_before_rnv: "ДДУ_эскроу", ...row });
    pace.push({ name: row.name, method: "ручной", manual: { from: quarters[0], step_months: LEGACY_QUARTER_MONTHS, values } });
  };
  for (const t of mix) {
    const label = Object.keys(sl.pace_units_quarterly_from_1q2026).find((k) => t.type_name.trim().endsWith(k));
    if (!label) throw new Error(`Нет темпа исходника для «${t.type_name}»`);
    add({ name: t.type_name.trim(), product: "квартиры", stock_area: t.count * t.avg_area, start_price: t.start_price }, paceOf(label).map((u) => u * t.avg_area));
  }
  add({ name: "ПСН", product: "ПСН", stock_area: psn.stock_area, start_price: psn.start_price }, paceOf("ПСН").map((u) => u * psn.avg_lot));
  add({ name: "Машино-места", product: "машино-места", stock_units: pi["TEP.PARKING_COUNT_OVERRIDE"], start_price: parking.price_per_space_calc }, paceOf("Машино-места"));
  values["SALES.PRODUCTS"] = products;
  values["SALES.PACE"] = pace;
  values["SALES.LEGACY_PRICE_GROWTH"] = [{ rate: sl.price_growth_quarterly, step_months: LEGACY_QUARTER_MONTHS }];
  for (const a of legacyAssumptions(c)) values[a.param] = a.value;
  const pm = pi["SALES.PAYMENT_MIX"] as { installment: number; mortgage: number; full: number; down_payment: number; installment_quarters: number };
  const types = [...new Set(products.map((r) => r.product as string))];
  const mortgageDeals = new Decimal(pm.mortgage).add(pm.down_payment);
  values["SALES.PAYMENT_MIX"] = types.map((product) => ({
    product,
    mortgage_share: mortgageDeals.toNumber(),
    mortgage_down_payment: pm.down_payment,
    full_payment_share: pm.full,
    installment_share: pm.installment,
    installment_months: pm.installment_quarters * LEGACY_QUARTER_MONTHS,
    installment_down_payment: 0,
  }));
  const cf1 = c.legacy_checks?.cf1;
  if (cf1) {
    const lastOne = (xs: number[]) => xs.reduce((acc: number, v, i) => (v ? i : acc), -1);
    const at = (i: number) => (i >= 0 ? quarters[i] : undefined);
    const dduEnd = at(lastOne(cf1.escrow_deposit_row8));
    const release = at(cf1.escrow_release_row6.findIndex((v) => v === 1));
    const cashEnd = at(cf1.revenue_row15_last_formula_col);
    if (dduEnd) values["TIME.LEGACY_ESCROW_DEPOSIT_END"] = dduEnd;
    if (release) values["TIME.LEGACY_ESCROW_RELEASE_DATE"] = release;
    if (cashEnd) values["SALES.LEGACY_CASH_IN_END"] = cashEnd;
  }
}

/**
 * Ставки кредита исходника: ключевая CF1!D115 — одна на весь срок; базовая CF1!D117 задана целиком, в ядре базовая =
 * ключевая + спред, поэтому спред = D117 − D115 (20% − 14,25% = 5,75 п.п.) — базовая ставка получается та же.
 */
function legacyFin(c: LegacyCase, values: Partial<Record<ParameterId, unknown>>): void {
  const key = c.project_inputs["FIN.KEY_RATE_legacy"];
  const base = c.project_inputs["FIN.RATE_BASE_legacy"];
  if (typeof key === "number") values["FIN.LEGACY_KEY_RATE"] = key;
  if (typeof key === "number" && typeof base === "number") values["FIN.RATE_BASE_SPREAD"] = new Decimal(base).sub(key).toNumber();
}

/**
 * Входы кейса исходного Excel → ProjectInput в расчёте «как в исходном Excel».
 * Ключи, которые не являются ID параметров (…_legacy, *_TEXT, SALES.PRODUCTS.<продукт>), здесь не нужны.
 * Нормы машино-мест исходника заданы по типам квартир (TEP.APT_MIX.parking_norm) → TEP.PARKING_NORM, rule = per_type.
 */
export function legacyCaseInput(c: LegacyCase): ProjectInput {
  const values: Partial<Record<ParameterId, unknown>> = {};
  for (const [key, value] of Object.entries(c.project_inputs)) if (isParameterId(key)) values[key] = value;
  const mix = c.project_inputs["TEP.APT_MIX"] as { type_name: string; count: number; avg_area: number; parking_norm: number }[];
  values["TEP.APT_MIX"] = mix.map(({ type_name, count, avg_area }) => ({ type_name, count, avg_area }));
  values["TEP.PARKING_NORM"] = { rule: "per_type", values: mix.map((r) => r.parking_norm) };
  if (c.capex_legacy) values["CAPEX.ITEMS"] = legacyCapex(c, values);
  legacySales(c, values);
  legacyFin(c, values);
  return { values, mode: "legacy" };
}
