import { ProjectScreen, type ProjectSection } from "@/components/ProjectScreen";

const SECTIONS: readonly ProjectSection[] = ["summary", "plot", "site", "market", "variants", "model"];

/** Старые адреса разделов (до нового меню 16.11.2026) ведут на те же данные в новых шагах. */
function legacy(sec: string | undefined, tab: string | undefined): { sec: ProjectSection; tab: string | undefined } | null {
  if (sec === "docs") return { sec: "plot", tab: "Документы" };
  if (sec === "compare") return { sec: "variants", tab: undefined };
  if (sec === "site" && tab === "Сделка") return { sec: "plot", tab: "Сделка" };
  if (sec === "plot" && tab === "Проект") return { sec: "plot", tab: "Участок" };
  return null;
}

export default async function ProjectPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ sec?: string; tab?: string }> }) {
  const { id } = await params;
  const q = await searchParams;
  const old = legacy(q.sec, q.tab);
  const sec: ProjectSection = old?.sec ?? SECTIONS.find((s) => s === q.sec) ?? "summary";
  return <ProjectScreen id={id} sec={sec} tab={old ? old.tab : q.tab} />;
}
