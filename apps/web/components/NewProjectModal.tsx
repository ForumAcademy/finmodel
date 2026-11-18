"use client";

import { useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { offer, plot } from "@fm/engine";
import { foundSummary, PLOT_DOCUMENT_ACCEPT, type PlotDocument } from "@fm/egrn-import";
import { readPlotDoc } from "@/lib/egrn";
import { getReference, newId, nowIso, saveFile, saveProject } from "@/lib/store";
import { Modal, WhereToFind } from "./ui";
import { MapPicker, pointText } from "./MapPicker";

interface Loaded {
  file: File;
  read: PlotDocument;
  doc: plot.ProjectDocument;
}

const docOf = (kind: plot.DocumentKind, file: File): plot.ProjectDocument => ({ id: newId(), kind, fileName: file.name, size: file.size, uploadedAt: nowIso() });

export function NewProjectModal({ onClose }: { onClose: () => void }) {
  const router = useRouter();
  const [kn, setKn] = useState("");
  const [name, setName] = useState("");
  const [area, setArea] = useState("");
  const [address, setAddress] = useState("");
  const [mode, setMode] = useState<"address" | "point">("address");
  const [point, setPoint] = useState<plot.GeoPoint | null>(null);
  const [region, setRegion] = useState("");
  const [egrn, setEgrn] = useState<Loaded | null>(null);
  const [use, setUse] = useState<plot.PurposeUse>("residential");
  const [object, setObject] = useState<Exclude<plot.ProjectPurpose, "residential">>("datacenter");
  /** Назначение выбрано вручную — подсказка из документа его не меняет. */
  const [useTouched, setUseTouched] = useState(false);
  const [reading, setReading] = useState(false);
  const [excel, setExcel] = useState<{ file: File; doc: plot.ProjectDocument } | null>(null);
  const [errors, setErrors] = useState<plot.NewProjectResult["errors"]>([]);
  const [saving, setSaving] = useState(false);
  const egrnInput = useRef<HTMLInputElement>(null);
  const excelInput = useRef<HTMLInputElement>(null);

  const egrnRead = egrn?.read.kind === "egrn" ? egrn.read.result : null;
  const offerRead = egrn?.read.kind === "offer" ? egrn.read.result : null;
  const offerFound = offerRead ? offer.offerFound(offerRead) : [];
  const egrnForm = egrn && egrnRead?.found.length ? { data: egrnRead.data, document: egrn.doc } : null;
  const offerPlot = offerRead ? offerRead.plot : null;
  const suggested = useMemo(() => plot.suggestedRegion({ cadastralNumber: kn, address: mode === "address" ? address : "", egrn: egrnForm, offerPlot }), [kn, address, mode, egrnForm, offerPlot]);
  const withoutKn = !kn.trim() && !egrnForm?.data.cadastralNumber && !offerPlot?.cadastralNumber;
  const purpose: plot.ProjectPurpose = use === "residential" ? "residential" : object;
  const err = (f: plot.NewProjectField) => errors.filter((e) => e.field === f).map((e) => <div key={e.text} className="err">{e.text}</div>);

  async function onEgrn(file: File | undefined) {
    if (!file) return;
    setReading(true);
    try {
      const read = await readPlotDoc(file);
      setEgrn({ file, read, doc: docOf(read.kind, file) });
      if (read.kind === "offer" && read.result.purposeHint && !useTouched) {
        setUse("commercial");
        setObject(read.result.purposeHint === "residential" ? "datacenter" : read.result.purposeHint);
      }
    } catch {
      setEgrn({ file, read: { kind: "egrn", result: { data: {}, found: [], problems: [`Файл «${file.name}» не удалось прочитать. Проверьте, что это выписка ЕГРН (XML, PDF или ZIP) или инвестиционное предложение в PDF с текстом, а не сканом, или введите данные вручную.`] } }, doc: docOf("egrn", file) });
    } finally {
      setReading(false);
    }
  }

  async function create() {
    const id = newId();
    const at = nowIso();
    const form: plot.NewProjectForm = {
      cadastralNumber: kn,
      name,
      area: withoutKn ? area : "",
      address: mode === "address" ? address : "",
      point: mode === "point" ? point : null,
      regionCode: region,
      egrn: egrnForm,
      documents: [...(egrn && !egrnForm ? [egrn.doc] : []), ...(excel ? [excel.doc] : [])],
      purpose,
      offerPlot,
    };
    const r = plot.createProject(form, id, at, (await getReference()).at(-1)?.version);
    setErrors(r.errors);
    if (!r.project) return;
    const project = offerRead && egrn ? offer.applyOffer(r.project, offerRead, egrn.doc.id, at).project : r.project;
    setSaving(true);
    if (egrn) await saveFile(egrn.doc.id, egrn.file);
    if (excel) await saveFile(excel.doc.id, excel.file);
    await saveProject(project);
    router.push(`/projects/${id}`);
  }

  return (
    <Modal
      title="Новый проект"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Отмена
          </button>
          <button className="btn pri" onClick={create} disabled={saving || reading}>
            Создать проект
          </button>
        </>
      }
    >
      <div className="frm">
        <div className="choice">
          <span style={{ color: "var(--ink2)" }}>Назначение</span>
          {plot.PURPOSE_USES.map((u) => (
            <label key={u.use}>
              <input
                type="radio"
                checked={use === u.use}
                onChange={() => {
                  setUse(u.use);
                  setUseTouched(true);
                }}
              />{" "}
              {u.title}
            </label>
          ))}
        </div>
        {use === "commercial" && (
          <label>
            Что строим
            <select value={object} onChange={(e) => setObject(e.target.value as typeof object)}>
              {plot.COMMERCIAL_OBJECTS.map((o) => (
                <option key={o.purpose} value={o.purpose}>
                  {o.title}
                </option>
              ))}
            </select>
            <span className="hint">Пока доступен ЦОД. Жилые шаги (варианты застройки, рынок квартир) для него не показываются.</span>
          </label>
        )}
        <label>
          Кадастровый номер участка
          <input value={kn} onChange={(e) => setKn(e.target.value)} placeholder="77:05:0004012:1873" />
          <WhereToFind className="hint" text={plot.plotField("cadastralNumber").where} />
          <span className="hint">Если номера нет, укажите площадь и местоположение участка.</span>
          {err("cadastralNumber")}
        </label>
        <label>
          Название
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Например, участок на Каширском шоссе" />
        </label>

        <div className={`drop ${egrn ? ((egrnRead?.found.length ?? offerFound.length) ? "ok" : "bad") : ""}`}>
          {egrn ? (
            <>
              <b>{egrn.file.name}</b> — {egrn.read.kind === "offer" ? offer.OFFER_TITLE.toLowerCase() : "выписка ЕГРН"}
              {egrnRead && egrnRead.found.length > 0 && (
                <div>
                  {foundSummary(egrnRead)}: {[egrnRead.data.cadastralNumber, plot.areaHa(egrnRead.data.area ?? null), suggested?.how === "по выписке ЕГРН" ? suggested.region.name : null].filter((x) => x && x !== "—").join(", ")}
                </div>
              )}
              {egrnRead?.problems.map((p) => (
                <div key={p} className="small">
                  {p}
                </div>
              ))}
              {offerRead && (
                <div>
                  {offerFound.length ? `Нашлось: ${offerFound.join(", ")}.` : "Цифры в документе не нашлись: возможно, это скан. Введите данные вручную, документ сохранится в проекте."}
                  {offerRead.purposeHint === "datacenter" && !useTouched && <div className="small">Документ про ЦОД — назначение выбрано «Коммерческое · ЦОД».</div>}
                </div>
              )}
              <button className="btn sm" style={{ marginTop: 8 }} onClick={() => egrnInput.current?.click()}>
                Заменить файл
              </button>
            </>
          ) : (
            <>
              Документ по участку: выписка ЕГРН или инвестиционное предложение. Номер, площадь, ВРИ, право, цену и мощность возьмём из него
              <br />
              <button className="btn sm" style={{ marginTop: 8 }} onClick={() => egrnInput.current?.click()} disabled={reading}>
                {reading ? "Читаем документ…" : "Выбрать файл"}
              </button>
              <div className="hint" style={{ marginTop: 6 }}>
                Выписка — XML, ZIP или PDF из личного кабинета Росреестра или Госуслуг; предложение — PDF с текстом (не скан)
              </div>
            </>
          )}
          {err("egrn")}
          <input ref={egrnInput} type="file" accept={PLOT_DOCUMENT_ACCEPT} hidden onChange={(e) => void onEgrn(e.target.files?.[0])} />
        </div>

        {withoutKn && (
          <>
            <label>
              Площадь участка, м² *
              <input value={area} onChange={(e) => setArea(e.target.value)} placeholder="32 000" inputMode="decimal" />
              <WhereToFind className="hint" text={plot.plotField("area").where} />
              {err("area")}
            </label>
            <div className="frm" style={{ gap: 8 }}>
              <div className="choice">
                <span style={{ color: "var(--ink2)" }}>Местоположение *</span>
                <label>
                  <input type="radio" checked={mode === "address"} onChange={() => setMode("address")} /> адрес
                </label>
                <label>
                  <input type="radio" checked={mode === "point"} onChange={() => setMode("point")} /> точка на карте
                </label>
              </div>
              {mode === "address" ? (
                <input value={address} onChange={(e) => setAddress(e.target.value)} placeholder="г. Москва, Каширское шоссе, вл. 64" aria-label="Адрес участка" />
              ) : (
                <>
                  <MapPicker value={point} onChange={setPoint} />
                  <span className="hint">{point ? pointText(point) : "Нажмите на карту, чтобы поставить точку"}</span>
                </>
              )}
              {mode === "address" && <WhereToFind className="hint" text={plot.plotField("address").where} />}
              {err("location")}
            </div>
          </>
        )}

        <label>
          Регион
          <select value={region} onChange={(e) => setRegion(e.target.value)}>
            <option value="">{suggested ? `${suggested.region.name} — ${suggested.how}` : "Выберите регион"}</option>
            {plot.PROJECT_REGIONS.map((r) => (
              <option key={r.code} value={r.code}>
                {r.name}
              </option>
            ))}
          </select>
          <WhereToFind className="hint" text={plot.plotField("regionCode").where} />
          {!region && suggested?.how === "по кадастровому номеру" && suggested.region.note && <span className="hint">{suggested.region.note}.</span>}
          {err("regionCode")}
        </label>

        <div className={`drop ${excel ? "ok" : ""}`}>
          {excel ? (
            <>
              <b>{excel.file.name}</b> — сохранится в документах проекта
              <br />
              <button className="btn sm" style={{ marginTop: 8 }} onClick={() => setExcel(null)}>
                Убрать
              </button>
            </>
          ) : (
            <>
              Есть готовая финансовая модель в Excel? Загрузите: файл сохранится в документах проекта для сверки с расчётом сервиса
              <br />
              <button className="btn sm" style={{ marginTop: 8 }} onClick={() => excelInput.current?.click()}>
                Выбрать файл
              </button>
            </>
          )}
          <input
            ref={excelInput}
            type="file"
            accept=".xlsx,.xlsm,.xls"
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) setExcel({ file: f, doc: docOf("excel", f) });
            }}
          />
        </div>
      </div>
    </Modal>
  );
}
