import { describe, expect, it } from "vitest";
import { FORMULA_IDS, formulaFnName, getFormula, type FormulaId } from "@fm/spec";
import { FORMULAS, IMPLEMENTED_MODULES } from "../src";

describe("одна формула = одна функция (CLAUDE.md, правило 2)", () => {
  const implemented = new Set<string>(IMPLEMENTED_MODULES);

  it("у каждой формулы реализованных модулей есть функция", () => {
    const missing = FORMULA_IDS.filter((id) => implemented.has(getFormula(id).module) && !FORMULAS[id]);
    expect(missing).toEqual([]);
  });

  it("каждая функция соответствует формуле из formulas.yaml и названа по её ID", () => {
    for (const [id, fn] of Object.entries(FORMULAS)) {
      expect(FORMULA_IDS).toContain(id);
      expect(fn.name).toBe(formulaFnName(id as FormulaId));
    }
  });
});
