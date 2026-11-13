/** Демонстрационный кейс из пользовательских материалов. Не данные по умолчанию для проектов. */
import { passport, plot } from "@fm/engine";

export function lyalinPassportExample() {
  const created = plot.createProject(
    {
      cadastralNumber: "77:01:0001028:2999",
      name: "Лялин переулок, 21/2",
      area: "3110",
      address: "Москва, переулок Лялин, з/у 21/2",
      regionCode: "77",
      point: null,
      egrn: null,
      documents: [],
    },
    "example-lyalin",
    "2026-11-13T00:00:00Z",
  );
  if (!created.project)
    throw new Error("Не удалось подготовить пример паспорта");
  const p = created.project;
  const basis: plot.ValueBasis = {
    title: "НСПД · скриншот пользователя",
    url: "https://nspd.gov.ru/",
    date: "2026-11-13",
    note: "Прочитано со скриншота. Дата обновления в карточке — 03.09.2026; прямой запрос к реестру не выполнен.",
  };
  const values: Partial<Record<plot.PlotFieldKey, string>> = {
    cadastralNumber: "77:01:0001028:2999",
    address: "Москва, переулок Лялин, з/у 21/2",
    area: "3110",
    category: "Земли населенных пунктов",
    vri: "Деловое управление (4.1)",
    cadastralValue: "326576186.20",
  };
  for (const [key, value] of Object.entries(values))
    p.plot[key as plot.PlotFieldKey] = { value, origin: "source", basis };
  const context: passport.PassportContext = {
    areaComparison: {
      value: "3410",
      basis: {
        title: "Исходный Excel пользователя",
        note: "Площадь из черновой финмодели. Причина отличия от карточки НСПД не установлена.",
      },
    },
    boundaryNote:
      "На скриншоте карты выделен участок сложной формы с существующей застройкой. Координаты границы, состояние зданий и возможность сноса не установлены.",
    rightsNote:
      "В карточке НСПД видны записи об аренде. Они не подтверждают число отдельных договоров, арендатора, размер платежей или условия строительства. Форма права для расчёта не задана.",
    sources: [
      {
        title: "НСПД: карточка участка и карта",
        url: "https://nspd.gov.ru/",
        date: "2026-11-13",
        status: "Скриншоты пользователя",
        note: "Кадастровый номер, адрес, площадь, ВРИ и стоимость. Официальная выписка ЕГРН не получена.",
      },
      {
        title: "Изменения ПЗЗ по адресу Лялин, 21, стр. 2",
        url: "https://www.mos.ru/dgp/documents/view/22393221/",
        date: "2026-02-04",
        status: "Проект постановления",
        note: "PDF найден на mos.ru. Проект не подтверждает вступление изменений в силу или разрешённость жилья.",
      },
      {
        title: "Подготовка изменений ПЗЗ по территории",
        url: "https://www.mos.ru/dgp/documents/view/335656220/",
        date: "2025-12-22",
        status: "Распоряжение о подготовке",
        note: "Поручение подготовить изменения. Это не утверждённый градостроительный регламент.",
      },
    ],
  };
  return { project: p, context };
}
