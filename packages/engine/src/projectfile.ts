/**
 * Файл проекта: один JSON со всеми вводными, документами, историей и версией справочника.
 *
 * Формат рассчитан на хранение на сервере без переделок: `project` — запись проекта как есть (строка таблицы проектов),
 * `reference` — версия справочника, на которой посчитан проект, `files` — документы проекта по id документа
 * (на сервере `data` заменяется ссылкой на хранилище файлов, остальные поля те же). Байты файла — base64, проверка
 * целостности — sha256; и то и другое считает интерфейс, здесь — только структура и правила открытия.
 */
import { z } from "zod";
import { assumptionVersionSchema, type SpecAssumptionVersion as AssumptionVersion } from "@fm/spec";
import { sameVersion } from "./book";
import { versionOf } from "./project";
import { DOCUMENT_KINDS, PLOT_FIELDS, projectTitle, type LandProject, type PlotValue } from "./plot";
import { SITE_FIELDS } from "./site";
import { date } from "./lib/text";

export const PROJECT_FORMAT = "finmodel-project";
export const PROJECT_FORMAT_VERSION = 1;

export interface FileEntry {
  /** id документа проекта (ProjectDocument.id). */
  id: string;
  name: string;
  type: string;
  size: number;
  /** sha256 байтов файла, hex. */
  sha256: string;
  /** Байты файла, base64. */
  data: string;
}

export interface ProjectFile {
  format: typeof PROJECT_FORMAT;
  formatVersion: typeof PROJECT_FORMAT_VERSION;
  savedAt: string;
  project: LandProject;
  /** Версия справочника, на которой посчитан проект. */
  reference: AssumptionVersion | null;
  files: FileEntry[];
}

// ---------- схема (проверка файла при открытии) ----------

const basis = z.object({ title: z.string(), url: z.string().nullish(), documentId: z.string().nullish(), date: z.string().nullish(), note: z.string().nullish() }).nullable();
const plotValue = z.object({ value: z.string().nullable(), origin: z.enum(["source", "estimate", "expert", "reference"]).nullable(), basis });
const kinds: [string, ...string[]] = ["other", ...DOCUMENT_KINDS.map((d) => d.kind)];
const fieldKeys = PLOT_FIELDS.map((f) => f.key) as [string, ...string[]];
const siteKeys = SITE_FIELDS.map((f) => f.key) as [string, ...string[]];
const nstr = z.string().nullable();

const siteSchema = z.object({
  values: z.object(Object.fromEntries(siteKeys.map((k) => [k, plotValue.optional()]))),
  zouit: z.array(z.object({ id: z.string(), name: z.string(), area: nstr, noBuild: z.boolean(), restriction: z.string(), origin: z.enum(["source", "estimate", "expert", "reference"]), basis: basis.unwrap() })),
  analogs: z.array(
    z.object({ id: z.string(), name: z.string(), product: z.string(), housingClass: z.string(), distanceKm: nstr, stage: nstr, price: nstr, pace: nstr, soldShare: nstr, url: z.string(), date: z.string() }),
  ),
  customVariants: z.array(z.object({ id: z.string(), housing_class: z.string(), floors: z.number(), apart: z.boolean() })),
  selectedVariant: nstr,
  snapshot: z.object({ at: z.string(), best: nstr, bestTitle: nstr, netProfit: nstr, variants: z.number() }).nullable(),
});

const projectSchema = z.object({
  id: z.string().min(1),
  name: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  archived: z.boolean(),
  assumptionsVersion: z.number().int().min(1),
  assumptionsSnapshot: assumptionVersionSchema.optional(),
  plot: z.object(Object.fromEntries(fieldKeys.map((k) => [k, plotValue]))),
  point: z.object({ lat: z.number(), lon: z.number() }).nullable(),
  documents: z.array(z.object({ id: z.string().min(1), kind: z.enum(kinds), fileName: z.string(), size: z.number(), uploadedAt: z.string() })),
  history: z.array(z.object({ at: z.string(), field: z.enum([...fieldKeys, ...siteKeys, "assumptionsVersion"]), from: z.string(), to: z.string(), basis: z.string() })),
  site: siteSchema.optional(),
});

const fileSchema = z.object({
  format: z.literal(PROJECT_FORMAT),
  formatVersion: z.literal(PROJECT_FORMAT_VERSION),
  savedAt: z.string(),
  project: projectSchema,
  reference: assumptionVersionSchema.nullable(),
  files: z.array(z.object({ id: z.string().min(1), name: z.string(), type: z.string(), size: z.number(), sha256: z.string(), data: z.string() })),
});

// ---------- сохранение ----------

/** Версия справочника проекта: своя из файла или версия этого браузера. */
export function projectReferenceVersion(p: LandProject, local: readonly AssumptionVersion[]): AssumptionVersion | null {
  return p.assumptionsSnapshot ?? versionOf([...local], p.assumptionsVersion);
}

export function buildProjectFile(p: LandProject, local: readonly AssumptionVersion[], files: readonly FileEntry[], at: string): ProjectFile {
  const project = structuredClone(p);
  delete project.assumptionsSnapshot;
  return { format: PROJECT_FORMAT, formatVersion: PROJECT_FORMAT_VERSION, savedAt: at, project, reference: projectReferenceVersion(p, local), files: [...files] };
}

const safeName = (s: string) => s.replace(/[\\/:*?"<>|]+/g, " ").replace(/\s+/g, " ").trim();

export function projectFileName(p: LandProject, at: string): string {
  return `${safeName(projectTitle(p))} — проект от ${date(at.slice(0, 10))}.json`;
}

/** Документы проекта, файлов которых нет в браузере: сохранить проект можно, но без них. */
export function missingFiles(p: LandProject, present: ReadonlySet<string>): string[] {
  return p.documents.filter((d) => !present.has(d.id)).map((d) => d.fileName);
}

// ---------- открытие ----------

export type ReadResult = { ok: true; file: ProjectFile } | { ok: false; error: string };

export function readProjectFile(json: unknown): ReadResult {
  const f = json as { format?: unknown; formatVersion?: unknown } | null;
  if (!f || typeof f !== "object" || f.format !== PROJECT_FORMAT) return { ok: false, error: "Это не файл проекта. Выберите файл, сохранённый кнопкой «Сохранить проект в файл»." };
  if (f.formatVersion !== PROJECT_FORMAT_VERSION) return { ok: false, error: "Файл сохранён более новой версией сервиса. Обновите страницу и откройте файл снова." };
  const r = fileSchema.safeParse(json);
  if (!r.success) return { ok: false, error: "Файл проекта повреждён: часть данных не читается. Сохраните проект в файл заново." };
  const file = r.data as unknown as ProjectFile;
  if (file.reference && file.reference.version !== file.project.assumptionsVersion) return { ok: false, error: "Файл проекта повреждён: версия справочника не совпадает с версией проекта." };
  return { ok: true, file };
}

const key = (s: string) => s.trim().toLowerCase().replace(/ё/g, "е").replace(/\s+/g, " ");

/** Проект этого браузера с тем же названием (или тот же проект) — спросить: заменить или создать копию. */
export function findConflict(file: ProjectFile, projects: readonly LandProject[]): LandProject | null {
  const title = key(projectTitle(file.project));
  return projects.find((p) => key(projectTitle(p)) === title) ?? projects.find((p) => p.id === file.project.id) ?? null;
}

export type OpenMode = "new" | "replace" | "copy";

export interface OpenResult {
  project: LandProject;
  /** Файлы документов с новыми id — сохранить в браузере. */
  files: FileEntry[];
  /** Пояснение про версию справочника, если она из файла; null — версия совпадает с этим браузером. */
  referenceNote: string | null;
}

/**
 * Проект из файла. Документы получают новые id, чтобы файлы копий не пересекались; ссылки полей участка на документы
 * переписываются. «Заменить» оставляет id и дату создания проекта этого браузера, «копия» — новый id и «(копия)».
 */
export function openProject(file: ProjectFile, mode: OpenMode, local: readonly AssumptionVersion[], existing: LandProject | null, newId: () => string, at: string): OpenResult {
  const src = structuredClone(file.project);
  const ids = new Map(src.documents.map((d) => [d.id, newId()]));
  const relink = <T extends Pick<PlotValue, "basis">>(v: T): T => (v.basis?.documentId && ids.has(v.basis.documentId) ? { ...v, basis: { ...v.basis, documentId: ids.get(v.basis.documentId) } } : v);
  const plot = Object.fromEntries(Object.entries(src.plot).map(([k, v]) => [k, relink(v)])) as LandProject["plot"];
  if (src.site) {
    src.site = {
      ...src.site,
      values: Object.fromEntries(Object.entries(src.site.values).map(([k, v]) => [k, v && relink(v)])),
      zouit: src.site.zouit.map((z) => relink(z)),
    };
  }
  const documents = src.documents.map((d) => ({ ...d, id: ids.get(d.id) ?? d.id }));
  const files = file.files.filter((f) => ids.has(f.id)).map((f) => ({ ...f, id: ids.get(f.id) as string }));

  const project: LandProject = { ...src, plot, documents };
  delete project.assumptionsSnapshot;
  if (mode === "replace" && existing) Object.assign(project, { id: existing.id, createdAt: existing.createdAt });
  if (mode === "copy") Object.assign(project, { id: newId(), name: `${projectTitle(src)} (копия)`, createdAt: at, updatedAt: at, archived: false });
  if (mode === "new" && existing) project.id = newId();

  let referenceNote: string | null = null;
  const ref = file.reference;
  const here = versionOf([...local], src.assumptionsVersion);
  if (ref && !sameVersion(ref, here)) {
    project.assumptionsSnapshot = ref;
    referenceNote = here
      ? `Версия ${ref.version} справочника в файле отличается от версии ${ref.version} этого браузера. Проект сохранит свои значения; перейти на справочник этого браузера можно кнопкой «Обновить» в проекте.`
      : `Проект посчитан на версии ${ref.version} справочника, которой нет в этом браузере. Проект сохранит свои значения; чтобы у всех была одна версия, загрузите справочник коллеги из файла.`;
  }
  return { project, files, referenceNote };
}

/** Файлы заменяемого проекта, которые больше не нужны ни одному проекту браузера. */
export function orphanFileIds(old: LandProject, others: readonly LandProject[]): string[] {
  const used = new Set(others.filter((p) => p.id !== old.id).flatMap((p) => p.documents.map((d) => d.id)));
  return old.documents.map((d) => d.id).filter((id) => !used.has(id));
}
