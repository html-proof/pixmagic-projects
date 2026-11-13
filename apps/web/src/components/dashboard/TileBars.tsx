"use client";
import { useState } from "react";
import type { PeriodGranularity } from "@app/shared/dates";
import { trendPeriods, type TrendPeriod } from "@app/shared/sales";
import { columnPath, columnWidth, useWidth } from "./chartUtils";
import { fmtDay, fmtMonth, fmtPeriodShort } from "./format";

// ---------------------------------------------------------------------------
// The small bar chart on a headline tile: the dashboard's four numbers (HomeCards.tsx), the
// Advertising overview's (advertising/OverviewKpis.tsx) and the Shopping funnel's
// (funnel/FunnelKpis.tsx). One look and one set of rules for all three.
// ---------------------------------------------------------------------------

/**
 * A headline tile's figure over the dates picked, as the bars of its small chart: one per day,
 * week or month (`trendPeriods` in @app/shared/sales picks which, so they stay few enough to tell
 * apart). `value` is null for a period with no figure (not imported, not read, or an average of
 * no orders): a gap, never a 0. `quiet` is one not all there yet, and `note` says why in a word or
 * two: it holds today, or some of its days have no figure.
 */
export type TileTrend = {
  by: PeriodGranularity;
  bars: Array<{ key: string; from: string; to: string; value: number | null; quiet: boolean; note?: string }>;
  /** A bar's figure in words, as the tile writes its own. */
  format: (n: number) => string;
};

/** The bars of a tile for one figure, worked out over each period's days by `value`. */
export function tileTrend<D extends { day: string }>(
  trend: { by: PeriodGranularity; periods: Array<TrendPeriod<D>> },
  value: (days: D[]) => number | null,
  format: (n: number) => string,
): TileTrend {
  return {
    by: trend.by,
    bars: trend.periods.map((p) => ({
      key: p.key,
      from: p.from,
      to: p.to,
      value: p.status === "not_imported" ? null : value(p.days),
      quiet: p.status === "partial",
      ...(p.status === "partial" ? { note: p.running ? "so far" : "not every day" } : {}),
    })),
    format,
  };
}

/**
 * The bars of a tile from a day series whose figure can be missing on a day (an ad platform's day
 * not read yet, a day before visits were counted): `has` says which days have it. A period adds
 * up the days that do, drawn lighter and saying "not every day" when some don't; one with none is
 * a gap.
 */
export function tileTrendOf<D extends { day: string }>(
  series: readonly D[],
  range: { from: string; to: string },
  today: string,
  has: (d: D) => boolean,
  value: (days: D[]) => number | null,
  format: (n: number) => string,
): TileTrend {
  return tileTrend(trendPeriods(series.filter(has), range, today, null), value, format);
}

/** A figure added up over the days of one bar, to the cent. */
export const sumDays = <D,>(days: D[], of: (d: D) => number) => Math.round(days.reduce((a, d) => a + of(d), 0) * 100) / 100;

const BARS_H = 40;
const BY_WORDS: Record<PeriodGranularity, string> = { day: "by day", week: "by week", month: "by month" };

/**
 * The small chart of a headline tile: a bar per day, week or month from a zero line, the dates it
 * runs between written under its two ends, and what each bar stands for between them. Pointing at
 * a bar names it and says its figure in place of that line. Bars start at zero (a figure below
 * it, like a day refunded more than it sold, hangs under the line), so their heights compare.
 * Nothing is drawn with fewer than two bars or with nothing but zeros. `ink` is the bars' colour
 * (a text colour class); `className` the space above it.
 */
export function TileBars({ trend, ink, className = "mt-3" }: { trend: TileTrend; ink: string; className?: string }) {
  // Decided out here, so the chart measures itself when it first has something to draw.
  if (trend.bars.length < 2 || !trend.bars.some((b) => b.value !== null && b.value !== 0)) return null;
  return <TileBarsDrawn trend={trend} ink={ink} className={className} />;
}

function TileBarsDrawn({ trend, ink, className }: { trend: TileTrend; ink: string; className: string }) {
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
    // Hidden from screen readers, like the line it replaced: the tile's figure is the content, and
    // the same figures are read out in full on the page behind it.
    <span aria-hidden className={`@container hidden w-full min-[420px]:block ${className}`} data-testid="tile-trend" data-by={by}>
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
      <span className="mt-1 flex h-4 items-center justify-between gap-2 whitespace-nowrap text-[11px] font-normal normal-case leading-4 tracking-normal text-muted">
        {shown ? (
          <>
            <span className="min-w-0 truncate">
              {fmtPeriodShort(shown, by)}
              {shown.value !== null && shown.note ? ` · ${shown.note}` : ""}
            </span>
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
