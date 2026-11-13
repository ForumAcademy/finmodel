import { describe, expect, it } from "vitest";
import { passportView } from "../src/passport";
import { createProject, type LandProject } from "../src/plot";

function project(): LandProject {
  const result = createProject(
    {
      cadastralNumber: "",
      name: "Проверка паспорта",
      area: "3410",
      address: "Москва, Лялин переулок, 21",
      point: null,
      regionCode: "77",
      egrn: null,
      documents: [],
    },
    "passport-test",
    "2026-11-13T00:00:00Z",
  );
  if (!result.project) throw new Error("Не создан проект");
  return result.project;
}

describe("паспорт участка: данные и юридическая подтверждённость", () => {
  it("адрес и площадь не подтверждают участок и возможность жилья", () => {
    const p = project();
    const v = passportView(p);
    expect(v.steps[0]?.state).toBe("Нужно найти участок");
    expect(v.steps[1]?.state).toBe("Не подтверждено");
    expect(v.facts.find((f) => f.key === "vri")?.value).toBe("Нет сведений");
    expect(v.areaConflict).toBeNull();
  });

  it("ВРИ 4.1 требует проверки жилья, но не объявляется окончательным запретом", () => {
    const p = project();
    p.plot.vri = {
      value: "Деловое управление (4.1)",
      origin: "source",
      basis: { title: "НСПД · скриншот пользователя" },
    };
    const v = passportView(p);
    expect(v.title).toBe("Возможность жилой застройки не подтверждена");
    expect(v.explanation).toContain("без изменения ВРИ");
    expect(v.facts.find((f) => f.key === "vri")?.entry.basis?.title).toContain(
      "скриншот",
    );
  });

  it("сохраняет оба основания расхождения 3110 и 3410 м² и не меняет проект", () => {
    const p = project();
    p.plot.area = {
      value: "3110",
      origin: "source",
      basis: { title: "Карточка НСПД" },
    };
    const before = JSON.stringify(p);
    const v = passportView(p, {
      areaComparison: {
        value: "3410",
        basis: { title: "Исходный Excel пользователя" },
      },
    });
    expect(v.areaConflict?.difference).toBe("300");
    expect(v.areaConflict?.currentEntry.basis?.title).toBe("Карточка НСПД");
    expect(v.areaConflict?.otherBasis.title).toBe(
      "Исходный Excel пользователя",
    );
    expect(JSON.stringify(p)).toBe(before);
    expect(
      passportView(p, {
        areaComparison: {
          value: "3110.0",
          basis: { title: "Другой источник" },
        },
      }).areaConflict,
    ).toBeNull();
  });

  it("введённые ограничения и жилой ВРИ не приравниваются к проверенному разрешению", () => {
    const p = project();
    p.plot.vri = {
      value: "2.6",
      origin: "expert",
      basis: { title: "Введено пользователем" },
    };
    p.site = {
      values: {
        maxFloors: { value: "8", origin: "expert", basis: { title: "Оценка" } },
        builtShare: {
          value: "0.4",
          origin: "expert",
          basis: { title: "Оценка" },
        },
      },
      analogs: [],
      zouit: [],
      customVariants: [],
      selectedVariant: null,
      snapshot: null,
      curve: null,
    };
    const v = passportView(p);
    expect(v.steps[2]?.state).toBe("Параметры введены");
    expect(v.steps[1]?.state).toBe("Не подтверждено");
  });
});
