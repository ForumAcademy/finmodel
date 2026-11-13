import { describe, expect, it } from "vitest";
import { getSource } from "@fm/spec";
import { dataGuide } from "../src";

describe("Где взять данные", () => {
  it("у общего источника есть ссылка, у документа проекта — нет", () => {
    for (const r of dataGuide.dataGuideRows()) {
      expect(r.url !== null).toBe(getSource(r.source).scope === "global");
      expect(r.gives.length).toBeGreaterThan(0);
      expect(r.how.length).toBeGreaterThan(0);
    }
  });
});
