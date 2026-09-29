import Decimal from "decimal.js";
import {
  FORMULA_IDS,
  getFormula,
  getParameter,
  getRegion,
  isRegionCode,
  type FormulaId,
  type ParameterId,
  type RegionCode,
  type SpecRegion,
} from "@fm/spec";
import type {
  CalcMessage,
  CalcMode,
  CalcOptions,
  ParameterTrace,
  ProjectInput,
  ResultSet,
  Severity,
  TraceNode,
  ValueOrigin,
} from "./types";

/** Функция формулы: имя совпадает с ID (F.FIN.RATE → F_FIN_RATE), CLAUDE.md, правило 2. */
export type FormulaFn = (ctx: FormulaContext) => unknown;

/**
 * Формула, которая считается по месяцам: значение месяца t. Нужна там, где формулы связаны друг с другом через прошлый
 * месяц (lag_depends_on в formulas.yaml: ставка ← покрытие за t−1 ← долг ← проценты ← ставка). Ядро находит такие группы
 * по графу depends_on и считает их помесячно: месяц t всех формул группы, затем t + 1. Результат месяца — число или
 * запись чисел; ряд собирается ядром (Decimal[] или запись рядов).
 */
export interface StepFormulaFn {
  (ctx: FormulaContext, t: number): unknown;
  stepwise: true;
}

/** Пометить функцию как помесячную (имя функции сохраняется — оно совпадает с ID формулы). */
export function stepwise<F extends (ctx: FormulaContext, t: number) => unknown>(fn: F): F & StepFormulaFn {
  return Object.assign(fn, { stepwise: true as const });
}

type AnyFormulaFn = FormulaFn | StepFormulaFn;

function isStepFn(fn: AnyFormulaFn): fn is StepFormulaFn {
  return (fn as Partial<StepFormulaFn>).stepwise === true;
}

/** Не заполнен обязательный параметр — формула не считается, пользователь видит, что ввести. */
export class MissingInputError extends Error {
  constructor(readonly parameterId: ParameterId) {
    super(`Не заполнен параметр ${parameterId}`);
  }
}

/** Формула не посчитана из-за ошибки в формуле, от которой она зависит (сообщение уже выдано там). */
export class DependencyError extends Error {
  constructor(readonly formulaId: FormulaId) {
    super(`Не посчитана формула ${formulaId}`);
  }
}

/** Блокирующая ошибка расчёта с текстом для пользователя. */
export class CalcError extends Error {
  constructor(
    message: string,
    readonly parameterId?: ParameterId,
  ) {
    super(message);
  }
}

/**
 * Значения region-параметров из data/regions.yaml. Параметр без поля в regions.yaml вводится по проекту
 * (например, TAX.LAND_RATE вне Москвы — ставка по ОКТМО).
 */
const REGION_VALUES: Partial<Record<ParameterId, (r: SpecRegion) => unknown>> = {
  "TEP.PARKING_NORM": (r) => (r.parking_norm.values ? r.parking_norm : null),
  "TEP.PARKING_NORM_APART": (r) => (r.parking_norm_apart.values ? r.parking_norm_apart : null),
  "TAX.LAND_RATE": (r) => r.land_tax_rate_housing?.value ?? null,
};

/** Что видит формула: только чтение параметров и других формул с записью в след. */
export interface FormulaContext {
  readonly mode: CalcMode;
  readonly horizonMonths: number | null;
  /** Значение параметра или null, если не задано. */
  param<T = unknown>(id: ParameterId): T | null;
  /** Значение параметра; если не задано — блокирующая ошибка «заполните параметр». */
  require<T = unknown>(id: ParameterId): T;
  /** Числовой параметр как Decimal или null. */
  num(id: ParameterId): Decimal | null;
  requireNum(id: ParameterId): Decimal;
  /**
   * Результат другой формулы. Внутри помесячной группы — ряд, собранный на текущий момент: формулы группы, посчитанные
   * раньше в этом месяце, — по месяц t включительно, остальные — по t − 1.
   */
  formula<T = unknown>(id: FormulaId): T;
  /** Помесячная формула: собственный ряд по месяц t − 1 (пустой вне помесячной группы). */
  own<T = unknown>(): T | null;
  /** Регион проекта (GEN.REGION_CODE) из data/regions.yaml. */
  region(): SpecRegion;
  message(severity: Severity, text: string, parameterId?: ParameterId, key?: string): void;
}

interface Frame {
  id: FormulaId;
  inputs: Set<ParameterId | FormulaId>;
}

export class Engine {
  readonly mode: CalcMode;
  readonly horizonMonths: number | null;
  private readonly values: ProjectInput["values"];
  private readonly standard: NonNullable<ProjectInput["standard"]>;
  private readonly nodes = new Map<FormulaId, TraceNode>();
  private readonly failed = new Set<FormulaId>();
  private readonly params = new Map<ParameterId, ParameterTrace>();
  private readonly messages: CalcMessage[] = [];
  private readonly stack: Frame[] = [];
  /** Группы формул, связанных через прошлый месяц: ID → группа (в порядке расчёта внутри месяца). */
  private readonly groups: Map<FormulaId, FormulaId[]>;
  /** Идёт помесячный расчёт группы: собранные ряды формул группы. */
  private step: { group: Set<FormulaId>; acc: Map<FormulaId, Assembled> } | null = null;

  constructor(
    input: ProjectInput,
    private readonly registry: Partial<Record<FormulaId, AnyFormulaFn>>,
    options: CalcOptions = {},
  ) {
    this.values = input.values;
    this.standard = input.standard ?? {};
    this.mode = input.mode ?? "normal";
    this.horizonMonths = options.horizonMonths ?? null;
    this.groups = stepGroups(Object.keys(registry) as FormulaId[]);
  }

  /** Посчитать формулу (с мемоизацией). Ошибки превращаются в сообщения, значение — null. */
  evaluate(id: FormulaId): unknown {
    const done = this.nodes.get(id);
    if (done) return done.value;
    if (this.failed.has(id)) throw new DependencyError(id);
    if (this.stack.some((f) => f.id === id)) {
      throw new Error(`Цикл в графе формул: ${[...this.stack.map((f) => f.id), id].join(" → ")}`);
    }
    const fn = this.registry[id];
    if (!fn) throw new Error(`Формула ${id} ещё не реализована`);
    const group = this.groups.get(id) ?? (isStepFn(fn) ? [id] : null);
    if (group) return this.runGroup(id, group);

    const frame: Frame = { id, inputs: new Set() };
    this.stack.push(frame);
    try {
      const value = (fn as FormulaFn)(this.context(frame));
      this.nodes.set(id, { id, value, inputs: [...frame.inputs] });
      return value;
    } catch (e) {
      this.failed.add(id);
      this.report(id, e);
      throw new DependencyError(id);
    } finally {
      this.stack.pop();
    }
  }

  /** Ошибка формулы → сообщение пользователю (неизвестная ошибка пробрасывается дальше). */
  private report(id: FormulaId, e: unknown) {
    if (e instanceof MissingInputError) {
      const p = getParameter(e.parameterId);
      this.push({ severity: "error", formulaId: id, parameterId: e.parameterId, text: `Заполните «${p.name}»` });
    } else if (e instanceof CalcError) {
      this.push({ severity: "error", formulaId: id, text: e.message, ...(e.parameterId ? { parameterId: e.parameterId } : {}) });
    } else if (!(e instanceof DependencyError)) {
      throw e;
    }
  }

  /**
   * Помесячный расчёт группы формул, связанных через прошлый месяц: для t = 0 … горизонт − 1 — все формулы группы
   * в порядке зависимостей внутри месяца. Ошибка любой формулы останавливает всю группу.
   */
  private runGroup(id: FormulaId, group: FormulaId[]): unknown {
    if (this.horizonMonths === null) {
      this.failed.add(id);
      this.push({ severity: "error", formulaId: id, text: "Не задан горизонт модели (число месяцев)" });
      throw new DependencyError(id);
    }
    // Сначала — формулы вне группы, от которых она зависит: они считаются, даже если группа остановится с ошибкой
    const inGroup = new Set(group);
    for (const g of group) {
      for (const d of getFormula(g).depends_on) {
        if (inGroup.has(d as FormulaId) || !this.registry[d as FormulaId]) continue;
        try {
          this.evaluate(d as FormulaId);
        } catch (e) {
          if (!(e instanceof DependencyError)) throw e;
        }
      }
    }
    const frames = new Map(group.map((g) => [g, { id: g, inputs: new Set<ParameterId | FormulaId>() } as Frame]));
    const acc = new Map<FormulaId, Assembled>();
    const outer = this.step;
    this.step = { group: new Set(group), acc };
    let current: FormulaId = id;
    try {
      for (let t = 0; t < this.horizonMonths; t++) {
        for (const g of group) {
          current = g;
          const fn = this.registry[g];
          if (!fn || !isStepFn(fn)) throw new Error(`Формула ${g} связана с другими через прошлый месяц и должна считаться помесячно`);
          const frame = frames.get(g) as Frame;
          this.stack.push(frame);
          try {
            acc.set(g, append(acc.get(g), fn(this.context(frame, g), t), t));
          } finally {
            this.stack.pop();
          }
        }
      }
    } catch (e) {
      for (const g of group) this.failed.add(g);
      this.report(current, e);
      throw new DependencyError(id);
    } finally {
      this.step = outer;
    }
    for (const g of group) this.nodes.set(g, { id: g, value: acc.get(g) ?? null, inputs: [...(frames.get(g) as Frame).inputs] });
    return this.nodes.get(id)?.value;
  }

  /** Посчитать набор формул; ошибки остаются в сообщениях. */
  run(targets: readonly FormulaId[]): ResultSet {
    for (const id of targets) {
      try {
        this.evaluate(id);
      } catch (e) {
        if (!(e instanceof DependencyError)) throw e;
      }
    }
    return this.result();
  }

  result(): ResultSet {
    const code = this.rawParam("GEN.REGION_CODE");
    return {
      regionCode: typeof code === "string" && isRegionCode(code) ? code : null,
      formulas: Object.fromEntries(FORMULA_IDS.filter((id) => this.nodes.has(id)).map((id) => [id, this.nodes.get(id)])),
      parameters: Object.fromEntries(this.params),
      messages: [...this.messages],
    };
  }

  private push(m: CalcMessage) {
    // Помесячная формула может выдать одно и то же сообщение в разные месяцы — показываем один раз
    if (this.step && this.messages.some((x) => x.formulaId === m.formulaId && x.text === m.text)) return;
    this.messages.push(m);
  }

  private rawParam(id: ParameterId): unknown {
    return this.values[id];
  }

  /**
   * Значение параметра: проект → справочник допущений компании → регион (regions.yaml) → значение по умолчанию из
   * parameters.yaml.
   */
  private resolve(id: ParameterId): { value: unknown; origin: ValueOrigin } | null {
    const own = this.values[id];
    if (own !== undefined && own !== null) return { value: own, origin: "project" };
    const std = this.standard[id];
    if (std !== undefined && std !== null) return { value: std, origin: "standard" };
    const fromRegion = REGION_VALUES[id];
    const region = this.projectRegion();
    if (fromRegion && region) {
      const v = fromRegion(region);
      if (v !== null && v !== undefined) return { value: v, origin: "region" };
    }
    const def = getParameter(id).default;
    if (def !== null && def !== undefined) return { value: def, origin: "template" };
    return null;
  }

  private projectRegion(): SpecRegion | null {
    const code = this.values["GEN.REGION_CODE"];
    return typeof code === "string" && isRegionCode(code) ? getRegion(code as RegionCode) : null;
  }

  private context(frame: Frame, self?: FormulaId): FormulaContext {
    const read = (id: ParameterId) => {
      frame.inputs.add(id);
      const r = this.resolve(id);
      if (r && !this.params.has(id)) this.params.set(id, { id, value: r.value, origin: r.origin });
      return r ? r.value : null;
    };
    const toNum = (id: ParameterId, v: unknown): Decimal | null => {
      if (v === null) return null;
      if (typeof v === "number" || typeof v === "string") return new Decimal(v);
      throw new CalcError(`«${getParameter(id).name}» должен быть числом`, id);
    };
    const ctx: FormulaContext = {
      mode: this.mode,
      horizonMonths: this.horizonMonths,
      param: <T>(id: ParameterId) => read(id) as T | null,
      require: <T>(id: ParameterId) => {
        const v = read(id);
        if (v === null) throw new MissingInputError(id);
        return v as T;
      },
      num: (id) => toNum(id, read(id)),
      requireNum: (id) => {
        const v = toNum(id, read(id));
        if (v === null) throw new MissingInputError(id);
        return v;
      },
      formula: <T>(id: FormulaId) => {
        frame.inputs.add(id);
        if (this.step?.group.has(id)) return (this.step.acc.get(id) ?? null) as T;
        return this.evaluate(id) as T;
      },
      own: <T>() => (self && this.step ? ((this.step.acc.get(self) ?? null) as T | null) : null),
      region: () => {
        const code = read("GEN.REGION_CODE");
        if (typeof code !== "string" || !isRegionCode(code)) throw new MissingInputError("GEN.REGION_CODE");
        return getRegion(code);
      },
      message: (severity, text, parameterId, key) => {
        this.push({ severity, formulaId: frame.id, text, ...(parameterId ? { parameterId } : {}), ...(key ? { key } : {}) });
      },
    };
    return ctx;
  }
}

/** Формулы, от которых не зависит ни одна другая реализованная формула, — корни расчёта. */
export function sinkFormulas(implemented: readonly FormulaId[]): FormulaId[] {
  const set = new Set(implemented);
  const used = new Set<string>();
  for (const id of implemented) for (const d of getFormula(id).depends_on) if (set.has(d as FormulaId)) used.add(d);
  return implemented.filter((id) => !used.has(id));
}

/** Собранный ряд помесячной формулы: Decimal[] (или number[] / null[]) либо запись таких рядов. */
type Assembled = unknown[] | Record<string, unknown[]>;

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !(v instanceof Decimal) && !Array.isArray(v);
}

/** Добавить значение месяца t к ряду: число → элемент массива, запись → элемент каждого ряда записи. */
function append(acc: Assembled | undefined, v: unknown, t: number): Assembled {
  if (isRecord(v)) {
    const rec = (acc as Record<string, unknown[]> | undefined) ?? {};
    for (const [k, x] of Object.entries(v)) {
      const arr = (rec[k] ??= Array.from({ length: t }, () => null));
      arr.push(x);
    }
    return rec;
  }
  const arr = (acc as unknown[] | undefined) ?? [];
  arr.push(v);
  return arr;
}

/**
 * Группы формул, связанных через прошлый месяц (сильно связные компоненты графа depends_on среди реализованных формул).
 * Внутри группы формулы упорядочены по зависимостям того же месяца (без lag_depends_on) — в спецификации они без циклов
 * (packages/spec/src/checks.ts).
 */
export function stepGroups(implemented: readonly FormulaId[]): Map<FormulaId, FormulaId[]> {
  const set = new Set(implemented);
  const deps = (id: FormulaId) => getFormula(id).depends_on.filter((d): d is FormulaId => set.has(d as FormulaId));
  // Тарьян
  let index = 0;
  const idx = new Map<FormulaId, number>();
  const low = new Map<FormulaId, number>();
  const onStack = new Set<FormulaId>();
  const st: FormulaId[] = [];
  const comps: FormulaId[][] = [];
  const visit = (v: FormulaId) => {
    idx.set(v, index);
    low.set(v, index++);
    st.push(v);
    onStack.add(v);
    for (const w of deps(v)) {
      if (!idx.has(w)) {
        visit(w);
        low.set(v, Math.min(low.get(v) as number, low.get(w) as number));
      } else if (onStack.has(w)) low.set(v, Math.min(low.get(v) as number, idx.get(w) as number));
    }
    if (low.get(v) === idx.get(v)) {
      const comp: FormulaId[] = [];
      let w: FormulaId;
      do {
        w = st.pop() as FormulaId;
        onStack.delete(w);
        comp.push(w);
      } while (w !== v);
      if (comp.length > 1) comps.push(comp);
    }
  };
  for (const id of implemented) if (!idx.has(id)) visit(id);
  const out = new Map<FormulaId, FormulaId[]>();
  for (const comp of comps) {
    const inComp = new Set(comp);
    const order: FormulaId[] = [];
    const seen = new Set<FormulaId>();
    const place = (v: FormulaId) => {
      if (seen.has(v)) return;
      seen.add(v);
      const lag = new Set(getFormula(v).lag_depends_on ?? []);
      for (const w of deps(v)) if (inComp.has(w) && !lag.has(w)) place(w);
      order.push(v);
    };
    [...comp].sort().forEach(place);
    for (const v of comp) out.set(v, order);
  }
  return out;
}
