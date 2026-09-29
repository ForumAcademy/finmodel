/**
 * Распознавание выписки ЕГРН об участке: электронная выписка Росреестра (XML, в том числе в ZIP-архиве с подписью)
 * и выписка в PDF (текст страниц передаёт вызывающий код). Результат — поля участка для проекта; что не нашлось,
 * финансист вводит вручную со ссылкой на документ.
 */
import { unzipSync } from "fflate";
import { plot, text } from "@fm/engine";
import { attrAt, findAll, parseXml, textAt, type XmlNode } from "./xml";

export { parseXml } from "./xml";

type EgrnPlot = plot.EgrnPlot;

export interface EgrnResult {
  data: EgrnPlot;
  /** Какие поля участка нашлись. */
  found: plot.PlotFieldKey[];
  /** Что не так → что сделать. */
  problems: string[];
}

const KN = /\d{2}:\d{2}:\d{6,7}:\d+/;
const QUARTER = /\d{2}:\d{2}:\d{6,7}/;

/** Число из выписки: «32 000,00», «2900000000.00» → строка с точкой. */
function number(s: string | undefined): string | undefined {
  if (!s) return undefined;
  const m = /\d[\d\s\u00a0]*(?:[.,]\d+)?/.exec(s);
  if (!m) return undefined;
  const v = m[0].replace(/[\s\u00a0]/g, "").replace(",", ".");
  return Number(v) > 0 ? v.replace(/\.0+$/, "") : undefined;
}

/** «28.09.2026» или «2026-09-28» → «2026-09-28». */
function isoDate(s: string | undefined): string | undefined {
  if (!s) return undefined;
  const iso = /(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const ru = /(\d{2})\.(\d{2})\.(\d{4})/.exec(s);
  return ru ? `${ru[3]}-${ru[2]}-${ru[1]}` : undefined;
}

const clean = (s: string | undefined) => {
  const t = s?.replace(/\s+/g, " ").replace(/[\s;,.]+$/, "").trim();
  return t ? t : undefined;
};

function result(data: { [K in keyof EgrnPlot]?: EgrnPlot[K] | undefined }): EgrnResult {
  const d = Object.fromEntries(Object.entries(data).filter(([, v]) => v !== undefined && !(Array.isArray(v) && !v.length))) as EgrnPlot;
  const found: plot.PlotFieldKey[] = [];
  if (d.cadastralNumber) found.push("cadastralNumber");
  if (d.quarter ?? d.cadastralNumber) found.push("quarter");
  if (d.address) found.push("address");
  if (d.regionCode ?? d.address) found.push("regionCode");
  if (d.area) found.push("area");
  if (d.category) found.push("category");
  if (d.vri) found.push("vri");
  if (d.cadastralValue) found.push("cadastralValue");
  if (d.rights?.length) found.push("tenure");
  const problems: string[] = [];
  if (!d.cadastralNumber && !d.area) {
    problems.push(
      "В файле не нашлись данные участка: нет кадастрового номера и площади. Загрузите выписку ЕГРН об объекте недвижимости (XML из личного кабинета Росреестра, ZIP-архив с ним или PDF) или введите данные вручную.",
    );
  } else {
    const missed = plot.PLOT_FIELDS.filter((f) => f.required && !found.includes(f.key)).map((f) => f.label.toLowerCase());
    if (missed.length) problems.push(`В выписке не нашлись: ${missed.join(", ")}. Введите их вручную со ссылкой на документ.`);
  }
  return { data: d, found, problems };
}

// ---------- электронная выписка (XML) ----------

function rightsXml(doc: XmlNode): string[] {
  const rights = findAll(doc, "right_type/value").map((n) => clean(n.text));
  const restrictions = findAll(doc, "restriction_encumbrance_type/value").map((n) => clean(n.text));
  const old = findAll(doc, "Right/Name").map((n) => clean(n.text));
  return [...new Set([...rights, ...restrictions, ...old].filter((x): x is string => !!x))];
}

function vriXml(doc: XmlNode): string | undefined {
  const byDoc = textAt(doc, "permitted_use_established/by_document", "permitted_use/by_document") ?? attrAt(doc, "Utilization", "ByDoc");
  const classifier = findAll(doc, "permitted_use_established")
    .flatMap((n) => n.children.filter((c) => c.name.startsWith("land_use")))
    .map((n) => textAt(n, "value"))
    .filter((x): x is string => !!x && x !== byDoc);
  const parts = [byDoc, ...classifier].filter((x): x is string => !!x);
  return parts.length ? [...new Set(parts)].join("; ") : undefined;
}

/** Электронная выписка ЕГРН (XML Росреестра: об объекте недвижимости, об основных характеристиках, кадастровая выписка). */
export function parseEgrnXml(xml: string): EgrnResult {
  const doc = parseXml(xml);
  const knText = textAt(doc, "object/common_data/cad_number", "land_record/cad_number", "common_data/cad_number") ?? attrAt(doc, "Parcel", "CadastralNumber");
  const cadastralNumber = knText ? KN.exec(knText)?.[0] : undefined;
  const quarterText = textAt(doc, "object/common_data/quarter_cad_number", "quarter_cad_number") ?? attrAt(doc, "Parcel", "CadastralBlock");
  const regionText = textAt(doc, "address_location/address/address_fias/level_settlement/region/code", "address/region/code") ?? textAt(doc, "Location/Address/Region");
  return result({
    cadastralNumber,
    quarter: quarterText ? QUARTER.exec(quarterText)?.[0] : undefined,
    address: clean(textAt(doc, "address_location/address/readable_address", "address_location/address/note", "Location/Address/Note", "Location/Elaboration/ReferenceMark")),
    regionCode: regionText && /^\d{2}$/.test(regionText) ? regionText : undefined,
    area: number(textAt(doc, "params/area/value", "Parcel/Area/Area", "Area/Area")),
    category: clean(textAt(doc, "params/category/type/value", "category/type/value")),
    vri: clean(vriXml(doc)),
    cadastralValue: number(textAt(doc, "land_record/cost/value", "cost/value") ?? attrAt(doc, "CadastralCost", "Value")),
    rights: rightsXml(doc),
    extractDate: isoDate(textAt(doc, "details_statement/group_top_requisites/date_formation", "date_formation", "DateUpload") ?? attrAt(doc, "CertificationDoc", "Date")),
  });
}

// ---------- выписка в PDF (текст страниц) ----------

/** Подписи граф выписки ЕГРН: значение графы — текст до следующей подписи. */
const LABELS = [
  "Кадастровый номер",
  "Номер кадастрового квартала",
  "Дата присвоения кадастрового номера",
  "Ранее присвоенный государственный учетный номер",
  "Местоположение",
  "Адрес",
  "Площадь",
  "Кадастровая стоимость",
  "Кадастровые номера расположенных в пределах земельного участка объектов недвижимости",
  "Кадастровые номера объектов недвижимости",
  "Категория земель",
  "Виды разрешенного использования",
  "Вид разрешенного использования",
  "Сведения о кадастровом инженере",
  "Сведения о лесах",
  "Статус записи об объекте недвижимости",
  "Особые отметки",
  "Получатель выписки",
  "Правообладатель",
  "Вид, номер, дата и время государственной регистрации права",
  "Вид, номер и дата государственной регистрации права",
  "Ограничение прав и обременение объекта недвижимости",
  "Документы-основания",
  "Сведения о включении объекта недвижимости",
  "Условный номер земельного участка",
  "Сведения о том, что земельный участок",
  "Лист №",
  "Раздел",
  "Всего листов",
  "Всего разделов",
];

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const norm = (s: string) => s.replace(/ё/g, "е").replace(/Ё/g, "Е");

function graphs(textAll: string): Map<string, string[]> {
  const t = norm(textAll).replace(/\s+/g, " ");
  const hits: { at: number; end: number; label: string }[] = [];
  for (const label of LABELS) {
    const re = new RegExp(`${escapeRe(label)}(?:\\s*\\([^)]{0,20}\\))?(?:,\\s*(?:м2|кв\\.\\s?м|руб\\.?))?\\s*:?`, "g");
    for (const m of t.matchAll(re)) hits.push({ at: m.index, end: m.index + m[0].length, label });
  }
  hits.sort((a, b) => a.at - b.at || b.end - a.end);
  const out = new Map<string, string[]>();
  let last = -1;
  const kept = hits.filter((h) => (h.at >= last ? ((last = h.end), true) : false));
  kept.forEach((h, i) => {
    const next = kept[i + 1]?.at ?? t.length;
    const value = t.slice(h.end, next).trim();
    if (value) out.set(h.label, [...(out.get(h.label) ?? []), value]);
  });
  return out;
}

const RIGHT_WORDS = /(Общая долевая собственность|Общая совместная собственность|Собственность|Аренда(?: \(в том числе, субаренда\))?|Постоянное \(бессрочное\) пользование|Безвозмездное \(срочное\) пользование|Пожизненное наследуемое владение)/g;

/** Выписка ЕГРН в PDF: текст всех страниц. */
export function parseEgrnText(pdfText: string): EgrnResult {
  const g = graphs(pdfText);
  const first = (label: string) => g.get(label)?.[0];
  const cadastralNumber = first("Кадастровый номер")?.match(KN)?.[0];
  const rightsText = [...(g.get("Вид, номер, дата и время государственной регистрации права") ?? []), ...(g.get("Вид, номер и дата государственной регистрации права") ?? []), ...(g.get("Ограничение прав и обременение объекта недвижимости") ?? [])].join(" ");
  const vri = first("Виды разрешенного использования") ?? first("Вид разрешенного использования");
  const flat = norm(pdfText).replace(/\s+/g, " ");
  const date = (/(\d{2}\.\d{2}\.\d{4})\s*№\s*КУВИ/.exec(flat) ?? /(?:Дата формирования выписки|выписка сформирована)\s*:?\s*(\d{2}\.\d{2}\.\d{4})/i.exec(flat))?.[1];
  return result({
    cadastralNumber,
    quarter: first("Номер кадастрового квартала")?.match(QUARTER)?.[0],
    address: clean(first("Адрес") ?? first("Местоположение")),
    area: number(first("Площадь")),
    category: clean(first("Категория земель")),
    vri: clean(vri),
    cadastralValue: number(first("Кадастровая стоимость")),
    rights: [...new Set([...rightsText.matchAll(RIGHT_WORDS)].map((m) => m[1] as string))],
    extractDate: isoDate(date),
  });
}

// ---------- файл целиком ----------

/** Текст XML с учётом кодировки из заголовка (выписки бывают в windows-1251). */
function decodeXml(bytes: Uint8Array): string {
  const head = new TextDecoder("latin1").decode(bytes.slice(0, 200));
  const enc = /encoding=["']([\w-]+)["']/i.exec(head)?.[1]?.toLowerCase() ?? "utf-8";
  return new TextDecoder(enc === "windows-1251" || enc === "cp1251" ? "windows-1251" : "utf-8").decode(bytes);
}

const isZip = (b: Uint8Array) => b[0] === 0x50 && b[1] === 0x4b;
const isPdf = (b: Uint8Array) => new TextDecoder("latin1").decode(b.slice(0, 5)) === "%PDF-";
const isXml = (b: Uint8Array) => /^\s*(?:\ufeff)?\s*</.test(new TextDecoder("utf-8").decode(b.slice(0, 64)));

export const EGRN_ACCEPT = ".xml,.pdf,.zip";

/**
 * Прочитать файл выписки: XML, PDF или ZIP-архив Росреестра (внутри XML и подпись). Текст PDF достаёт вызывающий код
 * (в браузере — pdf.js), чтобы пакет не зависел от среды.
 */
export async function readEgrnFile(fileName: string, bytes: Uint8Array, pdfText: (bytes: Uint8Array) => Promise<string>): Promise<EgrnResult> {
  if (isZip(bytes)) {
    const files = unzipSync(bytes);
    const names = Object.keys(files).filter((n) => !n.endsWith("/"));
    const xml = names.find((n) => /\.xml$/i.test(n));
    const pdf = names.find((n) => /\.pdf$/i.test(n));
    const zip = names.find((n) => /\.zip$/i.test(n));
    if (xml) return parseEgrnXml(decodeXml(files[xml] as Uint8Array));
    if (pdf) return parseEgrnText(await pdfText(files[pdf] as Uint8Array));
    if (zip) return readEgrnFile(zip, files[zip] as Uint8Array, pdfText);
    return unreadable(fileName);
  }
  if (isPdf(bytes)) return parseEgrnText(await pdfText(bytes));
  if (isXml(bytes)) return parseEgrnXml(decodeXml(bytes));
  return unreadable(fileName);
}

function unreadable(fileName: string): EgrnResult {
  return {
    data: {},
    found: [],
    problems: [`Файл «${fileName}» не похож на выписку ЕГРН: ожидается XML, PDF или ZIP-архив Росреестра. Загрузите выписку в одном из этих форматов или введите данные вручную.`],
  };
}

/** Коротко, что нашлось: «Найдено 8 из 9 полей участка». */
export function foundSummary(r: EgrnResult): string {
  const n = r.found.length;
  return `Найдено ${n} ${text.plural(n, ["поле", "поля", "полей"])} участка из ${plot.PLOT_FIELDS.length}`;
}
