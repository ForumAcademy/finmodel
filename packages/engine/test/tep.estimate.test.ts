import Decimal from "decimal.js";
import { describe, expect, it } from "vitest";
import { calculate } from "../src";

/** Синтетический проект на стадии «Оценка участка»: площади из ГПЗУ и коэффициентов. */
const values = {
  "GEN.PROJECT_STAGE": "оценка участка",
  "GEN.REGION_CODE": "77",
  "LAND.AREA": 20000,
  "GPZU.MAX_GFA_ABOVE": 100000,
  "TEP.RES_GFA_SHARE": 0.8,
  "TEP.APART_GFA_SHARE": 0.1,
  "TEP.APT_EFFICIENCY": 0.7,
  "TEP.COMM_EFFICIENCY": 0.6,
  "TEP.APART_EFFICIENCY": 0.65,
  "GPZU.APART_ALLOWED": true,
  "TEP.APT_MIX": [
    { type_name: "Студии", area_share: 0.25, avg_area: 30 },
    { type_name: "Двухкомнатные", area_share: 0.5, avg_area: 60 },
    { type_name: "Трёхкомнатные", area_share: 0.25, avg_area: 90 },
  ],
  "TEP.STORAGE_PER_APT": 0.5,
  "TEP.STORAGE_AVG_AREA": 4,
  "TEP.PARKING_AREA_PER_SPACE": 35,
};
const num = (x: unknown) => (x as Decimal).toNumber();

describe("ТЭП на стадии «Оценка участка»", () => {
  const r = calculate({ values }, {}, ["F.TEP.SALEABLE_AREA", "F.TEP.APT_AREA_CHECK"]);
  const v = (id: keyof typeof r.formulas) => r.formulas[id]?.value;

  it("ГНС наземная = предел ГПЗУ; части — по долям", () => {
    expect(num(v("F.TEP.GFA_ABOVE"))).toBe(100000);
    const split = v("F.TEP.GFA_SPLIT") as Record<string, Decimal>;
    expect([split.res?.toNumber(), split.apart?.toNumber(), split.nonres?.toNumber()]).toEqual([80000, 10000, 10000]);
  });

  it("площади продуктов — ГНС части × коэффициент", () => {
    expect(num(v("F.TEP.APT_AREA"))).toBe(56000);
    expect(num(v("F.TEP.COMM_AREA"))).toBe(6000);
    expect(num(v("F.TEP.APART_AREA"))).toBe(6500);
  });

  it("количество квартир — округление вниз", () => {
    // 0,25 × 56 000 / 30 = 466,67 → 466; 0,5 × 56 000 / 60 = 466,67 → 466; 0,25 × 56 000 / 90 = 155,56 → 155
    expect((v("F.TEP.APT_COUNT") as Decimal[]).map((x) => x.toNumber())).toEqual([466, 466, 155]);
  });

  it("кладовые: FLOOR(1 087 × 0,5) = 543 шт × 4 м²", () => {
    const s = v("F.TEP.STORAGE") as { count: Decimal; area: Decimal };
    expect([s.count.toNumber(), s.area.toNumber()]).toEqual([543, 2172]);
  });

  it("продаваемая площадь = квартиры по квартирографии + апартаменты + ПСН + кладовые", () => {
    // 13 980 + 27 960 + 13 950 = 55 890 м² квартир
    expect(num(v("F.TEP.SALEABLE_AREA"))).toBe(55890 + 6500 + 6000 + 2172);
  });

  it("квартирография меньше площади квартир из-за округления: 110 м² (0,2%) — без предупреждения", () => {
    expect((v("F.TEP.APT_AREA_CHECK") as { diff_m2: Decimal }).diff_m2.toNumber()).toBe(-110);
    expect(r.messages).toEqual([]);
  });
});

describe("ТЭП на стадии «Оценка участка» без апартаментов: паркинг и подземная часть", () => {
  const r = calculate({ values: { ...values, "TEP.APART_GFA_SHARE": 0 } }, {}, ["F.TEP.GFA_TOTAL"]);
  const v = (id: keyof typeof r.formulas) => r.formulas[id]?.value;

  it("машино-места по нормативу Москвы; подземная часть = места × площадь на место + кладовые", () => {
    // 466 × 0,8 + 466 × 0,8 + 155 × 1,2 = 931,6 → 932
    expect(num(v("F.TEP.PARKING_COUNT"))).toBe(932);
    expect(num(v("F.TEP.GFA_BELOW"))).toBe(932 * 35 + 2172);
    expect(num(v("F.TEP.GFA_TOTAL"))).toBe(100000 + 932 * 35 + 2172);
    expect(r.messages).toEqual([]);
  });
});

describe("ТЭП: ошибки и ограничения", () => {
  const calc = (patch: Record<string, unknown>, target: Parameters<typeof calculate>[2]) => calculate({ values: { ...values, ...patch } }, {}, target);

  it("нет СПП в ГПЗУ → пятно × этажность", () => {
    const r = calc({ "GPZU.MAX_GFA_ABOVE": null, "TEP.FOOTPRINT_AREA": 5000, "TEP.AVG_FLOORS": 16 }, ["F.TEP.GFA_ABOVE"]);
    expect(num(r.formulas["F.TEP.GFA_ABOVE"]?.value)).toBe(80000);
  });

  it("доли жилой и апартаментной части больше 100% — ошибка", () => {
    const r = calc({ "TEP.APART_GFA_SHARE": 0.3 }, ["F.TEP.GFA_SPLIT"]);
    expect(r.messages).toContainEqual(expect.objectContaining({ severity: "error", parameterId: "TEP.APART_GFA_SHARE" }));
  });

  it("сумма долей квартирографии ≠ 100% — ошибка", () => {
    const mix = (values["TEP.APT_MIX"] as object[]).map((row, k) => (k === 0 ? { ...row, area_share: 0.3 } : row));
    const r = calc({ "TEP.APT_MIX": mix }, ["F.TEP.APT_COUNT"]);
    expect(r.messages).toContainEqual(expect.objectContaining({ severity: "error", parameterId: "TEP.APT_MIX" }));
  });

  it("ГПЗУ не допускает апартаменты — площадь 0 и предупреждение; код 4.7 — подсказка", () => {
    const r = calc({ "GPZU.APART_ALLOWED": false, "LAND.VRI_CODES": ["2.6", "4.7"] }, ["F.TEP.APART_AREA"]);
    expect(num(r.formulas["F.TEP.APART_AREA"]?.value)).toBe(0);
    expect(r.messages.map((m) => m.severity)).toEqual(["warning", "info"]);
  });

  it("апартаменты есть, а норматив машино-мест для них в спецификации не задан — ошибка, а не выдуманный расчёт", () => {
    const r = calc({ "TEP.PARKING_NORM_APART": { rule: "per_m2", values: [] } }, ["F.TEP.PARKING_REQUIRED"]);
    expect(r.messages).toContainEqual(expect.objectContaining({ severity: "error", parameterId: "TEP.PARKING_NORM_APART", text: expect.stringContaining("вопрос владельцу продукта") }));
  });

  it("площадь на машино-место меньше 5,3 × 2,5 = 13,25 м² — ошибка", () => {
    const r = calc({ "TEP.APART_GFA_SHARE": 0, "TEP.PARKING_AREA_PER_SPACE": 13 }, ["F.TEP.GFA_BELOW"]);
    expect(num(r.formulas["F.TEP.PARKING_SPACE_MIN_AREA"]?.value)).toBe(13.25);
    expect(r.messages).toContainEqual(expect.objectContaining({ severity: "error", parameterId: "TEP.PARKING_AREA_PER_SPACE" }));
  });

  it("ГПЗУ требует больше мест, чем норматив, — берётся ГПЗУ", () => {
    const r = calc({ "TEP.APART_GFA_SHARE": 0, "TEP.PARKING_GPZU_COUNT": 1000 }, ["F.TEP.PARKING_COUNT"]);
    expect(num(r.formulas["F.TEP.PARKING_COUNT"]?.value)).toBe(1000);
  });

  it("не заполнен коэффициент — ошибка с именем параметра, зависящие формулы не считаются", () => {
    const r = calc({ "TEP.APT_EFFICIENCY": null }, ["F.TEP.SALEABLE_AREA"]);
    expect(r.messages).toEqual([expect.objectContaining({ severity: "error", parameterId: "TEP.APT_EFFICIENCY" })]);
    expect(r.formulas["F.TEP.SALEABLE_AREA"]).toBeUndefined();
  });

  it("на стадии «Концепция» оценка подземной части не считается и не требует площади на место", () => {
    const r = calculate(
      { values: { "GEN.PROJECT_STAGE": "концепция", "TEP.GFA_ABOVE": 1000, "TEP.GFA_BELOW": 300 } },
      {},
      ["F.TEP.GFA_TOTAL"],
    );
    expect(num(r.formulas["F.TEP.GFA_TOTAL"]?.value)).toBe(1300);
    expect(r.formulas["F.TEP.GFA_BELOW_EST"]).toBeUndefined();
    expect(r.messages).toEqual([]);
  });
});
