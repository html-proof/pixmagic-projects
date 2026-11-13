"use client";
import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { fmtMoney } from "@/lib/api";
import { TileBars, type TileTrend } from "./TileBars";

// ---------------------------------------------------------------------------
// The top of the dashboard: four headline numbers, each on a tinted tile with a small bar chart
// of it over the dates picked (TileBars.tsx; the panels under them are HomePanels.tsx). Each opens
// the details behind it, like every card on the page.
// ---------------------------------------------------------------------------

/**
 * One tint per headline number, so the four read apart at a glance (the owner's design): a soft
 * wash of it on the tile, a solid disc for the icon, and the ink of its bars.
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
  trend,
  i = 0,
  extra,
  onClick,
}: {
  title: string;
  value: ReactNode;
  icon: LucideIcon;
  tint: Tint;
  /** The figure over the dates picked, for the small bar chart (`tileTrend`). */
  trend?: TileTrend;
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
      {trend && <TileBars trend={trend} ink={t.ink} />}
      {extra && <span className="mt-2 block min-w-0 text-xs text-muted">{extra}</span>}
      {/* No aria-label: it would replace the figure; screen readers read the tile, then this. */}
      <span className="sr-only"> – open details</span>
    </button>
  );
}
