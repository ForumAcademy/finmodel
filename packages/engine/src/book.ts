/**
 * Справочник допущений компании в браузере: правка стандартных значений с новой версией, файл справочника для коллег,
 * версия справочника у проекта и переход на новую версию кнопкой «Обновить».
 * Нормативы регионов, налоги и ставки по закону не правятся здесь: каждое такое значение привязано к документу
 * и меняется через спецификацию (CLAUDE.md, правило 4).
 */
import Decimal from "decimal.js";
import {
  ASSUMPTION_STATUSES,
  assumptionValueProblem,
  assumptionVersionSchema,
  getParameter,
  spec,
  type ParameterId,
  type SpecAssumptionItem as AssumptionItem,
  type SpecAssumptionVersion as AssumptionVersion,
  type SpecParameter,
} from "@fm/spec";
import { SPEC_ASSUMPTIONS, versionOf } from "./project";
import type { LandProject } from "./plot";
import { formatValue } from "./reference";
import { date } from "./lib/text";

export type { AssumptionItem, AssumptionVersion };

// ---------- справочник этого браузера ----------

/**
 * Справочник браузера с учётом спецификации: сохранённые в браузере версии и версии спецификации с бо́льшими номерами
 * (новые версии, пришедшие с обновлением сервиса). Ничего не сохранено — версии спецификации.
 */
export function withSpecVersions(stored: readonly AssumptionVersion[] | null, specVersions: readonly AssumptionVersion[] = SPEC_ASSUMPTIONS): AssumptionVersion[] {
  if (!stored?.length) return [...specVersions];
  const last = stored.at(-1)?.version ?? 0;
  return [...stored, ...specVersions.filter((v) => v.version > last)];
}

const stable = (v: unknown): string =>
  JSON.stringify(v, (_k, x: unknown) =>
    x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.entries(x as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))) : x,
  );

/** Одна и та же версия: номер и всё содержимое совпадают. */
export const sameVersion = (a: AssumptionVersion | null | undefined, b: AssumptionVersion | null | undefined): boolean => !!a && !!b && stable(a) === stable(b);

// ---------- ввод значения ----------

const PERCENT_UNITS = new Set(["доля", "%годовых", "доля/год"]);

const isPercent = (unit: string) => PERCENT_UNITS.has(unit) || unit.startsWith("доля");

/** Единица поля ввода: проценты вводятся в % (задание, раздел 7). */
export function inputUnit(unit: string): string {
  if (unit === "%годовых") return "% годовых";
  if (unit === "доля/год") return "% в год";
  if (isPercent(unit)) return "%";
  if (unit === "мес") return "мес";
  if (unit === "руб") return "руб";
  return "";
}

const ru = (s: string) => s.replace(".", ",");

/** Число → текст поля ввода: доли показываются в %, 0,035 → «3,5». */
export function toInput(unit: string, v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v !== "number") return String(v);
  return ru(isPercent(unit) ? new Decimal(v).times(100).toString() : new Decimal(v).toString());
}

export type Parsed = { value: number | null; error?: undefined } | { value?: undefined; error: string };

/** Текст поля ввода → число параметра («3,5» % → 0,035). Пусто — null (стандарта нет). */
export function fromInput(unit: string, text: string, range?: readonly [number, number] | null): Parsed {
  const s = text.replace(/[\s\u00a0\u202f]/g, "").replace(",", ".");
  if (!s) return { value: null };
  if (!/^-?\d+(\.\d+)?$/.test(s)) return { error: `«${text}» — не число. Введите число${inputUnit(unit) ? ` в ${inputUnit(unit)}` : ""}, например 3,5` };
  const d = new Decimal(s);
  const value = isPercent(unit) ? d.div(100).toNumber() : d.toNumber();
  if (unit === "мес" && !Number.isInteger(value)) return { error: "Число месяцев — целое" };
  if (range && (value < range[0] || value > range[1])) return { error: `${ru(s)} ${inputUnit(unit)} вне допустимого: от ${toInput(unit, range[0])} до ${toInput(unit, range[1])} ${inputUnit(unit)}`.replace(/\s+/g, " ") };
  return { value };
}

// ---------- правка значений ----------

export const STATUS_LABEL: Record<(typeof ASSUMPTION_STATUSES)[number], string> = { unverified: "не проверено", check: "проверить", approved: "утверждено" };
export const STATUSES = ASSUMPTION_STATUSES;

/** Столбцы таблицы параметра для ввода: название, единица, варианты. */
export function tableColumns(p: SpecParameter): { key: string; title: string; unit: string; options: readonly string[] | null }[] {
  return (p.columns ?? []).map((c) => ({ key: c.key, title: "title" in c && typeof c.title === "string" ? c.title : c.key, unit: c.unit, options: c.options ?? null }));
}

/** Почему значение строки не подходит (null — подходит). */
export function itemProblem(item: AssumptionItem): string | null {
  const p = getParameter(item.param);
  if (!item.from.text.trim()) return "Заполните «Откуда»: документ или решение, на котором основано значение";
  if (item.from.url && !/^https?:\/\//.test(item.from.url)) return "Ссылка должна начинаться с http:// или https://";
  if (item.status === "check" && !item.check?.trim()) return "Для статуса «проверить» напишите, что проверить";
  if (p.kind === "table" && Array.isArray(item.value)) {
    for (const [i, row] of (item.value as Record<string, unknown>[]).entries())
      for (const c of tableColumns(p)) if (row[c.key] === null || row[c.key] === undefined || row[c.key] === "") return `Строка ${i + 1}: заполните «${c.title}»`;
  }
  const problem = assumptionValueProblem(p as never, item.value);
  if (!problem) return null;
  return p.range ? `Значение вне допустимого: от ${toInput(p.unit, p.range[0])} до ${toInput(p.unit, p.range[1])} ${inputUnit(p.unit)}` : "Значение не подходит показателю";
}

const valueText = (param: ParameterId, v: unknown): string => {
  const f = formatValue(getParameter(param), v);
  if (!f) return "нет стандарта";
  if (f.text) return f.text;
  return f.table ? f.table.rows.map((r) => r.join(" · ")).join("; ") : "";
};

const statusText = (i: AssumptionItem) => (i.status === "check" ? `проверить ${i.check ?? ""}`.trim() : STATUS_LABEL[i.status]);
const fromText = (i: AssumptionItem) => [i.from.text, i.from.url].filter(Boolean).join(", ");

export interface ItemChange {
  param: ParameterId;
  name: string;
  what: "Значение" | "Статус" | "Откуда" | "Пояснение";
  from: string;
  to: string;
}

/** Что изменилось между версией и правкой: по строке на изменённое поле. */
export function itemChanges(prev: readonly AssumptionItem[], next: readonly AssumptionItem[]): ItemChange[] {
  const out: ItemChange[] = [];
  for (const n of next) {
    const o = prev.find((x) => x.param === n.param);
    if (!o) continue;
    const name = getParameter(n.param).name;
    const push = (what: ItemChange["what"], from: string, to: string) => from !== to && out.push({ param: n.param, name, what, from: from || "—", to: to || "—" });
    if (stable(o.value) !== stable(n.value)) push("Значение", valueText(o.param, o.value), valueText(n.param, n.value));
    push("Статус", statusText(o), statusText(n));
    push("Откуда", fromText(o), fromText(n));
    push("Пояснение", o.note ?? "", n.note ?? "");
  }
  return out;
}

/** Строка для «Что изменилось» по умолчанию: названия изменённых показателей. */
export function suggestedNote(changes: readonly ItemChange[]): string {
  const names = [...new Set(changes.map((c) => c.name))];
  return names.length ? `Изменено: ${names.join(", ")}` : "";
}

const clean = (i: AssumptionItem): AssumptionItem => {
  const out: AssumptionItem = { param: i.param, group: i.group, value: i.value, status: i.status, from: { text: i.from.text.trim(), url: i.from.url?.trim() || null } };
  if (i.status === "check" && i.check?.trim()) out.check = i.check.trim();
  if (i.note?.trim()) out.note = i.note.trim();
  return out;
};

export type NewVersionResult = { version: AssumptionVersion; errors: string[] } | { version: null; errors: string[] };

/** Новая версия справочника из правки: полный список значений, номер — следующий, дата — день сохранения. */
export function newVersion(versions: readonly AssumptionVersion[], items: readonly AssumptionItem[], author: string, note: string, at: string): NewVersionResult {
  const last = versions.at(-1);
  const errors: string[] = [];
  if (!author.trim()) errors.push("Укажите, кто сохраняет версию");
  if (!note.trim()) errors.push("Опишите, что изменилось");
  for (const i of items) {
    const problem = itemProblem(i);
    if (problem) errors.push(`${getParameter(i.param).name}: ${problem}`);
  }
  const cleaned = items.map(clean);
  if (last && !itemChanges(last.items, cleaned).length) errors.push("Значения не изменились — новая версия не нужна");
  if (errors.length) return { version: null, errors };
  return { version: { version: (last?.version ?? 0) + 1, date: at.slice(0, 10), author: author.trim(), note: note.trim(), items: cleaned }, errors: [] };
}

// ---------- файл справочника ----------

export const REFERENCE_FORMAT = "finmodel-reference";
export const REFERENCE_FORMAT_VERSION = 1;

/** Файл справочника: все версии по порядку — у коллег, загрузивших файл, одна и та же история версий. */
export interface ReferenceFile {
  format: typeof REFERENCE_FORMAT;
  formatVersion: typeof REFERENCE_FORMAT_VERSION;
  savedAt: string;
  versions: AssumptionVersion[];
}

export function referenceFile(versions: readonly AssumptionVersion[], at: string): ReferenceFile {
  return { format: REFERENCE_FORMAT, formatVersion: REFERENCE_FORMAT_VERSION, savedAt: at, versions: [...versions] };
}

export function referenceFileName(versions: readonly AssumptionVersion[], at: string): string {
  const v = versions.at(-1);
  return `Справочник, версия ${v?.version ?? 0} — ${date(at.slice(0, 10))}.json`;
}

/** Проверка версий из файла: структура, параметры, значения, нумерация по порядку. */
export function versionsProblems(versions: readonly unknown[]): string[] {
  const errors: string[] = [];
  const params = new Set(spec.parameters.map((p) => p.id as string));
  versions.forEach((raw, i) => {
    const r = assumptionVersionSchema.safeParse(raw);
    if (!r.success) {
      errors.push(`Версия ${i + 1}: запись повреждена`);
      return;
    }
    const v = r.data;
    if (v.version !== i + 1) errors.push(`Версии идут не по порядку: на месте ${i + 1} версия ${v.version}`);
    for (const item of v.items) {
      if (!params.has(item.param)) {
        errors.push(`Версия ${v.version}: показателя нет в этой версии сервиса — обновите страницу или сервис`);
        break;
      }
      const problem = assumptionValueProblem(getParameter(item.param as ParameterId) as never, item.value);
      if (problem) errors.push(`Версия ${v.version}, «${getParameter(item.param as ParameterId).name}»: значение не подходит показателю`);
    }
  });
  return errors;
}

export type ReadResult<T> = { ok: true; value: T } | { ok: false; error: string };

export function readReferenceFile(json: unknown): ReadResult<AssumptionVersion[]> {
  const f = json as Partial<ReferenceFile> | null;
  if (!f || typeof f !== "object" || f.format !== REFERENCE_FORMAT) return { ok: false, error: "Это не файл справочника. Выберите файл, сохранённый кнопкой «Сохранить справочник в файл»." };
  if (f.formatVersion !== REFERENCE_FORMAT_VERSION) return { ok: false, error: "Файл сохранён более новой версией сервиса. Обновите страницу и загрузите файл снова." };
  if (!Array.isArray(f.versions) || !f.versions.length) return { ok: false, error: "В файле нет ни одной версии справочника." };
  const problems = versionsProblems(f.versions);
  if (problems.length) return { ok: false, error: `Файл справочника повреждён: ${problems[0]}.` };
  return { ok: true, value: f.versions as AssumptionVersion[] };
}

export type ReferencePlan =
  | { kind: "same"; latest: number }
  | { kind: "newer"; added: number[] }
  | { kind: "older"; local: number; file: number }
  | { kind: "diverged"; from: number; local: number; file: number };

/** Что будет при загрузке справочника из файла. */
export function referencePlan(local: readonly AssumptionVersion[], incoming: readonly AssumptionVersion[]): ReferencePlan {
  const n = Math.min(local.length, incoming.length);
  for (let i = 0; i < n; i++) {
    if (!sameVersion(local[i], incoming[i])) return { kind: "diverged", from: i + 1, local: local.length, file: incoming.length };
  }
  if (incoming.length === local.length) return { kind: "same", latest: local.length };
  if (incoming.length > local.length) return { kind: "newer", added: incoming.slice(local.length).map((v) => v.version) };
  return { kind: "older", local: local.length, file: incoming.length };
}

/** Текст перед загрузкой: что изменится и что будет с проектами. */
export function planText(plan: ReferencePlan, projects: readonly LandProject[]): string {
  switch (plan.kind) {
    case "same":
      return `Справочник в файле совпадает с этим браузером (версия ${plan.latest}). Загружать нечего.`;
    case "newer":
      return `В файле новые версии: ${plan.added.join(", ")}. Они добавятся в справочник. Проекты останутся на своих версиях; перейти на новую можно кнопкой «Обновить» в проекте.`;
    case "older":
      return `В этом браузере справочник новее: версия ${plan.local}, в файле — ${plan.file}. Загружать нечего. Чтобы у коллег была одна версия, передайте им файл из этого браузера.`;
    case "diverged": {
      const affected = projects.filter((p) => !p.assumptionsSnapshot && p.assumptionsVersion >= plan.from).length;
      return (
        `С версии ${plan.from} справочник в файле и в этом браузере разный (здесь версий ${plan.local}, в файле ${plan.file}). ` +
        `При замене версии этого браузера с ${plan.from}-й заменятся версиями из файла.` +
        (affected ? ` Проекты на этих версиях (${affected}) сохранят свои значения и перейдут на справочник из файла только по кнопке «Обновить».` : "")
      );
    }
  }
}

/**
 * Загрузить справочник из файла. Проекты на заменяемых версиях получают свою прежнюю версию с собой
 * (assumptionsSnapshot), чтобы их расчёт не изменился без «Обновить».
 */
export function applyReference(local: readonly AssumptionVersion[], incoming: readonly AssumptionVersion[], projects: readonly LandProject[], at: string): { versions: AssumptionVersion[]; projects: LandProject[] } {
  const plan = referencePlan(local, incoming);
  if (plan.kind === "same" || plan.kind === "older") return { versions: [...local], projects: [] };
  if (plan.kind === "newer") return { versions: [...incoming], projects: [] };
  const changed = projects
    .filter((p) => !p.assumptionsSnapshot && p.assumptionsVersion >= plan.from)
    .flatMap((p) => {
      const own = versionOf([...local], p.assumptionsVersion);
      return own ? [{ ...p, assumptionsSnapshot: own, updatedAt: at }] : [];
    });
  return { versions: [...incoming], projects: changed };
}

// ---------- версия справочника у проекта ----------

export interface ProjectReference {
  version: number;
  /** Версия пришла с проектом из файла и отличается от версии этого браузера с тем же номером. */
  fromFile: boolean;
  /** Последняя версия этого браузера, если проект может на неё перейти. */
  updateTo: number | null;
  text: string;
}

export function projectReference(p: LandProject, local: readonly AssumptionVersion[]): ProjectReference {
  const latest = local.at(-1);
  const fromFile = !!p.assumptionsSnapshot;
  const updateTo = latest && (fromFile || latest.version > p.assumptionsVersion) ? latest.version : null;
  const own = p.assumptionsSnapshot ?? versionOf([...local], p.assumptionsVersion);
  const text = `Справочник: версия ${p.assumptionsVersion}${own ? ` от ${date(own.date)}` : ""}${fromFile ? " (из файла проекта)" : ""}`;
  return { version: p.assumptionsVersion, fromFile, updateTo, text };
}

/** Версии для расчёта проекта: своя версия из файла или справочник браузера. */
export function projectVersions(p: LandProject, local: readonly AssumptionVersion[]): AssumptionVersion[] {
  return p.assumptionsSnapshot ? [p.assumptionsSnapshot] : [...local];
}

/** Перейти на последнюю версию справочника браузера (кнопка «Обновить»); переход пишется в историю. */
export function updateReference(p: LandProject, local: readonly AssumptionVersion[], at: string): LandProject {
  const latest = local.at(-1);
  if (!latest) return p;
  const from = projectReference(p, local).text.replace("Справочник: ", "");
  const rest = { ...p };
  delete rest.assumptionsSnapshot;
  return {
    ...rest,
    assumptionsVersion: latest.version,
    updatedAt: at,
    history: [...p.history, { at, field: "assumptionsVersion", from, to: `версия ${latest.version} от ${date(latest.date)}`, basis: `Справочник, версия ${latest.version}: ${latest.author}. ${latest.note}` }],
  };
}

// ---------- ввод ячейки таблицы ----------

/** Значение ячейки таблицы для поля ввода. */
export const cellInput = (unit: string, v: unknown): string => (typeof v === "number" ? toInput(unit, v) : v === null || v === undefined ? "" : String(v));
