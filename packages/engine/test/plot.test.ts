import { describe, expect, it } from "vitest";
import { plot } from "../src";

const AT = "2026-09-29T10:00:00.000Z";
/** Пробел в тысячах — неразрывный: в тестах сравниваем с обычным. */
const sp = <T>(x: T): T => JSON.parse(JSON.stringify(x).replace(/\u00a0/g, " "));
const form = (over: Partial<plot.NewProjectForm> = {}): plot.NewProjectForm => ({
  cadastralNumber: "",
  name: "",
  area: "",
  address: "",
  point: null,
  regionCode: "",
  egrn: null,
  documents: [],
  ...over,
});
const doc = (id: string, kind: plot.DocumentKind = "egrn"): plot.ProjectDocument => ({ id, kind, fileName: `${id}.xml`, size: 1, uploadedAt: AT });
const EGRN: plot.EgrnPlot = {
  cadastralNumber: "77:05:0004012:1873",
  address: "г. Москва, ул. Примерная, вл. 1",
  regionCode: "77",
  area: "32000",
  category: "Земли населенных пунктов",
  vri: "Многоэтажная жилая застройка (высотная застройка) (2.6)",
  cadastralValue: "2900000000.00",
  rights: ["Собственность"],
  extractDate: "2026-09-28",
};

describe("кадастровый номер и регион", () => {
  it("номер и квартал", () => {
    expect(plot.normalizeCadastralNumber(" 77:05:0004012:1873 ")).toBe("77:05:0004012:1873");
    expect(plot.normalizeCadastralNumber("77-05-0004012-1873")).toBeNull();
    expect(plot.cadastralQuarter("50:22:0010205:311")).toBe("50:22:0010205");
  });

  it("регионы для новых проектов — из справочника регионов: Москва и Московская область", () => {
    expect(plot.PROJECT_REGIONS.map((r) => r.code)).toEqual(["77", "50"]);
    expect(plot.regionByCadastral("77:05:0004012:1873")?.code).toBe("77");
    expect(plot.regionByCadastral("50:22:0010205:311")?.code).toBe("50");
    expect(plot.regionByCadastral("66:41:0000000:1")).toBeNull();
  });

  it("регион по адресу — целыми словами; неоднозначный адрес не угадывается", () => {
    expect(plot.regionByAddress("г. Москва, Каширское ш., вл. 64")?.code).toBe("77");
    expect(plot.regionByAddress("Москва г, Сосенское п")?.code).toBe("77");
    expect(plot.regionByAddress("Московская обл., г. Красногорск")?.code).toBe("50");
    expect(plot.regionByAddress("обл. Московская, г.о. Люберцы")?.code).toBe("50");
    expect(plot.regionByAddress("Московский пр-т, Санкт-Петербург")).toBeNull();
    expect(plot.regionByAddress("Московская обл., у реки Москва")).toBeNull();
  });
});

describe("новый проект", () => {
  it("по кадастровому номеру: регион и квартал по номеру, остальное — «не хватает»", () => {
    const r = plot.createProject(form({ cadastralNumber: "77:05:0004012:1873", name: "Каширка" }), "p1", AT);
    expect(r.errors).toEqual([]);
    const p = r.project!;
    expect(p.plot.regionCode.value).toBe("77");
    expect(p.plot.quarter.value).toBe("77:05:0004012");
    expect(plot.projectStatus(p)).toEqual({ noCadastralNumber: false, missing: 4 });
    expect(plot.missingFields(p)).toEqual(["area", "vri", "cadastralValue", "tenure"]);
  });

  it("без кадастрового номера: нужны площадь и местоположение, статус «Участок без кадастрового номера»", () => {
    const bad = plot.createProject(form(), "p2", AT);
    expect(bad.project).toBeNull();
    expect(bad.errors.map((e) => e.field)).toEqual(["area", "location", "regionCode"]);

    const ok = plot.createProject(form({ area: "14 500", address: "Московская обл., г. Люберцы, ул. Примерная" }), "p2", AT);
    expect(ok.errors).toEqual([]);
    const p = ok.project!;
    expect(p.plot.area.value).toBe("14500");
    expect(p.plot.regionCode.value).toBe("50");
    expect(p.plot.area.origin).toBe("expert");
    expect(plot.projectStatus(p)).toEqual({ noCadastralNumber: true, missing: 3 });
    expect(plot.projectTitle(p)).toBe("Московская обл., г. Люберцы, ул. Примерная");
    expect(plot.projectSubtitle(p)).toBe("Московская область · 1,45 га");
  });

  it("точка на карте без адреса: регион выбирается вручную", () => {
    const noRegion = plot.createProject(form({ area: "10000", point: { lat: 55.75, lon: 37.62 } }), "p3", AT);
    expect(noRegion.errors.map((e) => e.field)).toEqual(["regionCode"]);
    const ok = plot.createProject(form({ area: "10000", point: { lat: 55.75, lon: 37.62 }, regionCode: "77" }), "p3", AT);
    expect(ok.project?.plot.regionCode.basis?.note).toBe("Выбран вручную");
  });

  it("ошибки ввода: что не так → числа → что сделать", () => {
    const r = plot.createProject(form({ cadastralNumber: "66:41:0000000:1" }), "p", AT);
    expect(sp(r.errors[0]?.text)).toBe("Номер из кадастрового округа 66 — этот регион пока недоступен. Доступны: г. Москва (77), Московская область (50).");
    const a = plot.createProject(form({ area: "50", address: "г. Москва" }), "p", AT);
    expect(sp(a.errors[0]?.text)).toBe("Площадь 50 м² вне допустимого диапазона 100–5 000 000 м². Проверьте единицы: площадь вводится в м².");
  });

  it("с выпиской ЕГРН: поля «из источника» со ссылкой на документ", () => {
    const r = plot.createProject(form({ cadastralNumber: "77:05:0004012:1873", egrn: { data: EGRN, document: doc("d1") } }), "p4", AT);
    const p = r.project!;
    expect(p.documents.map((d) => d.id)).toEqual(["d1"]);
    expect(p.plot.area).toEqual({ value: "32000", origin: "source", basis: { title: "Выписка ЕГРН", documentId: "d1", date: "2026-09-28" } });
    expect(p.plot.tenure.value).toBe("собственность");
    expect(plot.projectStatus(p)).toEqual({ noCadastralNumber: false, missing: 0 });
    expect(plot.vriCodes(p.plot.vri.value)).toEqual(["2.6"]);
  });

  it("выписка по другому участку не принимается", () => {
    const r = plot.createProject(form({ cadastralNumber: "77:05:0004012:1", egrn: { data: EGRN, document: doc("d1") } }), "p", AT);
    expect(r.errors.map((e) => e.field)).toEqual(["egrn"]);
  });
});

describe("номер появился позже: замена оценок и «было → стало»", () => {
  const start = plot.createProject(form({ area: "30000", address: "г. Москва, Каширское ш." }), "p5", AT).project!;
  const manual = { title: "Введено вручную", date: "2026-09-29" };

  it("номер, квартал; регион совпал — не меняется", () => {
    const set = plot.cadastralNumberChanges(start, "77:05:0004012:1873", manual);
    expect(set.problems).toEqual([]);
    expect(set.changes.map((c) => c.field)).toEqual(["cadastralNumber", "quarter"]);
  });

  it("неверный номер — сообщение, без изменений", () => {
    expect(plot.cadastralNumberChanges(start, "12345", manual).changes).toEqual([]);
  });

  it("выписка заменяет введённые значения, «было → стало» и история", () => {
    const withKn = plot.applyChanges(start, plot.cadastralNumberChanges(start, "77:05:0004012:1873", manual).changes, AT);
    const set = plot.egrnChanges(withKn, EGRN, { id: "d9", date: "2026-09-28" });
    expect(set.problems).toEqual([]);
    const rows = plot.changeRows(set.changes);
    expect(sp(rows.find((r) => r.field === "area"))).toEqual({ field: "area", label: "Площадь участка", from: "30 000 м²", to: "32 000 м²" });
    expect(sp(rows.find((r) => r.field === "cadastralValue"))).toEqual({ field: "cadastralValue", label: "Кадастровая стоимость", from: "не учтено", to: "2 900 000 000 руб" });
    expect(sp(rows.find((r) => r.field === "regionCode"))).toEqual({ field: "regionCode", label: "Регион", from: "г. Москва, Экспертное значение", to: "г. Москва, из источника" });
    const after = plot.applyChanges(withKn, set.changes, "2026-09-29T11:00:00.000Z");
    expect(after.plot.area.origin).toBe("source");
    expect(after.history.at(-1)?.basis).toBe("Выписка ЕГРН от 28.09.2026");
    expect(plot.projectStatus(after)).toEqual({ noCadastralNumber: false, missing: 0 });
    // повторная загрузка той же выписки ничего не меняет
    expect(plot.egrnChanges(after, EGRN, { id: "d9", date: "2026-09-28" }).changes).toEqual([]);
  });

  it("ручное изменение: с документом — «из источника», без — «Экспертное значение»", () => {
    expect(plot.manualChange(start, "area", "31000", { title: "ГПЗУ", documentId: "g1" })[0]?.to.origin).toBe("source");
    expect(plot.manualChange(start, "area", "31000", { title: "Замер БТИ" })[0]?.to.origin).toBe("expert");
    expect(plot.manualChange(start, "area", null, { title: "—" })[0]?.to).toEqual({ value: null, origin: null, basis: null });
  });

  it("аренда в выписке — форма права «аренда»", () => {
    expect(plot.tenureFromRights(["Собственность", "Аренда (в том числе, субаренда)"])).toBe("аренда");
    expect(plot.tenureFromRights(["Общая долевая собственность"])).toBe("собственность");
    expect(plot.tenureFromRights(["Постоянное (бессрочное) пользование"])).toBeNull();
  });

  it("несохранённые изменения: по полю — исходное «было» и последнее «стало»; вернули как было — изменения нет", () => {
    const a = plot.manualChange(start, "area", "31000", { title: "Замер" });
    const b = plot.manualChange(start, "area", "32000", { title: "Замер" });
    const merged = plot.mergeChanges(a, b);
    expect(merged.map((c) => [c.from.value, c.to.value])).toEqual([["30000", "32000"]]);
    expect(plot.mergeChanges(a, [{ field: "area", from: a[0]!.to, to: start.plot.area }])).toEqual([]);
  });
});
