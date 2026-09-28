/**
 * Вопросы к данным: каждое предупреждение расчёта «как в исходном Excel» (CalcMessage.key) → вопрос к авторам исходного Excel
 * простым языком: что смутило систему, влияние в рублях, рекомендация (решение владельца продукта 27.09.2026).
 * Один механизм: вопросы строятся только из предупреждений расчёта и проверок исходника (legacyChecks), тексты —
 * по шаблону на каждый тип расхождения из чисел расчёта и ячеек исходника, а не вручную.
 *
 * Влияние — разница «значение Excel − исправленное (расчёт сервиса)» для того, что меняется: выручка, расходы или
 * сроки денег (для сроков — сумма, которая сдвигается). Знак «+» — в Excel больше, «−» — меньше.
 */
import Decimal from "decimal.js";
import { getCapexItem, getParameter, isCapexItemId, type FormulaId, type ParameterId } from "@fm/spec";
import type { LegacyCase } from "./legacy";
import { isIsoDate, monthDiff, type IsoDate } from "./lib/dates";
import { fmt, fmtQuarter, fmtRub, fmtShare } from "./lib/format";
import type { CalcMessage, ProjectInput, ResultSet } from "./types";

export type QuestionBlock = "sales" | "budget" | "cf" | "escrow" | "fin";
/** «зависит» — сумма, которая зависит от значения (для стандартных значений компании), без знака «Excel − исправленное». */
export type ImpactKind = "выручка" | "расходы" | "поступления" | "расходы в CF" | "сроки денег" | "зависит" | "нет";

export interface Impact {
  /** Excel − исправленное, руб.; для сроков денег — сдвигаемая сумма; null — оценить нельзя. */
  amount: Decimal | null;
  kind: ImpactKind;
  text: string;
}

export interface DataQuestion {
  /** Постоянный ключ предупреждения (CalcMessage.key). */
  key: string;
  /** Постоянный номер пункта. */
  no: number;
  block: QuestionBlock;
  question: string;
  /**
   * Пояснение простым языком (2–3 предложения, без формул): что с чем сравнивалось и где (лист!ячейка), на сколько
   * не сошлось, чем грозит результату и что уточнить. Собирается из compared + threat + question.
   */
  summary: string;
  /** Что с чем сравнивалось, какие значения не сошлись и на сколько; ячейки — в скобках. */
  compared: string;
  /** Чем расхождение грозит результату, в рублях, где можно оценить. */
  threat: string;
  /** Подробности: почему так вышло в файле; 1–3 предложения, ячейки — в конце в скобках. */
  explanation: string;
  impact: Impact;
  recommendation: string;
  formulaId: FormulaId;
  /** Параметр, о котором вопрос (стандартное значение компании): «как посчитано» открывает его карточку. */
  parameterId?: ParameterId;
  /** Текст предупреждения расчёта, из которого построен вопрос. */
  warning: string;
}

/**
 * Постоянные номера пунктов (порядок первого списка, согласованного с владельцем продукта). Новые ключи получают
 * номера после последнего, по алфавиту ключа.
 */
const NUMBERS: Record<string, number> = {
  "SALES.OVER_STOCK:ПСН": 1,
  "LEGACY.PSN_STOCK": 2,
  "LEGACY.MARKETING_F51": 3,
  "LEGACY.CONTINGENCY_F42": 4,
  "CAPEX.SCHEDULE_SUM:OTHER_SMR": 5,
  "CAPEX.SCHEDULE_SUM:ROADS_UDS": 6,
  "CAPEX.SCHEDULE_SUM:CONTINGENCY": 7,
  "CAPEX.SCHEDULE_SUM:MARKETING": 8,
  "CAPEX.SCHEDULE_SUM:BROKERAGE": 9,
  "SALES.CASH_IN_CUT": 10,
  "LEGACY.CF1_LAG": 11,
  "LEGACY.ESCROW_DATE": 12,
  "LEGACY.FIN_DRAW_REPAID": 13,
  "LEGACY.FIN_INTEREST": 14,
  "LEGACY.FIN_RATE": 15,
  "LEGACY.FIN_PIK_SIGN": 16,
  "LEGACY.FIN_EQUITY": 17,
  "LEGACY.FIN_FEE_BASE": 18,
  "LEGACY.FIN_EFF_RATE": 19,
};

/** Последний постоянный номер пункта по исходному Excel: номера следующих вопросов (стандарт компании) идут после него. */
export const LEGACY_QUESTION_MAX_NO = Math.max(...Object.values(NUMBERS));

/** Строки темпа продаж исходника (План продаж) по строкам продуктов, для ссылок на ячейки. */
const PACE_ROWS: Record<string, string> = { ПСН: "План продаж!E43:AM43" };

type Amounts = Record<string, Decimal>;
type Series = Record<string, Decimal[]>;

const ZERO = new Decimal(0);
const sum = (xs: Decimal[] | undefined) => (xs ?? []).reduce((s, x) => s.add(x), ZERO);
const nsum = (xs: number[]) => xs.reduce((s, x) => s.add(x), ZERO);
const lastNonZero = (xs: number[]) => xs.reduce((acc: number, v, i) => (v ? i : acc), -1);

/** «2 кв 2032» → 2032-06-30. */
function quarterEnd(text: string): IsoDate | null {
  const m = /(\d)\s*кв\s*(\d{4})/.exec(text);
  if (!m) return null;
  const monthsInQuarter = 3;
  const month = Number(m[1]) * monthsInQuarter;
  const last = new Date(Date.UTC(Number(m[2]), month, 0)).getUTCDate();
  return `${m[2]}-${String(month).padStart(2, "0")}-${String(last).padStart(2, "0")}` as IsoDate;
}

/** Чем грозит расхождение — по типу влияния, из суммы «Excel − исправленное». */
function threatOf(impact: Impact): string {
  const a = impact.amount;
  if (!a) return impact.kind === "выручка" ? "Выручка в Excel может быть завышена, сумму оценить нельзя." : "Влияние на суммы оценить нельзя.";
  if (a.isZero()) return "На суммы не влияет.";
  const x = fmtRub(a);
  const more = a.gt(0);
  switch (impact.kind) {
    case "выручка":
      return `Выручка в Excel может быть ${more ? "завышена" : "занижена"} на ~${x}.`;
    case "расходы":
      return `Расходы в Excel ${more ? "завышены" : "занижены"} на ~${x}.`;
    case "расходы в CF":
      return more
        ? `В денежный поток Excel попадает на ~${x} расходов больше, чем в бюджете, и он выглядит хуже, чем есть.`
        : `В денежном потоке Excel не хватает ~${x} расходов, и он выглядит лучше, чем есть.`;
    case "поступления":
      return more ? `В денежный поток Excel попадает на ~${x} поступлений больше, чем по плану продаж.` : `В денежный поток Excel не попадает ~${x} поступлений.`;
    default:
      return impact.text;
  }
}

function signed(excelMinusFixed: Decimal, kind: ImpactKind, more: string, less: string): Impact {
  const text = excelMinusFixed.isZero() ? "не влияет на суммы" : `${kind}: ${excelMinusFixed.gt(0) ? more : less} на ~${fmtRub(excelMinusFixed)}`;
  return { amount: excelMinusFixed, kind, text };
}

/** Вопросы по предупреждениям расчёта «как в исходном Excel» (сообщения с ключом), в порядке номеров. */
export function dataQuestions(c: LegacyCase, input: ProjectInput, result: ResultSet): DataQuestion[] {
  const f = result.formulas;
  const lc = c.legacy_checks;
  const total = (f["F.CAPEX.ITEM_TOTAL"]?.value ?? {}) as Amounts;
  const cash = (f["F.CAPEX.ITEM_CASH"]?.value ?? {}) as Series;
  const sold = (f["F.SALES.SOLD_AREA"]?.value ?? {}) as Series;
  const wavg = (f["F.SALES.WAVG_PRICE"]?.value ?? {}) as Record<string, Decimal | null>;
  const revenue = (f["F.SALES.REVENUE_TOTAL"]?.value as { gross: Decimal } | undefined)?.gross ?? null;
  const cashIn = (f["F.SALES.CASH_IN"]?.value as { total: Series } | undefined)?.total ?? {};
  const deposits = (f["F.ESC.DEPOSIT"]?.value ?? []) as Decimal[][];
  const quarters = c.timeline_quarters_F_to_AS ?? [];
  const budgetRow = (id: string) => c.capex_legacy?.find((x) => x.item_id === id);
  const cells = (id: string) => {
    const lg = budgetRow(id);
    const cfRow = lg?.manual_schedule_quarterly?.cf_row ?? lg?.cf_amounts_quarterly?.cf_row;
    return [lg?.budget_row ? `Бюджет!F${lg.budget_row}` : null, cfRow ? `CF1 строка ${cfRow}` : null].filter(Boolean).join(", ");
  };
  const itemName = (id: string) => (isCapexItemId(id) ? getCapexItem(id).name : id);
  const lag = Number(input.values["TIME.ESCROW_RELEASE_LAG_M"] ?? input.standard?.["TIME.ESCROW_RELEASE_LAG_M"] ?? getParameter("TIME.ESCROW_RELEASE_LAG_M").default ?? 0) || null;

  type Built = Omit<DataQuestion, "key" | "no" | "formulaId" | "warning" | "summary" | "threat"> & { threat?: string };
  const build = (m: CalcMessage): Built => {
    const key = m.key as string;
    const [kind, arg = ""] = key.split(":");

    if (kind === "SALES.OVER_STOCK") {
      // площади — целыми м² (с отбрасыванием дробной части лотов, как в аудите исходника); влияние — по точной разнице
      const s = sum(sold[arg]).floor();
      const stock = new Decimal(arg === "ПСН" && lc ? lc.tep.psn_stock_C23 : 0);
      const excess = s.sub(stock);
      const exact = sum(sold[arg]).sub(stock);
      const price = wavg[arg] ?? null;
      const typed = PACE_ROWS[arg];
      const refs = [typed, arg === "ПСН" ? "ТЭПы!C23" : null].filter(Boolean).join(", ") || "План продаж";
      return {
        compared: `По плану продаж продаётся ${fmt(s)} м² ${arg}, а построено ${fmt(stock)} м² — на ${fmt(excess)} м² больше (${refs}).`,
        block: "sales",
        question: `Сколько ${arg} построено и откуда взят темп продаж?`,
        explanation: `По плану продаётся ${fmt(s)} м², а построено ${fmt(stock)} м² — на ${fmt(excess)} м² больше.${typed ? " Темп введён в файл числами, и ни одна ячейка не даёт эти цифры" : ""} (${refs}).`,
        impact: price ? signed(exact.mul(price), "выручка", "завышена", "занижена") : { amount: null, kind: "выручка", text: "выручка завышена" },
        recommendation: `По плану продаж ${arg} получается ${fmt(s)} м², а построено ${fmt(stock)} м². Лишние ${fmt(excess)} м² в расчёт не попадают. Уменьшите темп или проверьте площадь ${arg} в ТЭПах.`,
      };
    }
    if (kind === "LEGACY.PSN_STOCK" && lc) {
      const t = lc.tep;
      const diff = new Decimal(t.psn_stock_C48).sub(t.psn_stock_C23);
      const price = wavg["ПСН"] ?? null;
      const saleable = new Decimal(t.apt_area_C22).add(t.psn_stock_C23);
      return {
        compared: `Площадь ПСН к продаже в ТЭПах указана дважды: ${fmt(t.psn_stock_C23)} и ${fmt(t.psn_stock_C48)} м², разница ${fmt(diff.abs())} м² (ТЭПы!C23, C48).`,
        threat: price ? `В зависимости от ответа выручка изменится на ±~${fmtRub(diff.abs().mul(price))}.` : "Выручка зависит от ответа, сумму оценить нельзя.",
        block: "sales",
        question: "Какая площадь ПСН к продаже и какая продаваемая площадь верны?",
        explanation: `Площадь ПСН к продаже указана дважды по-разному: ${fmt(t.psn_stock_C23)} и ${fmt(t.psn_stock_C48)} м². Продаваемая площадь ${fmt(t.saleable_area_C35)} м² введена числом, а квартиры и ПСН вместе дают ${fmt(saleable)} м² (ТЭПы!C23, C48, C35).`,
        impact: price
          ? { amount: diff.abs().mul(price), kind: "выручка", text: `выручка: ±~${fmtRub(diff.abs().mul(price))} в зависимости от ответа; продаваемая площадь в суммы не входит` }
          : { amount: null, kind: "выручка", text: "зависит от ответа" },
        recommendation: `В модели площадь ПСН к продаже = ${fmt(t.psn_stock_C23)} м² (ТЭПы!C23), продаваемая площадь считается как квартиры + ПСН. Подтвердите площадь ПСН.`,
      };
    }
    if (kind === "LEGACY.MARKETING_F51" && lc) {
      const b = lc.budget;
      const rev = nsum(lc.sales_plan.revenue_row25_from_1q2026);
      const byRate = rev.mul(b.marketing_rate_D51);
      const diff = new Decimal(b.marketing_F51).sub(byRate);
      return {
        compared: `Маркетинг в бюджете введён числом ${fmtRub(b.marketing_F51)}, а ${fmtShare(new Decimal(b.marketing_rate_D51))} от выручки по плану продаж дают ${fmtRub(byRate)} — на ${fmtRub(diff)} ${diff.gt(0) ? "меньше" : "больше"} (Бюджет!F51, План продаж строка 25).`,
        block: "budget",
        question: "Откуда взята сумма маркетинга в бюджете?",
        explanation: `Маркетинг введён числом ${fmtRub(b.marketing_F51)}, а не как ${fmtShare(new Decimal(b.marketing_rate_D51))} от выручки. Такое число получается из выручки ${fmtRub(new Decimal(b.marketing_F51).div(b.marketing_rate_D51))}, которой в файле нет: по плану продаж выручка ${fmtRub(rev)} (Бюджет!F51).`,
        impact: signed(new Decimal(b.marketing_F51).sub(byRate), "расходы", "завышены", "занижены"),
        recommendation: `Считать маркетинг как ${fmtShare(new Decimal(b.marketing_rate_D51))} от выручки (${fmtRub(byRate)}); в расчёте сервиса так и сделано. Подтвердите ставку.`,
      };
    }
    if (kind === "LEGACY.CONTINGENCY_F42" && lc) {
      const b = lc.budget;
      const product = new Decimal(b.contingency_E42).mul(b.contingency_D42);
      return {
        compared: `Резерв в бюджете Excel — ${fmtRub(b.contingency_F42)}: площадь сложена со ставкой. Если их перемножить, как задумал автор, получится ${fmtRub(product)} (Бюджет!F42).`,
        block: "budget",
        question: "Правильно ли посчитан резерв на непредвиденные расходы?",
        explanation: `Площадь сложена со ставкой вместо умножения: ${fmt(Math.round(b.contingency_E42))} + ${fmt(Math.round(b.contingency_D42))} = ${fmt(Math.round(b.contingency_F42))} ₽. При умножении получается ${fmtRub(product)} (Бюджет!F42).`,
        impact: signed(new Decimal(b.contingency_F42).sub(product), "расходы", "завышены", "занижены"),
        recommendation: "Подтвердить, что резерв — площадь × ставку, а ставка — 10% от ставок СМР. В расчёте сервиса резерв — 2% стоимости СМР по методике Минстроя 421/пр.",
      };
    }
    if (kind === "CAPEX.SCHEDULE_SUM") {
      const amount = total[arg] ?? ZERO;
      const inCf = sum(cash[arg]);
      const share = amount.isZero() ? ZERO : inCf.div(amount);
      const name = itemName(arg);
      const impact = signed(inCf.sub(amount), "расходы в CF", "завышены", "занижены");
      const compared = `В бюджете «${name}» — ${fmtRub(amount)}, а в денежный поток CF1 попадает ${inCf.isZero() ? "0 ₽" : `${fmtRub(inCf)} (${fmtShare(share)})`}, разница ${fmtRub(inCf.sub(amount))} (${cells(arg)}).`;
      if (arg === "MARKETING") {
        return {
          compared,
          block: "cf",
          question: "Какую сумму маркетинга считать верной: из бюджета или из CF?",
          explanation: `В бюджете маркетинг ${fmtRub(amount)}, а в CF1 платежи считаются как 3,5% от выручки по кварталам и дают ${fmtRub(inCf)} — ${fmtShare(share)} бюджета. Связано с №3 и №11 (${cells(arg)}).`,
          impact,
          recommendation: "В расчёте сервиса бюджет и CF совпадают: маркетинг — доля выручки, платежи идут вместе с продажами.",
        };
      }
      if (arg === "BROKERAGE") {
        return {
          compared,
          block: "cf",
          question: "Почему в денежный поток попадает только часть брокериджа?",
          explanation: `Брокеридж в бюджете ${fmtRub(amount)}, а в CF1 — ${fmtRub(inCf)} (${fmtShare(share)}). Ссылки строки брокериджа сначала сдвинуты на 7 кварталов, потом идут без сдвига, поэтому 7 кварталов продаж остаются без брокериджа. Связано с №11 (${cells(arg)}).`,
          impact,
          recommendation: "В расчёте сервиса брокеридж платится при каждой сделке, по графику продаж, и в CF попадает вся сумма бюджета.",
        };
      }
      if (share.isZero()) {
        const lg = budgetRow(arg);
        const hasRow = Boolean(lg?.manual_schedule_quarterly || lg?.cf_amounts_quarterly);
        return {
          compared,
          block: "cf",
          question: `Должна ли статья «${name}» попадать в денежный поток?`,
          explanation: `В бюджете статья стоит ${fmtRub(amount)}, но в CF1 её платежей нет: ${hasRow ? "доли графика не проставлены" : "для неё нет строки"}. Расход есть в бюджете, но не уменьшает денежный поток (${cells(arg)}).`,
          impact,
          recommendation: "В расчёте сервиса статья платится вслед за СМР и полностью попадает в денежный поток. Подтвердите сумму и график.",
        };
      }
      return {
        compared,
        block: "cf",
        question: `Почему «${name}» в денежном потоке ${share.gt(1) ? "больше" : "меньше"}, чем в бюджете?`,
        explanation: `Доли графика в CF1 в сумме дают ${fmtShare(share)}, а не 100%: в CF попадает ${fmtRub(inCf)} при бюджете ${fmtRub(amount)}${arg === "CONTINGENCY" ? "; сама сумма резерва тоже под вопросом, см. №4" : ""} (${cells(arg)}).`,
        impact,
        recommendation: "В расчёте сервиса доли графика равны 100%, и в CF попадает ровно сумма бюджета.",
      };
    }
    if (kind === "SALES.CASH_IN_CUT" && lc && revenue) {
      const inCf = Object.values(cashIn).reduce((s, x) => s.add(sum(x)), ZERO);
      const end = input.values["SALES.LEGACY_CASH_IN_END"];
      const lastSale = quarters[lastNonZero(lc.sales_plan.revenue_row25_from_1q2026)];
      return {
        compared: `По плану продаж выручка ${fmtRub(revenue)}, а в денежный поток CF1 попадает ${fmtRub(inCf)} — на ${fmtRub(inCf.sub(revenue))} ${inCf.lt(revenue) ? "меньше" : "больше"} (CF1 строка 15, План продаж строка 25).`,
        block: "cf",
        question: `Почему в денежный поток не попадает выручка${typeof end === "string" ? ` после ${fmtQuarter(end)}` : ""}?`,
        explanation: `Строка доходов CF1 ссылается на план продаж только${typeof end === "string" ? ` до ${fmtQuarter(end)}` : " до части кварталов"}, а продажи идут${lastSale ? ` до ${fmtQuarter(lastSale)}` : " дольше"}. В CF попадает ${fmtRub(inCf)} вместо ${fmtRub(revenue)} (CF1 строка 15, План продаж строка 25).`,
        impact: signed(inCf.sub(revenue), "поступления", "завышены", "занижены"),
        recommendation: "Похоже на недотянутую формулу. В расчёте сервиса учитываются все поступления.",
      };
    }
    if (kind === "LEGACY.CF1_LAG" && lc) {
      const s0 = lc.sales_plan.revenue_row25_from_1q2026.findIndex((v) => v !== 0);
      const b0 = lc.cf1.brokerage_row78.findIndex((v) => v !== 0);
      const monthsInQuarter = 3;
      const moved = sum(cash.MARKETING).add(sum(cash.BROKERAGE));
      const firstSale = quarters[s0];
      const firstPay = quarters[b0];
      return {
        compared: `Первые продажи идут в ${firstSale ? fmtQuarter(firstSale) : "первом квартале продаж"}, а платежи по маркетингу и брокериджу в CF1 начинаются в ${firstPay ? fmtQuarter(firstPay) : "более позднем квартале"} — на ${b0 - s0} кв. позже (План продаж строка 25, CF1 строки 78 и 79).`,
        threat: `~${fmtRub(moved)} расходов в Excel платятся на ~${(b0 - s0) * monthsInQuarter} мес. позже, поэтому потребность в финансировании в Excel может быть занижена.`,
        block: "cf",
        question: "Когда на самом деле платятся маркетинг и брокеридж?",
        explanation: `В CF1 платежи по маркетингу и брокериджу начинаются на ${b0 - s0} кварталов позже первых продаж. Брокеридж платится при сделке, маркетинг — до продаж или вместе с ними (CF1 строки 78 и 79).`,
        impact: { amount: moved, kind: "сроки денег", text: `сроки денег: ~${fmtRub(moved)} расходов сдвинуты на ~${(b0 - s0) * monthsInQuarter} мес. позже` },
        recommendation: "В расчёте сервиса оба платежа идут по графику продаж, без сдвига.",
      };
    }
    if (kind === "LEGACY.ESCROW_DATE" && lc) {
      const text = String(lc.tep.escrow_release_C12);
      const planned = quarterEnd(text);
      const released = input.values["TIME.LEGACY_ESCROW_RELEASE_DATE"];
      const months = planned && typeof released === "string" && isIsoDate(released) ? monthDiff(released, planned) : null;
      const dep = deposits.reduce((s, d) => s.add(sum(d)), ZERO);
      return {
        compared: `В ТЭПах эскроу раскрывается «${text}», а в CF1 раскрытие стоит вручную${typeof released === "string" ? ` в ${fmtQuarter(released)}` : ""}${months ? ` — на ${Math.abs(months)} мес. ${months > 0 ? "раньше" : "позже"}` : ""} (ТЭПы!C12, CF1 строки 6 и 8).`,
        threat: `~${fmtRub(dep)} эскроу приходят ${months && months < 0 ? "позже" : "раньше"}, чем по ТЭПам, поэтому проценты по проектному финансированию в Excel могут быть ${months && months < 0 ? "завышены" : "занижены"}.`,
        block: "escrow",
        question: `Когда раскрывается эскроу — ${typeof released === "string" ? fmtQuarter(released) : "по CF1"} или ${text}?`,
        explanation: `В ТЭПах срок записан текстом «${text}», формулы его не видят. В CF1 раскрытие стоит вручную${typeof released === "string" ? ` в ${fmtQuarter(released)}` : ""}, а взносы после этой даты обнулены (ТЭПы!C12, CF1 строки 6 и 8).`,
        impact: {
          amount: dep,
          kind: "сроки денег",
          text: `сроки денег: ~${fmtRub(dep)} эскроу${months ? ` раскрываются на ~${months} мес. ${months > 0 ? "раньше" : "позже"} срока в ТЭПах` : ""}; меняются проценты по ПФ`,
        },
        recommendation: `Уточнить плановую дату РНВ; в расчёте сервиса раскрытие = РНВ + ${lag ?? "лаг"} мес.`,
      };
    }
    const fin = finQuestion(kind ?? "", c, result);
    if (fin) return fin;
    return {
      compared: m.text,
      block: m.formulaId.startsWith("F.SALES.") ? "sales" : m.formulaId.startsWith("F.ESC.") ? "escrow" : m.formulaId.startsWith("F.FIN.") ? "fin" : "budget",
      question: "Что в этом месте файла верно?",
      explanation: m.text,
      impact: { amount: null, kind: "нет", text: "не оценено" },
      recommendation: "В расчёте сервиса это место считается по правилам модели.",
    };
  };

  const warnings = result.messages.filter((m) => m.severity === "warning" && m.key);
  const known = Math.max(...Object.values(NUMBERS));
  const extra = warnings.map((m) => m.key as string).filter((k) => !(k in NUMBERS)).sort();
  return warnings
    .map((m) => {
      const b = build(m);
      const threat = b.threat ?? threatOf(b.impact);
      return {
        key: m.key as string,
        no: NUMBERS[m.key as string] ?? known + 1 + extra.indexOf(m.key as string),
        formulaId: m.formulaId,
        warning: m.text,
        ...b,
        threat,
        summary: [b.compared, threat, b.question].join(" "),
      };
    })
    .sort((a, b) => a.no - b.no);
}

type FinBuilt = Omit<DataQuestion, "key" | "no" | "formulaId" | "warning" | "summary" | "threat"> & { threat?: string };

/** Вопросы по кредиту CF1 (строки 98–132): числа — из расчёта «как в исходном Excel», который повторяет CF1. */
function finQuestion(kind: string, c: LegacyCase, result: ResultSet): FinBuilt | null {
  const f = result.formulas;
  const lf = c.legacy_checks?.fin;
  const draw = (f["F.FIN.DRAW"]?.value ?? []) as Decimal[];
  const interest = (f["F.FIN.INTEREST"]?.value ?? []) as Decimal[];
  const rate = (f["F.FIN.RATE"]?.value ?? []) as Decimal[];
  const rep = f["F.FIN.REPAYMENT"]?.value as { interest_paid: Decimal[] } | undefined;
  const equity = f["F.FIN.EQUITY_IN"]?.value as { total: Decimal[] } | undefined;
  const fees = (f["F.FIN.FEES"]?.value ?? []) as Decimal[];
  const date = (f["F.TIME.DATE"]?.value ?? []) as IsoDate[];
  const drawn = sum(draw);
  const accrued = sum(interest);
  const paid = sum(rep?.interest_paid);
  const paidAt = (rep?.interest_paid ?? []).findIndex((x) => !x.isZero());
  if (kind === "LEGACY.FIN_DRAW_REPAID") {
    return {
      compared: `Кредит в CF1 выдаётся на все расходы квартала вместе с собственными средствами и в том же квартале гасится: выдано и погашено ${fmtRub(drawn)}, долг на конец каждого квартала 0 (CF1 строки 98, 100, 106).`,
      threat: "Долг, проценты и сроки погашения в Excel не отражают кредит, который нужен проекту.",
      block: "fin",
      question: "Как кредит должен выдаваться и гаситься в модели?",
      explanation: `Строка погашения берёт большее из раскрытого эскроу и суммы долга с выдачей квартала, поэтому вся выдача сразу гасится, хотя эскроу ещё не раскрыто (CF1 строки 98, 100, 106).`,
      impact: { amount: null, kind: "нет", text: `выдано и сразу погашено ${fmtRub(drawn)}; долг в Excel всегда 0` },
      recommendation: "В расчёте сервиса кредит выдаётся на потребность месяца после собственного участия и гасится из раскрытого эскроу.",
    };
  }
  if (kind === "LEGACY.FIN_INTEREST") {
    return {
      compared: `При долге 0 на конец каждого квартала в CF1 начислено процентов на ${fmtRub(accrued)}: они считаются от половины выдачи квартала (в первом квартале — от всей выдачи) плюс проценты прошлого квартала (CF1 строки 97, 107).`,
      threat: `Сумма процентов ${fmtRub(accrued)} не связана с настоящим долгом.`,
      block: "fin",
      question: "На какой остаток долга начислять проценты?",
      explanation: `Проценты должны начисляться на остаток долга вместе с уже начисленными процентами. В CF1 к половине выдачи прибавляются проценты только прошлого квартала, а в первом квартале ячейка начального долга пустая (CF1 строки 97, 107).`,
      impact: { amount: null, kind: "нет", text: `проценты в Excel ${fmtRub(accrued)} при нулевом долге` },
      recommendation: "В расчёте сервиса проценты начисляются на средний долг месяца и накопленные проценты.",
    };
  }
  if (kind === "LEGACY.FIN_RATE") {
    const max = rate.reduce((m, x) => Decimal.max(m, x), ZERO);
    const tMax = rate.findIndex((x) => x.eq(max));
    return {
      compared: `Ставка кредита в CF1 доходит до ${fmtShare(max)} годовых${date[tMax] ? ` в ${fmtQuarter(date[tMax] as IsoDate)}` : ""}, хотя должна быть между льготной 5% и базовой 20% (CF1 строки 122, 125).`,
      threat: "Проценты в Excel посчитаны по ставке, которой не бывает в кредитном договоре.",
      block: "fin",
      question: "Какой знак у долга и процентов в расчёте покрытия эскроу?",
      explanation: "Покрытие долга эскроу делится на проценты, записанные со знаком минус, и получается отрицательным. Отрицательное покрытие увеличивает ставку в разы (CF1 строки 110, 122, 125).",
      impact: { amount: null, kind: "нет", text: `ставка до ${fmtShare(max)} годовых` },
      recommendation: "В расчёте сервиса покрытие считается от положительного долга с процентами, ставка — между льготной и базовой.",
    };
  }
  if (kind === "LEGACY.FIN_PIK_SIGN") {
    return {
      compared: `При раскрытии эскроу${date[paidAt] ? ` в ${fmtQuarter(date[paidAt] as IsoDate)}` : ""} CF1 «оплачивает» проценты ${fmtRub(paid)}, но они попадают в поток по кредиту со знаком плюс, как поступление денег (CF1 строки 108, 113).`,
      threat: `Денежный поток Excel завышен на ~${fmtRub(paid)}: проценты увеличивают остаток денег вместо того, чтобы уменьшать его.`,
      block: "fin",
      question: "Должны ли проценты при раскрытии эскроу уменьшать деньги проекта?",
      explanation: "Проценты в CF1 записаны со знаком минус, а в потоке по кредиту они ещё раз вычитаются. Раскрытое эскроу на погашение не идёт, а договоры купли-продажи кредит не гасят (CF1 строки 100, 101, 108, 113).",
      impact: { amount: paid, kind: "поступления", text: `поступления: завышены на ~${fmtRub(paid)}` },
      recommendation: "В расчёте сервиса проценты платятся из раскрытого эскроу и уменьшают деньги проекта.",
    };
  }
  if (kind === "LEGACY.FIN_EQUITY") {
    const total = sum(equity?.total);
    return {
      compared: `Собственные средства в CF1 — 10% расходов каждого квартала, всего ${fmtRub(total)}; в первом квартале — только комиссия за выдачу (CF1 строка 132).`,
      threat: "Кредит в Excel начинает выдаваться раньше, чем застройщик внёс собственное участие, поэтому сроки и сумма долга занижены.",
      block: "fin",
      question: "Какое собственное участие требует банк и когда его вносить?",
      explanation: "Банк требует внести собственное участие до первой выдачи кредита. В CF1 собственные средства идут долей от расходов каждого квартала параллельно с кредитом (CF1 строка 132).",
      impact: { amount: total, kind: "сроки денег", text: `сроки денег: собственные средства ${fmtRub(total)} внесены позже, чем требует банк` },
      recommendation: "В расчёте сервиса собственное участие вносится вперёд, до первой выдачи; долю подтвердите по кредитному решению банка.",
    };
  }
  if (kind === "LEGACY.FIN_FEE_BASE") {
    const fee = sum(fees);
    return {
      compared: `Комиссия за выдачу в CF1 ${fmtRub(fee)} посчитана от «лимита» ${lf ? fmtRub(lf.limit_F67) : "из бюджета"}, куда входят участок и налоги (Бюджет!F67, CF1 строка 111).`,
      threat: "Комиссия в Excel завышена на долю участка и налогов в «лимите».",
      block: "fin",
      question: "Какой лимит кредита в кредитном решении банка?",
      explanation: "Лимит в бюджете — сумма СМР, ПИР, участка, коммерческих расходов и налогов. Участок оплачивается собственными средствами и в лимит не входит (Бюджет!F67, CF1 строка 111).",
      impact: { amount: null, kind: "расходы", text: "комиссия зависит от лимита по кредитному решению" },
      recommendation: "В расчёте сервиса лимит — бюджет за вычетом собственного участия, комиссия — процент от него при открытии кредита.",
    };
  }
  if (kind === "LEGACY.FIN_EFF_RATE") {
    return {
      compared: `Эффективная ставка кредита в CF1 не считается и показывает ошибку #NUM!: в потоке по кредиту для банка есть только одна сумма ${fmtRub(paid)} при раскрытии эскроу (CF1!D128, строка 127).`,
      threat: "Полную стоимость кредита по Excel оценить нельзя.",
      block: "fin",
      question: "Нужна ли полная стоимость кредита в отчёте?",
      explanation: "Выдачи гасятся в том же квартале, поэтому в потоке для банка нет выдач и погашений разного знака, и функция доходности не находит решения (CF1!D128).",
      impact: { amount: null, kind: "нет", text: "показатель не считается" },
      recommendation: "В расчёте сервиса полная стоимость кредита считается по датам выдач, погашений и комиссий.",
    };
  }
  return null;
}
