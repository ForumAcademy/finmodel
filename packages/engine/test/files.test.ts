import { describe, expect, it } from "vitest";
import { book, plot, projectFile, SPEC_ASSUMPTIONS } from "../src";

const AT = "2026-09-29T10:00:00.000Z";
const V1 = SPEC_ASSUMPTIONS[0] as book.AssumptionVersion;

const EGRN: plot.EgrnPlot = {
  cadastralNumber: "77:05:0004012:1873",
  address: "г. Москва, ул. Примерная, вл. 1",
  regionCode: "77",
  area: "32000",
  category: "Земли населенных пунктов",
  vri: "Многоэтажная жилая застройка (высотная застройка) (2.6)",
  cadastralValue: "2900000000.00",
  rights: ["Собственность"],
  extractDate: "2026-09-28",
};

function project(id = "p1", name = "Каширка"): plot.LandProject {
  const document: plot.ProjectDocument = { id: `${id}-doc`, kind: "egrn", fileName: "выписка.xml", size: 3, uploadedAt: AT };
  const r = plot.createProject(
    { cadastralNumber: "77:05:0004012:1873", name, area: "", address: "", point: null, regionCode: "", egrn: { data: EGRN, document }, documents: [] },
    id,
    AT,
    1,
  );
  return r.project as plot.LandProject;
}

/** Версия 2: маркетинг 4 % вместо 3,5 %. */
function v2(versions: book.AssumptionVersion[] = [V1], author = "Иванова"): book.AssumptionVersion {
  const items = V1.items.map((i) => (i.param === "OPEX.MARKETING_RATE" ? { ...i, value: 0.04 } : i));
  const r = book.newVersion(versions, items, author, "Маркетинг по бюджету 2027", AT);
  if (!r.version) throw new Error(r.errors.join("; "));
  return r.version;
}

describe("ввод стандартного значения", () => {
  it("проценты вводятся в %: 3,5 → 0,035 и обратно, без ошибок округления", () => {
    expect(book.toInput("доля", 0.035)).toBe("3,5");
    expect(book.toInput("%годовых", 0.0575)).toBe("5,75");
    expect(book.fromInput("доля", "3,5")).toEqual({ value: 0.035 });
    expect(book.fromInput("%годовых", "5,75")).toEqual({ value: 0.0575 });
    expect(book.fromInput("мес", "3")).toEqual({ value: 3 });
    expect(book.inputUnit("%годовых")).toBe("% годовых");
  });

  it("пусто — стандарта нет; не число и вне диапазона — сообщение с тем, что сделать", () => {
    expect(book.fromInput("доля", "")).toEqual({ value: null });
    expect(book.fromInput("доля", "три").error).toMatch(/не число.*в %/);
    expect(book.fromInput("доля", "150", [0, 1]).error).toBe("150 % вне допустимого: от 0 до 100 %");
    expect(book.fromInput("мес", "2,5").error).toBe("Число месяцев — целое");
  });
});

describe("новая версия справочника", () => {
  it("полный список значений, номер следующий, дата — день сохранения; изменения видны строками", () => {
    const v = v2();
    expect(v.version).toBe(2);
    expect(v.date).toBe("2026-09-29");
    expect(v.items).toHaveLength(V1.items.length);
    const changes = book.itemChanges(V1.items, v.items);
    expect(changes).toEqual([{ param: "OPEX.MARKETING_RATE", name: expect.any(String), what: "Значение", from: "3,5 %", to: "4 %" }]);
    expect(book.suggestedNote(changes)).toMatch(/^Изменено: /);
  });

  it("без автора, описания, изменений или с пустым «Откуда» — не сохраняется", () => {
    expect(book.newVersion([V1], V1.items, "", "", AT).errors).toEqual([
      "Укажите, кто сохраняет версию",
      "Опишите, что изменилось",
      "Значения не изменились — новая версия не нужна",
    ]);
    const items = V1.items.map((i) => (i.param === "OPEX.MARKETING_RATE" ? { ...i, value: 0.04, from: { text: " ", url: null } } : i));
    expect(book.newVersion([V1], items, "Иванова", "x", AT).errors[0]).toMatch(/Заполните «Откуда»/);
    const check = V1.items.map((i) => (i.param === "OPEX.MARKETING_RATE" ? { ...i, status: "check" as const } : i));
    expect(book.newVersion([V1], check, "Иванова", "x", AT).errors[0]).toMatch(/что проверить/);
  });

  it("справочник браузера: сохранённые версии, а новые версии спецификации добавляются в конец", () => {
    expect(book.withSpecVersions(null)).toEqual(SPEC_ASSUMPTIONS);
    const mine = [V1, v2()];
    expect(book.withSpecVersions(mine)).toEqual(mine);
  });
});

describe("файл справочника", () => {
  it("сохраняется и читается; чужой или повреждённый файл — понятная ошибка", () => {
    const f = book.referenceFile([V1, v2()], AT);
    const back = book.readReferenceFile(JSON.parse(JSON.stringify(f)));
    expect(back.ok && back.value.map((v) => v.version)).toEqual([1, 2]);
    expect(book.readReferenceFile({ format: "x" })).toEqual({ ok: false, error: expect.stringMatching(/не файл справочника/) });
    const broken = { ...f, versions: [{ ...V1, version: 2 }] };
    expect(book.readReferenceFile(broken)).toEqual({ ok: false, error: expect.stringMatching(/повреждён/) });
    expect(book.referenceFileName([V1, v2()], AT)).toBe("Справочник, версия 2 — 29.09.2026.json");
  });

  it("план загрузки: совпадает, новее, старее, разошлись", () => {
    const a = v2([V1], "Иванова");
    const b = v2([V1], "Петров");
    expect(book.referencePlan([V1], [V1]).kind).toBe("same");
    expect(book.referencePlan([V1], [V1, a])).toEqual({ kind: "newer", added: [2] });
    expect(book.referencePlan([V1, a], [V1])).toEqual({ kind: "older", local: 2, file: 1 });
    expect(book.referencePlan([V1, a], [V1, b])).toEqual({ kind: "diverged", from: 2, local: 2, file: 2 });
  });

  it("при замене разошедшихся версий проекты на них сохраняют свою версию до «Обновить»", () => {
    const a = v2([V1], "Иванова");
    const b = v2([V1], "Петров");
    const p1 = { ...project("p1"), assumptionsVersion: 1 };
    const p2 = { ...project("p2", "Люберцы"), assumptionsVersion: 2 };
    const r = book.applyReference([V1, a], [V1, b], [p1, p2], AT);
    expect(r.versions).toEqual([V1, b]);
    expect(r.projects.map((p) => [p.id, p.assumptionsSnapshot?.author])).toEqual([["p2", "Иванова"]]);
    expect(book.planText(book.referencePlan([V1, a], [V1, b]), [p1, p2])).toMatch(/Проекты на этих версиях \(1\)/);
  });
});

describe("версия справочника у проекта", () => {
  it("есть новая версия — «Обновить» переводит проект и пишет переход в историю", () => {
    const local = [V1, v2()];
    const p = project();
    expect(p.assumptionsVersion).toBe(1);
    const ref = book.projectReference(p, local);
    expect(ref).toMatchObject({ version: 1, fromFile: false, updateTo: 2, text: "Справочник: версия 1 от 27.09.2026" });
    const up = book.updateReference(p, local, AT);
    expect(up.assumptionsVersion).toBe(2);
    expect(up.history.at(-1)).toMatchObject({ field: "assumptionsVersion", from: "версия 1 от 27.09.2026", to: "версия 2 от 29.09.2026" });
    expect(plot.historyLabel("assumptionsVersion")).toBe("Версия справочника");
    expect(book.projectReference(up, local).updateTo).toBeNull();
  });

  it("новый проект получает текущую версию справочника браузера", () => {
    const r = plot.createProject({ cadastralNumber: "77:05:0004012:1873", name: "", area: "", address: "", point: null, regionCode: "", egrn: null, documents: [] }, "n", AT, 2);
    expect(r.project?.assumptionsVersion).toBe(2);
  });
});

describe("файл проекта", () => {
  const entry = (id: string): projectFile.FileEntry => ({ id, name: "выписка.xml", type: "text/xml", size: 3, sha256: "abc", data: "PHg+" });
  let n = 0;
  const newId = () => `new-${++n}`;

  it("один файл: проект, документы, история и версия справочника; открывается обратно", () => {
    const p = project();
    const f = projectFile.buildProjectFile(p, [V1], [entry("p1-doc")], AT);
    expect(f.format).toBe("finmodel-project");
    expect(f.reference?.version).toBe(1);
    expect(projectFile.projectFileName(p, AT)).toBe("Каширка — проект от 29.09.2026.json");
    const back = projectFile.readProjectFile(JSON.parse(JSON.stringify(f)));
    expect(back.ok && back.file.project.plot.area.value).toBe("32000");
  });

  it("чужой, новый или повреждённый файл — понятная ошибка", () => {
    expect(projectFile.readProjectFile({ format: "finmodel-reference" })).toEqual({ ok: false, error: expect.stringMatching(/не файл проекта/) });
    expect(projectFile.readProjectFile({ format: "finmodel-project", formatVersion: 99 })).toEqual({ ok: false, error: expect.stringMatching(/более новой версией/) });
    expect(projectFile.readProjectFile({ format: "finmodel-project", formatVersion: 1, project: {} })).toEqual({ ok: false, error: expect.stringMatching(/повреждён/) });
  });

  it("открытие: новые id документов и ссылки полей на них; конфликт по названию", () => {
    const p = project();
    const f = projectFile.buildProjectFile(p, [V1], [entry("p1-doc")], AT);
    expect(projectFile.findConflict(f, [project("other", " каширка ")])?.id).toBe("other");
    expect(projectFile.findConflict(f, [project("other", "Люберцы")])).toBeNull();

    const opened = projectFile.openProject(f, "new", [V1], null, newId, AT);
    const docId = opened.project.documents[0]?.id;
    expect(docId).toMatch(/^new-/);
    expect(opened.files[0]?.id).toBe(docId);
    expect(opened.project.plot.area.basis?.documentId).toBe(docId);
    expect(opened.project.id).toBe("p1");
    expect(opened.referenceNote).toBeNull();
  });

  it("заменить — id и дата создания проекта браузера; копия — новый id и «(копия)»", () => {
    const f = projectFile.buildProjectFile(project(), [V1], [entry("p1-doc")], AT);
    const mine = { ...project("mine"), createdAt: "2026-01-01T00:00:00.000Z" };
    const rep = projectFile.openProject(f, "replace", [V1], mine, newId, AT).project;
    expect([rep.id, rep.createdAt, rep.name]).toEqual(["mine", "2026-01-01T00:00:00.000Z", "Каширка"]);
    const copy = projectFile.openProject(f, "copy", [V1], mine, newId, AT).project;
    expect(copy.id).toMatch(/^new-/);
    expect(copy.name).toBe("Каширка (копия)");
  });

  it("версии справочника нет или она другая — проект хранит свою версию и пояснение", () => {
    const p = { ...project(), assumptionsVersion: 2 };
    const theirs = v2([V1], "Петров");
    const f = projectFile.buildProjectFile(p, [V1, theirs], [], AT);
    const none = projectFile.openProject(f, "new", [V1], null, newId, AT);
    expect(none.project.assumptionsSnapshot?.author).toBe("Петров");
    expect(none.referenceNote).toMatch(/нет в этом браузере/);
    const other = projectFile.openProject(f, "new", [V1, v2([V1], "Иванова")], null, newId, AT);
    expect(other.referenceNote).toMatch(/отличается/);
    expect(book.projectReference(other.project, [V1]).text).toMatch(/из файла проекта/);
    expect(book.projectVersions(other.project, [V1])).toEqual([theirs]);
    // Сохранение снова в файл берёт версию из файла проекта
    expect(projectFile.buildProjectFile(other.project, [V1], [], AT).reference).toEqual(theirs);
  });

  it("при замене удаляются только файлы, которые не нужны другим проектам", () => {
    const old = project("old");
    const copy = plot.copyProject(old, "copy", AT);
    expect(projectFile.orphanFileIds(old, [old, copy])).toEqual([]);
    expect(projectFile.orphanFileIds(old, [old])).toEqual(["old-doc"]);
  });
});
