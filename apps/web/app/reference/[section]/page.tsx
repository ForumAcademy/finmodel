import { notFound } from "next/navigation";
import { ReferenceScreen } from "@/components/ReferenceScreen";
import { SECTIONS } from "@/lib/reference-sections";

export function generateStaticParams() {
  return SECTIONS.map((s) => ({ section: s.id }));
}

export default async function ReferencePage({ params, searchParams }: { params: Promise<{ section: string }>; searchParams: Promise<{ tab?: string }> }) {
  const { section } = await params;
  const { tab } = await searchParams;
  const sec = SECTIONS.find((s) => s.id === section);
  if (!sec) notFound();
  return <ReferenceScreen section={sec.id} tab={tab} />;
}
