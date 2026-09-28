import { describe, expect, it } from "vitest";
import { Engine, FORMULAS, type FormulaContext, type ProjectInput } from "../src/index";

/** Справочник допущений компании: значение проекта → стандарт компании → значение по умолчанию (parameters.yaml). */
describe("стандартные значения компании в расчёте", () => {
  it("стандарт главнее значения по умолчанию, значение проекта главнее стандарта", () => {
    const trace = (input: ProjectInput) => {
      const e = new Engine(input, { ...FORMULAS, "F.TIME.DATE": (ctx: FormulaContext) => ctx.param("TIME.ESCROW_RELEASE_LAG_M") }, { horizonMonths: 1 });
      return e.run(["F.TIME.DATE"]).parameters["TIME.ESCROW_RELEASE_LAG_M"];
    };
    expect(trace({ values: {} })).toMatchObject({ value: 3, origin: "template" });
    expect(trace({ values: {}, standard: { "TIME.ESCROW_RELEASE_LAG_M": 2 } })).toMatchObject({ value: 2, origin: "standard" });
    expect(trace({ values: { "TIME.ESCROW_RELEASE_LAG_M": 1 }, standard: { "TIME.ESCROW_RELEASE_LAG_M": 2 } })).toMatchObject({ value: 1, origin: "project" });
  });
});
