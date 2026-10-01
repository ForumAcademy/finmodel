/**
 * Проекты конкурентов: карточки ЖК рядом с участками компании и их ежемесячные снимки (по карточке bnMAP или отчёту).
 * Карточка общая для всех проектов компании; к каждому нашему проекту конкурент привязывается отдельно, с расстоянием.
 * Из последнего снимка строится строка таблицы аналогов проекта (MARKET.ANALOGS): цена — из источника, темп — по
 * выгрузке сделок (из источника) или по разнице проданной площади между снимками (оценка по аналогам).
 *
 * Формат файла конкурентов рассчитан на хранение на сервере без переделок, как файл проекта: `competitors` — записи как
 * есть, `files` — скриншоты карточек по id снимка.
 */
import Decimal from "decimal.js";
import { z } from "zod";
import { getParameter } from "@fm/spec";
import { daysBetween, edate, isIsoDate, type IsoDate } from "./lib/dates";
import { date as fmtDate, num } from "./lib/text";
import { parseNumberRu, type Origin } from "./plot";
import type { FileEntry } from "./projectfile";
import { ANALOG_PRODUCTS, HOUSING_CLASSES, type AnalogEntry } from "./site";

const PERCENT = 100;
const DAYS_IN_MONTH = new Decimal(365).div(12);
const DMY = /^(\d{2})\.(\d{2})\.(\d{4})$/;

/** Типы квартир, как в экспозиции карточки bnMAP. */
export const ROOM_TYPES = ["студия", "1-комн.", "2-комн.", "3-комн.", "4-комн."] as const;
export type RoomType = (typeof ROOM_TYPES)[number];

/** Экспозиция по типу квартир: числа строками (как поля участка), null — нет в карточке. */
export interface RoomExposure {
  lots: string | null;
  area: string | null;
  /** Средняя цена 1 м² с НДС, руб — как в карточке (со скидкой, если карточка так пишет). */
  price: string | null;
}

/** Снимок карточки ЖК на дату: всё, что меняется от месяца к месяцу. */
export interface CompetitorSnapshot {
  id: string;
  /** Дата данных карточки («данные обновлены от»), ГГГГ-ММ-ДД. */
  date: IsoDate;
  /** Проектная площадь лотов по корпусам в продаже, м². */
  projectArea: string | null;
  /** Проектное количество лотов по корпусам в продаже, шт. */
  projectLots: string | null;
  /** Экспозиция, итого. */
  exposureLots: string | null;
  exposureArea: string | null;
  /** Средняя цена 1 м² в экспозиции, итого, руб с НДС. */
  avgPrice: string | null;
  byType: Partial<Record<RoomType, RoomExposure>>;
  /** Остатки по общей площади лотов, доля. */
  remainingAreaShare: string | null;
  /** Остатки по общему количеству лотов, доля. */
  remainingLotsShare: string | null;
  /** Строительная готовность на дату. */
  stage: string | null;
  /** Плановая дата РВЭ, как в карточке («4 квартал 2027»). */
  rve: string | null;
  /** Проданная площадь за последние 12 месяцев по выгрузке сделок, м² (если выгрузка есть). */
  soldArea12m: string | null;
  /** Скриншот карточки или отчёт: id файла в хранилище, имя файла. */
  fileId: string | null;
  fileName: string | null;
}

/** Привязка конкурента к нашему проекту. */
export interface CompetitorLink {
  projectId: string;
  /** Расстояние до участка, км. */
  distanceKm: string | null;
}

export interface Competitor {
  id: string;
  name: string;
  /** Ссылка на карточку ЖК (bnMAP или сайт): обязательна, без неё аналог не проверить. */
  url: string;
  developer: string | null;
  district: string | null;
  metro: string | null;
  /** Продукт для таблицы аналогов: квартиры или апартаменты. */
  product: string;
  /** Класс, как в карточке («Бизнес-»). */
  classText: string | null;
  /** Класс для расчёта — из справочника (эконом, комфорт, бизнес, премиум). */
  housingClass: string;
  construction: string | null;
  floors: string | null;
  finish: string | null;
  contract: string | null;
  /** Старт рыночной реализации, ГГГГ-ММ-ДД. */
  salesStart: IsoDate | null;
  links: CompetitorLink[];
  /** Снимки по возрастанию даты. */
  snapshots: CompetitorSnapshot[];
  updatedAt: string;
}

// ---------- ввод ----------

/** Класс для расчёта по тексту карточки: «Бизнес-» → «бизнес»; не узнали — пусто. */
export function classFromText(text: string): string {
  const t = text.trim().toLowerCase().replace(/[+\-–]+$/, "");
  return HOUSING_CLASSES.includes(t) ? t : "";
}

export type CompetitorForm = Record<"name" | "url" | "developer" | "district" | "metro" | "product" | "classText" | "housingClass" | "construction" | "floors" | "finish" | "contract" | "salesStart", string>;

const textOrNull = (s: string): string | null => s.trim() || null;

function parseDate(text: string): IsoDate | null {
  const m = DMY.exec(text.trim());
  const iso = m ? `${m[3]}-${m[2]}-${m[1]}` : text.trim();
  return isIsoDate(iso) ? iso : null;
}

export function competitorToForm(c: Competitor | null): CompetitorForm {
  return {
    name: c?.name ?? "",
    url: c?.url ?? "",
    developer: c?.developer ?? "",
    district: c?.district ?? "",
    metro: c?.metro ?? "",
    product: c?.product ?? "квартиры",
    classText: c?.classText ?? "",
    housingClass: c?.housingClass ?? "",
    construction: c?.construction ?? "",
    floors: c?.floors ?? "",
    finish: c?.finish ?? "",
    contract: c?.contract ?? "",
    salesStart: c?.salesStart ? fmtDate(c.salesStart) : "",
  };
}

/** Проверить карточку конкурента: что не так → что сделать. Привязки и снимки переносятся из прежней карточки. */
export function competitorFromForm(f: CompetitorForm, prev: Competitor | null, id: string, at: string): { competitor: Competitor | null; errors: string[] } {
  const errors: string[] = [];
  if (!f.name.trim()) errors.push("Укажите название ЖК.");
  if (!/^https?:\/\/\S+$/.test(f.url.trim())) errors.push("Укажите ссылку на карточку ЖК (https://…): без неё аналог не проверить.");
  if (!ANALOG_PRODUCTS.includes(f.product)) errors.push("Выберите продукт.");
  const housingClass = f.housingClass || classFromText(f.classText);
  if (!HOUSING_CLASSES.includes(housingClass)) errors.push("Выберите класс для расчёта.");
  const salesStart = f.salesStart.trim() ? parseDate(f.salesStart) : null;
  if (f.salesStart.trim() && !salesStart) errors.push("Укажите старт продаж как 10.04.2024.");
  if (errors.length) return { competitor: null, errors };
  return {
    competitor: {
      id,
      name: f.name.trim(),
      url: f.url.trim(),
      developer: textOrNull(f.developer),
      district: textOrNull(f.district),
      metro: textOrNull(f.metro),
      product: f.product,
      classText: textOrNull(f.classText),
      housingClass,
      construction: textOrNull(f.construction),
      floors: textOrNull(f.floors),
      finish: textOrNull(f.finish),
      contract: textOrNull(f.contract),
      salesStart,
      links: prev?.links ?? [],
      snapshots: prev?.snapshots ?? [],
      updatedAt: at,
    },
    errors: [],
  };
}

type SnapNumKey = "projectArea" | "projectLots" | "exposureLots" | "exposureArea" | "avgPrice" | "remainingAreaShare" | "remainingLotsShare" | "soldArea12m";
export type SnapshotForm = Record<SnapNumKey | "date" | "stage" | "rve", string> & { byType: Record<RoomType, Record<keyof RoomExposure, string>> };

const SHARE_KEYS: readonly SnapNumKey[] = ["remainingAreaShare", "remainingLotsShare"];
const SNAP_LABEL: Record<SnapNumKey, string> = {
  projectArea: "Проектная площадь",
  projectLots: "Проектное количество лотов",
  exposureLots: "Лотов на экспозиции",
  exposureArea: "Площадь на экспозиции",
  avgPrice: "Средняя цена 1 м²",
  remainingAreaShare: "Остатки по площади",
  remainingLotsShare: "Остатки по количеству",
  soldArea12m: "Продано за 12 месяцев",
};

const showNum = (s: string | null | undefined, digits = 1): string => (s ? num(new Decimal(s), digits) : "");

export function snapshotToForm(s: CompetitorSnapshot | null): SnapshotForm {
  const share = (v: string | null | undefined) => (v ? num(new Decimal(v).mul(PERCENT), 2) : "");
  const byType = Object.fromEntries(
    ROOM_TYPES.map((t) => {
      const r = s?.byType[t];
      return [t, { lots: showNum(r?.lots, 0), area: showNum(r?.area), price: showNum(r?.price, 0) }];
    }),
  ) as SnapshotForm["byType"];
  return {
    date: s?.date ? fmtDate(s.date) : "",
    projectArea: showNum(s?.projectArea),
    projectLots: showNum(s?.projectLots, 0),
    exposureLots: showNum(s?.exposureLots, 0),
    exposureArea: showNum(s?.exposureArea),
    avgPrice: showNum(s?.avgPrice, 0),
    remainingAreaShare: share(s?.remainingAreaShare),
    remainingLotsShare: share(s?.remainingLotsShare),
    soldArea12m: showNum(s?.soldArea12m),
    stage: s?.stage ?? "",
    rve: s?.rve ?? "",
    byType,
  };
}

/** Проверить снимок: что не так → что сделать. Проценты остатков хранятся долей. */
export function snapshotFromForm(f: SnapshotForm, id: string, file: { fileId: string | null; fileName: string | null }): { snapshot: CompetitorSnapshot | null; errors: string[] } {
  const errors: string[] = [];
  const read = (label: string, text: string): string | null => {
    if (!text.trim()) return null;
    const v = parseNumberRu(text);
    if (v === null) errors.push(`${label}: «${text}» — не число.`);
    return v;
  };
  const date = parseDate(f.date);
  if (!date) errors.push("Укажите дату данных карточки как 26.09.2026.");
  const nums = {} as Record<SnapNumKey, string | null>;
  for (const k of Object.keys(SNAP_LABEL) as SnapNumKey[]) {
    const v = read(SNAP_LABEL[k], f[k]);
    if (v !== null && SHARE_KEYS.includes(k) && new Decimal(v).gt(PERCENT)) errors.push(`${SNAP_LABEL[k]} — не больше 100 %.`);
    nums[k] = v !== null && SHARE_KEYS.includes(k) ? new Decimal(v).div(PERCENT).toString() : v;
  }
  if (nums.avgPrice === null) errors.push("Укажите среднюю цену 1 м² (итого по экспозиции): без неё ЖК не попадёт в аналоги.");
  const byType: CompetitorSnapshot["byType"] = {};
  for (const t of ROOM_TYPES) {
    const r = f.byType[t];
    const row = { lots: read(`${t}: лотов`, r.lots), area: read(`${t}: площадь`, r.area), price: read(`${t}: цена 1 м²`, r.price) };
    if (row.lots !== null || row.area !== null || row.price !== null) byType[t] = row;
  }
  if (errors.length || !date) return { snapshot: null, errors };
  return { snapshot: { id, date, ...nums, byType, stage: textOrNull(f.stage), rve: textOrNull(f.rve), ...file }, errors: [] };
}

/** Добавить или заменить снимок; снимки — по возрастанию даты. Снимок на ту же дату заменяет прежний. */
export function withSnapshot(c: Competitor, s: CompetitorSnapshot, at: string): Competitor {
  const rest = c.snapshots.filter((x) => x.id !== s.id && x.date !== s.date);
  return { ...c, snapshots: [...rest, s].sort((a, b) => a.date.localeCompare(b.date)), updatedAt: at };
}

export function withoutSnapshot(c: Competitor, id: string, at: string): Competitor {
  return { ...c, snapshots: c.snapshots.filter((x) => x.id !== id), updatedAt: at };
}

export const latestSnapshot = (c: Competitor): CompetitorSnapshot | null => c.snapshots.at(-1) ?? null;

/** Привязать к проекту или изменить расстояние; distanceKm — текст поля. */
export function linkTo(c: Competitor, projectId: string, distanceText: string, at: string): { competitor: Competitor | null; error: string | null } {
  const d = distanceText.trim() ? parseNumberRu(distanceText) : null;
  if (distanceText.trim() && d === null) return { competitor: null, error: `Расстояние «${distanceText}» — не число. Введите км, например 1,2.` };
  const links = [...c.links.filter((l) => l.projectId !== projectId), { projectId, distanceKm: d }];
  return { competitor: { ...c, links, updatedAt: at }, error: null };
}

export function unlink(c: Competitor, projectId: string, at: string): Competitor {
  return { ...c, links: c.links.filter((l) => l.projectId !== projectId), updatedAt: at };
}

export const linkOf = (c: Competitor, projectId: string): CompetitorLink | null => c.links.find((l) => l.projectId === projectId) ?? null;

// ---------- темп продаж ----------

/** Проданная площадь на дату снимка: проектная площадь × (1 − остатки по площади), м². */
export function soldArea(s: CompetitorSnapshot): Decimal | null {
  if (s.projectArea === null || s.remainingAreaShare === null) return null;
  return new Decimal(s.projectArea).mul(new Decimal(1).sub(s.remainingAreaShare));
}

const monthsBetween = (a: IsoDate, b: IsoDate): Decimal => new Decimal(daysBetween(a, b)).div(DAYS_IN_MONTH);

export interface CompetitorPace {
  /** м²/мес. */
  pace: Decimal | null;
  origin: Origin | null;
  /** Как получен темп или почему его нет — для пояснения в таблице аналогов. */
  note: string;
}

/** Последняя дата структурного сдвига рынка (BENCH.STRUCTURAL_BREAK_DATES): данные раньше неё не используются. */
function structuralBreak(): IsoDate | null {
  const rows = (getParameter("BENCH.STRUCTURAL_BREAK_DATES").default ?? []) as { date: IsoDate }[];
  return rows.length ? rows.map((r) => r.date).sort().at(-1)! : null;
}

/**
 * Темп продаж конкурента, м²/мес, по последнему снимку:
 * 1) продано за 12 месяцев по выгрузке сделок / 12 — из источника;
 * 2) иначе разница проданной площади между последним снимком и самым ранним снимком окна BENCH.PACE_WINDOW_M
 *    (не раньше даты структурного сдвига), делённая на число месяцев между ними — оценка по аналогам;
 * 3) иначе, если продажи стартовали после сдвига, — проданная площадь / месяцев со старта продаж — оценка по аналогам;
 * 4) иначе темпа нет: нужен второй снимок или выгрузка сделок.
 */
export function competitorPace(c: Competitor): CompetitorPace {
  const last = latestSnapshot(c);
  if (!last) return { pace: null, origin: null, note: "Нет данных карточки: добавьте данные за месяц." };
  const window = Number(getParameter("BENCH.PACE_WINDOW_M").default);
  if (last.soldArea12m !== null) {
    return { pace: new Decimal(last.soldArea12m).div(window), origin: "source", note: `Продано за ${window} мес. по выгрузке сделок на ${fmtDate(last.date)}, в среднем за месяц.` };
  }
  const soldLast = soldArea(last);
  if (soldLast === null) return { pace: null, origin: null, note: "В данных за месяц нет проектной площади или остатков по площади: темп не посчитать." };
  const brk = structuralBreak();
  const from = [edate(last.date, -window), brk].filter((d): d is IsoDate => !!d).sort().at(-1)!;
  const base = c.snapshots.find((s) => s.id !== last.id && s.date >= from && s.date < last.date && soldArea(s) !== null);
  if (base) {
    const months = monthsBetween(base.date, last.date);
    const pace = Decimal.max(soldLast.sub(soldArea(base)!), 0).div(months);
    return { pace, origin: "estimate", note: `Проданная площадь выросла с ${fmtDate(base.date)} по ${fmtDate(last.date)} (${num(months, 1)} мес.): проданная площадь — проектная площадь без остатков.` };
  }
  if (c.salesStart && (!brk || c.salesStart >= brk) && c.salesStart < last.date) {
    const months = monthsBetween(c.salesStart, last.date);
    return { pace: soldLast.div(months), origin: "estimate", note: `Средний темп со старта продаж ${fmtDate(c.salesStart)}: проданная площадь / ${num(months, 1)} мес. Темп за последние месяцы появится после данных за следующий месяц.` };
  }
  return {
    pace: null,
    origin: null,
    note: c.salesStart
      ? `Продажи стартовали до ${fmtDate(brk)}: средний темп со старта не сопоставим с текущим рынком. Добавьте данные за следующий месяц или проданную площадь за 12 месяцев из выгрузки сделок.`
      : "Нет старта продаж и данных за второй месяц: темп не посчитать. Добавьте данные за следующий месяц или проданную площадь за 12 месяцев из выгрузки сделок.",
  };
}

// ---------- в таблицу аналогов проекта ----------

/** Строка таблицы аналогов проекта по последнему снимку; id строки — id конкурента. Нет цены — ошибка с причиной. */
export function analogFromCompetitor(c: Competitor, projectId: string): { analog: AnalogEntry | null; error: string | null } {
  const last = latestSnapshot(c);
  if (!last) return { analog: null, error: `${c.name}: нет данных карточки.` };
  if (last.avgPrice === null) return { analog: null, error: `${c.name}: в данных за месяц нет средней цены 1 м².` };
  const pace = competitorPace(c);
  const link = linkOf(c, projectId);
  return {
    analog: {
      id: c.id,
      name: c.name,
      product: c.product,
      housingClass: c.housingClass,
      distanceKm: link?.distanceKm ?? null,
      stage: [last.stage, last.rve ? `РВЭ ${last.rve}` : null].filter(Boolean).join(", ") || null,
      price: last.avgPrice,
      pace: pace.pace === null ? null : pace.pace.toDecimalPlaces(0).toString(),
      soldShare: last.remainingAreaShare === null ? null : new Decimal(1).sub(last.remainingAreaShare).toString(),
      url: c.url,
      date: last.date,
      competitorId: c.id,
      paceOrigin: pace.origin,
      paceNote: pace.note,
    },
    error: null,
  };
}

/**
 * Обновить таблицу аналогов проекта по привязанным конкурентам: строки конкурентов заменяются данными последнего
 * снимка, новые добавляются, строки отвязанных конкурентов убираются. Строки, введённые вручную, не трогаются.
 */
export function syncAnalogs(analogs: readonly AnalogEntry[], competitors: readonly Competitor[], projectId: string): { analogs: AnalogEntry[]; added: number; updated: number; removed: number; errors: string[] } {
  const linked = competitors.filter((c) => linkOf(c, projectId));
  const linkedIds = new Set(linked.map((c) => c.id));
  const errors: string[] = [];
  const fresh = new Map<string, AnalogEntry>();
  for (const c of linked) {
    const r = analogFromCompetitor(c, projectId);
    if (r.analog) fresh.set(c.id, r.analog);
    else if (r.error) errors.push(r.error);
  }
  let updated = 0;
  let removed = 0;
  const out: AnalogEntry[] = [];
  for (const a of analogs) {
    if (!a.competitorId) {
      out.push(a);
      continue;
    }
    const f = fresh.get(a.competitorId);
    if (f) {
      out.push(f);
      fresh.delete(a.competitorId);
      updated++;
    } else if (linkedIds.has(a.competitorId)) out.push(a);
    else removed++;
  }
  const added = fresh.size;
  out.push(...fresh.values());
  return { analogs: out, added, updated, removed, errors };
}

// ---------- файл конкурентов ----------

export const COMPETITORS_FORMAT = "finmodel-competitors";
export const COMPETITORS_FORMAT_VERSION = 1;

export interface CompetitorsFile {
  format: typeof COMPETITORS_FORMAT;
  formatVersion: typeof COMPETITORS_FORMAT_VERSION;
  savedAt: string;
  competitors: Competitor[];
  /** Скриншоты и отчёты снимков, id — fileId снимка. */
  files: FileEntry[];
}

const nstr = z.string().nullable();
const room = z.object({ lots: nstr, area: nstr, price: nstr });
const snapshotSchema = z.object({
  id: z.string(),
  date: z.string().refine(isIsoDate),
  projectArea: nstr,
  projectLots: nstr,
  exposureLots: nstr,
  exposureArea: nstr,
  avgPrice: nstr,
  byType: z.object(Object.fromEntries(ROOM_TYPES.map((t) => [t, room.optional()]))),
  remainingAreaShare: nstr,
  remainingLotsShare: nstr,
  stage: nstr,
  rve: nstr,
  soldArea12m: nstr,
  fileId: nstr,
  fileName: nstr,
});
const competitorSchema = z.object({
  id: z.string(),
  name: z.string(),
  url: z.string(),
  developer: nstr,
  district: nstr,
  metro: nstr,
  product: z.string(),
  classText: nstr,
  housingClass: z.string(),
  construction: nstr,
  floors: nstr,
  finish: nstr,
  contract: nstr,
  salesStart: nstr,
  links: z.array(z.object({ projectId: z.string(), distanceKm: nstr })),
  snapshots: z.array(snapshotSchema),
  updatedAt: z.string(),
});
const fileSchema = z.object({
  format: z.literal(COMPETITORS_FORMAT),
  formatVersion: z.literal(COMPETITORS_FORMAT_VERSION),
  savedAt: z.string(),
  competitors: z.array(competitorSchema),
  files: z.array(z.object({ id: z.string(), name: z.string(), type: z.string(), size: z.number(), sha256: z.string(), data: z.string() })),
});

export function buildCompetitorsFile(competitors: readonly Competitor[], files: readonly FileEntry[], at: string): CompetitorsFile {
  return { format: COMPETITORS_FORMAT, formatVersion: COMPETITORS_FORMAT_VERSION, savedAt: at, competitors: [...competitors], files: [...files] };
}

export const competitorsFileName = (at: string): string => `Конкуренты ${fmtDate(at.slice(0, 10))}.json`;

export function parseCompetitorsFile(json: unknown): { file: CompetitorsFile | null; error: string | null } {
  const r = fileSchema.safeParse(json);
  if (!r.success) return { file: null, error: "Это не файл конкурентов или он повреждён." };
  return { file: r.data as CompetitorsFile, error: null };
}

/**
 * Объединить файл с карточками этого браузера: новые конкуренты добавляются; у известных снимки объединяются (снимок
 * на ту же дату из файла заменяет прежний), привязки к проектам — тоже, описание берётся из более свежей карточки.
 */
export function mergeCompetitors(local: readonly Competitor[], incoming: readonly Competitor[], at: string): { competitors: Competitor[]; added: number; updated: number } {
  const byId = new Map(local.map((c) => [c.id, c]));
  let added = 0;
  let updated = 0;
  for (const c of incoming) {
    const old = byId.get(c.id);
    if (!old) {
      byId.set(c.id, c);
      added++;
      continue;
    }
    const base = c.updatedAt > old.updatedAt ? c : old;
    let merged: Competitor = { ...base, snapshots: old.snapshots, links: old.links };
    for (const s of c.snapshots) merged = withSnapshot(merged, s, at);
    const links = new Map(old.links.map((l) => [l.projectId, l]));
    for (const l of c.links) links.set(l.projectId, l);
    byId.set(c.id, { ...merged, links: [...links.values()], updatedAt: at });
    updated++;
  }
  return { competitors: [...byId.values()], added, updated };
}

// ---------- показ ----------

/** Пора обновить данные: последнему снимку больше месяца (или снимков нет). */
export function needsUpdate(c: Competitor, today: IsoDate): boolean {
  const last = latestSnapshot(c);
  return !last || last.date < edate(today, -1);
}

/** Доля → «36,5 %»; нет — «—». */
export const shareText = (v: string | null): string => (v === null ? "—" : `${num(new Decimal(v).mul(PERCENT), 1)} %`);

/** Распроданность по площади: 1 − остатки. */
export const soldShareText = (s: CompetitorSnapshot | null): string => (s?.remainingAreaShare == null ? "—" : shareText(new Decimal(1).sub(s.remainingAreaShare).toString()));

/** Число строкой → «558 573»; нет — «—». */
export const numText = (v: string | null | undefined, digits = 0): string => (v ? num(new Decimal(v), digits) : "—");

/** Темп → «1 029 м²/мес»; нет — «—». */
export const paceText = (p: CompetitorPace): string => (p.pace === null ? "—" : `${num(p.pace, 0)} м²/мес`);
