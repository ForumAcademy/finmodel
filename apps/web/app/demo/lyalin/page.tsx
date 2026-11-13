import Link from "next/link";
import { ParcelOverview } from "@/components/ParcelOverview";
import { lyalinPassportExample } from "@/lib/lyalin-passport-example";

export default function LyalinExamplePage() {
  const example = lyalinPassportExample();
  return (
    <main className="po-demo-page">
      <Link className="po-back" href="/">
        ← К проектам
      </Link>
      <h1 className="po-demo-title">Пример оценки участка</h1>
      <ParcelOverview {...example} demo />
    </main>
  );
}
