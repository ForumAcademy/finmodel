import Decimal from "decimal.js";
import { describe, expect, it } from "vitest";
import { getFormula, type FormulaId, type ParameterId } from "@fm/spec";
import { ANALYSIS_FORMULAS, Engine, SPEC_ASSUMPTIONS, type CalcProject } from "../src";
import { analyzeSite, chooseBest, computeVariant, salesMonths, variantProject } from "../src/analysis";
import { compareTable, commonNotCounted, criterionMissing, marketRows, ncsLine, rateRows, rateText, riskFreeMissing, normRows, potentialRows, snapshotText, snapshotOf } from "../src/explain/site-view";
import { analogFromForm, analogToForm, customVariant, emptySite, parseSite, siteCalcProject, siteText, variantTitle, applySiteChange, siteChange } from "../src/site";
import * as plot from "../src/plot";
import { createProject, type LandProject } from "../src/plot";
import { ncsRange, type BestChoice, type NcsRow, type Variant, type VariantResult } from "../src/modules/variant";
import type { MaxGfa } from "../src/modules/site";
import type { MarketPrice } from "../src/modules/market";
import { curveAt } from "../src/modules/kpi";
import { parseZcyc, zcycTryDates } from "../src/zcyc";

type Values = Partial<Record<ParameterId, unknown>>;

function run<T>(id: FormulaId, values: Values): T {
  const r = new Engine({ values }, ANALYSIS_FORMULAS).run([id]);
  const node = r.formulas[id];
  if (!node) throw new Error(r.messages.map((m) => m.text).join("; "));
  return node.value as T;
}

const example = (id: FormulaId) => getFormula(id).example as { input: Record<string, unknown>; output: unknown };
const analog = (name: string, cls: string, price: number, pace: number, product = "квартиры") => ({ name, product, housing_class: cls, price, pace, url: "https://наш.дом.рф/" });

describe("безрисковая ставка по кривой доходности ОФЗ", () => {
  it("пример формулы: 7 лет между точками 5 и 10 лет — по прямой", () => {
    const { input, output } = example("F.KPI.RISK_FREE");
    const curve = (input.curve as [number, number][]).map(([t, y]) => ({ term: new Decimal(t), yield: new Decimal(y) }));
    expect(curveAt(curve, new Decimal(input.term as number))?.toDecimalPlaces(4).toNumber()).toBe(output);
    expect(curveAt(curve, new Decimal(0.5))?.toNumber()).toBe(0.1305);
    expect(curveAt(curve, new Decimal(30))?.toNumber()).toBe(0.1609);
    expect(curveAt([], new Decimal(7))).toBeNull();
  });

  it("ответ биржи: сроки и доходности в % → доли; дата — торговый день из ответа", () => {
    const json = {
      yearyields: {
        columns: ["tradedate", "tradetime", "period", "value"],
        data: [
          ["2026-09-18", "18:59:59", 5, 15.49],
          ["2026-09-18", "18:59:59", 1, 13.05],
          ["2026-09-18", "18:59:59", 10, 16.09],
        ],
      },
    };
    const c = parseZcyc(json, "2026-09-20", "2026-09-29T08:00:00Z");
    expect(c?.date).toBe("2026-09-18");
    expect(c?.points).toEqual([
      { term: 1, yield: 0.1305 },
      { term: 5, yield: 0.1549 },
      { term: 10, yield: 0.1609 },
    ]);
    expect(parseZcyc({ yearyields: { columns: ["period", "value"], data: [] } }, "2026-09-20", "")).toBeNull();
    expect(parseZcyc("<html>", "2026-09-20", "")).toBeNull();
    // Дата оценки в будущем — кривая на сегодня и раньше
    expect(zcycTryDates("2026-12-31", "2026-09-29").slice(0, 2)).toEqual(["2026-09-29", "2026-09-28"]);
  });
});

describe("анализ участка: примеры формул (formulas.yaml → example)", () => {
  it("F.SITE.BUILDABLE_AREA: площадь минус зоны, где строить нельзя", () => {
    const { input, output } = example("F.SITE.BUILDABLE_AREA");
    const v = run<Decimal>("F.SITE.BUILDABLE_AREA", { "LAND.AREA": input.area, "SITE.ZOUIT": input.zouit });
    expect(v.toNumber()).toBe(output);
  });

  it("F.SITE.MAX_GFA: самое жёсткое из ограничений", () => {
    const { input, output } = example("F.SITE.MAX_GFA");
    const v = run<MaxGfa>("F.SITE.MAX_GFA", { "LAND.AREA": input.area, "SITE.MAX_DENSITY": input.density, "GPZU.MAX_FLOORS": input.floors });
    expect(v.value.toNumber()).toBe(output);
    expect(v.limit).toBe("density");
    // Процент застройки × этажность жёстче плотности
    const w = run<MaxGfa>("F.SITE.MAX_GFA", { "LAND.AREA": 32000, "SITE.MAX_DENSITY": 2.5, "GPZU.MAX_FLOORS": 9, "GPZU.MAX_BUILT_SHARE": 0.25 });
    expect(w.limit).toBe("share");
    expect(w.value.toNumber()).toBe(32000 * 0.25 * 9);
    expect(Object.keys(w.limits).sort()).toEqual(["density", "share"]);
  });

  it("F.SITE.FOOTPRINT: пятно под предельную этажность", () => {
    const { output } = example("F.SITE.FOOTPRINT");
    const v = run<Decimal>("F.SITE.FOOTPRINT", { "LAND.AREA": 30200, "SITE.MAX_DENSITY": new Decimal(80000).div(30200).toNumber(), "GPZU.MAX_FLOORS": 24 });
    expect(v.toDecimalPlaces(2).toNumber()).toBe(output);
  });

  it("F.MARKET.PRICE / PACE / CAPACITY: цена с весом по темпу, медиана темпа, сумма темпов", () => {
    const { input, output } = example("F.MARKET.PRICE");
    const prices = input.prices as number[];
    const paces = input.paces as number[];
    const values = { "MARKET.ANALOGS": prices.map((p, i) => analog(`ЖК ${i}`, "комфорт", p, paces[i] as number)) };
    const price = run<Record<string, MarketPrice | null>>("F.MARKET.PRICE", values)["квартиры|комфорт"] as MarketPrice;
    expect(price.price.toDecimalPlaces(2).toNumber()).toBe(output);
    expect([price.min.toNumber(), price.max.toNumber(), price.n]).toEqual([348000, 372000, 3]);
    expect(run<Record<string, Decimal>>("F.MARKET.PACE", values)["квартиры|комфорт"]?.toNumber()).toBe(example("F.MARKET.PACE").output);
    expect(run<Record<string, Decimal>>("F.MARKET.CAPACITY", values)["квартиры|комфорт"]?.toNumber()).toBe(example("F.MARKET.CAPACITY").output);
  });

  it("F.MARKET.PRICE: меньше трёх аналогов — цены нет", () => {
    const v = run<Record<string, MarketPrice | null>>("F.MARKET.PRICE", { "MARKET.ANALOGS": [analog("А", "бизнес", 500000, 100), analog("Б", "бизнес", 520000, 100)] });
    expect(v["квартиры|бизнес"]).toBeNull();
  });

  it("F.VAR.FLOORS: предельная этажность и верхние границы групп ниже", () => {
    const { input, output } = example("F.VAR.FLOORS");
    const v = run<Decimal[]>("F.VAR.FLOORS", { "GPZU.MAX_FLOORS": input.max_floors, "VAR.LOWER_LEVELS": input.lower_levels });
    expect(v.map((x) => x.toNumber())).toEqual(output);
  });

  it("F.VAR.PHASES: очередей столько, чтобы каждая продавалась до ввода", () => {
    const { input, output } = example("F.VAR.PHASES");
    const values: Values = {
      "GEN.HOUSING_CLASS": "комфорт",
      "TIME.CONSTRUCTION_M": input.construction_m,
      "TIME.SALES_AFTER_RNS_M": input.sales_after_rns_m,
      "MARKET.ANALOGS": [analog("А", "комфорт", 300000, input.pace as number), analog("Б", "комфорт", 300000, input.pace as number), analog("В", "комфорт", 300000, input.pace as number)],
    };
    const e = new Engine({ values }, { ...ANALYSIS_FORMULAS, "F.TEP.APT_AREA": () => new Decimal(input.apt_area as number) });
    expect((e.run(["F.VAR.PHASES"]).formulas["F.VAR.PHASES"]?.value as Decimal).toNumber()).toBe(output);
  });

  it("F.VAR.MILESTONES: следующая очередь стартует продажи, когда предыдущая введена", () => {
    const values: Values = { "GEN.MODEL_START_DATE": "2026-09-30", "TIME.PRE_RNS_M": 6, "TIME.CONSTRUCTION_M": 36, "TIME.SALES_AFTER_RNS_M": 3 };
    const e = new Engine({ values }, { ...ANALYSIS_FORMULAS, "F.VAR.PHASES": () => new Decimal(2) });
    const rows = e.run(["F.VAR.MILESTONES"]).formulas["F.VAR.MILESTONES"]?.value as Record<string, string>[];
    expect(rows[0]).toMatchObject({ land_acquired: "2026-09-30", rns_date: "2027-03-31", sales_start: "2027-06-30", rnv_date: "2030-03-31" });
    // Окно продаж очереди — 33 мес: РНС второй очереди через 33 мес после первой, её старт продаж совпадает с вводом первой
    expect(rows[1]).toMatchObject({ rns_date: "2029-12-31", sales_start: "2030-03-31" });
    expect(rows[1]?.sales_start).toBe(rows[0]?.rnv_date);
  });

  it("F.VAR.BEST: максимум NPV среди прошедших условия и сопоставимых", () => {
    const rows: VariantResult[] = [
      { variant: "a", computed: true, npv: 100, net_profit: 500, irr: 0.25, peak_debt: 10, sales_months: 30, not_counted: ["Мониторинг"] },
      { variant: "b", computed: true, npv: 300, net_profit: 400, irr: 0.15, peak_debt: 10, sales_months: 30, not_counted: ["Мониторинг"] },
      { variant: "c", computed: true, npv: 900, net_profit: 900, irr: 0.4, peak_debt: 10, sales_months: 30, not_counted: ["Мониторинг", "СМР надземной части"] },
      { variant: "d", computed: false },
    ];
    const pick = (extra: Values) => run<BestChoice>("F.VAR.BEST", { "VAR.RESULTS": rows, ...extra });
    const noHurdle = pick({});
    expect(noHurdle.best).toBe("b");
    expect(noHurdle.reasons.c?.[0]).toContain("СМР надземной части");
    expect(noHurdle.reasons.d).toEqual(["не посчитан полностью"]);
    expect(pick({ "VAL.HURDLE_IRR": 0.2 }).best).toBe("a");
    expect(pick({ "VAL.SELECT_CRITERION": "прибыль" }).best).toBe("a");
    const withoutNpv = run<BestChoice>("F.VAR.BEST", { "VAR.RESULTS": rows.map((r) => ({ ...r, npv: null })) });
    expect(withoutNpv.best).toBeNull();
    expect(withoutNpv.blocked).toContain("NPV");
  });
});

// ---------- проект целиком ----------

const MSK: CalcProject = {
  assumptionsVersion: 2,
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
      "SITE.ZOUIT": [{ name: "Газопровод", area_m2: 1800, no_build: true }],
      "GEN.MODEL_START_DATE": "2026-09-30",
      "GEN.VALUATION_DATE": "2026-09-30",
      "MARKET.ANALOGS": [
        analog("ЖК 1", "бизнес", 450000, 1500),
        analog("ЖК 2", "бизнес", 470000, 1200),
        analog("ЖК 3", "бизнес", 430000, 1800),
        analog("ЖК 4", "комфорт", 330000, 2500),
        analog("ЖК 5", "комфорт", 310000, 2000),
        analog("ЖК 6", "комфорт", 350000, 2200),
      ],
    },
  },
};

describe("анализ участка: варианты освоения", () => {
  const sa = analyzeSite(MSK);

  it("градпотенциал и список вариантов: 2 класса × 3 уровня этажности", () => {
    expect(sa.result.messages.filter((m) => m.severity === "error")).toEqual([]);
    expect(sa.buildable?.toNumber()).toBe(30200);
    expect(sa.maxGfa?.limit).toBe("gfa");
    expect(sa.floors).toEqual([24, 17, 9]);
    expect(sa.classes).toEqual(["комфорт", "бизнес"]);
    expect(sa.variants.length).toBeGreaterThanOrEqual(4);
    expect(sa.variants.length).toBeLessThanOrEqual(6);
  });

  it("вариант строит вводные проекта: пятно под этажность, вехи, план продаж, бюджет", () => {
    const v = sa.variants.find((x) => x.floors === 9 && x.housing_class === "бизнес") as Variant;
    const vp = variantProject(MSK, v);
    expect(vp.project).not.toBeNull();
    // 9 этажей: пятно ограничено процентом застройки (30 200 × 40 %), а не предельной площадью
    expect(vp.footprint?.toNumber()).toBe(12080);
    const values = vp.project?.input.values ?? {};
    expect(values["GPZU.MAX_GFA_ABOVE"]).toBeNull();
    expect(values["GEN.HOUSING_CLASS"]).toBe("бизнес");
    expect((values["SALES.PRODUCTS"] as { product: string }[]).every((r) => r.product === "квартиры")).toBe(true);
    expect(vp.sales?.missing).toEqual(["ПСН", "Машино-места"]);
    const capex = values["CAPEX.ITEMS"] as { item_id: string; base: string; schedule_rule?: string }[];
    expect(capex.find((r) => r.item_id === "SMR_ABOVE")?.base).toBe("F.TEP.GFA_ABOVE");
    // Подготовка площадки: от РНС до начала СМР, а на вехах варианта это одна дата — платёж в РНС
    expect(capex.find((r) => r.item_id === "SITE_PREP")?.schedule_rule).toBe("at_milestone");
    // Ставка СМР задана только для бизнес-класса
    const comfort = variantProject(MSK, { ...v, housing_class: "комфорт", id: "комфорт-9" });
    expect((comfort.project?.input.values["CAPEX.ITEMS"] as { item_id: string }[]).some((r) => r.item_id === "SMR_ABOVE")).toBe(false);
  });

  it("вариант считается полным расчётом; без ставок дисконтирования лучший не выбирается", () => {
    const list = sa.variants.filter((v) => v.floors === 24);
    const summaries = list.map((v) => computeVariant(MSK, v));
    for (const s of summaries) {
      expect(s.computed).toBe(true);
      expect(s.revenue?.gt(0)).toBe(true);
      expect(s.npv).toBeNull();
      expect(s.salesMonths).toBeGreaterThan(0);
    }
    const common = commonNotCounted(summaries);
    expect(common).toContain("ПСН");
    expect(common).not.toContain("СМР надземной части (в т.ч. стилобат)");
    const { choice } = chooseBest(MSK, summaries);
    expect(choice?.best).toBeNull();
    expect(criterionMissing(summaries)).toEqual(["Премия за риск девелоперского проекта"]);
    expect(riskFreeMissing(summaries)).toBe(true);
    const table = compareTable(summaries, choice);
    expect(table.why).toContain("Загрузите кривую доходности ОФЗ");
    expect(table.why).toContain("«Премия за риск девелоперского проекта»");
    expect(table.needsReference).toBe(true);
    expect(table.needsRiskFree).toBe(true);
    // Комфорт без ставки СМР не сопоставим с бизнесом
    expect(table.reasons.map((r) => r.title)).toEqual(["Комфорт, 24 этажа"]);

    const withRates: CalcProject = { ...MSK, input: { ...MSK.input, values: { ...MSK.input.values, "VAL.RISK_FREE": 0.14, "VAL.EQUITY_PREMIUM": 0.06 } } };
    const rated = list.map((v) => computeVariant(withRates, v));
    const best = chooseBest(withRates, rated).choice;
    expect(best?.best).toBe("бизнес-24");
    expect(compareTable(rated, best).why).toContain("«Бизнес, 24 этажа»");
    expect(snapshotText(snapshotOf(rated, best, "2026-09-29T10:00:00Z"))).toMatch(/^Лучший вариант: Бизнес, 24 этажа · NPV акционера -?[\d\s ]+(,\d)? млн руб · прибыль -?[\d\s ]+(,\d)? млн руб$/);
    const t = compareTable(rated, best);
    expect(t.why).toMatch(/^Лучший — «Бизнес, 24 этажа»: NPV акционера -?[\d\s ]+(,\d)? млн руб/);
    expect(t.why).toContain("руководитель ещё не утвердил");
    expect(compareTable(rated, best, true).why).not.toContain("не утвердил");
    // Прошедшие отбор, но уступившие лучшему — с разницей в млн руб
    for (const r of t.reasons.filter((x) => x.title !== "Комфорт, 24 этажа")) expect(r.text).toMatch(/меньше, чем у лучшего$/);
  });

  it("справочник версии 3 и кривая ОФЗ: безрисковая ставка в точке срока варианта, премия 9 п.п., лучший выбран", () => {
    const curve = (example("F.KPI.RISK_FREE").input.curve as [number, number][]).map(([term, y]) => ({ term, yield: y }));
    const v3: CalcProject = { assumptionsVersion: 3, input: { ...MSK.input, values: { ...MSK.input.values, "VAL.ZCYC": curve, "VAL.ZCYC_DATE": "2026-09-18" } } };
    const list = sa.variants.filter((v) => v.floors === 24);
    const rated = list.map((v) => computeVariant(v3, v));
    for (const s of rated) {
      expect(s.riskFree?.from_curve).toBe(true);
      const rf = s.riskFree?.rf.toNumber() ?? 0;
      expect(rf).toBeGreaterThan(0.1305);
      expect(rf).toBeLessThan(0.1609);
      expect(s.discountRate?.sub(s.riskFree?.rf ?? 0).toNumber()).toBeCloseTo(0.09, 10);
      expect(s.npv).not.toBeNull();
      expect(rateText(s)).toMatch(/^[\d,]+ %$/);
    }
    expect(chooseBest(v3, rated).choice?.best).toBe("бизнес-24");
    const p = { ...landProject(), assumptionsVersion: 3, site: { ...emptySite(), curve: { date: "2026-09-18", points: curve, loadedAt: "" } } };
    expect(rateRows(p, SPEC_ASSUMPTIONS, rated)[1]?.value).toMatch(/^[\d,]+ %( – [\d,]+ %)? на срок [\d,]+( – [\d,]+)? года$/);
  });

  it("блок ставки: без кривой — ручной ввод безрисковой ставки, премия из справочника", () => {
    const p = { ...landProject(), assumptionsVersion: 3 };
    const rows = rateRows(p, SPEC_ASSUMPTIONS, []);
    expect(rows.map((r) => r.label)).toEqual(["Кривая доходности ОФЗ", "Безрисковая ставка", "Премия за риск девелоперского проекта"]);
    expect(rows[0]?.value).toBe("не загружена");
    expect(rows[1]?.edit).toBe("riskFree");
    expect(rows[2]?.origin).toBe("reference");
    expect(rows[2]?.value).toBe("9 п.п.");
    const withCurve = { ...p, site: { ...emptySite(), curve: { date: "2026-09-18", points: [{ term: 1, yield: 0.1305 }, { term: 10, yield: 0.1609 }], loadedAt: "2026-09-29T08:00:00Z" } } };
    const r2 = rateRows(withCurve, SPEC_ASSUMPTIONS, []);
    expect(r2[0]?.value).toBe("на 18.09.2026, сроки от 1 до 10 лет");
    expect(r2[1]?.origin).toBe("source");
    expect(siteCalcProject(withCurve, "2026-09-29").input.values["VAL.ZCYC_DATE"]).toBe("2026-09-18");
  });

  it("срок продаж — от первого до последнего месяца с продажами", () => {
    const z = new Decimal(0);
    const o = new Decimal(1);
    expect(salesMonths({ a: [z, o, z, o, z], b: [z, z, z, z, o] })).toBe(4);
    expect(salesMonths({ a: [z, z] })).toBeNull();
  });
});

// ---------- проект: ограничения, аналоги, свои варианты ----------

function landProject(): LandProject {
  const r = createProject({ cadastralNumber: "77:05:0004012:1873", name: "Тест", area: "32 000", address: "", point: null, regionCode: "", egrn: null, documents: [] }, "p1", "2026-09-29T08:00:00Z", 2);
  return r.project as LandProject;
}

describe("участок проекта: ограничения и аналоги", () => {
  it("ввод ограничений: проценты — в %, плотность — в тыс. м²/га, этажность — целое", () => {
    expect(parseSite("builtShare", "40")).toEqual({ value: "0.4" });
    expect(parseSite("density", "25")).toEqual({ value: "2.5" });
    expect(siteText("density", "2.5")).toBe("25");
    expect(parseSite("maxFloors", "24,5").error).toBe("Этажность — целое число.");
    expect(parseSite("startDate", "30.09.2026")).toEqual({ value: "2026-09-30" });
    expect(parseSite("apartAllowed", "да")).toEqual({ value: "да" });
  });

  it("изменение ограничения пишется в историю и попадает в расчёт", () => {
    const p0 = landProject();
    const c = siteChange(p0, "maxFloors", "24", { title: "ГПЗУ участка", date: "2026-09-29" });
    expect(c?.to.origin).toBe("expert");
    const p1 = applySiteChange(p0, c as NonNullable<typeof c>, "2026-09-29T09:00:00Z");
    expect(p1.history.at(-1)).toMatchObject({ field: "maxFloors", from: "не учтено", to: "24 эт." });
    const calc = siteCalcProject(p1, "2026-09-29");
    expect(calc.input.values["GPZU.MAX_FLOORS"]).toBe(24);
    expect(calc.input.values["LAND.AREA"]).toBe(32000);
    // Дата сделки не задана — конец текущего месяца
    expect(calc.input.values["GEN.MODEL_START_DATE"]).toBe("2026-09-30");
  });

  it("аналог: ссылка и дата обязательны, числа по-русски", () => {
    const bad = analogFromForm({ ...analogToForm(null), name: "ЖК", housingClass: "комфорт", price: "330 000", pace: "2 000", url: "", date: "" }, "a1");
    expect(bad.analog).toBeNull();
    expect(bad.errors.join(" ")).toContain("ссылку");
    const ok = analogFromForm({ ...analogToForm(null), name: "ЖК", housingClass: "комфорт", price: "330 000", pace: "2 000,5", url: "https://наш.дом.рф/1", date: "20.09.2026", soldShare: "35" }, "a1");
    expect(ok.analog).toMatchObject({ price: "330000", pace: "2000.5", soldShare: "0.35", date: "2026-09-20" });
    expect(analogToForm(ok.analog).price.replace(/\s/g, " ")).toBe("330 000");
  });

  it("свой вариант: не выше предельной этажности и без повторов", () => {
    const p = { ...landProject(), site: { ...emptySite(), values: { maxFloors: { value: "24", origin: "expert" as const, basis: { title: "ГПЗУ" } } } } };
    expect(customVariant(p, "комфорт", "30", []).error).toContain("выше предельной этажности 24");
    const v = customVariant(p, "комфорт", "12", []).variant as Variant;
    expect(variantTitle(v)).toBe("Комфорт, 12 этажей");
    expect(customVariant({ ...p, site: { ...p.site, customVariants: [v] } }, "комфорт", "12", []).error).toContain("уже есть");
  });

  it("экраны: нормативы региона, градпотенциал, рынок", () => {
    const p = landProject();
    const norms = normRows(p, [] as never);
    expect(norms.region[0]).toMatchObject({ label: "Норматив машино-мест на квартиру", origin: "source", tone: "grn" });
    const withSite = {
      ...p,
      site: {
        ...emptySite(),
        analogs: ["А", "Б"].map((n, i) => ({ id: n, name: n, product: "квартиры", housingClass: "комфорт", distanceKm: null, stage: null, price: String(300000 + i), pace: "1000", soldShare: null, url: "https://x.ru", date: "2026-09-20" })),
      },
    };
    const sa = analyzeSite(siteCalcProject(withSite, "2026-09-29"));
    expect(marketRows(withSite, sa)).toMatchObject([{ product: "квартиры", housingClass: "комфорт", analogs: 2, enough: false }]);
    expect(potentialRows(withSite, sa)[0]?.value.replace(/\s/g, " ")).toBe("32 000 м²");
  });
});

describe("ставка СМР комфорта: доля от бизнеса и контроль по НЦС", () => {
  it("пример формулы: норматив той же этажности × Кпер × квартиры / наземная площадь × (1 + НДС)", () => {
    const { input, output } = example("F.VAR.NCS_CHECK");
    const rows: NcsRow[] = (input.ncs as [number | null, number | null, number][]).map(([a, b, rate]) => ({ code: "", floors_min: a, floors_max: b, design: "", apt_area: null, rate }));
    const k = new Decimal(input.k_per as number).mul(input.apt_area as number).div(input.gfa_above as number).mul(1 + (input.vat as number));
    const range = ncsRange(rows, input.floors as number, k);
    const out = output as { min: number; max: number; below: boolean };
    expect(range?.min.toDecimalPlaces(1).toNumber()).toBe(out.min);
    expect(range?.max.toDecimalPlaces(1).toNumber()).toBe(out.max);
    expect(range !== null && new Decimal(input.rate as number).lt(range.min)).toBe(out.below);
    // Этажность вне групп — норматива нет
    expect(ncsRange(rows, 12, k)).toBeNull();
  });

  it("справочник версии 4: доля задана — у комфорта есть ставка СМР и строка контроля по НЦС", () => {
    const sa = analyzeSite(MSK);
    const v = sa.variants.find((x) => x.floors === 24 && x.housing_class === "комфорт") as Variant;
    const ratio = (r: number | null) => [{ item: "СМР надземной части (в т.ч. стилобат)", housing_class: "комфорт", base_class: "бизнес", ratio: r }];
    const v4 = (r: number | null): CalcProject => ({ assumptionsVersion: 4, input: { ...MSK.input, values: { ...MSK.input.values, "CAPEX.CLASS_RATIO": ratio(r) } } });
    const smr = (p: CalcProject, cls: Variant) =>
      (variantProject(p, cls).project?.input.values["CAPEX.ITEMS"] as { item_id: string; rate: number }[] | undefined)?.find((x) => x.item_id === "SMR_ABOVE")?.rate ?? null;
    const business = smr(v4(null), { ...v, housing_class: "бизнес", id: "бизнес-24" });
    expect(business).not.toBeNull();
    expect(smr(v4(null), v)).toBeNull();
    expect(smr(v4(0.6), v)).toBeCloseTo((business as number) * 0.6, 6);

    const low = computeVariant(v4(0.2), v);
    expect(low.ncs?.below).toBe(true);
    expect(ncsLine(low)?.tone).toBe("red");
    expect(ncsLine(low)?.text).toMatch(/^Ставка СМР надземной части [\d\s ]+,\d тыс\. руб\/м², норматив цены строительства той же этажности [\d\s ]+,\d(–[\d\s ]+,\d)? тыс\. руб\/м² \(с НДС\): ставка ниже норматива/);
    const ok = computeVariant(v4(0.6), v);
    expect(ok.ncs?.below).toBe(false);
    expect(ncsLine(ok)?.tone).toBe("grn");
    // Нет ставки — нет строки контроля, и расчёт варианта из-за контроля не останавливается
    const none = computeVariant(v4(null), v);
    expect(ncsLine(none)).toBeNull();
    expect(none.errors.some((e) => e.text.includes("НЦС"))).toBe(false);
  });
});

describe("основание Экспертного значения: автор и диапазон", () => {
  const num = { value: "24", parse: (t: string) => ({ value: t.trim() }), show: (x: string) => `${x} эт.` };
  const form = { title: "Письмо архитектора", url: "", author: "Иванова", min: "20", max: "25" };
  it("нужны основание, автор и диапазон, в который попадает значение", () => {
    expect(plot.expertBasis({ ...form, author: "" }, "2026-09-29", num)).toEqual({ error: expect.stringContaining("кто задал") });
    expect(plot.expertBasis({ ...form, min: "" }, "2026-09-29", num)).toEqual({ error: expect.stringContaining("диапазон") });
    expect(plot.expertBasis({ ...form, min: "25", max: "20" }, "2026-09-29", num)).toEqual({ error: expect.stringContaining("больше") });
    expect(plot.expertBasis({ ...form, max: "22" }, "2026-09-29", num)).toEqual({ error: "Значение 24 эт. вне диапазона 20 эт.–22 эт.: проверьте значение или диапазон." });
    const ok = plot.expertBasis(form, "2026-09-29", num);
    expect(ok).toEqual({ basis: { title: "Письмо архитектора", url: null, date: "2026-09-29", author: "Иванова", min: "20", max: "25" } });
    // Текстовое значение — без диапазона
    expect(plot.expertBasis({ ...form, min: "", max: "" }, "2026-09-29")).toHaveProperty("basis");
    if ("basis" in ok) {
      expect(plot.basisText(ok.basis)).toBe("Письмо архитектора, 29.09.2026, задал(а) Иванова");
      expect(plot.basisNote(ok.basis, num.show)).toBe("Диапазон 20 эт.–25 эт.");
      expect(plot.expertForm(ok.basis)).toEqual(form);
    }
  });
});
