"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { book, reference, text } from "@fm/engine";
import { getParameter, type ParameterId } from "@fm/spec";
import { readJson, saveReferenceFile } from "@/lib/files";
import { getReference, listProjects, nowIso, saveProject, saveReference } from "@/lib/store";
import { SECTIONS, type SectionId } from "@/lib/reference-sections";
import { Modal, Toast } from "./ui";


type Item = book.AssumptionItem;
const AUTHOR_KEY = "referenceAuthor";

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

function Tabs({ section, tabs, on }: { section: SectionId; tabs: { id: string; title: string; dot?: boolean }[]; on: string }) {
  return (
    <div className="tabs">
      {tabs.map((t) => (
        <Link key={t.id} href={`/reference/${section}?tab=${t.id}`} className={t.id === on ? "on" : ""}>
          {t.title}
          {t.dot && <span className="tdot" />}
        </Link>
      ))}
    </div>
  );
}

function ValueTable({ rows, changed, onEdit }: { rows: reference.RefRow[]; changed?: ReadonlySet<string>; onEdit?: (param: ParameterId) => void }) {
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
            <tr key={r.name} className={r.param && changed?.has(r.param) ? "chgd" : ""}>
              <td>
                {r.name}
                {r.note && <div className="small muted">{r.note}</div>}
                {onEdit && r.param && (
                  <button className="lnk" onClick={() => onEdit(r.param as ParameterId)}>
                    Изменить
                  </button>
                )}
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

// ---------- правка стандартного значения ----------

type Cells = Record<string, string>[];

function EditItem({ item, onApply, onClose }: { item: Item; onApply: (next: Item) => void; onClose: () => void }) {
  const p = getParameter(item.param);
  const cols = book.tableColumns(p);
  const isTable = p.kind === "table";
  const isSeries = p.kind === "series";
  const [scalar, setScalar] = useState(book.toInput(p.unit, item.value));
  const [cells, setCells] = useState<Cells>(() => (Array.isArray(item.value) ? (item.value as Record<string, unknown>[]).map((r) => Object.fromEntries(cols.map((c) => [c.key, book.cellText(c.unit, r[c.key])]))) : []));
  const [years, setYears] = useState<book.SeriesRow[]>(() => (isSeries ? book.seriesRows(p.unit, item.value) : []));
  const [status, setStatus] = useState(item.status);
  const [check, setCheck] = useState(item.check ?? "");
  const [from, setFrom] = useState(item.from.text);
  const [url, setUrl] = useState(item.from.url ?? "");
  const [note, setNote] = useState(item.note ?? "");
  const [error, setError] = useState<string | null>(null);
  const unit = book.inputUnit(p.unit);

  function apply() {
    let value: Item["value"];
    if (isTable) {
      const rows: Record<string, unknown>[] = [];
      for (const [i, r] of cells.entries()) {
        const row: Record<string, unknown> = {};
        for (const c of cols) {
          if (c.options) {
            row[c.key] = r[c.key] ?? "";
            continue;
          }
          const v = book.cellFromInput(c.unit, r[c.key] ?? "");
          if (v.error !== undefined) return setError(`Строка ${i + 1}, «${c.title}»: ${v.error}`);
          row[c.key] = v.value;
        }
        rows.push(row);
      }
      value = rows.length ? rows : null;
    } else if (isSeries) {
      const v = book.seriesFromRows(p.unit, years, item.value);
      if (v.error !== undefined) return setError(v.error);
      value = v.value as Item["value"];
    } else if (p.options) {
      value = scalar || null;
    } else {
      const v = book.fromInput(p.unit, scalar, p.range ?? null);
      if (v.error !== undefined) return setError(v.error);
      value = v.value;
    }
    const next: Item = { param: item.param, group: item.group, value, status, from: { text: from, url: url.trim() || null } };
    if (status === "check") next.check = check;
    if (note.trim()) next.note = note;
    const problem = book.itemProblem(next);
    if (problem) return setError(problem);
    onApply(next);
  }

  const setCell = (i: number, key: string, v: string) => setCells((prev) => prev.map((r, j) => (j === i ? { ...r, [key]: v } : r)));

  return (
    <Modal
      title={p.name}
      onClose={onClose}
      wide={isTable}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Отмена
          </button>
          <button className="btn pri" onClick={apply}>
            Применить
          </button>
        </>
      }
    >
      <div className="frm">
        {isTable ? (
          <div>
            <div className="lbl">Значение</div>
            {cells.length ? (
              <div className="innerwrap">
                <table className="inner edit">
                  <thead>
                    <tr>
                      {cols.map((c) => (
                        <th key={c.key}>
                          {c.title}
                          {book.inputUnit(c.unit) && <span className="muted">, {book.inputUnit(c.unit)}</span>}
                        </th>
                      ))}
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {cells.map((r, i) => (
                      <tr key={i}>
                        {cols.map((c) => (
                          <td key={c.key}>
                            {c.options ? (
                              <select value={r[c.key] ?? ""} onChange={(e) => setCell(i, c.key, e.target.value)}>
                                <option value="">—</option>
                                {c.options.map((o) => (
                                  <option key={o}>{o}</option>
                                ))}
                              </select>
                            ) : (
                              <input
                                value={r[c.key] ?? ""}
                                inputMode={c.unit === "текст" ? "text" : "decimal"}
                                placeholder={c.unit === "дата" ? "ДД.ММ.ГГГГ" : undefined}
                                onChange={(e) => setCell(i, c.key, e.target.value)}
                              />
                            )}
                          </td>
                        ))}
                        <td>
                          <button className="x" title="Удалить строку" onClick={() => setCells((prev) => prev.filter((_, j) => j !== i))}>
                            ×
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="small muted">Стандарта нет: значение вводится в проекте.</div>
            )}
            <button className="btn sm" style={{ marginTop: 6 }} onClick={() => setCells((prev) => [...prev, Object.fromEntries(cols.map((c) => [c.key, ""]))])}>
              + Строка
            </button>
          </div>
        ) : isSeries ? (
          <div>
            <div className="lbl">Значение по годам{unit ? `, ${unit}` : ""}</div>
            {years.length ? (
              <div className="innerwrap">
                <table className="inner edit">
                  <thead>
                    <tr>
                      <th>Год</th>
                      <th>Значение</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {years.map((r, i) => (
                      <tr key={i}>
                        <td>
                          <input value={r.year} inputMode="numeric" onChange={(e) => setYears((prev) => prev.map((x, j) => (j === i ? { ...x, year: e.target.value } : x)))} />
                        </td>
                        <td>
                          <input value={r.value} inputMode="decimal" onChange={(e) => setYears((prev) => prev.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))} />
                        </td>
                        <td>
                          <button className="x" title="Удалить год" onClick={() => setYears((prev) => prev.filter((_, j) => j !== i))}>
                            ×
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="small muted">Стандарта нет: значение вводится в проекте.</div>
            )}
            <button className="btn sm" style={{ marginTop: 6 }} onClick={() => setYears((prev) => [...prev, book.nextSeriesRow(prev)])}>
              + Год
            </button>
            <div className="hint">После последнего года до конца проекта действует значение последнего года.</div>
          </div>
        ) : p.options ? (
          <label>
            Значение
            <select value={scalar} onChange={(e) => setScalar(e.target.value)}>
              <option value="">— стандарта нет</option>
              {p.options.map((o) => (
                <option key={o}>{o}</option>
              ))}
            </select>
          </label>
        ) : (
          <label>
            Значение{unit ? `, ${unit}` : ""}
            <input value={scalar} onChange={(e) => setScalar(e.target.value)} inputMode="decimal" placeholder="Пусто — стандарта нет, вводится в проекте" autoFocus />
          </label>
        )}
        <div className="row2">
          <label>
            Статус
            <select value={status} onChange={(e) => setStatus(e.target.value as Item["status"])}>
              {book.STATUSES.map((s) => (
                <option key={s} value={s}>
                  {book.STATUS_LABEL[s]}
                </option>
              ))}
            </select>
          </label>
          {status === "check" && (
            <label>
              Что проверить *
              <input value={check} onChange={(e) => setCheck(e.target.value)} placeholder="Например, условия банка" />
            </label>
          )}
        </div>
        <div className="row2">
          <label>
            Откуда *
            <input value={from} onChange={(e) => setFrom(e.target.value)} placeholder="Документ или решение, на котором основано значение" />
          </label>
          <label>
            Ссылка
            <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://" />
          </label>
        </div>
        <label>
          Пояснение
          <input value={note} onChange={(e) => setNote(e.target.value)} />
        </label>
        {error && <div className="err">{error}</div>}
      </div>
    </Modal>
  );
}

// ---------- экран ----------

type Loaded = { versions: book.AssumptionVersion[]; plan: book.ReferencePlan; text: string };

export function ReferenceScreen({ section, tab }: { section: SectionId; tab: string | undefined }) {
  const [versions, setVersions] = useState<book.AssumptionVersion[] | null>(null);
  const [draft, setDraft] = useState<Item[] | null>(null);
  const [editing, setEditing] = useState<ParameterId | null>(null);
  const [saving, setSaving] = useState(false);
  const [author, setAuthor] = useState("");
  const [note, setNote] = useState("");
  const [errors, setErrors] = useState<string[]>([]);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    getReference().then(setVersions, () => setVersions([]));
    try {
      setAuthor(localStorage.getItem(AUTHOR_KEY) ?? "");
    } catch {
      /* не запоминаем */
    }
  }, []);

  if (!versions) return null;
  const current = versions.at(-1) ?? null;
  const items = draft ?? current?.items ?? [];
  const shown = current ? [...versions.slice(0, -1), { ...current, items }] : versions;
  const changes = current && draft ? book.itemChanges(current.items, draft) : [];
  const changed = new Set<string>(changes.map((c) => c.param));
  const summary = reference.referenceSummary(shown);

  const flash = (t: string) => {
    setToast(t);
    setTimeout(() => setToast(null), 3200);
  };

  function applyItem(next: Item) {
    setDraft(items.map((i) => (i.param === next.param ? next : i)));
    setEditing(null);
  }

  async function saveVersion() {
    if (!versions) return;
    const r = book.newVersion(versions, items, author, note, nowIso());
    setErrors(r.errors);
    if (!r.version) return;
    const next = [...versions, r.version];
    await saveReference(next);
    try {
      localStorage.setItem(AUTHOR_KEY, author.trim());
    } catch {
      /* не запоминаем */
    }
    setVersions(next);
    setDraft(null);
    setSaving(false);
    flash(`Сохранена версия ${r.version.version}. Проекты переходят на неё кнопкой «Обновить» в проекте.`);
  }

  async function onFile(f: File | undefined) {
    if (fileInput.current) fileInput.current.value = "";
    if (!f || !versions) return;
    const r = book.readReferenceFile(await readJson(f));
    if (!r.ok) return setFileError(r.error);
    const plan = book.referencePlan(versions, r.value);
    setLoaded({ versions: r.value, plan, text: book.planText(plan, await listProjects()) });
  }

  async function applyFile() {
    if (!loaded || !versions) return;
    const res = book.applyReference(versions, loaded.versions, await listProjects(), nowIso());
    for (const p of res.projects) await saveProject(p);
    await saveReference(res.versions);
    setVersions(res.versions);
    setDraft(null);
    setLoaded(null);
    flash(`Справочник загружен: версия ${res.versions.at(-1)?.version ?? ""}`);
  }

  let body: React.ReactNode = null;
  if (section === "values" || section === "regions") {
    const tabs = section === "values" ? reference.standardTabs(shown) : reference.regionTabs();
    const t = tabs.find((x) => x.id === tab) ?? tabs[0];
    const editable = section === "values" && !!t?.rows.some((r) => r.param);
    body = t && (
      <>
        <Tabs section={section} on={t.id} tabs={tabs.map((x) => ({ id: x.id, title: x.title, dot: x.rows.some((r) => r.status.tone === "yel") }))} />
        {section === "values" && !editable && <p className="small muted">Значения по закону и официальным прогнозам меняются только вместе с документом-источником.</p>}
        <ValueTable rows={t.rows} changed={changed} {...(editable ? { onEdit: setEditing } : {})} />
      </>
    );
  }
  if (section === "formulas") {
    const tabs = reference.formulaTabs();
    const t = tabs.find((x) => x.id === tab) ?? tabs[0];
    body = t && (
      <>
        <Tabs section={section} on={t.id} tabs={tabs} />
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
  if (section === "sources") {
    const tabs = reference.sourceTabs();
    const t = tabs.find((x) => x.id === tab) ?? tabs[0];
    body = t && (
      <>
        <Tabs section={section} on={t.id} tabs={tabs.map((x) => ({ id: x.id, title: `${x.title} · ${x.rows.length}` }))} />
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
  if (section === "history") {
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
            {reference.versionRows(versions).map((v) => (
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

  const editItem = editing ? items.find((i) => i.param === editing) : null;

  return (
    <>
      <div className="phead">
        <div className="ttl wrap">
          <h1>Справочник</h1>
          <span className="sub">
            {current ? `версия ${current.version} от ${text.date(current.date)} · ` : ""}общий для всех проектов
          </span>
          {summary.needValue > 0 && <span className="chip yel">Нужно значение: {summary.needValue}</span>}
          {summary.recheckSources > 0 && <span className="chip red">Перепроверить источники: {summary.recheckSources}</span>}
          <span className="hbtns">
            <button className="btn sm" onClick={() => void saveReferenceFile(versions)}>
              Сохранить справочник в файл
            </button>
            <button className="btn sm" onClick={() => fileInput.current?.click()}>
              Загрузить справочник
            </button>
            <input ref={fileInput} type="file" accept=".json,application/json" hidden onChange={(e) => void onFile(e.target.files?.[0])} />
          </span>
        </div>
      </div>
      <div className="shell">
        <aside className="side">
          {SECTIONS.map((s) => (
            <Link key={s.id} className={`it top1 ${s.id === section ? "on" : ""}`} href={`/reference/${s.id}`}>
              <span>{s.title}</span>
              {s.id === "values" && changes.length > 0 && <span className="chip yel st">изменено</span>}
            </Link>
          ))}
        </aside>
        <main className="main">{body}</main>
      </div>

      {changes.length > 0 && !saving && (
        <div className="dirty">
          <div className="ch">Изменения справочника — сохраняются новой версией</div>
          <div className="rows">
            {changes.map((c) => (
              <div className="chg" key={`${c.param}-${c.what}`}>
                <div className="l">
                  {c.name}
                  {c.what !== "Значение" ? ` · ${c.what.toLowerCase()}` : ""}
                </div>
                <span className="from">{c.from}</span> → {c.to}
              </div>
            ))}
          </div>
          <div className="mf">
            <button className="btn" onClick={() => setDraft(null)}>
              Отменить
            </button>
            <button
              className="btn pri"
              onClick={() => {
                setNote((n) => n || book.suggestedNote(changes));
                setErrors([]);
                setSaving(true);
              }}
            >
              Сохранить версию {book.nextVersionNumber(versions)}
            </button>
          </div>
        </div>
      )}

      {editItem && <EditItem item={editItem} onApply={applyItem} onClose={() => setEditing(null)} />}

      {saving && (
        <Modal
          title={`Сохранить версию ${book.nextVersionNumber(versions)} справочника`}
          onClose={() => setSaving(false)}
          footer={
            <>
              <button className="btn" onClick={() => setSaving(false)}>
                Отмена
              </button>
              <button className="btn pri" onClick={() => void saveVersion()}>
                Сохранить версию
              </button>
            </>
          }
        >
          <div className="frm">
            <label>
              Кто сохраняет *
              <input value={author} onChange={(e) => setAuthor(e.target.value)} placeholder="Фамилия и должность" autoFocus />
            </label>
            <label>
              Что изменилось *
              <input value={note} onChange={(e) => setNote(e.target.value)} />
            </label>
            <p className="small muted">Проекты останутся на своей версии справочника и перейдут на новую только по кнопке «Обновить» в проекте. Чтобы у коллег была та же версия, сохраните справочник в файл и передайте им.</p>
            {errors.map((e) => (
              <div key={e} className="err">
                {e}
              </div>
            ))}
          </div>
        </Modal>
      )}

      {loaded && (
        <Modal
          title="Загрузить справочник из файла"
          onClose={() => setLoaded(null)}
          footer={
            loaded.plan.kind === "newer" || loaded.plan.kind === "diverged" ? (
              <>
                <button className="btn" onClick={() => setLoaded(null)}>
                  Отмена
                </button>
                <button className={`btn ${loaded.plan.kind === "diverged" ? "danger" : "pri"}`} onClick={() => void applyFile()}>
                  {loaded.plan.kind === "diverged" ? "Заменить справочником из файла" : "Загрузить"}
                </button>
              </>
            ) : (
              <button className="btn pri" onClick={() => setLoaded(null)}>
                Понятно
              </button>
            )
          }
        >
          <p>{loaded.text}</p>
          {draft && (loaded.plan.kind === "newer" || loaded.plan.kind === "diverged") && <p className="err">Несохранённые изменения справочника будут отменены.</p>}
        </Modal>
      )}

      {fileError && (
        <Modal
          title="Файл не загружен"
          onClose={() => setFileError(null)}
          footer={
            <button className="btn pri" onClick={() => setFileError(null)}>
              Понятно
            </button>
          }
        >
          <p>{fileError}</p>
        </Modal>
      )}
      <Toast text={toast} />
    </>
  );
}
