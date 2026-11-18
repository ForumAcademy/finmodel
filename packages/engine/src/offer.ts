/**
 * Инвестиционное предложение по участку (PDF продавца или брокера): поля участка, цена, плотность и данные для ЦОДа
 * (мощность по техусловиям). Распознаёт пакет @fm/egrn-import, здесь — что из этого попадает в проект.
 * Решение пользователя 18.11.2026: документ можно загрузить в самом начале, цифры из него сервис берёт сам.
 */
import Decimal from "decimal.js";
import { num } from "./lib/text";
import { applyChanges, cadastralQuarter, PROJECT_REGIONS, regionByAddress, tenureFromRights, type EgrnPlot, type LandProject, type PlotChange, type PlotFieldKey, type PlotValue, type ProjectPurpose, type ValueBasis } from "./plot";
import { applySiteChange, siteChange, siteValue, type SiteFieldKey } from "./site";

/** Данные предложения сверх полей участка. Числа — строки с точкой. */
export interface OfferData {
  /** Мощность по согласованным техусловиям, МВт. */
  gridPowerMw?: string;
  /** Потенциальная мощность (например, после постройки подстанции), МВт. */
  potentialPowerMw?: string;
  /** Уровень напряжения (тариф): ВН, СН-1, СН-2, НН. */
  voltage?: string;
  /** Плотность застройки, тыс. м²/га, как в документе. */
  densityThM2Ha?: string;
  /** Площадь по ППМ, м². */
  ppmAreaM2?: string;
  /** Цена участка или прав, руб. */
  priceRub?: string;
  /** «без НДС» / «с НДС», если указано рядом с ценой. */
  priceVat?: "без НДС" | "с НДС";
  /** Схема сделки, как в документе: «покупка юридического лица». */
  dealScheme?: string;
  /** Срок аренды, год окончания. */
  leaseUntilYear?: string;
}

/** Что распознано в предложении: поля участка (как у выписки) и данные предложения. */
export interface OfferParsed {
  plot: EgrnPlot;
  offer: OfferData;
  /** Документ говорит о ЦОДе — подсказка для поля «Назначение». */
  purposeHint: ProjectPurpose | null;
}

/** Предложение в проекте: что распознано и из какого документа. */
export interface ProjectOffer {
  documentId: string;
  data: OfferData;
}

export const OFFER_TITLE = "Инвестиционное предложение";

export const OFFER_FIELDS: readonly { key: keyof OfferData; label: string; unit?: string }[] = [
  { key: "gridPowerMw", label: "Мощность по техусловиям", unit: "МВт" },
  { key: "potentialPowerMw", label: "Потенциальная мощность", unit: "МВт" },
  { key: "voltage", label: "Уровень напряжения (тариф)" },
  { key: "densityThM2Ha", label: "Плотность застройки", unit: "тыс. м²/га" },
  { key: "ppmAreaM2", label: "Площадь по ППМ", unit: "м²" },
  { key: "priceRub", label: "Цена участка", unit: "руб" },
  { key: "dealScheme", label: "Схема сделки" },
  { key: "leaseUntilYear", label: "Аренда до", unit: "года" },
];

/** Значение для показа: числа с разрядами, цена — с пометкой НДС. */
export function offerText(o: OfferData, key: keyof OfferData): string | null {
  const v = o[key];
  if (!v) return null;
  if (key === "leaseUntilYear") return `${v} года`;
  if (key === "voltage" || key === "dealScheme" || key === "priceVat") return v;
  const f = OFFER_FIELDS.find((x) => x.key === key);
  const text = `${num(new Decimal(v), key === "priceRub" ? 0 : 2)}${f?.unit ? ` ${f.unit}` : ""}`;
  return key === "priceRub" && o.priceVat ? `${text}, ${o.priceVat}` : text;
}

/** Строки «что нашлось» для экрана: только найденные поля. */
export function offerRows(o: OfferData): { label: string; value: string }[] {
  return OFFER_FIELDS.flatMap((f) => {
    const value = offerText(o, f.key);
    return value ? [{ label: f.label, value }] : [];
  });
}

/** Коротко, что нашлось: поля участка и предложения. */
export function offerFound(r: OfferParsed): string[] {
  const plotLabels: [keyof EgrnPlot, string][] = [
    ["cadastralNumber", "кадастровый номер"],
    ["address", "адрес"],
    ["area", "площадь"],
    ["vri", "ВРИ"],
    ["rights", "право"],
  ];
  const plotFound = plotLabels.filter(([k]) => {
    const v = r.plot[k];
    return Array.isArray(v) ? v.length > 0 : Boolean(v);
  });
  return [...plotFound.map(([, l]) => l), ...OFFER_FIELDS.filter((f) => r.offer[f.key]).map((f) => lowerFirst(f.label))];
}

/** «Площадь по ППМ» → «площадь по ППМ»: аббревиатуры остаются заглавными. */
const lowerFirst = (s: string) => (s.charAt(1) === s.charAt(1).toUpperCase() ? s : s.charAt(0).toLowerCase() + s.slice(1));

/** 1 тыс. м²/га = 0,1 м²/м² (как у поля «Предельная плотность застройки»). */
const TH_M2_HA_TO_M2_M2 = new Decimal(1000).div(10000);

/**
 * Взять данные предложения в проект: поля участка, цена и плотность — «из источника» со ссылкой на документ.
 * Значения из выписки ЕГРН не заменяются: выписка главнее предложения продавца.
 */
export function applyOffer(p: LandProject, parsed: OfferParsed, documentId: string, at: string): { project: LandProject; problems: string[] } {
  const basis: ValueBasis = { title: OFFER_TITLE, documentId, date: at.slice(0, 10) };
  const fromEgrn = (v: PlotValue) => v.origin === "source" && v.basis?.title === "Выписка ЕГРН";
  const problems: string[] = [];
  const changes: PlotChange[] = [];
  const put = (field: PlotFieldKey, value: string | null | undefined, note?: string) => {
    if (!value) return;
    const from = p.plot[field];
    if (fromEgrn(from)) {
      if (from.value !== value) problems.push(`${fieldName(field)} в предложении (${value}) отличается от выписки ЕГРН (${from.value}). Оставлено значение выписки.`);
      return;
    }
    if (from.value === value && from.origin === "source") return;
    changes.push({ field, from, to: { value, origin: "source", basis: note ? { ...basis, note } : basis } });
  };
  const d = parsed.plot;
  const own = p.plot.cadastralNumber.value;
  if (own && d.cadastralNumber && own !== d.cadastralNumber && !own.split(",").map((x) => x.trim()).includes(d.cadastralNumber)) {
    return { project: p, problems: [`Номер в предложении ${d.cadastralNumber} не совпадает с номером проекта ${own}. Проверьте, что документ по этому участку, или исправьте номер.`] };
  }
  put("cadastralNumber", d.cadastralNumber);
  put("quarter", d.cadastralNumber ? cadastralQuarter(d.cadastralNumber) : null, "По кадастровому номеру");
  put("address", d.address);
  const region = (d.regionCode ? PROJECT_REGIONS.find((r) => r.code === d.regionCode) : undefined) ?? (d.address ? regionByAddress(d.address) : null);
  if (region) put("regionCode", region.code, "Регион определён по адресу в предложении");
  put("area", d.area, "Точная площадь — в выписке ЕГРН или на карте НСПД");
  put("vri", d.vri);
  const tenure = d.rights?.length ? tenureFromRights(d.rights) : null;
  put("tenure", tenure, d.rights?.length ? `По предложению: ${d.rights.join("; ")}` : undefined);

  let project = applyChanges(p, changes, at);
  const o = parsed.offer;
  const siteFrom = (key: SiteFieldKey, value: string | undefined, note?: string) => {
    if (!value) return;
    if (fromEgrn(siteValue(project, key))) return;
    const c = siteChange(project, key, value, note ? { ...basis, note } : basis);
    if (c) project = applySiteChange(project, c, at);
  };
  siteFrom("landPrice", o.priceRub, o.priceVat ? `Цена ${o.priceVat}${o.dealScheme ? `; схема сделки: ${o.dealScheme}` : ""}` : o.dealScheme ? `Схема сделки: ${o.dealScheme}` : undefined);
  siteFrom("density", o.densityThM2Ha ? new Decimal(o.densityThM2Ha).mul(TH_M2_HA_TO_M2_M2).toString() : undefined);
  project = { ...project, offer: { documentId, data: o }, updatedAt: at };
  return { project, problems };
}

function fieldName(field: PlotFieldKey): string {
  const names: Partial<Record<PlotFieldKey, string>> = { area: "Площадь", address: "Адрес", vri: "ВРИ", tenure: "Форма права", regionCode: "Регион" };
  return names[field] ?? "Значение";
}
