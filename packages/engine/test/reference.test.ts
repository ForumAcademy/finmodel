import { describe, expect, it } from "vitest";
import { getParameter } from "@fm/spec";
import { reference } from "../src";

const sp = <T>(x: T): T => JSON.parse(JSON.stringify(x).replace(/\u00a0/g, " "));

describe("справочник для экрана", () => {
  it("технические обозначения заменяются названиями", () => {
    expect(reference.humanize("аренда (статья бюджета LAND_TAX_OR_RENT)")).toBe("аренда (статья бюджета «Земельный налог или арендная плата»)");
    expect(reference.humanize("решающее условие — GPZU.APART_ALLOWED")).toMatch(/^решающее условие — «.+»$/);
    expect(reference.humanize("подсказка (XYZ.UNKNOWN_CODE) в тексте")).toBe("подсказка в тексте");
    expect(reference.humanize("индексы CAPEX.COST_INDEX и CAPEX.OPEX_INDEX")).not.toMatch(/[A-Z]{3,}/);
  });

  it("значения: проценты, ряды по годам, таблицы", () => {
    expect(sp(reference.formatValue(getParameter("TAX.PROFIT_RATE"), 0.25))).toEqual({ text: "25 %" });
    expect(sp(reference.formatValue(getParameter("FIN.RATE_PREFERENTIAL"), 0.05))).toEqual({ text: "5 % годовых" });
    const key = sp(reference.formatValue(getParameter("FIN.KEY_RATE_PATH"), getParameter("FIN.KEY_RATE_PATH").default));
    expect(key?.table?.rows[0]).toEqual(["Сейчас (на 11.09.2026)", "14 % годовых"]);
    expect(reference.formatValue(getParameter("SALES.MORTGAGE_BANK_FEE_RATE"), null)).toBeNull();
    const vat = reference.formatValue(getParameter("TAX.VAT_REGIME"), getParameter("TAX.VAT_REGIME").default);
    expect(vat?.table?.headers).toEqual(["Продукт", "Договор", "НДС", "Основание"]);
    expect(vat?.table?.rows[0]?.slice(0, 3)).toEqual(["квартиры", "ДДУ", "не облагается"]);
  });

  it("разделы: стандартные значения, регионы проектов, формулы, источники", () => {
    expect(reference.standardTabs().map((t) => t.title)).toEqual(["Оценка участка", "Коэффициенты выхода площадей", "Продажи", "Бюджет", "Эскроу", "Финансирование", "Налоги и ставки"]);
    expect(reference.regionTabs().map((t) => t.title)).toEqual(["г. Москва", "Московская область"]);
    expect(reference.sourceTabs().map((t) => t.title)).toEqual(["Законодательство", "Статистика и аналитика", "Документы компании", "Экспертные данные"]);
    // param — ключ строки для правки, на экран не выводится
    const all = JSON.stringify([reference.standardTabs(), reference.regionTabs(), reference.formulaTabs(), reference.sourceTabs()], (k, v: unknown) => (k === "param" ? undefined : v));
    // в интерфейсе нет ID параметров, формул и источников
    expect(all).not.toMatch(/\b(?:F\.)?(?:GEN|LAND|TEP|CAPEX|SALES|FIN|TAX|TIME|OPEX|BENCH|VAL|GPZU|SITE|MARKET|VAR)\.[A-Z0-9_]+\b|\bS_[A-Z0-9_]+\b/);
  });

  it("шапка: пустые значения и источники на перепроверку", () => {
    const s = reference.referenceSummary();
    expect(s.version).toBe(4);
    expect(s.needValue).toBeGreaterThan(0);
    expect(s.recheckSources).toBeGreaterThan(0);
  });
});
