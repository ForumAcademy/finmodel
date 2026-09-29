import type { Metadata } from "next";
import type { ReactNode } from "react";
import { TopNav } from "@/components/TopNav";
import "./globals.css";

export const metadata: Metadata = {
  title: "Оценка участка",
  description: "Оценка потенциала земельного участка под жилую застройку: Москва и Московская область",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="ru">
      <body>
        <TopNav />
        {children}
      </body>
    </html>
  );
}
