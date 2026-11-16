import { describe, expect, it } from "vitest";
import { book, plot, projectFile, site, summary, SPEC_ASSUMPTIONS } from "../src";

const AT = "2026-09-29T10:00:00.000Z";
const V1 = SPEC_ASSUMPTIONS[0] as book.AssumptionVersion;

/** Проект без кадастрового номера: адрес и площадь, как «Дербеневская» у пользователя. */
function project(id = "p1", name = "Дербеневская"): plot.LandProject {
  const r = plot.createProject({ cadastralNumber: "", name, area: "96572", address: "г. Москва, Дербеневская набережная", point: null, regionCode: "77", egrn: null, documents: [] }, id, AT, 1);
  if (!r.project) throw new Error(r.errors.join("; "));
  return r.project;
}

const SNAP: site.AnalysisSnapshot = { at: "2026-09-29T10:00:00.000Z", best: "b", bestTitle: "Бизнес, 24 этажа", netProfit: "1234500000", variants: 4 };
const UPDATES: summary.ServiceUpdate[] = [
  { date: "2026-11-16", text: "Новое 16.11" },
  { date: "2026-11-13", text: "Новое 13.11" },
];

describe("что нужно ввести", () => {
  it("значения со всех экранов одним списком: участок, градрегламент, сделка, аналоги", () => {
    const p = project();
    const list = summary.todoList(p);
    const keys = list.map((i) => i.key);
    for (const k of plot.missingFields(p)) expect(keys).toContain(`plot.${k}`);
    expect(keys).toContain("site.maxFloors");
    expect(keys).toContain("site.landPrice");
    expect(keys).toContain("market.analogs");
    // ни одного ограничения объёма — одна строка на все три
    expect(keys).toContain("site.density");
    // у каждого пункта — где взять и куда перейти
    for (const i of list) {
      expect(i.where.length).toBeGreaterThan(0);
      expect(["plot", "site", "market"]).toContain(i.sec);
    }
    expect(list.find((i) => i.key === "market.analogs")?.why).toMatch(/сейчас 0/);
    // Цена участка — на шаге «Участок», вкладка «Сделка»; этажность — «Что можно построить», «Ограничения»
    expect(list.find((i) => i.key === "site.landPrice")).toMatchObject({ sec: "plot", tab: "Сделка" });
    expect(list.find((i) => i.key === "site.maxFloors")).toMatchObject({ sec: "site", tab: "Ограничения" });
    expect(summary.todoCount(list, "market")).toBe(1);
    expect(summary.todoCount(list, "plot")).toBe(plot.missingFields(p).length + 1);
  });

  it("введённое значение уходит из списка", () => {
    const p = project();
    const c = site.siteChange(p, "maxFloors", "24", { title: "ГПЗУ" });
    const next = site.applySiteChange(p, c as site.SiteChange, AT);
    expect(summary.todoList(next).map((i) => i.key)).not.toContain("site.maxFloors");
  });
});

describe("обновления сервиса после расчёта", () => {
  it("только то, что вышло позже дня расчёта", () => {
    expect(summary.updatesSince("2026-11-13T09:00:00Z", UPDATES).map((u) => u.text)).toEqual(["Новое 16.11"]);
    expect(summary.updatesSince("2026-09-29T10:00:00Z", UPDATES)).toHaveLength(2);
    expect(summary.updatesSince("2026-11-16T12:00:00Z", UPDATES)).toEqual([]);
    expect(summary.updatesSince(null, UPDATES)).toEqual([]);
  });

  it("список сервиса: даты по порядку, новые сверху, без пустых текстов", () => {
    const dates = summary.SERVICE_UPDATES.map((u) => u.date);
    expect([...dates].sort().reverse()).toEqual(dates);
    for (const u of summary.SERVICE_UPDATES) {
      expect(u.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(u.text.length).toBeGreaterThan(0);
    }
    expect(summary.lastUpdate(UPDATES)).toBe("2026-11-16");
  });

  it("итог для карточки запоминается заново, если он изменился или сервис обновился", () => {
    const fresh = { ...SNAP, at: "2026-11-16T10:00:00Z" };
    expect(summary.snapshotOutdated(null, fresh, UPDATES)).toBe(true);
    expect(summary.snapshotOutdated(SNAP, fresh, UPDATES)).toBe(true);
    expect(summary.snapshotOutdated(fresh, { ...fresh, at: "2026-11-17T10:00:00Z" }, UPDATES)).toBe(false);
    expect(summary.snapshotOutdated(fresh, { ...fresh, netProfit: "1" }, UPDATES)).toBe(true);
  });
});

describe("карточка проекта", () => {
  it("не посчитан: причина — сколько значений ввести", () => {
    const p = project();
    const s = summary.cardStatus(p, UPDATES);
    const n = summary.todoList(p).length;
    expect(s.result).toBeNull();
    expect(s.reason).toBe(`Не посчитан: нужно ввести ${n} значений`);
    expect(s.changed).toBe("Данные изменены 29.09.2026");
    expect(s.calculated).toBeNull();
    // расчёт без вариантов — тоже «не посчитан», без даты расчёта
    const empty = summary.cardStatus(site.updateSite(p, { snapshot: { ...SNAP, best: null, bestTitle: null, netProfit: null, variants: 0 } }, AT), UPDATES);
    expect(empty.result).toBeNull();
    expect(empty.calculated).toBeNull();
  });

  it("посчитан до обновления сервиса — итог и пометка пересчитать", () => {
    const p = site.updateSite(project(), { snapshot: SNAP }, "2026-09-29T11:00:00.000Z");
    const s = summary.cardStatus(p, UPDATES);
    expect(s.result).toMatch(/^Лучший вариант: Бизнес, 24 этажа/);
    expect(s.reason).toMatch(/Сервис обновился после расчёта/);
    expect(s.calculated).toBe("Посчитан 29.09.2026");
  });

  it("запомненный итог не меняет дату изменения данных, выбор варианта — меняет", () => {
    const p = project();
    expect(site.updateSite(p, { snapshot: SNAP }, "2026-11-16T10:00:00.000Z").updatedAt).toBe(AT);
    expect(site.updateSite(p, { selectedVariant: "b" }, "2026-11-16T10:00:00.000Z").updatedAt).toBe("2026-11-16T10:00:00.000Z");
  });

  it("время расчёта — местное время браузера", () => {
    expect(summary.calculatedText(new Date(2026, 10, 16, 9, 5))).toBe("Посчитано 16.11.2026 в 09:05");
  });
});

describe("все проекты одним файлом", () => {
  const files = [project("p1", "Дербеневская"), project("p2", "Лялин")].map((p) => projectFile.buildProjectFile(p, [V1], [], AT));
  const bundle = projectFile.buildBundle(files, [V1], AT);

  it("сохраняется и читается обратно; имя файла с числом проектов", () => {
    const r = projectFile.readAnyProjectFile(JSON.parse(JSON.stringify(bundle)));
    expect(r.kind).toBe("bundle");
    if (r.kind === "bundle") {
      expect(r.bundle.projects.map((f) => f.project.name)).toEqual(["Дербеневская", "Лялин"]);
      expect(r.bundle.reference).toHaveLength(1);
    }
    expect(projectFile.bundleFileName(2, AT)).toBe("Все проекты (2) — 29.09.2026.json");
  });

  it("обычный файл проекта открывается той же кнопкой", () => {
    const r = projectFile.readAnyProjectFile(JSON.parse(JSON.stringify(files[0])));
    expect(r.kind).toBe("project");
  });

  it("чужой и повреждённый файл — понятная ошибка", () => {
    const other = projectFile.readAnyProjectFile({ hello: 1 });
    expect(other.kind === "error" && other.error).toMatch(/Это не файл проекта/);
    const broken = projectFile.readAnyProjectFile({ ...bundle, projects: [{ format: "finmodel-project" }] });
    expect(broken.kind === "error" && broken.error).toMatch(/один из проектов не читается/);
  });

  it("совпавшие по названию: заменить, создать копии или пропустить; остальные открываются как новые", () => {
    const here = [project("x", "Лялин")];
    expect(projectFile.bundleConflicts(bundle, here).map((c) => c.existing.id)).toEqual(["x"]);
    expect(projectFile.bundlePlan(bundle, here, "skip").map((s) => [s.file.project.name, s.mode])).toEqual([["Дербеневская", "new"]]);
    expect(projectFile.bundlePlan(bundle, here, "replace").map((s) => s.mode)).toEqual(["new", "replace"]);
    expect(projectFile.bundlePlan(bundle, here, "copy").map((s) => s.mode)).toEqual(["new", "copy"]);
    expect(projectFile.bundleResultText(1, 1)).toBe("Открыто 1 проект, не открыто 1 (такие проекты уже есть в браузере).");
    expect(projectFile.bundleResultText(2, 0)).toBe("Открыто 2 проекта.");
  });
});
