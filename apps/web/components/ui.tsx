"use client";

import { useEffect, type ReactNode } from "react";
import { plot } from "@fm/engine";

export type Tone = "yel" | "red" | "grn" | "gry" | "acc";

export function Chip({ tone, children, onClick }: { tone: Tone; children: ReactNode; onClick?: () => void }) {
  return (
    <span className={`chip ${tone}${onClick ? " click" : ""}`} onClick={onClick}>
      {children}
    </span>
  );
}

const ORG_CLASS: Record<plot.Origin, string> = { source: "src", estimate: "est", expert: "exp", reference: "ref" };

/** Метка происхождения значения; нет значения — «нет значения». */
export function OriginTag({ origin }: { origin: plot.Origin | null }) {
  if (!origin) return <span className="org miss">нет значения</span>;
  return <span className={`org ${ORG_CLASS[origin]}`}>{plot.ORIGIN_LABEL[origin]}</span>;
}

export function Modal({ title, onClose, children, footer, wide }: { title: string; onClose: () => void; children: ReactNode; footer: ReactNode; wide?: boolean }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="ovl" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" style={wide ? { width: 680 } : undefined} role="dialog" aria-label={title}>
        <div className="mh">
          <h2>{title}</h2>
          <button className="x" onClick={onClose} aria-label="Закрыть">
            ×
          </button>
        </div>
        {children}
        <div className="mf">{footer}</div>
      </div>
    </div>
  );
}

export function Toast({ text }: { text: string | null }) {
  return text ? <div className="toast">{text}</div> : null;
}
