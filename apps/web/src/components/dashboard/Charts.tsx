"use client";
import { useState, type ReactNode } from "react";

/**
 * Single-series column chart built from plain divs: thin columns (≤ 24px) with
 * rounded tops on one hairline baseline, the highlighted column in the accent
 * and the rest in a lighter step of it, a hover tooltip per column, and a
 * screen-reader table with every value.
 */
export function ColumnChart({
  values,
  labels,
  tickLabels,
  highlight,
  format,
  label,
  height = "h-32",
}: {
  values: number[];
  /** Full label per column (tooltip + table). */
  labels: string[];
  /** Optional shorter axis labels; empty strings are skipped. Defaults to `labels`. */
  tickLabels?: string[];
  highlight: number | null;
  format: (n: number) => string;
  label: string;
  height?: string;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const max = Math.max(...values, 0);
  const n = values.length;
  const ticks = tickLabels ?? labels;

  return (
    <figure className="relative min-w-0">
      <figcaption className="mb-2 text-xs text-muted">{label}</figcaption>
      <div className={`relative flex ${height} items-end gap-[2px] border-b border-border`} role="img" aria-label={label} onMouseLeave={() => setHover(null)}>
        {values.map((v, i) => {
          const align = i < n * 0.2 ? "left-0" : i >= n * 0.8 ? "right-0" : "left-1/2 -translate-x-1/2";
          return (
            <div key={i} className="relative flex h-full min-w-0 flex-1 items-end justify-center" onMouseEnter={() => setHover(i)}>
              <div
                className={`animate-grow-y w-full max-w-6 rounded-t transition-[opacity,height] duration-500 ${i === highlight ? "bg-gradient-to-t from-accent to-accent-2" : "bg-accent/35"} ${hover !== null && hover !== i ? "opacity-60" : ""}`}
                style={{ height: max > 0 ? `${(v / max) * 100}%` : "0%", minHeight: v > 0 ? 2 : 0, ["--i" as string]: i }}
              />
              {hover === i && (
                <div className={`pointer-events-none absolute top-0 z-10 -translate-y-full whitespace-nowrap rounded-md border border-border bg-surface px-2 py-1 text-xs shadow ${align}`}>
                  <div className="text-muted">{labels[i]}</div>
                  <div className="font-medium tabular-nums">{format(v)}</div>
                </div>
              )}
            </div>
          );
        })}
      </div>
      <div className="mt-1 flex gap-[2px] text-[11px] text-muted" aria-hidden>
        {ticks.map((t, i) => (
          <span key={i} className="relative flex min-w-0 flex-1 justify-center">
            {t && <span className="absolute whitespace-nowrap">{t}</span>}
          </span>
        ))}
      </div>
      <div className="h-4" aria-hidden />
      {/* The sr-only wrapper (not the table itself) keeps the table from widening the page. */}
      <div className="sr-only">
        <table>
          <caption>{label}</caption>
          <tbody>
            {values.map((v, i) => (
              <tr key={i}>
                <th scope="row">{labels[i]}</th>
                <td>{format(v)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </figure>
  );
}

/** One row of a ranked list with a proportional bar (share of the largest or of the total). */
export function BarRow({ label, sub, value, fraction }: { label: ReactNode; sub?: ReactNode; value: ReactNode; fraction: number }) {
  const pct = Math.max(0, Math.min(1, fraction)) * 100;
  return (
    <li className="min-w-0">
      <div className="flex items-baseline justify-between gap-3 text-sm">
        <span className="min-w-0 truncate">{label}</span>
        <span className="shrink-0 font-medium tabular-nums">{value}</span>
      </div>
      <div className="mt-1.5 h-2 rounded-full bg-bg">
        <div className="animate-grow-x h-2 rounded-full bg-gradient-to-r from-accent to-accent/70 transition-[width] duration-700" style={{ width: `${pct}%`, minWidth: pct > 0 ? 4 : 0 }} />
      </div>
      {sub && <p className="mt-1 text-xs text-muted">{sub}</p>}
    </li>
  );
}

export interface Segment {
  label: string;
  value: number;
  /** Fill class from the app tokens (bg-good, bg-accent, …). */
  fill: string;
}

/** Part-to-whole bar: segments separated by a 2px surface gap, with a labelled legend (never color alone). */
export function StackedBar({ segments, format = (n) => new Intl.NumberFormat().format(n), label }: { segments: Segment[]; format?: (n: number) => string; label: string }) {
  const total = segments.reduce((a, s) => a + s.value, 0);
  const pct = (v: number) => (total > 0 ? new Intl.NumberFormat(undefined, { style: "percent", maximumFractionDigits: 0 }).format(v / total) : "—");
  return (
    <figure className="min-w-0">
      <div className="animate-grow-x flex h-3 gap-[2px] overflow-hidden rounded-full bg-bg" role="img" aria-label={`${label}: ${segments.map((s) => `${s.label} ${format(s.value)}`).join(", ")}`}>
        {segments
          .filter((s) => s.value > 0)
          .map((s) => (
            <div key={s.label} className={`${s.fill} h-full`} style={{ flexGrow: s.value, flexBasis: 0, minWidth: 4 }} title={`${s.label}: ${format(s.value)} (${pct(s.value)})`} />
          ))}
      </div>
      <ul className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1.5 text-xs sm:grid-cols-4">
        {segments.map((s) => (
          <li key={s.label} className="flex min-w-0 items-center gap-1.5">
            <span aria-hidden className={`h-2 w-2 shrink-0 rounded-full ${s.fill}`} />
            <span className="truncate text-muted">{s.label}</span>
            <span className="ml-auto font-medium tabular-nums">{format(s.value)}</span>
          </li>
        ))}
      </ul>
    </figure>
  );
}
