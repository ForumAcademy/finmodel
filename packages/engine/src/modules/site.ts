/**
 * SITE — участок и ограничения (data/formulas.yaml, модуль SITE): площадь под застройку, максимально допустимая
 * наземная ГНС и пятно застройки вариантов освоения.
 */
import Decimal from "decimal.js";
import type { FormulaContext } from "../context";
import { CalcError } from "../context";
import { fmt } from "../lib/format";

const ZERO = new Decimal(0);

/** Строка SITE.ZOUIT (столбцы — parameters.yaml). */
export interface ZouitRow {
  name: string;
  area_m2?: number | null;
  no_build?: boolean | null;
  restriction?: string | null;
}

/** Максимально допустимая ГНС и ограничение, которое её задаёт. */
export interface MaxGfa {
  value: Decimal;
  /** Какое ограничение самое жёсткое: предельная ГНС по документу, плотность или процент застройки × этажность. */
  limit: GfaLimit;
  /** Все заданные ограничения: из них выбран минимум. */
  limits: Partial<Record<GfaLimit, Decimal>>;
}

export type GfaLimit = "gfa" | "density" | "share";

export function F_SITE_BUILDABLE_AREA(ctx: FormulaContext): Decimal {
  const area = ctx.requireNum("LAND.AREA");
  const rows = ctx.param<ZouitRow[]>("SITE.ZOUIT") ?? [];
  if (!Array.isArray(rows)) throw new CalcError("Зоны с особыми условиями: нужен список строк", "SITE.ZOUIT");
  const closed = rows.reduce((s, r) => (r.no_build ? s.add(r.area_m2 ?? 0) : s), ZERO);
  const out = area.sub(closed);
  if (out.lte(0)) throw new CalcError(`Зоны, где строить нельзя, занимают ${fmt(closed)} м² при площади участка ${fmt(area)} м². Проверьте площади зон`, "SITE.ZOUIT");
  return out;
}

export function F_SITE_MAX_GFA(ctx: FormulaContext): MaxGfa {
  const limits: Partial<Record<GfaLimit, Decimal>> = {};
  const doc = ctx.num("GPZU.MAX_GFA_ABOVE");
  if (doc !== null) limits.gfa = doc;
  const density = ctx.num("SITE.MAX_DENSITY");
  if (density !== null) limits.density = ctx.requireNum("LAND.AREA").mul(density);
  const share = ctx.num("GPZU.MAX_BUILT_SHARE");
  const floors = ctx.num("GPZU.MAX_FLOORS");
  if (share !== null && floors !== null) limits.share = ctx.formula<Decimal>("F.SITE.BUILDABLE_AREA").mul(share).mul(floors);
  const set = (Object.entries(limits) as [GfaLimit, Decimal][]).map(([limit, value]) => ({ limit, value }));
  if (set.length === 0) {
    throw new CalcError("Не задано ни одно ограничение объёма: предельная наземная площадь, плотность застройки или процент застройки с этажностью", "SITE.MAX_DENSITY");
  }
  const min = set.reduce((a, b) => (b.value.lt(a.value) ? b : a));
  return { ...min, limits };
}

export function F_SITE_FOOTPRINT(ctx: FormulaContext): Decimal {
  const buildable = ctx.formula<Decimal>("F.SITE.BUILDABLE_AREA");
  const share = ctx.num("GPZU.MAX_BUILT_SHARE");
  const byShare = share === null ? buildable : buildable.mul(share);
  const floors = ctx.requireNum("GPZU.MAX_FLOORS");
  if (floors.lte(0)) throw new CalcError("Предельное количество этажей должно быть больше нуля", "GPZU.MAX_FLOORS");
  return Decimal.min(byShare, ctx.formula<MaxGfa>("F.SITE.MAX_GFA").value.div(floors));
}

export const SITE_FORMULAS = {
  "F.SITE.BUILDABLE_AREA": F_SITE_BUILDABLE_AREA,
  "F.SITE.MAX_GFA": F_SITE_MAX_GFA,
  "F.SITE.FOOTPRINT": F_SITE_FOOTPRINT,
} as const;
