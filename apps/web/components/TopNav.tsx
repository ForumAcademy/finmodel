"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

export function TopNav() {
  const path = usePathname();
  const ref = path.startsWith("/reference");
  const comp = path.startsWith("/competitors");
  return (
    <header className="top">
      <div className="brand">
        <i />
        Оценка участка
      </div>
      <nav className="topnav">
        <Link href="/" className={ref || comp ? "" : "on"}>
          Проекты
        </Link>
        <Link href="/competitors" className={comp ? "on" : ""}>
          Проекты конкурентов
        </Link>
        <Link href="/reference" className={ref ? "on" : ""}>
          Справочник
        </Link>
      </nav>
    </header>
  );
}
