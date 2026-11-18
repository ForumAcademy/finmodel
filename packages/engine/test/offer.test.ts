import { describe, expect, it } from "vitest";
import { offer, plot, site } from "../src";

const AT = "2026-11-18T10:00:00.000Z";
const PARSED: offer.OfferParsed = {
  plot: { cadastralNumber: "77:07:0012004:4155", address: "Москва, ул. Рябиновая, 28а", area: "53000", vri: "размещение объектов связи (6.8)", rights: ["Аренда до 2073 года"] },
  offer: { gridPowerMw: "39", potentialPowerMw: "50", voltage: "ВН", densityThM2Ha: "15", ppmAreaM2: "79500", priceRub: "5000000000", priceVat: "без НДС", dealScheme: "покупка юридического лица", leaseUntilYear: "2073" },
  purposeHint: "datacenter",
};
const form = (over: Partial<plot.NewProjectForm> = {}): plot.NewProjectForm => ({ cadastralNumber: "", name: "", area: "", address: "", point: null, regionCode: "", egrn: null, documents: [], ...over });
const doc: plot.ProjectDocument = { id: "d1", kind: "offer", fileName: "offer.pdf", size: 1, uploadedAt: AT };

describe("назначение проекта", () => {
  it("старые проекты без поля — жилые; ЦОД — коммерческое", () => {
    const r = plot.createProject(form({ cadastralNumber: "77:07:0012004:4155" }), "p0", AT);
    expect(r.project?.purpose).toBeUndefined();
    expect(plot.purposeOf(r.project as plot.LandProject)).toBe("residential");
    expect(plot.purposeTitle("datacenter")).toBe("Коммерческое · ЦОД");
    expect(plot.purposeUse("datacenter")).toBe("commercial");
  });
});

describe("инвестиционное предложение в новом проекте", () => {
  const created = plot.createProject(form({ purpose: "datacenter", offerPlot: PARSED.plot, documents: [doc] }), "p1", AT);

  it("номер, адрес и площадь из предложения заменяют ввод при проверке формы", () => {
    expect(created.errors).toEqual([]);
    expect(created.project?.purpose).toBe("datacenter");
    expect(plot.suggestedRegion(form({ offerPlot: PARSED.plot }))?.how).toBe("по инвестиционному предложению");
  });

  it("поля участка, цена и плотность — из документа", () => {
    const { project, problems } = offer.applyOffer(created.project as plot.LandProject, PARSED, "d1", AT);
    expect(problems).toEqual([]);
    expect(project.plot.cadastralNumber).toMatchObject({ value: "77:07:0012004:4155", origin: "source", basis: { documentId: "d1", title: "Инвестиционное предложение" } });
    expect(project.plot.quarter.value).toBe("77:07:0012004");
    expect(project.plot.area.value).toBe("53000");
    expect(project.plot.tenure.value).toBe("аренда");
    expect(project.plot.regionCode.value).toBe("77");
    expect(site.siteValue(project, "landPrice")).toMatchObject({ value: "5000000000", origin: "source", basis: { note: "Цена без НДС; схема сделки: покупка юридического лица" } });
    expect(site.siteValue(project, "density").value).toBe("1.5");
    expect(project.offer).toEqual({ documentId: "d1", data: PARSED.offer });
    expect(plot.projectSubtitle(project)).toContain("Коммерческое · ЦОД");
  });

  it("строки для экрана", () => {
    const rows = offer.offerRows(PARSED.offer).map((r) => `${r.label}: ${r.value}`.replace(/\u00a0/g, " "));
    expect(rows).toContain("Мощность по техусловиям: 39 МВт");
    expect(rows).toContain("Цена участка: 5 000 000 000 руб, без НДС");
  });

  it("значения выписки ЕГРН не заменяются, расхождение — сообщение", () => {
    const egrnDoc: plot.ProjectDocument = { ...doc, id: "e1", kind: "egrn" };
    const withEgrn = plot.createProject(form({ egrn: { data: { cadastralNumber: "77:07:0012004:4155", regionCode: "77", area: "53053", rights: ["Аренда"] }, document: egrnDoc } }), "p2", AT).project as plot.LandProject;
    const { project, problems } = offer.applyOffer(withEgrn, PARSED, "d1", AT);
    expect(project.plot.area.value).toBe("53053");
    expect(problems.join(" ")).toContain("Площадь в предложении (53000) отличается от выписки ЕГРН (53053)");
  });

  it("предложение по другому участку не применяется", () => {
    const other = plot.createProject(form({ cadastralNumber: "77:05:0004012:1873" }), "p3", AT).project as plot.LandProject;
    const r = offer.applyOffer(other, PARSED, "d1", AT);
    expect(r.project).toBe(other);
    expect(r.problems[0]).toContain("не совпадает");
  });
});

describe("что нашлось — коротко", () => {
  it("аббревиатуры не уменьшаются, год аренды с подписью", () => {
    expect(offer.offerFound(PARSED)).toContain("площадь по ППМ");
    expect(offer.offerFound(PARSED)).toContain("ВРИ");
    expect(offer.offerText(PARSED.offer, "leaseUntilYear")).toBe("2073 года");
  });
});
