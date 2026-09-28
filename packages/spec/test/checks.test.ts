import { describe, expect, it } from "vitest";
import { checkSpec, spec, type SpecData } from "../src/index";

const clone = (): SpecData => structuredClone(spec) as unknown as SpecData;

describe("справочник проходит все проверки", () => {
  const result = checkSpec(spec as unknown as SpecData);

  it("ошибок нет", () => {
    expect(result.errors).toEqual([]);
  });

  it("все source_ids параметров, формул, статей и регионов существуют", () => {
    const ids = new Set(spec.sources.map((s) => s.id));
    const refs = [
      ...spec.parameters.flatMap((p) => p.source_ids),
      ...spec.formulas.flatMap((f) => f.source_ids),
      ...spec.capexItems.flatMap((c) => c.source_ids),
      ...spec.regions.flatMap((r) => [
        ...r.ncs_k_per_source_ids,
        ...r.land_tax_source_ids,
        ...r.land_rent_source_ids,
        ...r.vri_fee.source_ids,
        ...r.parking_norm.source_ids,
        ...r.ngp_source_ids,
      ]),
    ];
    expect(refs.filter((id) => !ids.has(id))).toEqual([]);
  });

  it("у источников уровня 1–3 есть URL", () => {
    const withoutUrl = spec.sources.filter((s) => s.level <= 3 && !s.url).map((s) => s.id);
    expect(withoutUrl).toEqual([]);
  });

  it("у каждого параметра и формулы есть хотя бы один источник", () => {
    expect(spec.parameters.filter((p) => p.source_ids.length === 0)).toEqual([]);
    expect(spec.formulas.filter((f) => f.source_ids.length === 0)).toEqual([]);
  });
});

describe("проверки ловят ошибки", () => {
  it("несуществующий источник у параметра", () => {
    const s = clone();
    s.parameters[0]!.source_ids = ["S_НЕТ_ТАКОГО"];
    expect(checkSpec(s).errors).toContainEqual(expect.stringContaining("источник S_НЕТ_ТАКОГО отсутствует"));
  });

  it("источник уровня 2 без URL", () => {
    const s = clone();
    const src = s.sources.find((x) => x.level === 2)!;
    src.url = null;
    expect(checkSpec(s).errors).toContainEqual(`источник ${src.id} уровня 2 без URL`);
  });

  it("проектный источник с URL или уровнем ниже 4", () => {
    const s = clone();
    const src = s.sources.find((x) => x.scope === "project")!;
    src.url = "https://example.com";
    expect(checkSpec(s).errors).toContainEqual(expect.stringContaining(`источник ${src.id}: проектный источник`));
  });

  it("общий источник уровня 5", () => {
    const s = clone();
    s.sources.find((x) => x.scope === "global")!.level = 5;
    expect(checkSpec(s).errors).toContainEqual(expect.stringContaining("может быть только проектной"));
  });

  it("зависимость формулы на несуществующий ID", () => {
    const s = clone();
    s.formulas[0]!.depends_on.push("GEN.НЕТ_ТАКОГО");
    expect(checkSpec(s).errors).toContainEqual(expect.stringContaining("зависимость GEN.НЕТ_ТАКОГО не найдена"));
  });

  it("цикл без лага в графе формул", () => {
    const s = clone();
    const date = s.formulas.find((f) => f.id === "F.TIME.DATE")!;
    date.depends_on.push("F.TIME.DAYS");
    expect(checkSpec(s).errors).toContainEqual(expect.stringContaining("цикл без лага"));
  });

  it("дубль ID параметра", () => {
    const s = clone();
    s.parameters.push(structuredClone(s.parameters[0]!));
    expect(checkSpec(s).errors).toContainEqual(`параметр: дубль ID ${s.parameters[0]!.id}`);
  });
});

describe("лаговые зависимости (lag_depends_on)", () => {
  it("входят в depends_on", () => {
    const bad = spec.formulas.flatMap((f) => (f.lag_depends_on ?? []).filter((d) => !f.depends_on.includes(d)));
    expect(bad).toEqual([]);
  });

  it("лаг вне depends_on — ошибка", () => {
    const s = clone();
    s.formulas.find((f) => f.id === "F.FIN.RATE")!.lag_depends_on = ["F.TIME.DAYS"];
    expect(checkSpec(s).errors).toContainEqual("формула F.FIN.RATE: lag_depends_on F.TIME.DAYS нет в depends_on");
  });

  it("без лаговых связей граф формул содержит цикл", () => {
    const s = clone();
    for (const f of s.formulas) delete f.lag_depends_on;
    expect(checkSpec(s).errors).toContainEqual(expect.stringContaining("цикл без лага"));
  });
});
