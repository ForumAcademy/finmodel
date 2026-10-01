/**
 * Анализ участка в проекте: ограничения (градрегламент, ГПЗУ, зоны с особыми условиями), аналоги рынка, свои варианты
 * и выбранный вариант. Ввод, показ, «было → стало» и вводные для расчёта. Экраны только показывают результат.
 */
import Decimal from "decimal.js";
import { getParameter, type ParameterId, type SpecAssumptionVersion as AssumptionVersion } from "@fm/spec";
import type { CalcProject } from "./project";
import { eomonth, isIsoDate, type IsoDate } from "./lib/dates";
import { date as fmtDate, num, plural } from "./lib/text";
import { basisText, parseNumberRu, PLOT_FIELDS, vriCodes, type HistoryEntry, type LandProject, type Origin, type PlotValue, type ValueBasis } from "./plot";
import type { Variant } from "./modules/variant";
import { variantId } from "./modules/variant";
import type { ZcycCurve } from "./zcyc";

// ---------- поля ограничений ----------

export type SiteFieldKey = "zone" | "maxGfa" | "density" | "maxFloors" | "maxHeight" | "builtShare" | "apartAllowed" | "landPrice" | "startDate" | "parkingPerApt" | "landTaxRate" | "riskFree";

export type SiteFieldKind = "text" | "area" | "number" | "percent" | "density" | "bool" | "money" | "date";

export interface SiteField {
  key: SiteFieldKey;
  label: string;
  unit?: string;
  param: ParameterId;
  kind: SiteFieldKind;
  /** Подсказка: где взять значение. */
  hint: string;
}

const PERCENT = 100;
/** 1 тыс. м²/га = 1000 м² / 10 000 м² = 0,1 м²/м². */
const DENSITY_TO_M2 = new Decimal(1000).div(10000);

export const SITE_FIELDS: readonly SiteField[] = [
  { key: "zone", label: "Территориальная зона", param: "SITE.ZONE", kind: "text", hint: "Индекс зоны по карте ПЗЗ, например Ж1" },
  { key: "maxGfa", label: "Предельная наземная площадь", unit: "м²", param: "GPZU.MAX_GFA_ABOVE", kind: "area", hint: "Суммарная поэтажная площадь в габаритах наружных стен из ГПЗУ" },
  { key: "density", label: "Предельная плотность застройки", unit: "тыс. м²/га", param: "SITE.MAX_DENSITY", kind: "density", hint: "Из регламента зоны ПЗЗ или ГПЗУ (для Москвы — в тыс. м²/га)" },
  { key: "maxFloors", label: "Предельная этажность", unit: "эт.", param: "GPZU.MAX_FLOORS", kind: "number", hint: "Из ГПЗУ или регламента зоны ПЗЗ; если задана только высота — пересчитайте в этажи" },
  { key: "maxHeight", label: "Предельная высота", unit: "м", param: "GPZU.MAX_HEIGHT_M", kind: "number", hint: "Из ГПЗУ или регламента зоны ПЗЗ" },
  { key: "builtShare", label: "Максимальный процент застройки", unit: "%", param: "GPZU.MAX_BUILT_SHARE", kind: "percent", hint: "Из ГПЗУ или регламента зоны ПЗЗ" },
  { key: "apartAllowed", label: "Допускаются апартаменты", param: "GPZU.APART_ALLOWED", kind: "bool", hint: "Да — если ГПЗУ допускает объекты гостиничного назначения (ВРИ 4.7)" },
  { key: "landPrice", label: "Цена участка", unit: "руб", param: "LAND.PURCHASE_PRICE", kind: "money", hint: "По предложению продавца или договору" },
  { key: "startDate", label: "Дата сделки по участку", param: "GEN.MODEL_START_DATE", kind: "date", hint: "С неё начинается расчёт вариантов; пусто — конец текущего месяца" },
  { key: "parkingPerApt", label: "Норматив машино-мест на квартиру", unit: "м/м", param: "TEP.PARKING_NORM", kind: "number", hint: "По нормативам градостроительного проектирования региона или ГПЗУ" },
  { key: "landTaxRate", label: "Ставка земельного налога", unit: "%", param: "TAX.LAND_RATE", kind: "percent", hint: "По решению муниципалитета (сервис ФНС «Справочная информация о ставках»)" },
  { key: "riskFree", label: "Безрисковая ставка", unit: "% годовых", param: "VAL.RISK_FREE", kind: "percent", hint: "Доходность ОФЗ со сроком, равным сроку проекта, на дату оценки — если кривую Мосбиржи не удалось загрузить" },
];

const siteFieldByKey = new Map(SITE_FIELDS.map((f) => [f.key, f]));
export const siteField = (key: SiteFieldKey): SiteField => siteFieldByKey.get(key) as SiteField;

/** Вкладка «Градрегламент»: ограничения объёма; «Сделка»: цена и дата. */
export const REGULATION_FIELDS: readonly SiteFieldKey[] = ["zone", "maxGfa", "density", "maxFloors", "maxHeight", "builtShare", "apartAllowed"];
export const DEAL_FIELDS: readonly SiteFieldKey[] = ["landPrice", "startDate"];
/** Нормативы, которых нет в справочнике регионов: вводятся по проекту с документом. */
export const NORM_FIELDS: readonly SiteFieldKey[] = ["parkingPerApt", "landTaxRate"];
/** Ручной ввод безрисковой ставки: только когда кривая доходности не загружена. */
export const RATE_FIELDS: readonly SiteFieldKey[] = ["riskFree"];

export const BOOL_YES = "да";
export const BOOL_NO = "нет";

/** Значение поля для показа, без единицы. */
export function siteText(key: SiteFieldKey, value: string | null): string {
  if (value === null) return "";
  const f = siteField(key);
  switch (f.kind) {
    case "area":
    case "number":
      return num(new Decimal(value), 2);
    case "money":
      return num(new Decimal(value), 0);
    case "percent":
      return num(new Decimal(value).mul(PERCENT), 2);
    case "density":
      return num(new Decimal(value).div(DENSITY_TO_M2), 2);
    case "date":
      return fmtDate(value);
    default:
      return value;
  }
}

/** Значение с единицей для «было → стало» и истории; нет значения — «не учтено». */
export function siteDisplay(key: SiteFieldKey, value: string | null): string {
  if (value === null) return "не учтено";
  const f = siteField(key);
  return f.unit ? `${siteText(key, value)} ${f.unit}` : siteText(key, value);
}

export type ParsedSite = { value: string; error?: undefined } | { value?: undefined; error: string };

const DMY = /^(\d{2})\.(\d{2})\.(\d{4})$/;

/** Текст поля ввода → значение для хранения (числа — с точкой, проценты — долей, плотность — м²/м²). */
export function parseSite(key: SiteFieldKey, text: string): ParsedSite {
  const f = siteField(key);
  const t = text.trim();
  if (!t) return { error: "Введите значение или удалите его кнопкой «Нет значения»." };
  if (f.kind === "text") return { value: t };
  if (f.kind === "bool") return t === BOOL_YES || t === BOOL_NO ? { value: t } : { error: "Выберите «да» или «нет»." };
  if (f.kind === "date") {
    const m = DMY.exec(t);
    const iso = m ? `${m[3]}-${m[2]}-${m[1]}` : t;
    return isIsoDate(iso) ? { value: iso } : { error: `«${t}» — не дата. Введите дату как 30.09.2026.` };
  }
  const n = parseNumberRu(t);
  if (n === null) return { error: `«${t}» — не число. Введите число${f.unit ? ` в ${f.unit}` : ""}, например ${f.kind === "percent" ? "40" : "24"}.` };
  const d = new Decimal(n);
  const stored = f.kind === "percent" ? d.div(PERCENT) : f.kind === "density" ? d.mul(DENSITY_TO_M2) : d;
  const range = getParameter(f.param).range;
  if (range && (stored.lt(range[0]) || stored.gt(range[1]))) {
    const show = (x: number) => siteText(key, String(x));
    return { error: `${f.label} ${siteText(key, stored.toString())}${f.unit ? ` ${f.unit}` : ""} вне допустимого диапазона ${show(range[0])}–${show(range[1])}. Проверьте единицы.` };
  }
  if (f.kind === "number" && f.param === "GPZU.MAX_FLOORS" && !d.isInteger()) return { error: "Этажность — целое число." };
  return { value: stored.toString() };
}

/** Число с единицей для сообщений и диапазона: «24 эт.», «40 %». */
export function siteShow(key: SiteFieldKey, stored: string): string {
  const f = siteField(key);
  return `${siteText(key, stored)}${f.unit ? ` ${f.unit}` : ""}`;
}

/** Проверка диапазона Экспертного значения поля ограничений: у числовых полей — разбор как у значения; у текста, даты, да/нет — нет. */
export function siteExpertNumeric(key: SiteFieldKey, value: string | null) {
  const f = siteField(key);
  if (f.kind === "text" || f.kind === "bool" || f.kind === "date") return undefined;
  return { value, parse: (t: string) => parseSite(key, t), show: (x: string) => siteShow(key, x) };
}

// ---------- зоны с особыми условиями ----------

/** Диапазон площади зоны без документа (Экспертное значение), м². */
export function zoneAreaNumeric(area: string | null) {
  const show = (x: string) => `${num(x, 2)} м²`;
  return { value: area, parse: (t: string) => { const v = parseNumberRu(t); return v === null ? { error: `«${t}» — не число, введите площадь в м²` } : { value: v }; }, show };
}

export interface ZouitEntry {
  id: string;
  name: string;
  /** Площадь пересечения с участком, м², строка; null — не известна. */
  area: string | null;
  /** Строить в зоне нельзя: площадь вычитается из площади под застройку. */
  noBuild: boolean;
  restriction: string;
  origin: Origin;
  basis: ValueBasis;
}

// ---------- аналоги рынка ----------

export const ANALOG_PRODUCTS = getParameter("MARKET.ANALOGS").columns?.find((c) => c.key === "product")?.options ?? [];
export const HOUSING_CLASSES = getParameter("GEN.HOUSING_CLASS").options ?? [];

export interface AnalogEntry {
  id: string;
  name: string;
  product: string;
  housingClass: string;
  /** Строки чисел (как в поле участка); null — нет значения. */
  distanceKm: string | null;
  stage: string | null;
  /** Цена с НДС, руб/м² (руб/шт для машино-мест). */
  price: string | null;
  /** Темп продаж, м²/мес (шт/мес для машино-мест). */
  pace: string | null;
  soldShare: string | null;
  /** Карточка ЖК или объявление: обязательна. */
  url: string;
  /** Дата данных, ГГГГ-ММ-ДД. */
  date: string;
  /** Строка из карточки конкурента (вкладка «Конкуренты»): id конкурента. Нет — строка введена вручную. */
  competitorId?: string;
  /** Происхождение темпа, если он посчитан, а не взят из источника как есть; пояснение — как посчитан. */
  paceOrigin?: Origin | null;
  paceNote?: string;
}

export type AnalogForm = Record<"name" | "product" | "housingClass" | "distanceKm" | "stage" | "price" | "pace" | "soldShare" | "url" | "date", string>;

export const PIECE_PRODUCT = "машино-места";

/** Сколько аналогов одного продукта и класса нужно для цены и темпа (BENCH.MARKET_MIN_COMPS). */
export const minAnalogs = (): number => Number(getParameter("BENCH.MARKET_MIN_COMPS").default);

export const analogPriceUnit = (product: string): string => (product === PIECE_PRODUCT ? "руб/шт" : "руб/м²");
export const analogPaceUnit = (product: string): string => (product === PIECE_PRODUCT ? "шт/мес" : "м²/мес");

export function analogToForm(a: AnalogEntry | null): AnalogForm {
  const n = (s: string | null, digits = 2) => (s === null ? "" : num(new Decimal(s), digits));
  return {
    name: a?.name ?? "",
    product: a?.product ?? "квартиры",
    housingClass: a?.housingClass ?? "",
    distanceKm: n(a?.distanceKm ?? null),
    stage: a?.stage ?? "",
    price: n(a?.price ?? null, 0),
    pace: n(a?.pace ?? null),
    soldShare: a?.soldShare ? num(new Decimal(a.soldShare).mul(PERCENT), 1) : "",
    url: a?.url ?? "",
    date: a?.date ? fmtDate(a.date) : "",
  };
}

/** Проверить форму аналога: что не так → что сделать. */
export function analogFromForm(f: AnalogForm, id: string, prev: AnalogEntry | null = null): { analog: AnalogEntry | null; errors: string[] } {
  const errors: string[] = [];
  const numOrNull = (label: string, text: string): string | null => {
    if (!text.trim()) return null;
    const v = parseNumberRu(text);
    if (v === null) errors.push(`${label}: «${text}» — не число.`);
    return v;
  };
  if (!f.name.trim()) errors.push("Укажите название ЖК.");
  if (!ANALOG_PRODUCTS.includes(f.product)) errors.push("Выберите продукт.");
  if (!HOUSING_CLASSES.includes(f.housingClass)) errors.push("Выберите класс жилья.");
  const price = numOrNull("Цена", f.price);
  const pace = numOrNull("Темп продаж", f.pace);
  const distanceKm = numOrNull("Расстояние", f.distanceKm);
  const sold = numOrNull("Продано", f.soldShare);
  if (price === null && !errors.some((e) => e.startsWith("Цена"))) errors.push(`Укажите цену, ${analogPriceUnit(f.product)} с НДС.`);
  if (pace === null && !errors.some((e) => e.startsWith("Темп"))) errors.push(`Укажите темп продаж, ${analogPaceUnit(f.product)}.`);
  if (!/^https?:\/\/\S+$/.test(f.url.trim())) errors.push("Укажите ссылку на карточку ЖК или объявление (https://…): без неё аналог не проверить.");
  const m = DMY.exec(f.date.trim());
  const iso = m ? `${m[3]}-${m[2]}-${m[1]}` : f.date.trim();
  if (!isIsoDate(iso)) errors.push("Укажите дату данных как 30.09.2026.");
  if (sold !== null && new Decimal(sold).gt(PERCENT)) errors.push("Продано — не больше 100 %.");
  if (errors.length) return { analog: null, errors };
  return {
    analog: {
      id,
      name: f.name.trim(),
      product: f.product,
      housingClass: f.housingClass,
      distanceKm,
      stage: f.stage.trim() || null,
      price,
      pace,
      soldShare: sold === null ? null : new Decimal(sold).div(PERCENT).toString(),
      url: f.url.trim(),
      date: iso,
      ...(prev?.competitorId ? { competitorId: prev.competitorId } : {}),
      ...(prev?.paceOrigin && prev.pace === pace ? { paceOrigin: prev.paceOrigin, paceNote: prev.paceNote ?? "" } : {}),
    },
    errors: [],
  };
}

// ---------- данные анализа в проекте ----------

/** Итоги последнего расчёта вариантов: для карточки в списке проектов. */
export interface AnalysisSnapshot {
  /** Дата и время расчёта, ISO. */
  at: string;
  best: string | null;
  bestTitle: string | null;
  /** Итог лучшего (или выбранного) варианта для карточки: чистая прибыль, руб. */
  netProfit: string | null;
  /** NPV акционера лучшего варианта, руб — если выбран по NPV. */
  npv?: string;
  variants: number;
}

export interface SiteData {
  values: Partial<Record<SiteFieldKey, PlotValue>>;
  zouit: ZouitEntry[];
  analogs: AnalogEntry[];
  /** Свои варианты: класс и этажность, заданные финансистом. */
  customVariants: Variant[];
  /** Вариант, выбранный финансистом для дальнейшей работы. */
  selectedVariant: string | null;
  snapshot: AnalysisSnapshot | null;
  /** Кривая бескупонной доходности ОФЗ Мосбиржи на дату оценки; null — не загружена. */
  curve: ZcycCurve | null;
}

export function emptySite(): SiteData {
  return { values: {}, zouit: [], analogs: [], customVariants: [], selectedVariant: null, snapshot: null, curve: null };
}

export const siteOf = (p: LandProject): SiteData => ({ ...emptySite(), ...(p.site ?? {}) });

const EMPTY: PlotValue = { value: null, origin: null, basis: null };
export const siteValue = (p: LandProject, key: SiteFieldKey): PlotValue => siteOf(p).values[key] ?? EMPTY;

/** Название варианта: «Комфорт, 24 этажа». */
export function variantTitle(v: Pick<Variant, "housing_class" | "floors" | "apart">): string {
  const cls = v.housing_class.charAt(0).toUpperCase() + v.housing_class.slice(1);
  return `${cls}, ${v.floors} ${plural(v.floors, ["этаж", "этажа", "этажей"])}${v.apart ? ", с апартаментами" : ""}`;
}

/** Свой вариант: класс и этажность. Такой вариант уже есть — ошибка. */
export function customVariant(p: LandProject, housingClass: string, floorsText: string, generated: readonly Variant[]): { variant: Variant | null; error: string | null } {
  if (!HOUSING_CLASSES.includes(housingClass)) return { variant: null, error: "Выберите класс жилья." };
  const f = parseNumberRu(floorsText);
  if (f === null || !Number.isInteger(Number(f)) || Number(f) < 1) return { variant: null, error: `«${floorsText}» — не этажность. Введите целое число этажей, например 17.` };
  const max = siteValue(p, "maxFloors").value;
  if (max !== null && Number(f) > Number(max)) return { variant: null, error: `${f} этажей — выше предельной этажности ${max}. Введите этажность не выше ${max}.` };
  const v: Variant = { id: variantId(housingClass, Number(f), false), housing_class: housingClass, floors: Number(f), apart: false };
  if ([...generated, ...siteOf(p).customVariants].some((x) => x.id === v.id)) return { variant: null, error: `Вариант «${variantTitle(v)}» уже есть.` };
  return { variant: v, error: null };
}

/** Все варианты проекта: построенные по ограничениям и рынку + свои. */
export function allVariants(p: LandProject, generated: readonly Variant[]): Variant[] {
  const custom = siteOf(p).customVariants.filter((c) => !generated.some((g) => g.id === c.id));
  return [...generated, ...custom];
}

// ---------- изменения ----------

export interface SiteChange {
  field: SiteFieldKey;
  from: PlotValue;
  to: PlotValue;
}

/** Ручное изменение ограничения: с документом проекта — «из источника», без документа — «Экспертное значение». */
export function siteChange(p: LandProject, field: SiteFieldKey, value: string | null, basis: ValueBasis): SiteChange | null {
  const from = siteValue(p, field);
  const to: PlotValue = { value, origin: value === null ? null : basis.documentId ? "source" : "expert", basis: value === null ? null : basis };
  return from.value === to.value && from.origin === to.origin && basisText(from.basis) === basisText(to.basis) ? null : { field, from, to };
}

/** Применить изменение: новое значение и запись в историю. */
export function applySiteChange(p: LandProject, c: SiteChange, at: string): LandProject {
  const site = siteOf(p);
  const entry: HistoryEntry = { at, field: c.field, from: siteDisplay(c.field, c.from.value), to: siteDisplay(c.field, c.to.value), basis: basisText(c.to.basis) || "Значение удалено" };
  return { ...p, site: { ...site, values: { ...site.values, [c.field]: c.to }, snapshot: null }, history: [...p.history, entry], updatedAt: at };
}

/** Заменить список (зоны, аналоги, свои варианты) или выбранный вариант; итоги расчёта сбрасываются. */
export function updateSite(p: LandProject, patch: Partial<Omit<SiteData, "values">>, at: string): LandProject {
  const keepSnapshot = Object.keys(patch).every((k) => k === "selectedVariant" || k === "snapshot");
  return { ...p, site: { ...siteOf(p), ...(keepSnapshot ? {} : { snapshot: null }), ...patch }, updatedAt: at };
}

// ---------- вводные для расчёта ----------

const toNumber = (s: string | null) => (s === null ? null : Number(s));

/**
 * Проект для расчёта анализа участка: поля участка и ограничений → параметры, стадия «оценка участка», начало расчёта
 * и дата оценки — дата сделки по участку (пусто — конец текущего месяца).
 */
export function siteCalcProject(p: LandProject, today: IsoDate): CalcProject {
  const values: Partial<Record<ParameterId, unknown>> = { "GEN.PROJECT_STAGE": "оценка участка" };
  for (const f of PLOT_FIELDS) {
    const v = p.plot[f.key].value;
    if (!f.param || v === null) continue;
    if (f.key === "vri") values[f.param] = vriCodes(v);
    else values[f.param] = f.kind === "area" || f.kind === "money" ? Number(v) : v;
  }
  const site = siteOf(p);
  for (const f of SITE_FIELDS) {
    const v = site.values[f.key]?.value ?? null;
    if (v === null) continue;
    if (f.key === "parkingPerApt") values[f.param] = { rule: "by_apartment_area", values: [{ max_area: null, per_apt: Number(v) }] };
    else values[f.param] = f.kind === "bool" ? v === BOOL_YES : f.kind === "text" || f.kind === "date" ? v : Number(v);
  }
  const start = (site.values.startDate?.value as IsoDate | undefined) ?? eomonth(today, 0);
  values["GEN.MODEL_START_DATE"] = start;
  values["GEN.VALUATION_DATE"] = start;
  if (site.curve) {
    values["VAL.ZCYC"] = site.curve.points.map((x) => ({ term: x.term, yield: x.yield }));
    values["VAL.ZCYC_DATE"] = site.curve.date;
  }
  if (site.zouit.length) {
    values["SITE.ZOUIT"] = site.zouit.map((z) => ({ name: z.name, area_m2: toNumber(z.area), no_build: z.noBuild, restriction: z.restriction }));
  }
  if (site.analogs.length) {
    values["MARKET.ANALOGS"] = site.analogs.map((a) => ({
      name: a.name,
      product: a.product,
      housing_class: a.housingClass,
      distance_km: toNumber(a.distanceKm),
      stage: a.stage,
      price: toNumber(a.price),
      pace: toNumber(a.pace),
      sold_share: toNumber(a.soldShare),
      url: a.url,
      date: a.date,
    }));
  }
  return { input: { values, mode: "normal" }, assumptionsVersion: p.assumptionsVersion };
}

/** Версии справочника для расчёта проекта: снимок из файла проекта, иначе справочник этого браузера. */
export function calcVersions(p: LandProject, local: readonly AssumptionVersion[]): AssumptionVersion[] {
  return p.assumptionsSnapshot ? [p.assumptionsSnapshot] : [...local];
}

/** Распроданность аналога для таблицы: доля → «63 %»; нет — «—». */
export function analogSoldText(a: AnalogEntry): string {
  return a.soldShare === null ? "—" : `${num(new Decimal(a.soldShare).mul(PERCENT), 0)} %`;
}
