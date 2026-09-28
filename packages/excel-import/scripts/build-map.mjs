// Карта исходного Excel для загрузки файла в новый проект: legacy/legacy_values_map.csv → src/generated/legacy-map.json.
// Ячейки с вердиктом remove (дубли, вычисляемые значения) не читаются. С флагом --check только проверяет, что файл актуален.
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const csv = readFileSync(resolve(root, "../../legacy/legacy_values_map.csv"), "utf8").trim().split("\n");
const cols = (line) => {
  const out = [];
  let cur = "";
  let quoted = false;
  for (const ch of line) {
    if (ch === '"') quoted = !quoted;
    else if (ch === "," && !quoted) {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  return [...out, cur];
};
const head = cols(csv[0]);
const map = csv
  .slice(1)
  .map((line) => Object.fromEntries(cols(line).map((v, i) => [head[i], v])))
  .filter((r) => r.verdict !== "remove")
  .map((r) => ({ sheet: r.sheet.trim(), cell: r.cell, target: r.target_id, verdict: r.verdict, label: r.row_label.trim() }));
const out = resolve(root, "src/generated/legacy-map.json");
const text = JSON.stringify(map, null, 1) + "\n";
let current;
try {
  current = readFileSync(out, "utf8");
} catch {
  current = null;
}
if (process.argv.includes("--check")) {
  if (current !== text) {
    console.error("Карта исходного Excel устарела: запустите pnpm --filter @fm/excel-import map:build");
    process.exit(1);
  }
  console.log(`Карта исходного Excel актуальна: ${map.length} ячеек`);
} else if (current !== text) writeFileSync(out, text);
