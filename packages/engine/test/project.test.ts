import Decimal from "decimal.js";
import { describe, expect, it } from "vitest";
import { aggregate, calculate, clarifyBeforeDecision, compatWarnings, computeProject, DOUBLE_GROWTH, inMode, legacyProject, periodKey, projectHorizon, STAGE_UPLIFT_NOT_COUNTED, type CalcProject } from "../src";
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
    expect(m.missing.has("LAND.VRI_FEE")).toBe(true);
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

describe("значения расчёта сервиса, временно перенесённые из исходного файла", () => {
  it("рыночный рост цен: 2% в квартал из исходного файла → 8,24% в год на весь срок, не подтверждено", () => {
    const [growth] = demo.fromFile ?? [];
    expect(growth).toMatchObject({ param: "SALES.PRICE_MARKET_GROWTH", label: "Экспертное значение", status: "не подтверждено", note: "Перенесено из исходного файла, без обоснования рынком, требует подтверждения" });
    const v = demo.input.values["SALES.PRICE_MARKET_GROWTH"] as { by_year: Record<string, number>; after_last: string };
    expect(v.after_last).toBe("last");
    expect(v.by_year["2025"]).toBeCloseTo(0.08243216, 10);
  });

  it("рост по стадиям готовности — отдельный параметр, из исходного файла не заполняется", () => {
    expect(demo.input.values["SALES.PRICE_STAGE_UPLIFT"]).toBeUndefined();
    expect(demo.fromFile?.map((a) => a.param)).not.toContain("SALES.PRICE_STAGE_UPLIFT");
  });
});

describe("расчёт сервиса без Excel: пробелы Дербеневской", () => {
  const normal = inMode(demo, "normal");
  const m = computeProject(normal);
  const keys = (x: ReturnType<typeof computeProject>) => x.result.messages.map((w) => w.key);
  const withUplift = (p: CalcProject, values: Record<string, unknown> = {}): CalcProject => ({
    ...p,
    input: { ...p.input, values: { ...p.input.values, "SALES.PRICE_STAGE_UPLIFT": [{ stage: "РНВ", uplift: 0.05 }], ...values } },
  });

  it("пустой рост по стадиям — «не учтено»: цена и выручка считаются, в сообщениях отметка", () => {
    expect(m.missing.has("SALES.PRICE_STAGE_UPLIFT")).toBe(false);
    expect(keys(m)).toContain(STAGE_UPLIFT_NOT_COUNTED);
    expect(m.result.formulas["F.SALES.PRICE"]?.value).toBeDefined();
  });

  it("рост по стадиям заполнен, а рыночный рост из исходного файла не пересмотрен — предупреждение о двойном росте", () => {
    const filled = computeProject(withUplift(normal));
    expect(keys(filled)).not.toContain(STAGE_UPLIFT_NOT_COUNTED);
    const w = filled.result.messages.find((x) => x.key === `${DOUBLE_GROWTH}:SALES.PRICE_STAGE_UPLIFT`);
    expect(w?.severity).toBe("warning");
    expect(w?.text).toMatch(/дважды/);
    const revised = computeProject(withUplift(normal, { "SALES.PRICE_MARKET_GROWTH": { by_year: { "2025": 0.05 }, after_last: "last" } }));
    expect(keys(revised).filter((k) => k?.startsWith(DOUBLE_GROWTH))).toEqual([]);
    expect(keys(computeProject(withUplift(demo))).filter((k) => k?.startsWith(DOUBLE_GROWTH))).toEqual([]);
  });

  it("начало и окончание СМР — из вех исходного файла (ТЭПы!C7, C9), метка «исходный файл», только в расчёте сервиса", () => {
    const smr = demo.fromFile?.filter((a) => a.param === "TIME.MILESTONES") ?? [];
    expect(smr.map((a) => [a.column, a.value, a.label])).toEqual([
      ["construction_start", "2025-12-31", "исходный файл"],
      ["construction_end", "2032-03-31", "исходный файл"],
    ]);
    const rows = m.input.values["TIME.MILESTONES"] as { construction_start: string; construction_end: string }[];
    expect(rows.map((r) => [r.construction_start, r.construction_end])).toEqual([
      ["2025-12-31", "2032-03-31"],
      ["2025-12-31", "2032-03-31"],
      ["2025-12-31", "2032-03-31"],
    ]);
    const legacyRows = computeProject(demo).input.values["TIME.MILESTONES"] as { construction_start?: string }[];
    expect(legacyRows.every((r) => r.construction_start === undefined)).toBe(true);
  });

  it("прочие СМР, УДС, маркетинг, брокеридж: график по справочнику — в денежный поток попадает 100% суммы", () => {
    expect(m.result.messages.filter((x) => x.formulaId === "F.CAPEX.SCHEDULE_WEIGHT" && x.severity === "error")).toEqual([]);
    const cash = m.result.formulas["F.CAPEX.ITEM_CASH"]?.value as Record<string, Decimal[]>;
    const sum = (xs: Decimal[] | undefined) => (xs ?? []).reduce((a, b) => a.add(b), new Decimal(0));
    expect(sum(cash.MARKETING).toNumber()).toBeCloseTo(4194809207.75, 0);
    expect(sum(cash.BROKERAGE).toNumber()).toBeCloseTo(4134560080.857636, 0);
    expect(sum(cash.ROADS_UDS).gt(0)).toBe(true);
    expect(sum(cash.OTHER_SMR).gt(0)).toBe(true);
  });

  it("земельные статьи в расчёте сервиса — по формулам: агентское 2% × цена участка, налог 0,1% × 2/4, плата за ВРИ ждёт расчёта", () => {
    const items = m.result.formulas["F.CAPEX.ITEM_TOTAL"]?.value as Record<string, Decimal | null | undefined>;
    expect(items.LAND_AGENT?.toNumber()).toBeCloseTo(26607117.96, 2); // 2% × 1 330 355 898 (цена участка), без НДС
    expect(items.LAND_VRI ?? null).toBeNull();
    // Налог за год при коэффициенте 2: 5 834 907 660 × 0,1% × 2 = 11 669 815,32 — как в исходном файле (0,2% × кадастровая, CF1 строка 84)
    const tax = m.result.formulas["F.LAND.TAX_OR_RENT"]?.value as Decimal[];
    const dates = m.result.formulas["F.TIME.DATE"]?.value as string[];
    const year = (y: string) => tax.reduce((s, x, t) => (dates[t]!.startsWith(y) ? s.add(x) : s), new Decimal(0)).toNumber();
    expect(year("2026")).toBeCloseTo(11669815.32, 2);
    expect(year("2029")).toBeCloseTo(23339630.64, 2); // с 4-го года — коэффициент 4
    expect(items.LAND_TAX_OR_RENT?.toNumber()).toBeCloseTo(94331007.17, 2);
    expect(m.result.messages.map((x) => x.key)).toContain("LAND.HANDOVER_END_MISSING");
  });

  it("форма права и смена ВРИ — из исходного файла, «уточнить»; в «Уточнить перед решением» — земля при собственности и аренде", () => {
    const land = demo.fromFile?.filter((a) => a.param === "LAND.TENURE" || a.param === "LAND.VRI_CHANGE") ?? [];
    expect(land.map((a) => [a.param, a.value, a.label, a.status])).toEqual([
      ["LAND.TENURE", "собственность", "исходный файл", "уточнить"],
      ["LAND.VRI_CHANGE", true, "исходный файл", "уточнить"],
    ]);
    const items = clarifyBeforeDecision(normal, m);
    const tenure = items.find((x) => x.param === "LAND.TENURE");
    expect(tenure?.compare?.map((c) => [c.label, c.amount?.round().toNumber() ?? null])).toEqual([
      ["собственность", 94331007],
      ["аренда", null],
    ]);
    expect(tenure?.impact).toMatch(/при аренде не учтены/);
    expect(items.find((x) => x.param === "LAND.VRI_CHANGE")?.impact).toMatch(/если смена не нужна, платы нет/);
    expect(clarifyBeforeDecision(demo, computeProject(demo))).toEqual([]);
    const noVri = computeProject({ ...normal, input: { ...normal.input, values: { ...normal.input.values, "LAND.VRI_CHANGE": false } } });
    expect((noVri.result.formulas["F.LAND.VRI_FEE"]?.value as Decimal).toNumber()).toBe(0);
  });

  it("машино-места в расчёте сервиса — по нормативу Москвы (до 70 м² — 0,8; 70–100 м² — 1,2)", () => {
    // 961 × 0,8 (35,1 м²) + 720 × 0,8 (60,5 м²) + 720 × 1,2 (92 м²) = 2 208,8 → 2 209
    expect((m.result.formulas["F.TEP.PARKING_REQUIRED"]?.value as Decimal).toNumber()).toBe(2209);
    expect(m.missing.has("TEP.PARKING_NORM")).toBe(false);
  });

  it("без Excel не хватает только платы за ВРИ, облагаемой доли содержания застройщика и безрисковой ставки", () => {
    expect([...m.missing].sort()).toEqual(["LAND.VRI_FEE", "OPEX.OVERHEAD_VAT_SHARE", "VAL.RISK_FREE"]);
  });

  it("цепочка до показателей: налоги в потребности в кредите, поток акционера, IRR, прибыль", () => {
    const f = m.result.formulas;
    const taxes = f["F.TAX.PAYMENTS"]?.value as { total: Decimal[]; profit_tax_paid: Decimal[] };
    const sum = (xs: Decimal[]) => xs.reduce((a, b) => a.add(b), new Decimal(0));
    expect(sum(taxes.profit_tax_paid).gt(0)).toBe(true);
    const tax = f["F.TAX.PROFIT_TAX"]?.value as { tax: Decimal[] };
    expect(sum(taxes.profit_tax_paid).toNumber()).toBeCloseTo(sum(tax.tax).toNumber(), 2);
    const margin = f["F.KPI.MARGIN"]?.value as { net_profit: Decimal; gross_profit: Decimal };
    const fcfe = f["F.CF.FCFE"]?.value as Decimal[];
    // Без выплат акционеру накопленный поток акционера = чистая прибыль (НДС к уплате за последний квартал — в пределах расчёта)
    expect(sum(fcfe).toNumber()).toBeCloseTo(margin.net_profit.toNumber(), -3);
    expect((f["F.KPI.IRR"]?.value as { irr_equity: Decimal | null }).irr_equity).not.toBeNull();
    const cash = f["F.CF.CASH_BALANCE"]?.value as Decimal[];
    expect(cash.every((x) => x.gte(-1))).toBe(true);
    expect(m.horizon).toBeGreaterThanOrEqual(f["F.CF.HORIZON"]?.value as number);
  });

  it("проверки модели: ГНС по частям больше наземной на 7 500 м², очереди 1 и 2 без продуктов, выручка = поток", () => {
    const checks = Object.fromEntries((m.result.formulas["F.CHECK.ALL"]?.value as { id: string; status: string }[]).map((c) => [c.id, c.status]));
    expect(checks).toMatchObject({
      GFA_SPLIT_LE_ABOVE: "ошибка",
      DDU_AFTER_RNS: "сходится",
      PHASE_WINDOWS: "предупреждение",
      REVENUE_EQ_CF: "сходится",
      SOLD_LE_MARKET: "ждёт данных",
      GPZU_LIMITS: "ждёт данных",
      DEBT_REPAID: "сходится",
    });
    const gfa = m.result.messages.find((x) => x.key === "CHECK.GFA_SPLIT_LE_ABOVE");
    expect(gfa?.text).toMatch(/229\s467\sм² — больше наземной ГНС 221\s967\sм² на 7\s500\sм²/);
    expect(m.missing.has("TEP.GFA_ABOVE")).toBe(false);
    // В расчёте «как в исходном Excel» найденное — справка, не ошибка
    const legacy = computeProject(demo).result.messages.filter((x) => x.key?.startsWith("CHECK."));
    expect(legacy.every((x) => x.severity === "info")).toBe(true);
  });

  it("продажи по ДДУ раньше РНС — ошибка; ГПЗУ: превышение предела — ошибка, решение об отклонении снимает её", () => {
    const rows = normal.input.values["TIME.MILESTONES"] as { phase: number; rns_date: string }[];
    const early = computeProject({ ...normal, input: { ...normal.input, values: { ...normal.input.values, "TIME.MILESTONES": rows.map((r) => (r.phase === 3 ? { ...r, rns_date: "2027-12-31" } : r)) } } });
    expect(early.result.messages.find((x) => x.key === "CHECK.DDU_AFTER_RNS")?.severity).toBe("error");
    const gpzu = (extra: Record<string, unknown>) =>
      (computeProject({ ...normal, input: { ...normal.input, values: { ...normal.input.values, "GPZU.MAX_GFA_ABOVE": 200000, ...extra } } }).result.formulas["F.CHECK.GPZU_LIMITS"]?.value as { status: string }).status;
    expect(gpzu({})).toBe("ошибка");
    expect(gpzu({ "GPZU.DEVIATION_PERMIT": [{ limit: "GPZU.MAX_GFA_ABOVE", permitted_value: 222000, decision: "решение", attachment_id: "x" }] })).toBe("сходится");
  });
});
