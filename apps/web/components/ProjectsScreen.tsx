"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { plot, text } from "@fm/engine";
import { listProjects, newId, nowIso, saveProject } from "@/lib/store";
import { NewProjectModal } from "./NewProjectModal";
import { Chip, Toast } from "./ui";

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
        <button className="btn pri" onClick={() => setCreating(true)}>
          + Новый проект
        </button>
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
          <button onClick={() => void act("copy", menu.p)}>Сделать копию</button>
          <button onClick={() => void act("archive", menu.p)}>{menu.p.archived ? "Вернуть из архива" : "В архив"}</button>
        </div>
      )}
      {creating && <NewProjectModal onClose={() => setCreating(false)} />}
      <Toast text={toast} />
    </div>
  );
}
