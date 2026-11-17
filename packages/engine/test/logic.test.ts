import { describe, expect, it } from "vitest";
import { getSource } from "@fm/spec";
import { logic } from "../src";

describe("Логика: карта сервиса", () => {
  const items = [...logic.LOGIC_STEPS.flatMap((s) => logic.LOGIC_LANES.flatMap((l) => s.lanes[l.id])), ...logic.LOGIC_RESULT];

  it("у каждого шага заполнены все строки карты", () => {
    for (const s of logic.LOGIC_STEPS) for (const l of logic.LOGIC_LANES) expect(s.lanes[l.id].length, `${s.title} / ${l.title}`).toBeGreaterThan(0);
  });

  it("каждый источник есть в справочнике; у общего источника есть ссылка, у документов проекта — нет", () => {
    for (const it of items)
      for (const link of logic.logicLinks(it)) {
        expect(link.url !== null, link.id).toBe(getSource(link.id).scope === "global");
        expect(link.label.length).toBeGreaterThan(0);
      }
  });

  it("законы и нормативы — всегда со ссылкой на документ", () => {
    for (const s of logic.LOGIC_STEPS)
      for (const it of s.lanes.norm.filter((x) => x.text !== "—")) {
        const links = logic.logicLinks(it);
        expect(links.length, it.text).toBeGreaterThan(0);
        expect(links.every((l) => l.url), it.text).toBe(true);
      }
  });

  it("пробелы на карте перечислены в «Что пока вручную»", () => {
    expect(items.some((i) => i.gap)).toBe(true);
    expect(logic.LOGIC_GAPS.length).toBeGreaterThan(0);
  });
});
