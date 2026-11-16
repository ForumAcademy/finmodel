import { describe, expect, it } from "vitest";
import { geocode, plot } from "../src";

const AT = "2026-11-16T13:00:00.000Z";
const form = (over: Partial<plot.NewProjectForm> = {}): plot.NewProjectForm => ({
  cadastralNumber: "",
  name: "",
  area: "3410",
  address: "Лялин переулок, 21 с.2",
  point: null,
  regionCode: "77",
  egrn: null,
  documents: [],
  ...over,
});
const make = (over: Partial<plot.NewProjectForm> = {}) => plot.createProject(form(over), "p1", AT).project as plot.LandProject;

/** Ответ Nominatim в том виде, в каком он приходит (jsonv2, addressdetails=1); значения — для проверки разбора. */
const LYALIN = [
  {
    lat: "55.7601",
    lon: "37.6543",
    category: "building",
    type: "yes",
    display_name: "21 строение 2, Лялин переулок, Басманный район, Москва, Центральный административный округ, Москва, Россия",
    address: { house_number: "21 строение 2", road: "Лялин переулок", suburb: "Басманный район", city_district: "Центральный административный округ", city: "Москва", state: "Москва", "ISO3166-2-lvl4": "RU-MOW", country: "Россия" },
  },
  {
    lat: "55.76",
    lon: "37.65",
    category: "highway",
    type: "residential",
    display_name: "Лялин переулок, Басманный район, Москва, Россия",
    address: { road: "Лялин переулок", suburb: "Басманный район", city: "Москва", state: "Москва" },
  },
  { lat: "59.9", lon: "30.3", category: "building", type: "house", display_name: "Санкт-Петербург", address: { house_number: "1", state: "Санкт-Петербург" } },
];

describe("поиск участка по адресу", () => {
  it("варианты запроса: как введён, без строения; регион добавляется, если его нет в адресе", () => {
    expect(geocode.geocodeQueries("Лялин переулок, 21 с.2", "77")).toEqual(["Москва, Лялин переулок, 21 с.2", "Москва, Лялин переулок, 21"]);
    expect(geocode.geocodeQueries("г. Москва, Лялин пер., 21 стр. 2", "77")).toEqual(["г. Москва, Лялин пер., 21 стр. 2", "г. Москва, Лялин пер., 21"]);
    expect(geocode.geocodeQueries("Москва, Тверская, 7", null)).toEqual(["Москва, Тверская, 7"]);
    expect(geocode.geocodeQueries("  ", "77")).toEqual([]);
  });

  it("адрес запроса — только Россия, по-русски, с частями адреса", () => {
    const u = new URL(geocode.geocodeUrl("Москва, Лялин переулок, 21"));
    expect(u.host).toBe("nominatim.openstreetmap.org");
    expect(u.searchParams.get("countrycodes")).toBe("ru");
    expect(u.searchParams.get("addressdetails")).toBe("1");
    expect(u.searchParams.get("q")).toBe("Москва, Лялин переулок, 21");
  });

  it("разбор ответа: регион, округ и район, дом; чужие регионы отбрасываются", () => {
    const all = geocode.parseGeocode(LYALIN);
    expect(all).toHaveLength(3);
    expect(all[0]).toMatchObject({ regionCode: "77", house: true, locality: ["Центральный административный округ", "Басманный район"] });
    expect(all[1]?.house).toBe(false);
    const ok = geocode.usableCandidates(all);
    expect(ok.map((c) => c.house)).toEqual([true, false]);
    expect(geocode.parseGeocode({ error: "x" })).toEqual([]);
  });

  it("регион, совпавший с введённым, получает метку «из источника»; точка ставится; место сохраняется", () => {
    const p = make();
    expect(p.plot.regionCode.origin).toBe("expert");
    const c = geocode.usableCandidates(geocode.parseGeocode(LYALIN))[0] as geocode.GeoCandidate;
    const r = geocode.applyGeocode(p, c, "Москва, Лялин переулок, 21 с.2", AT);
    expect(r.problems).toEqual([]);
    expect(r.project.plot.regionCode).toMatchObject({ value: "77", origin: "source" });
    expect(r.project.plot.regionCode.basis?.url).toBe("https://nominatim.openstreetmap.org/");
    expect(r.project.point).toEqual({ lat: 55.7601, lon: 37.6543 });
    expect(r.project.geo?.locality).toEqual(["Центральный административный округ", "Басманный район"]);
    expect(r.project.history.map((h) => h.field)).toEqual(["regionCode"]);
    expect(geocode.geoText(r.project.geo as geocode.GeoLookup)).toBe("Центральный административный округ, Басманный район. Найдено по адресу 16.11.2026");
  });

  it("точку, поставленную вручную, не трогает; повторный поиск двигает свою точку", () => {
    const own = { lat: 55.1, lon: 37.1 };
    const c = geocode.parseGeocode(LYALIN)[0] as geocode.GeoCandidate;
    expect(geocode.applyGeocode(make({ point: own }), c, "q", AT).project.point).toEqual(own);
    const first = geocode.applyGeocode(make(), c, "q", AT).project;
    const moved = { ...c, point: { lat: 55.2, lon: 37.2 } };
    expect(geocode.applyGeocode(first, moved, "q", AT).project.point).toEqual({ lat: 55.2, lon: 37.2 });
  });

  it("другой регион не перезаписывается — сообщение; улица вместо дома — предупреждение", () => {
    const p = make({ regionCode: "50" });
    const c = geocode.parseGeocode(LYALIN)[1] as geocode.GeoCandidate;
    const r = geocode.applyGeocode(p, c, "q", AT);
    expect(r.project.plot.regionCode.value).toBe("50");
    expect(r.changes).toEqual([]);
    expect(r.problems).toHaveLength(2);
  });
});
