/**
 * Загрузка финмодели в Excel в новый проект: файл читается по карте исходного Excel (legacy/legacy_values_map.csv →
 * src/generated/legacy-map.json, собирается scripts/build-map.mjs) и найденные числа подставляются в параметры проекта. У каждого подставленного значения
 * запоминается лист и ячейка. Что не подставлено, остаётся в прикреплённом файле и показывается списком.
 */
import { getCapexItem, getParameter, isCapexItemId, isParameterId, type ParameterId } from "@fm/spec";
import legacyMap from "./generated/legacy-map.json";
import { text } from "@fm/engine";

const { plural } = text;

export interface MapCell {
  sheet: string;
  cell: string;
  target: string;
  verdict: string;
  label: string;
}

/** Подставленное значение: параметр, число, лист и ячейка файла. */
export interface ImportedValue {
  param: ParameterId;
  value: unknown;
  sheet: string;
  cell: string;
}

/** Не подставлено: что это, где в файле и почему. */
export interface SkippedValue {
  label: string;
  sheet: string;
  cells: string;
  reason: string;
}

export interface FileImport {
  /** Документ проекта, в котором лежит файл. */
  sourceId: string;
  fileName: string;
  /** false — файл не прочитан или не похож на финмодель: параметры взяты из справочника. */
  ok: boolean;
  applied: ImportedValue[];
  skipped: SkippedValue[];
}

/** Ячейка, прочитанная из файла: число, дата «ГГГГ-ММ-ДД», текст или пусто. */
export type CellValue = number | string | null;

/** Чтение ячейки по имени листа (без пробелов по краям) и адресу. null — листа нет. */
export type CellReader = (sheet: string, cell: string) => CellValue | undefined;

/** Параметры, которые задаются в форме «Новый проект»: значения формы важнее значений файла. */
export const FORM_PARAMS: ParameterId[] = ["GEN.PROJECT_NAME", "GEN.REGION_CODE", "GEN.HOUSING_CLASS", "GEN.MODEL_START_DATE", "GEN.CADASTRAL_NUMBER", "LAND.AREA"];

/**
 * Типы квартир исходного Excel (ТЭПы, строки 41–43, как в scripts/build_legacy_case.py): B — название, D — средняя
 * площадь, F — количество, I — норма машино-мест на квартиру.
 */
const APT_SHEET = "ТЭПы";
const APT_ROWS = [41, 42, 43];

const MAP = legacyMap as MapCell[];

/** Карта: только ячейки, которые можно прочитать (вердикт не «удалить»). */
export function importMap(): MapCell[] {
  return MAP;
}

/** Название для списка «не подставлено»: статья бюджета или параметр сервиса, иначе подпись строки в файле. */
function label(target: string, rowLabel: string): string {
  const [base = "", tail] = target.split(".schedule");
  const item = /^CAPEX\.ITEMS\[(.+)\]$/.exec(base)?.[1];
  if (item && isCapexItemId(item)) return `${getCapexItem(item).name}${tail !== undefined ? ": график оплат" : ": сумма"}`;
  if (isParameterId(base) && base !== "CAPEX.ITEMS") return getParameter(base).name;
  return rowLabel || target;
}

/** Ячейки одной группы для списка: до трёх — через запятую, больше — первая … последняя и сколько всего. */
const FEW_CELLS = 3;
function cellsText(cells: string[]): string {
  if (cells.length <= FEW_CELLS) return cells.join(", ");
  return `${cells[0]} … ${cells.at(-1)}, ${cells.length} ${plural(cells.length, ["ячейка", "ячейки", "ячеек"])}`;
}

const isNum = (v: CellValue | undefined): v is number => typeof v === "number" && Number.isFinite(v);

/**
 * Разбор файла по карте. read — чтение ячейки; formParams — параметры, которые уже заданы в форме.
 * Одиночные числа карты с вердиктом «оставить» подставляются как есть; ставки по закону (НДС, налог на прибыль)
 * остаются из справочника. Таблица типов квартир собирается целиком, если заполнены все её строки.
 */
export function readByMap(read: CellReader, formParams: ReadonlySet<ParameterId>): { applied: ImportedValue[]; skipped: SkippedValue[] } {
  const applied: ImportedValue[] = [];
  const skipped: SkippedValue[] = [];
  const handled = new Set<string>();
  const key = (c: MapCell) => `${c.sheet}!${c.cell}`;

  for (const c of MAP) {
    if (c.verdict !== "keep" || !isParameterId(c.target)) continue;
    const p = getParameter(c.target);
    if (p.kind !== "scalar" && p.kind !== "date") continue;
    if (applied.some((a) => a.param === c.target)) continue;
    handled.add(key(c));
    const v = read(c.sheet, c.cell);
    const name = p.name;
    if (v === undefined) continue;
    if (formParams.has(c.target)) {
      if (v !== null) skipped.push({ label: name, sheet: c.sheet, cells: c.cell, reason: "указано в форме" });
      continue;
    }
    if (p.scope === "template") {
      skipped.push({ label: name, sheet: c.sheet, cells: c.cell, reason: "ставка по закону, берётся из Справочника" });
      continue;
    }
    const ok = p.kind === "date" ? typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) : isNum(v);
    if (ok) applied.push({ param: c.target, value: v, sheet: c.sheet, cell: c.cell });
    else if (v !== null) skipped.push({ label: name, sheet: c.sheet, cells: c.cell, reason: p.kind === "date" ? "не дата" : "не число" });
  }

  // Типы квартир и нормы машино-мест по типам (таблицы).
  const rows = APT_ROWS.map((r) => ({ name: read(APT_SHEET, `B${r}`), area: read(APT_SHEET, `D${r}`), count: read(APT_SHEET, `F${r}`), norm: read(APT_SHEET, `I${r}`) }));
  const first = APT_ROWS[0];
  const last = APT_ROWS.at(-1);
  if (rows.every((r) => typeof r.name === "string" && r.name.trim() && isNum(r.area) && isNum(r.count))) {
    applied.push({
      param: "TEP.APT_MIX",
      value: rows.map((r) => ({ type_name: String(r.name).trim(), count: r.count, avg_area: r.area })),
      sheet: APT_SHEET,
      cell: `B${first}:F${last}`,
    });
    MAP.filter((c) => c.target === "TEP.APT_MIX").forEach((c) => handled.add(key(c)));
    if (rows.every((r) => isNum(r.norm))) {
      applied.push({ param: "TEP.PARKING_NORM", value: { rule: "per_type", values: rows.map((r) => r.norm) }, sheet: APT_SHEET, cell: `I${first}:I${last}` });
      MAP.filter((c) => c.target === "TEP.PARKING_NORM").forEach((c) => handled.add(key(c)));
    }
  }

  // Остальное по карте — группами «что это, лист, ячейки», если в файле там что-то есть.
  const groups = new Map<string, MapCell[]>();
  for (const c of MAP) {
    if (handled.has(key(c))) continue;
    const g = `${c.sheet}|${c.target}`;
    groups.set(g, [...(groups.get(g) ?? []), c]);
  }
  for (const cells of groups.values()) {
    const filled = cells.filter((c) => {
      const v = read(c.sheet, c.cell);
      return v !== undefined && v !== null && v !== "";
    });
    const head = filled[0];
    if (!head) continue;
    skipped.push({ label: label(head.target, head.label), sheet: head.sheet, cells: cellsText(filled.map((c) => c.cell)), reason: "перенесите вручную" });
  }
  return { applied, skipped };
}

/** Значение ячейки exceljs → число / дата / текст / пусто. */
function plain(v: unknown): CellValue {
  if (v === null || v === undefined) return null;
  if (typeof v === "number") return v;
  if (typeof v === "string") return v.trim() === "" ? null : v;
  if (typeof v === "boolean") return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === "object") {
    const o = v as { result?: unknown; richText?: { text: string }[]; text?: string; error?: string };
    if ("result" in o) return plain(o.result);
    if (o.richText) return plain(o.richText.map((t) => t.text).join(""));
    if (typeof o.text === "string") return plain(o.text);
  }
  return null;
}

/** Файл → чтение ячеек. Бросает исключение, если файл не открывается как книга Excel (.xlsx, .xlsm). */
export async function workbookReader(data: ArrayBuffer): Promise<CellReader> {
  const ExcelJS = (await import("exceljs")).default;
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(data);
  const sheets = new Map(wb.worksheets.map((ws) => [ws.name.trim(), ws]));
  return (sheet, cell) => {
    const ws = sheets.get(sheet);
    return ws ? plain(ws.getCell(cell).value) : undefined;
  };
}

/** Файл → подставленные и не подставленные значения; null — файл не прочитан или в нём не нашлось ни одного значения карты. */
export async function readModelFile(data: ArrayBuffer, formParams: ReadonlySet<ParameterId>): Promise<{ applied: ImportedValue[]; skipped: SkippedValue[] } | null> {
  try {
    const result = readByMap(await workbookReader(data), formParams);
    return result.applied.length ? result : null;
  } catch {
    return null;
  }
}
