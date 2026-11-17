import { geocode, mosdata, type plot } from "@fm/engine";

export type GeocodeLoad = { query: string; candidates: geocode.GeoCandidate[] } | { error: string };

/** Поиск по адресу проекта: варианты запроса по очереди (с строением, без него), до первого найденного места. */
export async function findByAddress(p: plot.LandProject): Promise<GeocodeLoad> {
  const address = p.plot.address.value;
  if (!address) return { error: "В проекте нет адреса. Введите адрес участка, чтобы сервис нашёл его на карте." };
  const queries = geocode.geocodeQueries(address, p.plot.regionCode.value);
  let reached = false;
  for (const q of queries) {
    let json: unknown;
    try {
      const r = await fetch(`/api/geocode?q=${encodeURIComponent(q)}`, { cache: "no-store" });
      if (!r.ok) continue;
      json = await r.json();
      reached = true;
    } catch {
      continue;
    }
    const candidates = geocode.usableCandidates(geocode.parseGeocode(json));
    if (candidates.length) return { query: q, candidates };
  }
  return {
    error: reached
      ? `По адресу «${address}» место в Москве или Московской области не нашлось. Проверьте адрес или поставьте точку на карте вручную.`
      : "Поиск по адресу сейчас недоступен. Повторите позже или поставьте точку на карте вручную.",
  };
}

export type MosLoad = { lookup: mosdata.MosLookup } | { error: string };

/** Данные портала открытых данных Москвы по точке участка (только Москва). */
export async function findMosData(point: plot.GeoPoint, at: string): Promise<MosLoad> {
  try {
    const r = await fetch(`/api/mosdata?lat=${point.lat}&lon=${point.lon}`, { cache: "no-store" });
    const json: unknown = await r.json();
    if (!r.ok) return { error: (json as { error?: string } | null)?.error ?? "Портал открытых данных Москвы недоступен" };
    return { lookup: mosdata.mosLookup(point, json as Partial<Record<mosdata.MosDatasetKey, unknown>>, at) };
  } catch {
    return { error: "Портал открытых данных Москвы недоступен. Повторите позже." };
  }
}
