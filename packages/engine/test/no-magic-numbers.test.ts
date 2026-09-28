import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * CLAUDE.md, правило 1: в packages/engine/src/modules/** запрещены числовые литералы,
 * кроме 0, 1, 12, 365 и индексов. Дублирует правило ESLint no-magic-numbers,
 * чтобы нарушение ловилось и тестами.
 */
const MODULES_DIR = resolve(import.meta.dirname, "../src/modules");
const ALLOWED = new Set(["0", "1", "12", "365"]);

function listTsFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return listTsFiles(path);
    return path.endsWith(".ts") ? [path] : [];
  });
}

function stripCommentsAndStrings(code: string): string {
  return code
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "")
    .replace(/(["'`])(?:\\.|(?!\1)[^\\])*\1/g, '""');
}

describe("нет магических чисел в модулях ядра", () => {
  it("числовые литералы — только 0, 1, 12, 365 и индексы", () => {
    const violations: string[] = [];
    for (const file of listTsFiles(MODULES_DIR)) {
      const code = stripCommentsAndStrings(readFileSync(file, "utf8"));
      for (const match of code.matchAll(/(?<![\w.$[])\d[\d_]*(?:\.\d+)?(?:e[+-]?\d+)?\b/gi)) {
        if (!ALLOWED.has(match[0])) violations.push(`${relative(MODULES_DIR, file)}: ${match[0]}`);
      }
    }
    expect(violations).toEqual([]);
  });
});
