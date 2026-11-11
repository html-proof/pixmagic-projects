"use client";
import Link from "next/link";
import { useState, type ReactNode } from "react";
import { useApp } from "@/components/AppContext";
import { LoadError } from "@/components/LoadError";
import type { ProfitAnswer } from "@/components/sheet/useProfit";
import { fmtMoney, useApi } from "@/lib/api";
import { GLANCE_VIEWS, HOME_DATE_CHIPS, costsKnown, drawable, firstView, weeksOf, type GlanceView, type MoneyPoint } from "@/lib/homeGlance";
import { PRESETS, type DateRangeState, type Shown } from "./DateRange";
import { fmtDay, fmtMoneyCompact, fmtMonth, fmtSpan } from "./format";
import { LineChart } from "./LineChart";

// ---------------------------------------------------------------------------
// The simple Home at a glance (lib/features.ts HOME_AT_A_GLANCE; rules in lib/homeGlance.ts): the
// dates most asked for as chips, the quieter numbers under the four tiles, and sales, expenses and
// profit by day, week or month. Every figure is one the app already works out elsewhere: the chips
// set the same dates as the dates menu, and the chart draws the Profit sheet's own answer.
// ---------------------------------------------------------------------------

const chip = "inline-flex h-9 shrink-0 items-center rounded-full px-3.5 text-[13px] font-medium whitespace-nowrap outline-none transition-colors focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-1";
const chipOn = "bg-accent text-accent-ink";
const chipOff = "border border-home-line bg-surface text-text hover:bg-home-soft";

/**
 * The dates one click away. They set the page's dates exactly as the dates menu does (the card
 * beside the greeting, which still lists every range and the comparison); a range that isn't one of
 * these leaves no chip pressed. On a phone the row scrolls sideways rather than wrap.
 */
export function DateChips({ r, shown }: { r: DateRangeState; shown: Shown }) {
  return (
    <div role="group" aria-label="Dates" className="-mx-1 flex gap-2 overflow-x-auto px-1 py-1" data-testid="date-chips">
      {HOME_DATE_CHIPS.map((id) => {
        const on = r.preset === id;
        return (
          <button key={id} type="button" aria-pressed={on} className={`${chip} ${on ? chipOn : chipOff}`} onClick={() => r.choose(id, shown?.range)} data-testid={`date-chip-${id}`}>
            {PRESETS.find((p) => p.id === id)!.label}
          </button>
        );
      })}
    </div>
  );
}

/** The quieter numbers: one card, a name, a figure and a line saying what it counts, each. */
export function MoreNumbers({ items }: { items: Array<{ id: string; label: string; value: ReactNode; sub: string }> }) {
  if (items.length === 0) return null;
  return (
    <section aria-label="More numbers" className="home-card animate-rise px-5 py-4 sm:px-6" data-testid="home-more-numbers">
      <dl className="grid grid-cols-2 gap-x-6 gap-y-4 lg:grid-cols-4">
        {items.map((n) => (
          <div key={n.id} className="min-w-0" data-testid={`more-number-${n.id}`}>
            <dt className="truncate text-xs font-medium text-muted">{n.label}</dt>
            <dd className="mt-1 truncate text-xl leading-7 font-semibold tracking-[-0.01em] tabular-nums">{n.value}</dd>
            <dd className="mt-0.5 text-xs text-muted">{n.sub}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

const point = (p: MoneyPoint): MoneyPoint => ({ from: p.from, to: p.to, revenue: p.revenue, totalExpenses: p.totalExpenses, netProfit: p.netProfit });

/**
 * Sales, expenses and profit: this month day by day or week by week, or the last 12 months, from
 * the Profit sheet's own answer (GET …/profit, components/sheet/useProfit.ts). Only for a member who
 * may see the sales breakdown and the profit, as that page is. A day, week or month whose costs
 * aren't all known has its sales only, and the card says so: never a profit worked out from part of
 * the costs.
 */
export function MoneyInAndOut({ className = "" }: { className?: string }) {
  const { workspace, store, allowed } = useApp();
  const sees = allowed("finance.breakdown") && allowed("analytics.sales");
  const { data, error, loading, reload } = useApi<ProfitAnswer>(store && sees ? `/workspaces/${workspace.id}/stores/${store.id}/profit` : null);
  // Until a view is picked: the first one with something to draw (lib/homeGlance.ts firstView).
  const [picked, setView] = useState<GlanceView | null>(null);
  if (!sees || !store) return null;

  const frame = (body: ReactNode, aside?: ReactNode) => (
    <section id="money-in-out" aria-labelledby="money-in-out-h" data-testid="home-money" className={`home-card animate-rise flex min-w-0 flex-col p-5 sm:p-6 ${className}`}>
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <h2 id="money-in-out-h" className="home-h2">Sales, expenses and profit</h2>
        {aside}
      </div>
      {body}
    </section>
  );
  if (!data) {
    if (error) return frame(<div className="mt-4"><LoadError what="your sales, expenses and profit" error={error} onRetry={() => void reload()} busy={loading} /></div>);
    return frame(<div className="skeleton mt-4 h-56" aria-busy="true" aria-label="Loading" />);
  }

  const view = picked ?? firstView(data.trend.map(point), data.days.map(point));
  const points: MoneyPoint[] = view === "monthly" ? data.trend.map(point) : view === "weekly" ? weeksOf(data.days.map(point)) : data.days.map(point);
  const thisMonth = fmtMonth(data.month, { year: true });
  const periods =
    view === "monthly"
      ? data.trend.map((m) => ({ tick: fmtMonth(m.month, { short: true }), long: `${fmtMonth(m.month, { year: true })}${m.month === data.today.slice(0, 7) ? " so far" : ""}` }))
      : view === "weekly"
        ? points.map((w) => ({ tick: fmtDay(w.from, { year: false }), long: `${fmtSpan(w.from, w.to)}${w.to >= data.today ? " so far" : ""}` }))
        : undefined;
  const money = (n: number) => fmtMoney(n, data.currency);
  const what = view === "monthly" ? "The last 12 months." : view === "weekly" ? `${thisMonth}, week by week (Monday to Sunday).` : `${thisMonth}, day by day.`;
  const switcher = (
    <div role="group" aria-label="Show by" className="flex gap-1.5">
      {GLANCE_VIEWS.map((v) => (
        <button key={v.id} type="button" aria-pressed={view === v.id} className={`${chip} h-8 px-3 text-xs ${view === v.id ? chipOn : chipOff}`} onClick={() => setView(v.id)} data-testid={`money-view-${v.id}`}>
          {v.label}
        </button>
      ))}
    </div>
  );
  return frame(
    <>
      <p className="mt-1 text-xs text-muted" data-testid="money-what">
        {what} Sales here leave out tax, so they can be lower than Total sales.
      </p>
      <div className="mt-3 flex-1">
        {drawable(points) ? (
          <LineChart
            days={view === "monthly" ? data.trend.map((m) => `${m.month}-01`) : points.map((p) => p.from)}
            periods={periods}
            series={[
              { key: "sales", label: "Sales", color: "var(--viz-cat-1)", values: points.map((p) => p.revenue) },
              { key: "expenses", label: "Expenses", color: "var(--viz-cat-2)", values: points.map((p) => p.totalExpenses) },
              { key: "profit", label: "Profit", color: "var(--good)", negativeColor: "var(--danger)", values: points.map((p) => p.netProfit) },
            ]}
            format={money}
            fmtAxis={(v) => fmtMoneyCompact(v, data.currency)}
            label={`Sales, expenses and profit: ${what}`}
            today={view === "daily" ? data.today : undefined}
            bars
            height={220}
          />
        ) : (
          <p className="rounded-lg border border-dashed border-border px-3 py-10 text-center text-sm text-muted" data-testid="money-empty">
            Nothing to draw here yet: bizinsights doesn&apos;t have every day&apos;s sales for {view === "monthly" ? "these months" : "these dates"}.
          </p>
        )}
      </div>
      {drawable(points) && !costsKnown(points) && (
        <p className="mt-3 text-xs text-muted" data-testid="money-gaps">
          Expenses and profit show only where every cost is known. Where a bar is missing, a cost is too.{" "}
          <Link href="/profit" className="font-medium text-accent hover:underline">
            See what&apos;s missing in Profit &amp; Loss
          </Link>
        </p>
      )}
    </>,
    switcher,
  );
}
