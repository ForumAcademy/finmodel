import { zcyc } from "@fm/engine";

export type LoadResult = { curve: zcyc.ZcycCurve } | { error: string };

async function getJson(url: string): Promise<unknown> {
  const r = await fetch(url, { cache: "no-store" });
  if (!r.ok) throw new Error(String(r.status));
  return r.json();
}

/**
 * Загрузка кривой доходности ОФЗ на дату оценки: от даты назад до ближайшего торгового дня. Сначала напрямую с биржи,
 * если браузер не пускает — через сервис.
 */
export async function loadZcyc(valuation: string, today: string, now: string): Promise<LoadResult> {
  let direct = true;
  let reached = false;
  for (const d of zcyc.zcycTryDates(valuation, today)) {
    let json: unknown = null;
    if (direct) {
      try {
        json = await getJson(zcyc.zcycUrl(d));
      } catch {
        direct = false;
      }
    }
    if (!direct) {
      try {
        json = await getJson(`/api/zcyc?date=${d}`);
      } catch {
        json = null;
      }
    }
    // Ни браузер, ни сервис до биржи не достучались — остальные даты не помогут
    if (json === null && !reached) break;
    reached = true;
    const curve = zcyc.parseZcyc(json, d, now);
    if (curve) return { curve };
  }
  return {
    error: reached
      ? `На дату оценки и ${zcyc.ZCYC_LOOKBACK_DAYS} дней до неё биржа не вернула кривую. Введите безрисковую ставку вручную с документом.`
      : "Биржа недоступна. Введите безрисковую ставку вручную: доходность ОФЗ со сроком, равным сроку проекта, на дату оценки, с документом.",
  };
}
