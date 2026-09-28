import { describe, expect, it } from "vitest";
import { calculate } from "../src";

const milestones = [
  {
    phase: 1,
    land_acquired: "2025-12-15",
    sales_start: "2026-02-10",
    construction_start: "2026-03-01",
    construction_end: "2026-06-15",
    rnv_date: "2026-05-20",
    handover_end: "2026-07-31",
  },
];
const input = { values: { "GEN.MODEL_START_DATE": "2025-12-31", "TIME.MILESTONES": milestones } };
const run = () => calculate(input, { horizonMonths: 8 });

describe("TIME", () => {
  it("F.TIME.DATE — концы месяцев от даты начала", () => {
    expect(run().formulas["F.TIME.DATE"]?.value).toEqual([
      "2025-12-31", "2026-01-31", "2026-02-28", "2026-03-31", "2026-04-30", "2026-05-31", "2026-06-30", "2026-07-31",
    ]);
  });

  it("F.TIME.DAYS — дни в месяце, для t = 0 — день даты", () => {
    expect(run().formulas["F.TIME.DAYS"]?.value).toEqual([31, 31, 28, 31, 30, 31, 30, 31]);
  });

  it("флаги стройки, ДДУ, ДКП и раскрытия эскроу — по настоящим датам", () => {
    const f = calculate(input, { horizonMonths: 10 }, ["F.TIME.FLAG_CONSTRUCTION", "F.TIME.FLAG_PRESALE", "F.TIME.FLAG_POST_RNV", "F.TIME.FLAG_ESCROW_RELEASE"]).formulas;
    expect(f["F.TIME.FLAG_CONSTRUCTION"]?.value).toEqual([[0, 0, 0, 1, 1, 1, 0, 0, 0, 0]]);
    expect(f["F.TIME.FLAG_PRESALE"]?.value).toEqual([[0, 0, 1, 1, 1, 0, 0, 0, 0, 0]]);
    expect(f["F.TIME.FLAG_POST_RNV"]?.value).toEqual([[0, 0, 0, 0, 0, 1, 1, 1, 1, 1]]);
    // РНВ в мае (t = 5) + лаг по умолчанию 3 месяца (TIME.ESCROW_RELEASE_LAG_M) → август
    expect(f["F.TIME.FLAG_ESCROW_RELEASE"]?.value).toEqual([[0, 0, 0, 0, 0, 0, 0, 0, 1, 0]]);
  });

  it("лаг раскрытия эскроу 1 месяц (чувствительность) → раскрытие в июне", () => {
    const f = calculate({ ...input, values: { ...input.values, "TIME.ESCROW_RELEASE_LAG_M": 1 } }, { horizonMonths: 10 }, ["F.TIME.FLAG_ESCROW_RELEASE"]).formulas;
    expect(f["F.TIME.FLAG_ESCROW_RELEASE"]?.value).toEqual([[0, 0, 0, 0, 0, 0, 1, 0, 0, 0]]);
  });

  it("веха текстом вместо даты — ошибка с указанием очереди (ошибка исходника №1)", () => {
    const r = calculate(
      { values: { ...input.values, "TIME.MILESTONES": [{ ...milestones[0], rnv_date: "4 кв 2025" }] } },
      { horizonMonths: 8 },
      ["F.TIME.FLAG_POST_RNV"],
    );
    expect(r.messages).toContainEqual(expect.objectContaining({ severity: "error", parameterId: "TIME.MILESTONES", text: expect.stringContaining("Очередь 1: заполните веху «РНВ»") }));
  });
});
