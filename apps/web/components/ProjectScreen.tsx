"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { plot, text } from "@fm/engine";
import { EGRN_ACCEPT } from "@fm/egrn-import";
import { download, readEgrn } from "@/lib/egrn";
import { getFile, getProject, newId, nowIso, saveFile, saveProject } from "@/lib/store";
import { Chip, Modal, OriginTag, Toast } from "./ui";
import { MapPicker, pointText } from "./MapPicker";

type LandProject = plot.LandProject;
type PlotFieldKey = plot.PlotFieldKey;

export type ProjectSection = "plot" | "docs";
const PLOT_TABS = ["Участок", "Проект", "История"] as const;
type PlotTab = (typeof PLOT_TABS)[number];

const href = (id: string, sec: ProjectSection, tab?: PlotTab) => `/projects/${id}?sec=${sec}${tab ? `&tab=${encodeURIComponent(tab)}` : ""}`;
const today = () => nowIso().slice(0, 10);

// ---------- поле участка ----------

function BasisLink({ p, basis }: { p: LandProject; basis: plot.ValueBasis | null }) {
  if (!basis) return null;
  const label = plot.basisText(basis);
  if (basis.documentId && p.documents.some((d) => d.id === basis.documentId)) {
    return (
      <Link className="org basis" href={href(p.id, "docs")}>
        {label}
      </Link>
    );
  }
  if (basis.url) {
    return (
      <a className="org basis" href={basis.url} target="_blank" rel="noopener">
        {label} ↗
      </a>
    );
  }
  return <span className="org basis">{label}</span>;
}

function FieldRow({ p, field, onEdit }: { p: LandProject; field: plot.PlotField; onEdit: (k: PlotFieldKey) => void }) {
  const v = p.plot[field.key];
  const miss = field.required && v.value === null;
  const shown = plot.plotText(field.key, v.value);
  const placeholder = field.key === "cadastralValue" ? "не учтено" : field.required ? "нет значения" : "—";
  return (
    <div className={`fld ${miss ? "miss" : ""}`}>
      <div className="lb">
        <span>{field.label}</span>
        <div className="meta">
          <OriginTag origin={v.origin} />
          <BasisLink p={p} basis={v.basis} />
        </div>
      </div>
      <div className="val">
        <button className={`shown ${field.kind === "text" && field.key !== "cadastralNumber" && field.key !== "quarter" ? "text" : ""}`} onClick={() => onEdit(field.key)} title="Изменить">
          {shown || placeholder}
        </button>
        {field.unit && <span className="u">{field.unit}</span>}
      </div>
      {v.basis?.note && <div className="note">{v.basis.note}</div>}
    </div>
  );
}

// ---------- изменение поля ----------

function EditField({ p, field, onApply, onClose }: { p: LandProject; field: plot.PlotField; onApply: (set: plot.ChangeSet) => void; onClose: () => void }) {
  const cur = p.plot[field.key];
  const [value, setValue] = useState(plot.plotText(field.key, cur.value));
  const [docId, setDocId] = useState(cur.basis?.documentId ?? "");
  const [basis, setBasis] = useState(cur.basis?.documentId ? "" : (cur.basis?.title ?? ""));
  const [url, setUrl] = useState(cur.basis?.url ?? "");
  const [error, setError] = useState<string | null>(null);
  const isKn = field.key === "cadastralNumber";
  const numeric = field.kind === "area" || field.kind === "money";

  function apply(clear = false) {
    const doc = p.documents.find((d) => d.id === docId);
    const b: plot.ValueBasis = doc ? { title: plot.documentTitle(doc.kind), documentId: doc.id, date: today() } : { title: basis.trim(), url: url.trim() || null, date: today() };
    if (!doc && !basis.trim() && !clear) return setError("Укажите основание: документ проекта или на чём основано значение.");
    if (isKn) {
      const set = plot.cadastralNumberChanges(p, value, { title: b.title || "Введено вручную", ...(b.documentId ? { documentId: b.documentId } : {}), date: today() });
      if (set.problems.length && !set.changes.length) return setError(set.problems.join(" "));
      return onApply(set);
    }
    if (clear) return onApply({ changes: plot.manualChange(p, field.key, null, b), problems: [] });
    let v: string | null = value.trim();
    if (numeric) {
      v = plot.parseNumberRu(value);
      if (v === null) return setError(`«${value}» — не число. Введите число, например 32 000.`);
    }
    if (!v) return setError("Введите значение или удалите его кнопкой «Нет значения».");
    onApply({ changes: plot.manualChange(p, field.key, v, b), problems: [] });
  }

  return (
    <Modal
      title={field.label}
      onClose={onClose}
      footer={
        <>
          {!isKn && cur.value !== null && (
            <button className="btn" onClick={() => apply(true)} style={{ marginRight: "auto" }}>
              Нет значения
            </button>
          )}
          <button className="btn" onClick={onClose}>
            Отмена
          </button>
          <button className="btn pri" onClick={() => apply()}>
            Применить
          </button>
        </>
      }
    >
      <div className="frm">
        <label>
          Значение{field.unit ? `, ${field.unit}` : ""}
          {field.kind === "enum" ? (
            <select value={value} onChange={(e) => setValue(e.target.value)}>
              <option value="">—</option>
              {field.options?.map((o) => (
                <option key={o}>{o}</option>
              ))}
            </select>
          ) : field.kind === "region" ? (
            <select value={value} onChange={(e) => setValue(e.target.value)}>
              <option value="">—</option>
              {plot.PROJECT_REGIONS.map((r) => (
                <option key={r.code} value={r.code}>
                  {r.name}
                </option>
              ))}
            </select>
          ) : (
            <input value={value} onChange={(e) => setValue(e.target.value)} placeholder={isKn ? "77:05:0004012:1873" : ""} inputMode={numeric ? "decimal" : "text"} autoFocus />
          )}
        </label>
        {isKn && <span className="hint">После ввода номера загрузите выписку ЕГРН: её данные заменят введённые значения.</span>}
        <label>
          Документ-основание
          <select value={docId} onChange={(e) => setDocId(e.target.value)}>
            <option value="">Без документа — Экспертное значение</option>
            {p.documents.map((d) => (
              <option key={d.id} value={d.id}>
                {plot.documentTitle(d.kind)} — {d.fileName}
              </option>
            ))}
          </select>
        </label>
        {!docId && (
          <div className="row2">
            <label>
              На чём основано *
              <input value={basis} onChange={(e) => setBasis(e.target.value)} placeholder="Например, письмо продавца от 22.09.2026" />
            </label>
            <label>
              Ссылка
              <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://" />
            </label>
          </div>
        )}
        {error && <div className="err">{error}</div>}
      </div>
    </Modal>
  );
}

// ---------- экран проекта ----------

export function ProjectScreen({ id, sec, tab }: { id: string; sec: ProjectSection; tab: PlotTab }) {
  const [project, setProject] = useState<LandProject | null | undefined>(undefined);
  const [pending, setPending] = useState<plot.PlotChange[]>([]);
  const [problems, setProblems] = useState<string[]>([]);
  const [editing, setEditing] = useState<PlotFieldKey | null>(null);
  const [reading, setReading] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const egrnInput = useRef<HTMLInputElement>(null);
  const docInput = useRef<HTMLInputElement>(null);
  const [docKind, setDocKind] = useState<plot.DocumentKind>("other");

  useEffect(() => {
    getProject(id).then(setProject, () => setProject(null));
    try {
      setCollapsed(localStorage.getItem("menuCollapsed") === "1");
    } catch {
      /* хранилище недоступно — меню развёрнуто */
    }
  }, [id]);

  const flash = useCallback((t: string) => {
    setToast(t);
    setTimeout(() => setToast(null), 2600);
  }, []);

  if (project === undefined) return null;
  if (project === null) {
    return (
      <div className="page">
        <div className="card empty">
          Проект не найден в этом браузере. <Link href="/">Все проекты</Link>
        </div>
      </div>
    );
  }
  const p = project;
  const view = pending.length ? plot.applyChanges(p, pending, p.updatedAt) : p;
  const status = plot.projectStatus(view);
  const hasEgrn = p.documents.some((d) => d.kind === "egrn");

  async function persist(next: LandProject) {
    await saveProject(next);
    setProject(next);
  }

  async function addDocument(file: File, kind: plot.DocumentKind): Promise<plot.ProjectDocument> {
    const doc: plot.ProjectDocument = { id: newId(), kind, fileName: file.name, size: file.size, uploadedAt: nowIso() };
    await saveFile(doc.id, file);
    await persist({ ...p, documents: [...p.documents, doc], updatedAt: nowIso() });
    return doc;
  }

  async function onEgrn(file: File | undefined) {
    if (!file) return;
    setReading(true);
    try {
      const r = await readEgrn(file).catch(() => null);
      const doc = await addDocument(file, "egrn");
      if (!r || !r.found.length) {
        setProblems(r?.problems ?? [`Файл «${file.name}» не удалось прочитать. Проверьте, что это выписка ЕГРН в XML, PDF или ZIP, или введите данные вручную.`]);
        return;
      }
      const set = plot.egrnChanges({ ...p, documents: [...p.documents, doc] }, r.data, { id: doc.id, date: r.data.extractDate ?? null });
      setProblems([...set.problems, ...r.problems]);
      if (set.changes.length) setPending((prev) => plot.mergeChanges(prev, set.changes));
      else if (!set.problems.length) flash("Выписка сохранена: данные совпадают с проектом");
    } finally {
      setReading(false);
    }
  }

  async function save() {
    const at = nowIso();
    await persist(plot.applyChanges(p, pending, at));
    setPending([]);
    setProblems([]);
    flash("Изменения сохранены");
  }

  const toggleMenu = () => {
    const c = !collapsed;
    setCollapsed(c);
    try {
      localStorage.setItem("menuCollapsed", c ? "1" : "0");
    } catch {
      /* не запоминаем */
    }
  };

  const docCount = plot.DOCUMENT_KINDS.filter((k) => p.documents.some((d) => d.kind === k.kind)).length;

  return (
    <>
      <div className="phead">
        <Link className="back" href="/">
          ← Все проекты
        </Link>
        <div className="ttl">
          <h1>{plot.projectTitle(view)}</h1>
          {status.noCadastralNumber && <Chip tone="yel">Участок без кадастрового номера</Chip>}
          {status.missing > 0 && (
            <Link href={href(p.id, "plot", "Участок")}>
              <Chip tone="yel">
                Не хватает {status.missing} {text.plural(status.missing, ["значения", "значений", "значений"])}
              </Chip>
            </Link>
          )}
        </div>
        <div className="sub2">{plot.projectSubtitle(view)}</div>
      </div>
      <div className="shell">
        <aside className={`side ${collapsed ? "col" : ""}`}>
          <button className="collapse" onClick={toggleMenu}>
            {collapsed ? "»" : "« Свернуть меню"}
          </button>
          <div className="grp">
            {!collapsed && (
              <div className="gh open">
                <span>Вводные</span>
              </div>
            )}
            <Link className={`it ${collapsed ? "top1" : ""} ${sec === "plot" ? "on" : ""}`} href={href(p.id, "plot")}>
              <span>{collapsed ? "Участок" : "Проект и участок"}</span>
              {!collapsed && (status.missing ? <span className="chip yel st">нет {status.missing}</span> : <span className="stok st">✓</span>)}
            </Link>
          </div>
          <div className="grp">
            <Link className={`it top1 ${sec === "docs" ? "on" : ""}`} href={href(p.id, "docs")}>
              <span>{collapsed ? "Документы" : "Документы проекта"}</span>
              {!collapsed && (
                <span className="chip gry st">
                  {docCount} из {plot.DOCUMENT_KINDS.length}
                </span>
              )}
            </Link>
          </div>
        </aside>
        <main className="main">
          {sec === "plot" ? (
            <>
              <div className="mhead">
                <h2>Проект и участок</h2>
              </div>
              <div className="tabs">
                {PLOT_TABS.map((t) => (
                  <Link key={t} className={t === tab ? "on" : ""} href={href(p.id, "plot", t)}>
                    {t}
                    {t === "Участок" && status.missing > 0 && <span className="tdot" />}
                  </Link>
                ))}
              </div>
              {tab === "Участок" && (
                <>
                  {status.noCadastralNumber ? (
                    <div className="check warn">
                      <div>
                        Участок без кадастрового номера. Кадастровая стоимость не учтена, форму права и ВРИ нужно ввести вручную. Когда номер появится, введите его и загрузите выписку ЕГРН: её данные заменят введённые значения.
                      </div>
                      <button className="btn sm" onClick={() => setEditing("cadastralNumber")}>
                        Ввести номер
                      </button>
                    </div>
                  ) : (
                    !hasEgrn && (
                      <div className="check warn">
                        <div>Загрузите выписку ЕГРН по участку {view.plot.cadastralNumber.value}: из неё заполнятся площадь, ВРИ, кадастровая стоимость и право.</div>
                        <button className="btn sm" onClick={() => egrnInput.current?.click()} disabled={reading}>
                          {reading ? "Читаем…" : "Загрузить выписку"}
                        </button>
                      </div>
                    )
                  )}
                  {problems.map((t) => (
                    <div key={t} className="check warn">
                      {t}
                    </div>
                  ))}
                  <div className="fgrid">
                    {plot.PLOT_FIELDS.map((f) => (
                      <FieldRow key={f.key} p={view} field={f} onEdit={setEditing} />
                    ))}
                  </div>
                  {hasEgrn && (
                    <div style={{ marginTop: 14 }}>
                      <button className="btn" onClick={() => egrnInput.current?.click()} disabled={reading}>
                        {reading ? "Читаем выписку…" : "Загрузить новую выписку ЕГРН"}
                      </button>
                    </div>
                  )}
                </>
              )}
              {tab === "Проект" && <ProjectTab p={p} onSave={async (next, msg) => { await persist(next); flash(msg); }} />}
              {tab === "История" && <HistoryTab p={p} />}
            </>
          ) : (
            <>
              <div className="mhead">
                <h2>Документы проекта</h2>
                <span className="chip gry">
                  Загружено {docCount} из {plot.DOCUMENT_KINDS.length}
                </span>
                <span className="sp" />
                <button
                  className="btn"
                  onClick={() => {
                    setDocKind("other");
                    docInput.current?.click();
                  }}
                >
                  + Другой документ
                </button>
              </div>
              {problems.map((t) => (
                <div key={t} className="check warn">
                  {t}
                </div>
              ))}
              <div className="tw">
                <table className="t">
                  <thead>
                    <tr>
                      <th>Документ</th>
                      <th className="l">Что подтверждает</th>
                      <th className="l">Файл</th>
                    </tr>
                  </thead>
                  <tbody>
                    {[...plot.DOCUMENT_KINDS, ...(p.documents.some((d) => d.kind === "other") ? [{ kind: "other" as const, title: plot.OTHER_DOCUMENT_TITLE, confirms: "—" }] : [])].map((k) => {
                      const docs = p.documents.filter((d) => d.kind === k.kind);
                      const upload = () => {
                        if (k.kind === "egrn") egrnInput.current?.click();
                        else {
                          setDocKind(k.kind);
                          docInput.current?.click();
                        }
                      };
                      return (
                        <tr key={k.kind}>
                          <td>{k.title}</td>
                          <td className="l">{k.kind === "egrn" ? <Link href={href(p.id, "plot", "Участок")}>{k.confirms}</Link> : k.confirms}</td>
                          <td className="l">
                            {docs.map((d) => (
                              <div key={d.id}>
                                <a
                                  onClick={async () => {
                                    const f = await getFile(d.id);
                                    if (f) void download(f.name, f.blob);
                                    else flash("Файл не найден в этом браузере");
                                  }}
                                >
                                  ⭳ {d.fileName}
                                </a>{" "}
                                <span className="small muted">{text.date(d.uploadedAt.slice(0, 10))}</span>
                              </div>
                            ))}
                            <button className="btn sm" onClick={upload} disabled={reading && k.kind === "egrn"} style={docs.length ? { marginTop: 4 } : undefined}>
                              {docs.length ? "Загрузить ещё" : "Загрузить"}
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </main>
      </div>
      <input ref={egrnInput} type="file" accept={EGRN_ACCEPT} hidden onChange={(e) => { void onEgrn(e.target.files?.[0]); e.target.value = ""; }} />
      <input
        ref={docInput}
        type="file"
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = "";
          if (f) void addDocument(f, docKind).then(() => flash("Документ загружен"));
        }}
      />
      {editing && (
        <EditField
          p={view}
          field={plot.plotField(editing)}
          onClose={() => setEditing(null)}
          onApply={(set) => {
            setPending((prev) => plot.mergeChanges(prev, set.changes));
            setProblems(set.problems);
            setEditing(null);
          }}
        />
      )}
      {pending.length > 0 && (
        <div className="dirty">
          <div className="row" style={{ marginBottom: 6 }}>
            <b>Несохранённые изменения</b>
          </div>
          <div className="rows">
            {plot.changeRows(pending).map((r) => (
              <div key={r.field} className="chg">
                <div className="l">{r.label}</div>
                <div>
                  <span className="from">{r.from}</span> → <b>{r.to}</b>
                </div>
              </div>
            ))}
          </div>
          <div className="mf" style={{ marginTop: 10 }}>
            <button
              className="btn"
              onClick={() => {
                setPending([]);
                setProblems([]);
              }}
            >
              Отменить
            </button>
            <button className="btn pri" onClick={() => void save()}>
              Сохранить
            </button>
          </div>
        </div>
      )}
      <Toast text={toast} />
    </>
  );
}

function ProjectTab({ p, onSave }: { p: LandProject; onSave: (next: LandProject, message: string) => Promise<void> }) {
  const [name, setName] = useState(p.name ?? "");
  const [point, setPoint] = useState<plot.GeoPoint | null>(p.point);
  const changed = name.trim() !== (p.name ?? "") || JSON.stringify(point) !== JSON.stringify(p.point);
  return (
    <div className="frm" style={{ maxWidth: 640 }}>
      <label>
        Название
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder={plot.projectTitle({ ...p, name: null })} />
      </label>
      <div className="frm" style={{ gap: 6 }}>
        <span style={{ fontSize: 13, color: "var(--ink2)" }}>Точка на карте</span>
        <MapPicker value={point} onChange={setPoint} />
        <span className="hint">{point ? pointText(point) : "Нажмите на карту, чтобы поставить точку"}</span>
      </div>
      <div>
        <button className="btn pri" disabled={!changed} onClick={() => void onSave({ ...p, name: name.trim() || null, point, updatedAt: nowIso() }, "Проект сохранён")}>
          Сохранить
        </button>
      </div>
    </div>
  );
}

function HistoryTab({ p }: { p: LandProject }) {
  if (!p.history.length) return <div className="card empty">Изменений пока нет: значения такие, как при создании проекта.</div>;
  return (
    <div className="tw">
      <table className="t">
        <thead>
          <tr>
            <th>Показатель</th>
            <th className="l">Дата</th>
            <th className="l">Было</th>
            <th className="l">Стало</th>
            <th className="l">Основание</th>
          </tr>
        </thead>
        <tbody>
          {[...p.history].reverse().map((h, i) => (
            <tr key={i}>
              <td>{plot.plotField(h.field).label}</td>
              <td className="l">{text.date(h.at.slice(0, 10))}</td>
              <td className="l">{h.from}</td>
              <td className="l">{h.to}</td>
              <td className="l">{h.basis}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
