"use client";
import { useState, type CSSProperties } from "react";
import { useApp } from "@/components/AppContext";
import { fmtMoney, fmtNum, fmtPct, useLiveApi } from "@/lib/api";
import { fmtDay, fmtMonth, fmtRange, plural } from "./format";
import { ChartChoice, Panel, Stat } from "./Primitives";
import type { Overview } from "./types";

// ---------------------------------------------------------------------------
// Repeat customers and monthly first-order cohorts on the Customers page (GET …/analytics/customers,
// apps/api/src/routes/customerAnalytics.ts; packages/core/src/reports/customers.ts; the arithmetic
// in @app/shared/customers; docs/customer-analytics.md). Its types are its own: the dashboard's
// answer doesn't carry it. Fields marked "orders" or "money" are absent for a member who may not
// see the store's order counts or sales; a money field is null while it can't be known yet.
// ---------------------------------------------------------------------------

export interface CustomerFigures {
  customers: number;
  repeatCustomers: number;
  repeatRate: number | null;
  /** orders */
  orders?: number;
  ordersPerCustomer?: number | null;
  /** money */
  netSales?: number | null;
  netSalesPerCustomer?: number | null;
}

export interface CohortCell {
  n: number;
  month: string;
  returned: number;
  rate: number | null;
  /** The store's current month: so far. */
  running: boolean;
  /** money: what a customer of the cohort has spent to the end of this month, first order included. */
  netSalesPerCustomerToDate?: number | null;
}

export interface Cohort {
  month: string;
  customers: number;
  /** The month began before customers are known: its earlier first buyers aren't in it. */
  partial: boolean;
  repeatCustomers: number;
  repeatRate: number | null;
  ordersPerCustomer?: number | null;
  netSalesPerCustomer?: number | null;
  cells: CohortCell[];
}

export interface CustomerAnalytics {
  range: { from: string; to: string };
  months: number;
  today: string;
  importing: boolean;
  /** The first day every order's customer is known; null before any is. */
  customersFrom: string | null;
  /** orders: where the imported orders begin, and how older ones can be had. */
  historyFrom?: string | null;
  historyAccess?: "granted" | "reconnect" | "requestable" | "awaiting_shopify";
  /** orders: customers are known from later than the orders are all in (orders read before Your customers was granted say nobody). */
  customersLater?: boolean;
  dates: {
    from: string;
    to: string;
    clamped: boolean;
    figures: CustomerFigures;
    withoutCustomer?: number;
    salesPending?: number;
  } | null;
  cohorts: {
    from: string;
    items: Cohort[];
    acquired: CustomerFigures;
    returningFromBefore: number;
    salesPending?: number;
  } | null;
}

/** Asked when the page opens and then now and again: the figures move with orders, not by the second. */
const LIVE_EVERY_MS = 5 * 60_000;
const MONTH_CHOICES: Array<["6" | "12" | "24", string]> = [["6", "6 months"], ["12", "12 months"], ["24", "24 months"]];

/**
 * The report for the dashboard's dates, written out as custom dates, and `months` of cohorts.
 * `shown` false (no customers module for this member or store): nothing is asked.
 */
export function useCustomerAnalytics(ov: Overview, shown: boolean, months: number) {
  const { workspace } = useApp();
  const params = new URLSearchParams({ preset: "custom", from: ov.range.from, to: ov.range.to, months: String(months) });
  const path = shown ? `/workspaces/${workspace.id}/stores/${ov.store.id}/analytics/customers?${params}` : null;
  const live = useLiveApi<CustomerAnalytics>(path, LIVE_EVERY_MS);
  // Never the figures of other dates under these ones.
  return { report: live.data && live.dataPath === path ? live.data : null, error: live.error, loading: live.loading, failing: live.failing };
}

type Live = ReturnType<typeof useCustomerAnalytics>;

const fmtEach = (n: number | null | undefined) => (n === null || n === undefined ? "—" : new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(n));
const waiting = (n: number | undefined) => (n ? `Waiting for the sales of ${plural(n, "order")} to be read from Shopify.` : null);

/** The figures of a group of customers, each only when this member gets it. */
function FigureStats({ f, currency, repeatNote, salesPending, ordersNote }: { f: CustomerFigures; currency: string; repeatNote: string; salesPending?: number; ordersNote: string }) {
  return (
    <>
      <Stat label="Repeat purchase rate" value={fmtPct(f.repeatRate)} note={`${repeatNote} ${fmtNum(f.repeatCustomers)} of ${plural(f.customers, "customer")}.`} />
      {f.ordersPerCustomer !== undefined && <Stat label="Orders per customer" value={fmtEach(f.ordersPerCustomer)} note={ordersNote} />}
      {f.netSalesPerCustomer !== undefined && (
        <Stat
          label="Net sales per customer"
          value={f.netSalesPerCustomer === null ? "—" : fmtMoney(f.netSalesPerCustomer, currency)}
          note={waiting(salesPending) ?? (f.customers ? "After discounts and returns, before tax and shipping." : "No customers to divide by.")}
        />
      )}
    </>
  );
}

/**
 * Why the figures start where they do: the first day customers are known, and what keeps earlier
 * orders out (Shopify's 60 days, or orders read before Your customers was granted).
 */
function Coverage({ r }: { r: CustomerAnalytics }) {
  if (!r.customersFrom) return null;
  return (
    <div className="space-y-1 text-xs text-muted" data-testid="customers-coverage">
      <p>
        Customers are known on the orders bizinsights holds from <span className="font-medium text-text">{fmtDay(r.customersFrom)}</span>
        {r.customersLater ? ": the orders before that don't say who placed them (they were imported before Your customers was granted, or were guest checkouts)." : "."}
      </p>
      {r.historyAccess && r.historyAccess !== "granted" && (
        <p>
          Shopify shares only the last 60 days of orders with an app until the store grants it full order history: first purchases before that can&apos;t be seen, and each month from now on adds a cohort.
          {r.historyAccess === "requestable" ? " An owner or admin can import the full history from the line at the top of this page." : null}
          {r.historyAccess === "reconnect" ? " Reconnecting the store imports the full history." : null}
          {r.historyAccess === "awaiting_shopify" ? " Shopify has to approve bizinsights for full order history first: there's nothing to turn on yet." : null}
        </p>
      )}
      {!r.historyAccess && <p>Earlier customers aren&apos;t counted: their orders weren&apos;t shared with bizinsights, or don&apos;t say who placed them.</p>}
    </div>
  );
}

/** Repeat purchase rate, orders and net sales per customer: the dates on screen, and everyone who first bought since the cohorts start. */
export function RepeatCustomers({ currency, live }: { currency: string; live: Live }) {
  const r = live.report;
  const d = r?.dates;
  const c = r?.cohorts;
  return (
    <Panel
      id="d-customer-value"
      title="Repeat customers"
      help="From the orders bizinsights holds, each customer counted once. A repeat customer placed two orders or more. Cancelled orders count as orders, as in Shopify; orders of gift cards only don't. Historical figures only: nothing here is a forecast."
    >
      {live.error && !r && <p role="alert">Repeat customers could not be loaded: {live.error.message}</p>}
      {live.failing && r && <p role="status">Refresh is delayed. Showing the last successful response.</p>}
      {!r ? (
        !live.error && <div aria-label="Loading repeat customers" className="h-32 animate-pulse rounded bg-border" />
      ) : !r.customersFrom || r.customersFrom > r.today ? (
        <p className="text-sm" data-testid="customers-unknown">
          {r.customersFrom
            ? `Customers are counted from ${fmtDay(r.customersFrom)}.`
            : "No order bizinsights holds says who placed it yet. These figures start once orders arrive with their customer."}
        </p>
      ) : (
        <div className="space-y-5">
          {r.importing && <p role="status" className="text-sm">Orders are still being imported from Shopify: these figures fill in as they arrive.</p>}
          <section aria-labelledby="d-customer-value-dates" data-testid="customers-dates">
            <h3 id="d-customer-value-dates" className="mb-2 text-sm font-medium">
              {d ? `Customers who ordered ${fmtRange(d.from, d.to)}` : "Customers who ordered in these dates"}
            </h3>
            {!d ? (
              <p className="text-sm text-muted">These dates end before customers are known ({fmtDay(r.customersFrom)}): there&apos;s nothing to count, which isn&apos;t the same as no customers.</p>
            ) : (
              <>
                {d.clamped && <p className="mb-2 text-xs text-muted">Counted from {fmtDay(d.from)}: earlier orders in these dates don&apos;t say who placed them.</p>}
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                  <FigureStats f={d.figures} currency={currency} repeatNote="Ordered twice or more in these dates:" salesPending={d.salesPending} ordersNote="Their orders in these dates ÷ customers." />
                  {d.withoutCustomer !== undefined && (
                    <Stat label="Orders without a known customer" value={fmtNum(d.withoutCustomer)} note="Guest checkouts, and deleted or redacted customers: in no figure here." />
                  )}
                </div>
              </>
            )}
          </section>
          {c && c.acquired.customers > 0 && (
            <section aria-labelledby="d-customer-value-acquired" data-testid="customers-acquired">
              <h3 id="d-customer-value-acquired" className="mb-2 text-sm font-medium">Customers who first bought since {fmtDay(c.from)}</h3>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                <Stat label="Customers" value={fmtNum(c.acquired.customers)} note="Their first purchase ever was since then." />
                <FigureStats f={c.acquired} currency={currency} repeatNote="Bought again since:" salesPending={c.salesPending} ordersNote="All their orders so far ÷ customers." />
              </div>
              {c.returningFromBefore > 0 && (
                <p className="mt-2 text-xs text-muted">
                  {plural(c.returningFromBefore, "more customer", "more customers")} ordered since {fmtDay(c.from)} whose first purchase was earlier: they&apos;re in no cohort.
                </p>
              )}
            </section>
          )}
          <p className="text-xs text-muted">Customers are known on orders from {fmtDay(r.customersFrom)}. Monthly cohorts, below, say why not earlier.</p>
        </div>
      )}
    </Panel>
  );
}

/** A cell's tint: one hue, from the surface (nothing) to at most 60% of it (the table's largest), so text stays readable in both themes. */
const tint = (v: number | null | undefined, max: number): CSSProperties | undefined =>
  v === null || v === undefined || !(max > 0) || v <= 0 ? undefined : { background: `color-mix(in oklab, var(--viz-cat-1) ${Math.round(8 + (Math.min(v, max) / max) * 52)}%, var(--surface))` };

/** Monthly first-order cohorts: who came back, month by month, or what they spent so far. */
export function MonthlyCohorts({ currency, live, months, onMonths }: { currency: string; live: Live; months: number; onMonths: (m: number) => void }) {
  const { allowed } = useApp();
  const r = live.report;
  const items = r?.cohorts?.items ?? [];
  const money = items.some((c) => c.netSalesPerCustomer !== undefined);
  const [measure, setMeasure] = useState<"rate" | "value">("rate");
  const showValue = money && measure === "value";
  const width = items.reduce((a, c) => Math.max(a, c.cells.length), 0);
  const valueOf = (x: CohortCell) => (showValue ? x.netSalesPerCustomerToDate : x.rate);
  const max = items.reduce((a, c) => c.cells.reduce((b, x) => Math.max(b, valueOf(x) ?? 0), a), 0);
  const pending = r?.cohorts?.salesPending ?? 0;
  const csv = () => {
    if (!allowed("reports.export") || !r?.cohorts) return;
    const head = ["First order month", "Customers", "Partial", "Repeat purchase rate", ...Array.from({ length: width }, (_, n) => `Month ${n} retention`), ...(money ? Array.from({ length: width }, (_, n) => `Month ${n} net sales per customer to date`) : [])];
    const values = [
      head,
      ...items.map((c) => {
        const at = (n: number) => c.cells.find((x) => x.n === n);
        return [
          c.month,
          c.customers,
          c.partial ? "yes" : "no",
          c.repeatRate,
          ...Array.from({ length: width }, (_, n) => at(n)?.rate ?? null),
          ...(money ? Array.from({ length: width }, (_, n) => at(n)?.netSalesPerCustomerToDate ?? null) : []),
        ];
      }),
    ];
    const text = values.map((row) => row.map((v) => `"${(typeof v === "string" && /^\s*[=+\-@\t\r]/.test(v) ? "'" + v : String(v ?? "")).replaceAll('"', '""')}"`).join(",")).join("\r\n");
    const url = URL.createObjectURL(new Blob(["\ufeff", text], { type: "text/csv;charset=utf-8" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `customer-cohorts-${r.today}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };
  return (
    <Panel
      id="d-cohorts"
      title="Monthly cohorts"
      help="Customers grouped by the month of their first purchase ever, in the store's time zone. Month 0 is that month itself (orders after the first one), month 1 the next calendar month, and so on. Each cell is the share of the cohort who ordered in that month, or, for net sales, what a customer of the cohort has spent so far, first order included. The same whatever dates are picked above."
      aside={
        <div className="flex flex-wrap items-center gap-2">
          {money && <ChartChoice label="Cohort figure" value={measure} options={[["rate", "Customers back"], ["value", "Net sales per customer"]]} onChange={setMeasure} />}
          <ChartChoice label="Months shown" value={String(months) as "6" | "12" | "24"} options={MONTH_CHOICES} onChange={(v) => onMonths(Number(v))} />
          {allowed("reports.export") && items.length > 0 && <button type="button" className="rounded border px-3 py-1" onClick={csv}>Export CSV</button>}
        </div>
      }
    >
      {live.error && !r && <p role="alert">Cohorts could not be loaded: {live.error.message}</p>}
      {!r ? (
        !live.error && <div aria-label="Loading cohorts" className="h-48 animate-pulse rounded bg-border" />
      ) : !r.cohorts || items.length === 0 ? (
        <p className="text-sm">No cohorts yet: they start with the first month whose orders say who placed them.</p>
      ) : (
        <>
          {showValue && pending > 0 && <p role="status" className="mb-3 text-sm">{waiting(pending)} Net sales per customer show once they are.</p>}
          <div className="max-h-[620px] overflow-auto" data-testid="cohort-table">
            <table className="w-full whitespace-nowrap text-left text-sm tabular-nums">
              <caption className="sr-only">{showValue ? "Net sales per customer so far, by month of first purchase" : "Share of each month's first-time customers who ordered again, month by month"}</caption>
              <thead className="sticky top-0 bg-surface">
                <tr>
                  <th className="p-2" scope="col">First order</th>
                  <th className="p-2" scope="col">Customers</th>
                  {Array.from({ length: width }, (_, n) => (
                    <th key={n} className="p-2 text-right" scope="col">Month {n}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {items.map((c) => (
                  <tr className="border-t" key={c.month} data-testid={`cohort-${c.month}`}>
                    <th scope="row" className="p-2 font-normal">
                      {fmtMonth(c.month, { short: true, year: true })}
                      {c.partial && <small className="block text-muted">from {fmtDay(r.customersFrom)}</small>}
                    </th>
                    <td className="p-2">{fmtNum(c.customers)}</td>
                    {Array.from({ length: width }, (_, n) => {
                      const x = c.cells.find((y) => y.n === n);
                      // A month that hasn't come yet: no cell, not 0.
                      if (!x) return <td key={n} className="p-2" aria-label="Not yet" />;
                      const v = valueOf(x);
                      const text = showValue ? (v === null || v === undefined ? "—" : fmtMoney(v, currency)) : fmtPct(v);
                      const title = showValue
                        ? `${fmtMonth(x.month, { year: true })}: ${text} per customer so far`
                        : c.customers
                          ? `${fmtMonth(x.month, { year: true })}: ${plural(x.returned, "customer")} of ${fmtNum(c.customers)} ordered${x.n === 0 ? " again" : ""}${x.running ? " so far" : ""}`
                          : "No first-time customers this month";
                      return (
                        <td key={n} className="p-2 text-right" style={tint(v, max)} title={title}>
                          {text}
                          {x.running && <small className="block text-[10px] text-muted">so far</small>}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="mt-4 space-y-1 text-xs text-muted">
            <p>
              {showValue
                ? "Net sales: product sales after discounts and returns (returns made since included), before tax and shipping, counted in the month of the order. Not Shopify's \"amount spent\", which includes them."
                : "Darker: a larger share of the cohort ordered that month. Month 0 counts only orders after the first one; the current month is still running."}
              {items.some((c) => c.partial) ? ` A month marked "from" began before customers were known: its earlier first-time buyers aren't in it.` : ""} {money ? currency : null}
            </p>
            <Coverage r={r} />
          </div>
        </>
      )}
    </Panel>
  );
}
