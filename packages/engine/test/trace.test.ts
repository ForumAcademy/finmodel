import { describe, expect, it } from "vitest";
import { getFormula, type FormulaId } from "@fm/spec";
import { calculate, type ResultSet } from "../src";
import { legacyInput, loadCase } from "./support/cases";

/** Формула читает только то, что объявлено в её depends_on (formulas.yaml) — паспорт показателя не врёт. */
function undeclared(r: ResultSet): string[] {
  return Object.values(r.formulas).flatMap((node) => {
    const declared = new Set<string>(getFormula(node!.id as FormulaId).depends_on);
    return node!.inputs.filter((i) => !declared.has(i)).map((i) => `${node!.id} читает ${i}`);
  });
}

describe("след расчёта совпадает с depends_on спецификации", () => {
  it("Дербеневская (концепция, расчёт «как в исходном Excel»)", () => {
    const r = calculate(legacyInput(loadCase("derbenevskaya_legacy")), { horizonMonths: 120 });
    expect(Object.keys(r.formulas).length).toBeGreaterThan(10);
    expect(undeclared(r)).toEqual([]);
  });

  it("оценка участка и земельный налог", () => {
    const r = calculate(
      {
        values: {
          "GEN.PROJECT_STAGE": "оценка участка",
          "GEN.REGION_CODE": "77",
          "GEN.MODEL_START_DATE": "2025-12-31",
          "LAND.AREA": 10000,
          "LAND.CADASTRAL_VALUE": 1e9,
          "LAND.VRI_FEE": 0,
          "TAX.LAND_RATE": 0.015,
          "TEP.FOOTPRINT_AREA": 3000,
          "TEP.AVG_FLOORS": 12,
          "TEP.RES_GFA_SHARE": 0.9,
          "TEP.APT_EFFICIENCY": 0.7,
          "TEP.COMM_EFFICIENCY": 0.6,
          "TEP.APT_MIX": [{ type_name: "Все", area_share: 1, avg_area: 50 }],
          "TEP.STORAGE_PER_APT": 0.3,
          "TEP.STORAGE_AVG_AREA": 4,
          "TEP.PARKING_AREA_PER_SPACE": 35,
          "TEP.LANDSCAPE_SHARE": 0.4,
          "TEP.ROAD_SHARE": 0.2,
          "TEP.GREEN_SHARE": 0.3,
          "TIME.MILESTONES": [
            { phase: 1, land_acquired: "2025-12-31", sales_start: "2026-06-01", construction_start: "2026-03-01", construction_end: "2028-12-31", rnv_date: "2029-03-31", handover_end: "2029-09-30" },
          ],
        },
      },
      { horizonMonths: 48 },
    );
    // бюджет и продажи в этом проекте не заполнены — их ошибки «заполните …» здесь не проверяются
    expect(r.messages.filter((m) => m.severity === "error" && !/^F\.(CAPEX|SALES|ESC|FIN)\./.test(m.formulaId))).toEqual([]);
    expect(undeclared(r)).toEqual([]);
  });
});
