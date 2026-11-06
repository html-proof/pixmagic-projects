"use client";
import { gradeCover, gradeShipping, type Grade } from "@app/shared/health";
import type { TrafficSplit } from "@app/shared/traffic";
import Link from "next/link";
import { useApp } from "@/components/AppContext";
import { fmtMoney, fmtNum, fmtPct } from "@/lib/api";
import { BarRow, ColumnChart, StackedBar } from "./Charts";
import { fmtDateTime, fmtDuration, hourLabel, hourRange, humanize, plural, weekdayNames } from "./format";
import { Badge, Empty, Panel, Stat, type Tone } from "./Primitives";
import type {
  CatalogModule,
  ChannelsModule,
  DiscountCodesModule,
  FulfillmentModule,
  InventoryModule,
  OrderTimingModule,
  RecentOrder,
  TrafficModule,
} from "./types";

/** How a grade (@app/shared/health) is colored. */
const GRADE_TONE: Record<Grade, Tone> = { good: "good", watch: "warn", attention: "danger" };

export function ChannelsCard({ m, currency }: { m: ChannelsModule; currency: string }) {
  return (
    <Panel id="channels" title="Sales by channel" help="Where this period's orders came from, by sales after discounts (before tax and shipping).">
      {m.items.length === 0 ? (
        <Empty>No sales to show for these dates.</Empty>
      ) : (
        <ul className="space-y-4">
          {m.items.map((c) => (
            <BarRow
              key={c.source ?? "unknown"}
              label={
                <>
                  {c.label}
                  {c.source && /^\d+$/.test(c.source) && <span className="ml-1 text-xs text-muted">(app {c.source})</span>}
                </>
              }
              value={fmtMoney(c.sales, currency)}
              fraction={c.share ?? 0}
              sub={`${plural(c.orders, "order")} · ${fmtPct(c.share)} of sales`}
            />
          ))}
        </ul>
      )}
    </Panel>
  );
}

/** One colour per split, the same wherever it is drawn: paid in the ad-spend colour, organic in the sales colour (HomePanels). */
const SPLIT_COLOR: Record<TrafficSplit, string> = { paid: "var(--viz-cat-2)", organic: "var(--viz-cat-3)", email: "var(--viz-cat-1)", direct: "var(--muted)", unknown: "var(--border)" };

/**
 * Paid vs organic (TrafficModule.split): one part-to-whole bar and its legend, each split's sales, share
 * and orders. A split whose sales come to nothing or less (returns) has no width in the bar; its figure
 * is still written as it is.
 */
export function TrafficSplitBar({ split, currency }: { split: NonNullable<TrafficModule["split"]>; currency: string }) {
  return (
    <figure className="min-w-0" data-testid="traffic-split">
      <div
        className="animate-grow-x flex h-3 gap-[2px] overflow-hidden rounded-full bg-bg"
        role="img"
        aria-label={`Sales by how the last visit came: ${split.map((p) => `${p.label} ${fmtMoney(p.sales, currency)}`).join(", ")}`}
      >
        {split
          .filter((p) => p.sales > 0)
          .map((p) => (
            <div key={p.id} className="h-full" style={{ flexGrow: p.sales, flexBasis: 0, minWidth: 4, background: SPLIT_COLOR[p.id] }} title={`${p.label}: ${fmtMoney(p.sales, currency)} (${fmtPct(p.share)})`} />
          ))}
      </div>
      <ul className="mt-3 space-y-1.5 text-sm">
        {split.map((p) => (
          <li key={p.id} className="flex min-w-0 items-center gap-2" data-testid={`traffic-split-${p.id}`}>
            <span aria-hidden className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: SPLIT_COLOR[p.id] }} />
            <span className="min-w-0 flex-1 truncate">
              {p.label} <span className="text-xs text-muted">· {plural(p.orders, "order")}</span>
            </span>
            <span className="font-medium tabular-nums">{fmtMoney(p.sales, currency)}</span>
            <span className="w-12 text-right text-xs tabular-nums text-muted">{fmtPct(p.share)}</span>
          </li>
        ))}
      </ul>
    </figure>
  );
}

/** What the paid vs organic split is, said wherever it is shown: last click, from Shopify's record, not the platforms' attribution. */
export function TrafficSplitNote() {
  return (
    <p className="mt-3 text-xs text-muted">
      Last click: the visit Shopify recorded just before each order, not what Meta or Google credit to their ads (they also count earlier clicks and views).
      &ldquo;Paid&rdquo; is a link tagged as an ad: Google adds its click id by itself; for Facebook and Instagram, add URL parameters such as utm_medium=paid, or their
      sales count as organic. Organic is search, social posts and other websites; orders without a recorded visit (point of sale, draft orders, apps) are &ldquo;Not
      recorded&rdquo;.
    </p>
  );
}

/**
 * Where sales came from: the visit Shopify recorded before each order (an ad, a post, a search, an
 * email, a typed address). The store's own view, so it needs no ad account, and it is never mixed
 * with what an ad platform says its ads brought.
 */
export function TrafficCard({ m, currency }: { m: TrafficModule; currency: string }) {
  const known = m.items.filter((x) => x.source !== "unknown");
  return (
    <Panel
      id="traffic"
      title="Where your sales come from"
      help="The visit Shopify recorded before each order: an ad, a post, a search, an email or a typed address. Sales after discounts, before tax and shipping."
      aside={m.paid && m.paid.sales > 0 ? <span className="text-xs text-muted">From tagged ads: <strong className="text-text">{fmtMoney(m.paid.sales, currency)}</strong> ({fmtPct(m.paid.share)})</span> : undefined}
    >
      {m.pending > 0 && (
        <p className="mb-3 text-xs text-muted">
          Reading from Shopify where {plural(m.pending, "older order")} came from; {m.pending === 1 ? "it appears" : "they appear"} here within a few minutes.
        </p>
      )}
      {m.split && m.items.length > 0 && (
        <div className="mb-5">
          <h3 className="mb-2 text-sm font-medium">Paid vs organic</h3>
          <TrafficSplitBar split={m.split} currency={currency} />
        </div>
      )}
      {m.items.length === 0 ? (
        <Empty>{m.pending > 0 ? "Sources are being read from Shopify." : "No sales to show for these dates."}</Empty>
      ) : (
        <ul className="space-y-4">
          {m.items.map((x) => (
            <BarRow
              key={x.id}
              label={x.label}
              value={fmtMoney(x.sales, currency)}
              fraction={x.share ?? 0}
              sub={
                <>
                  {plural(x.orders, "order")} · {fmtPct(x.share)} of sales
                  {x.paidOrders !== undefined && x.paidOrders > 0 && x.paidOrders < x.orders && <> · {fmtMoney(x.paidSales, currency)} from tagged ads</>}
                  {x.paidOrders !== undefined && x.paidOrders > 0 && x.paidOrders === x.orders && <> · all from tagged ads</>}
                </>
              }
            />
          ))}
        </ul>
      )}
      {m.campaigns && m.campaigns.length > 0 && (
        <div className="mt-5">
          <h3 className="text-sm font-medium">Campaigns</h3>
          <p className="text-xs text-muted">From the campaign name in your ad and email links (utm_campaign).</p>
          <ul className="mt-2 divide-y divide-border text-sm">
            {m.campaigns.map((c) => (
              <li key={`${c.source}:${c.campaign}`} className="flex flex-wrap items-baseline justify-between gap-2 py-2">
                <span className="min-w-0 truncate">
                  <span className="font-medium">{c.campaign}</span> <span className="text-xs text-muted">{c.label}</span>
                </span>
                <span className="tabular-nums">
                  {fmtMoney(c.sales, currency)} <span className="text-xs text-muted">· {plural(c.orders, "order")}</span>
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {known.length > 0 && (
        <p className="mt-4 text-xs text-muted">
          &ldquo;Tagged ads&rdquo; are visits whose link said it was an ad (Google and TikTok add this by themselves; for Facebook and Instagram, add URL parameters such
          as utm_medium=paid to your ads). An ad platform&apos;s own report credits sales differently, so its numbers won&apos;t match these.
        </p>
      )}
    </Panel>
  );
}

export function OrderTimingCard({ m, timezone }: { m: OrderTimingModule; timezone: string }) {
  const total = m.byWeekday.reduce((a, b) => a + b, 0);
  const days = weekdayNames("long");
  const busiestDay = m.byWeekday.indexOf(Math.max(...m.byWeekday));
  const orders = (n: number) => plural(n, "order");
  return (
    <Panel
      id="order_timing"
      title="When customers buy"
      help={`Orders by day and hour, in the store's time zone (${timezone}).`}
      aside={
        total > 0 && m.busiestHour !== null ? (
          <p className="text-xs text-muted">
            Busiest day <strong className="text-text">{days[busiestDay] ?? m.busiestDay}</strong>
            <span aria-hidden="true"> · </span>
            Busiest hour <strong className="text-text">{hourRange(m.busiestHour)}</strong>
          </p>
        ) : undefined
      }
    >
      {total === 0 ? (
        <Empty>Not enough orders in these dates to spot a pattern yet.</Empty>
      ) : (
        <div className="grid gap-6">
          <ColumnChart label="Orders by day of the week" values={m.byWeekday} labels={days} tickLabels={weekdayNames("short")}highlight={total ? busiestDay : null} format={orders} />
          <ColumnChart
            label="Orders by hour of the day"
            values={m.byHour}
            labels={m.byHour.map((_, h) => hourRange(h))}
            tickLabels={m.byHour.map((_, h) => (h % 6 === 0 ? hourLabel(h) : ""))}
            highlight={m.busiestHour}
            format={orders}
          />
        </div>
      )}
    </Panel>
  );
}

export function FulfillmentCard({ m }: { m: FulfillmentModule }) {
  const c = m.current;
  const other = Math.max(0, c.orders - c.fulfilled - c.partiallyFulfilled - c.unfulfilled);
  const waitingTone: Tone = GRADE_TONE[gradeShipping(m.openNow, m.oldestOpenDays)];
  return (
    <Panel id="fulfillment" title="Fulfillment" help="How quickly orders ship, and what's still waiting.">
      <div className="grid gap-3 sm:grid-cols-3">
        <Stat
          label="Waiting to ship"
          value={fmtNum(m.openNow)}
          tone={waitingTone}
          note={m.openNow === 0 ? "All caught up." : m.oldestOpenDays !== null ? `Oldest has waited ${plural(m.oldestOpenDays, "day")}.` : undefined}
        />
        <Stat label="Average time to ship" value={fmtDuration(c.avgHoursToFulfill)} note="From order to first shipment, for orders in these dates." />
        <Stat label="Fulfilled" value={fmtPct(c.orders ? c.fulfilled / c.orders : null)} note={`${fmtNum(c.fulfilled)} of ${plural(c.orders, "order")} in these dates.`} />
      </div>
      {c.orders > 0 && (
        <div className="mt-5">
          <p className="mb-2 text-xs text-muted">Orders placed in these dates, by fulfillment status</p>
          <StackedBar
            label="Fulfillment status"
            segments={[
              { label: "Fulfilled", value: c.fulfilled, fill: "bg-good" },
              { label: "Partly fulfilled", value: c.partiallyFulfilled, fill: "bg-warn" },
              { label: "Unfulfilled", value: c.unfulfilled, fill: "bg-muted" },
              { label: "Other", value: other, fill: "bg-border" },
            ]}
          />
        </div>
      )}
      <p className="mt-4 text-xs text-muted">&quot;Waiting to ship&quot; counts every open order, whatever its date, that is unfulfilled, partly fulfilled, on hold or scheduled.</p>
    </Panel>
  );
}

export function DiscountCodesCard({ m, currency }: { m: DiscountCodesModule; currency: string }) {
  // Amounts per code need "View discount performance" (Team & Access).
  const money = m.items.some((d) => d.sales !== undefined);
  return (
    <Panel id="discount_codes" title="Discount codes" help="Codes customers used most in these dates. Amounts are the discounts on the items of the orders that used each code, automatic ones included, before tax, as in the Discounts line (shipping discounts are in shipping). An order with several codes counts toward each.">
      {m.items.length === 0 ? (
        <Empty>No discount codes were used in these dates.</Empty>
      ) : (
        <div className="-mx-1 overflow-x-auto">
          <table className="w-full min-w-[22rem] text-sm">
            <thead className="text-left text-xs text-muted">
              <tr>
                <th className="px-1 pb-2 font-normal">Code</th>
                <th className="px-1 pb-2 text-right font-normal">Orders</th>
                {money && <th className="px-1 pb-2 text-right font-normal">Discounts on these orders</th>}
                {money && <th className="px-1 pb-2 text-right font-normal">Net sales</th>}
              </tr>
            </thead>
            <tbody>
              {m.items.map((d) => (
                <tr key={d.code} className="border-t border-border">
                  <td className="px-1 py-2">
                    <span className="rounded border border-border bg-bg px-1.5 py-0.5 font-mono text-xs">{d.code}</span>
                  </td>
                  <td className="px-1 py-2 text-right tabular-nums">{fmtNum(d.orders)}</td>
                  {money && <td className="px-1 py-2 text-right tabular-nums">{fmtMoney(d.discount, currency)}</td>}
                  {money && <td className="px-1 py-2 text-right tabular-nums">{fmtMoney(d.sales, currency)}</td>}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}

const financialTone = (s: string | null | undefined): Tone =>
  s === "paid" ? "good" : s === "pending" || s === "authorized" || s === "partially_paid" || s === "expired" ? "warn" : "neutral";
const fulfillmentTone = (s: string | null | undefined): Tone =>
  s === "fulfilled" ? "good" : s === "restocked" || s === "request_declined" || s === null ? "neutral" : "warn";

/** Order number, linking to the order in the merchant's Shopify admin when we know its id. */
export function OrderName({ o, shopDomain }: { o: RecentOrder; shopDomain: string }) {
  const cls = o.cancelled ? "line-through" : "";
  if (!o.shopifyId) return <span className={cls}>{o.name}</span>;
  return (
    <a className={`hover:underline ${cls}`} href={`https://${shopDomain}/admin/orders/${encodeURIComponent(o.shopifyId)}`} target="_blank" rel="noopener noreferrer" title="Open in Shopify admin">
      {o.name}
    </a>
  );
}

// Payment, fulfillment and cancellation each need their own permission (Team & Access): a field
// that isn't in the answer gets no badge, rather than a guess.
export const PaymentBadge = ({ o }: { o: RecentOrder }) =>
  o.cancelled ? (
    <Badge tone="danger">Cancelled</Badge>
  ) : o.financialStatus !== undefined ? (
    <Badge tone={financialTone(o.financialStatus)}>{humanize(o.financialStatus)}</Badge>
  ) : null;
export const FulfillmentBadge = ({ o }: { o: RecentOrder }) =>
  o.fulfillmentStatus !== undefined ? <Badge tone={fulfillmentTone(o.fulfillmentStatus)}>{o.fulfillmentStatus ? humanize(o.fulfillmentStatus) : "Not synced yet"}</Badge> : null;

export function RecentOrdersCard({ items, currency, timezone, shopDomain }: { items: RecentOrder[]; currency: string; timezone: string; shopDomain: string }) {
  const showPayment = items.some((o) => o.financialStatus !== undefined || o.cancelled !== undefined);
  const showFulfillment = items.some((o) => o.fulfillmentStatus !== undefined);
  return (
    <Panel id="recent_orders" title="Recent orders" help={`The 10 latest orders, whatever dates are selected. Times are in the store's time zone (${timezone}).`}>
      {items.length === 0 ? (
        <Empty>No orders have been imported yet. They appear here as soon as they arrive from Shopify.</Empty>
      ) : (
        <>
        {/* Phones: stacked rows instead of a wide table. */}
        <ul className="divide-y divide-border sm:hidden">
          {items.map((o) => (
            <li key={o.id} className={`py-2.5 text-sm ${o.cancelled ? "text-muted" : ""}`}>
              <div className="flex items-baseline justify-between gap-3">
                <span className="font-medium"><OrderName o={o} shopDomain={shopDomain} /></span>
                <span className="font-medium tabular-nums">{fmtMoney(o.total, currency)}</span>
              </div>
              <p className="mt-0.5 text-xs text-muted">
                {fmtDateTime(o.createdAt, timezone)} · {o.channel} · {plural(o.units, "item")}
              </p>
              <div className="mt-1.5 flex flex-wrap gap-1.5">
                <PaymentBadge o={o} />
                <FulfillmentBadge o={o} />
              </div>
            </li>
          ))}
        </ul>
        <div className="-mx-1 hidden overflow-x-auto sm:block">
          <table className="w-full min-w-[40rem] text-sm">
            <thead className="text-left text-xs text-muted">
              <tr>
                <th className="px-1 pb-2 font-normal">Order</th>
                <th className="px-1 pb-2 font-normal">Placed</th>
                <th className="px-1 pb-2 font-normal">Channel</th>
                <th className="px-1 pb-2 text-right font-normal">Items</th>
                {showPayment && <th className="px-1 pb-2 font-normal">Payment</th>}
                {showFulfillment && <th className="px-1 pb-2 font-normal">Fulfillment</th>}
                <th className="px-1 pb-2 text-right font-normal">Total</th>
              </tr>
            </thead>
            <tbody>
              {items.map((o) => (
                <tr key={o.id} className={`border-t border-border ${o.cancelled ? "text-muted" : ""}`}>
                  <td className="px-1 py-2 font-medium"><OrderName o={o} shopDomain={shopDomain} /></td>
                  <td className="whitespace-nowrap px-1 py-2">{fmtDateTime(o.createdAt, timezone)}</td>
                  <td className="px-1 py-2">{o.channel}</td>
                  <td className="px-1 py-2 text-right tabular-nums">{fmtNum(o.units)}</td>
                  {showPayment && <td className="px-1 py-2"><PaymentBadge o={o} /></td>}
                  {showFulfillment && <td className="px-1 py-2"><FulfillmentBadge o={o} /></td>}
                  <td className="whitespace-nowrap px-1 py-2 text-right tabular-nums">{fmtMoney(o.total, currency)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        </>
      )}
    </Panel>
  );
}

const coverLabel = (d: number | null) => (d === null ? "No recent sales" : d < 1 ? "Under a day" : `About ${plural(Math.round(d), "day")}`);
const coverTone = (d: number | null, qty: number): Tone => GRADE_TONE[gradeCover(d, qty)];

/** The way from the dashboard's stock card to the Inventory section, for whoever may open it. */
function OpenInventory() {
  const { allowed, offers } = useApp();
  if (!offers("inventory") || !allowed("inventory.view")) return null;
  return (
    <Link href="/inventory" className="text-accent underline">
      Open Inventory
    </Link>
  );
}

export function InventoryCard({ m, currency }: { m: InventoryModule; currency: string }) {
  const c = m.current;
  if (c.trackedVariants === 0) {
    return (
      <Panel id="inventory" title="Inventory" help="Stock on hand, what it's worth and what's about to run out." aside={<OpenInventory />}>
        <Empty>No stock levels yet. They appear once your products and variants are imported, for items where Shopify tracks quantity.</Empty>
      </Panel>
    );
  }
  // What the stock is worth needs "View stock value and prices" (Team & Access).
  const valued = c.retailValue !== undefined;
  const costNote =
    c.stockValueAtCost === null
      ? "Add a cost per item in Shopify to see this."
      : c.variantsWithCost !== undefined && c.variantsWithCost < c.trackedVariants
        ? `Based on ${fmtNum(c.variantsWithCost)} of ${plural(c.trackedVariants, "variant")} with a cost.`
        : "What you paid for the stock you hold.";
  return (
    <Panel id="inventory" title="Inventory" help="Stock across all locations for active and draft products, as the Inventory section counts it. Running low: at or under the low-stock threshold (10 unless you set one in Inventory → Stock settings)." aside={<OpenInventory />}>
      <div className={`grid grid-cols-2 gap-3 ${valued ? "lg:grid-cols-5" : "lg:grid-cols-3"}`}>
        <Stat label="Units in stock" value={fmtNum(c.unitsInStock)} note={`Across ${plural(c.trackedVariants, "tracked variant")}.`} />
        {valued && <Stat label="Stock value at cost" value={fmtMoney(c.stockValueAtCost, currency)} note={costNote} />}
        {valued && <Stat label="Retail value" value={fmtMoney(c.retailValue, currency)} note="If everything sold at today's prices." />}
        <Stat label="Out of stock" value={fmtNum(c.outOfStock)} tone={c.outOfStock > 0 ? "danger" : "good"} note="Variants with nothing left to sell." />
        <Stat className="col-span-2 lg:col-span-1" label="Running low" value={fmtNum(c.lowStock)} tone={c.lowStock > 0 ? "warn" : "good"} note="At or under the low-stock threshold, counting every location." />
      </div>
      <h3 className="mt-6 text-sm font-medium">Restock soon</h3>
      {m.lowStockItems.length === 0 ? (
        <p className="mt-2 text-sm text-muted">Nothing is running low right now.</p>
      ) : (
        <>
        {/* Phones: one compact row per item, so "runs out in" stays visible. */}
        <ul className="mt-2 divide-y divide-border sm:hidden">
          {m.lowStockItems.map((i, idx) => (
            <li key={`${i.productTitle}-${i.variantTitle}-${i.sku ?? idx}`} className="flex items-start justify-between gap-3 py-2 text-sm">
              <div className="min-w-0">
                <p className="truncate font-medium">{i.productTitle}</p>
                <p className="truncate text-xs text-muted">
                  {[i.variantTitle !== "Default Title" ? i.variantTitle : null, i.sku].filter(Boolean).join(" · ") || "—"}
                </p>
                <p className="text-xs text-muted">
                  {fmtNum(i.quantity)} left{i.dailySales ? ` · sells ${new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(i.dailySales)}/day` : ""}
                </p>
              </div>
              <Badge tone={coverTone(i.daysOfCover, i.quantity)}>{coverLabel(i.daysOfCover)}</Badge>
            </li>
          ))}
        </ul>
        <div className="-mx-1 mt-2 hidden overflow-x-auto sm:block">
          <table className="w-full min-w-[34rem] text-sm">
            <thead className="text-left text-xs text-muted">
              <tr>
                <th className="px-1 pb-2 font-normal">Product</th>
                <th className="px-1 pb-2 font-normal">SKU</th>
                <th className="px-1 pb-2 text-right font-normal">In stock</th>
                <th className="px-1 pb-2 text-right font-normal">Sells per day</th>
                <th className="px-1 pb-2 font-normal">Runs out in</th>
              </tr>
            </thead>
            <tbody>
              {m.lowStockItems.map((i, idx) => (
                <tr key={`${i.productTitle}-${i.variantTitle}-${i.sku ?? idx}`} className="border-t border-border">
                  <td className="px-1 py-2">
                    <span className="font-medium">{i.productTitle}</span>
                    {i.variantTitle && i.variantTitle !== "Default Title" && <span className="text-muted"> · {i.variantTitle}</span>}
                  </td>
                  <td className="px-1 py-2 font-mono text-xs text-muted">{i.sku ?? "—"}</td>
                  <td className="px-1 py-2 text-right tabular-nums">{fmtNum(i.quantity)}</td>
                  <td className="px-1 py-2 text-right tabular-nums">{i.dailySales ? new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(i.dailySales) : "—"}</td>
                  <td className="px-1 py-2">
                    <Badge tone={coverTone(i.daysOfCover, i.quantity)}>{coverLabel(i.daysOfCover)}</Badge>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        </>
      )}
    </Panel>
  );
}

export function CatalogCard({ m, currency }: { m: CatalogModule; currency: string }) {
  const topRevenue = Math.max(...m.topVendors.map((v) => v.revenue), 0);
  return (
    <Panel
      id="catalog"
      title="Catalog"
      help="Your products by status, and the brands that sold best in these dates."
      aside={
        <p className="text-right text-xs text-muted">
          <strong className="text-base text-text">{fmtNum(m.products.total)}</strong> products
          <br />
          {plural(m.variants, "variant")}
        </p>
      }
    >
      {m.products.total === 0 ? (
        <Empty>No products imported yet.</Empty>
      ) : (
        <StackedBar
          label="Products by status"
          segments={[
            { label: "Active", value: m.products.active, fill: "bg-accent" },
            { label: "Draft", value: m.products.draft, fill: "bg-accent/40" },
            { label: "Archived", value: m.products.archived, fill: "bg-border" },
          ]}
        />
      )}
      <h3 className="mt-6 text-sm font-medium">Top vendors</h3>
      {m.topVendors.length === 0 ? (
        <p className="mt-2 text-sm text-muted">No vendor sales in these dates.</p>
      ) : (
        <ul className="mt-3 space-y-4">
          {m.topVendors.map((v) => (
            <BarRow key={v.vendor} label={v.vendor} value={fmtMoney(v.revenue, currency)} fraction={topRevenue > 0 ? v.revenue / topRevenue : 0} sub={plural(v.units, "unit") + " sold"} />
          ))}
        </ul>
      )}
    </Panel>
  );
}
