"use client";
import { useState, type ReactNode } from "react";

// ---------------------------------------------------------------------------------------------
// Charts for Staff Management: stacked or side-by-side columns over time buckets, and ranked
// horizontal bars. Built from plain elements like the dashboard's ColumnChart: a legend names
// every series (never colour alone), each column has a tooltip, and a table carries every value
// for screen readers. Colours are the app's categorical chart tokens.
// ---------------------------------------------------------------------------------------------

export interface Series {
  key: string;
  label: string;
  /** A CSS colour, normally var(--viz-cat-N). */
  color: string;
  values: number[];
}

export const VIZ = ["var(--viz-cat-1)", "var(--viz-cat-2)", "var(--viz-cat-3)"] as const;

function Legend({ series }: { series: Series[] }) {
  return (
    <ul className="mb-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted">
      {series.map((s) => (
        <li key={s.key} className="inline-flex items-center gap-1.5">
          <span aria-hidden className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: s.color }} />
          {s.label}
        </li>
      ))}
    </ul>
  );
}

/**
 * Columns per bucket: stacked (parts of one total, e.g. regular + overtime) or grouped (things to
 * compare side by side, e.g. paid vs still owed).
 */
export function ColumnsChart({
  labels,
  series,
  format,
  label,
  mode = "stacked",
  height = "h-48",
  empty,
}: {
  labels: string[];
  series: Series[];
  format: (v: number) => string;
  label: string;
  mode?: "stacked" | "grouped";
  height?: string;
  empty?: ReactNode;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const n = labels.length;
  const totals = labels.map((_, i) => series.reduce((a, s) => a + (s.values[i] ?? 0), 0));
  const max = mode === "stacked" ? Math.max(0, ...totals) : Math.max(0, ...series.flatMap((s) => s.values));
  const tickEvery = Math.max(1, Math.ceil(n / 8));
  if (max <= 0 && empty) return <div className="rounded-lg border border-dashed border-border px-3 py-10 text-center text-sm text-muted">{empty}</div>;
  return (
    <figure className="min-w-0">
      <Legend series={series} />
      <div className={`relative flex ${height} items-end gap-[3px] border-b border-border`} role="img" aria-label={label} onMouseLeave={() => setHover(null)}>
        {labels.map((l, i) => {
          const align = i < n * 0.25 ? "left-0" : i >= n * 0.75 ? "right-0" : "left-1/2 -translate-x-1/2";
          return (
            <div key={l + i} className="relative flex h-full min-w-0 flex-1 items-end justify-center gap-[2px]" onMouseEnter={() => setHover(i)} onFocus={() => setHover(i)} tabIndex={-1}>
              {mode === "stacked" ? (
                <div className={`flex w-full max-w-8 flex-col-reverse overflow-hidden rounded-t transition-opacity ${hover !== null && hover !== i ? "opacity-60" : ""}`} style={{ height: max > 0 ? `${(totals[i]! / max) * 100}%` : "0%", minHeight: totals[i]! > 0 ? 2 : 0 }}>
                  {series.map((s) => (
                    <div key={s.key} style={{ background: s.color, flexGrow: s.values[i] ?? 0, flexBasis: 0 }} />
                  ))}
                </div>
              ) : (
                series.map((s) => (
                  <div
                    key={s.key}
                    className={`w-full max-w-4 rounded-t transition-opacity ${hover !== null && hover !== i ? "opacity-60" : ""}`}
                    style={{ background: s.color, height: max > 0 ? `${((s.values[i] ?? 0) / max) * 100}%` : "0%", minHeight: (s.values[i] ?? 0) > 0 ? 2 : 0 }}
                  />
                ))
              )}
              {hover === i && (
                <div className={`pointer-events-none absolute top-0 z-10 -translate-y-full whitespace-nowrap rounded-md border border-border bg-surface px-2 py-1 text-xs shadow ${align}`}>
                  <div className="text-muted">{l}</div>
                  {series.map((s) => (
                    <div key={s.key} className="flex items-center gap-1.5 tabular-nums">
                      <span aria-hidden className="inline-block h-2 w-2 rounded-sm" style={{ background: s.color }} />
                      {s.label}: <span className="font-medium">{format(s.values[i] ?? 0)}</span>
                    </div>
                  ))}
                  {mode === "stacked" && series.length > 1 && <div className="mt-0.5 border-t border-border pt-0.5 font-medium tabular-nums">Total: {format(totals[i]!)}</div>}
                </div>
              )}
            </div>
          );
        })}
      </div>
      <div className="mt-1 flex gap-[3px] text-[11px] text-muted" aria-hidden>
        {labels.map((l, i) => (
          <span key={l + i} className="relative flex min-w-0 flex-1 justify-center">
            {i % tickEvery === 0 && <span className="absolute whitespace-nowrap">{shortLabel(l)}</span>}
          </span>
        ))}
      </div>
      <div className="h-5" aria-hidden />
      <div className="sr-only">
        <table>
          <caption>{label}</caption>
          <thead>
            <tr>
              <th scope="col">Period</th>
              {series.map((s) => (
                <th key={s.key} scope="col">
                  {s.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {labels.map((l, i) => (
              <tr key={l + i}>
                <th scope="row">{l}</th>
                {series.map((s) => (
                  <td key={s.key}>{format(s.values[i] ?? 0)}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </figure>
  );
}

/** Axis labels stay short: "Week of 12 Oct" -> "12 Oct", "14 Oct 09:00" -> "09:00". */
function shortLabel(l: string) {
  if (l.startsWith("Week of ")) return l.slice(8);
  const hour = /\s(\d{2}:00)$/.exec(l);
  return hour ? hour[1]! : l;
}

/** Ranked horizontal bars (employee cost comparison and similar). */
export function RankedBars({ rows, format, label }: { rows: Array<{ key: string; label: ReactNode; sub?: ReactNode; value: number; display?: string }>; format: (v: number) => string; label: string }) {
  const max = Math.max(0, ...rows.map((r) => r.value));
  return (
    <ul className="space-y-3" aria-label={label}>
      {rows.map((r) => {
        const pct = max > 0 ? (r.value / max) * 100 : 0;
        return (
          <li key={r.key} className="min-w-0">
            <div className="flex items-baseline justify-between gap-3 text-sm">
              <span className="min-w-0 truncate">{r.label}</span>
              <span className="shrink-0 font-medium tabular-nums">{r.display ?? format(r.value)}</span>
            </div>
            <div className="mt-1.5 h-2 rounded-full bg-bg">
              <div className="animate-grow-x h-2 rounded-full" style={{ width: `${pct}%`, minWidth: pct > 0 ? 4 : 0, background: VIZ[0] }} />
            </div>
            {r.sub && <p className="mt-1 text-xs text-muted">{r.sub}</p>}
          </li>
        );
      })}
    </ul>
  );
}
