"use client";

import { useState } from "react";

/** Кнопка «Скачать PDF»: снимок карты сервиса одной страницей, ссылки на документы в файле остаются нажимаемыми. */
export function LogicDownload({ targetId, fileName }: { targetId: string; fileName: string }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function download() {
    const el = document.getElementById(targetId);
    if (!el) return;
    setBusy(true);
    setErr(null);
    try {
      const [{ toJpeg }, { jsPDF }] = await Promise.all([import("html-to-image"), import("jspdf")]);
      const box = el.getBoundingClientRect();
      const w = Math.ceil(box.width);
      const h = Math.ceil(box.height);
      const jpg = await toJpeg(el, { quality: 0.9, pixelRatio: 2, backgroundColor: "#f5f6f8", filter: (n) => !(n instanceof HTMLElement && n.dataset.noPdf !== undefined) });
      const pdf = new jsPDF({ orientation: w > h ? "landscape" : "portrait", unit: "px", format: [w, h], hotfixes: ["px_scaling"], compress: true });
      pdf.addImage(jpg, "JPEG", 0, 0, w, h);
      el.querySelectorAll<HTMLAnchorElement>("a[href]").forEach((a) => {
        const r = a.getBoundingClientRect();
        pdf.link(r.left - box.left, r.top - box.top, r.width, r.height, { url: a.href });
      });
      pdf.save(fileName);
    } catch {
      setErr("Не удалось собрать файл. Обновите страницу и попробуйте ещё раз.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <span data-no-pdf className="lg-dl">
      <button className="btn pri" onClick={download} disabled={busy}>
        {busy ? "Собираю файл…" : "Скачать PDF"}
      </button>
      {err && <span className="lg-dl-err">{err}</span>}
    </span>
  );
}
