import { geocode } from "@fm/engine";

/**
 * Поиск места по адресу: запрос к геокодеру OpenStreetMap от имени сайта. Правила геокодера — не чаще одного запроса
 * в секунду и понятное имя программы, поэтому запросы идут по очереди, а ответы на сутки запоминаются. Ответ
 * передаётся без изменений; разбор — в ядре. В журнал адрес не пишется.
 */
export const dynamic = "force-dynamic";

const UA = "finmodel-ocenka/1.0 (+https://ocenka.orientirgpz.com)";
const PACE_MS = 1100;
const TTL_MS = 24 * 3600 * 1000;
const CACHE_MAX = 500;
const MAX_LEN = 300;

const cache = new Map<string, { at: number; body: unknown }>();
let queue: Promise<unknown> = Promise.resolve();
let last = 0;

/** Следующий запрос к геокодеру — не раньше чем через PACE_MS после предыдущего. */
function paced<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(async () => {
    const wait = last + PACE_MS - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    last = Date.now();
    return fn();
  });
  queue = run.catch(() => undefined);
  return run;
}

export async function GET(req: Request): Promise<Response> {
  const q = (new URL(req.url).searchParams.get("q") ?? "").trim();
  if (!q || q.length > MAX_LEN) return Response.json({ error: `Адрес обязателен, до ${MAX_LEN} символов` }, { status: 400 });
  const key = q.toLowerCase();
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return Response.json(hit.body);
  try {
    const r = await paced(() => fetch(geocode.geocodeUrl(q), { cache: "no-store", headers: { "User-Agent": UA, Accept: "application/json" }, signal: AbortSignal.timeout(20_000) }));
    if (!r.ok) return Response.json({ error: `Геокодер ответил ${r.status}` }, { status: 502 });
    const body: unknown = await r.json();
    if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value as string);
    cache.set(key, { at: Date.now(), body });
    return Response.json(body);
  } catch {
    return Response.json({ error: "Геокодер недоступен" }, { status: 502 });
  }
}
