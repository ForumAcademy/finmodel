/**
 * Расчёт проекта целиком: входные данные (своё значение → стандарт компании → по умолчанию), горизонт, запуск ядра,
 * пара режимов «расчёт сервиса / как в исходном Excel». Раньше жило в интерфейсе старого сервиса (lib/model.ts);
 * перенесено в ядро, чтобы экраны только показывали результат.
 */
import { getParameter, spec, type FormulaId, type ParameterId, type SpecAssumptionVersion as AssumptionVersion } from "@fm/spec";
import { Engine, sinkFormulas } from "./context";
import { legacyCaseInput, type LegacyCase } from "./legacy";
import { legacyChecks } from "./legacy-checks";
import { dataQuestions, type DataQuestion } from "./legacy-questions";
import { FORMULAS } from "./registry";
import type { CalcMessage, ProjectInput, ResultSet } from "./types";

/** Версии справочника допущений компании из спецификации (data/company_assumptions.yaml). */
export const SPEC_ASSUMPTIONS: AssumptionVersion[] = spec.assumptions;

/** Проект для расчёта: вводные, версия справочника допущений и, если проект создан из Excel, кейс исходника. */
export interface CalcProject {
  input: ProjectInput;
  /** Версия справочника допущений компании, на которой создан проект. */
  assumptionsVersion?: number;
  /** Кейс исходного Excel (ячейки для вопросов к данным); только у проектов, созданных из исходника. */
  legacyCase?: LegacyCase;
  /** Расхождения внутри исходного Excel: показываются в расчёте «как в исходном Excel». */
  legacyWarnings?: CalcMessage[];
}

export function versionOf(versions: AssumptionVersion[], n: number | undefined): AssumptionVersion | null {
  return n === undefined ? null : (versions.find((v) => v.version === n) ?? null);
}

/** Параметры, которые есть в справочнике допущений (в любой версии). */
export function assumptionParams(versions: AssumptionVersion[]): Set<ParameterId> {
  return new Set(versions.flatMap((v) => v.items.map((i) => i.param)));
}

/** Стандартные значения версии: только заданные (null — стандарта нет, значение вводится в проекте). */
export function standardValues(v: AssumptionVersion | null): Partial<Record<ParameterId, unknown>> {
  if (!v) return {};
  return Object.fromEntries(v.items.filter((i) => i.value !== null && i.value !== undefined).map((i) => [i.param, i.value]));
}

const excelCache = new WeakMap<LegacyCase, Partial<Record<ParameterId, unknown>>>();

/** Значения исходного Excel для параметров справочника допущений (расчёт «как в исходном Excel» берёт их, а не стандарт). */
function excelAssumptionValues(c: LegacyCase, versions: AssumptionVersion[]): Partial<Record<ParameterId, unknown>> {
  if (!excelCache.has(c)) {
    const params = assumptionParams(versions);
    const all = legacyCaseInput(c).values;
    excelCache.set(c, Object.fromEntries(Object.entries(all).filter(([k]) => params.has(k as ParameterId))));
  }
  return excelCache.get(c) ?? {};
}

/**
 * Статьи, которые в расчёте сервиса у проекта из Excel считаются по справочнику, а не суммой исходника: резерв —
 * ставка справочника (2% по методике Минстроя 421/пр) × стоимость СМР, график — по СМР (решение владельца продукта
 * 27.09.2026). Если сумму статьи изменили в проекте, остаётся она.
 */
const SERVICE_BY_RATE = ["CONTINGENCY"];

function serviceCapex(values: ProjectInput["values"], c: LegacyCase): ProjectInput["values"] {
  const rows = values["CAPEX.ITEMS"];
  if (!Array.isArray(rows)) return values;
  const excel = new Map((c.capex_legacy ?? []).map((x) => [x.item_id, x.amount_F]));
  const next = rows.map((r) => {
    const row = r as { item_id?: string; base?: string; rate?: number };
    const byExcel = row.item_id && SERVICE_BY_RATE.includes(row.item_id) && row.base === "фикс" && row.rate === excel.get(row.item_id);
    return byExcel ? { item_id: row.item_id } : r;
  });
  return { ...values, "CAPEX.ITEMS": next };
}

/**
 * Входные данные ядра: значения проекта + стандарт компании по версии проекта. В расчёте «как в исходном Excel»
 * параметры справочника берутся из исходного Excel (один в один), если в проекте их не меняли.
 */
export function projectInput(project: CalcProject, versions: AssumptionVersion[] = SPEC_ASSUMPTIONS): ProjectInput {
  const standard = standardValues(versionOf(versions, project.assumptionsVersion));
  const legacy = project.input.mode === "legacy" && project.legacyCase;
  const values = legacy
    ? { ...excelAssumptionValues(project.legacyCase as LegacyCase, versions), ...project.input.values }
    : project.legacyCase
      ? serviceCapex(project.input.values, project.legacyCase)
      : project.input.values;
  return { ...project.input, values, standard };
}

/** Действующее значение параметра в проекте: своё → стандарт компании → значение по умолчанию. */
export function projectValue(project: CalcProject, id: ParameterId, versions: AssumptionVersion[] = SPEC_ASSUMPTIONS): unknown {
  const input = projectInput(project, versions);
  return input.values[id] ?? input.standard?.[id] ?? getParameter(id).default ?? null;
}

const MONTHS_PER_YEAR = 12;
const YEAR = [0, 4] as const;
const MONTH = [5, 7] as const;

/** Месяцев от даты начала модели до даты (по календарным месяцам). */
function monthsFrom(start: string): (d: string) => number {
  const y = (d: string) => Number(d.slice(...YEAR));
  const m = (d: string) => Number(d.slice(...MONTH));
  return (d) => (y(d) - y(start)) * MONTHS_PER_YEAR + (m(d) - m(start));
}

/** Последний период ручного ряда, в котором есть ненулевое значение (-1 — нет). */
function lastFilled(xs: number[]): number {
  return xs.reduce((acc: number, v, p) => (v ? p : acc), -1);
}

interface ManualRow {
  from?: string;
  step_months?: number;
  values?: number[];
  weights?: number[];
}

/** Последний месяц ручных рядов (темп продаж, графики статей бюджета): горизонт не должен их обрезать. */
function manualEnd(rows: unknown, field: "manual" | "schedule_manual", series: "values" | "weights", monthsTo: (d: string) => number): number {
  if (!Array.isArray(rows)) return 0;
  return rows.reduce((max: number, r) => {
    const m = (r as Record<string, ManualRow | undefined>)[field];
    const xs = m?.[series];
    if (!m?.from || !m.step_months || !xs) return max;
    const last = lastFilled(xs);
    return last < 0 ? max : Math.max(max, monthsTo(m.from) + last * m.step_months);
  }, 0);
}

/**
 * Горизонт модели, месяцев: до последней вехи + лаг раскрытия эскроу, но не короче ручных графиков бюджета и темпа
 * продаж. Предварительное правило старого сервиса: формула горизонта (F.CF.HORIZON) появится вместе с денежным потоком.
 */
export function projectHorizon(project: CalcProject, versions: AssumptionVersion[] = SPEC_ASSUMPTIONS): number | null {
  const start = project.input.values["GEN.MODEL_START_DATE"];
  const rows = project.input.values["TIME.MILESTONES"];
  if (typeof start !== "string" || !Array.isArray(rows)) return null;
  const dates = rows.flatMap((r) =>
    Object.entries(r as Record<string, unknown>)
      .filter(([k, v]) => k !== "phase" && typeof v === "string" && v)
      .map(([, v]) => v as string),
  );
  if (dates.length === 0) return null;
  const monthsTo = monthsFrom(start);
  const last = dates.reduce((a, b) => (b > a ? b : a));
  const lag = Number(projectValue(project, "TIME.ESCROW_RELEASE_LAG_M", versions) ?? 0);
  const capexEnd = manualEnd(project.input.values["CAPEX.ITEMS"], "schedule_manual", "weights", monthsTo);
  const salesEnd = manualEnd(project.input.values["SALES.PACE"], "manual", "values", monthsTo);
  return Math.max(monthsTo(last) + 1 + lag, capexEnd + 1, salesEnd + 1, 1);
}

/**
 * Что считать: итоговые формулы (корни графа) + показатели ТЭП и участка, которые показываются на любой стадии,
 * даже если бюджет их не читает (в расчёте «как в исходном Excel» суммы статей берутся из исходника).
 */
const TARGETS: FormulaId[] = [
  ...sinkFormulas(Object.keys(FORMULAS) as FormulaId[]),
  "F.SALES.REVENUE_TOTAL",
  "F.SALES.WAVG_PRICE",
  "F.CAPEX.TOTAL",
  "F.TEP.PARKING_COUNT",
  "F.TEP.GFA_SPLIT",
  "F.TEP.GFA_TOTAL",
  "F.TEP.SALEABLE_AREA",
  "F.TEP.LANDSCAPE_AREA",
  "F.LAND.TAX_OR_RENT",
  "F.LAND.VRI_FEE",
];

export interface ProjectModel {
  result: ResultSet;
  horizon: number | null;
  /** Параметры, которые нужно заполнить (ошибка «заполните …» в расчёте). */
  missing: Set<ParameterId>;
  /** Версии справочника допущений, с которыми посчитан проект. */
  versions: AssumptionVersion[];
  /** Входные данные, с которыми посчитан проект (своё + стандарт; для проекта из Excel — с поправками режима). */
  input: ProjectInput;
}

export function computeProject(project: CalcProject, versions: AssumptionVersion[] = SPEC_ASSUMPTIONS): ProjectModel {
  const horizon = projectHorizon(project, versions);
  const input = projectInput(project, versions);
  const calc = new Engine(input, FORMULAS, horizon === null ? {} : { horizonMonths: horizon }).run(TARGETS);
  const result = project.input.mode === "legacy" && project.legacyWarnings ? { ...calc, messages: [...calc.messages, ...project.legacyWarnings] } : calc;
  const missing = new Set(result.messages.filter((m) => m.severity === "error" && m.parameterId).map((m) => m.parameterId as ParameterId));
  return { result, horizon, missing, versions, input };
}

/** Тот же проект в режиме mode. */
export function inMode(project: CalcProject, mode: "legacy" | "normal"): CalcProject {
  return { ...project, input: { ...project.input, mode } };
}

/**
 * Пара расчётов для проекта из исходного Excel: «как в исходном Excel» и расчёт сервиса. null — проект не из Excel.
 */
export function modePair(project: CalcProject, versions: AssumptionVersion[] = SPEC_ASSUMPTIONS): { legacy: ProjectModel; normal: ProjectModel; normalProject: CalcProject } | null {
  if (!project.legacyCase) return null;
  const normalProject = inMode(project, "normal");
  return { legacy: computeProject(inMode(project, "legacy"), versions), normal: computeProject(normalProject, versions), normalProject };
}

/** Предупреждения расчёта «как в исходном Excel»: расхождения исходного Excel, которые он повторяет как есть. */
export function compatWarnings(project: CalcProject, m: ProjectModel): CalcMessage[] {
  return project.input.mode === "legacy" ? m.result.messages.filter((x) => x.severity === "warning" && x.key) : [];
}

/** Вопросы расчёта «как в исходном Excel» к исходному файлу; у проекта без исходного Excel их нет. */
export function projectQuestions(project: CalcProject, versions: AssumptionVersion[] = SPEC_ASSUMPTIONS): DataQuestion[] {
  if (!project.legacyCase) return [];
  const legacy = inMode(project, "legacy");
  return dataQuestions(project.legacyCase, projectInput(legacy, versions), computeProject(legacy, versions).result);
}

/**
 * Проект из кейса исходного Excel (tests/cases/*_legacy.yaml). Значения справочника допущений проект берёт из
 * справочника: версия 1 заполнена из этого же Excel, поэтому числа те же. Расчёт «как в исходном Excel» берёт их
 * из исходника (projectInput).
 */
export function legacyProject(c: LegacyCase, name: string, versions: AssumptionVersion[] = SPEC_ASSUMPTIONS): CalcProject {
  const excel = legacyCaseInput(c);
  const params = assumptionParams(versions);
  const values = Object.fromEntries(Object.entries(excel.values).filter(([k]) => !params.has(k as ParameterId)));
  return {
    input: { ...excel, values: { ...values, "GEN.PROJECT_NAME": name } },
    assumptionsVersion: 1,
    legacyCase: c,
    legacyWarnings: legacyChecks(c),
  };
}
