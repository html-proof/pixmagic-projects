"use client";
import { useId, useState, type ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import type { PeriodGranularity } from "@app/shared/dates";
import type { TrendPeriod } from "@app/shared/sales";
import { fmtMoney } from "@/lib/api";
import { columnPath, columnWidth, useWidth } from "./chartUtils";
import { fmtDay, fmtMonth, fmtPeriodShort } from "./format";

// ---------------------------------------------------------------------------
// The top of the dashboard: four headline numbers, each on a tinted tile with a small bar chart
// of it over the dates picked (the panels under them are HomePanels.tsx). Each opens the details
// behind it, like every card on the page.
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
 * The Advertising and Shopping funnel tiles' sparkline (the dashboard's own tiles draw `TileBars`).
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
 * A headline tile's figure over the dates picked, as the bars of its small chart: one per day,
 * week or month (`trendPeriods` in @app/shared/sales picks which, so they stay few enough to tell
 * apart). `value` is null for a period with no figure (not imported, or an average of no orders):
 * a gap, never a 0. `quiet` is one not all there yet (it holds today, or days not imported).
 */
export type TileTrend = {
  by: PeriodGranularity;
  bars: Array<{ key: string; from: string; to: string; value: number | null; quiet: boolean }>;
  /** A bar's figure in words, as the tile writes its own. */
  format: (n: number) => string;
};

/** The bars of a tile for one figure, added up over each period's imported days by `value`. */
export function tileTrend<D extends { day: string }>(
  trend: { by: PeriodGranularity; periods: Array<TrendPeriod<D>> },
  value: (days: D[]) => number | null,
  format: (n: number) => string,
): TileTrend {
  return {
    by: trend.by,
    bars: trend.periods.map((p) => ({ key: p.key, from: p.from, to: p.to, value: p.status === "not_imported" ? null : value(p.days), quiet: p.status === "partial" })),
    format,
  };
}

const BARS_H = 40;
const BY_WORDS: Record<PeriodGranularity, string> = { day: "by day", week: "by week", month: "by month" };

/**
 * The small chart of a headline tile: a bar per day, week or month from a zero line, the dates it
 * runs between written under its two ends, and what each bar stands for between them. Pointing at
 * a bar names it and says its figure in place of that line. Bars start at zero (a figure below
 * it, like a day refunded more than it sold, hangs under the line), so their heights compare.
 * Nothing is drawn with fewer than two bars or with nothing but zeros.
 */
function TileBars({ trend, ink }: { trend: TileTrend; ink: string }) {
  // Decided out here, so the chart measures itself when it first has something to draw.
  if (trend.bars.length < 2 || !trend.bars.some((b) => b.value !== null && b.value !== 0)) return null;
  return <TileBarsDrawn trend={trend} ink={ink} />;
}

function TileBarsDrawn({ trend, ink }: { trend: TileTrend; ink: string }) {
  const { bars, by, format } = trend;
  const [ref, width] = useWidth<HTMLSpanElement>();
  const [over, setOver] = useState<number | null>(null);
  const values = bars.flatMap((b) => (b.value === null ? [] : [b.value]));
  const hi = Math.max(0, ...values);
  const lo = Math.min(0, ...values);
  const slot = width / bars.length;
  const w = columnWidth(slot);
  // 1px of room above and below for the zero line.
  const y = (v: number) => 1 + ((hi - v) / (hi - lo)) * (BARS_H - 2);
  const y0 = y(0);
  const first = bars[0]!;
  const last = bars.at(-1)!;
  const years = first.from.slice(0, 4) !== last.to.slice(0, 4);
  const end = (day: string) => (by === "month" ? fmtMonth(day.slice(0, 7), { short: true, year: true }) : fmtDay(day, { year: years }));
  const shown = over === null ? null : (bars[over] ?? null);
  return (
    // Hidden from screen readers, like the line it replaces: the tile's figure is the content, and
    // the same figures are read out in full on the page it opens.
    <span aria-hidden className="@container mt-3 hidden w-full min-[420px]:block" data-testid="tile-trend" data-by={by}>
      <span
        ref={ref}
        className={`block ${ink}`}
        style={{ height: BARS_H }}
        onPointerMove={(e) => {
          if (!(slot > 0)) return;
          const i = Math.floor((e.clientX - e.currentTarget.getBoundingClientRect().left) / slot);
          setOver(Math.max(0, Math.min(bars.length - 1, i)));
        }}
        onPointerLeave={() => setOver(null)}
      >
        {width > 0 && (
          <svg width={width} height={BARS_H} className="animate-fade block">
            {bars.map((b, i) => {
              if (b.value === null) return null;
              const x = i * slot;
              // A figure that isn't zero is never too short to see.
              const tip = b.value > 0 ? Math.min(y(b.value), y0 - 2) : Math.max(y(b.value), y0 + 2);
              const dim = (b.quiet ? 0.5 : 1) * (over !== null && over !== i ? 0.4 : 1);
              return (
                <g key={b.key}>
                  <rect x={x} y={y0 - 0.5} width={slot} height={1} fill="currentColor" opacity={0.3} />
                  {b.value !== 0 && <path d={columnPath(x + (slot - w) / 2, w, y0, tip)} fill="currentColor" opacity={dim} />}
                </g>
              );
            })}
          </svg>
        )}
      </span>
      <span className="mt-1 flex h-4 items-center justify-between gap-2 whitespace-nowrap text-[11px] leading-4 text-muted">
        {shown ? (
          <>
            <span className="min-w-0 truncate">{fmtPeriodShort(shown, by)}</span>
            <span className="font-semibold text-text">{shown.value === null ? "—" : format(shown.value)}</span>
          </>
        ) : (
          <>
            <span>{end(first.from)}</span>
            <span className="hidden @[11rem]:inline">{BY_WORDS[by]}</span>
            <span>{end(last.to)}</span>
          </>
        )}
      </span>
    </span>
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
