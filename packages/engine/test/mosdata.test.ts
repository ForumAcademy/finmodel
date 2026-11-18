import { describe, expect, it } from "vitest";
import { mosdata, plot, site } from "../src";

const AT = "2026-11-17T07:00:00.000Z";
const P = { lat: 55.75756, lon: 37.65373 };
const square = (lon: number, lat: number, d: number) => [[[lon - d, lat - d], [lon + d, lat - d], [lon + d, lat + d], [lon - d, lat + d], [lon - d, lat - d]]];

/** Ответ портала в том виде, в каком он приходит: поля — строкой в записи Python. Значения — из ответа 17.11.2026. */
const PLOTS = {
  type: "FeatureCollection",
  features: [
    {
      type: "Feature",
      geometry: { type: "MultiPolygon", coordinates: [square(P.lon, P.lat, 0.0003)] },
      properties: { datasetId: "1497", attributes: "{'ID': 7407715, 'global_id': 5097326729, 'CadastralNumber': '77:01:0001028:2999', 'Location': '(Российская Федерация, город Москва, внутригородская территория муниципальный округ Басманный, Лялин переулок, земельный участок 21/2)', 'FieldArea': 3110, 'OwnerType': 'неразграниченная собственность', 'RentalStatus': 'Нет', 'PermittedUse': 'деловое управление (4.1)'}" },
    },
    {
      type: "Feature",
      geometry: { type: "MultiPolygon", coordinates: [square(P.lon, P.lat, 0.0001)] },
      properties: { datasetId: "1497", attributes: "{'ID': 2120832, 'CadastralNumber': '77:01:0001028:2', 'Location': '(город Москва, переулок Лялин, земельный участок 21/2/1)', 'FieldArea': 793, 'OwnerType': 'неразграниченная собственность', 'RentalStatus': 'Да', 'PermittedUse': 'деловое управление (4.1)'}" },
    },
    {
      type: "Feature",
      geometry: { type: "Polygon", coordinates: square(P.lon + 0.01, P.lat, 0.0001) },
      properties: { attributes: "{'CadastralNumber': '77:01:0001028:61', 'FieldArea': 100}" },
    },
  ],
};

const ZONES = {
  features: [
    { geometry: { type: "Polygon", coordinates: square(P.lon, P.lat, 0.01) }, properties: { attributes: "{'ID': 1106, 'ObjectNameOnDoc': 'Объединенная охранная зона памятников истории и культуры', 'X': None}" } },
    { geometry: { type: "Polygon", coordinates: [square(P.lon, P.lat, 0.01)[0], square(P.lon, P.lat, 0.001)[0]] }, properties: { attributes: "{'ObjectNameOnDoc': 'Зона с дырой на участке'}" } },
  ],
};

const make = () =>
  plot.createProject({ cadastralNumber: "", name: "", area: "3410", address: "Лялин переулок, 21 с.2", point: null, regionCode: "77", egrn: null, documents: [] }, "p1", AT).project as plot.LandProject;

describe("данные портала открытых данных Москвы", () => {
  it("поля в записи Python разбираются", () => {
    expect(mosdata.parsePyLiteral("{'a': 1, 'b': 'Дом \\'X\\'', 'c': None, 'd': [1, 2.5], 'e': True}")).toEqual({ a: 1, b: "Дом 'X'", c: null, d: [1, 2.5], e: true });
    expect(mosdata.parsePyLiteral("{'a': ")).toBeNull();
  });

  it("окно запроса — вокруг точки", () => {
    expect(mosdata.featuresPath("plots", P)).toBe("/v1/datasets/1497/features?bbox=37.651730,55.755560,37.655730,55.759560");
  });

  it("городские участки в точке: крупный первым, чужие отброшены", () => {
    const list = mosdata.cityPlotsAt(PLOTS, P);
    expect(list.map((c) => c.cadastralNumber)).toEqual(["77:01:0001028:2999", "77:01:0001028:2"]);
    expect(list[0]).toMatchObject({ area: "3110", rented: false, vri: "деловое управление (4.1)", ownerType: "неразграниченная собственность" });
    expect(list[0]?.address).toMatch(/^Российская Федерация/);
    expect(mosdata.cityPlotText(list[1] as mosdata.CityPlot)).toBe("77:01:0001028:2, 793 м², деловое управление (4.1), сдан в аренду");
    expect(mosdata.cityPlotsAt({ error: 1 }, P)).toEqual([]);
    const m = mosdata.mosLookup(P, { plots: PLOTS }, AT);
    expect(mosdata.mosText(m)).toBe("Городских участков в этой точке: 2. Портал открытых данных Москвы, 17.11.2026.");
    const chosen = mosdata.chosenCityPlot(m, "77:01:0001028:2999");
    expect(mosdata.mosText(m, chosen)).toBe("Участок 77:01:0001028:2999, 3110 м², деловое управление (4.1), в аренду не сдан. Портал открытых данных Москвы, 17.11.2026.");
    expect(mosdata.chosenCityPlot(m, null)).toBeNull();
  });

  it("зоны охраны: точка в дыре границы — не в зоне", () => {
    const m = mosdata.mosLookup(P, { plots: PLOTS, zones: ZONES, territories: { features: [] } }, AT);
    expect(m.zones).toEqual(["Объединенная охранная зона памятников истории и культуры"]);
    const z = mosdata.heritageZouit(m);
    expect(z).toHaveLength(1);
    expect(z[0]).toMatchObject({ area: null, noBuild: false, origin: "source" });
    expect(z[0]?.basis.url).toBe("https://data.mos.ru/opendata/613");
  });

  it("участок города: номер, квартал, ВРИ — из источника; аренда — оценка; площадь не меняется, сообщение", () => {
    const c = mosdata.cityPlotsAt(PLOTS, P)[0] as mosdata.CityPlot;
    const r = mosdata.applyCityPlot(make(), c, AT);
    const pl = r.project.plot;
    expect(pl.cadastralNumber).toMatchObject({ value: "77:01:0001028:2999", origin: "source" });
    expect(pl.quarter).toMatchObject({ value: "77:01:0001028", origin: "source" });
    expect(pl.vri).toMatchObject({ value: "деловое управление (4.1)", origin: "source" });
    expect(pl.tenure).toMatchObject({ value: "аренда", origin: "estimate" });
    expect(pl.quarter.basis?.note).toBe("Первая часть кадастрового номера участка 77:01:0001028:2999");
    expect(pl.cadastralNumber.basis?.url).toBe("https://data.mos.ru/opendata/1497");
    expect(pl.area.value).toBe("3410");
    // Кадастровая стоимость — оценка: 3 410 м² × 107 210,79 (квартал 77:01:0001028, офисы — ВРИ 4.1)
    expect(pl.cadastralValue).toMatchObject({ value: "365588793.9", origin: "estimate" });
    expect(r.problems).toEqual(["В реестре города площадь участка 3110 м², в проекте — 3410 м². Проверьте площадь: расчёт идёт от площади проекта."]);
    // Повторно — без изменений
    expect(mosdata.applyCityPlot(r.project, c, AT).changes).toEqual([]);
  });
});

describe("сохранение найденного на портале", () => {
  it("зоны — в анализ участка, ручные строки остаются; один участок — сразу в данные", () => {
    const base = make();
    const own = { id: "z1", name: "Своя зона", area: "10", noBuild: true, restriction: "x", origin: "expert" as const, basis: { title: "Эксперт" } };
    const withOwn = { ...base, site: { values: {}, zouit: [own], analogs: [], customVariants: [], selectedVariant: null, snapshot: null, curve: null } };
    const one = { features: [PLOTS.features[0]] };
    const m = mosdata.mosLookup(P, { plots: one, zones: ZONES, territories: null }, AT);
    const r = mosdata.applyMosLookup(withOwn, m, AT);
    expect(r.project.mos?.plots).toHaveLength(1);
    expect(r.project.site?.zouit.map((z) => z.name)).toEqual(["Своя зона", "Объединенная охранная зона памятников истории и культуры"]);
    expect(r.project.plot.cadastralNumber.value).toBe("77:01:0001028:2999");
    const again = mosdata.applyMosLookup(r.project, m, AT);
    expect(again.project.site?.zouit).toHaveLength(2);
    const two = mosdata.applyMosLookup(base, mosdata.mosLookup(P, { plots: PLOTS }, AT), AT);
    expect(two.changes).toEqual([]);
    const none = mosdata.applyMosLookup(base, mosdata.mosLookup(P, { plots: { features: [] } }, AT), AT);
    expect(none.project.plot.tenure).toMatchObject({ value: "собственность", origin: "estimate" });
    expect(two.project.plot.cadastralNumber.value).toBeNull();
    // Выбранный из нескольких участок при обновлении остаётся и получает свежие данные
    const picked = mosdata.applyCityPlot(base, mosdata.cityPlotsAt(PLOTS, P)[0] as mosdata.CityPlot, AT).project;
    const refreshed = mosdata.applyMosLookup(picked, mosdata.mosLookup(P, { plots: PLOTS }, AT), AT);
    expect(refreshed.project.plot.cadastralNumber.value).toBe("77:01:0001028:2999");
    expect(refreshed.changes).toEqual([]);
  });
});

describe("после ручной правки", () => {
  it("площадь исправлена вручную — оценка кадастровой стоимости пересчитана", () => {
    const c = mosdata.cityPlotsAt(PLOTS, P)[0] as mosdata.CityPlot;
    const p = mosdata.applyCityPlot(make(), c, AT).project;
    const edited = plot.applyChanges(p, plot.manualChange(p, "area", "3110", { title: "Введено вручную" }), AT);
    const r = mosdata.afterManualEdit(edited, ["area"], AT);
    // 3 110 м² × 107 210,79 руб/м²
    expect(r.project.plot.cadastralValue).toMatchObject({ value: "333425556.9", origin: "estimate" });
  });

  it("номер участка введён вручную и есть на портале — данные участка подставлены", () => {
    const base = mosdata.applyMosLookup(make(), mosdata.mosLookup(P, { plots: PLOTS }, AT), AT).project;
    const edited = plot.applyChanges(base, plot.cadastralNumberChanges(base, "77:01:0001028:2", { title: "Введено вручную" }).changes, AT);
    const r = mosdata.afterManualEdit(edited, ["cadastralNumber", "quarter"], AT);
    expect(r.project.plot.cadastralNumber).toMatchObject({ value: "77:01:0001028:2", origin: "source" });
    expect(r.project.plot.vri.value).toBe("деловое управление (4.1)");
    expect(r.project.plot.cadastralValue.origin).toBe("estimate");
  });

  it("введённое вручную не заменяется значением портала", () => {
    const p = make();
    const own = plot.applyChanges(p, plot.manualChange(p, "vri", "многоэтажная жилая застройка (2.6)", { title: "Введено вручную" }), AT);
    const r = mosdata.applyCityPlot(own, mosdata.cityPlotsAt(PLOTS, P)[0] as mosdata.CityPlot, AT);
    expect(r.project.plot.vri).toMatchObject({ value: "многоэтажная жилая застройка (2.6)", origin: "expert" });
    expect(r.problems.some((t) => t.startsWith("Вид разрешённого использования: на портале Москвы"))).toBe(true);
  });
});


describe("несколько участков в проекте", () => {
  it("отмеченные участки складываются: номера, площадь, кадастровая стоимость; площадь больше введённой — сообщение", () => {
    const list = mosdata.cityPlotsAt(PLOTS, P);
    const base = mosdata.applyMosLookup(make(), mosdata.mosLookup(P, { plots: PLOTS }, AT), AT).project;
    const r = mosdata.applyCityPlots(base, list, AT);
    const pl = r.project.plot;
    expect(pl.cadastralNumber.value).toBe("77:01:0001028:2999, 77:01:0001028:2");
    expect(pl.quarter.value).toBe("77:01:0001028");
    expect(pl.area).toMatchObject({ value: "3903", origin: "source" });
    // (3 110 + 793) м² × 107 210,79 руб/м² — оба участка в одном квартале, ВРИ 4.1
    expect(pl.cadastralValue).toMatchObject({ value: "418443713.37", origin: "estimate" });
    expect(r.problems).toContain("Площадь отмеченных участков 3 903 м² больше введённой ранее 3 410 м². В расчёт взята сумма площадей; проверьте, все ли участки входят в проект.");
    expect(mosdata.chosenCityPlots(r.project.mos as mosdata.MosLookup, pl.cadastralNumber.value)).toHaveLength(2);
    // Обновление с портала сохраняет оба участка
    expect(mosdata.applyMosLookup(r.project, r.project.mos as mosdata.MosLookup, AT).changes).toEqual([]);
    // Снова один участок — площадь его
    const one = mosdata.applyCityPlots(r.project, [list[0] as mosdata.CityPlot], AT).project.plot;
    expect(one.area.value).toBe("3110");
    expect(one.cadastralNumber.value).toBe("77:01:0001028:2999");
  });

  it("введённая кадастровая стоимость меньше оценки отмеченных участков — сообщение, введённая остаётся", () => {
    const base = mosdata.applyMosLookup(make(), mosdata.mosLookup(P, { plots: PLOTS }, AT), AT).project;
    const own = plot.applyChanges(base, plot.manualChange(base, "cadastralValue", "326576186.2", { title: "Карта НСПД" }), AT);
    const r = mosdata.applyCityPlots(own, mosdata.cityPlotsAt(PLOTS, P), AT);
    expect(r.project.plot.cadastralValue).toMatchObject({ value: "326576186.2", origin: "expert" });
    expect(r.problems.some((t) => t.startsWith("Оценка кадастровой стоимости отмеченных участков 418 443 713 руб больше введённой 326 576 186 руб"))).toBe(true);
  });
});

describe("здания под снос: адресный реестр Москвы (60562) и этажность OpenStreetMap", () => {
  const R = { lat: 55.6935, lon: 37.4177 };
  const rect = (lon: number, lat: number) => [[[lon, lat], [lon + 0.0002, lat], [lon + 0.0002, lat + 0.0001], [lon, lat + 0.0001], [lon, lat]]];
  /** Поля — как в ответе портала 18.11.2026 (Рябиновая ул., 28А); границы — прямоугольники для проверки площади. */
  const bld = (n: string, unom: number, lon: number, lat: number, house = "28А", street = "Рябиновая улица") => ({
    geometry: { type: "MultiPolygon", coordinates: [rect(lon, lat)] },
    properties: { attributes: { UNOM: unom, OBJ_TYPE_PUBLIC: "здание", SIMPLE_ADDRESS: `${street}, дом ${house}, строение ${n}`, P7: street, L1_VALUE: house, L2_VALUE: "", L3_VALUE: n, KAD_N: [{ is_deleted: 0, KAD_N: `77:07:0012004:11${n}` }], KAD_ZU: [{ is_deleted: 0, KAD_ZU: "77:07:0012004:10" }] } },
  });
  const BUILDINGS = { features: [bld("2", 2119250, R.lon + 0.001, R.lat), bld("1", 3100754, R.lon - 0.0001, R.lat - 0.00005), bld("10", 2119258, R.lon + 0.0005, R.lat), bld("5", 999, R.lon - 0.001, R.lat, "30", "Рябиновая улица")] };
  const OSM = { elements: [{ id: 184735411, center: { lat: R.lat + 0.00005, lon: R.lon + 0.0011 }, tags: { "building:levels": "2" } }, { id: 1, center: { lat: 0, lon: 0 }, tags: { "building:levels": "этаж" } }] };
  const ryab = () => {
    const p = { ...make(), geo: { query: "q", label: "28А с1, Рябиновая улица, район Очаково-Матвеевское, Москва, Россия", point: R, regionCode: "77", locality: [], house: true, fetchedAt: AT } };
    return mosdata.applyMosLookup(p, mosdata.mosLookup(R, { plots: { features: [] }, buildings: BUILDINGS, osm: OSM }, AT), AT).project;
  };

  it("площадь контура в м²: 0,0002° × 0,0001° на широте 55,69° ≈ 139 м²", () => {
    const list = mosdata.buildingsAt(BUILDINGS, OSM, R);
    expect(list.find((b) => b.unom === "3100754")?.footprint).toBe("139");
  });

  it("здания одного дома, по номеру строения; этажность — у здания OpenStreetMap внутри контура; чужой дом отброшен", () => {
    const p = ryab();
    const list = p.mos?.buildings ?? [];
    expect(list.map((b) => b.address)).toEqual(["Рябиновая улица, дом 28А, строение 1", "Рябиновая улица, дом 28А, строение 2", "Рябиновая улица, дом 28А, строение 10"]);
    expect(list[0]).toMatchObject({ atPoint: true, levels: null, cadastralNumber: "77:07:0012004:111", plotNumbers: ["77:07:0012004:10"] });
    expect(list[1]).toMatchObject({ levels: 2, levelsUrl: "https://www.openstreetmap.org/way/184735411" });
    expect(mosdata.buildingMapUrl(list[0] as mosdata.CityBuilding)).toBe(`https://yandex.ru/maps/?text=${encodeURIComponent("Москва, Рябиновая улица, дом 28А, строение 1")}`);
    expect(mosdata.buildingText(list[1] as mosdata.CityBuilding)).toBe("Рябиновая улица, дом 28А, строение 2, контур 139 м², 2 эт. по OpenStreetMap");
  });

  it("отмеченные здания: контур × этажность, сумма — оценка с источником; отметки запоминаются", () => {
    const p = ryab();
    expect(mosdata.applyDemolitionPick(p, [], AT)).toEqual({ error: "Отметьте хотя бы одно здание." });
    expect(mosdata.applyDemolitionPick(p, [{ unom: "3100754", levels: 0 }], AT)).toMatchObject({ error: expect.stringMatching(/^Введите этажность здания «Рябиновая улица, дом 28А, строение 1»/) });
    const r = mosdata.applyDemolitionPick(p, [{ unom: "3100754", levels: 3 }, { unom: "2119250", levels: 2 }], AT);
    if ("error" in r) throw new Error(r.error);
    const v = site.siteValue(r.project, "demolitionGfa");
    expect(v.value).toBe("695");
    expect(v.origin).toBe("estimate");
    expect(v.basis?.url).toBe("https://data.mos.ru/opendata/60562");
    expect(v.basis?.note).toMatch(/^Рябиновая улица, дом 28А, строение 1: 139 м² × 3 эт\. = 417 м² \(этажность введена\); Рябиновая улица, дом 28А, строение 2: 139 м² × 2 эт\. = 278 м² \(этажность по OpenStreetMap\)\. Итого 695 м²/);
    expect(site.siteOf(r.project).demolitionPick).toEqual([{ unom: "3100754", levels: 3 }, { unom: "2119250", levels: 2 }]);
  });

  it("запрос этажности — в окне запроса к порталу; ответ без зданий — пусто", () => {
    expect(mosdata.osmLevelsQuery(P)).toBe('[out:json][timeout:25];way[building]["building:levels"](55.755560,37.651730,55.759560,37.655730);out tags center;');
    expect(mosdata.buildingsAt(null, null, P)).toEqual([]);
  });
});
