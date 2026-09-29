/** Чтение выписки ЕГРН из файла в браузере: текст PDF достаёт pdf.js, поля распознаёт @fm/egrn-import. */
import { readEgrnFile, type EgrnResult } from "@fm/egrn-import";

async function pdfText(bytes: Uint8Array): Promise<string> {
  const pdfjs = await import("pdfjs-dist");
  pdfjs.GlobalWorkerOptions.workerSrc = new URL("pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url).toString();
  const doc = await pdfjs.getDocument({ data: bytes }).promise;
  const pages: string[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const content = await (await doc.getPage(i)).getTextContent();
    pages.push(content.items.map((it) => ("str" in it ? it.str + (it.hasEOL ? "\n" : " ") : "")).join(""));
  }
  return pages.join("\n");
}

export async function readEgrn(file: File): Promise<EgrnResult> {
  return readEgrnFile(file.name, new Uint8Array(await file.arrayBuffer()), pdfText);
}

export async function download(name: string, blob: Blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
