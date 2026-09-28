/**
 * @fm/engine — расчётное ядро: одна формула из data/formulas.yaml = одна функция с тем же ID.
 * Каждая формула пишет след (что прочитала и что получила) — из него строится паспорт показателя.
 */
import { type FormulaId } from "@fm/spec";
import { Engine, sinkFormulas } from "./context";
import { FORMULAS } from "./registry";
import type { CalcOptions, ProjectInput, ResultSet } from "./types";

export { Engine, CalcError, MissingInputError, sinkFormulas, stepwise, stepGroups, type FormulaContext, type FormulaFn, type StepFormulaFn } from "./context";
export { FORMULAS, IMPLEMENTED_MODULES } from "./registry";
export { legacyAssumptions, legacyCaseInput, type LegacyAssumption, type LegacyCase, type LegacyChecks } from "./legacy";
export { legacyChecks } from "./legacy-checks";
export { fmtRub } from "./lib/format";
export * as text from "./lib/text";
export {
  assumptionParams,
  compatWarnings,
  computeProject,
  inMode,
  legacyProject,
  modePair,
  projectHorizon,
  projectInput,
  projectQuestions,
  projectValue,
  SPEC_ASSUMPTIONS,
  standardValues,
  versionOf,
  type CalcProject,
  type ProjectModel,
} from "./project";
export { cellQty, hasUnsold, paceLine, parkingWarning, rowName, salesRows, salesTotal, salesWarnings, type SalesRow, type SalesTotal, type SalesWarning } from "./explain/sales-summary";
export { aggregate, PERIOD_LABEL, periodKey, type Period } from "./explain/periods";
export { amount, compatDiff, exampleFocus, howExample, inputFields, shortSource, templateExample } from "./explain/how";
export { dataQuestions, LEGACY_QUESTION_MAX_NO, type DataQuestion, type Impact, type ImpactKind, type QuestionBlock } from "./legacy-questions";
export type * from "./types";

/** Модули ядра в порядке расчёта (docs/01_architecture.md). */
export const ENGINE_MODULES = [
  { id: "TIME", title: "Временная шкала и флаги", stage: 2 },
  { id: "TEP", title: "ТЭП", stage: 2 },
  { id: "LAND", title: "Участок", stage: 2 },
  { id: "CAPEX", title: "Бюджет", stage: 3 },
  { id: "SALES", title: "План продаж", stage: 4 },
  { id: "ESC", title: "Эскроу", stage: 4 },
  { id: "FIN", title: "Проектное финансирование", stage: 5 },
  { id: "TAX", title: "Налоги", stage: 6 },
  { id: "CF", title: "Денежный поток", stage: 6 },
  { id: "KPI", title: "Показатели", stage: 6 },
  { id: "CHECK", title: "Проверки", stage: 6 },
] as const;

export type EngineModuleId = (typeof ENGINE_MODULES)[number]["id"];

/**
 * Посчитать проект. По умолчанию — все реализованные формулы, которые нужны для итоговых
 * (формулы, нужные только на другой стадии проекта, не считаются и не требуют ввода).
 */
export function calculate(input: ProjectInput, options: CalcOptions = {}, targets?: readonly FormulaId[]): ResultSet {
  const engine = new Engine(input, FORMULAS, options);
  return engine.run(targets ?? sinkFormulas(Object.keys(FORMULAS) as FormulaId[]));
}
