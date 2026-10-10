"use client";
import { useId, useState, type KeyboardEvent, type PointerEvent } from "react";
import { fmtDay, fmtLongDay } from "./format";
import { niceTicks, useWidth } from "./salesBreakdown";

// ---------------------------------------------------------------------------
// A small multi-series line chart: one shared y-axis (never two), one line per series, a crosshair
// that reads every series at the hovered day, arrow keys for the same, and a table for screen
// readers. Identity is never colour alone: a legend names each line and short labels sit at the
// line ends.
// ---------------------------------------------------------------------------

export interface LineSeries {
  key: string;
  label: string;
  /** A categorical chart colour (var(--viz-cat-N)): fixed per entity, never per rank. */
  color: string;
  values: number[];
}

const MARGIN = { top: 10, right: 12, bottom: 24, left: 52 };
const END_LABEL_W = 0;

export function LineChart({
  days,
  series,
  format,
  fmtAxis,
  label,
  today,
  integer = false,
  height = 180,
}: {
  days: string[];
  series: LineSeries[];
  /** A value as the tooltip and table show it. */
  format: (v: number) => string;
  /** A gridline value, short. `step` is the gap between gridlines (to pick decimals). */
  fmtAxis: (v: number, step: number) => string;
  /** Counts (impressions, clicks): gridlines on whole numbers only. */
  integer?: boolean;
  /** What the chart shows, for screen readers. */
  label: string;
  today?: string;
  height?: number;
}) {
  const [ref, width] = useWidth();
  const [hover, setAt] = useState<number | null>(null);
  const id = useId();
  const n = days.length;
  // The dates can change under a held hover (a shorter range): never read past the new end.
  const at = hover !== null && hover < n ? hover : null;
  const max = Math.max(0, ...series.flatMap((s) => s.values));
  const ticks = niceTicks(integer ? Math.max(max, 4) : max, 4);
  const step = ticks[1] ?? 1;
  const top = ticks[ticks.length - 1] || 1;
  const plotW = Math.max(0, width - MARGIN.left - MARGIN.right - END_LABEL_W);
  const plotH = height - MARGIN.top - MARGIN.bottom;
  const x = (i: number) => MARGIN.left + (n <= 1 ? plotW / 2 : (i / (n - 1)) * plotW);
  const y = (v: number) => MARGIN.top + plotH - (v / top) * plotH;

  // About one date label per 70px, always including the first and last day.
  const every = Math.max(1, Math.ceil(n / Math.max(2, Math.floor(plotW / 70))));
  const xTicks = days.map((d, i) => ({ d, i })).filter(({ i }) => i % every === 0 || i === n - 1);
  if (xTicks.length > 1 && xTicks[xTicks.length - 1]!.i - xTicks[xTicks.length - 2]!.i < every / 2) xTicks.splice(xTicks.length - 2, 1);

  const pick = (e: PointerEvent<SVGRectElement>) => {
    const box = e.currentTarget.getBoundingClientRect();
    const px = e.clientX - box.left;
    setAt(n <= 1 ? 0 : Math.max(0, Math.min(n - 1, Math.round((px / box.width) * (n - 1)))));
  };
  const keys = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
      e.preventDefault();
      const step = e.key === "ArrowRight" ? 1 : -1;
      setAt((i) => Math.max(0, Math.min(n - 1, (i ?? (step > 0 ? -1 : n)) + step)));
    } else if (e.key === "Escape") setAt(null);
  };

  const describe = (i: number) => `${fmtLongDay(days[i]!)}${days[i] === today ? " (today so far)" : ""}: ${series.map((s) => `${s.label} ${format(s.values[i] ?? 0)}`).join(", ")}.`;

  return (
    <div className="min-w-0">
      {series.length > 1 && (
        <div className="mb-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted">
          {series.map((s) => (
            <span key={s.key} className="inline-flex items-center gap-1.5">
              <span aria-hidden className="inline-block h-0.5 w-4 rounded" style={{ background: s.color }} />
              {s.label}
            </span>
          ))}
        </div>
      )}
      <div
        ref={ref}
        className="relative select-none rounded-md outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
        role="figure"
        aria-label={`${label}. Use the left and right arrow keys to read each day.`}
        tabIndex={0}
        onKeyDown={keys}
        onBlur={() => setAt(null)}
      >
        {width > 0 && (
          <svg width={width} height={height} aria-hidden="true" className="block touch-pan-y overflow-visible">
            {ticks.map((t, i) => (
              <g key={i}>
                <line x1={MARGIN.left} x2={MARGIN.left + plotW} y1={y(t)} y2={y(t)} stroke="var(--border)" strokeWidth={1} />
                <text x={MARGIN.left - 6} y={y(t)} dy="0.32em" textAnchor="end" fontSize={11} fill="var(--muted)">
                  {fmtAxis(t, step)}
                </text>
              </g>
            ))}
            {xTicks.map(({ d, i }) => (
              <text key={d} x={x(i)} y={height - 6} textAnchor={n <= 1 ? "middle" : i === 0 ? "start" : i === n - 1 ? "end" : "middle"} fontSize={11} fill="var(--muted)">
                {d === today ? "Today" : fmtDay(d, { year: false })}
              </text>
            ))}
            {series.map((s) =>
              n <= 1 ? (
                <circle key={s.key} cx={x(0)} cy={y(s.values[0] ?? 0)} r={4} fill={s.color} stroke="var(--surface)" strokeWidth={2} />
              ) : (
                <polyline
                  key={s.key}
                  points={s.values.map((v, i) => `${x(i)},${y(v)}`).join(" ")}
                  fill="none"
                  stroke={s.color}
                  strokeWidth={2}
                  strokeLinejoin="round"
                  strokeLinecap="round"
                />
              ),
            )}
            {at !== null && (
              <g>
                <line x1={x(at)} x2={x(at)} y1={MARGIN.top} y2={MARGIN.top + plotH} stroke="var(--muted)" strokeWidth={1} strokeDasharray="3 3" />
                {series.map((s) => (
                  <circle key={s.key} cx={x(at)} cy={y(s.values[at] ?? 0)} r={4} fill={s.color} stroke="var(--surface)" strokeWidth={2} />
                ))}
              </g>
            )}
            <rect
              x={MARGIN.left}
              y={MARGIN.top}
              width={Math.max(plotW, 1)}
              height={plotH}
              fill="transparent"
              onPointerMove={pick}
              onPointerDown={pick}
              onPointerLeave={() => setAt(null)}
            />
          </svg>
        )}
        {at !== null && width > 0 && (
          <div
            className="pointer-events-none absolute z-10 min-w-[10rem] rounded-lg border border-border bg-surface px-3 py-2 text-xs shadow-lg"
            style={{ top: MARGIN.top, left: Math.min(Math.max(0, x(at) + 12), Math.max(0, width - 176)) }}
          >
            <div className="text-muted">{fmtLongDay(days[at]!)}{days[at] === today ? " · today so far" : ""}</div>
            {series.map((s) => (
              <div key={s.key} className="mt-1 flex items-center gap-2">
                <span aria-hidden className="inline-block h-0.5 w-3 shrink-0 rounded" style={{ background: s.color }} />
                <span className="font-semibold tabular-nums text-text">{format(s.values[at] ?? 0)}</span>
                <span className="truncate text-muted">{s.label}</span>
              </div>
            ))}
          </div>
        )}
        <p className="sr-only" aria-live="polite" id={`${id}-live`}>
          {at !== null ? describe(at) : ""}
        </p>
      </div>
      <table className="sr-only">
        <caption>{label}</caption>
        <thead>
          <tr>
            <th scope="col">Day</th>
            {series.map((s) => (
              <th key={s.key} scope="col">{s.label}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {days.map((d, i) => (
            <tr key={d}>
              <th scope="row">{fmtLongDay(d)}</th>
              {series.map((s) => (
                <td key={s.key}>{format(s.values[i] ?? 0)}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
