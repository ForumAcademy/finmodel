import { describe, expect, it } from "vitest";
import { mosdata, plot } from "../src";

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
  });
});
