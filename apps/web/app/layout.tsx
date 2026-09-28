import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "Оценка участка",
  description: "Оценка потенциала земельного участка под жилую застройку: Москва и Московская область",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="ru">
      <body>
        <header className="top">
          <span className="brand">Оценка участка</span>
          <nav>
            <a href="/">Проекты</a>
            <span aria-disabled="true">Справочник</span>
          </nav>
        </header>
        <main>{children}</main>
      </body>
    </html>
  );
}
