import { zcyc } from "@fm/engine";

/**
 * Кривая доходности ОФЗ Мосбиржи на дату: запрос к бирже от имени сервиса, если браузер не может обратиться к ней
 * напрямую. Ответ биржи передаётся без изменений; разбор — в ядре.
 */
export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<Response> {
  const d = new URL(req.url).searchParams.get("date") ?? "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return Response.json({ error: "Дата в формате ГГГГ-ММ-ДД" }, { status: 400 });
  try {
    const r = await fetch(zcyc.zcycUrl(d), { cache: "no-store" });
    if (!r.ok) return Response.json({ error: `Биржа ответила ${r.status}` }, { status: 502 });
    return Response.json(await r.json());
  } catch {
    return Response.json({ error: "Биржа недоступна" }, { status: 502 });
  }
}
