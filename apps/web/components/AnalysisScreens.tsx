"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { analysis, book, competitors as cmp, plot, site, siteView, text, zcyc } from "@fm/engine";
import { listCompetitors, newId, nowIso } from "@/lib/store";
import { loadZcyc } from "@/lib/zcyc";
import { Chip, ExpertFields, Modal, OriginTag } from "./ui";

type LandProject = plot.LandProject;
type SiteFieldKey = site.SiteFieldKey;
type VariantSummary = analysis.VariantSummary;

export const SITE_TABS = ["Градрегламент", "Зоны с ограничениями", "Нормативы", "Сделка", "Градпотенциал"] as const;
export type SiteTab = (typeof SITE_TABS)[number];

const today = () => nowIso().slice(0, 10);

// ---------- расчёт анализа ----------

/** Итоги вариантов по вводным: пересчёт только при изменении вводных или справочника. */
const cache = new Map<string, VariantSummary>();

export interface AnalysisState {
  calc: ReturnType<typeof site.siteCalcProject>;
  versions: book.AssumptionVersion[];
  sa: analysis.SiteAnalysis;
  variants: analysis.Variant[];
  summaries: VariantSummary[];
  done: boolean;
  choice: analysis.BestChoice | null;
}

/** Анализ участка проекта: градпотенциал и рынок сразу, варианты — по одному, чтобы экран не замирал. */
export function useAnalysis(p: LandProject, local: book.AssumptionVersion[]): AnalysisState {
  // Пересчёт — только когда меняются вводные расчёта, а не любая запись проекта (например, выбор варианта)
  const versionsKey = JSON.stringify(site.calcVersions(p, local));
  const versions = useMemo(() => JSON.parse(versionsKey) as book.AssumptionVersion[], [versionsKey]);
  const calcKey = JSON.stringify(site.siteCalcProject(p, today()));
  const calc = useMemo(() => JSON.parse(calcKey) as ReturnType<typeof site.siteCalcProject>, [calcKey]);
  const sa = useMemo(() => analysis.analyzeSite(calc, versions), [calc, versions]);
  const customKey = JSON.stringify(site.siteOf(p).customVariants);
  const variants = useMemo(() => site.allVariants({ ...p, site: { ...site.siteOf(p), customVariants: JSON.parse(customKey) } }, sa.variants), [customKey, sa]);
  const base = useMemo(() => JSON.stringify({ values: calc.input.values, version: versions.find((v) => v.version === calc.assumptionsVersion) ?? null }), [calc, versions]);
  const [summaries, setSummaries] = useState<VariantSummary[]>([]);
  const [done, setDone] = useState(false);

  useEffect(() => {
    let stop = false;
    const out: VariantSummary[] = [];
    setSummaries([]);
    setDone(variants.length === 0);
    const step = (i: number) => {
      if (stop) return;
      if (i >= variants.length) return setDone(true);
      const v = variants[i] as analysis.Variant;
      const key = `${base}|${v.id}`;
      let s = cache.get(key);
      if (!s) {
        s = analysis.computeVariant(calc, v, versions);
        cache.set(key, s);
      }
      out.push(s);
      setSummaries([...out]);
      setTimeout(() => step(i + 1), 0);
    };
    const t = setTimeout(() => step(0), 0);
    return () => {
      stop = true;
      clearTimeout(t);
    };
  }, [base, variants, calc, versions]);

  const choice = useMemo(() => (done && summaries.length ? analysis.chooseBest(calc, summaries, versions).choice : null), [done, summaries, calc, versions]);
  return { calc, versions, sa, variants, summaries, done, choice };
}

/** Сообщения ядра без повторов: что не так → что сделать. */
function uniqueTexts(messages: readonly { text: string; severity: string }[], severity = "error"): string[] {
  return [...new Set(messages.filter((m) => m.severity === severity).map((m) => m.text))];
}

// ---------- поле ограничения ----------

function BasisText({ basis }: { basis: plot.ValueBasis | { title: string; url: string | null } | null }) {
  if (!basis) return null;
  const label = plot.basisText(basis);
  if (basis.url) {
    return (
      <a className="org basis" href={basis.url} target="_blank" rel="noopener">
        {label} ↗
      </a>
    );
  }
  return <span className="org basis">{label}</span>;
}

function SiteFieldRow({ p, fieldKey, onEdit, required }: { p: LandProject; fieldKey: SiteFieldKey; onEdit: (k: SiteFieldKey) => void; required?: boolean }) {
  const f = site.siteField(fieldKey);
  const v = site.siteValue(p, fieldKey);
  const miss = !!required && v.value === null;
  return (
    <div className={`fld ${miss ? "miss" : ""}`}>
      <div className="lb">
        <span>{f.label}</span>
        <div className="meta">
          {(v.value !== null || required) && <OriginTag origin={v.origin} />}
          <BasisText basis={v.basis} />
        </div>
      </div>
      <div className="val">
        <button className={`shown ${f.kind === "text" ? "text" : ""}`} onClick={() => onEdit(fieldKey)} title="Изменить">
          {site.siteText(fieldKey, v.value) || (required ? "нет значения" : "—")}
        </button>
        {f.unit && <span className="u">{f.unit}</span>}
      </div>
      {plot.basisNote(v.basis, (x) => site.siteShow(fieldKey, x)) ? <div className="note">{plot.basisNote(v.basis, (x) => site.siteShow(fieldKey, x))}</div> : v.value === null && <div className="note">{f.hint}</div>}
    </div>
  );
}

function EditSiteField({ p, fieldKey, onApply, onClose }: { p: LandProject; fieldKey: SiteFieldKey; onApply: (c: site.SiteChange | null) => void; onClose: () => void }) {
  const f = site.siteField(fieldKey);
  const cur = site.siteValue(p, fieldKey);
  const [value, setValue] = useState(site.siteText(fieldKey, cur.value));
  const [docId, setDocId] = useState(cur.basis?.documentId ?? "");
  const [form, setForm] = useState(plot.expertForm(cur.basis, (x) => site.siteText(fieldKey, x)));
  const [error, setError] = useState<string | null>(null);

  function apply(clear = false) {
    const doc = p.documents.find((d) => d.id === docId);
    const docBasis: plot.ValueBasis | null = doc ? { title: plot.documentTitle(doc.kind), documentId: doc.id, date: today() } : null;
    if (clear) return onApply(site.siteChange(p, fieldKey, null, docBasis ?? { title: form.title.trim(), date: today() }));
    const parsed = site.parseSite(fieldKey, value);
    if (parsed.error !== undefined) return setError(parsed.error);
    if (docBasis) return onApply(site.siteChange(p, fieldKey, parsed.value, docBasis));
    const b = plot.expertBasis(form, today(), site.siteExpertNumeric(fieldKey, parsed.value));
    if ("error" in b) return setError(b.error);
    onApply(site.siteChange(p, fieldKey, parsed.value, b.basis));
  }

  return (
    <Modal
      title={f.label}
      onClose={onClose}
      footer={
        <>
          {cur.value !== null && (
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
          Значение{f.unit ? `, ${f.unit}` : ""}
          {f.kind === "bool" ? (
            <select value={value} onChange={(e) => setValue(e.target.value)}>
              <option value="">—</option>
              <option>{site.BOOL_YES}</option>
              <option>{site.BOOL_NO}</option>
            </select>
          ) : (
            <input value={value} onChange={(e) => setValue(e.target.value)} placeholder={f.kind === "date" ? "ДД.ММ.ГГГГ" : ""} inputMode={f.kind === "text" || f.kind === "date" ? "text" : "decimal"} autoFocus />
          )}
        </label>
        <span className="hint">{f.hint}</span>
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
        {!docId && <ExpertFields form={form} onChange={setForm} placeholder="Например, ПЗЗ Москвы, зона Ж1" unit={f.unit} numeric={!!site.siteExpertNumeric(fieldKey, null)} />}
        {error && <div className="err">{error}</div>}
      </div>
    </Modal>
  );
}

// ---------- участок и ограничения ----------

type Save = (next: LandProject, message: string) => Promise<void>;

export function SiteSection({ p, tab, state, onSave, tabHref }: { p: LandProject; tab: SiteTab; state: AnalysisState; onSave: Save; tabHref: (t: SiteTab) => string }) {
  const [editing, setEditing] = useState<SiteFieldKey | null>(null);
  const [zone, setZone] = useState<site.ZouitEntry | "new" | null>(null);
  const norms = siteView.normRows(p, state.versions);
  const siteErrors = uniqueTexts(state.sa.result.messages.filter((m) => m.formulaId.startsWith("F.SITE.")));
  const needVolume = site.siteValue(p, "maxGfa").value === null && site.siteValue(p, "density").value === null && site.siteValue(p, "builtShare").value === null;

  return (
    <>
      <div className="mhead">
        <h2>Участок и ограничения</h2>
      </div>
      <div className="tabs">
        {SITE_TABS.map((t) => (
          <Link key={t} className={t === tab ? "on" : ""} href={tabHref(t)}>
            {t}
            {t === "Градрегламент" && (needVolume || site.siteValue(p, "maxFloors").value === null) && <span className="tdot" />}
          </Link>
        ))}
      </div>
      {tab === "Градрегламент" && (
        <>
          {(needVolume || site.siteValue(p, "maxFloors").value === null) && (
            <div className="check warn">
              <div>Для вариантов нужны предельная этажность и хотя бы одно ограничение объёма: предельная наземная площадь по ГПЗУ, плотность застройки или процент застройки. Возьмите их из ГПЗУ участка или регламента зоны ПЗЗ.</div>
            </div>
          )}
          <div className="fgrid">
            {site.REGULATION_FIELDS.map((k) => (
              <SiteFieldRow key={k} p={p} fieldKey={k} onEdit={setEditing} required={k === "maxFloors"} />
            ))}
          </div>
        </>
      )}
      {tab === "Зоны с ограничениями" && (
        <>
          <p className="small muted">Зоны с особыми условиями использования территории: охранные зоны сетей, санитарно-защитные, водоохранные. Площадь зон, где строить нельзя, вычитается из площади под застройку.</p>
          {site.siteOf(p).zouit.length ? (
            <div className="tw">
              <table className="t">
                <thead>
                  <tr>
                    <th>Зона</th>
                    <th>Площадь на участке</th>
                    <th className="l">Строить нельзя</th>
                    <th className="l">Ограничение</th>
                    <th className="l">Основание</th>
                  </tr>
                </thead>
                <tbody>
                  {site.siteOf(p).zouit.map((z) => (
                    <tr key={z.id} className="click" onClick={() => setZone(z)}>
                      <td>{z.name}</td>
                      <td>{z.area === null ? "—" : `${text.num(Number(z.area), 0)} м²`}</td>
                      <td className="l">{z.noBuild ? "да" : "нет"}</td>
                      <td className="l">{z.restriction || "—"}</td>
                      <td className="l">
                        <OriginTag origin={z.origin} /> <BasisText basis={z.basis} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="card empty">Зон с ограничениями не внесено. Если по выписке ЕГРН или ГПЗУ зон нет, оставьте список пустым.</div>
          )}
          <div style={{ marginTop: 12 }}>
            <button className="btn" onClick={() => setZone("new")}>
              + Зона
            </button>
          </div>
        </>
      )}
      {tab === "Нормативы" && (
        <>
          <h3 className="h3">Нормативы региона</h3>
          <NormTable rows={norms.region} p={p} onEdit={setEditing} />
          <h3 className="h3">Стандартные значения компании для вариантов</h3>
          <NormTable rows={norms.standard} p={p} onEdit={setEditing} />
          <p className="small muted">
            Стандартные значения меняются в <Link href="/reference/values?tab=analysis">справочнике</Link>; проект считается на своей версии справочника.
          </p>
        </>
      )}
      {tab === "Сделка" && (
        <div className="fgrid">
          {site.DEAL_FIELDS.map((k) => (
            <SiteFieldRow key={k} p={p} fieldKey={k} onEdit={setEditing} required={k === "landPrice"} />
          ))}
        </div>
      )}
      {tab === "Градпотенциал" && (
        <>
          {siteErrors.map((t) => (
            <div key={t} className="check warn">
              {t}
            </div>
          ))}
          <div className="tw">
            <table className="t">
              <tbody>
                {siteView.potentialRows(p, state.sa).map((r) => (
                  <tr key={r.label}>
                    <td>
                      {r.label}
                      {r.binding && (
                        <>
                          {" "}
                          <Chip tone="acc">самое жёсткое</Chip>
                        </>
                      )}
                    </td>
                    <td>{r.value}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
      {editing && (
        <EditSiteField
          p={p}
          fieldKey={editing}
          onClose={() => setEditing(null)}
          onApply={(c) => {
            setEditing(null);
            if (c) void onSave(site.applySiteChange(p, c, nowIso()), "Значение сохранено");
          }}
        />
      )}
      {zone && (
        <EditZone
          p={p}
          zone={zone === "new" ? null : zone}
          onClose={() => setZone(null)}
          onApply={(list, msg) => {
            setZone(null);
            void onSave(site.updateSite(p, { zouit: list }, nowIso()), msg);
          }}
        />
      )}
    </>
  );
}

function NormTable({ rows, p, onEdit }: { rows: siteView.ViewRow[]; p: LandProject; onEdit: (k: SiteFieldKey) => void }) {
  return (
    <div className="tw" style={{ marginBottom: 16 }}>
      <table className="t">
        <tbody>
          {rows.map((r) => (
            <tr key={r.label} className={r.edit ? "click" : ""} onClick={r.edit ? () => onEdit(r.edit as SiteFieldKey) : undefined}>
              <td style={{ minWidth: 320 }}>
                {r.label}
                <div className="small" style={{ marginTop: 3 }}>
                  <OriginTag origin={r.origin} /> <BasisText basis={r.basis} />
                </div>
                {r.note && <div className="small muted">{r.note}</div>}
              </td>
              <td className="l">
                {r.tone ? <Chip tone={r.tone}>{r.value}</Chip> : r.value}
                {r.edit && site.siteValue(p, r.edit).value === null && (
                  <button className="btn sm" style={{ marginLeft: 8 }}>
                    Ввести
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function EditZone({ p, zone, onApply, onClose }: { p: LandProject; zone: site.ZouitEntry | null; onApply: (list: site.ZouitEntry[], message: string) => void; onClose: () => void }) {
  const [name, setName] = useState(zone?.name ?? "");
  const [area, setArea] = useState(zone?.area ? text.num(Number(zone.area), 2) : "");
  const [noBuild, setNoBuild] = useState(zone?.noBuild ?? false);
  const [restriction, setRestriction] = useState(zone?.restriction ?? "");
  const [docId, setDocId] = useState(zone?.basis.documentId ?? "");
  const [form, setForm] = useState(plot.expertForm(zone?.basis, (x) => text.num(Number(x), 2)));
  const [error, setError] = useState<string | null>(null);
  const list = site.siteOf(p).zouit;

  function apply() {
    if (!name.trim()) return setError("Укажите название зоны, например «Охранная зона газопровода».");
    const a = area.trim() ? plot.parseNumberRu(area) : null;
    if (area.trim() && a === null) return setError(`Площадь «${area}» — не число. Введите площадь в м².`);
    if (noBuild && a === null) return setError("Для зоны, где строить нельзя, укажите её площадь на участке: она вычитается из площади под застройку.");
    const doc = p.documents.find((d) => d.id === docId);
    const expert = doc ? null : plot.expertBasis(form, today(), a === null ? undefined : site.zoneAreaNumeric(a));
    if (expert && "error" in expert) return setError(expert.error);
    const b: plot.ValueBasis = doc ? { title: plot.documentTitle(doc.kind), documentId: doc.id, date: today() } : (expert as { basis: plot.ValueBasis }).basis;
    const entry: site.ZouitEntry = { id: zone?.id ?? newId(), name: name.trim(), area: a, noBuild, restriction: restriction.trim(), origin: doc ? "source" : "expert", basis: b };
    onApply(zone ? list.map((z) => (z.id === zone.id ? entry : z)) : [...list, entry], zone ? "Зона изменена" : "Зона добавлена");
  }

  return (
    <Modal
      title={zone ? zone.name : "Новая зона с ограничениями"}
      onClose={onClose}
      footer={
        <>
          {zone && (
            <button className="btn danger" onClick={() => onApply(list.filter((z) => z.id !== zone.id), "Зона удалена")} style={{ marginRight: "auto" }}>
              Удалить
            </button>
          )}
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
        <label>
          Зона *
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Охранная зона газопровода" autoFocus />
        </label>
        <div className="row2">
          <label>
            Площадь на участке, м²
            <input value={area} onChange={(e) => setArea(e.target.value)} inputMode="decimal" />
          </label>
          <label>
            Строить нельзя
            <select value={noBuild ? "да" : "нет"} onChange={(e) => setNoBuild(e.target.value === "да")}>
              <option>нет</option>
              <option>да</option>
            </select>
          </label>
        </div>
        <label>
          Ограничение
          <input value={restriction} onChange={(e) => setRestriction(e.target.value)} placeholder="Например, запрет размещения зданий" />
        </label>
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
        {!docId && <ExpertFields form={form} onChange={setForm} placeholder="Например, выписка ЕГРН, раздел об ограничениях" unit="м²" numeric={!!area.trim()} />}
        {error && <div className="err">{error}</div>}
      </div>
    </Modal>
  );
}

// ---------- рынок ----------

export function MarketSection({ p, state, onSave }: { p: LandProject; state: AnalysisState; onSave: Save }) {
  const [editing, setEditing] = useState<site.AnalogEntry | "new" | null>(null);
  const analogs = site.siteOf(p).analogs;
  const rows = siteView.marketRows(p, state.sa);
  const minComps = site.minAnalogs();
  const [linked, setLinked] = useState<cmp.Competitor[]>([]);
  const [syncErrors, setSyncErrors] = useState<string[]>([]);
  useEffect(() => {
    void listCompetitors().then((all) => setLinked(all.filter((c) => cmp.linkOf(c, p.id))), () => setLinked([]));
  }, [p.id]);
  function sync() {
    const r = cmp.syncAnalogs(analogs, linked, p.id);
    setSyncErrors(r.errors);
    void onSave(site.updateSite(p, { analogs: r.analogs }, nowIso()), `Из конкурентов: добавлено ${r.added}, обновлено ${r.updated}, убрано ${r.removed}`);
  }
  return (
    <>
      <div className="mhead">
        <h2>Рынок</h2>
        <span className="sp" />
        <button className="btn" onClick={sync} disabled={!linked.length && !analogs.some((a) => a.competitorId)} title={linked.length ? "" : "Привяжите конкурентов к этому проекту на вкладке «Проекты конкурентов»"}>
          Обновить из конкурентов · {linked.length}
        </button>
        <button className="btn pri" onClick={() => setEditing("new")}>
          + Аналог
        </button>
      </div>
      <p className="small muted">
        Аналоги в радиусе 1–3 км, по строке на ЖК и продукт, у каждой — ссылка на карточку ЖК. ЖК с вкладки <Link href="/competitors">«Проекты конкурентов»</Link>, привязанные к этому проекту, добавляются кнопкой «Обновить из конкурентов». Цена класса — средняя по аналогам с весом по темпу продаж, темп проекта — медиана, ёмкость — сумма темпов. Для цены и темпа нужно не меньше {minComps} аналогов одного класса.
      </p>
      {syncErrors.map((e) => (
        <div key={e} className="check warn">
          Не добавлен: {e}
        </div>
      ))}
      {rows.length > 0 && (
        <div className="tw" style={{ marginBottom: 16 }}>
          <table className="t">
            <thead>
              <tr>
                <th>Продукт и класс</th>
                <th>Аналогов</th>
                <th>Цена по аналогам</th>
                <th>Диапазон</th>
                <th>Темп проекта</th>
                <th>Ёмкость локации</th>
                <th className="l">Происхождение</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={`${r.product}-${r.housingClass}`}>
                  <td>
                    {r.product}, {r.housingClass}
                  </td>
                  <td>{r.enough ? r.analogs : <Chip tone="yel">{r.analogs} из {minComps} — мало</Chip>}</td>
                  <td>{r.price}</td>
                  <td>{r.range}</td>
                  <td>{r.pace}</td>
                  <td>{r.capacity}</td>
                  <td className="l">{r.enough ? <OriginTag origin="estimate" /> : <span className="org miss">не хватает аналогов</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {analogs.length ? (
        <div className="tw">
          <table className="t">
            <thead>
              <tr>
                <th>Аналог</th>
                <th className="l">Продукт</th>
                <th className="l">Класс</th>
                <th>Расстояние</th>
                <th>Цена</th>
                <th>Темп продаж</th>
                <th>Продано</th>
                <th className="l">Данные на</th>
                <th className="l">Источник</th>
              </tr>
            </thead>
            <tbody>
              {analogs.map((a) => (
                <tr key={a.id} className="click" onClick={() => setEditing(a)}>
                  <td>
                    {a.name}
                    {a.stage && <div className="small muted">{a.stage}</div>}
                  </td>
                  <td className="l">{a.product}</td>
                  <td className="l">{a.housingClass}</td>
                  <td>{a.distanceKm === null ? "—" : `${text.num(Number(a.distanceKm), 1)} км`}</td>
                  <td>{a.price === null ? "—" : `${text.num(Number(a.price), 0)} ${site.analogPriceUnit(a.product)}`}</td>
                  <td title={a.paceNote}>
                    {a.pace === null ? <span className="org miss" title={a.paceNote}>нет темпа</span> : `${text.num(Number(a.pace), 0)} ${site.analogPaceUnit(a.product)}`}
                    {a.pace !== null && a.paceOrigin && a.paceOrigin !== "source" && (
                      <div>
                        <OriginTag origin={a.paceOrigin} />
                      </div>
                    )}
                  </td>
                  <td>{site.analogSoldText(a)}</td>
                  <td className="l">{text.date(a.date)}</td>
                  <td className="l">
                    <OriginTag origin="source" />{" "}
                    <a className="org basis" href={a.url} target="_blank" rel="noopener" onClick={(e) => e.stopPropagation()}>
                      карточка ЖК ↗
                    </a>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="card empty">Аналогов пока нет. Добавьте ЖК рядом с участком: без цены и темпа по аналогам варианты не считаются.</div>
      )}
      {editing && (
        <EditAnalog
          analog={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
          onApply={(a, remove) => {
            setEditing(null);
            const list = remove ? analogs.filter((x) => x.id !== remove) : a ? (analogs.some((x) => x.id === a.id) ? analogs.map((x) => (x.id === a.id ? a : x)) : [...analogs, a]) : analogs;
            void onSave(site.updateSite(p, { analogs: list }, nowIso()), remove ? "Аналог удалён" : "Аналог сохранён");
          }}
        />
      )}
    </>
  );
}

function EditAnalog({ analog, onApply, onClose }: { analog: site.AnalogEntry | null; onApply: (a: site.AnalogEntry | null, remove?: string) => void; onClose: () => void }) {
  const [form, setForm] = useState<site.AnalogForm>(() => site.analogToForm(analog));
  const [errors, setErrors] = useState<string[]>([]);
  const set = (k: keyof site.AnalogForm) => (e: { target: { value: string } }) => setForm((f) => ({ ...f, [k]: e.target.value }));
  function apply() {
    const r = site.analogFromForm(form, analog?.id ?? newId(), analog);
    if (!r.analog) return setErrors(r.errors);
    onApply(r.analog);
  }
  return (
    <Modal
      title={analog ? analog.name : "Новый аналог"}
      onClose={onClose}
      wide
      footer={
        <>
          {analog && (
            <button className="btn danger" onClick={() => onApply(null, analog.id)} style={{ marginRight: "auto" }}>
              Удалить
            </button>
          )}
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
        <div className="row2">
          <label>
            ЖК *
            <input value={form.name} onChange={set("name")} autoFocus />
          </label>
          <label>
            Ссылка на карточку ЖК *
            <input value={form.url} onChange={set("url")} placeholder="https://" />
          </label>
        </div>
        <div className="row2">
          <label>
            Продукт *
            <select value={form.product} onChange={set("product")}>
              {site.ANALOG_PRODUCTS.map((o) => (
                <option key={o}>{o}</option>
              ))}
            </select>
          </label>
          <label>
            Класс *
            <select value={form.housingClass} onChange={set("housingClass")}>
              <option value="">—</option>
              {site.HOUSING_CLASSES.map((o) => (
                <option key={o}>{o}</option>
              ))}
            </select>
          </label>
        </div>
        <div className="row2">
          <label>
            Цена с НДС, {site.analogPriceUnit(form.product)} *
            <input value={form.price} onChange={set("price")} inputMode="decimal" />
          </label>
          <label>
            Темп продаж, {site.analogPaceUnit(form.product)} *
            <input value={form.pace} onChange={set("pace")} inputMode="decimal" />
          </label>
        </div>
        <div className="row2">
          <label>
            Расстояние до участка, км
            <input value={form.distanceKm} onChange={set("distanceKm")} inputMode="decimal" />
          </label>
          <label>
            Продано, %
            <input value={form.soldShare} onChange={set("soldShare")} inputMode="decimal" />
          </label>
        </div>
        <div className="row2">
          <label>
            Стадия
            <input value={form.stage} onChange={set("stage")} placeholder="Например, котлован, сдача 2028" />
          </label>
          <label>
            Данные на дату *
            <input value={form.date} onChange={set("date")} placeholder="ДД.ММ.ГГГГ" />
          </label>
        </div>
        {errors.map((e) => (
          <div key={e} className="err">
            {e}
          </div>
        ))}
      </div>
    </Modal>
  );
}

// ---------- варианты ----------

function Progress({ state }: { state: AnalysisState }) {
  if (state.done) return null;
  return (
    <div className="check warn">
      Считаем варианты: {state.summaries.length} из {state.variants.length}
    </div>
  );
}

function SetupHints({ state, p }: { state: AnalysisState; p: LandProject }) {
  if (state.variants.length) return null;
  const texts = uniqueTexts(state.sa.result.messages);
  return (
    <>
      <div className="check warn">
        <div>
          Варианты строятся по ограничениям участка и рынку. Заполните <Link href={`/projects/${p.id}?sec=site`}>градрегламент</Link> и добавьте <Link href={`/projects/${p.id}?sec=market`}>аналоги</Link>.
        </div>
      </div>
      {texts.map((t) => (
        <div key={t} className="check warn">
          {t}
        </div>
      ))}
    </>
  );
}

export function VariantsSection({ p, state, onSave, compareHref }: { p: LandProject; state: AnalysisState; onSave: Save; compareHref: string }) {
  const [adding, setAdding] = useState(false);
  const custom = new Set(site.siteOf(p).customVariants.map((v) => v.id));
  const selected = site.siteOf(p).selectedVariant;
  const common = state.done ? siteView.commonNotCounted(state.summaries) : [];
  return (
    <>
      <div className="mhead">
        <h2>Варианты освоения</h2>
        <span className="sp" />
        <button className="btn" onClick={() => setAdding(true)}>
          + Свой вариант
        </button>
        <Link className="btn pri" href={compareHref}>
          Сравнение
        </Link>
      </div>
      <SetupHints state={state} p={p} />
      <Progress state={state} />
      {common.length > 0 && (
        <div className="check warn">
          <div>
            Во всех вариантах не учтено: {common.join(", ")}. Нет ставки в <Link href="/reference/values?tab=budget">справочнике</Link>, цены или темпа по аналогам. Эти затраты и продажи в итоги не входят.
          </div>
        </div>
      )}
      <div className="vgrid">
        {state.summaries.map((s) => {
          const best = state.choice?.best === s.variant.id;
          const problems = siteView.variantProblems(s);
          const ncs = siteView.ncsLine(s);
          return (
            <div key={s.variant.id} className={`card vcard ${best ? "best" : ""}`}>
              <div className="vh">
                <b>{site.variantTitle(s.variant)}</b>
                {best && <Chip tone="grn">лучший</Chip>}
                {selected === s.variant.id && <Chip tone="acc">выбран</Chip>}
                {custom.has(s.variant.id) && <Chip tone="gry">свой</Chip>}
                <span className="sp" />
                {custom.has(s.variant.id) && (
                  <button
                    className="btn sm"
                    onClick={() => void onSave(site.updateSite(p, { customVariants: site.siteOf(p).customVariants.filter((v) => v.id !== s.variant.id) }, nowIso()), "Вариант удалён")}
                  >
                    Удалить
                  </button>
                )}
              </div>
              <div className="vnums" style={{ marginTop: 10 }}>
                {siteView.variantFacts(s).map((f) => (
                  <div key={f.label}>
                    <b>{f.value}</b>
                    <div>{f.label}</div>
                  </div>
                ))}
              </div>
              {ncs && <div className={`check ${ncs.tone === "red" ? "bad" : "ok"}`}>{ncs.text}</div>}
              {!s.computed && problems.length > 0 && (
                <div className="check bad">
                  <div>Вариант не посчитан полностью: {problems.join(" ")}</div>
                </div>
              )}
              {state.done && siteView.ownNotCounted(s, common).length > 0 && <div className="vreason">Не учтено{common.length ? " в этом варианте" : ""}: {siteView.ownNotCounted(s, common).join(", ")}.</div>}
            </div>
          );
        })}
      </div>
      {adding && (
        <AddVariant
          p={p}
          generated={state.sa.variants}
          onClose={() => setAdding(false)}
          onAdd={(v) => {
            setAdding(false);
            void onSave(site.updateSite(p, { customVariants: [...site.siteOf(p).customVariants, v] }, nowIso()), "Вариант добавлен");
          }}
        />
      )}
    </>
  );
}

function AddVariant({ p, generated, onAdd, onClose }: { p: LandProject; generated: analysis.Variant[]; onAdd: (v: analysis.Variant) => void; onClose: () => void }) {
  const [cls, setCls] = useState("");
  const [floors, setFloors] = useState("");
  const [error, setError] = useState<string | null>(null);
  return (
    <Modal
      title="Свой вариант"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Отмена
          </button>
          <button
            className="btn pri"
            onClick={() => {
              const r = site.customVariant(p, cls, floors, generated);
              if (!r.variant) return setError(r.error);
              onAdd(r.variant);
            }}
          >
            Добавить
          </button>
        </>
      }
    >
      <div className="frm">
        <div className="row2">
          <label>
            Класс жилья
            <select value={cls} onChange={(e) => setCls(e.target.value)}>
              <option value="">—</option>
              {site.HOUSING_CLASSES.map((o) => (
                <option key={o}>{o}</option>
              ))}
            </select>
          </label>
          <label>
            Этажность
            <input value={floors} onChange={(e) => setFloors(e.target.value)} inputMode="numeric" autoFocus />
          </label>
        </div>
        <span className="hint">Пятно, площади, очереди, план продаж и бюджет варианта посчитаются так же, как у остальных вариантов.</span>
        {error && <div className="err">{error}</div>}
      </div>
    </Modal>
  );
}

// ---------- сравнение ----------

export function CompareSection({ p, state, onSave }: { p: LandProject; state: AnalysisState; onSave: Save }) {
  const selected = site.siteOf(p).selectedVariant;
  const table = siteView.compareTable(state.summaries, state.choice, siteView.criterionApproved(p, state.versions));
  return (
    <>
      <div className="mhead">
        <h2>Сравнение вариантов</h2>
      </div>
      <SetupHints state={state} p={p} />
      <Progress state={state} />
      {state.done && state.summaries.length > 0 && (
        <>
          <p className="small muted">NPV — чистая приведённая стоимость денежного потока акционера, IRR — его внутренняя норма доходности. Деньги — в млн руб.</p>
          <div className={table.best ? "cmp-reason" : "check warn"}>
            <div>{table.why}</div>
            {table.needsReference && (
              <Link className="btn sm" href="/reference/values?tab=analysis">
                Открыть справочник
              </Link>
            )}
          </div>
          <div className="tw">
            <table className="t">
              <thead>
                <tr>
                  <th>Показатель</th>
                  {state.summaries.map((s, i) => (
                    <th key={s.variant.id} className={table.best === s.variant.id ? "best" : ""}>
                      {table.headers[i]}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {table.rows.map((r) => (
                  <tr key={r.label}>
                    <td>{r.label}</td>
                    {r.cells.map((c, i) => (
                      <td key={i} className={table.best === state.summaries[i]?.variant.id ? "best" : ""}>
                        {c}
                      </td>
                    ))}
                  </tr>
                ))}
                <tr>
                  <td />
                  {state.summaries.map((s) => (
                    <td key={s.variant.id} className={table.best === s.variant.id ? "best" : ""}>
                      {selected === s.variant.id ? (
                        <Chip tone="acc">выбран</Chip>
                      ) : (
                        <button className="btn sm" onClick={() => void onSave(site.updateSite(p, { selectedVariant: s.variant.id }, nowIso()), `Выбран вариант «${site.variantTitle(s.variant)}»`)}>
                          Выбрать вариант
                        </button>
                      )}
                    </td>
                  ))}
                </tr>
              </tbody>
            </table>
          </div>
          {table.reasons.length > 0 && (
            <>
              <h3 className="h3">Не проходят условия отбора</h3>
              {table.reasons.map((r) => (
                <div key={r.title} className="vreason">
                  <b>{r.title}:</b> {r.text}.
                </div>
              ))}
            </>
          )}
        </>
      )}
      <RateBlock p={p} state={state} onSave={onSave} />
    </>
  );
}

/** Ставка дисконтирования для NPV: кривая доходности ОФЗ на дату оценки и премия за риск из справочника. */
function RateBlock({ p, state, onSave }: { p: LandProject; state: AnalysisState; onSave: Save }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<SiteFieldKey | null>(null);
  const curve = site.siteOf(p).curve;
  const valuation = String(state.calc.input.values["GEN.VALUATION_DATE"] ?? today());
  const load = async () => {
    setBusy(true);
    setError(null);
    const r = await loadZcyc(valuation, today(), nowIso());
    setBusy(false);
    if ("error" in r) return setError(r.error);
    await onSave(site.updateSite(p, { curve: r.curve }, nowIso()), `${zcyc.zcycLabel(r.curve)} загружена`);
  };
  return (
    <>
      <h3 className="h3">Ставка дисконтирования</h3>
      <p className="small muted">NPV считается по ставке «безрисковая ставка + премия за риск». Безрисковая ставка — доходность ОФЗ на дату оценки ({text.date(valuation)}) со сроком, равным сроку варианта.</p>
      <NormTable rows={siteView.rateRows(p, state.versions, state.summaries)} p={p} onEdit={setEditing} />
      <div className="row" style={{ gap: 8 }}>
        <button className="btn" disabled={busy} onClick={() => void load()}>
          {busy ? "Загружаем…" : curve ? "Обновить кривую с Мосбиржи" : "Загрузить кривую с Мосбиржи"}
        </button>
        <Link className="btn" href="/reference/values?tab=analysis">
          Премия за риск в справочнике
        </Link>
      </div>
      {error && <div className="check warn">{error}</div>}
      {editing && (
        <EditSiteField
          p={p}
          fieldKey={editing}
          onClose={() => setEditing(null)}
          onApply={(c) => {
            setEditing(null);
            if (c) void onSave(site.applySiteChange(p, c, nowIso()), "Значение сохранено");
          }}
        />
      )}
    </>
  );
}

// ---------- раздел анализа в проекте ----------

export type AnalysisSec = "site" | "market" | "variants" | "compare";

/** Разделы анализа участка: один расчёт на все экраны; итоги лучшего варианта запоминаются для списка проектов. */
export function AnalysisArea({ p, sec, tab, versions, onSave, href }: { p: LandProject; sec: AnalysisSec; tab: string | undefined; versions: book.AssumptionVersion[]; onSave: Save; href: (sec: AnalysisSec, tab?: string) => string }) {
  const state = useAnalysis(p, versions);
  const snapshot = state.done ? siteView.snapshotOf(state.summaries, state.choice, nowIso()) : null;
  const saved = site.siteOf(p).snapshot;
  const changed = !!snapshot && (!saved || saved.best !== snapshot.best || saved.netProfit !== snapshot.netProfit || saved.variants !== snapshot.variants);
  useEffect(() => {
    if (changed && snapshot) void onSave(site.updateSite(p, { snapshot }, nowIso()), "");
  }, [changed]);

  if (sec === "site") {
    const t = SITE_TABS.find((x) => x === tab) ?? "Градрегламент";
    return <SiteSection p={p} tab={t} state={state} onSave={onSave} tabHref={(x) => href("site", x)} />;
  }
  if (sec === "market") return <MarketSection p={p} state={state} onSave={onSave} />;
  if (sec === "variants") return <VariantsSection p={p} state={state} onSave={onSave} compareHref={href("compare")} />;
  return <CompareSection p={p} state={state} onSave={onSave} />;
}
