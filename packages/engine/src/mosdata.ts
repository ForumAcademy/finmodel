/**
 * Данные портала открытых данных Москвы (data.mos.ru, источник S_MOS_OPENDATA) по точке участка: городские
 * земельные участки (набор 1497), зоны охраны (613) и территории (614) объектов культурного наследия, здания
 * адресного реестра (60562) — для площади под снос; этажность зданий — OpenStreetMap (S_OSM_BUILDINGS).
 * Запрос идёт с сервера сайта по ключу (apps/web/app/api/mosdata); здесь — разбор ответа, проверка «точка внутри
 * границы» и изменения проекта.
 */
import Decimal from "decimal.js";
import { getRegion, getSource, type RegionCode } from "@fm/spec";
import { upksFor } from "./modules/land";
import { date as fmtDate, num } from "./lib/text";
import { applyChanges, cadastralQuarter, plotField, vriCodes, normalizeCadastralNumber, parseNumberRu, type ChangeSet, type GeoPoint, type LandProject, type PlotChange, type PlotFieldKey, type PlotValue, type ValueBasis } from "./plot";
import { applySiteChange, siteOf, siteValue, updateSite, type ZouitEntry } from "./site";

export const MOS_SOURCE = "S_MOS_OPENDATA" as const;

/** Наборы портала, которые читает сервис. */
export const MOS_DATASETS = { plots: 1497, zones: 613, territories: 614, buildings: 60562 } as const;
export type MosDatasetKey = keyof typeof MOS_DATASETS;

/** Страница набора на портале — ссылка в основании значения. */
export const datasetUrl = (key: MosDatasetKey): string => `https://data.mos.ru/opendata/${MOS_DATASETS[key]}`;

/** Полуширина окна запроса вокруг точки, градусы (~200–300 м): границы, которые содержат точку, в него попадают. */
export const BBOX_HALF_DEG = 0.002;

/** Окно запроса «lon1,lat1,lon2,lat2» вокруг точки. */
export function bbox(p: GeoPoint): string {
  return [p.lon - BBOX_HALF_DEG, p.lat - BBOX_HALF_DEG, p.lon + BBOX_HALF_DEG, p.lat + BBOX_HALF_DEG].map((x) => x.toFixed(6)).join(",");
}

/** Адрес запроса к API портала (без ключа: ключ добавляет сервер). */
export function featuresPath(key: MosDatasetKey, p: GeoPoint): string {
  return `/v1/datasets/${MOS_DATASETS[key]}/features?bbox=${bbox(p)}`;
}

// ---------- разбор ответа ----------

/**
 * Поля объекта портал отдаёт строкой в записи Python: «{'ID': 1, 'Name': 'Дом', 'X': None}». Разбор: словари,
 * списки, строки в одинарных и двойных кавычках, числа, None/True/False. Непонятная строка — null.
 */
export function parsePyLiteral(text: string): unknown {
  let i = 0;
  const s = text;
  const ws = () => {
    while (i < s.length && /\s/.test(s[i] as string)) i++;
  };
  const value = (): unknown => {
    ws();
    const c = s[i];
    if (c === "{") {
      i++;
      const o: Record<string, unknown> = {};
      ws();
      if (s[i] === "}") return i++, o;
      for (;;) {
        const k = value();
        ws();
        if (s[i++] !== ":") throw new Error("ожидалось «:»");
        o[String(k)] = value();
        ws();
        const d = s[i++];
        if (d === "}") return o;
        if (d !== ",") throw new Error("ожидалось «,»");
      }
    }
    if (c === "[" || c === "(") {
      const end = c === "[" ? "]" : ")";
      i++;
      const a: unknown[] = [];
      ws();
      if (s[i] === end) return i++, a;
      for (;;) {
        a.push(value());
        ws();
        const d = s[i++];
        if (d === end) return a;
        if (d !== ",") throw new Error("ожидалось «,»");
        ws();
        if (s[i] === end) return i++, a;
      }
    }
    if (c === "'" || c === '"') {
      i++;
      let out = "";
      while (i < s.length && s[i] !== c) {
        if (s[i] === "\\") {
          const n = s[i + 1];
          out += n === "n" ? "\n" : n === "t" ? "\t" : (n ?? "");
          i += 2;
        } else out += s[i++];
      }
      i++;
      return out;
    }
    const m = /^(None|True|False|-?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?)/.exec(s.slice(i));
    if (!m) throw new Error("непонятное значение");
    i += (m[1] as string).length;
    return m[1] === "None" ? null : m[1] === "True" ? true : m[1] === "False" ? false : Number(m[1]);
  };
  try {
    const v = value();
    return v;
  } catch {
    return null;
  }
}

type Ring = [number, number][];
/** Граница: многоугольники, у каждого — внешний контур и дыры. */
type Polygons = Ring[][];

export interface MosFeature {
  attrs: Record<string, unknown>;
  polygons: Polygons;
}

const isRing = (r: unknown): r is Ring => Array.isArray(r) && r.every((pt) => Array.isArray(pt) && typeof pt[0] === "number" && typeof pt[1] === "number");

function polygonsOf(g: unknown): Polygons {
  const geom = g as { type?: unknown; coordinates?: unknown } | null;
  if (!geom || !Array.isArray(geom.coordinates)) return [];
  const polys = geom.type === "Polygon" ? [geom.coordinates] : geom.type === "MultiPolygon" ? (geom.coordinates as unknown[]) : [];
  return polys.filter((p): p is Ring[] => Array.isArray(p) && p.every(isRing));
}

/** Объекты из ответа портала (GeoJSON): поля и граница. Непонятный ответ — пустой список. */
export function parseFeatures(json: unknown): MosFeature[] {
  const list = (json as { features?: unknown } | null)?.features;
  if (!Array.isArray(list)) return [];
  return list.map((f) => {
    const props = (f as { properties?: Record<string, unknown> } | null)?.properties ?? {};
    const raw = props.attributes ?? props.Attributes ?? null;
    const parsed = typeof raw === "string" ? parsePyLiteral(raw) : raw;
    const attrs = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
    return { attrs, polygons: polygonsOf((f as { geometry?: unknown } | null)?.geometry) };
  });
}

/** Точка внутри контура (луч вправо, чётность пересечений). */
function inRing(p: GeoPoint, ring: Ring): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i] as [number, number];
    const [xj, yj] = ring[j] as [number, number];
    if (yi > p.lat !== yj > p.lat && p.lon < ((xj - xi) * (p.lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Точка внутри границы объекта: во внешнем контуре одного из многоугольников и не в его дыре. */
export function contains(f: MosFeature, p: GeoPoint): boolean {
  return f.polygons.some(([outer, ...holes]) => outer !== undefined && inRing(p, outer) && !holes.some((h) => inRing(p, h)));
}

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim().replace(/\s+/g, " ") : typeof v === "number" ? String(v) : null);

// ---------- городские участки (набор 1497) ----------

/** Участок из реестра земель города Москвы. */
export interface CityPlot {
  cadastralNumber: string;
  /** Адрес, как в реестре. */
  address: string | null;
  /** Площадь, м², строка. */
  area: string | null;
  /** Форма собственности: «собственность города Москвы», «неразграниченная собственность». */
  ownerType: string | null;
  /** Участок сдан в аренду; null — не указано. */
  rented: boolean | null;
  /** Вид разрешённого использования, как в реестре: «деловое управление (4.1)». */
  vri: string | null;
}

function cityPlot(f: MosFeature): CityPlot | null {
  const kn = normalizeCadastralNumber(str(f.attrs.CadastralNumber) ?? "");
  if (!kn) return null;
  const rent = str(f.attrs.RentalStatus)?.toLowerCase() ?? null;
  return {
    cadastralNumber: kn,
    address: str(f.attrs.Location)?.replace(/^\(|\)$/g, "") ?? null,
    area: parseNumberRu(str(f.attrs.FieldArea) ?? ""),
    ownerType: str(f.attrs.OwnerType),
    rented: rent === "да" ? true : rent === "нет" ? false : null,
    vri: str(f.attrs.PermittedUse),
  };
}

/** Городские участки, в границах которых лежит точка; крупные — первыми, одинаковые номера — один раз. */
export function cityPlotsAt(json: unknown, p: GeoPoint): CityPlot[] {
  const out = parseFeatures(json)
    .filter((f) => contains(f, p))
    .map(cityPlot)
    .filter((c): c is CityPlot => c !== null);
  const uniq = out.filter((c, i) => out.findIndex((x) => x.cadastralNumber === c.cadastralNumber) === i);
  return uniq.sort((a, b) => Number(b.area ?? 0) - Number(a.area ?? 0));
}

/** Строка участка для выбора: номер, площадь, вид использования, аренда. */
export function cityPlotText(c: CityPlot): string {
  const parts = [c.cadastralNumber];
  if (c.area) parts.push(`${num(c.area, 0)} м²`);
  if (c.vri) parts.push(c.vri);
  if (c.rented !== null) parts.push(c.rented ? "сдан в аренду" : "в аренду не сдан");
  return parts.join(", ");
}

// ---------- здания адресного реестра (набор 60562) — площадь под снос ----------

export const OSM_BUILDINGS_SOURCE = "S_OSM_BUILDINGS" as const;

/** Здание из адресного реестра объектов недвижимости Москвы. */
export interface CityBuilding {
  /** Номер здания в реестре (УНОМ). */
  unom: string;
  /** Адрес, как в реестре: «Рябиновая улица, дом 28А, строение 1». */
  address: string;
  /** Улица и дом без корпуса и строения — для сравнения с адресом проекта. */
  street: string | null;
  house: string | null;
  /** Кадастровый номер здания (если есть в реестре). */
  cadastralNumber: string | null;
  /** Участки, на которых стоит здание, по реестру. */
  plotNumbers: string[];
  /** Площадь контура здания на земле, м², по границе в реестре; null — границы нет. */
  footprint: string | null;
  /** Этажность по OpenStreetMap; null — не указана. */
  levels: number | null;
  /** Здание на карте OpenStreetMap, откуда этажность. */
  levelsUrl: string | null;
  /** Точка участка внутри контура здания. */
  atPoint: boolean;
}

/** Средний радиус Земли, м (IUGG, как в WGS 84): перевод градусов контура в метры для площади. */
const EARTH_RADIUS_M = 6371008.8;
const RAD = Math.PI / 180;

/** Площадь контура в м²: градусы → метры около широты контура (для зданий ошибка меньше 0,1 %), формула площади Гаусса. */
function ringArea(ring: Ring, lat0: number): number {
  const k = Math.cos(lat0 * RAD);
  let s = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i] as [number, number];
    const [xj, yj] = ring[j] as [number, number];
    s += xj * k * yi - xi * k * yj;
  }
  return (Math.abs(s) / 2) * (EARTH_RADIUS_M * RAD) ** 2;
}

/** Площадь границы объекта, м²: внешние контуры минус дыры; границы нет — null. */
export function footprintArea(f: MosFeature): number | null {
  const first = f.polygons[0]?.[0]?.[0];
  if (!first) return null;
  const lat0 = first[1];
  return f.polygons.reduce((sum, [outer, ...holes]) => sum + (outer ? ringArea(outer, lat0) : 0) - holes.reduce((h, r) => h + ringArea(r, lat0), 0), 0);
}

const listOf = (v: unknown, key: string): string[] =>
  Array.isArray(v) ? v.filter((x) => x && typeof x === "object" && (x as Record<string, unknown>).is_deleted !== 1).map((x) => str((x as Record<string, unknown>)[key])).filter((x): x is string => x !== null) : [];

/** Здания OpenStreetMap с этажностью: центр и число этажей (тег building:levels). */
export function osmLevels(json: unknown): { id: number; center: GeoPoint; levels: number }[] {
  const list = (json as { elements?: unknown } | null)?.elements;
  if (!Array.isArray(list)) return [];
  const out: { id: number; center: GeoPoint; levels: number }[] = [];
  for (const e of list as { id?: unknown; center?: { lat?: unknown; lon?: unknown }; tags?: Record<string, unknown> }[]) {
    const lv = String(e?.tags?.["building:levels"] ?? "").trim();
    const lat = Number(e?.center?.lat);
    const lon = Number(e?.center?.lon);
    if (!/^\d+$/.test(lv) || Number(lv) < 1 || !Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    out.push({ id: Number(e.id), center: { lat, lon }, levels: Number(lv) });
  }
  return out;
}

/** Адрес запроса этажности зданий к OpenStreetMap (Overpass): здания с этажностью в том же окне, что и запрос к порталу. */
export function osmLevelsQuery(p: GeoPoint): string {
  const [w, s, e, n] = bbox(p).split(",");
  return `[out:json][timeout:25];way[building]["building:levels"](${s},${w},${n},${e});out tags center;`;
}

/** Здания реестра из ответа портала; этажность — у здания OpenStreetMap, чей центр внутри контура. По адресу. */
export function buildingsAt(json: unknown, osm: unknown, p: GeoPoint): CityBuilding[] {
  const levels = osmLevels(osm);
  const out: CityBuilding[] = [];
  for (const f of parseFeatures(json)) {
    const a = f.attrs;
    const unom = str(a.UNOM);
    const address = str(a.SIMPLE_ADDRESS) ?? str(a.ADDRESS);
    if (!unom || !address || out.some((b) => b.unom === unom)) continue;
    const area = footprintArea(f);
    const osmHit = levels.find((l) => contains(f, l.center));
    const kn = listOf(a.KAD_N, "KAD_N").map((x) => normalizeCadastralNumber(x)).filter((x): x is string => Boolean(x));
    const housePart = [str(a.L1_VALUE), a.L2_VALUE ? `к${str(a.L2_VALUE)}` : null].filter(Boolean).join(" ");
    out.push({
      unom,
      address,
      street: str(a.P7),
      house: housePart || null,
      cadastralNumber: kn[0] ?? null,
      plotNumbers: listOf(a.KAD_ZU, "KAD_ZU").map((x) => normalizeCadastralNumber(x)).filter((x): x is string => Boolean(x)),
      footprint: area && area > 0 ? String(Math.round(area)) : null,
      levels: osmHit?.levels ?? null,
      levelsUrl: osmHit ? `https://www.openstreetmap.org/way/${osmHit.id}` : null,
      atPoint: contains(f, p),
    });
  }
  return out.sort((x, y) => x.address.localeCompare(y.address, "ru", { numeric: true }));
}

const norm = (s: string | null | undefined): string => (s ?? "").toLowerCase().replace(/ё/g, "е").replace(/[\s.,]+/g, "");

/** Улица и дом найденного по адресу места: «28А с1, Рябиновая улица, …» → дом «28А», улица «Рябиновая улица». */
function houseOfLabel(label: string | undefined): { house: string; street: string } | null {
  const [head, street] = (label ?? "").split(",").map((x) => x.trim());
  if (!head || !street || !/^\d/.test(head)) return null;
  return { house: head.replace(/\s+(?:с|стр)\.?\s*\d+[а-яa-z]?$/i, ""), street };
}

/**
 * Здания участка: на участках проекта или городских участках в точке (по реестру), в том же доме, что адрес проекта
 * (все строения), или здание, в котором стоит точка участка.
 */
export function projectBuildings(p: LandProject, m: MosLookup): CityBuilding[] {
  const plots = new Set([...cadastralNumbers(p.plot.cadastralNumber.value), ...m.plots.map((c) => c.cadastralNumber)]);
  const h = houseOfLabel(p.geo?.label);
  return (m.buildings ?? []).filter((b) => b.atPoint || b.plotNumbers.some((n) => plots.has(n)) || (h !== null && norm(b.house) === norm(h.house) && norm(b.street) === norm(h.street)));
}

/** Строка здания для выбора: адрес, контур, этажность и откуда она. */
export function buildingText(b: CityBuilding): string {
  const parts = [b.address];
  parts.push(b.footprint ? `контур ${num(b.footprint, 0)} м²` : "контура в реестре нет");
  if (b.levels !== null) parts.push(`${b.levels} эт. по OpenStreetMap`);
  return parts.join(", ");
}

/** Отмеченное здание и его этажность (из OpenStreetMap или введённая). */
export interface BuildingPick {
  unom: string;
  levels: number;
}

/** Площадь зданий под снос: контур × этажность по каждому, сумма. Здания без контура — в ошибках. */
export function demolitionEstimate(list: readonly CityBuilding[], picks: readonly BuildingPick[]): { value: Decimal; note: string } | { error: string } {
  if (!picks.length) return { error: "Отметьте хотя бы одно здание." };
  const rows: string[] = [];
  let sum = new Decimal(0);
  for (const pk of picks) {
    const b = list.find((x) => x.unom === pk.unom);
    if (!b) return { error: "Отмеченного здания нет в данных Москвы. Обновите данные." };
    if (!b.footprint) return { error: `У здания «${b.address}» нет контура в реестре: площадь не посчитать. Введите площадь вручную.` };
    if (!Number.isInteger(pk.levels) || pk.levels < 1) return { error: `Введите этажность здания «${b.address}»: целое число этажей, от 1.` };
    const area = new Decimal(b.footprint).mul(pk.levels);
    sum = sum.plus(area);
    const lv = b.levels === pk.levels && b.levelsUrl ? "этажность по OpenStreetMap" : "этажность введена";
    rows.push(`${b.address}: ${num(b.footprint, 0)} м² × ${pk.levels} эт. = ${num(area, 0)} м² (${lv})`);
  }
  return { value: sum, note: `${rows.join("; ")}. Итого ${num(sum, 0)} м²` };
}

/**
 * Площадь зданий под снос из отмеченных зданий — оценка: площадь контура здания по границе в адресном реестре Москвы ×
 * этажность (OpenStreetMap или введена). Отметки запоминаются, чтобы показать их снова.
 */
export function applyDemolitionPick(p: LandProject, picks: readonly BuildingPick[], at: string): { project: LandProject } | { error: string } {
  const list = p.mos ? projectBuildings(p, p.mos) : [];
  const e = demolitionEstimate(list, picks);
  if ("error" in e) return e;
  const osm = picks.some((pk) => list.find((b) => b.unom === pk.unom)?.levelsUrl);
  const to: PlotValue = {
    value: e.value.toDecimalPlaces(2).toString(),
    origin: "estimate",
    basis: {
      title: `Оценка: контур здания × этажность. Контуры — ${getSource(MOS_SOURCE).title.split(" — ")[0]}, набор ${MOS_DATASETS.buildings}${osm ? "; этажность — OpenStreetMap" : ""}`,
      url: datasetUrl("buildings"),
      date: at.slice(0, 10),
      note: `${e.note}. Площадь по контуру на земле больше площади помещений из техпаспорта на толщину стен; замените площадью из техпаспорта или выписки ЕГРН, когда они будут`,
    },
  };
  const c = { field: "demolitionGfa" as const, from: siteValue(p, "demolitionGfa"), to };
  const next = applySiteChange(p, c, at);
  return { project: updateSite(next, { demolitionPick: [...picks] }, at) };
}

/** Что нашлось на портале Москвы по точке; хранится в проекте. */
export interface MosLookup {
  point: GeoPoint;
  plots: CityPlot[];
  /** Здания адресного реестра у участка; нет поля — проект найден до 18.11.2026, нужно обновить данные Москвы. */
  buildings?: CityBuilding[];
  /** Зоны охраны объектов культурного наследия, в которых лежит точка. */
  zones: string[];
  /** Территории объектов культурного наследия, в которых лежит точка. */
  territories: string[];
  /** Когда найдено, ISO. */
  fetchedAt: string;
}

/** Названия объектов, в границах которых лежит точка, без повторов. */
function namesAt(json: unknown, p: GeoPoint): string[] {
  const names = parseFeatures(json)
    .filter((f) => contains(f, p))
    .map((f) => str(f.attrs.ObjectNameOnDoc) ?? str(f.attrs.ObjectName))
    .filter((n): n is string => n !== null);
  return [...new Set(names)];
}

/** Разбор ответов портала по точке; osm — ответ OpenStreetMap с этажностью зданий (нет — этажность вводится). */
export function mosLookup(p: GeoPoint, raw: Partial<Record<MosDatasetKey, unknown>> & { osm?: unknown }, at: string): MosLookup {
  return { point: p, plots: cityPlotsAt(raw.plots, p), buildings: buildingsAt(raw.buildings, raw.osm, p), zones: namesAt(raw.zones, p), territories: namesAt(raw.territories, p), fetchedAt: at };
}

export function mosBasis(key: MosDatasetKey, at: string, note: string): ValueBasis {
  const s = getSource(MOS_SOURCE);
  return { title: `${s.title.split(" — ")[0]}, набор ${MOS_DATASETS[key]}`, url: datasetUrl(key), date: at.slice(0, 10), note };
}

/** Строка «Данные Москвы» для экрана; выбранные участки — список или один. */
export function mosText(m: MosLookup, chosen: readonly CityPlot[] | CityPlot | null = null): string {
  const list = chosen === null ? [] : Array.isArray(chosen) ? chosen : [chosen as CityPlot];
  const total = list.reduce((s, c) => s.plus(c.area ?? 0), new Decimal(0));
  const plots =
    list.length > 1
      ? `Участки: ${list.map((c) => cityPlotText(c)).join("; ")}. Всего ${num(total, 0)} м²`
      : list.length === 1
        ? `Участок ${cityPlotText(list[0] as CityPlot)}`
        : m.plots.length
          ? `Городских участков в этой точке: ${m.plots.length}`
          : "Городских участков в этой точке нет";
  const heritage = m.zones.length || m.territories.length ? `, участок в зоне охраны памятников` : "";
  return `${plots}${heritage}. Портал открытых данных Москвы, ${fmtDate(m.fetchedAt.slice(0, 10))}.`;
}

/** Номера участков в поле «Кадастровый номер»: один или несколько через запятую. */
export const cadastralNumbers = (v: string | null): string[] => (v ? v.split(/[,;]\s*/).map((x) => x.trim()).filter(Boolean) : []);

/** Выбранные в проекте городские участки: те, чьи номера стоят в проекте (крупный первым). */
export const chosenCityPlots = (m: MosLookup, cadastralNumber: string | null): CityPlot[] => {
  const nums = cadastralNumbers(cadastralNumber);
  return m.plots.filter((c) => nums.includes(c.cadastralNumber));
};

/** Выбранный городской участок, если он один; иначе null. */
export const chosenCityPlot = (m: MosLookup, cadastralNumber: string | null): CityPlot | null => {
  const list = chosenCityPlots(m, cadastralNumber);
  return list.length === 1 ? (list[0] as CityPlot) : null;
};

/** Городская земля: собственность города или неразграниченная. */
export const isCityLand = (c: CityPlot): boolean => /город|неразграничен/i.test(c.ownerType ?? "");

/** Форма права для городской земли: участок под строительство предоставляется в аренду на торгах (ст. 39.6 ЗК РФ). */
export const CITY_LAND_TENURE = "аренда";

/**
 * Взять данные городского участка: номер, квартал, вид использования — «из источника»; форма права для городской
 * земли — оценка «аренда». Значения из документа проекта и введённые вручную не меняются. Площадь одного участка
 * не меняется: если она отличается от проекта — сообщение.
 */
export function applyCityPlot(p: LandProject, c: CityPlot, at: string): ChangeSet & { project: LandProject } {
  return applyCityPlots(p, [c], at);
}

/**
 * Взять данные одного или нескольких городских участков. Несколько — участки складываются: номера через запятую,
 * площадь — сумма площадей из реестра (заменяет введённую: финансист сам отметил участки), вид использования — все
 * разные виды; квартал — общий, а если участки в разных кварталах — квартал крупного участка (для оценки после
 * смены вида использования).
 */
export function applyCityPlots(p: LandProject, picked: readonly CityPlot[], at: string): ChangeSet & { project: LandProject } {
  const changes: PlotChange[] = [];
  const problems: string[] = [];
  if (!picked.length) return { project: p, changes, problems };
  const list = [...picked].sort((a, b) => Number(b.area ?? 0) - Number(a.area ?? 0));
  const many = list.length > 1;
  const first = list[0] as CityPlot;
  const note = many ? `Участки ${list.map((c) => c.cadastralNumber).join(", ")}` : `Участок ${first.cadastralNumber}${first.address ? `, ${first.address}` : ""}`;
  const put = (field: PlotFieldKey, value: string | null, origin: "source" | "estimate", extra?: string, own?: string, force = false) => {
    if (value === null) return;
    const cur = p.plot[field];
    if (cur.origin === "source" && cur.basis?.documentId) return;
    // Введено вручную и отличается от портала — остаётся введённое, финансист получает сообщение
    if (!force && cur.origin === "expert" && cur.value !== null && cur.value !== value) {
      problems.push(`${plotField(field).label}: на портале Москвы «${value}», в проекте введено «${cur.value}». Оставлено введённое; чтобы взять значение портала, очистите поле.`);
      return;
    }
    const to: PlotValue = { value, origin, basis: mosBasis("plots", at, own ?? (extra ? `${note}. ${extra}` : note)) };
    if (cur.value === to.value && cur.origin === to.origin && cur.basis?.url === to.basis?.url && cur.basis?.note === to.basis?.note) return;
    changes.push({ field, from: cur, to });
  };
  put("cadastralNumber", list.map((c) => c.cadastralNumber).join(", "), "source");
  const quarters = [...new Set(list.map((c) => cadastralQuarter(c.cadastralNumber)).filter((q): q is string => q !== null))];
  // Квартал — первая часть номера того же участка; адрес не повторяется, чтобы не читалось как второй участок
  const qNote = quarters.length > 1 ? `Участки в разных кварталах (${quarters.join(", ")}); взят квартал крупного участка ${first.cadastralNumber}` : `Первая часть кадастрового номера ${many ? "участков" : "участка"} ${list.map((c) => c.cadastralNumber).join(", ")}`;
  put("quarter", cadastralQuarter(first.cadastralNumber), "source", undefined, qNote);
  const vris = [...new Set(list.map((c) => c.vri).filter((v): v is string => v !== null))];
  put("vri", vris.length ? vris.join("; ") : null, "source");
  const city = list.find(isCityLand);
  if (city) {
    put("tenure", CITY_LAND_TENURE, "estimate", `Земля города (${city.ownerType}${city.rented === true ? ", сейчас сдана в аренду" : ""}): участок под строительство предоставляется в аренду на торгах, ст. 39.6 ЗК РФ`);
  }
  const area = p.plot.area.value;
  if (many) {
    const sum = list.reduce((s, c) => s.plus(c.area ?? 0), new Decimal(0));
    if (area && sum.gt(area)) problems.push(`Площадь отмеченных участков ${num(sum, 0)} м² больше введённой ранее ${num(new Decimal(area), 0)} м². В расчёт взята сумма площадей; проверьте, все ли участки входят в проект.`);
    put("area", sum.toString(), "source", undefined, `Сумма площадей участков из реестра города: ${list.map((c) => num(new Decimal(c.area ?? 0), 0)).join(" + ")} = ${num(sum, 0)} м²`, true);
    const noArea = list.filter((c) => !c.area).map((c) => c.cadastralNumber);
    if (noArea.length) problems.push(`В реестре города нет площади участков ${noArea.join(", ")}: площадь проекта посчитана без них. Проверьте площадь.`);
  } else if (first.area && p.plot.area.origin === "source" && p.plot.area.basis?.url === datasetUrl("plots")) {
    // Площадь была суммой отмеченных участков — теперь участок один, площадь — его
    put("area", first.area, "source", undefined, `Площадь участка ${first.cadastralNumber} из реестра города`);
  } else if (first.area && area && Math.abs(Number(first.area) - Number(area)) >= 1) {
    problems.push(`В реестре города площадь участка ${num(first.area, 0)} м², в проекте — ${num(area, 0)} м². Проверьте площадь: расчёт идёт от площади проекта.`);
  }
  const withPlot = applyChanges(p, changes, at);
  const curValue = withPlot.plot.cadastralValue;
  if (many && curValue.value !== null && curValue.origin !== "estimate") {
    const e = estimateCadastralValue(withPlot, list);
    if (e && e.value.gt(curValue.value)) problems.push(`Оценка кадастровой стоимости отмеченных участков ${num(e.value, 0)} руб больше введённой ${num(new Decimal(curValue.value), 0)} руб. Проверьте, стоимость каких участков введена.`);
  }
  const est = cadastralValueEstimate(withPlot, at, list);
  return { project: applyChanges(withPlot, est, at), changes: [...changes, ...est], problems };
}

/** Зоны охраны и территории памятников в точке — строки зон с особыми условиями (площадь на участке не известна). */
export function heritageZouit(m: MosLookup): ZouitEntry[] {
  const row = (key: "zones" | "territories", name: string, i: number): ZouitEntry => ({
    id: `mos-${MOS_DATASETS[key]}-${i}`,
    name,
    area: null,
    noBuild: false,
    restriction:
      key === "zones"
        ? "Зона охраны объектов культурного наследия: высота, габариты и облик новых зданий — по режиму зоны; для жилья может понадобиться изменение режима"
        : "Территория объекта культурного наследия: новое строительство ограничено режимом территории памятника",
    origin: "source",
    basis: mosBasis(key, m.fetchedAt, "Точка участка внутри границы"),
  });
  return [...m.zones.map((n, i) => row("zones", n, i)), ...m.territories.map((n, i) => row("territories", n, i))];
}

/** Форма права, если городского участка в точке нет: земля, вероятно, частная — покупка в собственность. */
export const PRIVATE_LAND_TENURE = "собственность";

/** Таблица средней кадастровой стоимости 1 м² региона проекта; нет — null. */
function upksTable(p: LandProject) {
  const region = p.plot.regionCode.value;
  if (!region) return null;
  try {
    return getRegion(region as RegionCode).cadastral_value_estimate ?? null;
  } catch {
    return null;
  }
}

/**
 * Оценка кадастровой стоимости: площадь × средний УПКС квартала по группе ВРИ (как F.LAND.CADASTRAL_VALUE_EST).
 * Несколько участков — оценка каждого по его площади, кварталу и ВРИ, затем сумма. Нет данных — null.
 */
export function estimateCadastralValue(p: LandProject, parts: readonly CityPlot[] = []): { value: Decimal; note: string } | null {
  const t = upksTable(p);
  if (!t) return null;
  const one = (area: string | null, quarter: string | null, vri: string | null) => {
    if (!area || !quarter) return null;
    const group = vriCodes(vri).map((c) => t.vri_groups[c]).find((g): g is string => g !== undefined);
    if (!group) return null;
    const u = upksFor(t, quarter, group);
    if (!u) return null;
    const title = t.groups.find((g) => g.key === group)?.title ?? group;
    return { value: new Decimal(area).mul(u.value), note: `${num(area, 0)} м² × ${num(String(u.value), 2)} руб/м² — группа «${title}», ${u.where}` };
  };
  if (parts.length > 1) {
    const rows = parts.map((c) => ({ c, r: one(c.area, cadastralQuarter(c.cadastralNumber), c.vri) }));
    if (rows.some((x) => x.r === null)) return null;
    const value = rows.reduce((sum, x) => sum.plus((x.r as { value: Decimal }).value), new Decimal(0));
    return { value, note: rows.map((x) => `${x.c.cadastralNumber}: ${(x.r as { note: string }).note}`).join("; ") + `. Сумма по ${parts.length} участкам` };
  }
  const quarter = p.plot.quarter.value ?? (p.plot.cadastralNumber.value ? cadastralQuarter(p.plot.cadastralNumber.value) : null);
  return one(p.plot.area.value, quarter, p.plot.vri.value);
}

/**
 * Оценка кадастровой стоимости в данные участка. Меняет только пустое значение или прошлую оценку; нет площади,
 * квартала, ВРИ или таблицы региона — изменений нет. Участки проекта — отмеченные на портале (если их несколько).
 */
export function cadastralValueEstimate(p: LandProject, at: string, parts?: readonly CityPlot[]): PlotChange[] {
  const cur = p.plot.cadastralValue;
  if (cur.value !== null && cur.origin !== "estimate") return [];
  const est = estimateCadastralValue(p, parts ?? (p.mos ? chosenCityPlots(p.mos, p.plot.cadastralNumber.value) : []));
  if (!est) return [];
  const s = getSource("S_MSK_DGI_UPKS_2024");
  const to: PlotValue = {
    value: est.value.toDecimalPlaces(2).toString(),
    origin: "estimate",
    basis: { title: "Оценка по средней кадастровой стоимости 1 м² в квартале, распоряжение ДГИ Москвы № 214856", url: s.url ?? null, date: at.slice(0, 10), note: `${est.note}. Замените стоимостью из выписки ЕГРН, когда она будет` },
  };
  if (cur.value === to.value && cur.origin === "estimate") return [];
  return [{ field: "cadastralValue", from: cur, to }];
}

/** Строки зон из портала Москвы в анализе участка: id начинается с «mos-». */
const isMosZouit = (z: ZouitEntry): boolean => z.id.startsWith("mos-");

/**
 * Сохранить найденное на портале: справка в проекте; зоны охраны памятников — в зонах с особыми условиями (прошлые
 * строки портала заменяются, введённые вручную остаются); единственный городской участок в точке — сразу в данные
 * участка. Несколько участков — финансист выбирает (applyCityPlot).
 */
export function applyMosLookup(p: LandProject, m: MosLookup, at: string): ChangeSet & { project: LandProject } {
  const site = siteOf(p);
  const heritage = heritageZouit(m);
  const own = site.zouit.filter((z) => !isMosZouit(z));
  const sameZones = JSON.stringify(site.zouit.filter(isMosZouit).map((z) => z.name)) === JSON.stringify(heritage.map((z) => z.name));
  const kept: MosLookup = m.buildings ? { ...m, buildings: projectBuildings(p, m) } : m;
  let next: LandProject = { ...p, mos: kept, updatedAt: at };
  if (!sameZones) next = updateSite(next, { zouit: [...own, ...heritage] }, at);
  if (m.plots.length === 1) return applyCityPlot(next, m.plots[0] as CityPlot, at);
  // Участок уже выбран из нескольких — его данные обновляются
  const chosen = chosenCityPlots(m, next.plot.cadastralNumber.value);
  if (chosen.length) return applyCityPlots(next, chosen, at);
  const changes: PlotChange[] = [];
  const t = next.plot.tenure;
  if (m.plots.length === 0 && t.value === null) {
    changes.push({ field: "tenure", from: t, to: { value: PRIVATE_LAND_TENURE, origin: "estimate", basis: mosBasis("plots", at, "В реестре земель города в этой точке участка нет: земля, вероятно, не городская — по умолчанию покупка в собственность") } });
  }
  const withTenure = applyChanges(next, changes, at);
  const est = cadastralValueEstimate(withTenure, at);
  return { project: applyChanges(withTenure, est, at), changes: [...changes, ...est], problems: [] };
}

/**
 * После ручной правки данных участка: если изменён кадастровый номер и он есть среди участков портала — данные этого
 * участка; оценка кадастровой стоимости пересчитывается по новой площади, кварталу и виду использования.
 */
export function afterManualEdit(p: LandProject, fields: readonly PlotFieldKey[], at: string): ChangeSet & { project: LandProject } {
  const list = p.mos && fields.includes("cadastralNumber") ? chosenCityPlots(p.mos, p.plot.cadastralNumber.value) : [];
  if (list.length) return applyCityPlots(p, list, at);
  const est = cadastralValueEstimate(p, at);
  return { project: applyChanges(p, est, at), changes: est, problems: [] };
}
