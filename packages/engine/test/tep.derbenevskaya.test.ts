import Decimal from "decimal.js";
import { describe, expect, it } from "vitest";
import { calculate } from "../src";
import { legacyInput, loadCase } from "./support/cases";

const c = loadCase("derbenevskaya_legacy");
const targets = c.reconciliation_targets as Record<string, number>;
const sum = (xs: unknown) => (xs as Decimal[]).reduce((a, b) => a.add(b), new Decimal(0));

describe("Дербеневская — сверка ТЭП с исходником (расчёт «как в исходном Excel»)", () => {
  const r = calculate(legacyInput(c), {}, [
    "F.TEP.APT_TYPE_AREA",
    "F.TEP.PARKING_REQUIRED",
    "F.TEP.LANDSCAPE_AREA",
    "F.TEP.GFA_BELOW_EST",
    "F.TEP.SALEABLE_AREA",
    "F.TEP.APT_AREA_CHECK",
    "F.TEP.GFA_TOTAL",
  ]);
  const v = (id: keyof typeof r.formulas) => r.formulas[id]?.value;

  it("площадь квартир по квартирографии = 143 560,388 м²", () => {
    expect(sum(v("F.TEP.APT_TYPE_AREA")).toNumber()).toBe(targets["F.TEP.APT_TYPE_AREA_sum"]);
  });

  it("норматив машино-мест по нормам исходника = 2 785", () => {
    expect((v("F.TEP.PARKING_REQUIRED") as Decimal).toNumber()).toBe(targets["F.TEP.PARKING_REQUIRED_by_legacy_norm"]);
  });

  it("площадь благоустройства = 28 971,6 м²", () => {
    expect((v("F.TEP.LANDSCAPE_AREA") as { landscape: Decimal }).landscape.toNumber()).toBe(targets["F.TEP.LANDSCAPE_AREA"]);
  });

  it("оценка подземной площади по 862 м/м исходника = 35 294,59 м²", () => {
    expect((v("F.TEP.GFA_BELOW_EST") as Decimal).toNumber()).toBe(targets["F.TEP.GFA_BELOW_EST_legacy_parking"]);
  });

  it("продаваемая площадь — сумма по продуктам: 143 560,388 + 10 322 = 153 882,388 м² (а не 149 281 из ТЭПы!C35)", () => {
    expect((v("F.TEP.SALEABLE_AREA") as Decimal).toNumber()).toBe(153882.388);
  });

  it("862 м/м ниже норматива — предупреждение (ошибка исходника №13)", () => {
    expect(r.messages).toContainEqual(expect.objectContaining({ severity: "warning", parameterId: "TEP.PARKING_COUNT_OVERRIDE" }));
  });

  it("квартирография и ТЭП расходятся на 0,388 м² — в пределах 1%, без предупреждения", () => {
    expect((v("F.TEP.APT_AREA_CHECK") as { diff_m2: Decimal }).diff_m2.toNumber()).toBe(0.388);
    expect(r.messages.filter((m) => m.formulaId === "F.TEP.APT_AREA_CHECK")).toEqual([]);
  });

  it("ошибок расчёта нет", () => {
    expect(r.messages.filter((m) => m.severity === "error")).toEqual([]);
  });
});

describe("Дербеневская — расчёт сервиса: норматив Москвы (2118-ПП) по площади квартир", () => {
  it("по правилу regions.yaml: 961 × 0,8 + 720 × 0,8 + 720 × 1,2 → 2 209 м/м", () => {
    const input = legacyInput(c);
    delete input.values["TEP.PARKING_NORM"];
    const r = calculate({ ...input, mode: "normal" }, {}, ["F.TEP.PARKING_REQUIRED"]);
    expect(r.parameters["TEP.PARKING_NORM"]?.origin).toBe("region");
    expect((r.formulas["F.TEP.PARKING_REQUIRED"]?.value as Decimal).toNumber()).toBe(2209);
  });

  it("нормы по типам квартир вне расчёта «как в исходном Excel» запрещены", () => {
    const r = calculate({ ...legacyInput(c), mode: "normal" }, {}, ["F.TEP.PARKING_REQUIRED"]);
    expect(r.messages).toContainEqual(expect.objectContaining({ severity: "error", parameterId: "TEP.PARKING_NORM" }));
  });
});
