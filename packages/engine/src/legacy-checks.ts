/**
 * Проверки расчёта «как в исходном Excel»: расхождения внутри исходного Excel, которые видны только по его ячейкам
 * (legacy_checks кейса). Расчёт «как в исходном Excel» воспроизводит исходник один в один, а эти места выводит предупреждениями
 * (решение владельца продукта 27.09.2026). У каждого предупреждения — постоянный ключ (key): по нему оно связывается
 * с вопросом к данным. Расхождения, которые видит сам расчёт (продажи сверх запаса, график статьи ≠ 100%,
 * поступления после конца CF1), выдают формулы ядра с такими же ключами.
 */
import Decimal from "decimal.js";
import type { LegacyCase } from "./legacy";
import { fmt, fmtQuarter, fmtShare } from "./lib/format";
import type { CalcMessage } from "./types";

const firstNonZero = (xs: number[]) => xs.findIndex((v) => v !== 0);

export function legacyChecks(c: LegacyCase): CalcMessage[] {
  const lc = c.legacy_checks;
  if (!lc) return [];
  const out: CalcMessage[] = [];
  const warn = (m: Omit<CalcMessage, "severity">) => out.push({ severity: "warning", ...m });

  // Запас ПСН указан по-разному: ТЭПы!C23 и C48; продаваемая площадь C35 вбита числом и не равна квартиры + ПСН
  const { tep } = lc;
  const saleable = new Decimal(tep.apt_area_C22).add(tep.psn_stock_C23);
  if (tep.psn_stock_C23 !== tep.psn_stock_C48 || (tep.saleable_area_C35_formula === null && !saleable.eq(tep.saleable_area_C35))) {
    warn({
      formulaId: "F.SALES.SOLD_AREA",
      parameterId: "SALES.PRODUCTS",
      key: "LEGACY.PSN_STOCK",
      text: `Запас ПСН в исходнике указан по-разному: ТЭПы!C23 = ${fmt(tep.psn_stock_C23)} м², ТЭПы!C48 = ${fmt(tep.psn_stock_C48)} м²; продаваемая площадь ТЭПы!C35 = ${fmt(tep.saleable_area_C35)} м² вбита числом, а квартиры + ПСН = ${fmt(saleable)} м²`,
    });
  }

  // ГНС: жилая + нежилая больше наземной (ТЭПы!C19:C21). Верной считается наземная как предел (решение владельца
  // продукта 28.09.2026); вопрос автору — что входит в нежилую; «+420» в жилой — отдельный вопрос
  if (typeof tep.gfa_above_C19 === "number" && typeof tep.res_gfa_C20 === "number" && typeof tep.nonres_gfa_C21 === "number") {
    const over = new Decimal(tep.res_gfa_C20).add(tep.nonres_gfa_C21).sub(tep.gfa_above_C19);
    if (over.gt(0)) {
      warn({
        formulaId: "F.TEP.GFA_SPLIT",
        parameterId: "TEP.NONRES_GFA",
        key: "LEGACY.NONRES_GFA",
        text: `Жилая (${fmt(tep.res_gfa_C20)} м²) и нежилая (${fmt(tep.nonres_gfa_C21)} м²) ГНС вместе больше наземной ГНС ${fmt(tep.gfa_above_C19)} м² на ${fmt(over)} м² (ТЭПы!C19:C21)`,
      });
    }
    const typed = tep.res_gfa_C20_formula ?? "";
    if (/^=\d+(\.\d+)?\+\d+(\.\d+)?$/.test(typed)) {
      warn({ formulaId: "F.TEP.GFA_SPLIT", parameterId: "TEP.RES_GFA", key: "LEGACY.RES_GFA_TYPED", text: `Жилая ГНС ТЭПы!C20 введена как ${typed}: слагаемое без пояснения` });
    }
  }

  // Маркетинг Бюджет!F51 вбит числом и не равен ставке × выручке (соседняя строка брокериджа считается формулой)
  const { budget } = lc;
  const revenue = lc.sales_plan.revenue_row25_from_1q2026.reduce((s, v) => s.add(v), new Decimal(0));
  const byRate = revenue.mul(budget.marketing_rate_D51);
  if (!/[A-Z]+\d/.test(budget.marketing_F51_formula) && !byRate.sub(budget.marketing_F51).abs().lt(1)) {
    warn({
      formulaId: "F.CAPEX.ITEM_TOTAL",
      parameterId: "CAPEX.ITEMS",
      key: "LEGACY.MARKETING_F51",
      text: `Маркетинг Бюджет!F51 вбит числом (${budget.marketing_F51_formula}) = ${fmt(budget.marketing_F51)} руб.; ставка ${fmtShare(new Decimal(budget.marketing_rate_D51))} × выручка ${fmt(revenue)} руб. = ${fmt(byRate)} руб. Число соответствует выручке ${fmt(new Decimal(budget.marketing_F51).div(budget.marketing_rate_D51))} руб., которой в файле нет`,
    });
  }

  // Маркетинг и брокеридж в CF1 начинаются позже продаж
  const { cf1 } = lc;
  const sales0 = firstNonZero(lc.sales_plan.revenue_row25_from_1q2026);
  const lags = [
    { name: "брокеридж (CF1 строка 78)", start: firstNonZero(cf1.brokerage_row78) },
    { name: "маркетинг (CF1 строка 79)", start: firstNonZero(cf1.marketing_row79) },
  ].filter((x) => x.start > sales0);
  if (sales0 >= 0 && lags.length > 0) {
    warn({
      formulaId: "F.CAPEX.SCHEDULE_WEIGHT",
      parameterId: "CAPEX.ITEMS",
      key: "LEGACY.CF1_LAG",
      text: `В CF1 ${lags.map((x) => `${x.name} начинается на ${x.start - sales0} кв. позже первых продаж`).join(", ")}: брокеридж платится при сделке, маркетинг идёт до продаж или вместе с ними`,
    });
  }

  // Две даты раскрытия эскроу: текст в ТЭПы!C12 и единица, вбитая руками в CF1 строке 6
  const quarters = c.timeline_quarters_F_to_AS ?? [];
  const released = quarters[cf1.escrow_release_row6.findIndex((v) => v === 1)];
  const depositEnd = cf1.escrow_deposit_row8.findIndex((v) => v === 0);
  if (typeof tep.escrow_release_C12 === "string" && cf1.escrow_release_row6_typed.length > 0 && released) {
    warn({
      formulaId: "F.TIME.FLAG_ESCROW_RELEASE",
      parameterId: "TIME.LEGACY_ESCROW_RELEASE_DATE",
      key: "LEGACY.ESCROW_DATE",
      text: `В исходнике две даты раскрытия эскроу. ТЭПы!C12 «Срок окончания ПФ» = «${tep.escrow_release_C12}» записан текстом, и формулы CF1!F6:AS6 (=IF(F2=$D$6,…)) с ним не срабатывают. Фактически CF1 раскрывает эскроу в ${fmtQuarter(released)}: единица в строке 6 вбита руками, а взносы на эскроу обрезаны вбитыми нулями${depositEnd >= 0 && quarters[depositEnd] ? ` с ${fmtQuarter(quarters[depositEnd] as string)}` : ""} (строка 8). Расчёт «как в исходном Excel» повторяет расчёт CF1 — ${fmtQuarter(released)}`,
    });
  }

  // Резерв Бюджет!F42 = E42 + D42: сложены площадь и ставка вместо произведения
  if (/E42\s*\+\s*D42|D42\s*\+\s*E42/.test(budget.contingency_F42_formula)) {
    warn({
      formulaId: "F.CAPEX.ITEM_TOTAL",
      parameterId: "CAPEX.ITEMS",
      key: "LEGACY.CONTINGENCY_F42",
      text: `Резерв Бюджет!F42 ${budget.contingency_F42_formula} = ${fmt(budget.contingency_F42)}: сложены площадь E42 = ${fmt(budget.contingency_E42)} м² и ставка D42 = ${fmt(budget.contingency_D42)} руб./м² (10 % от ставок СМР D32:D34). Единицы разные, но результат учтён в бюджете как рубли; произведение — ${fmt(new Decimal(budget.contingency_E42).mul(budget.contingency_D42))} руб.`,
    });
  }
  return out;
}
