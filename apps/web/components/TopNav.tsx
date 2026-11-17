"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

export function TopNav() {
  const path = usePathname();
  const ref = path.startsWith("/reference");
  const lg = path.startsWith("/logic");
  return (
    <header className="top">
      <div className="brand">
        <i />
        Оценка участка
      </div>
      <nav className="topnav">
        <Link href="/" className={ref || lg ? "" : "on"}>
          Проекты
        </Link>
        <Link href="/reference" className={ref ? "on" : ""}>
          Справочник
        </Link>
        <Link href="/logic" className={lg ? "on" : ""}>
          Логика
        </Link>
      </nav>
    </header>
  );
}
