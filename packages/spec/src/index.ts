/**
 * @fm/spec — типизированный справочник модели из data/*.yaml.
 *
 * Данные проверяются zod-схемами и перекрёстными проверками при сборке (`pnpm spec:build`)
 * и попадают в src/generated/. ID параметров, формул, источников, статей и регионов —
 * union-типы: ссылка на несуществующий ID в коде — ошибка компиляции.
 */
import data from "./generated/spec.json";
import {
  CAPEX_ITEM_IDS,
  FORMULA_IDS,
  PARAMETER_IDS,
  REGION_CODES,
  SOURCE_IDS,
  type CapexItemId,
  type FormulaId,
  type ParameterId,
  type RegionCode,
  type SourceId,
} from "./generated/ids";
import type { AssumptionItem, AssumptionVersion, CapexItem, Formula, Parameter, Region, Source } from "./schemas";

export * from "./generated/ids";
export { assumptionValueProblem, checkAssumptions, checkSpec, type SpecCheckResult } from "./checks";
export {
  ASSUMPTION_GROUPS,
  ASSUMPTION_STATUSES,
  CAPEX_SCHEDULE_RULES,
  FORMULA_MODULES,
  MILESTONE_KEYS,
  PARAMETER_KINDS,
  PARAMETER_SCOPES,
  PARAMETER_STATUSES,
  REGION_STATUSES,
  SOURCE_LEVELS,
  SOURCE_SCOPES,
} from "./schemas";
export type { AssumptionItem, AssumptionVersion, CapexItem, Formula, Parameter, Region, Source, SpecData } from "./schemas";

/** Файлы справочника — единственный источник правды (CLAUDE.md). */
export const SPEC_FILES = [
  "sources.yaml",
  "parameters.yaml",
  "capex_items.yaml",
  "regions.yaml",
  "formulas.yaml",
  "company_assumptions.yaml",
] as const;
export type SpecFile = (typeof SPEC_FILES)[number];

// ---------- записи с типизированными ссылками ----------

export type SpecSource = Omit<Source, "id"> & { id: SourceId };
export type SpecParameter = Omit<Parameter, "id" | "source_ids"> & { id: ParameterId; source_ids: SourceId[] };
export type SpecFormula = Omit<Formula, "id" | "source_ids" | "depends_on" | "lag_depends_on"> & {
  id: FormulaId;
  source_ids: SourceId[];
  depends_on: (ParameterId | FormulaId)[];
  lag_depends_on?: FormulaId[];
};
export type SpecCapexItem = Omit<CapexItem, "item_id" | "source_ids" | "rate_param" | "formula"> & {
  item_id: CapexItemId;
  source_ids: SourceId[];
  rate_param?: ParameterId;
  formula?: FormulaId;
};
export type SpecRegion = Omit<
  Region,
  | "code"
  | "ncs_k_per_source_ids"
  | "land_tax_source_ids"
  | "land_tax_rate_housing"
  | "land_rent_source_ids"
  | "vri_fee"
  | "parking_norm"
  | "parking_norm_apart"
  | "ngp_source_ids"
> & {
  code: RegionCode;
  ncs_k_per_source_ids: SourceId[];
  land_tax_source_ids: SourceId[];
  land_tax_rate_housing?: Omit<NonNullable<Region["land_tax_rate_housing"]>, "source_ids"> & { source_ids: SourceId[] };
  land_rent_source_ids: SourceId[];
  vri_fee: Omit<Region["vri_fee"], "source_ids"> & { source_ids: SourceId[] };
  parking_norm: Omit<Region["parking_norm"], "source_ids"> & { source_ids: SourceId[] };
  parking_norm_apart: Omit<Region["parking_norm_apart"], "source_ids"> & { source_ids: SourceId[] };
  ngp_source_ids: SourceId[];
};

export type SpecAssumptionItem = Omit<AssumptionItem, "param"> & { param: ParameterId };
export type SpecAssumptionVersion = Omit<AssumptionVersion, "items"> & { items: SpecAssumptionItem[] };

export interface Spec {
  /** Хеш содержимого data/*.yaml — сохраняется в каждой версии расчёта. */
  specVersion: string;
  /** Самая поздняя дата проверки источника (ГГГГ-ММ-ДД). */
  actualizedAt: string | null;
  sources: SpecSource[];
  parameters: SpecParameter[];
  formulas: SpecFormula[];
  capexItems: SpecCapexItem[];
  regions: SpecRegion[];
  /** Справочник допущений компании по версиям; последняя — текущая. */
  assumptions: SpecAssumptionVersion[];
}

/**
 * Справочник целиком. Приведение типа безопасно: содержимое проверено схемами (src/schemas.ts)
 * и перекрёстными проверками (src/checks.ts) при генерации, а тест test/generated.test.ts
 * сверяет spec.json с data/*.yaml.
 */
export const spec = data as unknown as Spec;

const index = <T, K extends string>(items: T[], key: (item: T) => K) =>
  new Map<K, T>(items.map((item) => [key(item), item]));

const sourcesById = index(spec.sources, (s) => s.id);
const parametersById = index(spec.parameters, (p) => p.id);
const formulasById = index(spec.formulas, (f) => f.id);
const capexById = index(spec.capexItems, (c) => c.item_id);
const regionsByCode = index(spec.regions, (r) => r.code);

function must<T>(value: T | undefined, what: string, id: string): T {
  if (value === undefined) throw new Error(`${what} ${id} отсутствует в справочнике`);
  return value;
}

export const getSource = (id: SourceId): SpecSource => must(sourcesById.get(id), "Источник", id);
export const getParameter = (id: ParameterId): SpecParameter => must(parametersById.get(id), "Параметр", id);
export const getFormula = (id: FormulaId): SpecFormula => must(formulasById.get(id), "Формула", id);
export const getCapexItem = (id: CapexItemId): SpecCapexItem => must(capexById.get(id), "Статья бюджета", id);
export const getRegion = (code: RegionCode): SpecRegion => must(regionsByCode.get(code), "Регион", code);

// ---------- проверки строк, пришедших извне (БД, форма, Excel) ----------

const has = (list: readonly string[]) => {
  const set = new Set(list);
  return (value: string) => set.has(value);
};
export const isSourceId: (value: string) => value is SourceId = has(SOURCE_IDS) as never;
export const isParameterId: (value: string) => value is ParameterId = has(PARAMETER_IDS) as never;
export const isFormulaId: (value: string) => value is FormulaId = has(FORMULA_IDS) as never;
export const isCapexItemId: (value: string) => value is CapexItemId = has(CAPEX_ITEM_IDS) as never;
export const isRegionCode: (value: string) => value is RegionCode = has(REGION_CODES) as never;

// ---------- имя функции ядра по ID формулы (CLAUDE.md, правило 2) ----------

type DotsToUnderscores<S extends string> = S extends `${infer A}.${infer B}` ? `${A}_${DotsToUnderscores<B>}` : S;
/** Имя функции ядра для формулы: F.FIN.RATE → F_FIN_RATE. */
export type FormulaFnName<T extends FormulaId = FormulaId> = DotsToUnderscores<T>;

export function formulaFnName<T extends FormulaId>(id: T): FormulaFnName<T> {
  return id.replaceAll(".", "_") as FormulaFnName<T>;
}
