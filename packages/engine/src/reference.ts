/**
 * Справочник для экрана «Справочник»: стандартные значения, нормативы регионов, формулы, источники, история версий.
 * Всё берётся из data/*.yaml; экран только показывает строки, собранные здесь.
 */
import {
  ASSUMPTION_GROUPS,
  type SpecAssumptionVersion as AssumptionVersion,
  getParameter,
  spec,
  type ParameterId,
  type SourceId,
  type SpecFormula,
  type SpecParameter,
  type SpecRegion,
  type SpecSource,
} from "@fm/spec";
import { SPEC_ASSUMPTIONS } from "./project";
import { PROJECT_REGIONS } from "./plot";
import { date, num, plural } from "./lib/text";

export type Tone = "grn" | "yel" | "red" | "gry";

export interface RefLink {
  title: string;
  url: string | null;
}

export interface RefValue {
  text?: string;
  table?: { headers: string[]; rows: string[][] };
  /** Строки под таблицей: «дальше — как в последнем году». */
  notes?: string[];
}

export interface RefRow {
  /** Параметр стандартного значения (справочник допущений компании) — такие строки можно править. */
  param?: ParameterId;
  name: string;
  /** null — значения нет («нужно значение»). */
  value: RefValue | null;
  status: { text: string; tone: Tone };
  sources: RefLink[];
  note?: string;
}

export interface RefTab {
  id: string;
  title: string;
  rows: RefRow[];
}

// ---------- технические обозначения → названия ----------

const capexNames = new Map(spec.capexItems.map((c) => [c.item_id as string, c.name]));
const paramNames = new Map(spec.parameters.map((p) => [p.id as string, p.name]));
const formulaNames = new Map(spec.formulas.map((f) => [f.id as string, f.plain?.title ?? f.name]));
const sourceTitles = new Map(spec.sources.map((s) => [s.id as string, s.title]));

/**
 * Текст справочника без технических обозначений: ID параметров, формул, статей бюджета и источников заменяются
 * названиями в кавычках. Неизвестное обозначение (параметр будущих этапов) убирается вместе со скобками вокруг.
 */
export function humanize(text: string): string {
  const named = text.replace(/\b(?:F\.)?[A-Z]+\.[A-Z0-9_]+\b|\bS_[A-Z0-9_]+\b|\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/g, (id) => {
    const name = formulaNames.get(id) ?? paramNames.get(id) ?? capexNames.get(id) ?? sourceTitles.get(id);
    return name ? `«${name}»` : "⟦⟧";
  });
  return named
    .replace(/\s*\(\s*⟦⟧\s*\)/g, "")
    .replace(/\s*[—-]?\s*⟦⟧[,;]?/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

// ---------- значения ----------

const pct = (v: number) => `${num(v * 100, 2)} %`;

function scalarText(unit: string, v: unknown): string {
  if (typeof v === "boolean") return v ? "да" : "нет";
  if (typeof v !== "number") return String(v);
  switch (unit) {
    case "доля":
      return pct(v);
    case "%годовых":
      return `${pct(v)} годовых`;
    case "доля/год":
      return `${pct(v)} в год`;
    case "руб":
      return `${num(v)} руб`;
    case "руб/м2":
      return `${num(v)} руб/м²`;
    case "мес":
      return `${num(v)} мес`;
    case "год":
      return `${num(v)} ${plural(v, ["год", "года", "лет"])}`;
    case "м":
      return `${num(v)} м`;
    case "м2":
      return `${num(v)} м²`;
    case "км":
      return `${num(v)} км`;
    case "шт":
      return `${num(v)} шт.`;
    default:
      return num(v);
  }
}

function cellText(unit: string, v: unknown): string {
  if (v === null || v === undefined) return "—";
  if (typeof v === "boolean") return unit === "bool" ? (v ? "облагается" : "не облагается") : v ? "да" : "нет";
  if (typeof v === "number" && unit.startsWith("доля")) return pct(v);
  if (unit === "дата" && typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v)) return date(v);
  return scalarText(unit, v);
}

/** Значение параметра для показа: число с единицей, таблица или ряд по годам. */
export function formatValue(p: SpecParameter, v: unknown): RefValue | null {
  if (v === null || v === undefined) return null;
  if (Array.isArray(v) && v.every((r) => r && typeof r === "object")) {
    const cols = p.columns ?? Object.keys((v[0] as object) ?? {}).map((key) => ({ key, unit: "текст" }));
    return {
      table: {
        headers: cols.map((c) => ("title" in c && typeof c.title === "string" ? c.title : c.key)),
        rows: (v as Record<string, unknown>[]).map((r) => cols.map((c) => cellText(c.unit, r[c.key]))),
      },
    };
  }
  if (Array.isArray(v)) return { text: v.map((x) => scalarText(p.unit, x)).join("; ") };
  if (typeof v === "object") {
    const o = v as { current?: number; as_of?: string; forecast_date?: string; by_year?: Record<string, number>; after_last?: string };
    if (o.by_year) {
      const rows: string[][] = [];
      if (typeof o.current === "number") rows.push([`Сейчас${o.as_of ? ` (на ${date(o.as_of)})` : ""}`, scalarText(p.unit, o.current)]);
      for (const [y, x] of Object.entries(o.by_year)) rows.push([y, scalarText(p.unit, x)]);
      const notes: string[] = [];
      if (o.forecast_date) notes.push(`Прогноз от ${date(o.forecast_date)}.`);
      notes.push("Дальше до конца проекта — значение последнего года.");
      return { table: { headers: ["Год", "Значение"], rows }, notes };
    }
    return { text: JSON.stringify(v) };
  }
  return { text: scalarText(p.unit, v) };
}

const link = (id: SourceId): RefLink => {
  const s = spec.sources.find((x) => x.id === id);
  return { title: s?.title ?? id, url: s?.url ?? null };
};

// ---------- стандартные значения ----------

const GROUP_TITLE: Record<(typeof ASSUMPTION_GROUPS)[number], string> = {
  analysis: "Оценка участка",
  areas: "Коэффициенты выхода площадей",
  sales: "Продажи",
  budget: "Бюджет",
  escrow: "Эскроу",
  fin: "Финансирование",
};

/** Значения по закону и официальным прогнозам, одинаковые для всех проектов. */
const LAW_PARAMS: readonly ParameterId[] = [
  "TAX.PROFIT_RATE",
  "TAX.VAT_RATE",
  "TAX.VAT_REGIME",
  "TAX.LAND_COEF_UP_TO_3Y",
  "TAX.LAND_COEF_OVER_3Y",
  "TAX.LOSS_CARRYFORWARD_LIMIT",
  "FIN.KEY_RATE_PATH",
  "CAPEX.COST_INDEX",
  "CAPEX.OPEX_INDEX",
];

const NEED: RefRow["status"] = { text: "нужно значение", tone: "yel" };

function assumptionStatus(status: string, check: string | undefined, value: unknown): RefRow["status"] {
  if (value === null || value === undefined) return NEED;
  if (status === "approved") return { text: "утверждено", tone: "grn" };
  if (status === "check") return { text: `проверить ${check ?? ""}`.trim(), tone: "red" };
  return { text: "не проверено", tone: "gry" };
}

function paramStatus(p: SpecParameter, value: unknown): RefRow["status"] {
  if (value === null || value === undefined) return NEED;
  if (p.status === "verified") return { text: "сверено с источником", tone: "grn" };
  if (p.status === "needs_verification") return { text: "перепроверить", tone: "red" };
  return { text: "не проверено", tone: "gry" };
}

/** Текущая (последняя) версия справочника допущений. versions — справочник этого браузера, по умолчанию — из спецификации. */
export const currentVersion = (versions: readonly AssumptionVersion[] = SPEC_ASSUMPTIONS): AssumptionVersion | null => versions.at(-1) ?? null;

export function standardTabs(versions: readonly AssumptionVersion[] = SPEC_ASSUMPTIONS): RefTab[] {
  const items = currentVersion(versions)?.items ?? [];
  const tabs: RefTab[] = ASSUMPTION_GROUPS.map((g) => ({
    id: g,
    title: GROUP_TITLE[g],
    rows: items
      .filter((i) => i.group === g)
      .map((i) => {
        const p = getParameter(i.param);
        return {
          param: i.param,
          name: p.name,
          value: formatValue(p, i.value),
          status: assumptionStatus(i.status, i.check, i.value),
          sources: [{ title: humanize(i.from.text), url: i.from.url }],
          ...(i.note ? { note: humanize(i.note) } : {}),
        };
      }),
  }));
  tabs.push({
    id: "law",
    title: "Налоги и ставки",
    rows: LAW_PARAMS.map((id) => {
      const p = getParameter(id);
      return { name: p.name, value: formatValue(p, p.default), status: paramStatus(p, p.default), sources: p.source_ids.map(link), note: humanize(p.basis) };
    }),
  });
  return tabs.filter((t) => t.rows.length);
}

// ---------- нормативы регионов ----------

function regionRows(r: SpecRegion): RefRow[] {
  const rows: RefRow[] = [];
  const tax = r.land_tax_rate_housing;
  rows.push(
    tax
      ? {
          name: "Ставка земельного налога для жилищного строительства",
          value: tax.value === null ? null : { text: pct(tax.value) },
          status: tax.value === null ? NEED : tax.status === "verified" ? { text: "сверено с источником", tone: "grn" } : { text: "перепроверить", tone: "red" },
          sources: tax.source_ids.map(link),
          ...(tax.note ? { note: humanize(tax.note) } : {}),
        }
      : {
          name: "Ставка земельного налога",
          value: { text: "по муниципалитету" },
          status: { text: "вводится в проекте", tone: "gry" },
          sources: [...r.land_tax_source_ids.filter((id) => id !== "S_FNS_RATES").map(link), { title: `Сервис ФНС «Справочная информация о ставках и льготах», ${r.name}`, url: r.fns_rates_url }],
          note: "Ставку устанавливает муниципальное образование; в проекте она вводится со ссылкой на решение муниципалитета.",
        },
  );
  rows.push({
    name: "Плата за изменение вида разрешённого использования",
    value: r.vri_fee.exists === null ? null : { text: r.vri_fee.exists ? `есть${r.vri_fee.formula ? `, по формуле «${formulaNames.get(r.vri_fee.formula) ?? ""}»` : ""}` : "нет" },
    status: r.vri_fee.exists === null ? { text: "нужно проверить", tone: "yel" } : { text: "по акту региона", tone: "grn" },
    sources: r.vri_fee.source_ids.map(link),
    ...(r.vri_fee.note ? { note: humanize(r.vri_fee.note) } : {}),
  });
  const pn = r.parking_norm;
  rows.push({
    name: "Машино-места на квартиру",
    value:
      pn.rule === "by_apartment_area" && pn.values
        ? {
            table: {
              headers: ["Площадь квартиры", "Машино-мест на квартиру"],
              rows: pn.values.map((x, i, all) => [x.max_area === null ? `больше ${num(all[i - 1]?.max_area ?? 0)} м²` : `до ${num(x.max_area)} м²`, num(x.per_apt)]),
            },
          }
        : null,
    status: pn.values ? (pn.status === "verified" ? { text: "сверено с источником", tone: "grn" } : { text: "перепроверить", tone: "red" }) : NEED,
    sources: pn.source_ids.map(link),
  });
  rows.push({
    name: "Машино-места для апартаментов",
    value: r.parking_norm_apart.values ? { text: JSON.stringify(r.parking_norm_apart.values) } : null,
    status: r.parking_norm_apart.values ? { text: "сверено с источником", tone: "grn" } : NEED,
    sources: r.parking_norm_apart.source_ids.map(link),
  });
  rows.push({
    name: "Коэффициент перехода к ценам региона (НЦС)",
    value: r.ncs_k_per === null ? null : { text: num(r.ncs_k_per, 4) },
    status: r.ncs_k_per === null ? NEED : { text: "сверено с источником", tone: "grn" },
    sources: r.ncs_k_per_source_ids.map(link),
    note: "Таблица 1 сборника НЦС 81-02-01-2026.",
  });
  rows.push({
    name: "Орган регулирования тарифов на подключение",
    value: r.tariff_authority === null ? null : { text: r.tariff_authority },
    status: r.tariff_authority === null ? NEED : { text: "сверено с источником", tone: "grn" },
    sources: [],
  });
  return rows;
}

export function regionTabs(): RefTab[] {
  return PROJECT_REGIONS.map((pr) => {
    const r = spec.regions.find((x) => x.code === pr.code) as SpecRegion;
    return { id: r.code, title: r.name, rows: regionRows(r) };
  });
}

// ---------- формулы ----------

export const MODULE_TITLE: Record<SpecFormula["module"], string> = {
  TIME: "Сроки",
  TEP: "ТЭП",
  LAND: "Участок",
  CAPEX: "Бюджет",
  SALES: "Продажи",
  ESCROW: "Эскроу",
  FIN: "Финансирование",
  TAX: "Налоги",
  CF: "Денежный поток",
  KPI: "Показатели",
  CHECK: "Проверки",
  BENCH: "Аналоги",
  SITE: "Участок и ограничения",
  MARKET: "Рынок",
  VAR: "Варианты освоения",
};

export interface FormulaRow {
  title: string;
  how: string;
  sources: RefLink[];
  verified: boolean;
}

export function formulaTabs(): { id: string; title: string; rows: FormulaRow[] }[] {
  return (Object.keys(MODULE_TITLE) as SpecFormula["module"][])
    .map((m) => ({
      id: m.toLowerCase(),
      title: MODULE_TITLE[m],
      rows: spec.formulas
        .filter((f) => f.module === m)
        .map((f) => ({
          title: f.plain?.title ?? humanize(f.name),
          how: humanize(f.plain?.how ?? f.rationale),
          sources: f.source_ids.filter((id) => spec.sources.find((s) => s.id === id)?.scope === "global").map(link),
          verified: f.status === "verified",
        })),
    }))
    .filter((t) => t.rows.length);
}

// ---------- источники ----------

export interface SourceRow {
  title: string;
  url: string | null;
  usedFor: string;
  accessed: string | null;
  status: { text: string; tone: Tone };
}

const SOURCE_TABS: readonly { id: string; title: string; test: (s: SpecSource) => boolean }[] = [
  { id: "law", title: "Законодательство", test: (s) => s.level === 1 },
  { id: "stats", title: "Статистика и аналитика", test: (s) => s.level === 2 || s.level === 3 },
  { id: "company", title: "Документы компании", test: (s) => s.level === 4 },
  { id: "expert", title: "Экспертные данные", test: (s) => s.level === 5 },
];

function sourceStatus(s: SpecSource): SourceRow["status"] {
  if (s.scope === "project") return { text: "документ проекта", tone: "gry" };
  return s.verified ? { text: "сверен", tone: "grn" } : { text: "перепроверить", tone: "red" };
}

export function sourceTabs(): { id: string; title: string; rows: SourceRow[]; recheck: number }[] {
  return SOURCE_TABS.map((t) => {
    const rows = spec.sources.filter(t.test).map((s) => ({ title: s.title, url: s.url ?? null, usedFor: humanize(s.used_for), accessed: s.accessed ? date(s.accessed) : null, status: sourceStatus(s) }));
    return { id: t.id, title: t.title, rows, recheck: rows.filter((r) => r.status.tone === "red").length };
  });
}

// ---------- история версий и шапка ----------

export interface VersionRow {
  version: number;
  date: string;
  author: string;
  note: string;
}

export function versionRows(versions: readonly AssumptionVersion[] = SPEC_ASSUMPTIONS): VersionRow[] {
  return [...versions].reverse().map((v) => ({ version: v.version, date: date(v.date), author: v.author, note: humanize(v.note) }));
}

export interface ReferenceSummary {
  version: number | null;
  date: string | null;
  needValue: number;
  recheckSources: number;
}

export function referenceSummary(versions: readonly AssumptionVersion[] = SPEC_ASSUMPTIONS): ReferenceSummary {
  const cur = currentVersion(versions);
  const need = [...standardTabs(versions), ...regionTabs()].flatMap((t) => t.rows).filter((r) => r.status.tone === "yel").length;
  return {
    version: cur?.version ?? null,
    date: cur ? date(cur.date) : null,
    needValue: need,
    recheckSources: sourceTabs().reduce((a, t) => a + t.recheck, 0),
  };
}
