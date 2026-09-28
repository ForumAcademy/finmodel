import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("сгенерированные файлы актуальны", () => {
  it("src/generated совпадает с data/*.yaml (pnpm spec:build)", () => {
    const script = resolve(import.meta.dirname, "../scripts/build-spec.ts");
    const run = () => execFileSync(process.execPath, [script, "--check"], { encoding: "utf8", stdio: "pipe" });
    expect(run).not.toThrow();
  });
});
