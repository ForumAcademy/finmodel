import type { Metadata } from "next";
import { LogicScreen } from "@/components/LogicScreen";

export const metadata: Metadata = { title: "Логика — Оценка участка" };

export default function LogicPage() {
  return <LogicScreen />;
}
