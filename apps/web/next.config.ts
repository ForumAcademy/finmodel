import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Пакеты монорепо публикуются исходниками TypeScript.
  transpilePackages: ["@fm/engine", "@fm/spec"],
};

export default nextConfig;
