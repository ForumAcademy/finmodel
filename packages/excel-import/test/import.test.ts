import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { readByMap, readModelFile, workbookReader } from "../src";

const ROOT = resolve(import.meta.dirname, "../../..");
const file = readFileSync(resolve(ROOT, "legacy/Кальк Саевой привязка КОД.xlsx"));
const buf = file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength);
const inputs = (parse(readFileSync(resolve(ROOT, "tests/cases/derbenevskaya_legacy.yaml"), "utf8")) as { project_inputs: Record<string, unknown> }).project_inputs;

describe("загрузка финмодели в Excel", () => {
  it("исходный Excel: подставлены значения карты, как в тестовом кейсе", async () => {
    const r = readByMap(await workbookReader(buf), new Set());
    const got = Object.fromEntries(r.applied.map((a) => [a.param, a.value]));
    expect(got["LAND.AREA"]).toBe(inputs["LAND.AREA"]);
    expect(got["LAND.CADASTRAL_VALUE"]).toBe(inputs["LAND.CADASTRAL_VALUE"]);
    expect(got["TEP.GFA_ABOVE"]).toBe(inputs["TEP.GFA_ABOVE"]);
    expect(got["OPEX.MARKETING_RATE"]).toBe(inputs["OPEX.MARKETING_RATE"]);
    expect(got["GEN.MODEL_START_DATE"]).toBe("2025-12-31");
    expect(got["TEP.APT_MIX"]).toEqual((inputs["TEP.APT_MIX"] as { type_name: string; count: number; avg_area: number }[]).map(({ type_name, count, avg_area }) => ({ type_name, count, avg_area })));
    expect(r.applied.find((a) => a.param === "LAND.AREA")).toMatchObject({ sheet: "ТЭПы", cell: "C15" });
    // ставки по закону не подставляются
    expect(got["TAX.VAT_RATE"]).toBeUndefined();
    expect(r.skipped.find((s) => s.cells === "D54")?.reason).toMatch(/по закону/);
    // темп продаж не подставлен, но показан
    expect(r.skipped.some((s) => s.sheet === "План продаж")).toBe(true);
    // в списке — названия, а не коды параметров
    expect(r.skipped.filter((s) => /^[A-Z_]+\./.test(s.label))).toEqual([]);
  });

  it("значения формы важнее файла", async () => {
    const r = readByMap(await workbookReader(buf), new Set(["LAND.AREA", "GEN.MODEL_START_DATE"]));
    expect(r.applied.some((a) => a.param === "LAND.AREA")).toBe(false);
    expect(r.skipped.find((s) => s.cells === "C15")?.reason).toBe("указано в форме");
  });

  it("не Excel — null", async () => {
    expect(await readModelFile(new TextEncoder().encode("не таблица").buffer, new Set())).toBeNull();
  });
});
