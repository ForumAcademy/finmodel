import type { FormulaId } from "@fm/spec";
import type { FormulaFn, StepFormulaFn } from "./context";
import { CAPEX_FORMULAS } from "./modules/capex";
import { CF_FORMULAS } from "./modules/cf";
import { CHECK_FORMULAS } from "./modules/check";
import { ESCROW_FORMULAS } from "./modules/escrow";
import { FIN_FORMULAS } from "./modules/fin";
import { KPI_FORMULAS } from "./modules/kpi";
import { LAND_FORMULAS } from "./modules/land";
import { SALES_FORMULAS } from "./modules/sales";
import { TAX_FORMULAS } from "./modules/tax";
import { TEP_FORMULAS } from "./modules/tep";
import { TIME_FORMULAS } from "./modules/time";

/** Все реализованные формулы: ID из data/formulas.yaml → функция с тем же именем. */
export const FORMULAS: Partial<Record<FormulaId, FormulaFn | StepFormulaFn>> = {
  ...TIME_FORMULAS,
  ...TEP_FORMULAS,
  ...LAND_FORMULAS,
  ...CAPEX_FORMULAS,
  ...SALES_FORMULAS,
  ...ESCROW_FORMULAS,
  ...FIN_FORMULAS,
  ...TAX_FORMULAS,
  ...CF_FORMULAS,
  ...KPI_FORMULAS,
  ...CHECK_FORMULAS,
};

/**
 * Модули, реализованные полностью: для них тест требует функцию на каждую формулу YAML. CHECK — частично: проверка
 * вместимости подземной части ждёт бенчмарков (модуль BENCH).
 */
export const IMPLEMENTED_MODULES = ["TIME", "TEP", "LAND", "CAPEX", "SALES", "ESCROW", "FIN", "TAX", "CF", "KPI"] as const;
