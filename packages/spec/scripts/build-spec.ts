/**
 * Сборка справочника: data/*.yaml → проверка zod-схемами и перекрёстными проверками →
 * src/generated/spec.json (данные) и src/generated/ids.ts (union-типы всех ID).
 *
 *   node scripts/build-spec.ts          — пересобрать
 *   node scripts/build-spec.ts --check  — проверить, что сгенерированные файлы актуальны (для CI)
 *
 * Код выхода 1 — ошибки в справочнике или устаревшие сгенерированные файлы.
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "yaml";
import type { z } from "zod";
import {
  assumptionsFileSchema,
  capexFileSchema,
  formulasFileSchema,
  parametersFileSchema,
  regionsFileSchema,
  sourcesFileSchema,
  type SpecData,
} from "../src/schemas.ts";
import { checkSpec } from "../src/checks.ts";

const ROOT = resolve(import.meta.dirname, "../../..");
const DATA = resolve(ROOT, "data");
const OUT = resolve(import.meta.dirname, "../src/generated");
const checkOnly = process.argv.includes("--check");

const errors: string[] = [];
const hash = createHash("sha256");

function load<S extends z.ZodType>(file: string, schema: S): z.infer<S> | null {
  const text = readFileSync(resolve(DATA, file), "utf8");
  hash.update(file).update("\0").update(text).update("\0");
  const result = schema.safeParse(parse(text));
  if (!result.success) {
    for (const issue of result.error.issues) {
      errors.push(`${file}: ${issue.path.join(".")} — ${issue.message}`);
    }
    return null;
  }
  return result.data;
}

const sources = load("sources.yaml", sourcesFileSchema);
const parameters = load("parameters.yaml", parametersFileSchema);
const capex = load("capex_items.yaml", capexFileSchema);
const regions = load("regions.yaml", regionsFileSchema);
const formulas = load("formulas.yaml", formulasFileSchema);
const assumptions = load("company_assumptions.yaml", assumptionsFileSchema);

if (!sources || !parameters || !capex || !regions || !formulas || !assumptions) {
  report();
  process.exit(1);
}

const spec: SpecData = {
  sources: sources.sources,
  parameters: parameters.parameters,
  capexItems: capex.items,
  regions: regions.regions,
  formulas: formulas.formulas,
  assumptions: assumptions.versions,
};

const { errors: checkErrors, warnings } = checkSpec(spec);
errors.push(...checkErrors);
if (errors.length) {
  report(warnings);
  process.exit(1);
}

const specVersion = hash.digest("hex").slice(0, 12);
const actualizedAt = spec.sources
  .map((s) => s.accessed)
  .filter((d): d is string => d !== null)
  .sort()
  .at(-1) ?? null;

const union = (typeName: string, constName: string, ids: string[], doc: string) =>
  `/** ${doc} */\nexport const ${constName} = [\n${ids.map((id) => `  ${JSON.stringify(id)},`).join("\n")}\n] as const;\n` +
  `export type ${typeName} = (typeof ${constName})[number];\n`;

const files: Record<string, string> = {
  "spec.json": JSON.stringify({ specVersion, actualizedAt, ...spec }, null, 2) + "\n",
  "ids.ts":
    "// Файл сгенерирован packages/spec/scripts/build-spec.ts из data/*.yaml. Не редактировать вручную.\n\n" +
    `/** Версия справочника: хеш содержимого data/*.yaml. Сохраняется в каждой версии расчёта. */\n` +
    `export const SPEC_VERSION = ${JSON.stringify(specVersion)};\n` +
    `/** Дата актуализации справочника: самая поздняя дата проверки источника. */\n` +
    `export const SPEC_ACTUALIZED_AT = ${JSON.stringify(actualizedAt)};\n\n` +
    union("SourceId", "SOURCE_IDS", spec.sources.map((s) => s.id), "ID источников из data/sources.yaml") + "\n" +
    union("ParameterId", "PARAMETER_IDS", spec.parameters.map((p) => p.id), "ID параметров из data/parameters.yaml") + "\n" +
    union("FormulaId", "FORMULA_IDS", spec.formulas.map((f) => f.id), "ID формул из data/formulas.yaml") + "\n" +
    union("CapexItemId", "CAPEX_ITEM_IDS", spec.capexItems.map((c) => c.item_id), "ID статей бюджета из data/capex_items.yaml") + "\n" +
    union("RegionCode", "REGION_CODES", spec.regions.map((r) => r.code), "Коды субъектов РФ из data/regions.yaml"),
};

let stale = false;
if (!checkOnly) mkdirSync(OUT, { recursive: true });
for (const [name, content] of Object.entries(files)) {
  const path = resolve(OUT, name);
  const current = existsSync(path) ? readFileSync(path, "utf8") : null;
  if (checkOnly) {
    if (current !== content) {
      stale = true;
      console.error(`УСТАРЕЛ: packages/spec/src/generated/${name} — запустите pnpm spec:build`);
    }
  } else if (current !== content) {
    writeFileSync(path, content);
  }
}

report(warnings);
console.log(
  `Справочник ${specVersion}: источников ${spec.sources.length}, параметров ${spec.parameters.length}, ` +
    `формул ${spec.formulas.length}, статей бюджета ${spec.capexItems.length}, регионов ${spec.regions.length}, ` +
    `версий справочника допущений ${spec.assumptions.length}. Ошибки: 0`,
);
if (stale) process.exit(1);

function report(warns: string[] = []) {
  for (const w of warns) console.log(`  WARN ${w}`);
  for (const e of errors) console.error(`  ERROR ${e}`);
  if (errors.length) console.error(`Ошибки: ${errors.length}`);
}
