import { describe, expect, it } from "vitest";
import {
  FORMULA_IDS,
  PARAMETER_IDS,
  formulaFnName,
  getCapexItem,
  getFormula,
  getParameter,
  getRegion,
  getSource,
  isParameterId,
  spec,
  type FormulaFnName,
  type ParameterId,
} from "../src/index";

describe("типизированные ID", () => {
  it("поиск по ID возвращает запись с тем же ID", () => {
    expect(getParameter("TAX.VAT_RATE").id).toBe("TAX.VAT_RATE");
    expect(getFormula("F.FIN.RATE").module).toBe("FIN");
    expect(getSource("S_NK_164").level).toBe(1);
    expect(getCapexItem("LAND_PURCHASE").rate_param).toBe("LAND.PURCHASE_PRICE");
    expect(getRegion("77").name).toBe("г. Москва");
  });

  it("опечатка в ID — ошибка компиляции", () => {
    // Проверяется `pnpm typecheck`: без ошибки типа директива @ts-expect-error сама станет ошибкой.
    // @ts-expect-error — такого параметра нет в data/parameters.yaml
    expect(() => getParameter("TAX.VAT_RAET")).toThrow("отсутствует в справочнике");
    // @ts-expect-error — такой формулы нет в data/formulas.yaml
    expect(() => getFormula("F.FIN.RAET")).toThrow();
    // @ts-expect-error — такого источника нет в data/sources.yaml
    expect(() => getSource("S_NK_999")).toThrow();
    // @ts-expect-error — такого региона нет в data/regions.yaml
    expect(() => getRegion("00")).toThrow();
    // @ts-expect-error — ParameterId не принимает произвольную строку
    const id: ParameterId = "GEN.WHATEVER";
    expect(isParameterId(id)).toBe(false);
  });

  it("строки извне проверяются type guard-ом", () => {
    expect(isParameterId("GEN.REGION_CODE")).toBe(true);
    expect(isParameterId("GEN.REGION")).toBe(false);
  });

  it("union-типы содержат ровно ID справочника", () => {
    expect(PARAMETER_IDS).toEqual(spec.parameters.map((p) => p.id));
    expect(FORMULA_IDS).toEqual(spec.formulas.map((f) => f.id));
  });

  it("имя функции ядра совпадает с ID формулы (CLAUDE.md, правило 2)", () => {
    const name: FormulaFnName<"F.FIN.RATE"> = formulaFnName("F.FIN.RATE");
    expect(name).toBe("F_FIN_RATE");
    expect(new Set(FORMULA_IDS.map(formulaFnName)).size).toBe(FORMULA_IDS.length);
  });
});
