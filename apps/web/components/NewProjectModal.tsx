"use client";

import { useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { plot } from "@fm/engine";
import { EGRN_ACCEPT, foundSummary, type EgrnResult } from "@fm/egrn-import";
import { readEgrn } from "@/lib/egrn";
import { newId, nowIso, saveFile, saveProject } from "@/lib/store";
import { Modal } from "./ui";
import { MapPicker, pointText } from "./MapPicker";

interface Loaded {
  file: File;
  result: EgrnResult;
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
  const [reading, setReading] = useState(false);
  const [excel, setExcel] = useState<{ file: File; doc: plot.ProjectDocument } | null>(null);
  const [errors, setErrors] = useState<plot.NewProjectResult["errors"]>([]);
  const [saving, setSaving] = useState(false);
  const egrnInput = useRef<HTMLInputElement>(null);
  const excelInput = useRef<HTMLInputElement>(null);

  const egrnForm = egrn && egrn.result.found.length ? { data: egrn.result.data, document: egrn.doc } : null;
  const suggested = useMemo(() => plot.suggestedRegion({ cadastralNumber: kn, address: mode === "address" ? address : "", egrn: egrnForm }), [kn, address, mode, egrnForm]);
  const withoutKn = !kn.trim() && !egrnForm?.data.cadastralNumber;
  const err = (f: plot.NewProjectField) => errors.filter((e) => e.field === f).map((e) => <div key={e.text} className="err">{e.text}</div>);

  async function onEgrn(file: File | undefined) {
    if (!file) return;
    setReading(true);
    try {
      setEgrn({ file, result: await readEgrn(file), doc: docOf("egrn", file) });
    } catch {
      setEgrn({ file, result: { data: {}, found: [], problems: [`Файл «${file.name}» не удалось прочитать. Проверьте, что это выписка ЕГРН в XML, PDF или ZIP, или введите данные вручную.`] }, doc: docOf("egrn", file) });
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
    };
    const r = plot.createProject(form, id, at);
    setErrors(r.errors);
    if (!r.project) return;
    setSaving(true);
    if (egrn) await saveFile(egrn.doc.id, egrn.file);
    if (excel) await saveFile(excel.doc.id, excel.file);
    await saveProject(r.project);
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
        <label>
          Кадастровый номер участка
          <input value={kn} onChange={(e) => setKn(e.target.value)} placeholder="77:05:0004012:1873" />
          <span className="hint">Если номера нет, укажите площадь и местоположение участка.</span>
          {err("cadastralNumber")}
        </label>
        <label>
          Название
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Например, участок на Каширском шоссе" />
        </label>

        <div className={`drop ${egrn ? (egrn.result.found.length ? "ok" : "bad") : ""}`}>
          {egrn ? (
            <>
              <b>{egrn.file.name}</b>
              {egrn.result.found.length > 0 && (
                <div>
                  {foundSummary(egrn.result)}: {[egrn.result.data.cadastralNumber, plot.areaHa(egrn.result.data.area ?? null), suggested?.how === "по выписке ЕГРН" ? suggested.region.name : null].filter((x) => x && x !== "—").join(", ")}
                </div>
              )}
              {egrn.result.problems.map((p) => (
                <div key={p} className="small">
                  {p}
                </div>
              ))}
              <button className="btn sm" style={{ marginTop: 8 }} onClick={() => egrnInput.current?.click()}>
                Заменить файл
              </button>
            </>
          ) : (
            <>
              Выписка ЕГРН: площадь, адрес, ВРИ, кадастровая стоимость и право возьмём из неё
              <br />
              <button className="btn sm" style={{ marginTop: 8 }} onClick={() => egrnInput.current?.click()} disabled={reading}>
                {reading ? "Читаем выписку…" : "Выбрать файл"}
              </button>
              <div className="hint" style={{ marginTop: 6 }}>
                XML, ZIP или PDF из личного кабинета Росреестра или Госуслуг
              </div>
            </>
          )}
          {err("egrn")}
          <input ref={egrnInput} type="file" accept={EGRN_ACCEPT} hidden onChange={(e) => void onEgrn(e.target.files?.[0])} />
        </div>

        {withoutKn && (
          <>
            <label>
              Площадь участка, м² *
              <input value={area} onChange={(e) => setArea(e.target.value)} placeholder="32 000" inputMode="decimal" />
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
              Есть готовая финмодель в Excel? Загрузите: файл сохранится в документах проекта для сверки с расчётом сервиса
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
