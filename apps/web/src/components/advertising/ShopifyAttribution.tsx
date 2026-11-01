"use client";
import type { ReactNode } from "react";
import { fmtMoney, fmtNum, fmtPct } from "@/lib/api";
import { plural } from "@/components/dashboard/format";
import { ChangeText } from "@/components/dashboard/HomeCards";
import type { Overview } from "@/components/dashboard/types";
import { ShopifyIcon } from "@/components/ShopifyIcon";
import { AdCard } from "./AdCard";

// ---------------------------------------------------------------------------
// Shopify attribution: what happened in the store itself, from its own orders (the visit Shopify
// recorded before each), next to what the ad platforms say. The orders from Meta's and Google's sites,
// the part through links tagged as ads and what each of those cost in ad spend, the average order, new
// and returning customers, refunds and net sales. The store's figures are the whole store's unless they
// say otherwise; nothing here is the platforms' claim, and the two are never added together.
// ---------------------------------------------------------------------------

function Fig({ label, value, sub, change, testid }: { label: string; value: string; sub?: ReactNode; change?: ReactNode; testid: string }) {
  return (
    <div className="min-w-0 rounded-xl border border-border p-3" data-testid={testid}>
      <p className="truncate text-xs text-muted">{label}</p>
      <p className="mt-0.5 truncate text-xl font-bold tabular-nums tracking-tight" data-testid={`${testid}-value`}>
        {value}
      </p>
      {change && <div className="mt-1">{change}</div>}
      {sub && <p className="mt-1 text-[11px] text-muted">{sub}</p>}
    </div>
  );
}

export function AttributionSummary({ ov }: { ov: Overview }) {
  const m = ov.modules.ads_from_shopify;
  const s = ov.modules.sales_overview;
  const c = ov.modules.customers?.current;
  const refunds = ov.modules.refunds?.current;
  const a = ov.modules.ads;
  const currency = ov.store.currency;
  const money = (n: number) => fmtMoney(n, currency);
  const orders = m?.platforms.reduce((n, p) => n + p.orders, 0) ?? 0;
  const sales = m?.platforms.reduce((n, p) => n + p.sales, 0) ?? 0;
  const tagged = m?.platforms.every((p) => p.paidOrders !== undefined) ? m.platforms.reduce((n, p) => n + (p.paidOrders ?? 0), 0) : null;
  const taggedSales = tagged !== null && m ? m.platforms.reduce((n, p) => n + (p.paidSales ?? 0), 0) : null;
  // The spend set against the store's own counts: only every day of it, in the store's currency, never the demo's.
  const spend = a && !a.demo && a.currency === currency && a.current ? a.current.spend : null;
  return (
    <AdCard
      id="attribution-summary"
      title={
        <>
          <ShopifyIcon size={18} />
          What your store recorded
        </>
      }
      sub="From your Shopify orders, whatever the ad platforms claim. Orders count for the site their last visit came from (the last click)."
    >
      <div className="grid grid-cols-2 gap-3 @2xl:grid-cols-3 @4xl:grid-cols-4">
        {m && (
          <>
            <Fig label="Sales from Meta and Google sites" value={money(sales)} sub={`${plural(orders, "order")} · Facebook, Instagram, Google and YouTube`} testid="attr-sales" />
            <Fig label="Average order from those sites" value={orders > 0 ? money(sales / orders) : "—"} sub="Their sales ÷ their orders" testid="attr-aov" />
            {tagged !== null && taggedSales !== null && (
              <Fig label="From links tagged as ads" value={money(taggedSales)} sub={`${plural(tagged, "order")}: the sales Shopify credits to the ads`} testid="attr-tagged" />
            )}
            {tagged !== null && spend !== null && (
              <Fig
                label="Ad cost per tagged-ad order"
                value={tagged > 0 ? money(spend / tagged) : "—"}
                sub="Ad spend ÷ the orders Shopify credits to tagged ads"
                testid="attr-cost-per-order"
              />
            )}
          </>
        )}
        {s && (
          <>
            <Fig label="Net sales (whole store)" value={money(s.current.netSales)} sub="After discounts and returns, before tax and shipping" change={<ChangeText value={s.deltas.netSales} />} testid="attr-net-sales" />
            <Fig label="Average order value (whole store)" value={s.current.averageOrderValue === null ? "—" : money(s.current.averageOrderValue)} change={<ChangeText value={s.deltas.averageOrderValue} />} testid="attr-store-aov" />
          </>
        )}
        {c && (
          <>
            <Fig label="New customers (whole store)" value={fmtNum(c.newCustomers)} sub={`${fmtNum(c.returningCustomers)} returning${c.returningCustomerRate !== null ? `: ${fmtPct(c.returningCustomerRate)} of customers` : ""}`} testid="attr-new-customers" />
            {spend !== null && <Fig label="Ad spend per new customer" value={c.newCustomers > 0 ? money(spend / c.newCustomers) : "—"} sub="Ad spend ÷ every new customer, whatever brought them" testid="attr-cost-per-customer" />}
          </>
        )}
        {refunds && (
          <Fig
            label="Refunds (whole store)"
            value={money(refunds.refunds)}
            sub={`${plural(refunds.refundedOrders, "order")} refunded${refunds.refundRate !== null ? ` · ${fmtPct(refunds.refundRate)} of sales` : ""}. Net sales are already after returns.`}
            change={<ChangeText value={ov.modules.refunds?.deltas.refunds ?? null} invert />}
            testid="attr-refunds"
          />
        )}
      </div>
      {!m && <p className="mt-3 text-xs text-muted">Where each order came from needs your store&apos;s traffic sources, which you aren&apos;t shown.</p>}
      <p className="mt-3 text-xs text-muted">
        A tagged link carries utm_medium such as cpc or paid, or an ad click id; an ad whose links carry none counts as a visit from its site. New customers and refunds are your whole
        store&apos;s, so a cost per customer here is spend over every new customer, not only the ones the ads brought.
      </p>
    </AdCard>
  );
}
