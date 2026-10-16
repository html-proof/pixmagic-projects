"use client";
import { useId, useState, type KeyboardEvent, type PointerEvent } from "react";
import { fmtDay, fmtLongDay } from "./format";
import { columnPath, columnWidth, niceTicks, useWidth } from "./chartUtils";

// ---------------------------------------------------------------------------
// A small multi-series line chart: one shared y-axis (never two), one line per series, a crosshair
// that reads every series at the hovered day, arrow keys for the same, and a table for screen
// readers. Identity is never colour alone: a legend names each line and short labels sit at the
// line ends. With `bars`, each day is a column instead (series side by side), and the hovered day
// stays solid while the rest dim.
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
  area = false,
  grid = false,
  floor = 0,
  bars = false,
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
  /** Shade the area under each line with a fade of its colour. */
  area?: boolean;
  /** Faint dashed lines down from each date label. */
  grid?: boolean;
  /** The y-axis reaches at least this high, so an all-zero chart still has a scale. */
  floor?: number;
  /** A column per day instead of a line (`area` is ignored). Today's column is lighter: the day isn't over. */
  bars?: boolean;
}) {
  const [ref, width] = useWidth();
  const [hover, setAt] = useState<number | null>(null);
  const id = useId();
  // An id that is also safe inside url(#…).
  const fillId = `fill-${id.replace(/[^\w-]/g, "")}`;
  const n = days.length;
  // The dates can change under a held hover (a shorter range): never read past the new end.
  const at = hover !== null && hover < n ? hover : null;
  const max = Math.max(0, ...series.flatMap((s) => s.values));
  const ticks = niceTicks(Math.max(max, floor, integer ? 4 : 0), 4);
  const step = ticks[1] ?? 1;
  const top = ticks[ticks.length - 1] || 1;
  const plotW = Math.max(0, width - MARGIN.left - MARGIN.right - END_LABEL_W);
  const plotH = height - MARGIN.top - MARGIN.bottom;
  // Bars sit in the middle of equal slots; line points run edge to edge.
  const slot = n ? plotW / n : 0;
  const barW = columnWidth(slot);
  const x = (i: number) => MARGIN.left + (bars ? slot * (i + 0.5) : n <= 1 ? plotW / 2 : (i / (n - 1)) * plotW);
  const y = (v: number) => MARGIN.top + plotH - (v / top) * plotH;

  // About one date label per 70px, always including the first and last day.
  const every = Math.max(1, Math.ceil(n / Math.max(2, Math.floor(plotW / 70))));
  const xTicks = days.map((d, i) => ({ d, i })).filter(({ i }) => i % every === 0 || i === n - 1);
  if (xTicks.length > 1 && xTicks[xTicks.length - 1]!.i - xTicks[xTicks.length - 2]!.i < every / 2) xTicks.splice(xTicks.length - 2, 1);
  // The first and last labels line up with the plot's edges: a line's ends, the outer bars' sides.
  const tickX = (i: number) => x(i) + (bars && n > 1 ? (i === 0 ? -barW / 2 : i === n - 1 ? barW / 2 : 0) : 0);

  const pick = (e: PointerEvent<SVGRectElement>) => {
    const box = e.currentTarget.getBoundingClientRect();
    const px = e.clientX - box.left;
    if (n <= 1) setAt(0);
    else if (bars) setAt(Math.max(0, Math.min(n - 1, Math.floor((px / box.width) * n))));
    else setAt(Math.max(0, Math.min(n - 1, Math.round((px / box.width) * (n - 1)))));
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
              <span aria-hidden className={bars ? "inline-block h-2.5 w-2.5 rounded-sm" : "inline-block h-0.5 w-4 rounded"} style={{ background: s.color }} />
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
            {area && !bars && (
              <defs>
                {series.map((s) => (
                  <linearGradient key={s.key} id={`${fillId}-${s.key}`} x1="0" x2="0" y1="0" y2="1">
                    <stop offset="0%" stopColor={s.color} stopOpacity="0.22" />
                    <stop offset="100%" stopColor={s.color} stopOpacity="0" />
                  </linearGradient>
                ))}
              </defs>
            )}
            {grid &&
              xTicks.map(({ d, i }) => (
                <line key={`v-${d}`} x1={x(i)} x2={x(i)} y1={MARGIN.top} y2={MARGIN.top + plotH} stroke="var(--border)" strokeWidth={1} strokeDasharray="3 4" />
              ))}
            {ticks.map((t, i) => (
              <g key={i}>
                <line x1={MARGIN.left} x2={MARGIN.left + plotW} y1={y(t)} y2={y(t)} stroke="var(--border)" strokeWidth={1} />
                <text x={MARGIN.left - 6} y={y(t)} dy="0.32em" textAnchor="end" fontSize={11} fill="var(--muted)">
                  {fmtAxis(t, step)}
                </text>
              </g>
            ))}
            {xTicks.map(({ d, i }) => (
              <text key={d} x={tickX(i)} y={height - 6} textAnchor={n <= 1 ? "middle" : i === 0 ? "start" : i === n - 1 ? "end" : "middle"} fontSize={11} fill="var(--muted)">
                {d === today ? "Today" : fmtDay(d, { year: false })}
              </text>
            ))}
            {bars &&
              series.map((s, j) => (
                <g key={s.key} fill={s.color} className="animate-fade">
                  {s.values.map((v, i) => {
                    if (!v) return null;
                    const w = barW / series.length;
                    // A day with very little still shows a sliver, so it never reads as nothing.
                    const yTop = Math.abs(y(v) - y(0)) < 2 ? y(0) - Math.sign(v) * 2 : y(v);
                    const dim = (at !== null && at !== i ? 0.45 : 1) * (days[i] === today ? 0.45 : 1);
                    return <path key={i} d={columnPath(x(i) - barW / 2 + j * w, w, y(0), yTop)} opacity={dim} style={{ transition: "opacity 120ms" }} />;
                  })}
                </g>
              ))}
            {!bars &&
              area &&
              n > 1 &&
              series.map((s) => (
                <path
                  key={`a-${s.key}`}
                  d={`M${x(0)},${y(0)} ${s.values.map((v, i) => `L${x(i)},${y(v)}`).join(" ")} L${x(n - 1)},${y(0)} Z`}
                  fill={`url(#${fillId}-${s.key})`}
                  className="animate-fade"
                />
              ))}
            {!bars &&
              series.map((s) =>
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
            {at !== null && !bars && (
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
                <span aria-hidden className={bars ? "inline-block h-2.5 w-2.5 shrink-0 rounded-sm" : "inline-block h-0.5 w-3 shrink-0 rounded"} style={{ background: s.color }} />
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
      {/* The sr-only wrapper (not the table itself) keeps the table from widening the page. */}
      <div className="sr-only">
        <table>
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
    </div>
  );
}
