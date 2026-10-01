/**
 * Файлы проекта и справочника: сохранить на компьютер и открыть. Формат и правила — в ядре (projectFile, book);
 * здесь только байты: base64, sha256, скачивание и чтение выбранного файла.
 */
import { book, competitors, projectFile, type plot } from "@fm/engine";
import { getFile, getReference, listCompetitors, type StoredFile } from "./store";

function toBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let s = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) s += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  return btoa(s);
}

function fromBase64(data: string): Uint8Array<ArrayBuffer> {
  const s = atob(data);
  const out = new Uint8Array(new ArrayBuffer(s.length));
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

async function sha256(buf: BufferSource): Promise<string> {
  const h = new Uint8Array(await crypto.subtle.digest("SHA-256", buf));
  return Array.from(h, (b) => b.toString(16).padStart(2, "0")).join("");
}

function download(json: unknown, name: string) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(json, null, 1)], { type: "application/json" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Сохранить проект в файл. Возвращает названия документов, файлов которых нет в этом браузере. */
export async function saveProjectFile(p: plot.LandProject): Promise<string[]> {
  const at = new Date().toISOString();
  const entries: projectFile.FileEntry[] = [];
  const present = new Set<string>();
  for (const d of p.documents) {
    const f = await getFile(d.id);
    if (!f) continue;
    const buf = await f.blob.arrayBuffer();
    entries.push({ id: d.id, name: f.name, type: f.type, size: buf.byteLength, sha256: await sha256(buf), data: toBase64(buf) });
    present.add(d.id);
  }
  download(projectFile.buildProjectFile(p, await getReference(), entries, at), projectFile.projectFileName(p, at));
  return projectFile.missingFiles(p, present);
}

export async function readJson(file: File): Promise<unknown> {
  try {
    return JSON.parse(await file.text()) as unknown;
  } catch {
    return null;
  }
}

/** Файлы проекта из файла: байты с проверкой sha256. Не сошлось — документ повреждён. */
export async function storedFiles(entries: readonly projectFile.FileEntry[]): Promise<{ files: StoredFile[]; broken: string[] }> {
  const files: StoredFile[] = [];
  const broken: string[] = [];
  for (const e of entries) {
    try {
      const bytes = fromBase64(e.data);
      if ((await sha256(bytes)) !== e.sha256) throw new Error("sha256");
      files.push({ id: e.id, name: e.name, type: e.type, blob: new Blob([bytes], { type: e.type }) });
    } catch {
      broken.push(e.name);
    }
  }
  return { files, broken };
}

export async function saveReferenceFile(versions: book.AssumptionVersion[]) {
  const at = new Date().toISOString();
  download(book.referenceFile(versions, at), book.referenceFileName(versions, at));
}

async function fileEntry(id: string): Promise<projectFile.FileEntry | null> {
  const f = await getFile(id);
  if (!f) return null;
  const buf = await f.blob.arrayBuffer();
  return { id, name: f.name, type: f.type, size: buf.byteLength, sha256: await sha256(buf), data: toBase64(buf) };
}

/** Сохранить все карточки конкурентов со скриншотами в файл. */
export async function saveCompetitorsFile() {
  const at = new Date().toISOString();
  const list = await listCompetitors();
  const entries: projectFile.FileEntry[] = [];
  for (const c of list) for (const s of c.snapshots) if (s.fileId) {
    const e = await fileEntry(s.fileId);
    if (e) entries.push(e);
  }
  download(competitors.buildCompetitorsFile(list, entries, at), competitors.competitorsFileName(at));
}
