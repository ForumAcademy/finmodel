import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "yaml";
import { legacyCaseInput, type LegacyCase } from "../../src";

const CASES = resolve(import.meta.dirname, "../../../../tests/cases");

export function loadCase(name: string): LegacyCase {
  return parse(readFileSync(resolve(CASES, `${name}.yaml`), "utf8")) as LegacyCase;
}

export const legacyInput = legacyCaseInput;
