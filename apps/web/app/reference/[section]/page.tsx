import Link from "next/link";
import { notFound } from "next/navigation";
import { reference } from "@fm/engine";

const SECTIONS = [
  { id: "values", title: "Стандартные значения" },
  { id: "regions", title: "Нормативы регионов" },
  { id: "formulas", title: "Формулы" },
  { id: "sources", title: "Источники" },
  { id: "history", title: "История версий" },
] as const;
type SectionId = (typeof SECTIONS)[number]["id"];

export function generateStaticParams() {
  return SECTIONS.map((s) => ({ section: s.id }));
}

function Links({ links }: { links: reference.RefLink[] }) {
  if (!links.length) return <span className="muted">—</span>;
  return (
    <div className="srcs">
      {links.map((l) =>
        l.url ? (
          <a key={l.title} href={l.url} target="_blank" rel="noopener">
            {l.title} ↗
          </a>
        ) : (
          <span key={l.title}>{l.title}</span>
        ),
      )}
    </div>
  );
}

function Value({ v }: { v: reference.RefValue | null }) {
  if (!v) return <span className="small" style={{ color: "var(--yel)" }}>нужно значение</span>;
  return (
    <>
      {v.text && <span>{v.text}</span>}
      {v.table && (
        <div className="innerwrap">
        <table className="inner">
          <thead>
            <tr>
              {v.table.headers.map((h) => (
                <th key={h}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {v.table.rows.map((r, i) => (
              <tr key={i}>
                {r.map((c, j) => (
                  <td key={j}>{c}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        </div>
      )}
      {v.notes?.map((n) => (
        <div key={n} className="small muted">
          {n}
        </div>
      ))}
    </>
  );
}

function Tabs({ section, tabs, on }: { section: SectionId; tabs: { id: string; title: string; dot?: boolean; extra?: string }[]; on: string }) {
  return (
    <div className="tabs">
      {tabs.map((t) => (
        <Link key={t.id} href={`/reference/${section}?tab=${t.id}`} className={t.id === on ? "on" : ""}>
          {t.title}
          {t.extra}
          {t.dot && <span className="tdot" />}
        </Link>
      ))}
    </div>
  );
}

function ValueTable({ rows }: { rows: reference.RefRow[] }) {
  return (
    <div className="tw reftbl">
      <table className="t">
        <thead>
          <tr>
            <th>Показатель</th>
            <th className="l">Значение</th>
            <th className="l">Статус</th>
            <th className="l">Откуда</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.name}>
              <td>
                {r.name}
                {r.note && <div className="small muted">{r.note}</div>}
              </td>
              <td className="l" style={r.value ? undefined : { background: "var(--yel-bg)" }}>
                <Value v={r.value} />
              </td>
              <td className="l">
                <span className={`chip ${r.status.tone}`}>{r.status.text}</span>
              </td>
              <td className="l" style={{ minWidth: 260 }}>
                <Links links={r.sources} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default async function ReferencePage({ params, searchParams }: { params: Promise<{ section: string }>; searchParams: Promise<{ tab?: string }> }) {
  const { section } = await params;
  const { tab } = await searchParams;
  const sec = SECTIONS.find((s) => s.id === section);
  if (!sec) notFound();
  const summary = reference.referenceSummary();
  let body: React.ReactNode = null;

  if (sec.id === "values" || sec.id === "regions") {
    const tabs = sec.id === "values" ? reference.standardTabs() : reference.regionTabs();
    const t = tabs.find((x) => x.id === tab) ?? tabs[0];
    body = t && (
      <>
        <Tabs section={sec.id} on={t.id} tabs={tabs.map((x) => ({ id: x.id, title: x.title, dot: x.rows.some((r) => r.status.tone === "yel") }))} />
        <ValueTable rows={t.rows} />
      </>
    );
  }
  if (sec.id === "formulas") {
    const tabs = reference.formulaTabs();
    const t = tabs.find((x) => x.id === tab) ?? tabs[0];
    body = t && (
      <>
        <Tabs section={sec.id} on={t.id} tabs={tabs} />
        <div className="tw">
          <table className="t">
            <thead>
              <tr>
                <th>Показатель</th>
                <th className="l">Как считается</th>
                <th className="l">Основание</th>
              </tr>
            </thead>
            <tbody>
              {t.rows.map((r) => (
                <tr key={r.title} className={r.verified ? "" : "recheck"}>
                  <td>
                    {r.title}
                    {!r.verified && <div className="small" style={{ color: "var(--red)" }}>перепроверить</div>}
                  </td>
                  <td className="l" style={{ minWidth: 360 }}>
                    {r.how}
                  </td>
                  <td className="l" style={{ minWidth: 240 }}>
                    <Links links={r.sources} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </>
    );
  }
  if (sec.id === "sources") {
    const tabs = reference.sourceTabs();
    const t = tabs.find((x) => x.id === tab) ?? tabs[0];
    body = t && (
      <>
        <Tabs section={sec.id} on={t.id} tabs={tabs.map((x) => ({ id: x.id, title: `${x.title} · ${x.rows.length}` }))} />
        <div className="tw">
          <table className="t">
            <thead>
              <tr>
                <th>Источник</th>
                <th className="l">Проверен</th>
              </tr>
            </thead>
            <tbody>
              {t.rows.map((r) => (
                <tr key={r.title} className={r.status.tone === "red" ? "recheck" : ""}>
                  <td>
                    {r.url ? (
                      <a href={r.url} target="_blank" rel="noopener">
                        {r.title} ↗
                      </a>
                    ) : (
                      r.title
                    )}
                    <div className="small muted">{r.usedFor}</div>
                  </td>
                  <td className="l">
                    {r.accessed && <span className="small">{r.accessed} </span>}
                    <span className={`chip ${r.status.tone}`}>{r.status.text}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </>
    );
  }
  if (sec.id === "history") {
    body = (
      <div className="tw">
        <table className="t">
          <thead>
            <tr>
              <th>Версия</th>
              <th className="l">Дата</th>
              <th className="l">Кто</th>
              <th className="l">Что изменилось</th>
            </tr>
          </thead>
          <tbody>
            {reference.versionRows().map((v) => (
              <tr key={v.version}>
                <td>Версия {v.version}</td>
                <td className="l">{v.date}</td>
                <td className="l">{v.author}</td>
                <td className="l">{v.note}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }

  return (
    <>
      <div className="phead">
        <div className="ttl">
          <h1>Справочник</h1>
          <span className="sub">
            {summary.version ? `версия ${summary.version} от ${summary.date} · ` : ""}общий для всех проектов
          </span>
          {summary.needValue > 0 && <span className="chip yel">Нужно значение: {summary.needValue}</span>}
          {summary.recheckSources > 0 && <span className="chip red">Перепроверить источники: {summary.recheckSources}</span>}
        </div>
      </div>
      <div className="shell">
        <aside className="side">
          {SECTIONS.map((s) => (
            <Link key={s.id} className={`it top1 ${s.id === sec.id ? "on" : ""}`} href={`/reference/${s.id}`}>
              <span>{s.title}</span>
            </Link>
          ))}
        </aside>
        <main className="main">{body}</main>
      </div>
    </>
  );
}
