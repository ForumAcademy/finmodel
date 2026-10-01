import { describe, expect, it } from "vitest";
import { competitors as cmp, site } from "../src";

const AT = "2026-10-01T12:00:00.000Z";

/** Карточка «Стоун Сокольники» (bnMAP, данные на 26.09.2026) — как пример ввода. */
function stone(): cmp.Competitor {
  const r = cmp.competitorFromForm(
    { ...cmp.competitorToForm(null), name: "СТОУН Сокольники", url: "https://bnmap.pro/", developer: "Stone", classText: "Бизнес", salesStart: "10.04.2024" },
    null,
    "stone",
    AT,
  );
  expect(r.errors).toEqual([]);
  return r.competitor!;
}

function snap(date: string, projectArea: string, remainingPct: string, extra: Partial<cmp.SnapshotForm> = {}): cmp.CompetitorSnapshot {
  const f = { ...cmp.snapshotToForm(null), date, projectArea, remainingAreaShare: remainingPct, avgPrice: "558 573", ...extra };
  const r = cmp.snapshotFromForm(f, `s-${date}`, { fileId: null, fileName: null });
  expect(r.errors).toEqual([]);
  return r.snapshot!;
}

describe("карточка конкурента", () => {
  it("класс для расчёта по тексту карточки", () => {
    expect(cmp.classFromText("Бизнес-")).toBe("бизнес");
    expect(cmp.classFromText("Комфорт")).toBe("комфорт");
    expect(cmp.classFromText("Элит")).toBe("");
  });

  it("без ссылки и класса карточка не сохраняется", () => {
    const r = cmp.competitorFromForm({ ...cmp.competitorToForm(null), name: "ЖК" }, null, "x", AT);
    expect(r.competitor).toBeNull();
    expect(r.errors.join(" ")).toMatch(/ссылку/);
    expect(r.errors.join(" ")).toMatch(/класс/);
  });

  it("снимок: проценты остатков хранятся долей, цена обязательна", () => {
    const s = snap("26.09.2026", "45 984,2", "36,46");
    expect(s.date).toBe("2026-09-26");
    expect(s.remainingAreaShare).toBe("0.3646");
    expect(cmp.soldArea(s)!.toNumber()).toBeCloseTo(29218.36, 2);
    const bad = cmp.snapshotFromForm({ ...cmp.snapshotToForm(null), date: "26.09.2026" }, "x", { fileId: null, fileName: null });
    expect(bad.errors.join(" ")).toMatch(/среднюю цену/);
  });

  it("снимок на ту же дату заменяет прежний, снимки по возрастанию даты", () => {
    let c = stone();
    c = cmp.withSnapshot(c, snap("26.09.2026", "45984.2", "36.46"), AT);
    c = cmp.withSnapshot(c, snap("26.08.2026", "45984.2", "38"), AT);
    c = cmp.withSnapshot(c, { ...snap("26.09.2026", "45984.2", "36"), id: "other" }, AT);
    expect(c.snapshots.map((s) => [s.date, s.remainingAreaShare])).toEqual([
      ["2026-08-26", "0.38"],
      ["2026-09-26", "0.36"],
    ]);
  });
});

describe("темп продаж конкурента", () => {
  it("по выгрузке сделок — из источника: продано за 12 месяцев / 12", () => {
    const c = cmp.withSnapshot(stone(), snap("26.09.2026", "45984.2", "36.46", { soldArea12m: "12 000" }), AT);
    const p = cmp.competitorPace(c);
    expect(p.origin).toBe("source");
    expect(p.pace!.toNumber()).toBe(1000);
  });

  it("по двум снимкам — оценка: прирост проданной площади / месяцев", () => {
    let c = stone();
    c = cmp.withSnapshot(c, snap("26.03.2026", "45984.2", "50"), AT);
    c = cmp.withSnapshot(c, snap("26.09.2026", "45984.2", "36.46"), AT);
    const p = cmp.competitorPace(c);
    expect(p.origin).toBe("estimate");
    // (29 218,36068 − 22 992,1) м² / (184 дня / (365/12))
    expect(p.pace!.toNumber()).toBeCloseTo((29218.36068 - 22992.1) / (184 / (365 / 12)), 6);
  });

  it("снимок старше окна 12 месяцев не берётся", () => {
    let c: cmp.Competitor = { ...stone(), salesStart: null };
    c = cmp.withSnapshot(c, snap("01.08.2025", "45984.2", "60"), AT);
    c = cmp.withSnapshot(c, snap("26.09.2026", "45984.2", "36.46"), AT);
    expect(cmp.competitorPace(c).pace).toBeNull();
  });

  it("один снимок, старт продаж до 01.07.2024 — темпа нет, объяснено почему", () => {
    const c = cmp.withSnapshot(stone(), snap("26.09.2026", "45984.2", "36.46"), AT);
    const p = cmp.competitorPace(c);
    expect(p.pace).toBeNull();
    expect(p.note).toMatch(/01\.07\.2024/);
  });

  it("один снимок, старт после 01.07.2024 — средний темп со старта", () => {
    const c = cmp.withSnapshot({ ...stone(), salesStart: "2025-02-08" }, snap("26.09.2026", "11429.7", "76.91"), AT);
    const p = cmp.competitorPace(c);
    expect(p.origin).toBe("estimate");
    expect(p.pace!.toNumber()).toBeCloseTo((11429.7 * (1 - 0.7691)) / (595 / (365 / 12)), 6);
  });
});

describe("аналоги проекта из конкурентов", () => {
  it("привязанный конкурент добавляется строкой, ручные строки не трогаются, отвязанный убирается", () => {
    let c = cmp.withSnapshot(stone(), snap("26.09.2026", "45984.2", "36.46", { soldArea12m: "12000", stage: "Монтажные и отделочные работы", rve: "4 квартал 2027" }), AT);
    c = cmp.linkTo(c, "p1", "0,8", AT).competitor!;
    const manual: site.AnalogEntry = { id: "m", name: "Ручной", product: "квартиры", housingClass: "бизнес", distanceKm: null, stage: null, price: "500000", pace: "900", soldShare: null, url: "https://x", date: "2026-09-01" };
    const r = cmp.syncAnalogs([manual], [c], "p1");
    expect(r.added).toBe(1);
    const a = r.analogs.find((x) => x.competitorId === "stone")!;
    expect(a).toMatchObject({ price: "558573", pace: "1000", distanceKm: "0.8", housingClass: "бизнес", paceOrigin: "source", stage: "Монтажные и отделочные работы, РВЭ 4 квартал 2027" });
    expect(Number(a.soldShare)).toBeCloseTo(0.6354, 6);
    const again = cmp.syncAnalogs(r.analogs, [cmp.unlink(c, "p1", AT)], "p1");
    expect(again.removed).toBe(1);
    expect(again.analogs).toEqual([manual]);
  });

  it("ручная правка строки сохраняет связь с конкурентом", () => {
    const prev: site.AnalogEntry = { id: "stone", name: "Стоун", product: "квартиры", housingClass: "бизнес", distanceKm: null, stage: null, price: "558573", pace: "990", soldShare: null, url: "https://x", date: "2026-09-26", competitorId: "stone", paceOrigin: "estimate", paceNote: "n" };
    const r = site.analogFromForm(site.analogToForm(prev), prev.id, prev);
    expect(r.analog).toMatchObject({ competitorId: "stone", paceOrigin: "estimate" });
  });
});

describe("файл конкурентов", () => {
  it("сохраняется и открывается; объединение — снимки и привязки складываются", () => {
    let a = cmp.withSnapshot(stone(), snap("26.08.2026", "45984.2", "38"), AT);
    a = cmp.linkTo(a, "p1", "", AT).competitor!;
    let b = cmp.withSnapshot(stone(), snap("26.09.2026", "45984.2", "36.46"), AT);
    b = cmp.linkTo(b, "p2", "1", AT).competitor!;
    const parsed = cmp.parseCompetitorsFile(JSON.parse(JSON.stringify(cmp.buildCompetitorsFile([b], [], AT))));
    expect(parsed.error).toBeNull();
    const m = cmp.mergeCompetitors([a], parsed.file!.competitors, AT);
    expect(m.updated).toBe(1);
    expect(m.competitors[0]!.snapshots.map((s) => s.date)).toEqual(["2026-08-26", "2026-09-26"]);
    expect(m.competitors[0]!.links.map((l) => l.projectId).sort()).toEqual(["p1", "p2"]);
    expect(cmp.parseCompetitorsFile({ format: "x" }).file).toBeNull();
  });
});
