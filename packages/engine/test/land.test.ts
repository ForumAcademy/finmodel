import Decimal from "decimal.js";
import { describe, expect, it } from "vitest";
import { calculate } from "../src";

const base = {
  "GEN.MODEL_START_DATE": "2025-12-31",
  "GEN.REGION_CODE": "77",
  "LAND.CADASTRAL_VALUE": 5834907660,
  "TAX.LAND_RATE": 0.015,
  "TIME.MILESTONES": [{ phase: 1, land_acquired: "2025-12-31", handover_end: "2030-06-30" }],
};

describe("LAND", () => {
  it("пример F.LAND.TAX_OR_RENT: 5 834 907 660 × 1,5% × 2 / 12 = 14 587 269,15 руб/мес", () => {
    const r = calculate({ values: base }, { horizonMonths: 60 }, ["F.LAND.TAX_OR_RENT"]);
    const pay = r.formulas["F.LAND.TAX_OR_RENT"]?.value as Decimal[];
    expect(pay[1]?.toDecimalPlaces(2).toNumber()).toBe(14587269.15);
  });

  it("коэффициент 2 первые 3 года, затем 4, после передачи последней очереди — налога нет", () => {
    const r = calculate({ values: base }, { horizonMonths: 60 }, ["F.LAND.TAX_OR_RENT"]);
    const coef = (r.formulas["F.LAND.TAX_COEF"]?.value as Decimal[]).map((c) => c.toNumber());
    expect(coef[36]).toBe(2); // 31.12.2028 — ровно 3 года
    expect(coef[37]).toBe(4);
    const pay = r.formulas["F.LAND.TAX_OR_RENT"]?.value as Decimal[];
    expect(pay[54]?.gt(0)).toBe(true); // 30.06.2030
    expect(pay[55]?.isZero()).toBe(true);
  });

  it("аренда: поквартально авансом, индексация раз в год, до передачи первого помещения", () => {
    const rent = {
      ...base,
      "LAND.TENURE": "аренда",
      "LAND.RENT_ANNUAL": 1200,
      "LAND.RENT_INDEXATION": 0.1,
      "TIME.MILESTONES": [{ phase: 1, land_acquired: "2026-01-01", handover_start: "2027-05-31", handover_end: "2030-06-30" }],
    };
    const r = calculate({ values: rent }, { horizonMonths: 24 }, ["F.LAND.TAX_OR_RENT"]);
    const pay = (r.formulas["F.LAND.TAX_OR_RENT"]?.value as Decimal[]).map((x) => x.toDecimalPlaces(6).toNumber());
    expect(pay.slice(0, 10)).toEqual([0, 300, 0, 0, 300, 0, 0, 300, 0, 0]);
    expect(pay[10]).toBe(300);
    expect(pay[13]).toBe(330); // январь 2027: второй год аренды, +10%
    const monthly = calculate({ values: { ...rent, "LAND.RENT_PAYMENT_FREQ": "ежемесячно" } }, { horizonMonths: 24 }, ["F.LAND.TAX_OR_RENT"]);
    expect((monthly.formulas["F.LAND.TAX_OR_RENT"]?.value as Decimal[])[1]?.toNumber()).toBe(100);
  });

  it("аренда авансом: неполный первый квартал — в первый месяц аренды, неполный последний — по дням", () => {
    const rent = {
      ...base,
      "LAND.TENURE": "аренда",
      "LAND.RENT_ANNUAL": 1200,
      "LAND.RENT_INDEXATION": 0,
      // аренда с 16.02.2026 по 15.05.2026 (начало передачи помещений)
      "TIME.MILESTONES": [{ phase: 1, land_acquired: "2026-02-16", handover_start: "2026-05-16", handover_end: "2030-06-30" }],
    };
    const r = calculate({ values: rent }, { horizonMonths: 8 }, ["F.LAND.TAX_OR_RENT"]);
    const pay = (r.formulas["F.LAND.TAX_OR_RENT"]?.value as Decimal[]).map((x) => x.toNumber());
    // февраль: 13 дней из 28 + весь март — платится в феврале (первый месяц аренды), январь — ничего
    expect(pay[1]).toBe(0);
    expect(pay[2]).toBeCloseTo((100 * 13) / 28 + 100, 9);
    expect(pay[3]).toBe(0);
    // апрель: весь апрель + 15 дней мая из 31
    expect(pay[4]).toBeCloseTo(100 + (100 * 15) / 31, 9);
    expect(pay.slice(5)).toEqual([0, 0, 0]);
  });

  it("смена ВРИ: до вехи — стоимость до смены ВРИ без коэффициента, с вехи — новая с коэффициентом", () => {
    const vri = {
      ...base,
      "LAND.CADASTRAL_VALUE_AFTER_VRI": 12e9,
      "TIME.MILESTONES": [{ phase: 1, land_acquired: "2025-12-31", vri_change_date: "2026-06-30", handover_end: "2030-06-30" }],
    };
    const r = calculate({ values: vri }, { horizonMonths: 12 }, ["F.LAND.TAX_OR_RENT"]);
    const pay = r.formulas["F.LAND.TAX_OR_RENT"]?.value as Decimal[];
    expect(pay[5]?.toNumber()).toBeCloseTo(5834907660 * 0.015 / 12, 6); // май 2026
    expect(pay[6]?.toNumber()).toBeCloseTo(12e9 * 0.015 * 2 / 12, 6); // июнь 2026
    const noDate = calculate({ values: { ...base, "LAND.CADASTRAL_VALUE_AFTER_VRI": 12e9 } }, { horizonMonths: 12 }, ["F.LAND.TAX_OR_RENT"]);
    expect(noDate.messages).toContainEqual(expect.objectContaining({ severity: "error", text: expect.stringContaining("смена ВРИ") }));
  });

  it("плата за ВРИ: формула региона не выписана — обязательный ручной ввод", () => {
    const missing = calculate({ values: base }, {}, ["F.LAND.VRI_FEE"]);
    expect(missing.messages).toContainEqual(expect.objectContaining({ severity: "error", parameterId: "LAND.VRI_FEE" }));
    const given = calculate({ values: { ...base, "LAND.VRI_FEE": 1000 } }, {}, ["F.LAND.VRI_FEE"]);
    expect((given.formulas["F.LAND.VRI_FEE"]?.value as Decimal).toNumber()).toBe(1000);
  });
});
