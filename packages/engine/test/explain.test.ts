import { describe, expect, it } from "vitest";
import { getFormula, spec, type FormulaId } from "@fm/spec";
import { compatDiff, computeProject, exampleFocus, howExample, inputFields, legacyProject, modePair, paceLine, parkingWarning, salesRows, salesTotal, salesWarnings, shortSource, templateExample } from "../src";
import { loadCase } from "./support/cases";

/** Пояснение — не больше четырёх предложений (три и одно про деньги, где оно нужно). */
const MAX_SENTENCES = 4;
const demo = legacyProject(loadCase("derbenevskaya_legacy"), "Дербеневская (демо)");

describe("Пояснение «Как посчитано»: пример на цифрах проекта", () => {
  const m = computeProject(demo);
  // посчитанные показатели: формулы с null («как в исходном Excel» показателя нет) не показываются
  const computed = (Object.keys(m.result.formulas) as FormulaId[]).filter((id) => m.result.formulas[id]?.value !== null);

  it("у каждой формулы есть название и короткое пояснение простым языком", () => {
    for (const f of spec.formulas) {
      expect(f.plain?.title, f.id).toBeTruthy();
      const how = f.plain?.how ?? "";
      expect(how, f.id).not.toMatch(/[A-Za-z]/);
      expect(how, f.id).not.toMatch(/\n/);
      expect(how.split(/[.!?](\s|$)/).filter((s) => s.trim()).length, f.id).toBeLessThanOrEqual(MAX_SENTENCES);
    }
  });

  it("у каждого посчитанного показателя пример одной строкой, все подстановки заполнены", () => {
    for (const id of computed) {
      const ex = howExample(id, demo, m);
      if (getFormula(id).plain?.example) expect(templateExample(id, demo, m), id).not.toBeNull();
      if (ex !== null) expect(ex, id).not.toMatch(/\n/);
    }
  });

  it("«Продано в месяце»: пример из расчёта сервиса — ПСН распродан к марту 2033", () => {
    const pair = modePair(demo)!;
    expect(howExample("F.SALES.SOLD_AREA", pair.normalProject, pair.normal)).toBe("ПСН 10 322 м². Продажи начинаются в апреле 2029 года, вся площадь продана к марту 2033 года.");
    expect(pair.normal.result.messages.map((x) => x.text)).toContain("По плану продаж ПСН получается 10 888 м², а построено 10 322 м². Лишние 566 м² в расчёт не попали. Уменьшите темп или проверьте площадь ПСН в ТЭПах.");
  });

  it("«Продаваемая площадь»: нулевые слагаемые не пишутся, площади без дробей", () => {
    expect(howExample("F.TEP.SALEABLE_AREA", demo, m)).toMatch(/^Квартиры 143\s560 м² \+ ПСН 10\s322 м² = 153\s882 м²\.$/);
  });

  it("«В исходном Excel»: одна строка с цифрами, только если отличается от расчёта сервиса", () => {
    const pair = modePair(demo)!;
    expect(compatDiff("F.SALES.SOLD_AREA", pair.legacy, pair.normal, exampleFocus(pair.normalProject, pair.normal))).toMatch(/^В исходном Excel ПСН продано 10\s888 м² — больше, чем построено\.$/);
    expect(compatDiff("F.TEP.SALEABLE_AREA", pair.legacy, pair.normal)).toBeNull();
  });

  it("«Что влияет» — не больше пяти полей, которые вводит пользователь", () => {
    const fields = inputFields("F.TEP.SALEABLE_AREA", m);
    expect(fields.length).toBeLessThanOrEqual(5);
    expect(fields).toContain("TEP.COMM_AREA");
    expect(inputFields("F.SALES.SOLD_AREA", m)).not.toContain("GEN.MODEL_START_DATE");
  });

  it("короткое название источника", () => {
    expect(shortSource("Приказ Росреестра от 23.10.2020 № П/0393 (ред. от 01.01.2024) — требования к площади")).toBe("Приказ Росреестра П/0393");
  });
});

describe("Сводка продаж «Продано в месяце»: таблица по продуктам и предупреждения в рублях", () => {
  const pair = modePair(demo)!;

  it("таблица из расчёта сервиса: ПСН построено 10 322 м², продано всё, распродано к марту 2033", () => {
    const psn = salesRows(pair.normalProject, pair.normal)!.find((r) => r.key === "ПСН")!;
    expect(psn.sold.toNumber()).toBeCloseTo(10322, 6);
    expect(psn.soldOut).toBe("2033-03-31");
    expect(paceLine(psn)).toMatch(/^ПСН: в среднем \d+ м² в месяц, срок продаж 48 мес\.$/);
  });

  it("план до старта продаж переносится на первый разрешённый месяц: квартиры проданы полностью, остаётся только ПСН", () => {
    for (const r of salesRows(pair.normalProject, pair.normal)!) expect(r.unsold?.lt(1), r.key).toBe(true);
    const w = salesWarnings(pair.normalProject, pair.normal, pair.legacy);
    expect(w.map((x) => x.text)).toEqual(["ПСН: по плану продаж 10 888 м², построено 10 322 м². В расчёт вошло 10 322 м², выручка не потеряна, но темп завышен на 566 м²."]);
  });

  it("выручка расчёта сервиса не берётся из исходного Excel: пока цена сервиса не посчитана, выручки в сводке нет", () => {
    const normal = salesRows(pair.normalProject, pair.normal)!;
    const priced = !!pair.normal.result.formulas["F.SALES.PRICE"];
    for (const r of normal) expect(r.revenue === null, r.key).toBe(!priced);
  });

  it("выручка = продано × цена месяца; итого — по всем продуктам (расчёт «как в исходном Excel»)", () => {
    const rows = salesRows(demo, pair.legacy)!;
    const psn = rows.find((r) => r.key === "ПСН")!;
    expect(psn.avgPrice!.toNumber()).toBeGreaterThan(0);
    expect(psn.revenue!.div(psn.sold).toNumber()).toBeCloseTo(psn.avgPrice!.toNumber(), 6);
    const total = salesTotal(rows);
    expect(total.revenue!.toNumber()).toBeCloseTo(rows.reduce((s, r) => s + (r.revenue?.toNumber() ?? 0), 0), 2);
    expect(total.revenue!.sub(118130288024.5).abs().lt(1)).toBe(true);
  });

  it("машино-мест меньше норматива — предупреждение", () => {
    expect(parkingWarning(pair.legacy)).toBe("Машино-мест 862, а по нормативу нужно 2 785. Проверьте количество в ТЭПах — от него зависят затраты на паркинг и выручка.");
  });
});
