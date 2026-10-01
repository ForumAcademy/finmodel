"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { competitors as cmp, plot, text } from "@fm/engine";
import { readJson, saveCompetitorsFile, storedFiles } from "@/lib/files";
import { deleteCompetitor, deleteFile, getFile, listCompetitors, listProjects, newId, nowIso, saveCompetitor, saveFile, saveStoredFile } from "@/lib/store";
import { Chip, Modal, OriginTag, Toast } from "./ui";

type Competitor = cmp.Competitor;
type LandProject = plot.LandProject;

const today = () => new Date().toISOString().slice(0, 10);

function CompetitorCard({ c, projects, onOpen }: { c: Competitor; projects: Map<string, LandProject>; onOpen: () => void }) {
  const last = cmp.latestSnapshot(c);
  const pace = cmp.competitorPace(c);
  return (
    <div className="card pcard" onClick={onOpen}>
      <div className="t">{c.name}</div>
      <div className="s">{[c.district, c.metro, c.developer].filter(Boolean).join(" · ") || "—"}</div>
      <div className="hr" />
      <div className="kgrid">
        <div className="k">
          <b>{cmp.numText(last?.avgPrice)}</b>
          <div>цена 1 м², руб</div>
        </div>
        <div className="k">
          <b>{cmp.soldShareText(last)}</b>
          <div>продано по площади</div>
        </div>
        <div className="k">
          <b>{cmp.paceText(pace)}</b>
          <div>{pace.origin ? <OriginTag origin={pace.origin} /> : "темп продаж"}</div>
        </div>
      </div>
      <div className="row" style={{ flexWrap: "wrap", gap: 8, marginTop: 10 }}>
        <Chip tone="gry">{c.classText ?? c.housingClass}</Chip>
        {c.links.map((l) => (
          <Chip key={l.projectId} tone="acc">
            {projects.has(l.projectId) ? plot.projectTitle(projects.get(l.projectId)!) : "проект не в этом браузере"}
          </Chip>
        ))}
        {cmp.needsUpdate(c, today()) && <Chip tone="yel">Пора обновить</Chip>}
      </div>
      <div className="small muted" style={{ marginTop: 8 }}>
        {last ? `Данные на ${text.date(last.date)}` : "Данных карточки пока нет"}
      </div>
    </div>
  );
}

export function CompetitorsScreen() {
  const [all, setAll] = useState<Competitor[] | null>(null);
  const [projects, setProjects] = useState<LandProject[]>([]);
  const [q, setQ] = useState("");
  const [forProject, setForProject] = useState("");
  const [onlyLinked, setOnlyLinked] = useState(false);
  const [open, setOpen] = useState<Competitor | "new" | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [notice, setNotice] = useState<string[] | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const reload = () => listCompetitors().then(setAll, () => setAll([]));
  useEffect(() => {
    void reload();
    void listProjects().then((ps) => setProjects(ps.filter((p) => !p.archived)), () => setProjects([]));
  }, []);
  const flash = (t: string) => {
    setToast(t);
    setTimeout(() => setToast(null), 2600);
  };

  const byId = new Map(projects.map((p) => [p.id, p]));
  const needle = q.trim().toLowerCase();
  const list = (all ?? []).filter(
    (c) =>
      (!needle || [c.name, c.developer ?? "", c.district ?? "", c.metro ?? ""].some((s) => s.toLowerCase().includes(needle))) &&
      (!forProject || !onlyLinked || cmp.linkOf(c, forProject)) &&
      (forProject || !onlyLinked || c.links.length > 0),
  );

  async function fromFile(f: File | undefined) {
    if (fileInput.current) fileInput.current.value = "";
    if (!f) return;
    const r = cmp.parseCompetitorsFile(await readJson(f));
    if (!r.file) return setNotice([r.error ?? "Файл не открыт."]);
    const { files, broken } = await storedFiles(r.file.files);
    for (const x of files) await saveStoredFile(x);
    const m = cmp.mergeCompetitors(all ?? [], r.file.competitors, nowIso());
    for (const c of m.competitors) await saveCompetitor(c);
    await reload();
    const lines = [`Новых ЖК: ${m.added}, обновлено: ${m.updated}.`];
    if (broken.length) lines.push(`Скриншоты повреждены и не открыты: ${broken.join(", ")}.`);
    setNotice(lines);
  }

  return (
    <div className="page">
      <div className="row">
        <h1>Проекты конкурентов</h1>
        <div style={{ flex: 1 }} />
        <button className="btn" onClick={() => fileInput.current?.click()}>
          Открыть файл конкурентов
        </button>
        <input ref={fileInput} type="file" accept=".json,application/json" hidden onChange={(e) => void fromFile(e.target.files?.[0])} />
        <button className="btn" disabled={!all?.length} onClick={() => void saveCompetitorsFile().then(() => flash("Файл конкурентов скачан"))}>
          Сохранить в файл
        </button>
        <button className="btn pri" onClick={() => setOpen("new")}>
          + Конкурент
        </button>
      </div>
      <div className="small muted" style={{ marginTop: 6 }}>
        Карточки ЖК рядом с нашими участками. Раз в месяц добавляйте данные карточки на новую дату: по ним считаются цена, распроданность и темп продаж в аналогах проекта. Карточки хранятся в этом браузере — сохраните их в файл, чтобы передать коллегам.
      </div>
      <div className="ptoolbar" style={{ flexWrap: "wrap" }}>
        <input className="search" placeholder="Поиск по названию, девелоперу, району" value={q} onChange={(e) => setQ(e.target.value)} />
        <label className="row small" style={{ gap: 8 }}>
          Является конкурентом для
          <select className="search" value={forProject} onChange={(e) => setForProject(e.target.value)} style={{ minWidth: 200 }}>
            <option value="">любого нашего проекта</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {plot.projectTitle(p)}
              </option>
            ))}
          </select>
        </label>
        <label className="row small" style={{ gap: 6 }}>
          <input type="checkbox" checked={onlyLinked} onChange={(e) => setOnlyLinked(e.target.checked)} />
          Только привязанные
        </label>
        <span className="small muted">Всего ЖК: {(all ?? []).length}</span>
      </div>
      {all === null ? null : list.length ? (
        <div className="pgrid">
          {list.map((c) => (
            <CompetitorCard key={c.id} c={c} projects={byId} onOpen={() => setOpen(c)} />
          ))}
        </div>
      ) : (
        <div className="card empty">
          {all.length === 0 ? (
            <>
              <p>Конкурентов пока нет. Добавьте ЖК по карточке bnMAP или откройте файл конкурентов.</p>
              <button className="btn pri" onClick={() => setOpen("new")}>
                + Конкурент
              </button>
            </>
          ) : (
            "Ничего не найдено"
          )}
        </div>
      )}
      {open && (
        <CompetitorModal
          key={open === "new" ? "new" : open.id}
          competitor={open === "new" ? null : open}
          projects={projects}
          onClose={() => setOpen(null)}
          onSaved={async (c, msg) => {
            await saveCompetitor(c);
            await reload();
            setOpen(c);
            flash(msg);
          }}
          onDelete={async (c) => {
            for (const s of c.snapshots) if (s.fileId) await deleteFile(s.fileId);
            await deleteCompetitor(c.id);
            await reload();
            setOpen(null);
            flash("Конкурент удалён");
          }}
        />
      )}
      {notice && (
        <Modal
          title="Файл конкурентов"
          onClose={() => setNotice(null)}
          footer={
            <button className="btn pri" onClick={() => setNotice(null)}>
              Понятно
            </button>
          }
        >
          {notice.map((l) => (
            <p key={l}>{l}</p>
          ))}
        </Modal>
      )}
      <Toast text={toast} />
    </div>
  );
}

// ---------- карточка конкурента ----------

type Tab = "data" | "about" | "links";

function CompetitorModal({
  competitor,
  projects,
  onClose,
  onSaved,
  onDelete,
}: {
  competitor: Competitor | null;
  projects: LandProject[];
  onClose: () => void;
  onSaved: (c: Competitor, msg: string) => Promise<void>;
  onDelete: (c: Competitor) => Promise<void>;
}) {
  const [tab, setTab] = useState<Tab>(competitor ? "data" : "about");
  const [snap, setSnap] = useState<cmp.CompetitorSnapshot | "new" | null>(null);
  const c = competitor;
  return (
    <Modal
      title={c ? c.name : "Новый конкурент"}
      onClose={onClose}
      wide
      footer={
        <>
          {c && (
            <button className="btn danger" onClick={() => void onDelete(c)} style={{ marginRight: "auto" }}>
              Удалить
            </button>
          )}
          <button className="btn" onClick={onClose}>
            Закрыть
          </button>
        </>
      }
    >
      {c && (
        <div className="tabs">
          <button className={tab === "data" ? "on" : ""} onClick={() => setTab("data")}>
            Данные по месяцам
          </button>
          <button className={tab === "about" ? "on" : ""} onClick={() => setTab("about")}>
            Описание
          </button>
          <button className={tab === "links" ? "on" : ""} onClick={() => setTab("links")}>
            Наши проекты · {c.links.length}
          </button>
        </div>
      )}
      {tab === "about" && <AboutForm c={c} onSaved={onSaved} />}
      {c && tab === "data" && <SnapshotsTab c={c} onAdd={() => setSnap("new")} onEdit={setSnap} />}
      {c && tab === "links" && <LinksTab c={c} projects={projects} onSaved={onSaved} />}
      {c && snap && (
        <SnapshotModal
          c={c}
          snapshot={snap === "new" ? null : snap}
          onClose={() => setSnap(null)}
          onSaved={async (next, msg) => {
            setSnap(null);
            await onSaved(next, msg);
          }}
        />
      )}
    </Modal>
  );
}

function AboutForm({ c, onSaved }: { c: Competitor | null; onSaved: (c: Competitor, msg: string) => Promise<void> }) {
  const [form, setForm] = useState<cmp.CompetitorForm>(() => cmp.competitorToForm(c));
  const [errors, setErrors] = useState<string[]>([]);
  const set = (k: keyof cmp.CompetitorForm) => (e: { target: { value: string } }) => setForm((f) => ({ ...f, [k]: e.target.value }));
  function save() {
    const r = cmp.competitorFromForm(form, c, c?.id ?? newId(), nowIso());
    if (!r.competitor) return setErrors(r.errors);
    setErrors([]);
    void onSaved(r.competitor, c ? "Описание сохранено" : "Конкурент добавлен: внесите данные карточки за месяц");
  }
  const field = (k: keyof cmp.CompetitorForm, label: string, ph?: string) => (
    <label>
      {label}
      <input value={form[k]} onChange={set(k)} placeholder={ph} />
    </label>
  );
  return (
    <div className="frm">
      <div className="row2">
        {field("name", "ЖК *")}
        {field("url", "Ссылка на карточку ЖК *", "https://")}
      </div>
      <div className="row2">
        {field("developer", "Девелопер")}
        {field("salesStart", "Старт продаж", "ДД.ММ.ГГГГ")}
      </div>
      <div className="row2">
        {field("district", "Округ, район", "ВАО, Сокольники")}
        {field("metro", "Метро")}
      </div>
      <div className="row2">
        <label>
          Продукт *
          <select value={form.product} onChange={set("product")}>
            {["квартиры", "апартаменты"].map((o) => (
              <option key={o}>{o}</option>
            ))}
          </select>
        </label>
        {field("classText", "Класс в карточке", "Бизнес-")}
      </div>
      <div className="row2">
        <label>
          Класс для расчёта *
          <select value={form.housingClass || cmp.classFromText(form.classText)} onChange={set("housingClass")}>
            <option value="">—</option>
            {["эконом", "комфорт", "бизнес", "премиум"].map((o) => (
              <option key={o}>{o}</option>
            ))}
          </select>
        </label>
        {field("construction", "Конструктив", "Монолит-блоки")}
      </div>
      <div className="row2">
        {field("floors", "Этажность", "24–33")}
        {field("finish", "Отделка", "Без отделки")}
      </div>
      {field("contract", "Договор", "ДДУ с эскроу")}
      {errors.map((e) => (
        <div key={e} className="err">
          {e}
        </div>
      ))}
      <div className="row">
        <span className="sp" style={{ flex: 1 }} />
        <button className="btn pri" onClick={save}>
          {c ? "Сохранить описание" : "Добавить конкурента"}
        </button>
      </div>
    </div>
  );
}

function SnapshotsTab({ c, onAdd, onEdit }: { c: Competitor; onAdd: () => void; onEdit: (s: cmp.CompetitorSnapshot) => void }) {
  const pace = cmp.competitorPace(c);
  return (
    <>
      <div className="row" style={{ marginBottom: 10 }}>
        <div>
          Темп продаж: <b>{cmp.paceText(pace)}</b> {pace.origin && <OriginTag origin={pace.origin} />}
          <div className="small muted">{pace.note}</div>
        </div>
        <span style={{ flex: 1 }} />
        <button className="btn pri nowrap" style={{ flex: "none" }} onClick={onAdd}>
          + Данные за месяц
        </button>
      </div>
      {c.snapshots.length ? (
        <div className="tw">
          <table className="t">
            <thead>
              <tr>
                <th className="l">Данные на</th>
                <th>Цена 1 м²</th>
                <th>Проектная площадь</th>
                <th>Продано по площади</th>
                <th>На экспозиции</th>
                <th className="l">Источник</th>
              </tr>
            </thead>
            <tbody>
              {[...c.snapshots].reverse().map((s) => (
                <tr key={s.id} className="click" onClick={() => onEdit(s)}>
                  <td className="l">{text.date(s.date)}</td>
                  <td>{cmp.numText(s.avgPrice)} ₽</td>
                  <td>{cmp.numText(s.projectArea, 1)} м²</td>
                  <td>{cmp.soldShareText(s)}</td>
                  <td>
                    {cmp.numText(s.exposureLots)} лотов · {cmp.numText(s.exposureArea, 1)} м²
                  </td>
                  <td className="l">
                    <OriginTag origin="source" /> {s.fileName ? <FileLink id={s.fileId} name={s.fileName} /> : <span className="small muted">без скриншота</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="card empty">Данных пока нет. Добавьте данные карточки bnMAP на дату обновления.</div>
      )}
    </>
  );
}

function FileLink({ id, name }: { id: string | null; name: string }) {
  async function show(e: React.MouseEvent) {
    e.stopPropagation();
    const f = id ? await getFile(id) : null;
    if (f) window.open(URL.createObjectURL(f.blob), "_blank", "noopener");
  }
  return (
    <a className="org basis" href="#" onClick={(e) => void show(e)}>
      {name} ↗
    </a>
  );
}

function LinksTab({ c, projects, onSaved }: { c: Competitor; projects: LandProject[]; onSaved: (c: Competitor, msg: string) => Promise<void> }) {
  const [dist, setDist] = useState<Record<string, string>>(() => Object.fromEntries(c.links.map((l) => [l.projectId, l.distanceKm ? text.num(Number(l.distanceKm), 2) : ""])));
  const [error, setError] = useState<string | null>(null);
  const linked = new Set(c.links.map((l) => l.projectId));
  async function toggle(p: LandProject, on: boolean) {
    if (!on) return onSaved(cmp.unlink(c, p.id, nowIso()), "Конкурент отвязан от проекта");
    const r = cmp.linkTo(c, p.id, dist[p.id] ?? "", nowIso());
    if (!r.competitor) return setError(r.error);
    setError(null);
    await onSaved(r.competitor, "Конкурент привязан к проекту");
  }
  async function saveDist(p: LandProject) {
    if (!linked.has(p.id)) return;
    const r = cmp.linkTo(c, p.id, dist[p.id] ?? "", nowIso());
    if (!r.competitor) return setError(r.error);
    setError(null);
    await onSaved(r.competitor, "Расстояние сохранено");
  }
  if (!projects.length) return <div className="card empty">Проектов в этом браузере пока нет.</div>;
  return (
    <>
      <p className="small muted">
        Отметьте наши проекты, для которых этот ЖК — конкурент. В проекте на вкладке «Рынок» кнопка «Обновить из конкурентов» добавит его в аналоги.
      </p>
      <div className="tw">
        <table className="t">
          <thead>
            <tr>
              <th className="l">Наш проект</th>
              <th>Расстояние до участка, км</th>
            </tr>
          </thead>
          <tbody>
            {projects.map((p) => (
              <tr key={p.id}>
                <td className="l">
                  <label className="row" style={{ gap: 8 }}>
                    <input type="checkbox" checked={linked.has(p.id)} onChange={(e) => void toggle(p, e.target.checked)} />
                    {plot.projectTitle(p)}
                  </label>
                  {linked.has(p.id) && (
                    <Link className="small" href={`/projects/${p.id}?sec=market`}>
                      Рынок проекта →
                    </Link>
                  )}
                </td>
                <td>
                  <input
                    value={dist[p.id] ?? ""}
                    onChange={(e) => setDist((d) => ({ ...d, [p.id]: e.target.value }))}
                    onBlur={() => void saveDist(p)}
                    inputMode="decimal"
                    style={{ width: 90, textAlign: "right" }}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {error && <div className="err">{error}</div>}
    </>
  );
}

// ---------- данные карточки за месяц ----------

function SnapshotModal({ c, snapshot, onClose, onSaved }: { c: Competitor; snapshot: cmp.CompetitorSnapshot | null; onClose: () => void; onSaved: (c: Competitor, msg: string) => Promise<void> }) {
  const [form, setForm] = useState<cmp.SnapshotForm>(() => {
    const f = cmp.snapshotToForm(snapshot);
    if (snapshot) return f;
    // Новый месяц: описание стройки переносится из прошлого снимка, числа вводятся заново.
    const last = cmp.latestSnapshot(c);
    return { ...f, stage: last?.stage ?? "", rve: last?.rve ?? "" };
  });
  const [file, setFile] = useState<File | null>(null);
  const [errors, setErrors] = useState<string[]>([]);
  const set = (k: Exclude<keyof cmp.SnapshotForm, "byType">) => (e: { target: { value: string } }) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const setType = (t: cmp.RoomType, k: keyof cmp.RoomExposure) => (e: { target: { value: string } }) =>
    setForm((f) => ({ ...f, byType: { ...f.byType, [t]: { ...f.byType[t], [k]: e.target.value } } }));

  async function save() {
    const id = snapshot?.id ?? newId();
    const fileId = file ? newId() : (snapshot?.fileId ?? null);
    const r = cmp.snapshotFromForm(form, id, { fileId, fileName: file ? file.name : (snapshot?.fileName ?? null) });
    if (!r.snapshot) return setErrors(r.errors);
    if (file && fileId) {
      await saveFile(fileId, file);
      if (snapshot?.fileId) await deleteFile(snapshot.fileId);
    }
    await onSaved(cmp.withSnapshot(c, r.snapshot, nowIso()), "Данные за месяц сохранены");
  }
  async function remove() {
    if (!snapshot) return;
    if (snapshot.fileId) await deleteFile(snapshot.fileId);
    await onSaved(cmp.withoutSnapshot(c, snapshot.id, nowIso()), "Данные за месяц удалены");
  }
  const field = (k: Exclude<keyof cmp.SnapshotForm, "byType">, label: string, ph?: string) => (
    <label>
      {label}
      <input value={form[k]} onChange={set(k)} placeholder={ph} inputMode={k === "date" || k === "stage" || k === "rve" ? undefined : "decimal"} />
    </label>
  );
  return (
    <Modal
      title={`${c.name}: данные карточки`}
      onClose={onClose}
      wide
      footer={
        <>
          {snapshot && (
            <button className="btn danger" onClick={() => void remove()} style={{ marginRight: "auto" }}>
              Удалить
            </button>
          )}
          <button className="btn" onClick={onClose}>
            Отмена
          </button>
          <button className="btn pri" onClick={() => void save()}>
            Сохранить
          </button>
        </>
      }
    >
      <div className="frm">
        <p className="small muted">Перенесите цифры из карточки bnMAP: блоки «Описание проекта», «Экспозиция» (итого и по типам квартир) и «Остатки». Цены — как в карточке, с НДС.</p>
        <div className="row2">
          {field("date", "Данные обновлены от *", "ДД.ММ.ГГГГ")}
          <label>
            Скриншот карточки или отчёт
            <input type="file" accept="image/*,.pdf,.xlsx" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
            {!file && snapshot?.fileName && <span className="small muted">Сейчас: {snapshot.fileName}</span>}
          </label>
        </div>
        <div className="row2">
          {field("projectArea", "Проектная площадь лотов, м²")}
          {field("projectLots", "Проектное количество лотов")}
        </div>
        <div className="row2">
          {field("remainingAreaShare", "Остатки по площади, %")}
          {field("remainingLotsShare", "Остатки по количеству, %")}
        </div>
        <div className="row2">
          {field("stage", "Строительная готовность", "Монтажные и отделочные работы")}
          {field("rve", "Плановая дата РВЭ", "4 квартал 2027")}
        </div>
        <div className="h3">Экспозиция</div>
        <div className="tw">
          <table className="t">
            <thead>
              <tr>
                <th className="l" />
                <th>Лотов</th>
                <th>Площадь, м²</th>
                <th>Средняя цена 1 м², ₽ *</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td className="l">Итого</td>
                <td>
                  <input value={form.exposureLots} onChange={set("exposureLots")} inputMode="decimal" style={{ width: 90, textAlign: "right" }} />
                </td>
                <td>
                  <input value={form.exposureArea} onChange={set("exposureArea")} inputMode="decimal" style={{ width: 110, textAlign: "right" }} />
                </td>
                <td>
                  <input value={form.avgPrice} onChange={set("avgPrice")} inputMode="decimal" style={{ width: 120, textAlign: "right" }} />
                </td>
              </tr>
              {cmp.ROOM_TYPES.map((t) => (
                <tr key={t}>
                  <td className="l">{t}</td>
                  <td>
                    <input value={form.byType[t].lots} onChange={setType(t, "lots")} inputMode="decimal" style={{ width: 90, textAlign: "right" }} />
                  </td>
                  <td>
                    <input value={form.byType[t].area} onChange={setType(t, "area")} inputMode="decimal" style={{ width: 110, textAlign: "right" }} />
                  </td>
                  <td>
                    <input value={form.byType[t].price} onChange={setType(t, "price")} inputMode="decimal" style={{ width: 120, textAlign: "right" }} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="h3">Темп продаж</div>
        {field("soldArea12m", "Продано за последние 12 месяцев, м² — если есть выгрузка сделок bnMAP")}
        <p className="small muted">Без выгрузки темп считается по двум месяцам: насколько выросла проданная площадь (проектная площадь × (1 − остатки по площади)).</p>
        {errors.map((e) => (
          <div key={e} className="err">
            {e}
          </div>
        ))}
      </div>
    </Modal>
  );
}
