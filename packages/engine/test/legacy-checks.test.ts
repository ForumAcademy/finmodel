import { describe, expect, it } from "vitest";
import { legacyChecks } from "../src";
import { loadCase } from "./support/cases";

describe("Проверки расчёта «как в исходном Excel»: расхождения внутри исходника", () => {
  const c = loadCase("derbenevskaya_legacy");
  const m = legacyChecks(c);
  const text = (key: string) => m.find((x) => x.key === key)?.text ?? "";

  it("каждое расхождение — предупреждение с постоянным ключом", () => {
    expect(m.map((x) => x.key)).toEqual(["LEGACY.PSN_STOCK", "LEGACY.MARKETING_F51", "LEGACY.CF1_LAG", "LEGACY.ESCROW_DATE", "LEGACY.CONTINGENCY_F42"]);
    expect(m.every((x) => x.severity === "warning")).toBe(true);
  });

  it("запас ПСН: C23 = 10 322, C48 = 10 332; C35 = 149 281 вбито при сумме 153 882", () => {
    expect(text("LEGACY.PSN_STOCK")).toMatch(/C23 = 10\s322 м², ТЭПы!C48 = 10\s332 м².*C35 = 149\s281 м² вбита числом, а квартиры \+ ПСН = 153\s882 м²/);
  });

  it("маркетинг F51 соответствует выручке 119,85 млрд, которой в файле нет", () => {
    expect(text("LEGACY.MARKETING_F51")).toMatch(/4\s194\s809\s207,75.*выручке 119\s851\s691\s650 руб\./);
  });

  it("маркетинг и брокеридж в CF1 начинаются на 7 кварталов позже продаж", () => {
    expect(text("LEGACY.CF1_LAG")).toMatch(/брокеридж \(CF1 строка 78\) начинается на 7 кв\. позже.*маркетинг \(CF1 строка 79\) начинается на 7 кв\. позже/);
  });

  it("резерв: сложены площадь и ставка", () => {
    expect(text("LEGACY.CONTINGENCY_F42")).toMatch(/=E42\+D42 = 202\s839,89: сложены площадь E42 = 153\s882 м² и ставка D42 = 48\s957,89/);
  });

  it("эскроу: в ТЭПах 2 кв 2032 текстом, в CF1 фактически 3 кв 2031", () => {
    expect(text("LEGACY.ESCROW_DATE")).toMatch(/«2 кв 2032».*раскрывает эскроу в 3 кв 2031.*нулями с 3 кв 2031/);
  });

  it("исправленный исходник — без предупреждений", () => {
    const lc = structuredClone(c.legacy_checks);
    if (!lc) throw new Error("нет legacy_checks");
    lc.tep.psn_stock_C48 = lc.tep.psn_stock_C23;
    lc.tep.saleable_area_C35_formula = "=C22+C23";
    lc.budget.marketing_F51_formula = "=E51*D51";
    lc.cf1.marketing_row79 = [...lc.sales_plan.revenue_row25_from_1q2026];
    lc.cf1.brokerage_row78 = [...lc.sales_plan.revenue_row25_from_1q2026];
    lc.cf1.escrow_release_row6_typed = [];
    lc.budget.contingency_F42_formula = "=E42*D42";
    expect(legacyChecks({ ...c, legacy_checks: lc })).toEqual([]);
  });
});
