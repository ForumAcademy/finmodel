/**
 * Инвестиционное предложение по участку в PDF (презентация продавца или брокера). Свободная вёрстка, поэтому поиск
 * по ключевым словам: номер, адрес, площадь, ВРИ, право, цена, плотность, мощность по техусловиям.
 * pdf.js разбивает слова и числа на куски («1 5 тыс.», «79 5 00 м2», «В Н»), поэтому числа ищутся в тексте без пробелов.
 */
import { offer as offerMod, type plot } from "@fm/engine";

type OfferParsed = offerMod.OfferParsed;
type OfferData = offerMod.OfferData;

const KN = /\d{2}:\d{2}:\d{6,7}:\d+/;
const NUM = "(\\d+(?:[.,]\\d+)?)";
/** Степени десяти: гектар = 10⁴ м², млрд = 10⁹ и т. д. Умножение — сдвигом запятой, без округлений. */
const HA_POW = 4;
const MULT_POW: Record<string, number> = { млрд: 9, млн: 6, тыс: 3 };

/** «5.3» × 10⁴ → «53000». */
function shift(s: string, pow: number): string {
  const [int = "", frac = ""] = s.split(".");
  const digits = int + frac.padEnd(pow, "0");
  const point = int.length + pow;
  const whole = digits.slice(0, point).replace(/^0+(?=\d)/, "") || "0";
  const rest = digits.slice(point).replace(/0+$/, "");
  return rest ? `${whole}.${rest}` : whole;
}

const toNum = (s: string | undefined) => (s ? s.replace(",", ".") : undefined);
const clean = (s: string | undefined) => {
  const t = s?.replace(/\s+/g, " ").replace(/[\s;,.–-]+$/, "").trim();
  return t ? t : undefined;
};

/** Признак предложения: в выписке ЕГРН таких слов нет. */
export function looksLikeOffer(text: string): boolean {
  const t = text.replace(/\s+/g, "").toLowerCase();
  return t.includes("инвестиционноепредложение") || /цена(?:земельного)?участка/.test(t) || /схемасделки/.test(t);
}

/** Текст строки после подписи: «расположение участка» → следующая непустая строка или остаток этой. */
function after(lines: string[], label: RegExp): string | undefined {
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string;
    const m = label.exec(line);
    if (!m) continue;
    const rest = clean(line.slice(m.index + m[0].length).replace(/^\s*[:–-]\s*/, ""));
    if (rest) return rest;
    const next = lines.slice(i + 1).find((l) => l.trim());
    return clean(next);
  }
  return undefined;
}

export function parseOfferText(pdfText: string): OfferParsed {
  const lines = pdfText.replace(/ё/g, "е").split(/\n/);
  const flat = lines.join(" ").replace(/\s+/g, " ");
  // Без пробелов: «1 5 тыс.» → «15тыс.», «79 5 00 м2» → «79500м2», «Т а р и ф В Н» → «ТарифВН».
  const compact = flat.replace(/\s+/g, "");

  const cadastralNumber = KN.exec(compact)?.[0];
  const address = after(lines, /(?:расположение|местоположение)\s+участка|^\s*адрес\b/i);

  const areaM = new RegExp(`площадь(?:земельного)?участка:?${NUM}(га|м2|кв\\.?м)`, "i").exec(compact);
  const area = areaM ? (areaM[2]?.toLowerCase() === "га" ? shift(toNum(areaM[1]) as string, HA_POW) : toNum(areaM[1])) : undefined;

  const vriCode = /(?:кодВРИ|видразрешенногоиспользования)[:–-]*(\d{1,2}\.\d{1,2}(?:\.\d{1,2})?)/i.exec(compact)?.[1];
  const vriText = /«([^»]{5,300})»/.exec(flat)?.[1]?.replace(/(\S) - (\S)/g, "$1-$2");
  const vri = vriCode ? (vriText ? `${clean(vriText)} (${vriCode})` : vriCode) : undefined;

  const leaseYear = /аренд[аы]?(?:на)?(?:срок)?до(?:\d{2}\.\d{2}\.)?(\d{4})/i.exec(compact)?.[1];
  const ownership = /всобственности|собственностьназемлю|правособственности/i.test(compact);
  const rights = leaseYear || /земельныеотношения:?аренда/i.test(compact) ? [`Аренда${leaseYear ? ` до ${leaseYear} года` : ""}`] : ownership ? ["Собственность"] : [];

  const priceM = new RegExp(`цена(?:земельного)?участка:?${NUM}(млрд|млн|тыс)?\\.?(?:руб|₽)`, "i").exec(compact);
  const priceRub = priceM ? shift(toNum(priceM[1]) as string, MULT_POW[priceM[2]?.toLowerCase() ?? ""] ?? 0) : undefined;
  const priceVat: OfferData["priceVat"] = /безНДС/i.test(compact) ? "без НДС" : /(?:сНДС|вт\.?ч\.?НДС|включаяНДС)/i.test(compact) ? "с НДС" : undefined;

  const offer: { [K in keyof OfferData]: OfferData[K] | undefined } = {
    gridPowerMw: toNum(new RegExp(`(?:ТУ|техническ\\S{0,4}услови\\S{0,3})(?:на)?:?${NUM}МВт`, "i").exec(compact)?.[1]),
    potentialPowerMw: toNum(new RegExp(`потенциальн\\S{0,3}мощност\\S{0,2}\\D{0,30}?${NUM}МВт`, "i").exec(compact)?.[1]),
    voltage: /тариф:?(ВН|СН-?(?:I{1,2}|1|2)|НН)/i.exec(compact)?.[1]?.toUpperCase(),
    densityThM2Ha: toNum(new RegExp(`плотност\\S{0,2}застройки[:–-]*${NUM}тыс\\.?кв\\.?м\\.?/га`, "i").exec(compact)?.[1]),
    ppmAreaM2: toNum(new RegExp(`ППМ(?:на)?:?${NUM}(?:м2|кв\\.?м)`, "i").exec(compact)?.[1]),
    priceRub,
    priceVat: priceRub ? priceVat : undefined,
    dealScheme: after(lines, /схема\s+сделки/i),
    leaseUntilYear: leaseYear,
  };
  const plotData: { [K in keyof plot.EgrnPlot]: plot.EgrnPlot[K] | undefined } = { cadastralNumber, address, area, vri, rights };
  const datacenter = /ЦОД|центр\S*\s+обработки\s+данных|дата-центр/i.test(flat);
  return {
    plot: Object.fromEntries(Object.entries(plotData).filter(([, v]) => v !== undefined && !(Array.isArray(v) && !v.length))) as plot.EgrnPlot,
    offer: Object.fromEntries(Object.entries(offer).filter(([, v]) => v !== undefined)) as OfferData,
    purposeHint: datacenter ? "datacenter" : null,
  };
}
