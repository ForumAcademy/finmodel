import Decimal from "decimal.js";
import { describe, expect, it } from "vitest";
import { getFormula, type FormulaId, type ParameterId } from "@fm/spec";
import { ANALYSIS_FORMULAS, Engine, type CalcProject } from "../src";
import { analyzeSite, computeVariant } from "../src/analysis";
import { crossing, type LandMax, type Sensitivity } from "../src/modules/variant";
import { reportTotal, shiftKeyRate, shiftPrices, variantReportSync } from "../src/report";
import { signChange } from "../src/lib/solve";
import { landReportView, sensView, salesView, cashView } from "../src/explain/report-view";

type Values = Partial<Record<ParameterId, unknown>>;

function run<T>(id: FormulaId, values: Values): T {
  const r = new Engine({ values }, ANALYSIS_FORMULAS).run([id]);
  const node = r.formulas[id];
  if (!node) throw new Error(r.messages.map((m) => m.text).join("; "));
  return node.value as T;
}

const example = (id: FormulaId) => getFormula(id).example as { input: Record<string, unknown>; output: unknown };

describe("итоговый отчёт: примеры формул (formulas.yaml → example)", () => {
  it("F.VAR.LAND_MAX: цена, при которой NPV акционера равен нулю, — между соседними пробами", () => {
    const { input, output } = example("F.VAR.LAND_MAX");
    const trials = (input.trials as [number, number][]).map(([price, npv]) => ({ price, npv, irr: null }));
    const v = run<LandMax>("F.VAR.LAND_MAX", { "VAR.LAND_TRIALS": trials, "LAND.PURCHASE_PRICE": input.asked });
    expect(v.max_price?.toNumber()).toBe(output);
    expect(v.unprofitable).toBe(false);
    expect(v.reserve?.toNumber()).toBe(300000000);
    expect(v.reserve_share?.toDecimalPlaces(4).toNumber()).toBe(0.3333);
    expect(v.max_price_irr).toBeNull();
    // NPV отрицателен уже при нулевой цене — проект невыгоден при любой цене участка
    const bad = run<LandMax>("F.VAR.LAND_MAX", { "VAR.LAND_TRIALS": [{ price: 0, npv: -5, irr: null }, { price: 10, npv: -9, irr: null }] });
    expect(bad.unprofitable).toBe(true);
    expect(bad.max_price?.toNumber()).toBe(0);
    expect(bad.reserve).toBeNull();
    // Цена при целевой IRR: IRR 30 % при 0, 20 % при 100 → 25 % при 50
    const irr = run<LandMax>("F.VAR.LAND_MAX", { "VAR.LAND_TRIALS": [{ price: 0, npv: 10, irr: 0.3 }, { price: 100, npv: 5, irr: 0.2 }], "VAL.HURDLE_IRR": 0.25 });
    expect(irr.max_price_irr?.toNumber()).toBe(50);
    expect(irr.max_price).toBeNull();
  });

  it("F.VAR.SENSITIVITY: таблица по шагам и точки, где NPV становится нулём", () => {
    const { input, output } = example("F.VAR.SENSITIVITY");
    const results = (input.results as [number, number, number][]).map(([price_shift, rate_shift, npv]) => ({ price_shift, rate_shift, npv }));
    const v = run<Sensitivity>("F.VAR.SENSITIVITY", { "VAR.SENS_RESULTS": results, "VAL.SENS_PRICE_STEP": input.price_step, "VAL.SENS_RATE_STEP": input.rate_step, "VAL.SENS_STEPS": input.steps });
    const out = output as { price_breakeven: number; rate_breakeven: number };
    expect(v.price_breakeven?.toDecimalPlaces(4).toNumber()).toBe(out.price_breakeven);
    expect(v.rate_breakeven?.toDecimalPlaces(4).toNumber()).toBe(out.rate_breakeven);
    expect(v.price_steps.map((x) => x.toNumber())).toEqual([-0.05, 0, 0.05]);
    expect(v.rate_steps.map((x) => x.toNumber())).toEqual([-0.01, 0, 0.01]);
    // Строка «цена 0»: ставка −1 п.п. не посчитана, 0 → 100, +1 п.п. → 80
    expect(v.grid[1]?.map((x) => x?.toNumber() ?? null)).toEqual([null, 100, 80]);
  });

  it("пересечение: ближайшее к началу поиска, точное попадание в пробу", () => {
    const pts = [{ x: 0, y: 10 }, { x: 1, y: -10 }, { x: 2, y: 10 }, { x: 3, y: null }];
    expect(crossing(pts, 0, 0)?.toNumber()).toBe(0.5);
    expect(crossing(pts, 0, 2)?.toNumber()).toBe(1.5);
    expect(crossing([{ x: 0, y: 3 }, { x: 1, y: 0 }], 0, 0)?.toNumber()).toBe(1);
    expect(crossing([{ x: 0, y: 3 }, { x: 1, y: 2 }], 0, 0)).toBeNull();
  });
});

describe("поиск смены знака", () => {
  const drain = (g: Generator<void, boolean>) => {
    let n = 0;
    for (;;) {
      const r = g.next();
      if (r.done) return { found: r.value, n };
      n++;
    }
  };

  it("находит отрезок за пределами первого шага и сужает его", () => {
    const xs: number[] = [];
    const f = (x: number) => {
      xs.push(x);
      return 1000 - x * x;
    };
    const { found, n } = drain(signChange(f, 0, 1000, 5));
    expect(found).toBe(true);
    expect(n).toBe(xs.length);
    const root = Math.sqrt(1000);
    const near = xs.reduce((a, b) => (Math.abs(b - root) < Math.abs(a - root) ? b : a));
    expect(Math.abs(near - root) / root).toBeLessThan(1e-3);
  });

  it("не выходит за предел и сообщает, что смены знака нет", () => {
    const xs: number[] = [];
    const { found } = drain(signChange((x) => (xs.push(x), 5 + x), 0, 5, 0.01, 1));
    expect(found).toBe(false);
    expect(Math.max(...xs)).toBe(1);
  });
});

describe("пробные расчёты: изменение цены продаж и ключевой ставки", () => {
  it("ключевая ставка сдвигается целиком: текущая и по годам", () => {
    const path = { current: 0.14, as_of: "2026-09-11", by_year: { 2027: 0.124, 2028: 0.1 } };
    expect(shiftKeyRate(path, 0.01)).toEqual({ current: 0.15, as_of: "2026-09-11", by_year: { 2027: 0.134, 2028: 0.11 } });
    expect(shiftKeyRate(path, 0)).toBe(path);
    expect(shiftKeyRate(0.1, 0.02)).toBe(0.12);
  });

  it("цены плана продаж × (1 + изменение), остальные поля не меняются", () => {
    const rows = [{ name: "Квартиры", start_price: 400000, stock_area: 100 }, { name: "Без цены" }];
    expect(shiftPrices(rows, -0.1)).toEqual([{ name: "Квартиры", start_price: 360000, stock_area: 100 }, { name: "Без цены" }]);
  });
});

// ---------- отчёт по варианту целиком ----------

const analog = (name: string, cls: string, price: number, pace: number) => ({ name, product: "квартиры", housing_class: cls, price, pace, url: "https://наш.дом.рф/" });

const MSK: CalcProject = {
  assumptionsVersion: 5,
  input: {
    mode: "normal",
    values: {
      "GEN.PROJECT_STAGE": "оценка участка",
      "GEN.REGION_CODE": "77",
      "LAND.AREA": 32000,
      "LAND.TENURE": "собственность",
      "LAND.VRI_CODES": ["2.6"],
      "LAND.CADASTRAL_VALUE": 1500000000,
      "LAND.PURCHASE_PRICE": 2400000000,
      "GPZU.MAX_GFA_ABOVE": 110000,
      "GPZU.MAX_FLOORS": 24,
      "GPZU.MAX_BUILT_SHARE": 0.4,
      "GEN.MODEL_START_DATE": "2026-09-30",
      "GEN.VALUATION_DATE": "2026-09-30",
      "VAL.RISK_FREE": 0.14,
      "VAL.EQUITY_PREMIUM": 0.06,
      "VAL.HURDLE_IRR": 0.18,
      "MARKET.ANALOGS": [analog("ЖК 1", "бизнес", 650000, 1500), analog("ЖК 2", "бизнес", 670000, 1200), analog("ЖК 3", "бизнес", 630000, 1800)],
      // Механика отчёта проверяется на выгодном участке: обязательства перед городом — по договору 0, зданий под снос нет
      // (компенсация по нормативу и снос проверяются в analysis.test.ts)
      "LAND.CITY_CASH_COMPENSATION": 0,
      "SITE.DEMOLITION_GFA": 0,
    },
  },
};

describe("итоговый отчёт по варианту", () => {
  const sa = analyzeSite(MSK);
  const v = sa.variants.find((x) => x.housing_class === "бизнес" && x.floors === 24);
  if (!v) throw new Error("нет варианта бизнес-24");
  const s = computeVariant(MSK, v);
  const r = variantReportSync(MSK, s);

  it("максимальная цена участка: при ней NPV акционера равен нулю, полный пересчёт", () => {
    expect(r.blocked).toBeNull();
    const land = r.land as LandMax;
    expect(land.unprofitable).toBe(false);
    const max = land.max_price?.toNumber() ?? 0;
    // NPV при цене продавца положителен — максимальная цена выше неё
    expect(s.npv?.gt(0)).toBe(true);
    expect(max).toBeGreaterThan(2400000000);
    expect(land.reserve?.toNumber()).toBeCloseTo(max - 2400000000, 0);
    // Проверка: полный расчёт при найденной цене даёт NPV около нуля (меньше 0,1 % цены)
    const at = computeVariant({ ...MSK, input: { ...MSK.input, values: { ...MSK.input.values, "LAND.PURCHASE_PRICE": max } } }, v);
    expect(Math.abs(at.npv?.toNumber() ?? Infinity)).toBeLessThan(max / 1000);
    // Цена при целевой IRR 18 %: IRR акционера при ней — 18 %
    const hurdlePrice = land.max_price_irr?.toNumber() ?? 0;
    expect(hurdlePrice).toBeGreaterThan(0);
    const atIrr = computeVariant({ ...MSK, input: { ...MSK.input, values: { ...MSK.input.values, "LAND.PURCHASE_PRICE": hurdlePrice } } }, v);
    expect(atIrr.irr?.toNumber()).toBeCloseTo(0.18, 3);
  });

  it("«что, если»: таблица 5 × 5, в центре — расчёт варианта, цена влияет на NPV", () => {
    const sens = r.sens as Sensitivity;
    expect(sens.grid).toHaveLength(5);
    expect(sens.grid.every((row) => row.length === 5 && row.every((x) => x !== null))).toBe(true);
    expect(sens.grid[2]?.[2]?.toNumber()).toBeCloseTo(s.npv?.toNumber() ?? 0, 0);
    const col = sens.grid.map((row) => row[2]?.toNumber() ?? 0);
    for (let i = 1; i < col.length; i++) expect(col[i]).toBeGreaterThan(col[i - 1] as number);
    // Цена продаж может упасть до точки безубыточности: NPV в ней около нуля
    expect(sens.price_breakeven?.isNeg()).toBe(true);
    expect(reportTotal(MSK)).toBe(35);
  }, 60000);

  it("графики: продажи по кварталам до 100 % площади, окупаемость после пика вложений", () => {
    expect(r.sales?.keys.length).toBeGreaterThan(0);
    expect(r.sales?.soldShare.at(-1)).toBeCloseTo(1, 6);
    expect(r.sales?.value.every((x) => x >= 0)).toBe(true);
    expect(r.cash?.peak).toBeGreaterThan(0);
    expect((r.cash?.payback ?? "") > (r.cash?.peakDate ?? "")).toBe(true);
    expect(r.cash?.paybackMonths).toBeGreaterThan(0);
  });

  it("тексты отчёта", () => {
    const land = landReportView(r.land as LandMax, s.discountRate);
    expect(land.value).toMatch(/^[\d\s ]+ млн руб$/);
    expect(land.reserve).toMatch(/^запас [\d\s ]+ млн руб · [\d,]+ %$/);
    const sens = sensView(r.sens as Sensitivity);
    expect(sens.cols[0]).toBe("−2 п.п.");
    expect(sens.rows[0]?.label).toBe("−10 %");
    expect(sens.rows[2]?.cells[2]?.base).toBe(true);
    expect(sens.priceLine).toMatch(/^Цена продаж может упасть на [\d,]+ %, пока проект выгоден$/);
    expect(salesView(r.sales)?.bars.length).toBe(r.sales?.keys.length);
    expect(cashView(r.cash)?.payback).toMatch(/\d{4}$/);
  });

  it("без ставки дисконтирования — только графики и причина", () => {
    const noRate: CalcProject = { ...MSK, assumptionsVersion: 2, input: { ...MSK.input, values: { ...MSK.input.values, "VAL.EQUITY_PREMIUM": null } } };
    const s2 = computeVariant(noRate, v);
    const r2 = variantReportSync(noRate, s2);
    expect(r2.blocked).toContain("ставка дисконтирования");
    expect(r2.land).toBeNull();
    expect(r2.sales).not.toBeNull();
  });
});

void Decimal;
