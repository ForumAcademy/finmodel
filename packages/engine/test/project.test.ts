import Decimal from "decimal.js";
import { describe, expect, it } from "vitest";
import { aggregate, calculate, compatWarnings, computeProject, legacyProject, periodKey, projectHorizon, type CalcProject } from "../src";
import { loadCase } from "./support/cases";

const demo = legacyProject(loadCase("derbenevskaya_legacy"), "Дербеневская (демо)");

describe("расчёт проекта целиком", () => {
  const m = computeProject(demo);

  it("ТЭП и машино-места считаются на стадии «Концепция»", () => {
    expect((m.result.formulas["F.TEP.SALEABLE_AREA"]?.value as Decimal).toNumber()).toBe(153882.388);
    expect((m.result.formulas["F.TEP.PARKING_COUNT"]?.value as Decimal).toNumber()).toBe(862);
    expect((m.result.formulas["F.TEP.GFA_SPLIT"]?.value as { res: Decimal }).res.toNumber()).toBe(210458);
  });

  it("бюджет: «Компенсация городу» в денежном потоке, УДС — как в исходнике, только в бюджете", () => {
    const cash = m.result.formulas["F.CAPEX.ITEM_CASH"]?.value as Record<string, Decimal[]>;
    const sum = (xs: Decimal[] | undefined) => (xs ?? []).reduce((a, b) => a.add(b), new Decimal(0)).toNumber();
    expect(sum(cash.CITY_CASH_COMPENSATION)).toBe(1260033986.66);
    expect(sum(cash.ROADS_UDS)).toBe(0);
    expect(compatWarnings(demo, m).map((w) => w.key)).toContain("CAPEX.SCHEDULE_SUM:ROADS_UDS");
    expect((m.result.formulas["F.CAPEX.TOTAL"]?.value as Decimal).gt(0)).toBe(true);
  });

  it("незаполненные обязательные параметры видны", () => {
    expect(m.missing.has("TAX.LAND_RATE")).toBe(true);
    expect(m.missing.has("LAND.AREA")).toBe(false);
  });

  it("горизонт (предварительно) — до последней вехи + лаг раскрытия эскроу, но не короче ручных графиков бюджета и темпа продаж", () => {
    // старт 31.12.2025, последняя веха 31.03.2032 → 75 мес. + 1 + лаг 3 = 79;
    // продажи ПСН исходника — по 4 кв 2033 → декабрь 2033 = 96 мес. + 1 = 97;
    // маркетинг в CF1 (строка 79, сдвиг на 7 кварталов) — по 3 кв 2035 → сентябрь 2035 = 117 мес. + 1
    expect(projectHorizon(demo)).toBe(118);
  });

  it("раскрытие эскроу: «как в исходном Excel» — дата исходника, в расчёте сервиса — РНВ + 3 месяца, и перенос РНВ его сдвигает", () => {
    const rows = demo.input.values["TIME.MILESTONES"] as { phase: number; rnv_date: string }[];
    const moved: CalcProject = { ...demo, input: { ...demo.input, values: { ...demo.input.values, "TIME.MILESTONES": rows.map((r) => (r.phase === 1 ? { ...r, rnv_date: "2029-12-31" } : r)) } } };
    const release = (p: CalcProject) => {
      const r = computeProject(p).result.formulas;
      const t = (r["F.TIME.FLAG_ESCROW_RELEASE"]?.value as number[][])[0]!.indexOf(1);
      return (r["F.TIME.DATE"]?.value as string[])[t];
    };
    expect(release(demo)).toBe("2031-09-30");
    expect(release(moved)).toBe("2031-09-30");
    const normal = (p: CalcProject) => {
      const r = calculate({ ...p.input, mode: "normal" }, { horizonMonths: projectHorizon(p) ?? 0 }, ["F.TIME.FLAG_ESCROW_RELEASE"]).formulas;
      const t = (r["F.TIME.FLAG_ESCROW_RELEASE"]?.value as number[][])[0]!.indexOf(1);
      return (r["F.TIME.DATE"]?.value as string[])[t];
    };
    expect(normal(demo)).toBe("2029-12-31");
    expect(normal(moved)).toBe("2030-03-31");
  });

  it("периоды отчёта: месяц, квартал, год; потоки суммируются", () => {
    const dates = ["2025-12-31", "2026-01-31", "2026-02-28", "2026-03-31", "2026-04-30"];
    expect(periodKey("2026-02-28", "quarter")).toBe("1 кв 2026");
    expect(periodKey("2026-02-28", "month")).toBe("02.2026");
    expect(aggregate([1, 2, 3, 4, 5], dates, "quarter")).toEqual({ keys: ["4 кв 2025", "1 кв 2026", "2 кв 2026"], sums: [1, 9, 5] });
    expect(aggregate([1, 2, 3, 4, 5], dates, "year").sums).toEqual([1, 14]);
    expect(aggregate([1, 2, 3, 4, 5], dates, "quarter", "last").sums).toEqual([1, 4, 5]);
  });
});
