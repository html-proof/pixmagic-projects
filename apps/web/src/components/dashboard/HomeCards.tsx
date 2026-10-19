"use client";
import { useState, type ReactNode } from "react";
import { ArrowDown, ArrowUp, ChartColumn, Lightbulb, Minus, ShoppingCart, type LucideIcon } from "lucide-react";
import { fmtMoney, fmtNum, fmtPct } from "@/lib/api";
import { fmtMoneyCompact } from "./format";
import { LineChart } from "./LineChart";
import type { Overview } from "./types";
import { customSales } from "@app/shared/salesCalculation";
import { appliedCustom, dayLinesOf, showsRefunds, showsTotalSales } from "./redacted";

// ---------------------------------------------------------------------------
// The top of the dashboard: four headline numbers, the sales and orders trends, and the summary
// card. Each opens the details behind it, like every card on the page.
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

/** A card's heading: a tinted round icon, the title and one line under it, and a control on the right. */
function CardHead({ icon: IconCmp, title, sub, id, aside }: { icon: LucideIcon; title: string; sub: string; id: string; aside?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div className="flex min-w-0 items-start gap-3.5">
        <span aria-hidden className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-accent/10 text-accent">
          <IconCmp className="h-5 w-5" strokeWidth={1.8} />
        </span>
        <div className="min-w-0">
          <h2 id={id} className="font-semibold">{title}</h2>
          <p className="mt-0.5 text-sm text-muted">{sub}</p>
        </div>
      </div>
      {aside}
    </div>
  );
}

function ChartChoice<T extends string>({ label, value, options, onChange }: { label: string; value: T; options: Array<[T, string]>; onChange: (v: T) => void }) {
  return (
    <select aria-label={label} className="input h-9 w-auto cursor-pointer py-1 pr-8 text-xs font-medium shadow-[var(--shadow)]" value={value} onChange={(e) => onChange(e.target.value as T)}>
      {options.map(([v, l]) => (
        <option key={v} value={v}>{l}</option>
      ))}
    </select>
  );
}

/** Shown over an empty chart's gridlines: what's missing, and when it will fill in. */
function EmptyChart({ icon: IconCmp, title, body }: { icon: LucideIcon; title: string; body: string }) {
  return (
    <div className="pointer-events-none absolute inset-0 flex items-center justify-center px-4 pb-6 pl-14">
      <div className="flex max-w-xs flex-col items-center rounded-xl bg-surface/90 px-4 py-3 text-center">
        <span aria-hidden className="flex h-10 w-10 items-center justify-center rounded-xl border border-border bg-surface text-muted shadow-[var(--shadow)]">
          <IconCmp className="h-5 w-5" strokeWidth={1.8} />
        </span>
        <p className="mt-2 text-sm font-semibold">{title}</p>
        <p className="mt-0.5 text-xs text-muted">{body}</p>
      </div>
    </div>
  );
}

const running = (values: number[]) => {
  let total = 0;
  return values.map((v) => Math.round((total += v) * 100) / 100);
};

type SalesView = "sales" | "custom" | "net" | "running" | "refunds";
type OrdersView = "daily" | "total";

/** Net sales and orders over the dates picked, side by side (the headline numbers above open their details). */
export function TrendCharts({ ov, currency }: { ov: Overview; currency: string }) {
  const s = ov.modules.sales_overview;
  // Until one is picked: Custom sales when the store shows it on the dashboard, else total sales.
  const [salesView, setSalesView] = useState<SalesView | null>(null);
  const [ordersView, setOrdersView] = useState<OrdersView>("daily");
  if (!s) return null;
  const days = s.series.map((d) => d.day);
  const money = (v: number) => fmtMoney(v, currency);
  // Whole amounts are short; gridlines less than a unit apart need the cents.
  const axis = (v: number, step: number) => (step < 1 ? fmtMoney(v, currency) : fmtMoneyCompact(v, currency));
  const count = (v: number) => fmtNum(v);

  const net = s.series.map((d) => d.netSales);
  // Refunds and total sales per day only for someone who may see them (Team & Access).
  const refundsShown = showsRefunds(s.series);
  const totalShown = showsTotalSales(s.series);
  // The store's own calculation, day by day from each day's lines, named wherever it shows.
  const custom = appliedCustom(s);
  const wanted = salesView ?? (custom ? "custom" : "sales");
  const view: SalesView =
    (wanted === "refunds" && !refundsShown) || (wanted === "sales" && !totalShown) || (wanted === "custom" && !custom) ? (totalShown ? "sales" : "net") : wanted;
  const salesValues =
    view === "refunds"
      ? s.series.map((d) => d.refunds ?? 0)
      : view === "running"
        ? running(net)
        : view === "sales"
          ? s.series.map((d) => d.totalSales ?? 0)
          : view === "custom" && custom
            ? s.series.map((d) => {
                const lines = dayLinesOf(d);
                return lines ? customSales(lines, custom.components) : 0;
              })
            : net;
  const salesEmpty = salesValues.every((v) => v === 0);
  const orders = s.series.map((d) => d.orders);
  const orderValues = ordersView === "total" ? running(orders) : orders;
  const ordersEmpty = orderValues.every((v) => v === 0);

  const salesLabel = {
    sales: "Total sales per day (Shopify)",
    custom: `Custom sales per day · ${custom?.name ?? ""}`,
    net: "Net sales per day",
    running: "Net sales, running total",
    refunds: "Returns per day",
  }[view];
  const ordersLabel = ordersView === "total" ? "Orders, running total" : "Orders per day";

  return (
    <div className="grid gap-4 xl:grid-cols-2">
      <section className="card animate-rise min-w-0" aria-labelledby="trend-sales-h" data-testid="trend-sales">
        <CardHead
          id="trend-sales-h"
          icon={ChartColumn}
          title="Sales overview"
          sub={view === "custom" && custom ? `Custom sales (${custom.name}), not Shopify's total sales.` : "Your store's sales performance over time."}
          aside={
            <ChartChoice<SalesView>
              label="Sales chart shows"
              value={view}
              onChange={setSalesView}
              options={[
                ...(totalShown ? [["sales", "Total sales"] as [SalesView, string]] : []),
                ...(custom ? [["custom", `Custom sales · ${custom.name}`] as [SalesView, string]] : []),
                ["net", "Net sales"],
                ["running", "Running total"],
                ...(refundsShown ? [["refunds", "Returns"] as [SalesView, string]] : []),
              ]}
            />
          }
        />
        <div className="relative mt-5">
          <LineChart
            days={days}
            series={salesEmpty ? [] : [{ key: view, label: salesLabel, color: view === "refunds" ? "var(--danger)" : "var(--accent)", values: salesValues }]}
            format={money}
            fmtAxis={axis}
            label={`${salesLabel}, ${days.length} days`}
            today={ov.today}
            height={220}
            floor={salesEmpty ? 4 : 0}
            bars
          />
          {salesEmpty &&
            (salesView === "refunds" ? (
              <EmptyChart icon={ChartColumn} title="No refunds in this period" body="Refunds show up here on the day they're issued." />
            ) : (
              <EmptyChart icon={ChartColumn} title="No sales in this period" body="Try a longer date range. Sales appear here as soon as your store receives orders." />
            ))}
        </div>
      </section>

      <section className="card animate-rise min-w-0" style={{ ["--i" as string]: 1 }} aria-labelledby="trend-orders-h" data-testid="trend-orders">
        <CardHead
          id="trend-orders-h"
          icon={ShoppingCart}
          title="Orders over time"
          sub="Number of orders placed in your store."
          aside={
            <ChartChoice<OrdersView>
              label="Orders chart shows"
              value={ordersView}
              onChange={setOrdersView}
              options={[
                ["daily", "Orders"],
                ["total", "Running total"],
              ]}
            />
          }
        />
        <div className="relative mt-5">
          <LineChart
            days={days}
            series={ordersEmpty ? [] : [{ key: ordersView, label: ordersLabel, color: "var(--viz-cat-1)", values: orderValues }]}
            format={count}
            fmtAxis={(v) => count(v)}
            label={`${ordersLabel}, ${days.length} days`}
            today={ov.today}
            height={220}
            integer
            bars
          />
          {ordersEmpty && <EmptyChart icon={ShoppingCart} title="No orders in this period" body="New orders show up here within a few minutes while this page is open. Test orders aren't counted, as in Shopify's reports." />}
        </div>
      </section>
    </div>
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
