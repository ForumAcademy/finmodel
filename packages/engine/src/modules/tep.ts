/**
 * TEP — площади и машино-места (data/formulas.yaml, модуль TEP).
 * Источник площадей зависит от стадии GEN.PROJECT_STAGE: «оценка участка» — предельные параметры ГПЗУ
 * и коэффициенты уровня 4/5; «концепция» — ТЭП архитектора.
 */
import Decimal from "decimal.js";
import type { FormulaContext } from "../context";
import { CalcError } from "../context";
import { fmt, fmtShare } from "../lib/format";

type Stage = "оценка участка" | "концепция";

/** Строка TEP.APT_MIX (столбцы — parameters.yaml). */
export interface AptMixRow {
  type_name: string;
  count?: number | null;
  area_share?: number | null;
  avg_area: number;
  phase?: number | null;
}

/** Значение TEP.PARKING_NORM: правило региона (regions.yaml → parking_norm). */
interface ParkingNorm {
  rule: "by_apartment_area" | "per_type";
  values: ({ max_area: number | null; per_apt: number } | number)[] | null;
}

export interface GfaSplit {
  res: Decimal;
  apart: Decimal;
  nonres: Decimal;
}

export interface Storage {
  count: Decimal;
  area: Decimal;
}

export interface Landscape {
  landscape: Decimal;
  roads: Decimal;
  green: Decimal;
  ground_parking: Decimal;
}

export interface AptAreaCheck {
  diff_m2: Decimal;
  check: Decimal;
}

const ZERO = new Decimal(0);
const ONE = new Decimal(1);
const sum = (xs: Decimal[]) => xs.reduce((a, b) => a.add(b), ZERO);

function stage(ctx: FormulaContext): Stage {
  const s = ctx.require<string>("GEN.PROJECT_STAGE");
  if (s !== "оценка участка" && s !== "концепция") {
    throw new CalcError(`Неизвестная стадия проекта «${s}»`, "GEN.PROJECT_STAGE");
  }
  return s;
}

function aptMix(ctx: FormulaContext): AptMixRow[] {
  const rows = ctx.require<AptMixRow[]>("TEP.APT_MIX");
  if (!Array.isArray(rows) || rows.length === 0) throw new CalcError("Заполните квартирографию", "TEP.APT_MIX");
  return rows;
}

export function F_TEP_GFA_ABOVE(ctx: FormulaContext): Decimal {
  if (stage(ctx) === "концепция") return ctx.requireNum("TEP.GFA_ABOVE");
  const gpzu = ctx.num("GPZU.MAX_GFA_ABOVE");
  if (gpzu !== null) return gpzu;
  return ctx.requireNum("TEP.FOOTPRINT_AREA").mul(ctx.requireNum("TEP.AVG_FLOORS"));
}

export function F_TEP_GFA_SPLIT(ctx: FormulaContext): GfaSplit {
  if (stage(ctx) === "концепция") {
    return {
      res: ctx.requireNum("TEP.RES_GFA"),
      apart: ctx.num("TEP.APART_GFA") ?? ZERO,
      nonres: ctx.requireNum("TEP.NONRES_GFA"),
    };
  }
  const res = ctx.num("TEP.RES_GFA");
  const nonres = ctx.num("TEP.NONRES_GFA");
  if (res !== null && nonres !== null) return { res, apart: ctx.num("TEP.APART_GFA") ?? ZERO, nonres };
  if (res !== null || nonres !== null) {
    ctx.message("warning", "Из ГПЗУ или ППТ задана только жилая или только нежилая площадь — вторая часть считается по долям из справочника", res !== null ? "TEP.NONRES_GFA" : "TEP.RES_GFA");
  }
  const gfa = ctx.formula<Decimal>("F.TEP.GFA_ABOVE");
  const resShare = ctx.requireNum("TEP.RES_GFA_SHARE");
  const apartShare = ctx.num("TEP.APART_GFA_SHARE") ?? ZERO;
  if (resShare.add(apartShare).gt(ONE)) {
    throw new CalcError(`Доли жилой (${fmtShare(resShare)}) и апартаментной (${fmtShare(apartShare)}) части в сумме больше 100 %`, "TEP.APART_GFA_SHARE");
  }
  return { res: gfa.mul(resShare), apart: gfa.mul(apartShare), nonres: gfa.mul(ONE.sub(resShare).sub(apartShare)) };
}

export function F_TEP_APT_AREA(ctx: FormulaContext): Decimal {
  if (stage(ctx) === "концепция") return ctx.requireNum("TEP.APT_AREA");
  return ctx.formula<GfaSplit>("F.TEP.GFA_SPLIT").res.mul(ctx.requireNum("TEP.APT_EFFICIENCY"));
}

export function F_TEP_COMM_AREA(ctx: FormulaContext): Decimal {
  if (stage(ctx) === "концепция") return ctx.requireNum("TEP.COMM_AREA");
  return ctx.formula<GfaSplit>("F.TEP.GFA_SPLIT").nonres.mul(ctx.requireNum("TEP.COMM_EFFICIENCY"));
}

export function F_TEP_APART_AREA(ctx: FormulaContext): Decimal {
  let area: Decimal;
  if (stage(ctx) === "концепция") {
    area = ctx.num("TEP.APART_AREA") ?? ZERO;
  } else {
    const apartGfa = ctx.formula<GfaSplit>("F.TEP.GFA_SPLIT").apart;
    area = apartGfa.isZero() ? ZERO : apartGfa.mul(ctx.requireNum("TEP.APART_EFFICIENCY"));
  }
  const allowed = ctx.param<boolean>("GPZU.APART_ALLOWED") === true;
  if (!allowed && area.gt(ZERO)) {
    ctx.message("warning", `Апартаменты (${fmt(area)} м²) исключены: по ГПЗУ проекта размещение объектов гостиничного назначения / апартаментов не подтверждено`, "GPZU.APART_ALLOWED");
    const codes = ctx.param<string[]>("LAND.VRI_CODES") ?? [];
    if (codes.includes("4.7")) {
      ctx.message("info", "ВРИ участка включает код 4.7 «Гостиничное обслуживание» — апартаменты могут быть допустимы. Проверьте ГПЗУ и отметьте, что апартаменты допускаются", "GPZU.APART_ALLOWED");
    }
    return ZERO;
  }
  return allowed ? area : ZERO;
}

export function F_TEP_APT_COUNT(ctx: FormulaContext): Decimal[] {
  const rows = aptMix(ctx);
  if (stage(ctx) === "концепция") {
    return rows.map((r) => {
      if (r.count === null || r.count === undefined) throw new CalcError(`Квартирография: укажите количество квартир типа «${r.type_name}»`, "TEP.APT_MIX");
      return new Decimal(r.count);
    });
  }
  const shares = rows.map((r) => {
    if (r.area_share === null || r.area_share === undefined) throw new CalcError(`Квартирография: укажите долю площади типа «${r.type_name}»`, "TEP.APT_MIX");
    return new Decimal(r.area_share);
  });
  const total = sum(shares);
  if (!total.eq(ONE)) throw new CalcError(`Квартирография: сумма долей площади типов = ${fmtShare(total)}, должна быть 100 %`, "TEP.APT_MIX");
  const aptArea = ctx.formula<Decimal>("F.TEP.APT_AREA");
  return rows.map((r, k) => (shares[k] as Decimal).mul(aptArea).div(r.avg_area).floor());
}

export function F_TEP_APT_TYPE_AREA(ctx: FormulaContext): Decimal[] {
  const counts = ctx.formula<Decimal[]>("F.TEP.APT_COUNT");
  const rows = aptMix(ctx);
  return rows.map((r, k) => (counts[k] as Decimal).mul(r.avg_area));
}

export function F_TEP_APT_SHARE(ctx: FormulaContext): Decimal[] {
  const counts = ctx.formula<Decimal[]>("F.TEP.APT_COUNT");
  const total = sum(counts);
  if (total.isZero()) throw new CalcError("В квартирографии нет ни одной квартиры", "TEP.APT_MIX");
  return counts.map((c) => c.div(total));
}

export function F_TEP_APT_AREA_CHECK(ctx: FormulaContext): AptAreaCheck {
  const byMix = sum(ctx.formula<Decimal[]>("F.TEP.APT_TYPE_AREA"));
  const total = ctx.formula<Decimal>("F.TEP.APT_AREA");
  if (total.isZero()) throw new CalcError("Площадь квартир равна нулю", "TEP.APT_AREA");
  const diff = byMix.sub(total);
  const check = diff.div(total);
  const tolerance = ctx.requireNum("TEP.APT_AREA_TOLERANCE");
  if (check.abs().gt(tolerance)) {
    ctx.message("warning", `Площадь квартир по квартирографии (${fmt(byMix)} м²) отличается от ТЭП (${fmt(total)} м²) на ${fmt(diff)} м² (${fmtShare(check)}) — больше допустимых ${fmtShare(tolerance)}`, "TEP.APT_MIX");
  }
  return { diff_m2: diff, check };
}

export function F_TEP_STORAGE(ctx: FormulaContext): Storage {
  if (stage(ctx) === "концепция") {
    return { count: ctx.num("TEP.STORAGE_COUNT") ?? ZERO, area: ctx.num("TEP.STORAGE_AREA") ?? ZERO };
  }
  const apartments = sum(ctx.formula<Decimal[]>("F.TEP.APT_COUNT"));
  const count = apartments.mul(ctx.requireNum("TEP.STORAGE_PER_APT")).floor();
  const area = count.isZero() ? ZERO : count.mul(ctx.requireNum("TEP.STORAGE_AVG_AREA"));
  return { count, area };
}

/** Норматив машино-мест на квартиру типа k. */
function normFor(norm: ParkingNorm, row: AptMixRow, k: number, mode: FormulaContext["mode"]): Decimal {
  const values = norm.values ?? [];
  if (norm.rule === "per_type") {
    // Только расчёт «как в исходном Excel»: нормы по типам из исходного Excel (tests/cases/*_legacy.yaml).
    if (mode !== "legacy") throw new CalcError("Норматив по типам квартир допускается только в расчёте «как в исходном Excel»", "TEP.PARKING_NORM");
    const v = values[k];
    if (typeof v !== "number") throw new CalcError(`Нет норматива для типа «${row.type_name}»`, "TEP.PARKING_NORM");
    return new Decimal(v);
  }
  const rule = values
    .filter((v): v is { max_area: number | null; per_apt: number } => typeof v === "object")
    .find((v) => v.max_area === null || new Decimal(row.avg_area).lte(v.max_area));
  if (!rule) throw new CalcError(`Норматив региона не покрывает квартиры площадью ${fmt(row.avg_area)} м²`, "TEP.PARKING_NORM");
  return new Decimal(rule.per_apt);
}

export function F_TEP_PARKING_REQUIRED(ctx: FormulaContext): Decimal {
  const counts = ctx.formula<Decimal[]>("F.TEP.APT_COUNT");
  const rows = aptMix(ctx);
  const norm = ctx.require<ParkingNorm>("TEP.PARKING_NORM");
  const forApartments = sum(rows.map((r, k) => (counts[k] as Decimal).mul(normFor(norm, r, k, ctx.mode))));
  const apartArea = ctx.formula<Decimal>("F.TEP.APART_AREA");
  if (apartArea.gt(ZERO)) {
    ctx.require("TEP.PARKING_NORM_APART");
    throw new CalcError("Норматив машино-мест для апартаментов по региону ещё не внесён в справочник. Введите число машино-мест по ГПЗУ с документом", "TEP.PARKING_NORM_APART");
  }
  return forApartments.ceil();
}

export function F_TEP_PARKING_COUNT(ctx: FormulaContext): Decimal {
  const required = ctx.formula<Decimal>("F.TEP.PARKING_REQUIRED");
  const gpzu = ctx.num("TEP.PARKING_GPZU_COUNT");
  const calc = Decimal.max(required, gpzu ?? ZERO);
  const override = ctx.num("TEP.PARKING_COUNT_OVERRIDE");
  if (override === null) return calc;
  if (override.lt(required)) {
    ctx.message("warning", `Машино-мест ${fmt(override)} — ниже норматива региона (${fmt(required)}); основание — вложенный документ`, "TEP.PARKING_COUNT_OVERRIDE");
  }
  return override;
}

export function F_TEP_PARKING_SPACE_MIN_AREA(ctx: FormulaContext): Decimal {
  return ctx.requireNum("TEP.PARKING_SPACE_MIN_LENGTH").mul(ctx.requireNum("TEP.PARKING_SPACE_MIN_WIDTH"));
}

export function F_TEP_GFA_BELOW_EST(ctx: FormulaContext): Decimal {
  const parking = ctx.formula<Decimal>("F.TEP.PARKING_COUNT");
  const perSpace = ctx.requireNum("TEP.PARKING_AREA_PER_SPACE");
  const min = ctx.formula<Decimal>("F.TEP.PARKING_SPACE_MIN_AREA");
  if (perSpace.lt(min)) {
    throw new CalcError(`Площадь на одно машино-место с проездами (${fmt(perSpace)} м²) меньше площади самого машино-места (${fmt(min)} м²)`, "TEP.PARKING_AREA_PER_SPACE");
  }
  return parking.mul(perSpace).add(ctx.formula<Storage>("F.TEP.STORAGE").area);
}

export function F_TEP_GFA_BELOW(ctx: FormulaContext): Decimal {
  if (stage(ctx) === "концепция") return ctx.requireNum("TEP.GFA_BELOW");
  return ctx.formula<Decimal>("F.TEP.GFA_BELOW_EST");
}

export function F_TEP_GFA_TOTAL(ctx: FormulaContext): Decimal {
  return ctx.formula<Decimal>("F.TEP.GFA_ABOVE").add(ctx.formula<Decimal>("F.TEP.GFA_BELOW"));
}

export function F_TEP_SALEABLE_AREA(ctx: FormulaContext): Decimal {
  return sum(ctx.formula<Decimal[]>("F.TEP.APT_TYPE_AREA"))
    .add(ctx.formula<Decimal>("F.TEP.APART_AREA"))
    .add(ctx.formula<Decimal>("F.TEP.COMM_AREA"))
    .add(ctx.formula<Storage>("F.TEP.STORAGE").area);
}

export function F_TEP_LANDSCAPE_AREA(ctx: FormulaContext): Landscape {
  const landscape = ctx.requireNum("LAND.AREA").mul(ctx.requireNum("TEP.LANDSCAPE_SHARE"));
  const roads = landscape.mul(ctx.requireNum("TEP.ROAD_SHARE"));
  const green = landscape.mul(ctx.requireNum("TEP.GREEN_SHARE"));
  return { landscape, roads, green, ground_parking: landscape.sub(roads).sub(green) };
}

export const TEP_FORMULAS = {
  "F.TEP.GFA_ABOVE": F_TEP_GFA_ABOVE,
  "F.TEP.GFA_SPLIT": F_TEP_GFA_SPLIT,
  "F.TEP.APT_AREA": F_TEP_APT_AREA,
  "F.TEP.COMM_AREA": F_TEP_COMM_AREA,
  "F.TEP.APART_AREA": F_TEP_APART_AREA,
  "F.TEP.STORAGE": F_TEP_STORAGE,
  "F.TEP.APT_COUNT": F_TEP_APT_COUNT,
  "F.TEP.APT_TYPE_AREA": F_TEP_APT_TYPE_AREA,
  "F.TEP.APT_SHARE": F_TEP_APT_SHARE,
  "F.TEP.APT_AREA_CHECK": F_TEP_APT_AREA_CHECK,
  "F.TEP.PARKING_REQUIRED": F_TEP_PARKING_REQUIRED,
  "F.TEP.PARKING_COUNT": F_TEP_PARKING_COUNT,
  "F.TEP.PARKING_SPACE_MIN_AREA": F_TEP_PARKING_SPACE_MIN_AREA,
  "F.TEP.GFA_BELOW_EST": F_TEP_GFA_BELOW_EST,
  "F.TEP.GFA_BELOW": F_TEP_GFA_BELOW,
  "F.TEP.GFA_TOTAL": F_TEP_GFA_TOTAL,
  "F.TEP.SALEABLE_AREA": F_TEP_SALEABLE_AREA,
  "F.TEP.LANDSCAPE_AREA": F_TEP_LANDSCAPE_AREA,
} as const;
