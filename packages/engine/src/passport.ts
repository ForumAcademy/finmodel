/** Представление паспорта: наличие данных не означает юридическую проверку участка. */
import Decimal from "decimal.js";
import {
  PLOT_FIELDS,
  plotText,
  vriCodes,
  type LandProject,
  type PlotFieldKey,
  type PlotValue,
  type ValueBasis,
} from "./plot";
import { siteOf } from "./site";
import { num } from "./lib/text";

export interface PassportContext {
  areaComparison?: { value: string; basis: ValueBasis };
  boundaryNote?: string;
  rightsNote?: string;
  sources?: {
    title: string;
    url: string;
    date: string;
    status: string;
    note: string;
  }[];
}

export function passportView(p: LandProject, context: PassportContext = {}) {
  const businessUse = vriCodes(p.plot.vri.value).includes("4.1");
  const facts = (
    [
      "area",
      "vri",
      "cadastralNumber",
      "category",
      "cadastralValue",
      "tenure",
    ] as PlotFieldKey[]
  ).map((key) => {
    const field = PLOT_FIELDS.find((f) => f.key === key)!;
    const entry = p.plot[key];
    return {
      key,
      label: field.label,
      value: entry.value === null ? "Нет сведений" : plotText(key, entry.value),
      unit: entry.value === null ? undefined : field.unit,
      entry,
    };
  });
  const current = p.plot.area;
  const other = context.areaComparison;
  let areaConflict: {
    current: string;
    other: string;
    difference: string;
    currentEntry: PlotValue;
    otherBasis: ValueBasis;
  } | null = null;
  if (current.value !== null && other && current.value !== other.value) {
    try {
      const diff = new Decimal(current.value).sub(other.value).abs();
      if (!diff.isZero())
        areaConflict = {
          current: num(new Decimal(current.value)),
          other: num(new Decimal(other.value)),
          difference: num(diff),
          currentEntry: current,
          otherBasis: other.basis,
        };
    } catch {
      /* Нечисловые сведения не превращаются в расчёт. */
    }
  }
  const s = siteOf(p);
  const hasLimits =
    !!s.values.maxFloors?.value &&
    ["maxGfa", "density", "builtShare"].some(
      (k) => !!s.values[k as keyof typeof s.values]?.value,
    );
  return {
    facts,
    areaConflict,
    title: businessUse
      ? "Возможность жилой застройки не подтверждена"
      : "Сначала проверим, что можно построить",
    explanation: businessUse
      ? "В сведениях об участке указано деловое управление. Нужно установить, допускается ли жильё по действующему градостроительному регламенту без изменения ВРИ."
      : "Адрес и площадь — начало оценки. Для обоснованного выбора нужны действующие ограничения участка и данные рынка.",
    steps: [
      {
        title: "Установить участок",
        state: p.plot.cadastralNumber.value
          ? "Номер указан"
          : "Нужно найти участок",
        detail:
          "Сверить адрес, кадастровый номер и границы. Точка на карте не заменяет контур земли.",
        target: "plot",
      },
      {
        title: "Проверить возможность жилья",
        state: "Не подтверждено",
        detail:
          "Проверить действующий ВРИ, ПЗЗ и ограничения. Проект изменений не подтверждает действующие права.",
        target: "site",
      },
      {
        title: "Определить допустимый объём",
        state: hasLimits ? "Параметры введены" : "Нет предельных параметров",
        detail:
          "Нужны высота или этажность, ограничения площади и проверка размещения застройки.",
        target: "site",
      },
      {
        title: "Оценить рынок и экономику",
        state: s.analogs.length ? "Аналоги добавлены" : "Нужны данные рынка",
        detail:
          "Проверить сопоставимость цен, темпы продаж, состав затрат и условия финансирования.",
        target: "market",
      },
    ],
  };
}
