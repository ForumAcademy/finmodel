/**
 * Хранилище проектов и документов. Сейчас — в браузере (IndexedDB): проекты видны только там, где созданы.
 * Общая база подключается заменой этого файла; экраны работают только через эти функции.
 */
import type { plot } from "@fm/engine";

type LandProject = plot.LandProject;

const DB = "finmodel";
const VERSION = 1;
const PROJECTS = "projects";
const FILES = "files";

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

export async function getFile(id: string): Promise<StoredFile | null> {
  return (await run<StoredFile | undefined>(FILES, "readonly", (s) => s.get(id))) ?? null;
}

export const newId = () => crypto.randomUUID();
export const nowIso = () => new Date().toISOString();
