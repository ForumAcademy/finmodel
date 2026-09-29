import { ProjectScreen, type ProjectSection } from "@/components/ProjectScreen";

const TABS = ["Участок", "Проект", "История"] as const;

export default async function ProjectPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ sec?: string; tab?: string }> }) {
  const { id } = await params;
  const q = await searchParams;
  const sec: ProjectSection = q.sec === "docs" ? "docs" : "plot";
  const tab = TABS.find((t) => t === q.tab) ?? "Участок";
  return <ProjectScreen id={id} sec={sec} tab={tab} />;
}
