import Decimal from "decimal.js";
import { describe, expect, it } from "vitest";
import { getFormula, type FormulaId, type ParameterId } from "@fm/spec";
import { ANALYSIS_FORMULAS, Engine, calculate } from "../src";
import type { SocialNeed } from "../src/modules/land";

type Values = Partial<Record<ParameterId, unknown>>;

const example = (id: FormulaId) => getFormula(id).example as { input: Record<string, number>; output: unknown };

/** Москва, стадия «оценка участка»: жилая часть задана напрямую (ГПЗУ), квартал в центре, Басманный район. */
const msk = (extra: Values = {}): Values => ({
  "GEN.REGION_CODE": "77",
  "GEN.PROJECT_STAGE": "оценка участка",
  "TEP.RES_GFA": 7628,
  "TEP.NONRES_GFA": 1500,
  "GEN.LOCALITY": ["Басманный район", "Бауманка"],
  "GEN.CADASTRAL_QUARTER": "77:01:0001003",
  ...extra,
});

function run<T>(id: FormulaId, values: Values, mode: "normal" | "legacy" = "normal") {
  const r = new Engine({ values, mode }, ANALYSIS_FORMULAS).run([id]);
  return { value: r.formulas[id]?.value as T, messages: r.messages };
}

describe("обязательства перед городом по соцобъектам (Москва, 3135-ПП)", () => {
  it("пример F.LAND.SOCIAL_POPULATION: жилая часть 7 628 м² ÷ 50 м² = 152,56 чел.", () => {
    const { input, output } = example("F.LAND.SOCIAL_POPULATION");
    const { value } = run<Decimal>("F.LAND.SOCIAL_POPULATION", msk({ "TEP.RES_GFA": input.res_gfa }));
    expect(value.toNumber()).toBe(output);
  });

  it("пример F.LAND.SOCIAL_NEED: зона 1, места округляются вверх — 7, 14 и 3, как в граданализе Лялина", () => {
    const { output } = example("F.LAND.SOCIAL_NEED");
    // УПКС примера условный (100 000 руб/м²): подставляем таблицу с одним кварталом
    const { value: real } = run<SocialNeed>("F.LAND.SOCIAL_NEED", msk());
    const rows = real.rows;
    expect(real.zone).toBe(1);
    expect(real.district).toBe("Басманный район");
    expect(rows.map((r) => r.units.toNumber())).toEqual((output as { units: number }[]).map((o) => o.units));
    // Без земли (её стоимость зависит от квартала) строительство совпадает с примером
    const build = rows.map((r) => r.build.toNumber());
    expect(build).toEqual([7 * 4293600, 14 * 4011310, 3 * 7246600]);
    // Земля: квартал 77:01:0001003, группа «объекты социальной инфраструктуры» — 56 881,51 руб/м²
    expect(rows[0]?.landM2.toNumber()).toBe(7 * 35);
    expect(rows[0]?.land.toNumber()).toBeCloseTo(7 * 35 * 56881.51, 6);
    expect(rows[2]?.land.isZero()).toBe(true);
    const withExampleUpks = rows.map((r) => r.build.add(r.landM2.mul(100000)).toNumber());
    expect(withExampleUpks).toEqual((output as { total: number }[]).map((o) => o.total));
  });

  it("район не найден — зона 2 с бо́льшим нормативом и предупреждение; нет квартала — земля не учтена", () => {
    const { value, messages } = run<SocialNeed>("F.LAND.SOCIAL_NEED", msk({ "GEN.LOCALITY": null, "GEN.CADASTRAL_QUARTER": null }));
    expect(value.zone).toBe(2);
    expect(value.rows.map((r) => r.units.toNumber())).toEqual([10, 19, 3]); // 152,56 × 63 / 1000 = 9,6; × 124 = 18,9
    expect(value.rows.every((r) => r.land.isZero())).toBe(true);
    expect(messages.map((m) => m.key)).toEqual(expect.arrayContaining(["LAND.SOCIAL_ZONE_UNKNOWN", "LAND.SOCIAL_LAND_UNKNOWN"]));
  });

  it("пример F.LAND.SOCIAL_COMPENSATION и когда по нормативу не считается", () => {
    const { input, output } = example("F.LAND.SOCIAL_COMPENSATION") as unknown as { input: { totals: number[] }; output: number };
    expect(input.totals.reduce((a, b) => a + b, 0)).toBe(output);
    const { value } = run<Decimal>("F.LAND.SOCIAL_COMPENSATION", msk());
    const { value: need } = run<SocialNeed>("F.LAND.SOCIAL_NEED", msk());
    expect(value.toNumber()).toBeCloseTo(need.rows.reduce((s, r) => s + r.total.toNumber(), 0), 4);
    // Сумма по договору с городом заменяет норматив
    expect(run<Decimal>("F.LAND.SOCIAL_COMPENSATION", msk({ "LAND.CITY_CASH_COMPENSATION": 0 })).value.isZero()).toBe(true);
    expect(run<Decimal>("F.LAND.SOCIAL_COMPENSATION", msk({ "CAPEX.ITEMS": [{ item_id: "SOCIAL_OBJECTS", rate: 1 }] })).value.isZero()).toBe(true);
    // Расчёт «как в исходном Excel» — обязательства исходника
    expect(run<Decimal>("F.LAND.SOCIAL_COMPENSATION", msk(), "legacy").value.isZero()).toBe(true);
    // Регион без нормативов — не учтено с предупреждением
    const mo = run<Decimal>("F.LAND.SOCIAL_COMPENSATION", msk({ "GEN.REGION_CODE": "50" }));
    expect(mo.value.isZero()).toBe(true);
    expect(mo.messages.map((m) => m.key)).toContain("LAND.SOCIAL_RULES_MISSING");
  });
});

describe("снос существующих зданий", () => {
  it("пример F.CAPEX.DEMOLITION_VOLUME: 2 343 м² × 3,3 м = 7 731,9 м³", () => {
    const { input, output } = example("F.CAPEX.DEMOLITION_VOLUME");
    const r = calculate({ values: { "SITE.DEMOLITION_GFA": input.demolition_gfa } }, {}, ["F.CAPEX.DEMOLITION_VOLUME"]);
    expect((r.formulas["F.CAPEX.DEMOLITION_VOLUME"]?.value as Decimal).toNumber()).toBe(output);
  });

  it("объём из техпаспорта главнее оценки; нет данных — 0 и сообщение; «как в исходном Excel» — 0", () => {
    const given = calculate({ values: { "SITE.DEMOLITION_GFA": 2343, "SITE.DEMOLITION_VOLUME": 9000 } }, {}, ["F.CAPEX.DEMOLITION_VOLUME"]);
    expect((given.formulas["F.CAPEX.DEMOLITION_VOLUME"]?.value as Decimal).toNumber()).toBe(9000);
    const none = calculate({ values: {} }, {}, ["F.CAPEX.DEMOLITION_VOLUME"]);
    expect((none.formulas["F.CAPEX.DEMOLITION_VOLUME"]?.value as Decimal).isZero()).toBe(true);
    expect(none.messages.map((m) => m.key)).toContain("CAPEX.DEMOLITION_UNKNOWN");
    const legacy = calculate({ values: { "SITE.DEMOLITION_GFA": 2343 }, mode: "legacy" }, {}, ["F.CAPEX.DEMOLITION_VOLUME"]);
    expect((legacy.formulas["F.CAPEX.DEMOLITION_VOLUME"]?.value as Decimal).isZero()).toBe(true);
  });
});
