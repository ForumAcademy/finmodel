import { ProjectScreen, type ProjectSection } from "@/components/ProjectScreen";

const SECTIONS: readonly ProjectSection[] = ["plot", "docs", "site", "market", "variants", "compare"];

export default async function ProjectPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ sec?: string; tab?: string }> }) {
  const { id } = await params;
  const q = await searchParams;
  const sec: ProjectSection = SECTIONS.find((s) => s === q.sec) ?? "plot";
  return <ProjectScreen id={id} sec={sec} tab={q.tab} />;
}
