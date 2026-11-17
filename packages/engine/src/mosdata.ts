/**
 * Данные портала открытых данных Москвы (data.mos.ru, источник S_MOS_OPENDATA) по точке участка: городские
 * земельные участки (набор 1497), зоны охраны (613) и территории (614) объектов культурного наследия.
 * Запрос идёт с сервера сайта по ключу (apps/web/app/api/mosdata); здесь — разбор ответа, проверка «точка внутри
 * границы» и изменения проекта.
 */
import Decimal from "decimal.js";
import { getRegion, getSource, type RegionCode } from "@fm/spec";
import { upksFor } from "./modules/land";
import { date as fmtDate, num } from "./lib/text";
import { applyChanges, cadastralQuarter, vriCodes, normalizeCadastralNumber, parseNumberRu, type ChangeSet, type GeoPoint, type LandProject, type PlotChange, type PlotFieldKey, type PlotValue, type ValueBasis } from "./plot";
import { siteOf, updateSite, type ZouitEntry } from "./site";

export const MOS_SOURCE = "S_MOS_OPENDATA" as const;

/** Наборы портала, которые читает сервис. */
export const MOS_DATASETS = { plots: 1497, zones: 613, territories: 614 } as const;
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

/** Что нашлось на портале Москвы по точке; хранится в проекте. */
export interface MosLookup {
  point: GeoPoint;
  plots: CityPlot[];
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

/** Разбор трёх ответов портала по точке. */
export function mosLookup(p: GeoPoint, raw: Partial<Record<MosDatasetKey, unknown>>, at: string): MosLookup {
  return { point: p, plots: cityPlotsAt(raw.plots, p), zones: namesAt(raw.zones, p), territories: namesAt(raw.territories, p), fetchedAt: at };
}

export function mosBasis(key: MosDatasetKey, at: string, note: string): ValueBasis {
  const s = getSource(MOS_SOURCE);
  return { title: `${s.title.split(" — ")[0]}, набор ${MOS_DATASETS[key]}`, url: datasetUrl(key), date: at.slice(0, 10), note };
}

/** Строка «Данные Москвы» для экрана. */
export function mosText(m: MosLookup): string {
  const plots = m.plots.length ? `Городских участков в этой точке: ${m.plots.length}` : "Городских участков в этой точке нет";
  const heritage = m.zones.length || m.territories.length ? `, участок в зоне охраны памятников` : "";
  return `${plots}${heritage}. Портал открытых данных Москвы, ${fmtDate(m.fetchedAt.slice(0, 10))}`;
}

/** Городская земля: собственность города или неразграниченная. */
export const isCityLand = (c: CityPlot): boolean => /город|неразграничен/i.test(c.ownerType ?? "");

/** Форма права для городской земли: участок под строительство предоставляется в аренду на торгах (ст. 39.6 ЗК РФ). */
export const CITY_LAND_TENURE = "аренда";

/**
 * Взять данные городского участка: номер, квартал, вид использования — «из источника»; форма права для городской
 * земли — оценка «аренда». Значения из документа проекта не меняются. Площадь не меняется: если она отличается
 * от проекта — сообщение.
 */
export function applyCityPlot(p: LandProject, c: CityPlot, at: string): ChangeSet & { project: LandProject } {
  const changes: PlotChange[] = [];
  const problems: string[] = [];
  const note = `Участок ${c.cadastralNumber}${c.address ? `, ${c.address}` : ""}`;
  const put = (field: PlotFieldKey, value: string | null, origin: "source" | "estimate", extra?: string) => {
    if (value === null) return;
    const cur = p.plot[field];
    if (cur.origin === "source" && cur.basis?.documentId) return;
    const to: PlotValue = { value, origin, basis: mosBasis("plots", at, extra ? `${note}. ${extra}` : note) };
    if (cur.value === to.value && cur.origin === to.origin && cur.basis?.url === to.basis?.url) return;
    changes.push({ field, from: cur, to });
  };
  put("cadastralNumber", c.cadastralNumber, "source");
  put("quarter", cadastralQuarter(c.cadastralNumber), "source");
  put("vri", c.vri, "source");
  if (isCityLand(c)) {
    put("tenure", CITY_LAND_TENURE, "estimate", `Земля города (${c.ownerType}${c.rented === true ? ", сейчас сдана в аренду" : ""}): участок под строительство предоставляется в аренду на торгах, ст. 39.6 ЗК РФ`);
  }
  const area = p.plot.area.value;
  if (c.area && area && Math.abs(Number(c.area) - Number(area)) >= 1) {
    problems.push(`В реестре города площадь участка ${num(c.area, 0)} м², в проекте — ${num(area, 0)} м². Проверьте площадь: расчёт идёт от площади проекта.`);
  }
  const withPlot = applyChanges(p, changes, at);
  const est = cadastralValueEstimate(withPlot, at);
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

/**
 * Оценка кадастровой стоимости в данные участка: площадь × средний УПКС квартала по группе текущего ВРИ (как
 * F.LAND.CADASTRAL_VALUE_EST). Меняет только пустое значение или прошлую оценку; нет площади, квартала, ВРИ или
 * таблицы региона — изменений нет.
 */
export function cadastralValueEstimate(p: LandProject, at: string): PlotChange[] {
  const cur = p.plot.cadastralValue;
  if (cur.value !== null && cur.origin !== "estimate") return [];
  const region = p.plot.regionCode.value;
  const quarter = p.plot.quarter.value ?? (p.plot.cadastralNumber.value ? cadastralQuarter(p.plot.cadastralNumber.value) : null);
  const area = p.plot.area.value;
  if (!region || !quarter || !area) return [];
  let t;
  try {
    t = getRegion(region as RegionCode).cadastral_value_estimate;
  } catch {
    return [];
  }
  if (!t) return [];
  const group = vriCodes(p.plot.vri.value).map((c) => t.vri_groups[c]).find((g): g is string => g !== undefined);
  if (!group) return [];
  const u = upksFor(t, quarter, group);
  if (!u) return [];
  const value = new Decimal(area).mul(u.value).toDecimalPlaces(2).toString();
  const title = t.groups.find((g) => g.key === group)?.title ?? group;
  const s = getSource("S_MSK_DGI_UPKS_2024");
  const to: PlotValue = {
    value,
    origin: "estimate",
    basis: { title: "Оценка по средней кадастровой стоимости 1 м² в квартале, распоряжение ДГИ Москвы № 214856", url: s.url ?? null, date: at.slice(0, 10), note: `${num(area, 0)} м² × ${num(String(u.value), 2)} руб/м² — группа «${title}», ${u.where}. Замените стоимостью из выписки ЕГРН, когда она будет` },
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
  let next: LandProject = { ...p, mos: m, updatedAt: at };
  if (!sameZones) next = updateSite(next, { zouit: [...own, ...heritage] }, at);
  if (m.plots.length === 1) return applyCityPlot(next, m.plots[0] as CityPlot, at);
  const changes: PlotChange[] = [];
  const t = next.plot.tenure;
  if (m.plots.length === 0 && t.value === null) {
    changes.push({ field: "tenure", from: t, to: { value: PRIVATE_LAND_TENURE, origin: "estimate", basis: mosBasis("plots", at, "В реестре земель города в этой точке участка нет: земля, вероятно, не городская — по умолчанию покупка в собственность") } });
  }
  const withTenure = applyChanges(next, changes, at);
  const est = cadastralValueEstimate(withTenure, at);
  return { project: applyChanges(withTenure, est, at), changes: [...changes, ...est], problems: [] };
}
