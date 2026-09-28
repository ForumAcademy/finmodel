import Decimal from "decimal.js";
import { describe, expect, it } from "vitest";
import { getFormula, spec } from "@fm/spec";
import { calculate, type ResultSet } from "../src";
import { legacyInput, loadCase } from "./support/cases";

type Series = Record<string, Decimal[]>;
type Amounts = Record<string, Decimal>;

const sum = (xs: Decimal[]) => xs.reduce((a, b) => a.add(b), new Decimal(0));
const series = (r: ResultSet, id: "F.CAPEX.SCHEDULE_WEIGHT" | "F.CAPEX.INDEX" | "F.CAPEX.ITEM_CASH") => r.formulas[id]?.value as Series;
const totals = (r: ResultSet) => r.formulas["F.CAPEX.ITEM_TOTAL"]?.value as Amounts;

const project = (items: Record<string, unknown>[], extra: Record<string, unknown> = {}) => ({
  values: {
    "GEN.MODEL_START_DATE": "2025-12-31",
    "GEN.REGION_CODE": "77",
    "TIME.MILESTONES": [
      { phase: 1, land_acquired: "2026-01-16", construction_start: "2026-01-15", construction_end: "2026-05-10", rnv_date: "2026-03-16", handover_end: "2026-12-31" },
      { phase: 2, land_acquired: "2026-02-01", construction_start: "2026-02-15", construction_end: "2026-04-30", rnv_date: "2026-03-01", handover_end: "2026-12-31" },
    ],
    "CAPEX.ITEMS": items,
    ...extra,
  },
});

describe("CAPEX: график статьи (F.CAPEX.SCHEDULE_WEIGHT)", () => {
  const r = calculate(
    project([
      { item_id: "SMR_ABOVE", base: "фикс", rate: 1000, price_date: "2025-12-31" },
      { item_id: "EXTERNAL_NETWORKS", rate: 400, price_date: "2025-12-31" },
      { item_id: "SITE_SECURITY", rate: 31, price_date: "2025-12-31" },
      { item_id: "PREDESIGN", rate: 5, price_date: "2025-12-31" },
      { item_id: "OTHER_SMR", base: "фикс", rate: 70, price_date: "2025-12-31" },
    ]),
    { horizonMonths: 12 },
    ["F.CAPEX.ITEM_CASH"],
  );
  const w = series(r, "F.CAPEX.SCHEDULE_WEIGHT");
  const num = (id: string) => (w[id] ?? []).map((x) => x.toNumber());

  it("пример из formulas.yaml: S-кривая на 4 месяца = 0,15625 / 0,34375 / 0,34375 / 0,15625", () => {
    // очереди: с — самое раннее начало (15.01), по — самое позднее окончание (10.05) → январь…апрель
    expect(getFormula("F.CAPEX.SCHEDULE_WEIGHT").example?.output).toEqual([0.15625, 0.34375, 0.34375, 0.15625]);
    expect(num("SMR_ABOVE").slice(1, 5)).toEqual([0.15625, 0.34375, 0.34375, 0.15625]);
  });

  it("равномерно: 1/N по месяцам [с; по)", () => {
    expect(num("EXTERNAL_NETWORKS").slice(0, 6)).toEqual([0, 0.25, 0.25, 0.25, 0.25, 0]);
  });

  it("«фикс в месяц»: неполные месяцы — по дням, сумма = ставка × Σ долей дней", () => {
    // охрана: с 16.01 (самое раннее приобретение) по 16.03 (самый поздний РНВ): 16/31 января, весь февраль, 15/31 марта
    const days = new Decimal(16).div(31).add(1).add(new Decimal(15).div(31));
    expect(totals(r).SITE_SECURITY?.toNumber()).toBeCloseTo(days.mul(31).toNumber(), 9);
    expect(w.SITE_SECURITY?.[1]?.toNumber()).toBeCloseTo(new Decimal(16).div(31).div(days).toNumber(), 12);
  });

  it("в месяц вехи: вся сумма — в месяце самой ранней вехи", () => {
    expect(num("PREDESIGN").slice(0, 3)).toEqual([0, 1, 0]);
  });

  it("вслед за СМР: доли — как у платежей по СМР", () => {
    const smr = [0, 1, 2, 3, 4].map((t) => (w.SMR_ABOVE?.[t] as Decimal).mul(1000).add((w.EXTERNAL_NETWORKS?.[t] as Decimal).mul(400)));
    const total = sum(smr);
    expect(num("OTHER_SMR").slice(0, 5)).toEqual(smr.map((x) => x.div(total).toNumber()));
  });

  it("сумма весов каждой посчитанной статьи = 1 (SCHEDULE_SUM)", () => {
    for (const [id, ws] of Object.entries(w)) if (!totals(r)[id]?.isZero()) expect(sum(ws).sub(1).abs().lt(1e-9), id).toBe(true);
    expect(r.messages.filter((m) => m.text.includes("вместо 100%"))).toEqual([]);
  });

  it("график за горизонтом модели — ошибка SCHEDULE_SUM", () => {
    const short = calculate(project([{ item_id: "EXTERNAL_NETWORKS", rate: 400, price_date: "2025-12-31" }]), { horizonMonths: 3 }, ["F.CAPEX.SCHEDULE_WEIGHT"]);
    expect(short.messages).toContainEqual(expect.objectContaining({ severity: "error", text: expect.stringContaining("вместо 100%. Проверьте, что график не выходит за срок расчёта") }));
  });
});

describe("CAPEX: индекс, НДС, платёж", () => {
  it("индекс: дефлятор инвестиций 2026 — 6,5%, дальше — доля дней года", () => {
    const r = calculate(project([{ item_id: "SMR_ABOVE", base: "фикс", rate: 1, price_date: "2025-12-31" }]), { horizonMonths: 24 }, ["F.CAPEX.INDEX"]);
    const k = series(r, "F.CAPEX.INDEX").SMR_ABOVE as Decimal[];
    expect(k[0]?.toNumber()).toBe(1);
    expect(k[12]?.toNumber()).toBeCloseTo(1.065, 12); // 31.12.2026
    expect(k[18]?.toNumber()).toBeCloseTo(1.065 * 1.05 ** (181 / 365), 12); // 30.06.2027
  });

  it("статьи «доля от выручки / от СМР» не индексируются (решение 27.09.2026)", () => {
    for (const id of ["MARKETING", "BROKERAGE", "DEV_FEE", "TECH_CUSTOMER", "AUTHOR_SUPERVISION", "TECH_SUPERVISION", "CONTINGENCY"]) {
      expect(spec.capexItems.find((c) => c.item_id === id)?.index_type, id).toBe("none");
    }
  });

  it("платёж = сумма × вес × индекс × (1 + НДС × облагаемая доля)", () => {
    const r = calculate(
      project(
        [
          { item_id: "PREDESIGN", rate: 100, price_date: "2026-01-31" },
          { item_id: "DEVELOPER_OVERHEAD", rate: 31, price_date: "2025-12-31", schedule_to: "rnv_date" },
          { item_id: "MONITORING", rate: 100, price_date: "2026-01-31", vat_rate: 0.05 },
          { item_id: "CITY_CASH_COMPENSATION", schedule_manual: { from: "2026-03-31", step_months: 3, weights: [1] } },
        ],
        { "OPEX.OVERHEAD_VAT_SHARE": 0.5, "LAND.CITY_CASH_COMPENSATION": 1000, "LAND.CITY_OBJECTS_COST": 0 },
      ),
      { horizonMonths: 12 },
      ["F.CAPEX.ITEM_CASH"],
    );
    const cash = series(r, "F.CAPEX.ITEM_CASH");
    expect(cash.PREDESIGN?.[1]?.toNumber()).toBeCloseTo(122, 9); // НДС 22%, индекс 1 на дату расценки
    expect(sum(cash.DEVELOPER_OVERHEAD as Decimal[]).div(sum((series(r, "F.CAPEX.SCHEDULE_WEIGHT").DEVELOPER_OVERHEAD as Decimal[]).map((w, t) => w.mul(totals(r).DEVELOPER_OVERHEAD as Decimal).mul((series(r, "F.CAPEX.INDEX").DEVELOPER_OVERHEAD as Decimal[])[t] as Decimal)))).toNumber()).toBeCloseTo(1.11, 12);
    expect(sum(cash.MONITORING as Decimal[]).div(sum((series(r, "F.CAPEX.SCHEDULE_WEIGHT").MONITORING as Decimal[]).map((w, t) => w.mul(100).mul((series(r, "F.CAPEX.INDEX").MONITORING as Decimal[])[t] as Decimal)))).toNumber()).toBeCloseTo(1.05, 12);
    // денежная компенсация городу — платёж в бюджет, без НДС и индексации
    expect(sum(cash.CITY_CASH_COMPENSATION as Decimal[]).toNumber()).toBe(1000);
  });

  it("ставка НДС не из допустимых — ошибка по статье", () => {
    const r = calculate(project([{ item_id: "PREDESIGN", rate: 100, price_date: "2026-01-31", vat_rate: 0.1 }]), { horizonMonths: 12 }, ["F.CAPEX.ITEM_CASH"]);
    expect(r.messages).toContainEqual(expect.objectContaining({ severity: "error", text: expect.stringContaining("не из допустимых") }));
  });

  it("аренда у частного собственника — НДС 22%, у государства — без НДС", () => {
    const rent = { "LAND.TENURE": "аренда", "LAND.RENT_ANNUAL": 1200, "LAND.RENT_INDEXATION": 0, "LAND.RENT_PAYMENT_FREQ": "ежемесячно", "LAND.RENT_END_MILESTONE": "rnv_date" };
    const run = (lessor: string) =>
      sum(series(calculate(project([], { ...rent, "LAND.LESSOR_TYPE": lessor }), { horizonMonths: 12 }, ["F.CAPEX.ITEM_CASH"]), "F.CAPEX.ITEM_CASH").LAND_TAX_OR_RENT as Decimal[]).toNumber();
    // аренда с 16.01 по 01.03 (самый ранний РНВ): 16 дней января и весь февраль
    const rentSum = (100 * 16) / 31 + 100;
    expect(run("государственная/муниципальная")).toBeCloseTo(rentSum, 9);
    expect(run("частная")).toBeCloseTo(rentSum * 1.22, 9);
  });

  it("статья без ставки — ошибка «заполните ставку», остальные считаются", () => {
    const r = calculate(project([{ item_id: "PREDESIGN", rate: 100, price_date: "2026-01-31" }]), { horizonMonths: 12 }, ["F.CAPEX.ITEM_TOTAL"]);
    expect(r.messages).toContainEqual(expect.objectContaining({ severity: "error", text: expect.stringContaining("«Мониторинг окружающей застройки»: заполните ставку") }));
    expect(totals(r).PREDESIGN?.toNumber()).toBe(100);
  });

  it("статьи от выручки без плана продаж не считаются и не входят в итог", () => {
    const r = calculate(project([]), { horizonMonths: 12 }, ["F.CAPEX.TOTAL"]);
    expect(r.messages).toContainEqual(expect.objectContaining({ severity: "warning", text: expect.stringContaining("«Маркетинг» не посчитана: не посчитана формула F.SALES.REVENUE_TOTAL") }));
    expect(r.messages).toContainEqual(expect.objectContaining({ formulaId: "F.CAPEX.TOTAL", text: expect.stringContaining("Маркетинг") }));
  });
});

describe("CAPEX: Дербеневская в расчёте «как в исходном Excel»", () => {
  // горизонт — до последнего квартала CF1 (AS = 4 кв 2035: там кончаются ряды маркетинга и брокериджа)
  const r = calculate(legacyInput(loadCase("derbenevskaya_legacy")), { horizonMonths: 121 });
  const cash = series(r, "F.CAPEX.ITEM_CASH");
  const w = series(r, "F.CAPEX.SCHEDULE_WEIGHT");
  // Excel один в один: ряды CF1, у которых доли не равны 100%
  const cf1Share: Record<string, number> = { OTHER_SMR: 0, ROADS_UDS: 0, CONTINGENCY: 1.246, MARKETING: 4134560080.857632 / 4194809207.75, BROKERAGE: 2733176548.211842 / 4134560080.857636 };

  it("доли графика — как в CF1: 100%, а где в исходнике иначе — как есть, с предупреждением", () => {
    for (const [id, total] of Object.entries(totals(r))) {
      if (total.isZero()) continue;
      expect(sum(w[id] as Decimal[]).sub(cf1Share[id] ?? 1).abs().lt(1e-9), id).toBe(true);
    }
    const keys = r.messages.filter((m) => m.key?.startsWith("CAPEX.SCHEDULE_SUM:")).map((m) => m.key?.split(":")[1]);
    expect(keys.sort()).toEqual(Object.keys(cf1Share).sort());
    expect(r.messages.filter((m) => m.severity === "error" && m.formulaId.startsWith("F.CAPEX"))).toEqual([]);
  });

  it("УДС и «Прочие СМР» в денежный поток не попадают, как в CF1 (в бюджете — есть)", () => {
    expect(sum(cash.ROADS_UDS as Decimal[]).isZero()).toBe(true);
    expect(sum(cash.OTHER_SMR as Decimal[]).isZero()).toBe(true);
    expect(totals(r).ROADS_UDS?.toNumber()).toBe(535620851);
    expect(r.messages).toContainEqual(expect.objectContaining({ severity: "warning", key: "CAPEX.SCHEDULE_SUM:ROADS_UDS", text: expect.stringContaining("0% суммы бюджета") }));
  });

  it("без индексации: суммы исходника в ценах исходника, эффект индексации = 0", () => {
    for (const k of Object.values(series(r, "F.CAPEX.INDEX"))) expect(k.every((x) => x.eq(1))).toBe(true);
    expect((r.formulas["F.CAPEX.INDEX_EFFECT"]?.value as Decimal).toNumber()).toBe(0);
    const normal = calculate({ ...legacyInput(loadCase("derbenevskaya_legacy")), mode: "normal" }, { horizonMonths: 88 }, ["F.CAPEX.INDEX_EFFECT"]);
    expect((normal.formulas["F.CAPEX.INDEX_EFFECT"]?.value as Decimal).gt(0)).toBe(true);
  });

  it("земельные платежи — из исходника: аренда/налог ЗУ Бюджет!F21 по CF1 строке 24, ВРИ Бюджет!F22 в квартал CF1!K26", () => {
    const land = cash.LAND_TAX_OR_RENT as Decimal[];
    expect(sum(land).toNumber()).toBeCloseTo(825124525.273, 3);
    // 29 кварталов F:AH (1 кв 2026 — 1 кв 2033), в месяцах поровну
    expect(land[1]?.toNumber()).toBeCloseTo(825124525.273 / 29 / 3, 3);
    expect(land[87]?.toNumber()).toBeCloseTo(825124525.273 / 29 / 3, 3);
    const vri = cash.LAND_VRI as Decimal[];
    expect(sum(vri).toNumber()).toBe(5000 * 221967);
    // K — 6-й квартал с 1 кв 2026 = 2 кв 2027: апрель…июнь 2027
    expect(vri.findIndex((x) => x.gt(0))).toBe(16);
  });

  it("«Компенсация городу» Бюджет!F24 — целиком денежная компенсация, без НДС и индексации, по ручному ряду CF1!M29:N29", () => {
    expect(totals(r).CITY_CASH_COMPENSATION?.toNumber()).toBe(1260033986.66);
    expect(totals(r).CITY_OBJECTS_CONSTRUCTION?.toNumber()).toBe(0);
    const c = cash.CITY_CASH_COMPENSATION as Decimal[];
    expect(sum(c).toNumber()).toBe(1260033986.66);
    // M и N — 8-й и 9-й кварталы с 1 кв 2026 (4 кв 2027 и 1 кв 2028), по 50% → поровну на три месяца
    expect(c.findIndex((x) => x.gt(0))).toBe(22);
    expect(c[22]?.toNumber()).toBeCloseTo(1260033986.66 / 6, 4);
  });

  it("резерв — как в исходнике E42 + D42 = 202 839,89 руб., в CF — 124,6% по ряду СМР", () => {
    expect(totals(r).CONTINGENCY?.toNumber()).toBeCloseTo(202839.892889, 6);
    expect(sum(cash.CONTINGENCY as Decimal[]).toNumber()).toBeCloseTo(202839.892889 * 1.246, 4);
  });
});
