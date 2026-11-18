import { mosdata } from "@fm/engine";

/**
 * Данные портала открытых данных Москвы по точке участка: городские участки, зоны охраны и территории памятников,
 * здания адресного реестра; к ним — этажность зданий из OpenStreetMap (Overpass; не ответил — без этажности).
 * Запрос — от имени сайта с ключом API портала (DATA_MOS_API_KEY в ~/web/.env на сервере); ключ в ответ и в журнал
 * не попадает. Ответы портала передаются без изменений; разбор — в ядре. Ответ на точку запоминается на сутки.
 */
export const dynamic = "force-dynamic";

const API = "https://apidata.mos.ru";
const TTL_MS = 24 * 3600 * 1000;
const CACHE_MAX = 300;
const KEYS = Object.keys(mosdata.MOS_DATASETS) as mosdata.MosDatasetKey[];

const OVERPASS = "https://overpass-api.de/api/interpreter";
const UA = "finmodel-ocenka/1.0 (+https://ocenka.orientirgpz.com)";

/** Этажность зданий у точки из OpenStreetMap; ошибка — null (этажность введёт финансист). */
async function loadOsm(p: { lat: number; lon: number }): Promise<unknown> {
  try {
    const r = await fetch(OVERPASS, { method: "POST", cache: "no-store", headers: { "User-Agent": UA, "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ data: mosdata.osmLevelsQuery(p) }).toString(), signal: AbortSignal.timeout(30_000) });
    return r.ok ? await r.json() : null;
  } catch {
    return null;
  }
}

const cache = new Map<string, { at: number; body: unknown }>();

async function load(key: mosdata.MosDatasetKey, p: { lat: number; lon: number }, apiKey: string): Promise<unknown> {
  const url = `${API}${mosdata.featuresPath(key, p)}&api_key=${encodeURIComponent(apiKey)}`;
  const r = await fetch(url, { cache: "no-store", headers: { Accept: "application/json" }, signal: AbortSignal.timeout(60_000) });
  if (!r.ok) throw new Error(`Портал ответил ${r.status}`);
  return r.json();
}

export async function GET(req: Request): Promise<Response> {
  const q = new URL(req.url).searchParams;
  const lat = Number(q.get("lat"));
  const lon = Number(q.get("lon"));
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return Response.json({ error: "Нужны координаты точки" }, { status: 400 });
  const apiKey = process.env.DATA_MOS_API_KEY ?? "";
  if (!apiKey) return Response.json({ error: "На сервере не задан ключ портала открытых данных Москвы" }, { status: 503 });
  const id = `${lat.toFixed(6)},${lon.toFixed(6)}`;
  const hit = cache.get(id);
  if (hit && Date.now() - hit.at < TTL_MS) return Response.json(hit.body);
  try {
    const [parts, osm] = await Promise.all([Promise.all(KEYS.map((k) => (k === "buildings" ? load(k, { lat, lon }, apiKey).catch(() => null) : load(k, { lat, lon }, apiKey)))), loadOsm({ lat, lon })]);
    const body = { ...Object.fromEntries(KEYS.map((k, i) => [k, parts[i]])), osm };
    if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value as string);
    cache.set(id, { at: Date.now(), body });
    return Response.json(body);
  } catch {
    return Response.json({ error: "Портал открытых данных Москвы недоступен" }, { status: 502 });
  }
}
