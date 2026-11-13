"use client";
import { useState, type KeyboardEvent, type PointerEvent } from "react";
import { fmtMoney } from "@/lib/api";
import { fmtDay, fmtLongDay, fmtSpan } from "./format";
import type { Overview } from "./types";

// The Sales page's "Sales by day" (SalesViews.tsx): one bar per day of the dates, on a plain white
// panel (globals.css `home-card`).

/** Up to five day labels under the bars: the first, the last, and a few evenly between (each week, on 30 days). */
function tickDays(n: number): number[] {
  if (n <= 1) return n ? [0] : [];
  const step = Math.max(1, Math.round((n - 1) / 4));
  const out: number[] = [];
  for (let i = 0; i < n - 1; i += step) out.push(i);
  // The last day always; the one before it gives way when the two would touch.
  if (out.length > 1 && n - 1 - out[out.length - 1]! < step / 2) out.pop();
  out.push(n - 1);
  return out;
}

/**
 * The design's bars: a dark green column per day, today's paler with "today so far" over it. No
 * axis: the tooltip, the arrow keys and the table for screen readers give each day's figure.
 */
function DayBars({
  days,
  values,
  today,
  label,
  money,
}: {
  days: string[];
  values: number[];
  today: string;
  label: string;
  money: (n: number) => string;
}) {
  const n = days.length;
  const [hover, setAt] = useState<number | null>(null);
  // The dates can change under a held hover (a shorter range): never read past the new end.
  const at = hover !== null && hover < n ? hover : null;
  const top = Math.max(0, ...values) || 1;
  const pct = (v: number) => (Math.max(0, v) / top) * 100;
  const gap = n > 90 ? "gap-0" : n > 45 ? "gap-px" : "gap-1 sm:gap-1.5";
  const todayAt = days.indexOf(today);
  const name = (i: number) => `${fmtLongDay(days[i]!)}${i === todayAt ? " · today so far" : ""}`;
  const describe = (i: number) => `${name(i)}: ${label} ${money(values[i]!)}.`;
  // A label or tag over day i: from its column's left in the left half, from its right in the right half, so it never leaves the chart.
  const anchor = (i: number) => (i < n / 2 ? { left: `${(i / n) * 100}%` } : { right: `${((n - 1 - i) / n) * 100}%` });

  const pick = (e: PointerEvent<HTMLDivElement>) => {
    const box = e.currentTarget.getBoundingClientRect();
    setAt(Math.max(0, Math.min(n - 1, Math.floor(((e.clientX - box.left) / box.width) * n))));
  };
  const keys = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
      e.preventDefault();
      const step = e.key === "ArrowRight" ? 1 : -1;
      setAt((i) => Math.max(0, Math.min(n - 1, (i ?? (step > 0 ? -1 : n)) + step)));
    } else if (e.key === "Escape") setAt(null);
  };

  return (
    <div className="min-w-0">
      <div
        className="relative rounded-md pt-7 outline-none select-none focus-visible:ring-2 focus-visible:ring-accent/60"
        role="figure"
        aria-label={`${label} by day. Use the left and right arrow keys to read each day.`}
        tabIndex={0}
        onKeyDown={keys}
        onBlur={() => setAt(null)}
      >
        <div className="relative h-44 touch-pan-y" onPointerMove={pick} onPointerLeave={() => setAt(null)} data-testid="day-bars">
          <div aria-hidden className={`grid h-full items-end border-b border-home-line ${gap}`} style={{ gridTemplateColumns: `repeat(${n}, minmax(0, 1fr))` }}>
            {values.map((v, i) => (
              <div key={days[i]} className="flex h-full items-end justify-center">
                <div
                  className={`animate-grow-y w-full max-w-12 rounded-t-[2px] bg-accent transition-opacity ${i === todayAt ? "opacity-35" : at !== null && at !== i ? "opacity-55" : ""}`}
                  style={{ height: `${pct(v)}%`, ["--i" as string]: Math.round((i * 24) / n) }}
                />
              </div>
            ))}
          </div>
          {todayAt >= 0 && at === null && (
            <span aria-hidden className="pointer-events-none absolute rounded bg-home-tag px-1 py-0.5 text-[11px] leading-none whitespace-nowrap" style={{ ...anchor(todayAt), bottom: `calc(${pct(values[todayAt]!)}% + 6px)` }}>
              today so far
            </span>
          )}
          {at !== null && (
            <div aria-hidden className="pointer-events-none absolute z-10 rounded-md border border-border bg-surface px-2.5 py-1.5 text-xs whitespace-nowrap shadow-[var(--shadow)]" style={{ ...anchor(at), bottom: `calc(${pct(values[at]!)}% + 8px)` }}>
              <p className="font-medium">{name(at)}</p>
              <p className="mt-0.5 flex items-center gap-1.5">
                <span className="h-2.5 w-2.5 rounded-[2px] bg-accent" />
                {label} <span className="font-semibold tabular-nums">{money(values[at]!)}</span>
              </p>
            </div>
          )}
        </div>
        <div aria-hidden className="relative mt-2 h-4 text-xs text-muted tabular-nums">
          {/* On a phone: every other label, and no year. */}
          {tickDays(n).map((i, k) => (
            <span
              key={i}
              className={`absolute whitespace-nowrap ${k % 2 === 1 && i !== n - 1 ? "hidden sm:inline" : ""}`}
              style={i === 0 ? { left: 0 } : i === n - 1 ? { right: 0 } : { left: `${((i + 0.5) / n) * 100}%`, transform: "translateX(-50%)" }}
            >
              {n > 1 && (i === 0 || i === n - 1) ? (
                <>
                  <span className="sm:hidden">{fmtDay(days[i], { year: false })}</span>
                  <span className="hidden sm:inline">{fmtDay(days[i], { year: true })}</span>
                </>
              ) : (
                fmtDay(days[i], { year: false })
              )}
            </span>
          ))}
        </div>
      </div>
      <p className="sr-only" aria-live="polite">{at !== null ? describe(at) : ""}</p>
      {/* The sr-only wrapper (not the table itself) keeps the table from widening the page. */}
      <div className="sr-only">
        <table>
          <caption>{label} by day</caption>
          <thead>
            <tr>
              <th scope="col">Day</th>
              <th scope="col">{label}</th>
            </tr>
          </thead>
          <tbody>
            {days.map((d, i) => (
              <tr key={d}>
                <th scope="row">{name(i)}</th>
                <td>{money(values[i]!)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/** One chart: total sales (net sales for a member not shown tax and shipping) each day of the dates. */
export function SalesByDay({ ov, currency, className = "" }: { ov: Overview; currency: string; className?: string }) {
  const s = ov.modules.sales_overview!;
  const total = s.current.totalSales !== undefined;
  const pick = (d: { netSales: number; totalSales?: number }) => (total ? (d.totalSales ?? d.netSales) : d.netSales);
  const what = total ? "Total sales" : "Net sales";
  return (
    <section id="sales-by-day" aria-labelledby="sales-by-day-h" data-testid="home-sales-by-day" className={`home-card animate-rise flex min-w-0 flex-col p-5 sm:p-6 ${className}`}>
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <h2 id="sales-by-day-h" className="home-h2">Sales by day</h2>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs font-medium">
          <span className="inline-flex items-center gap-1.5" title={`${what} each day`}>
            <span aria-hidden className="h-3 w-3 rounded-[2px] bg-accent" />
            {fmtSpan(ov.range.from, ov.range.to)}
          </span>
        </div>
      </div>
      <div className="mt-2 flex-1">
        <DayBars days={s.series.map((d) => d.day)} values={s.series.map(pick)} today={ov.today} label={what} money={(n) => fmtMoney(n, currency)} />
      </div>
    </section>
  );
}
