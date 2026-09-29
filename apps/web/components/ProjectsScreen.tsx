"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { plot, projectFile, text } from "@fm/engine";
import { readJson, saveProjectFile, storedFiles } from "@/lib/files";
import { deleteFile, getReference, listProjects, newId, nowIso, saveProject, saveStoredFile } from "@/lib/store";
import { NewProjectModal } from "./NewProjectModal";
import { Chip, Modal, Toast } from "./ui";

type LandProject = plot.LandProject;

function Card({ p, onMenu }: { p: LandProject; onMenu: (p: LandProject, el: HTMLElement) => void }) {
  const router = useRouter();
  const s = plot.projectStatus(p);
  return (
    <div className="card pcard" onClick={() => router.push(`/projects/${p.id}`)}>
      <div className="t">{plot.projectTitle(p)}</div>
      <div className="s">{plot.projectSubtitle(p)}</div>
      <button
        className="kebab"
        title="Действия"
        onClick={(e) => {
          e.stopPropagation();
          onMenu(p, e.currentTarget);
        }}
      >
        ⋮
      </button>
      <div className="hr" />
      <div className="row" style={{ flexWrap: "wrap", gap: 8 }}>
        {s.noCadastralNumber && <Chip tone="yel">Участок без кадастрового номера</Chip>}
        {s.missing > 0 && <Chip tone="yel">Не хватает {s.missing} {text.plural(s.missing, ["значения", "значений", "значений"])}</Chip>}
        {!s.noCadastralNumber && s.missing === 0 && <Chip tone="grn">Данные участка заполнены</Chip>}
      </div>
      <div className="small muted" style={{ marginTop: 8 }}>
        Обновлено {text.date(p.updatedAt.slice(0, 10))}
      </div>
    </div>
  );
}

export function ProjectsScreen() {
  const router = useRouter();
  const [all, setAll] = useState<LandProject[] | null>(null);
  const [archive, setArchive] = useState(false);
  const [q, setQ] = useState("");
  const [creating, setCreating] = useState(false);
  const [menu, setMenu] = useState<{ p: LandProject; x: number; y: number } | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [conflict, setConflict] = useState<{ file: projectFile.ProjectFile; existing: LandProject } | null>(null);
  const [notice, setNotice] = useState<{ title: string; lines: string[]; open?: string } | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const reload = () => listProjects().then(setAll, () => setAll([]));
  useEffect(() => {
    void reload();
  }, []);
  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    window.addEventListener("click", close);
    return () => window.removeEventListener("click", close);
  }, [menu]);

  const flash = (t: string) => {
    setToast(t);
    setTimeout(() => setToast(null), 2600);
  };
  const needle = q.trim().toLowerCase();
  const list = (all ?? []).filter(
    (p) => p.archived === archive && (!needle || [plot.projectTitle(p), p.plot.cadastralNumber.value ?? "", p.plot.address.value ?? ""].some((s) => s.toLowerCase().includes(needle))),
  );
  const active = (all ?? []).filter((p) => !p.archived).length;
  const archived = (all ?? []).length - active;

  async function toFile(p: LandProject) {
    setMenu(null);
    const missing = await saveProjectFile(p);
    if (missing.length) setNotice({ title: "Проект сохранён без части документов", lines: [`В этом браузере нет файлов: ${missing.join(", ")}. Остальное сохранено. Загрузите эти документы в проект заново и сохраните файл ещё раз.`] });
    else flash("Файл проекта сохранён в папку загрузок");
  }

  async function fromFile(f: File | undefined) {
    if (fileInput.current) fileInput.current.value = "";
    if (!f) return;
    const r = projectFile.readProjectFile(await readJson(f));
    if (!r.ok) {
      setNotice({ title: "Файл не открыт", lines: [r.error] });
      return;
    }
    const existing = projectFile.findConflict(r.file, all ?? []);
    if (existing) setConflict({ file: r.file, existing });
    else await open(r.file, "new", null);
  }

  async function open(file: projectFile.ProjectFile, mode: projectFile.OpenMode, existing: LandProject | null) {
    setConflict(null);
    const res = projectFile.openProject(file, mode, await getReference(), existing, newId, nowIso());
    const { files, broken } = await storedFiles(res.files);
    for (const f of files) await saveStoredFile(f);
    if (mode === "replace" && existing) for (const id of projectFile.orphanFileIds(existing, all ?? [])) await deleteFile(id);
    await saveProject(res.project);
    await reload();
    const lines = [
      ...(res.referenceNote ? [res.referenceNote] : []),
      ...(broken.length ? [`Документы повреждены и не открыты: ${broken.join(", ")}. Попросите коллегу сохранить проект в файл ещё раз.`] : []),
    ];
    if (lines.length) setNotice({ title: "Проект открыт", lines, open: res.project.id });
    else flash(mode === "replace" ? "Проект заменён проектом из файла" : "Проект открыт из файла");
  }

  async function act(kind: "copy" | "archive", p: LandProject) {
    setMenu(null);
    const at = nowIso();
    if (kind === "copy") await saveProject(plot.copyProject(p, newId(), at));
    else await saveProject({ ...p, archived: !p.archived, updatedAt: at });
    await reload();
    flash(kind === "copy" ? "Копия проекта создана" : p.archived ? "Проект возвращён из архива" : "Проект в архиве");
  }

  return (
    <div className="page">
      <div className="row">
        <h1>Проекты</h1>
        <div style={{ flex: 1 }} />
        <button className="btn" onClick={() => fileInput.current?.click()}>
          Открыть проект из файла
        </button>
        <input ref={fileInput} type="file" accept=".json,application/json" hidden onChange={(e) => void fromFile(e.target.files?.[0])} />
        <button className="btn pri" onClick={() => setCreating(true)}>
          + Новый проект
        </button>
      </div>
      <div className="small muted" style={{ marginTop: 6 }}>
        Проекты хранятся в этом браузере. Сохраните проект в файл, чтобы не потерять его и передать коллегам.
      </div>
      <div className="ptoolbar">
        <div className="seg">
          <button className={archive ? "" : "on"} onClick={() => setArchive(false)}>
            Активные · {active}
          </button>
          <button className={archive ? "on" : ""} onClick={() => setArchive(true)}>
            Архив · {archived}
          </button>
        </div>
        <input className="search" placeholder="Поиск по названию, номеру, адресу" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      {all === null ? null : list.length ? (
        <div className="pgrid">
          {list.map((p) => (
            <Card key={p.id} p={p} onMenu={(p, el) => {
              const b = el.getBoundingClientRect();
              setMenu({ p, x: b.right - 200 + window.scrollX, y: b.bottom + 4 + window.scrollY });
            }} />
          ))}
        </div>
      ) : (
        <div className="card empty">
          {all.length === 0 ? (
            <>
              <p>Проектов пока нет.</p>
              <button className="btn pri" onClick={() => setCreating(true)}>
                + Новый проект
              </button>
            </>
          ) : (
            "Ничего не найдено"
          )}
        </div>
      )}
      {menu && (
        <div className="menu" style={{ left: menu.x, top: menu.y }} onClick={(e) => e.stopPropagation()}>
          <button onClick={() => router.push(`/projects/${menu.p.id}`)}>Открыть</button>
          <button onClick={() => void toFile(menu.p)}>Сохранить проект в файл</button>
          <button onClick={() => void act("copy", menu.p)}>Сделать копию</button>
          <button onClick={() => void act("archive", menu.p)}>{menu.p.archived ? "Вернуть из архива" : "В архив"}</button>
        </div>
      )}
      {creating && <NewProjectModal onClose={() => setCreating(false)} />}
      {conflict && (
        <Modal
          title="Такой проект уже есть"
          onClose={() => setConflict(null)}
          footer={
            <>
              <button className="btn" onClick={() => setConflict(null)} style={{ marginRight: "auto" }}>
                Отмена
              </button>
              <button className="btn" onClick={() => void open(conflict.file, "copy", conflict.existing)}>
                Создать копию
              </button>
              <button className="btn pri" onClick={() => void open(conflict.file, "replace", conflict.existing)}>
                Заменить
              </button>
            </>
          }
        >
          <p>
            В этом браузере уже есть проект «{plot.projectTitle(conflict.existing)}», обновлён {text.date(conflict.existing.updatedAt.slice(0, 10))}. В файле — проект, обновлённый{" "}
            {text.date(conflict.file.project.updatedAt.slice(0, 10))}.
          </p>
          <p className="small muted">«Заменить» — данные и документы проекта в браузере заменятся данными из файла. «Создать копию» — появится второй проект с пометкой «(копия)».</p>
        </Modal>
      )}
      {notice && (
        <Modal
          title={notice.title}
          onClose={() => setNotice(null)}
          footer={
            notice.open ? (
              <button className="btn pri" onClick={() => router.push(`/projects/${notice.open}`)}>
                Открыть проект
              </button>
            ) : (
              <button className="btn pri" onClick={() => setNotice(null)}>
                Понятно
              </button>
            )
          }
        >
          {notice.lines.map((l) => (
            <p key={l}>{l}</p>
          ))}
        </Modal>
      )}
      <Toast text={toast} />
    </div>
  );
}
