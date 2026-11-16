import path from "node:path";
import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Пакеты монорепо публикуются исходниками TypeScript.
  transpilePackages: ["@fm/engine", "@fm/spec", "@fm/egrn-import"],
  // Сборка одним пакетом для сервера в России (workflow «Сайт на сервер», docs/passports/web.md).
  // Vercel эту настройку не использует.
  output: "standalone",
  outputFileTracingRoot: path.join(path.dirname(fileURLToPath(import.meta.url)), "../.."),
};

export default nextConfig;
