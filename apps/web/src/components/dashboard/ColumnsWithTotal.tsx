"use client";
/**
 * The chart: columns over a running-total strip that shares their x positions.
 *
 * The running total gets its own strip and scale rather than a second y-axis on the columns:
 * two scales on one plot line up arbitrarily, so the line's crossings would read as meaning
 * something. Hovering (or arrowing through) a column reads out both at once. Used by the sales
 * cards (SalesBreakdown.tsx) and the ad panels.
 */
import { useId, useState, type KeyboardEvent, type ReactNode } from "react";
import { columnPath, columnWidth, niceTicks, useWidth } from "./chartUtils";

export interface Column {
  key: string;
  value: number;
  fill: string;
  /** A period still running, or only partly imported: drawn lighter. */
  faded?: boolean;
  /** Not imported at all: a quiet band instead of a column. */
  missing?: boolean;
  /** Weekend days get a faint band behind them. */
  shaded?: boolean;
  running: number | null;
  tick: { top: string; bottom?: string; strong?: boolean; major?: boolean };
  /** Value written on the column's cap, when there's room for every one. */
  label?: string;
  /** Labelled even when the others can't be (best day, today). */
  keepLabel?: boolean;
  /** A short change readout above the label (month on month). */
  note?: { text: string; tone: "good" | "danger" };
}

const MARGIN = { left: 52, right: 10 };
const PLOT_H = 190;
const RUN_H = 64;
const FONT = 11;
/** Rough width of a label at 11px, for deciding what fits without measuring the DOM. */
const textWidth = (s: string) => s.length * 6.3 + 6;

export function ColumnsWithTotal({
  columns,
  label,
  fmtAxis,
  reference,
  runningLabel,
  fmtRunning,
  tooltip,
  describe,
  missingLabel,
}: {
  columns: Column[];
  /** What the chart shows, for assistive technology. */
  label: string;
  fmtAxis: (n: number) => string;
  /** A hairline across the plot (the average day). */
  reference?: number | null;
  runningLabel: string;
  fmtRunning: (n: number) => string;
  tooltip: (i: number) => ReactNode;
  describe: (i: number) => string;
  missingLabel: string;
}) {
  const [ref, width] = useWidth();
  const hatchId = `hatch-${useId().replace(/:/g, "")}`;
  const [active, setActive] = useState<number | null>(null);
  const n = columns.length;
  const plotW = Math.max(0, width - MARGIN.left - MARGIN.right);
  const slot = n ? plotW / n : 0;
  const barW = columnWidth(slot);
  const cx = (i: number) => MARGIN.left + slot * (i + 0.5);

  // Labels on every cap only when each fits its slot; otherwise just the ones that matter.
  const labelled = columns.filter((c) => c.label && !c.missing);
  const allFit = labelled.every((c) => textWidth(c.label!) <= slot + 2);
  const showLabel = (c: Column) => !!c.label && !c.missing && (allFit || c.keepLabel);
  const showNotes = allFit && columns.some((c) => c.note);
  const top = showNotes ? 34 : columns.some(showLabel) ? 20 : 10;

  const values = columns.filter((c) => !c.missing).map((c) => c.value);
  const max = Math.max(0, ...values, reference ?? 0);
  const min = Math.min(0, ...values);
  const yTicks = niceTicks(max, 4);
  const yMax = yTicks.at(-1)! || 1;
  const yMin = min < 0 ? -niceTicks(-min, 1).at(-1)! : 0;
  const y = (v: number) => top + (1 - (v - yMin) / (yMax - yMin)) * PLOT_H;

  const allTicks = slot >= 26;
  const twoLineTicks = allTicks && columns.some((c) => c.tick.bottom);
  const tickH = twoLineTicks ? 30 : 18;
  const runTop = top + PLOT_H + tickH + 30;

  const runs = columns.map((c) => c.running);
  const runMax = Math.max(0, ...runs.filter((r): r is number => r !== null));
  const runMin = Math.min(0, ...runs.filter((r): r is number => r !== null));
  const runTicks = niceTicks(runMax, 3);
  const rMax = runTicks.at(-1)! || 1;
  const yr = (v: number) => runTop + (1 - (v - runMin) / (rMax - runMin)) * RUN_H;
  const height = runTop + RUN_H + 8;

  // The running total as line segments, broken across days that weren't imported.
  const segments: Array<Array<[number, number]>> = [];
  runs.forEach((r, i) => {
    if (r === null) return;
    const prev = i > 0 ? runs[i - 1] : null;
    if (prev === null || prev === undefined || !segments.length) segments.push([]);
    segments.at(-1)!.push([cx(i), yr(r)]);
  });
  const lastRun = runs.reduce<number | null>((a, r, i) => (r !== null ? i : a), null);

  // Contiguous stretches that weren't imported, drawn as one band each.
  const missingRuns: Array<[number, number]> = [];
  columns.forEach((c, i) => {
    if (!c.missing) return;
    const last = missingRuns.at(-1);
    if (last && last[1] === i - 1) last[1] = i;
    else missingRuns.push([i, i]);
  });

  // Ticks: every column when they fit, otherwise the major ones that don't collide.
  const ticks: number[] = [];
  let lastRight = -Infinity;
  columns.forEach((c, i) => {
    if (allTicks) return ticks.push(i);
    if (!c.tick.major) return;
    const w = textWidth(c.tick.top);
    if (cx(i) - w / 2 < lastRight + 4) return;
    ticks.push(i);
    lastRight = cx(i) + w / 2;
  });

  const indexAt = (clientX: number, rect: DOMRect) => {
    const i = Math.floor((clientX - rect.left - MARGIN.left) / slot);
    return i >= 0 && i < n ? i : null;
  };
  const onKey = (e: KeyboardEvent) => {
    const at = active ?? n - 1;
    const next = e.key === "ArrowLeft" ? at - 1 : e.key === "ArrowRight" ? at + 1 : e.key === "Home" ? 0 : e.key === "End" ? n - 1 : null;
    if (e.key === "Escape") return setActive(null);
    if (next === null) return;
    e.preventDefault();
    setActive(Math.max(0, Math.min(n - 1, next)));
  };

  const tipLeft = active === null ? 0 : cx(active);
  const tipAlign = tipLeft < 130 ? "translateX(-12px)" : tipLeft > width - 130 ? "translateX(calc(-100% + 12px))" : "translateX(-50%)";

  return (
    <div
      ref={ref}
      className="relative mt-4 select-none rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
      tabIndex={0}
      role="group"
      aria-label={`${label}. Use the left and right arrow keys to read each column.`}
      onKeyDown={onKey}
      onFocus={() => setActive((a) => a ?? (n ? n - 1 : null))}
      onBlur={() => setActive(null)}
    >
      <p className="sr-only" aria-live="polite">{active !== null ? describe(active) : ""}</p>
      {width > 0 && n > 0 && (
        <svg
          width={width}
          height={height}
          className="block touch-pan-y"
          aria-hidden
          onPointerMove={(e) => setActive(indexAt(e.clientX, e.currentTarget.getBoundingClientRect()))}
          onPointerDown={(e) => setActive(indexAt(e.clientX, e.currentTarget.getBoundingClientRect()))}
          onPointerLeave={() => setActive(null)}
        >
          <defs>
            {/* Days that weren't imported: hatched, so they never pass for weekend bands or $0 days. */}
            <pattern id={hatchId} width={6} height={6} patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
              <rect width={6} height={6} fill="var(--border)" opacity={0.25} />
              <line x1={0} y1={0} x2={0} y2={6} stroke="var(--border)" strokeWidth={2} />
            </pattern>
          </defs>
          {/* Weekend bands, then the stretch nobody imported. */}
          {columns.map((c, i) =>
            c.shaded && !c.missing ? (
              <rect key={`w${c.key}`} x={MARGIN.left + slot * i} y={top} width={slot} height={PLOT_H} fill="var(--border)" opacity={0.35} />
            ) : null,
          )}
          {missingRuns.map(([a, b]) => {
            const x = MARGIN.left + slot * a;
            const w = slot * (b - a + 1);
            return (
              <g key={`m${a}`}>
                <rect x={x} y={top} width={w} height={PLOT_H} fill={`url(#${hatchId})`} />
                {w >= textWidth(missingLabel) + 8 && (
                  <>
                    <rect x={x + w / 2 - textWidth(missingLabel) / 2} y={top + 8} width={textWidth(missingLabel)} height={18} rx={4} fill="var(--surface)" />
                    <text x={x + w / 2} y={top + 21} textAnchor="middle" fontSize={FONT} fill="var(--muted)">{missingLabel}</text>
                  </>
                )}
              </g>
            );
          })}

          {/* Grid and axis: solid hairlines, labels in muted ink. */}
          {yTicks.map((t) => (
            <g key={`g${t}`}>
              <line x1={MARGIN.left} x2={width - MARGIN.right} y1={y(t)} y2={y(t)} stroke="var(--border)" />
              <text x={MARGIN.left - 8} y={y(t) + 4} textAnchor="end" fontSize={FONT} fill="var(--muted)" className="tabular-nums">{fmtAxis(t)}</text>
            </g>
          ))}
          {yMin < 0 && <line x1={MARGIN.left} x2={width - MARGIN.right} y1={y(0)} y2={y(0)} stroke="var(--muted)" opacity={0.6} />}
          {reference != null && reference > 0 && (
            <line x1={MARGIN.left} x2={width - MARGIN.right} y1={y(reference)} y2={y(reference)} stroke="var(--text)" opacity={0.45} />
          )}

          {columns.map((c, i) => {
            if (c.missing) return null;
            const h = Math.abs(y(c.value) - y(0));
            const yTop = c.value === 0 ? y(0) : h < 2 ? y(0) - Math.sign(c.value) * 2 : y(c.value);
            const dim = active !== null && active !== i;
            return (
              <g key={c.key} opacity={dim ? 0.45 : 1} style={{ transition: "opacity 120ms" }}>
                {c.value !== 0 && <path d={columnPath(cx(i) - barW / 2, barW, y(0), yTop)} fill={c.fill} opacity={c.faded ? 0.45 : 1} />}
                {showLabel(c) && (
                  <text
                    x={Math.min(Math.max(cx(i), MARGIN.left + textWidth(c.label!) / 2), width - MARGIN.right - textWidth(c.label!) / 2)}
                    y={Math.min(yTop, y(0)) - 5}
                    textAnchor="middle"
                    fontSize={FONT}
                    fontWeight={c.keepLabel ? 600 : 500}
                    fill="var(--text)"
                    className="tabular-nums"
                  >
                    {c.label}
                  </text>
                )}
                {showNotes && c.note && (
                  <text x={cx(i)} y={Math.min(yTop, y(0)) - 19} textAnchor="middle" fontSize={FONT} fontWeight={600} fill={c.note.tone === "good" ? "var(--good)" : "var(--danger)"}>
                    {c.note.text}
                  </text>
                )}
              </g>
            );
          })}

          {ticks.map((i) => {
            const t = columns[i]!.tick;
            return (
              <g key={`t${i}`} fontSize={FONT} textAnchor="middle">
                <text x={cx(i)} y={top + PLOT_H + 14} fill={t.strong ? "var(--text)" : "var(--muted)"} fontWeight={t.strong ? 600 : 400}>{t.top}</text>
                {twoLineTicks && t.bottom && (
                  <text x={cx(i)} y={top + PLOT_H + 27} fill={t.strong ? "var(--text)" : "var(--muted)"} fontWeight={t.strong ? 600 : 400} fontSize={10}>{t.bottom}</text>
                )}
              </g>
            );
          })}

          {/* Running total strip. */}
          <text x={MARGIN.left} y={runTop - 8} fontSize={FONT} fill="var(--muted)">{runningLabel}</text>
          {runTicks.map((t) => (
            <g key={`r${t}`}>
              <line x1={MARGIN.left} x2={width - MARGIN.right} y1={yr(t)} y2={yr(t)} stroke="var(--border)" />
              <text x={MARGIN.left - 8} y={yr(t) + 4} textAnchor="end" fontSize={FONT} fill="var(--muted)" className="tabular-nums">{fmtAxis(t)}</text>
            </g>
          ))}
          {segments.map((pts, k) => {
            const line = pts.map(([px, py], j) => `${j ? "L" : "M"}${px.toFixed(1)},${py.toFixed(1)}`).join("");
            const area = `${line}L${pts.at(-1)![0].toFixed(1)},${yr(Math.max(0, runMin)).toFixed(1)}L${pts[0]![0].toFixed(1)},${yr(Math.max(0, runMin)).toFixed(1)}Z`;
            return (
              <g key={`s${k}`}>
                <path d={area} fill="var(--viz-total)" opacity={0.1} />
                <path d={line} fill="none" stroke="var(--viz-total)" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
              </g>
            );
          })}
          {lastRun !== null && (
            <>
              <circle cx={cx(lastRun)} cy={yr(runs[lastRun]!)} r={4} fill="var(--viz-total)" stroke="var(--surface)" strokeWidth={2} />
              <text x={Math.min(cx(lastRun), width - MARGIN.right)} y={yr(runs[lastRun]!) - 9} textAnchor="end" fontSize={FONT} fontWeight={600} fill="var(--text)" className="tabular-nums">
                {fmtRunning(runs[lastRun]!)}
              </text>
            </>
          )}

          {active !== null && (
            <>
              <line x1={cx(active)} x2={cx(active)} y1={top} y2={runTop + RUN_H} stroke="var(--muted)" opacity={0.5} />
              {runs[active] !== null && (
                <circle cx={cx(active)} cy={yr(runs[active]!)} r={4} fill="var(--viz-total)" stroke="var(--surface)" strokeWidth={2} />
              )}
            </>
          )}
        </svg>
      )}
      {width === 0 && <div style={{ height: PLOT_H + RUN_H + 90 }} />}
      {active !== null && width > 0 && (
        <div
          className="pointer-events-none absolute z-10 min-w-40 rounded-md border border-border bg-surface px-3 py-2 text-xs shadow-lg"
          style={{ left: tipLeft, top: 0, transform: `${tipAlign} translateY(-100%)` }}
        >
          {tooltip(active)}
        </div>
      )}
    </div>
  );
}
