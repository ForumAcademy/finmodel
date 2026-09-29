/**
 * Хранилище проектов, документов и справочника — в браузере (IndexedDB), решение пользователя 29.09.2026:
 * отдельную базу не подключаем, проекты и справочник передаются коллегам файлами (lib/files.ts).
 * Сервер, если понадобится, подключается заменой этого файла; экраны работают только через эти функции.
 */
import { book, type plot } from "@fm/engine";

type LandProject = plot.LandProject;

const DB = "finmodel";
const VERSION = 2;
const PROJECTS = "projects";
const FILES = "files";
/** Справочник допущений компании: одна запись — все версии по порядку. */
const REFERENCE = "reference";
const REFERENCE_KEY = "versions";

export interface StoredFile {
  id: string;
  name: string;
  type: string;
  blob: Blob;
}

let opening: Promise<IDBDatabase> | null = null;

function db(): Promise<IDBDatabase> {
  opening ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, VERSION);
    req.onupgradeneeded = () => {
      const d = req.result;
      if (!d.objectStoreNames.contains(PROJECTS)) d.createObjectStore(PROJECTS, { keyPath: "id" });
      if (!d.objectStoreNames.contains(FILES)) d.createObjectStore(FILES, { keyPath: "id" });
      if (!d.objectStoreNames.contains(REFERENCE)) d.createObjectStore(REFERENCE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("Хранилище браузера недоступно"));
  });
  return opening;
}

async function run<T>(store: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const d = await db();
  return new Promise((resolve, reject) => {
    const tx = d.transaction(store, mode);
    const req = fn(tx.objectStore(store));
    tx.oncomplete = () => resolve(req.result);
    tx.onerror = () => reject(tx.error ?? new Error("Не удалось сохранить в хранилище браузера"));
  });
}

export async function listProjects(): Promise<LandProject[]> {
  const all = await run<LandProject[]>(PROJECTS, "readonly", (s) => s.getAll());
  return all.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function getProject(id: string): Promise<LandProject | null> {
  return (await run<LandProject | undefined>(PROJECTS, "readonly", (s) => s.get(id))) ?? null;
}

export async function saveProject(p: LandProject): Promise<void> {
  await run(PROJECTS, "readwrite", (s) => s.put(p));
}

export async function saveFile(id: string, file: File): Promise<void> {
  const f: StoredFile = { id, name: file.name, type: file.type, blob: file };
  await run(FILES, "readwrite", (s) => s.put(f));
}

export async function saveStoredFile(f: StoredFile): Promise<void> {
  await run(FILES, "readwrite", (s) => s.put(f));
}

export async function deleteFile(id: string): Promise<void> {
  await run(FILES, "readwrite", (s) => s.delete(id));
}

export async function getFile(id: string): Promise<StoredFile | null> {
  return (await run<StoredFile | undefined>(FILES, "readonly", (s) => s.get(id))) ?? null;
}

export const newId = () => crypto.randomUUID();
export const nowIso = () => new Date().toISOString();

/** Справочник этого браузера: сохранённые версии и новые версии, пришедшие с обновлением сервиса. */
export async function getReference(): Promise<book.AssumptionVersion[]> {
  const stored = await run<book.AssumptionVersion[] | undefined>(REFERENCE, "readonly", (s) => s.get(REFERENCE_KEY));
  return book.withSpecVersions(stored ?? null);
}

export async function saveReference(versions: book.AssumptionVersion[]): Promise<void> {
  await run(REFERENCE, "readwrite", (s) => s.put(versions, REFERENCE_KEY));
}
