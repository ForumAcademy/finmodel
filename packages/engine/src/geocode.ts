/**
 * Поиск участка по адресу (геокодер OpenStreetMap Nominatim, источник S_OSM_NOMINATIM): адрес запроса, разбор ответа,
 * регион, округ и район, точка на карте. Запрос идёт с сервера сайта (apps/web/app/api/geocode); здесь — только
 * разбор и изменения проекта, без арифметики.
 */
import { getSource } from "@fm/spec";
import { date as fmtDate } from "./lib/text";
import { applyChanges, PROJECT_REGIONS, regionByAddress, regionName, type ChangeSet, type GeoPoint, type LandProject, type PlotChange, type PlotValue, type ValueBasis } from "./plot";

export const GEOCODER_SOURCE = "S_OSM_NOMINATIM" as const;

/** Сколько вариантов адреса просить у геокодера. */
const LIMIT = 5;

/** Адрес запроса к геокодеру: только Россия, ответ по-русски, с частями адреса. */
export function geocodeUrl(query: string): string {
  const q = new URLSearchParams({ q: query, format: "jsonv2", limit: String(LIMIT), addressdetails: "1", countrycodes: "ru", "accept-language": "ru" });
  return `https://nominatim.openstreetmap.org/search?${q.toString()}`;
}

/** Строение, корпус, владение в конце адреса: «21 с.2», «21 стр. 2», «21к1», «вл. 3». */
const BUILDING = /[\s,]*(?:с\.?|стр\.?|строение|к\.?|корп\.?|корпус|лит\.?|литера)\s*\d+[а-я]?\s*$/i;

/**
 * Варианты запроса по порядку: адрес как введён; без строения и корпуса (их часто нет в OpenStreetMap); с названием
 * региона, если его нет в адресе. Повторы убраны.
 */
export function geocodeQueries(address: string, regionCode: string | null): string[] {
  const a = address.trim().replace(/\s+/g, " ");
  if (!a) return [];
  const region = regionCode ? regionName(regionCode) : null;
  const withRegion = (s: string) => (region && region !== "—" && !s.toLowerCase().includes(region.toLowerCase().replace(/^г\.\s*/, "")) ? `${region.replace(/^г\.\s*/, "")}, ${s}` : s);
  const short = a.replace(BUILDING, "").trim();
  const list = [withRegion(a), withRegion(short)];
  return list.filter((q, i) => q && list.indexOf(q) === i);
}

/** Найденное место. */
export interface GeoCandidate {
  point: GeoPoint;
  /** Адрес, как его записал геокодер. */
  label: string;
  /** Регион, если это Москва или Московская область; иначе null. */
  regionCode: string | null;
  /** Округ, район, поселение, населённый пункт — от крупного к мелкому, без повторов. */
  locality: string[];
  /** Найден дом (а не улица или район). */
  house: boolean;
}

interface NominatimRow {
  lat?: unknown;
  lon?: unknown;
  display_name?: unknown;
  type?: unknown;
  category?: unknown;
  address?: Record<string, unknown>;
}

/** Части адреса OpenStreetMap от крупной к мелкой: округ Москвы или городской округ области, район, населённый пункт. */
const LOCALITY_KEYS = ["city_district", "county", "municipality", "suburb", "city", "town", "village", "hamlet"] as const;

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

/** Разбор ответа геокодера. Непонятный ответ — пустой список. */
export function parseGeocode(json: unknown): GeoCandidate[] {
  if (!Array.isArray(json)) return [];
  const out: GeoCandidate[] = [];
  for (const row of json as NominatimRow[]) {
    const lat = Number(row?.lat);
    const lon = Number(row?.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    const a = row.address ?? {};
    const state = str(a.state);
    const region = state ? regionByAddress(state) : null;
    const locality: string[] = [];
    for (const k of LOCALITY_KEYS) {
      const v = str(a[k]);
      if (v && v !== state && !locality.includes(v)) locality.push(v);
    }
    out.push({
      point: { lat, lon },
      label: str(row.display_name) ?? "",
      regionCode: region?.code ?? null,
      locality,
      house: Boolean(str(a.house_number)) || row.type === "house" || row.category === "building" || row.type === "building",
    });
  }
  return out;
}

/** Места в доступных регионах (Москва, Московская область), дома — первыми. Одинаковые подписи — один раз. */
export function usableCandidates(list: readonly GeoCandidate[]): GeoCandidate[] {
  const ok = list.filter((c) => c.regionCode && PROJECT_REGIONS.some((r) => r.code === c.regionCode));
  const sorted = [...ok.filter((c) => c.house), ...ok.filter((c) => !c.house)];
  return sorted.filter((c, i) => sorted.findIndex((x) => x.label === c.label) === i);
}

/** Что нашлось по адресу; хранится в проекте. */
export interface GeoLookup {
  /** Адрес, по которому искали. */
  query: string;
  /** Адрес, как его записал геокодер. */
  label: string;
  point: GeoPoint;
  regionCode: string | null;
  locality: string[];
  house: boolean;
  /** Когда найдено, ISO. */
  fetchedAt: string;
}

/** Основание найденного значения: геокодер, ссылка на источник, дата, пояснение. */
export function geocodeBasis(found: GeoLookup, note: string): ValueBasis {
  const s = getSource(GEOCODER_SOURCE);
  return { title: "Геокодер OpenStreetMap", url: s.url ?? null, date: found.fetchedAt.slice(0, 10), note };
}

export interface GeocodeResult extends ChangeSet {
  /** Проект с найденным местом, точкой и регионом (если его можно было заполнить). */
  project: LandProject;
}

/**
 * Применить найденное место к проекту:
 * - место сохраняется в проекте; точка на карте ставится, если её не было или она стояла по прошлому поиску;
 * - регион: пустой — заполняется; совпал с введённым — получает метку «из источника»; взят из документа — не меняется;
 *   отличается — не меняется, финансист получает сообщение.
 */
export function applyGeocode(p: LandProject, c: GeoCandidate, query: string, at: string): GeocodeResult {
  const found: GeoLookup = { query, label: c.label, point: c.point, regionCode: c.regionCode, locality: c.locality, house: c.house, fetchedAt: at };
  const problems: string[] = [];
  const changes: PlotChange[] = [];
  const cur = p.plot.regionCode;
  if (c.regionCode) {
    const v: PlotValue = { value: c.regionCode, origin: "source", basis: geocodeBasis(found, `По адресу «${query}»`) };
    const fromDoc = cur.origin === "source" && Boolean(cur.basis?.documentId);
    if (cur.value === null) changes.push({ field: "regionCode", from: cur, to: v });
    else if (cur.value === c.regionCode) {
      if (!fromDoc && cur.origin !== "source") changes.push({ field: "regionCode", from: cur, to: v });
    } else {
      problems.push(`По адресу участок в регионе «${regionName(c.regionCode)}», а в проекте — «${regionName(cur.value)}». Проверьте адрес или регион.`);
    }
  }
  if (!c.house) problems.push("Дом по адресу не найден, точка поставлена по улице или району. Уточните адрес или поставьте точку на карте вручную.");
  const ownPoint = p.point && !(p.geo && samePoint(p.point, p.geo.point));
  const withGeo: LandProject = { ...p, geo: found, point: ownPoint ? p.point : c.point, updatedAt: at };
  return { project: applyChanges(withGeo, changes, at), changes, problems };
}

const samePoint = (a: GeoPoint, b: GeoPoint) => a.lat === b.lat && a.lon === b.lon;

/** Строка «Где участок» для экрана: округ, район и дата поиска. */
export function geoText(g: GeoLookup): string {
  const where = g.locality.length ? g.locality.join(", ") : regionName(g.regionCode);
  return `${where}. Найдено по адресу в OpenStreetMap ${fmtDate(g.fetchedAt.slice(0, 10))}`;
}
