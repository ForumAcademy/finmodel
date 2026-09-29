import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { zipSync, strToU8 } from "fflate";
import { parseEgrnText, parseEgrnXml, readEgrnFile } from "../src";

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url));
const noPdf = async () => {
  throw new Error("PDF не ожидался");
};

describe("электронная выписка ЕГРН (XML)", () => {
  const r = parseEgrnXml(fixture("extract_land.xml").toString("utf-8"));

  it("поля участка", () => {
    expect(r.data).toEqual({
      cadastralNumber: "77:05:0004012:1873",
      quarter: "77:05:0004012",
      address: "г. Москва, Каширское шоссе, вл. 64 (условный адрес)",
      regionCode: "77",
      area: "32000",
      category: "Земли населенных пунктов",
      vri: "Многоэтажная жилая застройка (высотная застройка) (2.6)",
      cadastralValue: "2900000000",
      rights: ["Собственность", "Аренда (в том числе, субаренда)"],
      extractDate: "2026-09-28",
    });
    expect(r.problems).toEqual([]);
  });

  it("ZIP-архив Росреестра: внутри XML и подпись", async () => {
    const zip = zipSync({ "report.xml": fixture("extract_land.xml"), "report.xml.sig": strToU8("подпись") });
    const z = await readEgrnFile("vypiska.zip", zip, noPdf);
    expect(z.data.cadastralNumber).toBe("77:05:0004012:1873");
  });

  it("windows-1251", async () => {
    const xml = '<?xml version="1.0" encoding="windows-1251"?><extract_base_params_land><land_record><object><common_data><cad_number>50:22:0010205:311</cad_number></common_data></object><params><area><value>14500</value></area><category><type><value>Земли населенных пунктов</value></type></category></params></land_record></extract_base_params_land>';
    const bytes = Uint8Array.from(Buffer.from(new TextDecoder("utf-8").decode(new TextEncoder().encode(xml)), "utf-8"));
    // перекодируем в windows-1251 вручную: только кириллица базового диапазона
    const cp = Uint8Array.from([...xml].map((ch) => {
      const c = ch.charCodeAt(0);
      return c >= 0x410 && c <= 0x44f ? c - 0x350 : c;
    }));
    expect(bytes.length).toBeGreaterThan(cp.length);
    const r1251 = await readEgrnFile("v.xml", cp, noPdf);
    expect(r1251.data.category).toBe("Земли населенных пунктов");
    expect(r1251.problems).toEqual(["В выписке не нашлись: регион, вид разрешённого использования, кадастровая стоимость, форма права. Введите их вручную со ссылкой на документ."]);
  });

  it("кадастровая выписка старого формата (атрибуты)", () => {
    const old = parseEgrnXml('<KVZU><Parcels><Parcel CadastralNumber="77:01:0001001:10" CadastralBlock="77:01:0001001"><Area><Area>1200</Area></Area><Location><Address><Note>Москва, ул. Примерная, 1</Note></Address></Location><Utilization ByDoc="для жилищного строительства"/><CadastralCost Value="150000000"/></Parcel></Parcels></KVZU>');
    expect(old.data).toMatchObject({ cadastralNumber: "77:01:0001001:10", quarter: "77:01:0001001", area: "1200", cadastralValue: "150000000", vri: "для жилищного строительства", address: "Москва, ул. Примерная, 1" });
  });
});

describe("выписка ЕГРН в PDF (текст)", () => {
  it("поля по подписям граф", () => {
    const r = parseEgrnText(fixture("extract_land_pdf.txt").toString("utf-8"));
    expect(r.data).toEqual({
      cadastralNumber: "50:22:0010205:311",
      quarter: "50:22:0010205",
      address: "Московская область, г.о. Люберцы, г. Люберцы, ул. Примерная, з/у 5 (условный адрес)",
      area: "14500",
      category: "Земли населенных пунктов",
      vri: "Многоэтажная жилая застройка (высотная застройка)",
      cadastralValue: "812345678.90",
      rights: ["Собственность"],
      extractDate: "2026-09-28",
    });
    expect(r.problems).toEqual([]);
  });

  it("PDF передаётся на извлечение текста", async () => {
    const r = await readEgrnFile("v.pdf", new TextEncoder().encode("%PDF-1.7 ..."), async () => fixture("extract_land_pdf.txt").toString("utf-8"));
    expect(r.data.area).toBe("14500");
  });

  it("не выписка — понятное сообщение", async () => {
    const r = await readEgrnFile("photo.jpg", Uint8Array.from([0xff, 0xd8, 0xff]), noPdf);
    expect(r.problems[0]).toMatch(/не похож на выписку ЕГРН/);
    const empty = parseEgrnText("Договор аренды");
    expect(empty.problems[0]).toMatch(/не нашлись данные участка/);
  });
});
