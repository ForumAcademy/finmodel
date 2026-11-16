/**
 * Экран «Итог» и карточка проекта: что нужно ввести, когда проект посчитан, что изменилось в сервисе после расчёта.
 * Здесь нет арифметики расчёта: только сбор того, что уже есть в проекте и в итогах анализа.
 */
import type { LandProject } from "./plot";
import { PLOT_FIELDS, missingFields } from "./plot";
import { minAnalogs, siteField, siteOf, siteValue, type AnalysisSnapshot, type SiteFieldKey } from "./site";
import { date, plural } from "./lib/text";
import { snapshotText } from "./explain/site-view";

// ---------- что нужно ввести ----------

/** Раздел проекта, где вводится значение. */
export type TodoSection = "plot" | "site" | "market";

export interface TodoItem {
  key: string;
  label: string;
  /** Что не посчитается без значения; пусто — значение обязательно для участка. */
  why: string | null;
  /** «Где взять данные». */
  where: string;
  sec: TodoSection;
  tab: string | null;
}

/** Ограничения, без которых не строятся варианты, и данные сделки, без которых нет итогов (обязательные поля экранов анализа). */
const REQUIRED_SITE: readonly { key: SiteFieldKey; tab: string; why: string }[] = [
  { key: "maxFloors", tab: "Градрегламент", why: "Без неё не строятся варианты." },
  { key: "landPrice", tab: "Сделка", why: "Без неё затраты на покупку участка не учтены." },
];

/** Все значения, которых не хватает, со всех экранов проекта — одним списком. */
export function todoList(p: LandProject): TodoItem[] {
  const plotItems = missingFields(p).map((k): TodoItem => {
    const f = PLOT_FIELDS.find((x) => x.key === k) as (typeof PLOT_FIELDS)[number];
    return { key: `plot.${k}`, label: f.label, why: null, where: f.where, sec: "plot", tab: "Участок" };
  });
  const siteItems = REQUIRED_SITE.filter((r) => siteValue(p, r.key).value === null).map((r): TodoItem => {
    const f = siteField(r.key);
    return { key: `site.${r.key}`, label: f.label, why: r.why, where: f.hint, sec: "site", tab: r.tab };
  });
  const need = minAnalogs();
  const have = siteOf(p).analogs.length;
  const market: TodoItem[] =
    have < need
      ? [
          {
            key: "market.analogs",
            label: "Аналоги на рынке",
            why: `Нужно не меньше ${need} ${plural(need, ["аналога", "аналогов", "аналогов"])}, сейчас ${have}. Без них нет цены и темпа продаж.`,
            where: "Объявления о продаже квартир в ЖК рядом с участком, сайты застройщиков, наш.дом.рф",
            sec: "market",
            tab: null,
          },
        ]
      : [];
  return [...plotItems, ...siteItems, ...market];
}

// ---------- обновления сервиса ----------

export interface ServiceUpdate {
  /** Дата выхода, ГГГГ-ММ-ДД. */
  date: string;
  text: string;
}

/** Что менялось в сервисе — для финансиста, новые сверху. Дополняется в каждом PR, который меняет расчёт или экраны. */
export const SERVICE_UPDATES: readonly ServiceUpdate[] = [
  { date: "2026-11-16", text: "Проект открывается на экране «Итог»: кнопка «Пересчитать», лучший вариант и общий список того, что нужно ввести. Все проекты можно сохранить в один файл и открыть его на другом компьютере или новом адресе сайта." },
  { date: "2026-11-16", text: "Плата за изменение вида разрешённого использования участка в Москве считается сама по постановлению 593-ПП: ставка по плотности застройки умножается на разницу кадастровых стоимостей." },
  { date: "2026-11-13", text: "У полей, которые вводятся вручную, есть подсказка «Где взять данные», в справочнике — раздел с тем же названием." },
  { date: "2026-11-13", text: "В справочнике пометка «нужно значение» осталась только у значений, без которых расчёт не идёт." },
];

/** Обновления сервиса после даты расчёта проекта (дата расчёта — ISO с временем или без). Нет расчёта — пусто. */
export function updatesSince(at: string | null, updates: readonly ServiceUpdate[] = SERVICE_UPDATES): ServiceUpdate[] {
  if (!at) return [];
  const day = at.slice(0, 10);
  return updates.filter((u) => u.date > day);
}

/** Дата последнего обновления сервиса. */
export const lastUpdate = (updates: readonly ServiceUpdate[] = SERVICE_UPDATES): string | null => updates.reduce<string | null>((m, u) => (m === null || u.date > m ? u.date : m), null);

// ---------- карточка проекта ----------

export interface CardStatus {
  /** Строка итога: лучший вариант и цифры; null — не посчитан. */
  result: string | null;
  /** Почему итога нет или он устарел; null — всё в порядке. */
  reason: string | null;
  /** «Данные изменены 29.09.2026». */
  changed: string;
  /** «Посчитан 16.11.2026»; null — итога нет. */
  calculated: string | null;
}

export function cardStatus(p: LandProject, updates: readonly ServiceUpdate[] = SERVICE_UPDATES): CardStatus {
  const snap: AnalysisSnapshot | null = siteOf(p).snapshot;
  const todo = todoList(p).length;
  const need = todo ? `нужно ввести ${todo} ${plural(todo, ["значение", "значения", "значений"])}` : null;
  const stale = snap ? updatesSince(snap.at, updates).length > 0 : false;
  const result = snap?.bestTitle ? snapshotText(snap) : null;
  let reason: string | null = null;
  if (!result) reason = `Не посчитан${need ? `: ${need}` : snap ? ": лучший вариант не выбран" : ": откройте проект"}`;
  else if (stale) reason = "Сервис обновился после расчёта: откройте проект, чтобы пересчитать";
  else if (need) reason = `Для точного расчёта ${need}`;
  return {
    result,
    reason,
    changed: `Данные изменены ${date(p.updatedAt.slice(0, 10))}`,
    calculated: result && snap ? `Посчитан ${date(snap.at.slice(0, 10))}` : null,
  };
}

/** «Посчитано 16.11.2026 в 10:15» — время расчёта на экране «Итог» (время — местное время браузера). */
export function calculatedText(at: Date): string {
  const hh = String(at.getHours()).padStart(2, "0");
  const mm = String(at.getMinutes()).padStart(2, "0");
  const iso = `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, "0")}-${String(at.getDate()).padStart(2, "0")}`;
  return `Посчитано ${date(iso)} в ${hh}:${mm}`;
}

/** Нужно ли запомнить итог для карточки: итог изменился или после прошлого расчёта сервис обновился. */
export function snapshotOutdated(saved: AnalysisSnapshot | null, next: AnalysisSnapshot, updates: readonly ServiceUpdate[] = SERVICE_UPDATES): boolean {
  if (!saved) return true;
  if (saved.best !== next.best || saved.netProfit !== next.netProfit || saved.variants !== next.variants || saved.npv !== next.npv) return true;
  return updatesSince(saved.at, updates).length > 0;
}
