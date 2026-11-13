"use client";
import { useId, type ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { fmtMoney } from "@/lib/api";

// ---------------------------------------------------------------------------
// The top of the dashboard: four headline numbers, each on a tinted tile with its day-by-day
// shape (the panels under them are HomePanels.tsx). Each opens the details behind it, like every
// card on the page.
// ---------------------------------------------------------------------------

/**
 * One tint per headline number, so the four read apart at a glance (the owner's design): a soft
 * wash of it on the tile, a solid disc for the icon, and the sparkline's ink.
 */
const TINT = {
  green: {
    disc: "bg-emerald-600 dark:bg-emerald-500",
    ink: "text-emerald-600 dark:text-emerald-400",
  },
  blue: {
    disc: "bg-sky-600 dark:bg-sky-500",
    ink: "text-sky-600 dark:text-sky-400",
  },
  violet: {
    disc: "bg-violet-600 dark:bg-violet-500",
    ink: "text-violet-600 dark:text-violet-400",
  },
  amber: {
    disc: "bg-orange-500 dark:bg-orange-500",
    ink: "text-orange-600 dark:text-orange-400",
  },
} as const;
export type Tint = keyof typeof TINT;

/**
 * A figure's shape over the days picked, small and unlabelled (the tile says what it is): a line
 * in the current colour with a fade under it. A day with no figure is a gap, never a 0. Nothing
 * is drawn with fewer than two days.
 */
export function Sparkline({ values, className = "" }: { values: Array<number | null>; className?: string }) {
  const id = `spark-${useId().replace(/[^\w-]/g, "")}`;
  const known = values.filter((v): v is number => v !== null);
  if (values.length < 2 || known.length < 2) return null;
  const W = 112;
  const H = 40;
  const lo = Math.min(...known);
  const hi = Math.max(...known);
  const span = hi - lo || 1;
  const x = (i: number) => (i / (values.length - 1)) * W;
  // 3px of room at the top and bottom for the stroke.
  const y = (v: number) => 3 + (1 - (v - lo) / span) * (H - 6);
  const runs: Array<Array<[number, number]>> = [];
  values.forEach((v, i) => {
    if (v === null) return;
    if (i === 0 || values[i - 1] === null || !runs.length) runs.push([]);
    runs.at(-1)!.push([x(i), y(v)]);
  });
  const line = (pts: Array<[number, number]>) => pts.map(([px, py], i) => `${i ? "L" : "M"}${px.toFixed(1)},${py.toFixed(1)}`).join("");
  return (
    <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className={className} aria-hidden>
      <defs>
        <linearGradient id={id} x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stopColor="currentColor" stopOpacity={0.22} />
          <stop offset="100%" stopColor="currentColor" stopOpacity={0} />
        </linearGradient>
      </defs>
      {runs.map((pts, r) =>
        pts.length > 1 ? (
          <g key={r}>
            <path d={`${line(pts)}L${pts.at(-1)![0].toFixed(1)},${H}L${pts[0]![0].toFixed(1)},${H}Z`} fill={`url(#${id})`} />
            <path d={line(pts)} fill="none" stroke="currentColor" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
          </g>
        ) : null,
      )}
    </svg>
  );
}

/**
 * Under the Total sales tile: what refunds, returns and cancellations took off it in the dates
 * picked, tax and shipping in. The figure above is already after them (Shopify's total sales), so
 * this says by how much, never takes it off again. An item returned with no money given back takes
 * nothing off, so a day with a return can still say A$0.00.
 */
export function RefundsLine({ refunded, currency }: { refunded: number; currency: string }) {
  // Never "-A$0.00": Intl writes a negative zero with its sign.
  const amount = refunded > 0 ? `−${fmtMoney(refunded, currency)}` : fmtMoney(refunded < 0 ? -refunded : 0, currency);
  return (
    <span data-testid="tile-refunds" className="block truncate" title={`Refunds in these dates took ${fmtMoney(refunded, currency)} off total sales (tax and shipping included). Total sales is already after them.`}>
      Refunds <span className="font-semibold text-text">{amount}</span>
    </span>
  );
}

/** One headline number. Tapping it opens the full details behind it. */
export function KpiCard({
  title,
  value,
  icon: IconCmp,
  tint,
  spark,
  i = 0,
  extra,
  onClick,
}: {
  title: string;
  value: ReactNode;
  icon: LucideIcon;
  tint: Tint;
  /** The figure day by day over the dates picked, for the sparkline. */
  spark?: Array<number | null>;
  i?: number;
  /** One more line under the figure, such as the store's Custom sales beside Shopify's figure. */
  extra?: ReactNode;
  onClick: () => void;
}) {
  const t = TINT[tint];
  return (
    <button
      type="button"
      onClick={onClick}
      className={`lift animate-rise flex min-w-0 flex-col rounded-lg bg-surface p-4 text-left shadow-[var(--shadow)] sm:p-5`}
      style={{ ["--i" as string]: i }}
      data-testid={`metric-${title}`}
    >
      <span className="flex min-w-0 items-start gap-3">
        <span aria-hidden className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-white shadow-sm sm:h-11 sm:w-11 ${t.disc}`}>
          <IconCmp className="h-5 w-5" strokeWidth={2} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium text-text/80">{title}</span>
          <span className="mt-0.5 block truncate text-xl font-bold tracking-tight sm:text-[1.65rem] sm:leading-9">{value}</span>
        </span>
      </span>
      {spark && <Sparkline values={spark} className={`mt-3 hidden h-10 w-24 shrink-0 self-end min-[420px]:block sm:w-28 ${t.ink}`} />}
      {extra && <span className="mt-2 block min-w-0 text-xs text-muted">{extra}</span>}
      {/* No aria-label: it would replace the figure; screen readers read the tile, then this. */}
      <span className="sr-only"> – open details</span>
    </button>
  );
}
