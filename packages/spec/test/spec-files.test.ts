import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { SPEC_FILES } from "../src/index.js";

const DATA_DIR = resolve(import.meta.dirname, "../../../data");

describe("каркас @fm/spec", () => {
  it.each(SPEC_FILES)("файл справочника data/%s существует", (file) => {
    expect(existsSync(resolve(DATA_DIR, file))).toBe(true);
  });
});
