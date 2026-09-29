/** Разделы экрана «Справочник». */
export const SECTIONS = [
  { id: "values", title: "Стандартные значения" },
  { id: "regions", title: "Нормативы регионов" },
  { id: "formulas", title: "Формулы" },
  { id: "sources", title: "Источники" },
  { id: "history", title: "История версий" },
] as const;
export type SectionId = (typeof SECTIONS)[number]["id"];
