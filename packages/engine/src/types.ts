import type Decimal from "decimal.js";
import type { FormulaId, ParameterId, RegionCode } from "@fm/spec";

/**
 * Откуда взято значение параметра: проект, справочник допущений компании (стандарт, версия зафиксирована в проекте),
 * справочник регионов или значение по умолчанию из parameters.yaml.
 */
export type ValueOrigin = "project" | "standard" | "region" | "template";

/** Режим расчёта: расчёт сервиса (normal) или «как в исходном Excel» (legacy, tests/cases/*_legacy.yaml). */
export type CalcMode = "normal" | "legacy";

/** Входные данные проекта: значения параметров по ID (docs/passports/engine.md). */
export interface ProjectInput {
  values: Partial<Record<ParameterId, unknown>>;
  /**
   * Стандартные значения компании (data/company_assumptions.yaml, версия, на которой создан проект). Действуют там, где
   * у проекта нет своего значения; своё значение проекта всегда главнее.
   */
  standard?: Partial<Record<ParameterId, unknown>>;
  mode?: CalcMode;
}

export interface CalcOptions {
  /**
   * Горизонт модели в месяцах (число значений t). Правило определения горизонта в спецификации
   * пока не задано — вопрос владельцу продукта; до решения горизонт передаёт вызывающий код.
   */
  horizonMonths?: number;
}

export type Severity = "error" | "warning" | "info";

/** Сообщение расчёта: ошибка (блокирует отчёт), предупреждение или информация. */
export interface CalcMessage {
  severity: Severity;
  formulaId: FormulaId;
  text: string;
  /** Параметр, который нужно заполнить или исправить. */
  parameterId?: ParameterId;
  /**
   * Постоянный ключ условия («CAPEX.SCHEDULE_SUM:ROADS_UDS»): одно и то же расхождение в разных прогонах имеет один
   * ключ. По нему предупреждения расчёта «как в исходном Excel» связываются с вопросами к данным.
   */
  key?: string;
}

/** Узел следа: значение формулы и все прочитанные ею параметры и формулы. */
export interface TraceNode {
  id: FormulaId;
  value: unknown;
  inputs: (ParameterId | FormulaId)[];
}

export interface ParameterTrace {
  id: ParameterId;
  value: unknown;
  origin: ValueOrigin;
}

/** Результат расчёта: значения всех посчитанных формул + след для паспорта показателя. */
export interface ResultSet {
  regionCode: RegionCode | null;
  formulas: Partial<Record<FormulaId, TraceNode>>;
  parameters: Partial<Record<ParameterId, ParameterTrace>>;
  messages: CalcMessage[];
}

export type Num = Decimal;
