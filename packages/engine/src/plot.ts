/**
 * Участок проекта: поля, метки происхождения, создание проекта (с кадастровым номером и без), данные выписки ЕГРН,
 * изменения «было → стало» и история. Экраны только показывают результат этих функций (CLAUDE.md, «Устройство»).
 */
import Decimal from "decimal.js";
import { getParameter, spec, type ParameterId, type RegionCode, type SpecAssumptionVersion } from "@fm/spec";
import { SPEC_ASSUMPTIONS } from "./project";
import { date as fmtDate, num } from "./lib/text";
import { siteField, type SiteData, type SiteFieldKey } from "./site";

// ---------- происхождение значения (задание, раздел 5) ----------

export type Origin = "source" | "estimate" | "expert" | "reference";

export const ORIGIN_LABEL: Record<Origin, string> = {
  source: "из источника",
  estimate: "оценка по аналогам",
  expert: "Экспертное значение",
  reference: "по справочнику",
};

/** Основание значения: документ проекта, общий источник или «введено вручную». */
export interface ValueBasis {
  title: string;
  url?: string | null;
  /** Документ проекта, из которого взято значение. */
  documentId?: string | null;
  /** Дата документа или ввода, ГГГГ-ММ-ДД. */
  date?: string | null;
  /** Пояснение: как получено значение. */
  note?: string | null;
  /** Экспертное значение: кто задал. */
  author?: string | null;
  /** Экспертное значение: диапазон min–max в единицах хранения значения (строки, как value). */
  min?: string | null;
  max?: string | null;
}

// ---------- основание Экспертного значения ----------

/** Поля формы «без документа»: на чём основано, ссылка, кто задал, диапазон (как вводит финансист). */
export interface ExpertForm {
  title: string;
  url: string;
  author: string;
  min: string;
  max: string;
}

/**
 * Начальные поля формы из текущего основания. show переводит хранимое число в вид ввода (проценты — в %),
 * чтобы диапазон открывался в тех же единицах, что и значение.
 */
export function expertForm(b: ValueBasis | null | undefined, show: (stored: string) => string = (x) => x): ExpertForm {
  const own = b && !b.documentId ? b : null;
  return {
    title: own?.title ?? "",
    url: b?.url ?? "",
    author: own?.author ?? "",
    min: own?.min ? show(own.min) : "",
    max: own?.max ? show(own.max) : "",
  };
}

/**
 * Основание Экспертного значения из формы: обязательны «на чём основано» и «кто задал»; у числа — ещё диапазон
 * от–до, в который попадает само значение (правило: автор, обоснование и диапазон min–max).
 * parse переводит ввод в хранимое число (как у самого значения) или возвращает текст ошибки.
 */
export function expertBasis(
  form: ExpertForm,
  today: string,
  numeric?: { value: string | null; parse: (text: string) => { value?: string | undefined; error?: string | undefined }; show: (stored: string) => string },
): { basis: ValueBasis } | { error: string } {
  if (!form.title.trim()) return { error: "Укажите основание: документ проекта или на чём основано значение." };
  if (!form.author.trim()) return { error: "Укажите, кто задал значение: для Экспертного значения нужен автор." };
  const basis: ValueBasis = { title: form.title.trim(), url: form.url.trim() || null, date: today, author: form.author.trim() };
  if (!numeric) return { basis };
  if (!form.min.trim() || !form.max.trim()) return { error: "Укажите диапазон «от» и «до»: в каких пределах может быть Экспертное значение. Он нужен для расчёта чувствительности." };
  const lo = numeric.parse(form.min);
  if (lo.value === undefined) return { error: `Диапазон «от»: ${lo.error ?? "не число"}` };
  const hi = numeric.parse(form.max);
  if (hi.value === undefined) return { error: `Диапазон «до»: ${hi.error ?? "не число"}` };
  if (new Decimal(lo.value).gt(hi.value)) return { error: `Диапазон: «от» ${numeric.show(lo.value)} больше, чем «до» ${numeric.show(hi.value)}. Поменяйте границы местами.` };
  const v = numeric.value;
  if (v !== null && (new Decimal(v).lt(lo.value) || new Decimal(v).gt(hi.value))) {
    return { error: `Значение ${numeric.show(v)} вне диапазона ${numeric.show(lo.value)}–${numeric.show(hi.value)}: проверьте значение или диапазон.` };
  }
  return { basis: { ...basis, min: lo.value, max: hi.value } };
}

/** Проверка диапазона числового поля участка без документа: разбор как у значения, показ с единицей. */
export function plotExpertNumeric(key: PlotFieldKey, value: string | null) {
  const unit = PLOT_FIELDS.find((f) => f.key === key)?.unit;
  const show = (x: string) => `${plotText(key, x)}${unit ? ` ${unit}` : ""}`;
  return { value, parse: (t: string) => { const v = parseNumberRu(t); return v === null ? { error: `«${t}» — не число` } : { value: v }; }, show };
}

/** Подпись под значением: пояснение и диапазон Экспертного значения («Диапазон 20–24 эт.»). Нечего сказать — null. */
export function basisNote(b: ValueBasis | null | undefined, show: (stored: string) => string = (x) => x): string | null {
  if (!b) return null;
  const parts: string[] = [];
  if (b.note) parts.push(b.note);
  if (b.min && b.max) parts.push(`Диапазон ${show(b.min)}–${show(b.max)}`);
  return parts.length ? parts.join(". ") : null;
}

export interface PlotValue {
  /** Строка: деньги хранятся строкой рублей (decimal.js), площадь — строкой м². null — нет значения («не учтено»). */
  value: string | null;
  origin: Origin | null;
  basis: ValueBasis | null;
}

// ---------- поля участка ----------

export type PlotFieldKey = "cadastralNumber" | "quarter" | "address" | "regionCode" | "area" | "category" | "vri" | "cadastralValue" | "tenure";

export interface PlotField {
  key: PlotFieldKey;
  label: string;
  /** Единица для показа. */
  unit?: string;
  /** Параметр справочника, в который значение попадает в расчёт. */
  param?: ParameterId;
  kind: "text" | "area" | "money" | "enum" | "region";
  options?: readonly string[];
  /** Без значения показатель отмечается «не хватает значения» и входит в счётчик «Не хватает N значений». */
  required: boolean;
}

const tenureOptions = getParameter("LAND.TENURE").options ?? [];

export const PLOT_FIELDS: readonly PlotField[] = [
  { key: "cadastralNumber", label: "Кадастровый номер", param: "GEN.CADASTRAL_NUMBER", kind: "text", required: false },
  { key: "quarter", label: "Кадастровый квартал", kind: "text", required: false },
  { key: "address", label: "Адрес", kind: "text", required: false },
  { key: "regionCode", label: "Регион", param: "GEN.REGION_CODE", kind: "region", required: true },
  { key: "area", label: "Площадь участка", unit: "м²", param: "LAND.AREA", kind: "area", required: true },
  { key: "category", label: "Категория земель", kind: "text", required: false },
  { key: "vri", label: "Вид разрешённого использования", param: "LAND.VRI_CODES", kind: "text", required: true },
  { key: "cadastralValue", label: "Кадастровая стоимость", unit: "руб", param: "LAND.CADASTRAL_VALUE", kind: "money", required: true },
  { key: "tenure", label: "Форма права", param: "LAND.TENURE", kind: "enum", options: tenureOptions, required: true },
];

const fieldByKey = new Map(PLOT_FIELDS.map((f) => [f.key, f]));
export const plotField = (key: PlotFieldKey): PlotField => fieldByKey.get(key) as PlotField;

export const historyLabel = (field: HistoryField): string =>
  field === "assumptionsVersion" ? "Версия справочника" : fieldByKey.has(field as PlotFieldKey) ? plotField(field as PlotFieldKey).label : siteField(field as SiteFieldKey).label;

export type Plot = Record<PlotFieldKey, PlotValue>;

const EMPTY: PlotValue = { value: null, origin: null, basis: null };

export function emptyPlot(): Plot {
  return Object.fromEntries(PLOT_FIELDS.map((f) => [f.key, EMPTY])) as Plot;
}

// ---------- документы проекта ----------

export type DocumentKind = "egrn" | "gpzu" | "ppt" | "deal" | "tep" | "estimate" | "bank" | "excel" | "other";

/** Документы проекта (задание, раздел 6): что каждый подтверждает. */
export const DOCUMENT_KINDS: readonly { kind: DocumentKind; title: string; confirms: string }[] = [
  { kind: "egrn", title: "Выписка ЕГРН", confirms: "Кадастровый номер, адрес, площадь, категория земель, ВРИ, кадастровая стоимость, право" },
  { kind: "gpzu", title: "ГПЗУ", confirms: "Предельные параметры застройки, процент застройки" },
  { kind: "ppt", title: "ППТ", confirms: "Параметры застройки, если участок в проекте планировки" },
  { kind: "deal", title: "Предложение или договор по участку", confirms: "Цена и дата сделки" },
  { kind: "tep", title: "ТЭП архитектора", confirms: "Площади, если есть концепция" },
  { kind: "estimate", title: "Смета или расчёт по НЦС", confirms: "Стоимость строительства" },
  { kind: "bank", title: "Условия банка", confirms: "Ставки, комиссии, собственные средства" },
  { kind: "excel", title: "Готовая финмодель в Excel", confirms: "Сверка с расчётом сервиса" },
];

export const OTHER_DOCUMENT_TITLE = "Другой документ";

export interface ProjectDocument {
  id: string;
  kind: DocumentKind;
  fileName: string;
  size: number;
  /** Дата и время загрузки, ISO. */
  uploadedAt: string;
}

export function documentTitle(kind: DocumentKind): string {
  return DOCUMENT_KINDS.find((d) => d.kind === kind)?.title ?? OTHER_DOCUMENT_TITLE;
}

// ---------- проект ----------

/** Строка истории: поле участка, ограничение участка или переход проекта на другую версию справочника. */
export type HistoryField = PlotFieldKey | SiteFieldKey | "assumptionsVersion";

export interface HistoryEntry {
  /** Дата и время, ISO. */
  at: string;
  field: HistoryField;
  from: string;
  to: string;
  basis: string;
}

export interface GeoPoint {
  lat: number;
  lon: number;
}

export interface LandProject {
  id: string;
  name: string | null;
  createdAt: string;
  updatedAt: string;
  archived: boolean;
  /** Версия справочника допущений компании, на которой посчитан проект. */
  assumptionsVersion: number;
  /**
   * Версия справочника, пришедшая с проектом из файла, если в этом браузере такой версии нет или она другая.
   * Проект считается на ней, пока финансист не перейдёт на версию этого браузера кнопкой «Обновить».
   */
  assumptionsSnapshot?: SpecAssumptionVersion;
  plot: Plot;
  /** Точка на карте, если участок указан точкой. */
  point: GeoPoint | null;
  documents: ProjectDocument[];
  history: HistoryEntry[];
  /** Анализ участка: ограничения, аналоги, свои варианты; нет — ещё не заполнялся. */
  site?: SiteData;
}

// ---------- кадастровый номер и регион ----------

const KN = /^(\d{2}):(\d{2}):(\d{6,7}):(\d+)$/;

/** Кадастровый номер без пробелов; null — строка не похожа на номер участка. */
export function normalizeCadastralNumber(text: string): string | null {
  const s = text.replace(/\s+/g, "");
  return KN.test(s) ? s : null;
}

/** Кадастровый квартал — первые три части номера: 77:05:0004012:1873 → 77:05:0004012. */
export function cadastralQuarter(kn: string): string | null {
  const m = KN.exec(kn);
  return m ? `${m[1]}:${m[2]}:${m[3]}` : null;
}

export interface ProjectRegion {
  code: RegionCode;
  name: string;
  districts: string[];
  note: string | null;
}

/** Регионы, доступные для новых проектов (data/regions.yaml, поле lookup). */
export const PROJECT_REGIONS: readonly ProjectRegion[] = spec.regions
  .filter((r) => r.lookup)
  .map((r) => ({ code: r.code, name: r.name, districts: r.lookup?.cadastral_districts ?? [], note: r.lookup?.note ?? null }))
  .sort((a, b) => a.name.localeCompare(b.name, "ru"));

export function regionName(code: string | null): string {
  if (!code) return "—";
  return PROJECT_REGIONS.find((r) => r.code === code)?.name ?? spec.regions.find((r) => r.code === code)?.name ?? code;
}

/** Регион по номеру кадастрового округа. */
export function regionByCadastral(kn: string): ProjectRegion | null {
  const district = kn.split(":")[0];
  return PROJECT_REGIONS.find((r) => r.districts.includes(district ?? "")) ?? null;
}

const words = (s: string) => ` ${s.toLowerCase().replace(/ё/g, "е").replace(/[^a-zа-я0-9]+/g, " ").trim()} `;

/** Регион по адресу: название региона целыми словами. Нашлось несколько или ни одного — null. */
export function regionByAddress(address: string): ProjectRegion | null {
  const a = words(address);
  const found = spec.regions.filter((r) => PROJECT_REGIONS.some((p) => p.code === r.code) && r.lookup?.address_names.some((n) => a.includes(words(n))));
  return found.length === 1 ? (PROJECT_REGIONS.find((p) => p.code === found[0]?.code) ?? null) : null;
}

const listRegions = () => PROJECT_REGIONS.map((r) => `${r.name} (${r.districts.join(", ")})`).join(", ");

// ---------- числа ввода и показа ----------

/** Число из ввода по-русски: «32 000,5» → «32000.5»; не число — null. */
export function parseNumberRu(text: string): string | null {
  const s = text.replace(/[\s\u00a0\u202f]/g, "").replace(",", ".");
  return /^\d+(\.\d+)?$/.test(s) ? s : null;
}

const SQM_IN_HA = 10_000;

/** Площадь в гектарах для показа: 32000 → «3,20 га». */
export function areaHa(m2: string | null): string {
  if (m2 === null) return "—";
  const f = new Intl.NumberFormat("ru-RU", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${f.format(new Decimal(m2).div(SQM_IN_HA).toNumber())} га`;
}

/** Значение поля для показа, без единицы. */
export function plotText(key: PlotFieldKey, value: string | null): string {
  if (value === null) return "";
  const f = plotField(key);
  if (f.kind === "area") return num(new Decimal(value), 2);
  if (f.kind === "money") {
    const d = new Decimal(value);
    return d.isInteger() ? num(d, 0) : new Intl.NumberFormat("ru-RU", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(d.toNumber());
  }
  if (f.kind === "region") return regionName(value);
  return value;
}

/** Значение с единицей для «было → стало» и истории; нет значения — «не учтено». */
export function plotDisplay(key: PlotFieldKey, value: string | null): string {
  if (value === null) return "не учтено";
  const f = plotField(key);
  return f.unit ? `${plotText(key, value)} ${f.unit}` : plotText(key, value);
}

/** Строка основания для показа: «Выписка ЕГРН от 28.09.2026». */
export function basisText(b: ValueBasis | null): string {
  if (!b) return "";
  const who = b.author ? `, задал(а) ${b.author}` : "";
  if (!b.date || b.title.includes(fmtDate(b.date))) return `${b.title}${who}`;
  return b.documentId ? `${b.title} от ${fmtDate(b.date)}` : `${b.title}, ${fmtDate(b.date)}${who}`;
}

// ---------- статус проекта ----------

/** Обязательные поля участка без значения. */
export function missingFields(p: LandProject): PlotFieldKey[] {
  return PLOT_FIELDS.filter((f) => f.required && p.plot[f.key].value === null).map((f) => f.key);
}

export interface ProjectStatus {
  /** «Участок без кадастрового номера» (дополнение к заданию, 28.09.2026). */
  noCadastralNumber: boolean;
  missing: number;
}

export function projectStatus(p: LandProject): ProjectStatus {
  return { noCadastralNumber: p.plot.cadastralNumber.value === null, missing: missingFields(p).length };
}

/** Название проекта для списка: своё, иначе адрес, иначе кадастровый номер. */
export function projectTitle(p: LandProject): string {
  return p.name ?? p.plot.address.value ?? p.plot.cadastralNumber.value ?? "Участок без названия";
}

/** Подпись под названием: «Москва · 77:05:0004012:1873 · 3,20 га». */
export function projectSubtitle(p: LandProject): string {
  const parts = [regionName(p.plot.regionCode.value)];
  if (p.plot.cadastralNumber.value) parts.push(p.plot.cadastralNumber.value);
  if (p.plot.area.value) parts.push(areaHa(p.plot.area.value));
  return parts.join(" · ");
}

// ---------- данные выписки ЕГРН ----------

/** Поля, распознанные в выписке ЕГРН (пакет @fm/egrn-import). */
export interface EgrnPlot {
  cadastralNumber?: string;
  quarter?: string;
  address?: string;
  /** Код региона, если он указан в выписке отдельно (электронная выписка XML). */
  regionCode?: string;
  /** Площадь, м², строка. */
  area?: string;
  category?: string;
  vri?: string;
  /** Кадастровая стоимость, руб, строка. */
  cadastralValue?: string;
  /** Вид права и обременения, как в выписке. */
  rights?: string[];
  /** Дата выписки, ГГГГ-ММ-ДД. */
  extractDate?: string;
}

/** Форма права по видам прав и обременений в выписке: аренда — если участок в аренде, иначе собственность. */
export function tenureFromRights(rights: readonly string[]): string | null {
  const r = rights.map((x) => x.toLowerCase());
  if (r.some((x) => x.includes("аренда"))) return tenureOptions.find((o) => o === "аренда") ?? null;
  if (r.some((x) => x.includes("собственност"))) return tenureOptions.find((o) => o === "собственность") ?? null;
  return null;
}

/** Коды ВРИ по классификатору из текста выписки: «Многоэтажная жилая застройка (2.6)» → ["2.6"]. */
export function vriCodes(text: string | null): string[] {
  if (!text) return [];
  return [...new Set(text.match(/\b\d{1,2}\.\d{1,2}(?:\.\d{1,2})?\b/g) ?? [])];
}

// ---------- изменения «было → стало» ----------

export interface PlotChange {
  field: PlotFieldKey;
  from: PlotValue;
  to: PlotValue;
}

export interface ChangeRow {
  field: PlotFieldKey;
  label: string;
  from: string;
  to: string;
}

/** Строки «было → стало»; если значение то же, а сменился источник — видно, откуда было и откуда стало. */
export function changeRows(changes: readonly PlotChange[]): ChangeRow[] {
  return changes.map((c) => {
    const from = plotDisplay(c.field, c.from.value);
    const to = plotDisplay(c.field, c.to.value);
    const origin = (v: PlotValue) => (v.origin ? `, ${ORIGIN_LABEL[v.origin]}` : "");
    return c.from.value === c.to.value
      ? { field: c.field, label: plotField(c.field).label, from: `${from}${origin(c.from)}`, to: `${to}${origin(c.to)}` }
      : { field: c.field, label: plotField(c.field).label, from, to };
  });
}

const sameValue = (a: PlotValue, b: PlotValue) =>
  a.value === b.value && a.origin === b.origin && basisText(a.basis) === basisText(b.basis) && (a.basis?.documentId ?? null) === (b.basis?.documentId ?? null);

function change(p: LandProject, field: PlotFieldKey, to: PlotValue): PlotChange[] {
  return sameValue(p.plot[field], to) ? [] : [{ field, from: p.plot[field], to }];
}

export interface ChangeSet {
  changes: PlotChange[];
  /** Что не так → числа → что сделать (задание, раздел 7). */
  problems: string[];
}

export interface DocumentRef {
  id: string;
  /** Дата документа, ГГГГ-ММ-ДД. */
  date: string | null;
}

/**
 * Изменения участка по выписке ЕГРН: данные выписки заменяют введённые вручную значения и оценки. Если номер в
 * выписке не совпадает с номером проекта — изменений нет, только сообщение.
 */
export function egrnChanges(p: LandProject, egrn: EgrnPlot, doc: DocumentRef): ChangeSet {
  const own = p.plot.cadastralNumber.value;
  if (own && egrn.cadastralNumber && egrn.cadastralNumber !== own) {
    return {
      changes: [],
      problems: [`Номер в выписке ${egrn.cadastralNumber} не совпадает с номером проекта ${own}. Загрузите выписку по этому участку или исправьте номер.`],
    };
  }
  const basis: ValueBasis = { title: "Выписка ЕГРН", documentId: doc.id, date: doc.date ?? egrn.extractDate ?? null };
  const src = (value: string | undefined | null, note?: string): PlotValue | null =>
    value === undefined || value === null || value === "" ? null : { value, origin: "source", basis: note ? { ...basis, note } : basis };
  const out: PlotChange[] = [];
  const problems: string[] = [];
  const put = (field: PlotFieldKey, v: PlotValue | null) => {
    if (v) out.push(...change(p, field, v));
  };

  put("cadastralNumber", src(egrn.cadastralNumber));
  put("quarter", src(egrn.quarter ?? (egrn.cadastralNumber ? cadastralQuarter(egrn.cadastralNumber) : null)));
  put("address", src(egrn.address));

  const byCode = egrn.regionCode ? PROJECT_REGIONS.find((r) => r.code === egrn.regionCode) : undefined;
  const byAddress = egrn.address ? regionByAddress(egrn.address) : null;
  const region = byCode ?? byAddress;
  if (region) put("regionCode", src(region.code, byCode ? "Регион указан в выписке" : "Регион определён по адресу в выписке"));
  else if (egrn.regionCode || egrn.address) {
    problems.push(`Регион по выписке не определился: участок не в Москве и не в Московской области или адрес записан иначе («${egrn.address ?? egrn.regionCode}»). Проверьте выписку или выберите регион вручную.`);
  }

  put("area", src(egrn.area));
  put("category", src(egrn.category));
  put("vri", src(egrn.vri));
  put("cadastralValue", src(egrn.cadastralValue));
  const tenure = egrn.rights?.length ? tenureFromRights(egrn.rights) : null;
  put("tenure", src(tenure, egrn.rights?.length ? `По выписке: ${egrn.rights.join("; ")}` : undefined));
  return { changes: out, problems };
}

/** Ручное изменение поля: с документом проекта — «из источника», без документа — «Экспертное значение». */
export function manualChange(p: LandProject, field: PlotFieldKey, value: string | null, basis: ValueBasis): PlotChange[] {
  return change(p, field, { value, origin: value === null ? null : basis.documentId ? "source" : "expert", basis: value === null ? null : basis });
}

/**
 * Кадастровый номер введён позже (дополнение к заданию, 28.09.2026): номер, квартал и регион по номеру. Данные ЕГРН
 * заменят оценки после загрузки выписки.
 */
export function cadastralNumberChanges(p: LandProject, text: string, basis: ValueBasis): ChangeSet {
  const kn = normalizeCadastralNumber(text);
  if (!kn) return { changes: [], problems: [knFormatProblem(text)] };
  const region = regionByCadastral(kn);
  if (!region) return { changes: [], problems: [regionUnavailable(kn)] };
  const v = (value: string, note?: string): PlotValue => ({ value, origin: "expert", basis: note ? { ...basis, note } : basis });
  const out = [...change(p, "cadastralNumber", v(kn)), ...change(p, "quarter", v(cadastralQuarter(kn) as string, "По кадастровому номеру"))];
  const problems: string[] = [];
  const current = p.plot.regionCode;
  if (current.value !== region.code) {
    if (current.origin === "source" && current.basis?.documentId) {
      problems.push(`Номер из кадастрового округа ${kn.split(":")[0]} (${region.name}), а в документе проекта регион — ${regionName(current.value)}. Проверьте номер.`);
    } else {
      out.push(...change(p, "regionCode", v(region.code, region.note ?? "По кадастровому номеру")));
    }
  }
  return { changes: out, problems };
}

/** Добавить изменения к несохранённым: по одному полю остаётся исходное «было» и последнее «стало». */
export function mergeChanges(pending: readonly PlotChange[], next: readonly PlotChange[]): PlotChange[] {
  const out = [...pending];
  for (const c of next) {
    const i = out.findIndex((x) => x.field === c.field);
    if (i < 0) out.push(c);
    else out[i] = { field: c.field, from: (out[i] as PlotChange).from, to: c.to };
  }
  return out.filter((c) => !sameValue(c.from, c.to));
}

/** Применить изменения: новые значения, запись в историю, дата обновления. */
export function applyChanges(p: LandProject, changes: readonly PlotChange[], at: string): LandProject {
  if (!changes.length) return p;
  const plot = { ...p.plot };
  const history = [...p.history];
  const rows = changeRows(changes);
  changes.forEach((c, i) => {
    plot[c.field] = c.to;
    history.push({ at, field: c.field, from: rows[i]?.from ?? "", to: rows[i]?.to ?? "", basis: basisText(c.to.basis) || "Значение удалено" });
  });
  return { ...p, plot, history, updatedAt: at };
}

// ---------- новый проект ----------

export interface NewProjectForm {
  cadastralNumber: string;
  name: string;
  /** Площадь, м², как введена. */
  area: string;
  address: string;
  point: GeoPoint | null;
  /** Регион, выбранный вручную. */
  regionCode: string;
  /** Выписка ЕГРН, если загружена. */
  egrn: { data: EgrnPlot; document: ProjectDocument } | null;
  /** Прочие документы (готовая финмодель в Excel). */
  documents: ProjectDocument[];
}

export type NewProjectField = "cadastralNumber" | "area" | "location" | "regionCode" | "egrn";

export interface NewProjectResult {
  project: LandProject | null;
  errors: { field: NewProjectField; text: string }[];
}

function knFormatProblem(text: string): string {
  return `Кадастровый номер «${text.trim()}» не похож на номер участка. Формат: 77:05:0004012:1873 (округ, район, квартал, номер участка).`;
}

function regionUnavailable(kn: string): string {
  return `Номер из кадастрового округа ${kn.split(":")[0]} — этот регион пока недоступен. Доступны: ${listRegions()}.`;
}

/** Регион нового проекта: по выписке, по номеру, по адресу или выбранный вручную. */
export function suggestedRegion(form: Pick<NewProjectForm, "cadastralNumber" | "address" | "egrn">): { region: ProjectRegion; how: string } | null {
  const e = form.egrn?.data;
  const fromEgrn = (e?.regionCode ? PROJECT_REGIONS.find((r) => r.code === e.regionCode) : undefined) ?? (e?.address ? regionByAddress(e.address) : null);
  if (fromEgrn) return { region: fromEgrn, how: "по выписке ЕГРН" };
  const kn = normalizeCadastralNumber(form.cadastralNumber);
  const byKn = kn ? regionByCadastral(kn) : null;
  if (byKn) return { region: byKn, how: "по кадастровому номеру" };
  const byAddress = form.address.trim() ? regionByAddress(form.address) : null;
  if (byAddress) return { region: byAddress, how: "по адресу" };
  return null;
}

/** Проверить форму «Новый проект» и создать проект. */
/** assumptionsVersion — текущая версия справочника этого браузера (по умолчанию — последняя из спецификации). */
export function createProject(form: NewProjectForm, id: string, at: string, assumptionsVersion = SPEC_ASSUMPTIONS.at(-1)?.version ?? 1): NewProjectResult {
  const errors: NewProjectResult["errors"] = [];
  const knText = form.cadastralNumber.trim();
  const kn = knText ? normalizeCadastralNumber(knText) : null;
  if (knText && !kn) errors.push({ field: "cadastralNumber", text: knFormatProblem(knText) });
  if (kn && !regionByCadastral(kn)) errors.push({ field: "cadastralNumber", text: regionUnavailable(kn) });
  const egrn = form.egrn?.data;
  if (kn && egrn?.cadastralNumber && egrn.cadastralNumber !== kn) {
    errors.push({ field: "egrn", text: `Номер в выписке ${egrn.cadastralNumber} не совпадает с введённым ${kn}. Загрузите выписку по этому участку или исправьте номер.` });
  }
  const anyKn = kn ?? egrn?.cadastralNumber ?? null;

  const areaText = form.area.trim();
  const area = areaText ? parseNumberRu(areaText) : null;
  const range = getParameter("LAND.AREA").range;
  if (areaText && area === null) errors.push({ field: "area", text: `Площадь «${areaText}» — не число. Введите площадь в м², например 32 000.` });
  if (area !== null && range && (Number(area) < range[0] || Number(area) > range[1])) {
    errors.push({ field: "area", text: `Площадь ${num(Number(area))} м² вне допустимого диапазона ${num(range[0])}–${num(range[1])} м². Проверьте единицы: площадь вводится в м².` });
  }
  if (!anyKn) {
    if (!areaText && !egrn?.area) errors.push({ field: "area", text: "Без кадастрового номера нужна площадь участка в м²." });
    if (!form.address.trim() && !form.point) errors.push({ field: "location", text: "Без кадастрового номера укажите адрес участка или точку на карте." });
  }

  const suggested = suggestedRegion(form);
  const chosen = form.regionCode ? PROJECT_REGIONS.find((r) => r.code === form.regionCode) : undefined;
  if (!suggested && !chosen) errors.push({ field: "regionCode", text: "Выберите регион: по введённым данным он не определился." });
  if (errors.length) return { project: null, errors };

  const manual: ValueBasis = { title: "Введено при создании проекта", date: at.slice(0, 10) };
  const expert = (value: string, note?: string): PlotValue => ({ value, origin: "expert", basis: note ? { ...manual, note } : manual });
  const plot = emptyPlot();
  if (kn) {
    plot.cadastralNumber = expert(kn);
    plot.quarter = expert(cadastralQuarter(kn) as string, "По кадастровому номеру");
  }
  if (form.address.trim()) plot.address = expert(form.address.trim());
  if (area !== null) plot.area = expert(area);
  const region = chosen ?? suggested?.region;
  if (region) {
    plot.regionCode = chosen
      ? expert(region.code, "Выбран вручную")
      : expert(region.code, suggested?.how === "по кадастровому номеру" ? (region.note ?? "По кадастровому номеру") : `Определён ${suggested?.how}`);
  }
  const documents = [...form.documents];
  const base: LandProject = {
    id,
    name: form.name.trim() || null,
    createdAt: at,
    updatedAt: at,
    archived: false,
    assumptionsVersion,
    plot,
    point: form.point,
    documents,
    history: [],
  };
  if (!form.egrn) return { project: base, errors: [] };
  const withDoc = { ...base, documents: [form.egrn.document, ...documents] };
  const set = egrnChanges(withDoc, form.egrn.data, { id: form.egrn.document.id, date: form.egrn.data.extractDate ?? null });
  const project = { ...withDoc, plot: Object.fromEntries(PLOT_FIELDS.map((f) => [f.key, set.changes.find((c) => c.field === f.key)?.to ?? withDoc.plot[f.key]])) as Plot };
  // Регион, выбранный вручную, главнее определённого по адресу выписки.
  if (chosen) project.plot.regionCode = expert(chosen.code, "Выбран вручную");
  return { project, errors: [] };
}

// ---------- действия со списком проектов ----------

export function copyProject(p: LandProject, id: string, at: string): LandProject {
  return { ...structuredClone(p), id, name: `${projectTitle(p)} (копия)`, createdAt: at, updatedAt: at, archived: false };
}
