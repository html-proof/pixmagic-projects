"use client";
import type { ReactNode } from "react";
import { ArrowDown, ArrowUp, Lightbulb, Minus, type LucideIcon } from "lucide-react";
import { fmtPct } from "@/lib/api";

// ---------------------------------------------------------------------------
// The top of the dashboard: four headline numbers and the summary card (the sales panels under
// them are OverviewCharts.tsx). Each opens the details behind it, like every card on the page.
// ---------------------------------------------------------------------------

/** Icon tints for the headline numbers: one colour per number, so the four read apart at a glance. */
const TINT = {
  green: "bg-emerald-50 text-emerald-700 dark:bg-emerald-400/10 dark:text-emerald-300",
  blue: "bg-sky-50 text-sky-600 dark:bg-sky-400/10 dark:text-sky-300",
  violet: "bg-violet-50 text-violet-600 dark:bg-violet-400/10 dark:text-violet-300",
  amber: "bg-amber-50 text-amber-600 dark:bg-amber-400/10 dark:text-amber-300",
} as const;
export type Tint = keyof typeof TINT;

/** A change on the period before as a pill: green when it's good news, red when not (`invert` for costs). */
export function ChangePill({ value, invert = false }: { value: number | null | undefined; invert?: boolean }) {
  if (value === null || value === undefined) return <span className="rounded-full bg-text/[0.06] px-2 py-0.5 text-xs text-muted">No earlier data</span>;
  const good = invert ? value < 0 : value > 0;
  const tone = value === 0 ? "bg-text/[0.06] text-muted" : good ? "bg-good/10 text-good" : "bg-danger/10 text-danger";
  const Arrow = value > 0 ? ArrowUp : value < 0 ? ArrowDown : Minus;
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-xs font-semibold tabular-nums ${tone}`}>
      <Arrow aria-hidden className="h-3 w-3" strokeWidth={2.5} />
      <span className="sr-only">{value > 0 ? "up" : value < 0 ? "down" : "unchanged,"}</span>
      {fmtPct(Math.abs(value))}
    </span>
  );
}

/** One headline number. Tapping it opens the full details behind it. */
export function KpiCard({
  title,
  value,
  delta,
  invert,
  icon: IconCmp,
  tint,
  compared,
  versus = "vs previous period",
  i = 0,
  extra,
  onClick,
}: {
  title: string;
  value: ReactNode;
  delta: number | null | undefined;
  invert?: boolean;
  icon: LucideIcon;
  tint: Tint;
  /** "Compared with 18 Aug – 16 Sep", once known. */
  compared?: string;
  /** What the change is on, under the number: "vs same time yesterday" (`versusWords`). */
  versus?: string;
  i?: number;
  /** One more line under the change, such as the store's Custom sales beside Shopify's figure. */
  extra?: ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="card lift animate-rise flex min-w-0 flex-col gap-3 text-left sm:flex-row sm:items-start sm:gap-3.5"
      style={{ ["--i" as string]: i }}
      data-testid={`metric-${title}`}
    >
      <span aria-hidden className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-full ${TINT[tint]}`}>
        <IconCmp className="h-5 w-5" strokeWidth={1.8} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-sm text-muted">{title}</span>
        <span className="mt-1 block truncate text-xl font-bold tracking-tight sm:text-[1.7rem] sm:leading-9">{value}</span>
        <span className="mt-2 flex flex-wrap items-center gap-x-1.5 gap-y-1">
          <ChangePill value={delta} invert={invert} />
          {delta !== null && delta !== undefined && (
            <span className="whitespace-nowrap text-[11px] text-muted" title={compared}>
              {versus}
            </span>
          )}
        </span>
        {extra && <span className="mt-2 block min-w-0 text-xs text-muted">{extra}</span>}
      </span>
      {/* No aria-label: it would replace the figure; screen readers read the tile, then this. */}
      <span className="sr-only"> – open details</span>
    </button>
  );
}

/** "How your store is doing": the page's answer in a sentence or two, on a soft green card. */
export function SummaryCard({ aside, children }: { aside?: ReactNode; children: ReactNode }) {
  return (
    <section className="animate-rise flex min-w-0 flex-col rounded-xl border border-accent/20 bg-accent/[0.06] p-5" style={{ ["--i" as string]: 1 }} aria-labelledby="summary-h">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id="summary-h" className="flex items-center gap-2.5 font-semibold">
          <Lightbulb aria-hidden className="h-5 w-5 text-accent" strokeWidth={1.8} />
          How your store is doing
        </h2>
        {aside}
      </div>
      <div className="mt-3">{children}</div>
    </section>
  );
}
