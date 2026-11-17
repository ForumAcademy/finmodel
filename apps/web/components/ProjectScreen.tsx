"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { book, geocode, plot, projectFile, site, summary, text } from "@fm/engine";
import { EGRN_ACCEPT } from "@fm/egrn-import";
import { download, readEgrn } from "@/lib/egrn";
import { saveProjectFile } from "@/lib/files";
import { findByAddress } from "@/lib/geocode";
import { getFile, getProject, getReference, newId, nowIso, saveFile, saveProject } from "@/lib/store";
import { Chip, ExpertFields, FieldTable, Modal, OriginTag, Toast, WhereToFind, type FieldItem } from "./ui";
import { MapPicker, pointText } from "./MapPicker";
import { AnalysisArea, SiteFields, type AnalysisSec } from "./AnalysisScreens";

type LandProject = plot.LandProject;
type PlotFieldKey = plot.PlotFieldKey;

export type ProjectSection = "plot" | "model" | AnalysisSec;
const PLOT_TABS = ["Участок", "Сделка", "Документы", "История"] as const;
type PlotTab = (typeof PLOT_TABS)[number];

const href = (id: string, sec: ProjectSection, tab?: string) => `/projects/${id}?sec=${sec}${tab ? `&tab=${encodeURIComponent(tab)}` : ""}`;

/** Меню проекта: Итог и шаги по порядку; «Финмодель» появится на этапе 6. */
const STEPS: readonly { sec: ProjectSection; num: string; title: string; short: string; later?: boolean }[] = [
  { sec: "summary", num: "★", title: "Итог", short: "Итог" },
  { sec: "plot", num: "1", title: "Участок", short: "Участок" },
  { sec: "site", num: "2", title: "Что можно построить", short: "Что строить" },
  { sec: "market", num: "3", title: "Рынок", short: "Рынок" },
  { sec: "variants", num: "4", title: "Варианты", short: "Варианты" },
  { sec: "model", num: "5", title: "Финмодель", short: "Финмодель", later: true },
];
const today = () => nowIso().slice(0, 10);

// ---------- поле участка ----------

function BasisLink({ p, basis }: { p: LandProject; basis: plot.ValueBasis | null }) {
  if (!basis) return null;
  const label = plot.basisText(basis);
  if (basis.documentId && p.documents.some((d) => d.id === basis.documentId)) {
    return (
      <Link className="org basis" href={href(p.id, "plot", "Документы")}>
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

/** Поле участка строкой шага: пустое обязательное — в «Не хватает», введённое — в таблицу. */
function plotItem(p: LandProject, field: plot.PlotField, onEdit: (k: PlotFieldKey) => void): FieldItem {
  const v = p.plot[field.key];
  const shown = plot.plotText(field.key, v.value);
  const unit = field.unit ? ` ${field.unit}` : "";
  return {
    key: field.key,
    label: field.label,
    value: shown ? `${shown}${unit}` : field.key === "cadastralValue" ? "не учтено" : "",
    missing: field.required && v.value === null,
    origin:
      v.value === null ? (
        <span className="small muted">необязательно</span>
      ) : (
        <>
          <OriginTag origin={v.origin} /> <BasisLink p={p} basis={v.basis} />
        </>
      ),
    note: plot.basisNote(v.basis, (x) => `${plot.plotText(field.key, x)}${unit}`),
    where: field.where,
    onEdit: () => onEdit(field.key),
  };
}

// ---------- изменение поля ----------

function EditField({ p, field, onApply, onClose }: { p: LandProject; field: plot.PlotField; onApply: (set: plot.ChangeSet) => void; onClose: () => void }) {
  const cur = p.plot[field.key];
  const [value, setValue] = useState(plot.plotText(field.key, cur.value));
  const [docId, setDocId] = useState(cur.basis?.documentId ?? "");
  const [form, setForm] = useState(plot.expertForm(cur.basis, (x) => plot.plotText(field.key, x)));
  const [error, setError] = useState<string | null>(null);
  const isKn = field.key === "cadastralNumber";
  const numeric = field.kind === "area" || field.kind === "money";

  function apply(clear = false) {
    const doc = p.documents.find((d) => d.id === docId);
    const docBasis: plot.ValueBasis | null = doc ? { title: plot.documentTitle(doc.kind), documentId: doc.id, date: today() } : null;
    if (isKn) {
      const set = plot.cadastralNumberChanges(p, value, docBasis ?? { title: form.title.trim() || "Введено вручную", date: today(), ...(form.author.trim() ? { author: form.author.trim() } : {}) });
      if (set.problems.length && !set.changes.length) return setError(set.problems.join(" "));
      return onApply(set);
    }
    if (clear) return onApply({ changes: plot.manualChange(p, field.key, null, docBasis ?? { title: form.title.trim(), date: today() }), problems: [] });
    let v: string | null = value.trim();
    if (numeric) {
      v = plot.parseNumberRu(value);
      if (v === null) return setError(`«${value}» — не число. Введите число, например 32 000.`);
    }
    if (!v) return setError("Введите значение или удалите его кнопкой «Нет значения».");
    if (docBasis) return onApply({ changes: plot.manualChange(p, field.key, v, docBasis), problems: [] });
    const b = plot.expertBasis(form, today(), numeric ? plot.plotExpertNumeric(field.key, v) : undefined);
    if ("error" in b) return setError(b.error);
    onApply({ changes: plot.manualChange(p, field.key, v, b.basis), problems: [] });
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
        <WhereToFind className="hint" text={field.where} />
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
        {!docId && <ExpertFields form={form} onChange={setForm} placeholder="Например, письмо продавца от 22.09.2026" unit={field.unit} numeric={numeric} />}
        {error && <div className="err">{error}</div>}
      </div>
    </Modal>
  );
}

// ---------- экран проекта ----------

export function ProjectScreen({ id, sec, tab: rawTab }: { id: string; sec: ProjectSection; tab: string | undefined }) {
  const tab: PlotTab = PLOT_TABS.find((t) => t === rawTab) ?? "Участок";
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
  const [versions, setVersions] = useState<book.AssumptionVersion[]>([]);
  const [updating, setUpdating] = useState(false);
  const [missingDocs, setMissingDocs] = useState<string[]>([]);
  const [geoBusy, setGeoBusy] = useState(false);
  const [geoFailed, setGeoFailed] = useState(false);
  const [geoChoices, setGeoChoices] = useState<{ query: string; candidates: geocode.GeoCandidate[] } | null>(null);
  const geoAuto = useRef(false);

  useEffect(() => {
    getProject(id).then(setProject, () => setProject(null));
    getReference().then(setVersions, () => setVersions([]));
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

  const applyFound = useCallback(
    async (proj: LandProject, query: string, c: geocode.GeoCandidate) => {
      const r = geocode.applyGeocode(proj, c, query, nowIso());
      await saveProject(r.project);
      setProject(r.project);
      setGeoChoices(null);
      setProblems(r.problems);
      flash(`Найдено по адресу: ${c.locality.join(", ") || c.label}`);
    },
    [flash],
  );

  const findPlace = useCallback(
    async (proj: LandProject) => {
      setGeoBusy(true);
      try {
        const r = await findByAddress(proj);
        setGeoFailed("error" in r);
        if ("error" in r) {
          setProblems([r.error]);
          return;
        }
        const houses = r.candidates.filter((c) => c.house);
        // Несколько разных домов — пусть финансист выберет; иначе берём первый (дом, если есть).
        if (houses.length > 1) setGeoChoices({ query: r.query, candidates: houses });
        else await applyFound(proj, r.query, r.candidates[0] as geocode.GeoCandidate);
      } finally {
        setGeoBusy(false);
      }
    },
    [applyFound],
  );

  // Первый поиск — сам, когда проект открыт впервые после создания с адресом.
  useEffect(() => {
    if (!project || project.geo || !project.plot.address.value || geoAuto.current) return;
    geoAuto.current = true;
    void findPlace(project);
  }, [project, findPlace]);

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
  const ref = versions.length ? book.projectReference(p, versions) : null;
  const own = projectFile.projectReferenceVersion(p, versions);
  const latest = versions.at(-1) ?? null;
  const refChanges = ref?.updateTo && own && latest ? book.itemChanges(own.items, latest.items) : [];

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

  async function toFile() {
    const missing = await saveProjectFile(p);
    setMissingDocs(missing);
    if (!missing.length) flash("Файл проекта скачан");
  }

  async function updateRef() {
    await persist(book.updateReference(p, versions, nowIso()));
    setUpdating(false);
    flash(`Проект переведён на версию ${latest?.version ?? ""} справочника`);
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

  const todoList = summary.todoList(view);
  const todo = todoList.length;
  const docCount = plot.DOCUMENT_KINDS.filter((k) => p.documents.some((d) => d.kind === k.kind)).length;
  const counted = !!site.siteOf(p).snapshot?.best;
  /** Отметка шага в меню: сколько ввести, ✓ или «этап 6». */
  const badge = (m: (typeof STEPS)[number]) => {
    if (m.later) return <span className="chip gry st">этап 6</span>;
    if (m.sec === "summary") return todo > 0 ? <span className="chip yel st">{todo}</span> : null;
    if (m.sec === "variants") return counted ? <span className="stok st">✓</span> : null;
    const n = summary.todoCount(todoList, m.sec as summary.TodoSection);
    return n > 0 ? <span className="chip yel st">{n}</span> : <span className="stok st">✓</span>;
  };
  const save2 = async (next: LandProject, msg: string) => {
    await persist(next);
    if (msg) flash(msg);
  };

  return (
    <>
      <div className="phead">
        <Link className="back" href="/">
          ← Все проекты
        </Link>
        <div className="ttl">
          <h1>{plot.projectTitle(view)}</h1>
          {status.noCadastralNumber && <Chip tone="yel">Участок без кадастрового номера</Chip>}
          <button className="btn sm hbtn" onClick={() => void toFile()}>
            Сохранить проект в файл
          </button>
        </div>
        <div className="sub2">{plot.projectSubtitle(view)}</div>
      </div>
      <div className="shell">
        <aside className={`side ${collapsed ? "col" : ""}`}>
          <button className="collapse" onClick={toggleMenu}>
            {collapsed ? "»" : "« Свернуть меню"}
          </button>
          <div className="grp">
            {STEPS.map((m) => (
              <Link key={m.sec} className={`it top1 ${m.later ? "later" : ""} ${sec === m.sec ? "on" : ""}`} href={href(p.id, m.sec)}>
                <span className="num">{m.num}</span>
                <span>{collapsed ? m.short : m.title}</span>
                {!collapsed && badge(m)}
              </Link>
            ))}
          </div>
        </aside>
        <main className="main">
          {/* Узкий экран: меню слева скрыто, шаги — строкой над содержимым */}
          <nav className="mnav">
            {STEPS.map((m) => (
              <Link key={m.sec} className={sec === m.sec ? "on" : ""} href={href(p.id, m.sec)}>
                {m.num === "★" ? m.title : `${m.num}. ${m.short}`}
              </Link>
            ))}
          </nav>
          {sec === "summary" || sec === "site" || sec === "market" || sec === "variants" ? (
            <AnalysisArea
              p={p}
              sec={sec}
              tab={rawTab}
              versions={versions}
              href={(s, t) => href(p.id, s, t)}
              onEditPlot={setEditing}
              refInfo={ref ? { text: ref.text, updateTo: ref.updateTo, onUpdate: () => setUpdating(true) } : null}
              onSave={save2}
            />
          ) : sec === "model" ? (
            <>
              <div className="mhead">
                <h2>5. Финмодель выбранного варианта</h2>
              </div>
              <div className="card empty">
                Появится на этапе 6: вводные выбранного варианта (ТЭП, график, продажи, затраты, финансирование, налоги) и расчёт — план продаж, бюджет, эскроу, денежный поток по годам, кварталам или месяцам, с пояснением к каждой строке.
              </div>
            </>
          ) : (
            <>
              <div className="mhead">
                <h2>1. Участок</h2>
              </div>
              <div className="tabs">
                {PLOT_TABS.map((t) => {
                  const n = t === "Участок" ? status.missing : t === "Сделка" ? todoList.filter((i) => i.sec === "plot" && i.tab === "Сделка").length : 0;
                  return (
                    <Link key={t} className={t === tab ? "on" : ""} href={href(p.id, "plot", t)}>
                      {t === "Документы" ? `Документы · ${docCount} из ${plot.DOCUMENT_KINDS.length}` : t}
                      {n > 0 && <span className="tdot" />}
                    </Link>
                  );
                })}
              </div>
              {tab === "Участок" && (
                <>
                  {status.noCadastralNumber ? (
                    <div className="check warn">
                      <div>Участок без кадастрового номера: кадастровая стоимость не учтена. Когда номер появится, введите его или загрузите выписку ЕГРН — её данные заменят введённые.</div>
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
                  <div className={`check ${p.geo ? "ok" : ""}`}>
                    <div>
                      <b>Где участок.</b> {p.geo ? geocode.geoText(p.geo) : geoBusy ? "Ищем по адресу, это может занять до минуты…" : geoFailed ? "По адресу участок не найден, причина выше." : "Сервис ещё не искал участок по адресу."}
                    </div>
                    <button className="btn sm" onClick={() => void findPlace(p)} disabled={geoBusy || !view.plot.address.value}>
                      {geoBusy ? "Ищем…" : "Найти данные по адресу"}
                    </button>
                  </div>
                  {geoChoices && (
                    <div className="check warn">
                      <div>
                        По адресу нашлось несколько домов. Выберите нужный:
                        <ul style={{ margin: "6px 0 0", paddingLeft: 18 }}>
                          {geoChoices.candidates.map((c) => (
                            <li key={c.label}>
                              <button className="btn sm" style={{ margin: "3px 0" }} onClick={() => void applyFound(p, geoChoices.query, c)}>
                                {c.label}
                              </button>
                            </li>
                          ))}
                        </ul>
                      </div>
                    </div>
                  )}
                  <FieldTable items={plot.PLOT_FIELDS.map((f) => plotItem(view, f, setEditing))} />
                  <p className="small muted">
                    Где взять данные участка и как их внести — <Link href="/reference/where">Справочник → Где взять данные</Link>
                  </p>
                  {hasEgrn && (
                    <div style={{ marginTop: 14 }}>
                      <button className="btn" onClick={() => egrnInput.current?.click()} disabled={reading}>
                        {reading ? "Читаем выписку…" : "Загрузить новую выписку ЕГРН"}
                      </button>
                    </div>
                  )}
                  <h3 className="h3">Название и точка на карте</h3>
                  <ProjectTab key={JSON.stringify(p.point)} p={p} onSave={save2} />
                </>
              )}
              {tab === "Сделка" && <SiteFields p={p} keys={site.DEAL_FIELDS} required={{ landPrice: "Без неё затраты на покупку участка не учтены." }} onSave={save2} />}
              {tab === "История" && <HistoryTab p={p} />}
              {tab === "Документы" && (
                <>
                  <p className="small muted">Загруженный документ становится источником для полей, которые он подтверждает.</p>
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
                  <div style={{ marginTop: 12 }}>
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
                </>
              )}
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
      {updating && latest && (
        <Modal
          title={`Перейти на версию ${latest.version} справочника?`}
          onClose={() => setUpdating(false)}
          wide
          footer={
            <>
              <button className="btn" onClick={() => setUpdating(false)} style={{ marginRight: "auto" }}>
                Отмена
              </button>
              <button className="btn pri" onClick={() => void updateRef()}>
                Обновить
              </button>
            </>
          }
        >
          <p>
            Версия {latest.version} от {text.date(latest.date)} · {latest.author} · {latest.note}
          </p>
          {refChanges.length ? (
            <div className="tw">
              <table className="t">
                <thead>
                  <tr>
                    <th>Показатель</th>
                    <th className="l">Было</th>
                    <th className="l">Стало</th>
                  </tr>
                </thead>
                <tbody>
                  {refChanges.map((c) => (
                    <tr key={`${c.param}-${c.what}`}>
                      <td>
                        {c.name}
                        {c.what !== "Значение" && <div className="small muted">{c.what}</div>}
                      </td>
                      <td className="l">{c.from}</td>
                      <td className="l">{c.to}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="small muted">Стандартные значения в этих версиях одинаковые.</p>
          )}
          <p className="small muted">Значения, которые вы задали в проекте сами, не изменятся. Переход запишется в историю проекта.</p>
        </Modal>
      )}
      {missingDocs.length > 0 && (
        <Modal
          title="Проект сохранён без части документов"
          onClose={() => setMissingDocs([])}
          footer={
            <button className="btn pri" onClick={() => setMissingDocs([])}>
              Понятно
            </button>
          }
        >
          <p>В этом браузере нет файлов: {missingDocs.join(", ")}. Остальное сохранено. Загрузите эти документы в проект заново и сохраните файл ещё раз.</p>
        </Modal>
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
              <td>{plot.historyLabel(h.field)}</td>
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
