"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { analysis, report, reportView, site, type plot } from "@fm/engine";
import type { AnalysisState } from "./AnalysisScreens";
import { OriginTag } from "./ui";

type VariantSummary = analysis.VariantSummary;

/** Готовые отчёты: пересчёт только при изменении вводных, справочника, варианта или по «Пересчитать». */
const cache = new Map<string, report.VariantReport>();

interface ReportRun {
  report: report.VariantReport | null;
  progress: report.ReportProgress | null;
}

/** Отчёт по варианту: пробные расчёты по одному, чтобы экран не замирал. */
function useReport(state: AnalysisState, s: VariantSummary | null): ReportRun {
  const key = s ? `${JSON.stringify(state.calc)}|${JSON.stringify(state.versions.map((v) => v.version))}|${s.variant.id}|${state.run}` : null;
  const [run, setRun] = useState<ReportRun>({ report: key ? (cache.get(key) ?? null) : null, progress: null });
  useEffect(() => {
    if (!key || !s) return setRun({ report: null, progress: null });
    const done = cache.get(key);
    if (done) return setRun({ report: done, progress: null });
    setRun({ report: null, progress: { done: 0, total: report.reportTotal(state.calc, state.versions) } });
    const g = report.variantReport(state.calc, s, state.versions);
    let stop = false;
    let t: ReturnType<typeof setTimeout> | undefined;
    const step = () => {
      if (stop) return;
      const r = g.next();
      if (r.done) {
        cache.set(key, r.value);
        setRun({ report: r.value, progress: null });
      } else {
        setRun({ report: null, progress: r.value });
        t = setTimeout(step, 0);
      }
    };
    t = setTimeout(step, 0);
    return () => {
      stop = true;
      clearTimeout(t);
    };
  }, [key]);
  return run;
}

const W = 520;
const H = 190;
const PAD_L = 44;
const PAD_B = 22;
const PAD_T = 14;

/** Шаг шкалы: 1, 2 или 5 × 10ⁿ, чтобы делений было около четырёх. */
function niceStep(range: number): number {
  const raw = range / 4;
  if (raw <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(raw));
  return [1, 2, 5, 10].map((k) => k * p).find((x) => x >= raw) ?? raw;
}

const fmtTick = (v: number) => new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 0 }).format(v).replace("-", "−");

function SalesSvg({ v }: { v: reportView.SalesView }) {
  const step = niceStep(v.max);
  const top = Math.max(step, Math.ceil(v.max / step) * step);
  const ticks = Array.from({ length: Math.round(top / step) + 1 }, (_, i) => i * step);
  const plotW = W - PAD_L - 6;
  const plotH = H - PAD_B - PAD_T;
  const bw = plotW / v.bars.length;
  const y = (x: number) => PAD_T + plotH - (x / top) * plotH;
  const years = v.bars
    .map((b, i) => ({ i, y: b.key.slice(-4) }))
    .filter((b, i, a) => i === 0 || a[i - 1]?.y !== b.y)
    .filter((b, k, a) => !a[k + 1] || ((a[k + 1]?.i ?? 0) - b.i) * bw >= 30);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="chart" role="img" aria-label="Продажи по кварталам, млн руб">
      {ticks.map((t) => (
        <g key={t}>
          <line x1={PAD_L} x2={W - 6} y1={y(t)} y2={y(t)} className={t === 0 ? "ax" : "grid"} />
          <text x={PAD_L - 6} y={y(t) + 4} className="tk" textAnchor="end">
            {fmtTick(t)}
          </text>
        </g>
      ))}
      {v.bars.map((b, i) => {
        const h = Math.max(0, y(0) - y(b.value));
        const x = PAD_L + i * bw + 1;
        const w = Math.max(1, bw - 2);
        return (
          <g key={b.key}>
            <rect x={x} y={y(b.value)} width={w} height={h} rx={Math.min(3, w / 2)} className="bar" />
            <rect x={PAD_L + i * bw} y={PAD_T} width={bw} height={plotH} className="hit">
              <title>{`${b.key}: ${b.text}, продано ${b.shareText} площади`}</title>
            </rect>
          </g>
        );
      })}
      {years.map((yr) => (
        <text key={yr.y} x={PAD_L + yr.i * bw + 2} y={H - 6} className="tk">
          {yr.y}
        </text>
      ))}
    </svg>
  );
}

function CashSvg({ v }: { v: reportView.CashView }) {
  const step = niceStep(v.max - v.min);
  const lo = Math.floor(v.min / step) * step;
  const hi = Math.max(lo + step, Math.ceil(v.max / step) * step);
  const ticks = Array.from({ length: Math.round((hi - lo) / step) + 1 }, (_, i) => lo + i * step);
  const plotW = W - PAD_L - 6;
  const plotH = H - PAD_B - PAD_T;
  const n = v.points.length;
  const x = (i: number) => PAD_L + (n > 1 ? (i / (n - 1)) * plotW : 0);
  const y = (val: number) => PAD_T + ((hi - val) / (hi - lo)) * plotH;
  const peakI = v.points.reduce((m, p, i, a) => (p.value < (a[m]?.value ?? 0) ? i : m), 0);
  const payI = v.payback ? v.points.findIndex((p, i) => i > peakI && p.value >= 0) : -1;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="chart" role="img" aria-label="Накопленный поток денег застройщика, млн руб">
      {ticks.map((t) => (
        <g key={t}>
          <line x1={PAD_L} x2={W - 6} y1={y(t)} y2={y(t)} className={t === 0 ? "ax" : "grid"} />
          <text x={PAD_L - 6} y={y(t) + 4} className="tk" textAnchor="end">
            {fmtTick(t)}
          </text>
        </g>
      ))}
      <polyline points={v.points.map((p, i) => `${x(i)},${y(p.value)}`).join(" ")} className="ln" />
      {v.years.map((yr, k) => {
        const i = v.points.findIndex((p) => p.date === yr.date);
        // Подпись года не налезает на соседнюю: неполный первый год без подписи
        const next = v.years[k + 1];
        if (next && x(v.points.findIndex((p) => p.date === next.date)) - x(i) < 30) return null;
        return (
          <text key={yr.label} x={x(i)} y={H - 6} className="tk">
            {yr.label}
          </text>
        );
      })}
      {v.peak && (
        <circle cx={x(peakI)} cy={y(v.points[peakI]?.value ?? 0)} r={4.5} className="dot">
          <title>{`Пик вложений: ${v.peak}, ${v.peakDate}`}</title>
        </circle>
      )}
      {payI >= 0 && (
        <circle cx={x(payI)} cy={y(v.points[payI]?.value ?? 0)} r={4.5} className="dot ok">
          <title>{`Окупаемость: ${v.payback}`}</title>
        </circle>
      )}
      {v.points.map((p, i) => (
        <rect key={p.date} x={x(i) - plotW / n / 2} y={PAD_T} width={plotW / n} height={plotH} className="hit">
          <title>{`${p.date.slice(5, 7)}.${p.date.slice(0, 4)}: ${fmtTick(p.value)} млн руб`}</title>
        </rect>
      ))}
    </svg>
  );
}

/** Итоговый отчёт по лучшему варианту на экране «Итог». */
export function ReportBlock({ p, state, s, href }: { p: plot.LandProject; state: AnalysisState; s: VariantSummary; href: (sec: "variants" | "plot", tab?: string) => string }) {
  const { report: r, progress } = useReport(state, s);
  const cash = r ? reportView.cashView(r.cash) : null;
  const sales = r ? reportView.salesView(r.sales) : null;
  const tiles = reportView.reportTiles(s, r?.cash ?? null);
  const hurdle = analysis.hurdleIrr(state.calc, state.versions);
  const land = r?.land ? reportView.landReportView(r.land, s.discountRate, hurdle) : null;
  const sens = r?.sens ? reportView.sensView(r.sens) : null;
  const clarify = reportView.clarifyLines(s, hurdle);
  const askedOrigin = site.siteValue(p, "landPrice").origin;
  return (
    <>
      <div className="tiles t4">
        {tiles.map((t) => (
          <div key={t.label} className="tile">
            <div className="l">{t.label}</div>
            <b>{t.value}</b>
            {t.note && <div className="n">{t.note}</div>}
          </div>
        ))}
      </div>
      {progress && (
        <div className="check warn">
          <div>
            Считаем максимальную цену участка и «что, если»: пробный расчёт {progress.done} из {progress.total}. Каждая проба — полный расчёт варианта.
          </div>
        </div>
      )}
      {r?.blocked && (
        <div className="check warn">
          <div>{r.blocked}.</div>
        </div>
      )}
      {land && (
        <div className="card rep">
          <h3>Максимальная цена участка</h3>
          <div className="rep-row">
            <div>
              <div className="small muted">можно заплатить до</div>
              <div className={`rep-big ${land.unprofitable ? "bad" : ""}`}>{land.value}</div>
            </div>
            {land.asked && (
              <div>
                <div className="small muted">цена продавца</div>
                <div className="rep-mid">
                  {land.asked} <OriginTag origin={askedOrigin} />
                </div>
              </div>
            )}
            {land.reserve && (
              <div>
                <div className="small muted">{land.reserveOk ? "запас" : "цена продавца выше максимума"}</div>
                <div className={`rep-mid ${land.reserveOk ? "ok" : "bad"}`}>{land.reserve.replace(/^(запас|не хватает) /, "")}</div>
              </div>
            )}
            {land.irr && (
              <div>
                <div className="small muted">{land.irr.label}</div>
                <div className="rep-mid">{land.irr.value}</div>
              </div>
            )}
          </div>
          <p className="note">{land.how}</p>
          {!land.asked && (
            <p className="small">
              Введите цену продавца, чтобы увидеть запас: <Link href={href("plot", "Сделка")}>1. Участок → Сделка</Link>
            </p>
          )}
        </div>
      )}
      {(sales || cash) && (
        <div className="two rep-two">
          {sales && (
            <div className="card rep">
              <h3>Продажи по кварталам, млн руб</h3>
              <div className="small muted">Стоимость договоров за квартал, всего {sales.total}; к концу продаж продано {sales.bars.at(-1)?.shareText} площади</div>
              <SalesSvg v={sales} />
            </div>
          )}
          {cash && (
            <div className="card rep">
              <h3>Окупаемость, млн руб</h3>
              <div className="small muted">
                Накопленный поток денег застройщика.{cash.peak ? ` Пик вложений ${cash.peak} — ${cash.peakDate}.` : ""}
                {cash.payback ? ` Деньги вернулись — ${cash.payback}.` : " В расчёте вложения не возвращаются."}
              </div>
              <CashSvg v={cash} />
            </div>
          )}
        </div>
      )}
      {sens && (
        <div className="card rep">
          <h3>Что, если цена продаж или ключевая ставка изменится · NPV акционера, млн руб</h3>
          <div className="tw sens">
            <table className="t">
              <thead>
                <tr>
                  <th>Цена продаж (строки), ключевая ставка (столбцы)</th>
                  {sens.cols.map((c) => (
                    <th key={c}>{c}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {sens.rows.map((row) => (
                  <tr key={row.label}>
                    <td>{row.label}</td>
                    {row.cells.map((c, j) => (
                      <td key={j} className={`${c.neg ? "neg" : "pos"}${c.base ? " base" : ""}`}>
                        {c.text}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <ul className="leads">
            <li>{sens.priceLine}.</li>
            <li>{sens.rateLine}.</li>
          </ul>
          <p className="note">
            Каждая клетка — полный расчёт варианта. Ключевая ставка меняется на весь срок; от неё зависит ставка проектного кредита, ставка дисконтирования не меняется. Красным — проект невыгоден. Шаги —{" "}
            <Link href="/reference">по справочнику</Link>.
          </p>
        </div>
      )}
      {clarify.length > 0 && (
        <>
          <h3 className="h3">Уточнить перед решением · {clarify.length}</h3>
          <div className="todo">
            {clarify.map((c) => (
              <div key={c.label} className="todo-it clar">
                <div className="todo-l">
                  <b>{c.label}</b>
                  <div className="small">{c.note}</div>
                </div>
                <Link className="btn sm" href={c.link === "variants" ? href("variants") : "/reference"}>
                  {c.link === "variants" ? "4. Варианты" : "Справочник"}
                </Link>
              </div>
            ))}
          </div>
        </>
      )}
    </>
  );
}
