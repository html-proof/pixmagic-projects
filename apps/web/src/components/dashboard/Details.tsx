"use client";
import Link from "next/link";
import type { ReactNode } from "react";
import type { CompareMode } from "@app/shared/dates";
import { bestEntryPage, biggestDropOff, dropOffSection } from "@app/shared/journey";
import { fmtMoney, fmtNum, fmtPct } from "@/lib/api";
import { BarRow, StackedBar } from "./Charts";
import { ContactsCard } from "./Contacts";
import { comparisonHelp, noEarlierData, versusWords } from "./DateRange";
import { FunnelCard, JourneyCard, SECTION_LABEL, STEP_LABEL } from "./Funnel";
import { fmtComparison, fmtDuration, fmtRange, hourRange, plural, weekdayNames } from "./format";
import { CatalogCard, ChannelsCard, DiscountCodesCard, FulfillmentCard, InventoryCard, OrderTimingCard, RecentOrdersCard, TrafficCard } from "./Modules";
import { AdsDetail } from "./AdsPanel";
import { AdsenseDetail } from "./AdsensePanel";
import { Explained } from "./Explain";
import { B, Change, comparedOn, InShort, upDown } from "./Narrative";
import { OverviewDetail } from "./Overview";
import { Delta, Panel, Stat } from "./Primitives";
import { DailySalesCard, MonthlySalesCard } from "./SalesBreakdown";
import type { Topic } from "./topics";
import type { Overview } from "./types";
import { breakdownOf } from "./redacted";

export type { Topic } from "./topics";

// ---------------------------------------------------------------------------
// Topics (./topics.ts): everything the dashboard knows, one tap away from its summary card.
// This is what goes inside the detail panel (./TopicDetail.tsx), loaded when a panel first opens.
// ---------------------------------------------------------------------------

const r2 = (n: number) => Math.round(n * 100) / 100;

/** A figure for the dates compared with, by how they were chosen. */
const COMPARE_LABEL: Record<CompareMode, string> = { previous: "The period before", year: "Same dates last year", custom: "The dates compared" };

/** The sales comparison table's title, by what the dates are compared with. */
const COMPARE_TITLE: Record<CompareMode, string> = {
  previous: "This period and the one before",
  year: "This period and the same dates last year",
  custom: "This period and the dates compared",
};

// ---------------------------------------------------------------------------
// Each topic.
// ---------------------------------------------------------------------------

function SalesDetail({ ov, currency }: { ov: Overview; currency: string }) {
  const s = ov.modules.sales_overview!;
  const c = s.current;
  const p = s.previous;
  const money = (n: number) => fmtMoney(n, currency);
  // Gross sales, discounts, tax, shipping and total sales, and returns, each only for someone who
  // may see them (Team & Access leaves them out of the answer otherwise). Returns follow from the
  // breakdown, so whoever sees it sees them too.
  const bd = breakdownOf(c);
  const refunds = c.returns ?? (bd ? r2(bd.grossSales - bd.discounts - c.netSales) : null);
  const total = c.totalSales ?? null;
  const r = ov.modules.refunds;
  const prevPeriod = fmtComparison(ov.previous);
  const versus = versusWords(ov);
  // Null when the imported orders don't reach back to the dates compared with: nothing is compared.
  const missing = ov.previous.imported === false ? noEarlierData(ov.data?.historyFrom) : null;
  const change = upDown(total !== null ? (s.deltas.totalSales ?? null) : s.deltas.netSales);
  const rows: Array<{ label: string; now: string; before: string; delta: number | null }> = [
    ...(total !== null ? [{ label: "Total sales", now: money(total), before: p?.totalSales !== undefined ? money(p.totalSales) : "—", delta: s.deltas.totalSales ?? null }] : []),
    { label: "Net sales", now: money(c.netSales), before: p ? money(p.netSales) : "—", delta: s.deltas.netSales },
    ...(bd ? [{ label: "Gross sales", now: money(bd.grossSales), before: p?.grossSales !== undefined ? money(p.grossSales) : "—", delta: s.deltas.grossSales ?? null }] : []),
    { label: "Orders", now: fmtNum(c.orders), before: p ? fmtNum(p.orders) : "—", delta: s.deltas.orders },
    { label: "Average order", now: money(c.averageOrderValue ?? 0), before: p && p.averageOrderValue !== null ? money(p.averageOrderValue) : "—", delta: s.deltas.averageOrderValue },
  ];
  // Shopify's "Total sales breakdown", in its order.
  const lines: Array<{ label: string; note: string; amount: number; sign: "" | "−" }> = bd
    ? [
        { label: "Gross sales", note: "Every item sold at its listed price, before tax.", amount: bd.grossSales, sign: "" },
        { label: "Discounts", note: "Codes and automatic discounts taken off.", amount: bd.discounts, sign: "−" },
        { label: "Returns", note: "What refunds, cancellations and order edits took back, on the day they were made.", amount: refunds ?? 0, sign: "−" },
      ]
    : [];
  // Duties and fees: what total sales holds besides net sales, shipping and taxes.
  const otherCharges = bd && total !== null ? r2(total - c.netSales - (bd.shipping ?? 0) - (bd.tax ?? 0)) : 0;
  const charges: Array<{ label: string; note: string; amount: number }> = bd
    ? [
        ...(bd.shipping !== null ? [{ label: "Shipping charges", note: "What customers paid for shipping, after shipping discounts and refunds.", amount: bd.shipping }] : []),
        ...(bd.tax !== null ? [{ label: "Taxes", note: "Collected on items and on shipping.", amount: bd.tax }] : []),
        ...(otherCharges !== 0 ? [{ label: "Duties and fees", note: "Import duties and other charges on orders.", amount: otherCharges }] : []),
      ]
    : [];

  return (
    <>
      <InShort>
        <p>
          {total !== null ? (
            <>
              Your total sales were <B>{money(total)}</B> from <B>{plural(c.orders, "order")}</B> ({plural(c.units, "item")} sold)
              {change ? <>, <B>{change}</B> on {prevPeriod}</> : null}. Before shipping and taxes, that&apos;s <B>{money(c.netSales)}</B> in net sales.
            </>
          ) : (
            <>
              You had <B>{money(c.netSales)}</B> in net sales from <B>{plural(c.orders, "order")}</B> ({plural(c.units, "item")} sold)
              {change ? <>, <B>{change}</B> on {prevPeriod}</> : null}.
            </>
          )}
        </p>
        {c.orders > 0 && (
          <p>
            A typical order was <B>{money(c.averageOrderValue ?? 0)}</B>.
            {bd ? (
              <>
                {" "}Discounts took off {money(bd.discounts)}
                {refunds !== null && refunds > 0 ? <> and returns {money(refunds)}</> : null}.
              </>
            ) : null}
          </p>
        )}
      </InShort>

      <Panel id="d-sales-glance" title="At a glance" help={missing ?? `Compared with ${comparisonHelp(ov.previous)}.`}>
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
          {total !== null && <Stat label="Total sales" value={money(total)} note={<Delta value={s.deltas.totalSales ?? null} label={versus} />} />}
          <Stat label="Net sales" value={money(c.netSales)} note={<Delta value={s.deltas.netSales} label={versus} />} />
          <Stat label="Orders" value={fmtNum(c.orders)} note={<Delta value={s.deltas.orders} label={versus} />} />
          <Stat label="Average order" value={money(c.averageOrderValue ?? 0)} note={<Delta value={s.deltas.averageOrderValue} label={versus} />} />
          {total === null && bd && <Stat label="Gross sales" value={money(bd.grossSales)} note={<Delta value={s.deltas.grossSales ?? null} label={versus} />} />}
          <Stat label="Items sold" value={fmtNum(c.units)} note={c.orders ? `${new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(c.units / c.orders)} per order` : undefined} />
          {r ? (
            <Stat label="Returns" value={money(r.current.refunds)} note={<Delta value={r.deltas.refunds} invert label={versus} />} />
          ) : refunds !== null ? (
            <Stat label="Returns" value={money(refunds)} />
          ) : null}
        </div>
      </Panel>

      {bd && (
        <Panel
          id="d-sales-adds-up"
          title={total !== null ? "How your total sales add up" : "How your net sales add up"}
          help="The same lines as Shopify's total sales breakdown, from Shopify's own sales records. Test orders aren't counted."
        >
          <ul className="divide-y divide-border text-sm">
            {lines.map((l) => (
              <li key={l.label} className="flex items-start justify-between gap-4 py-2.5">
                <div className="min-w-0">
                  <p className="font-medium">{l.label}</p>
                  <p className="text-xs text-muted">{l.note}</p>
                </div>
                <p className="shrink-0 tabular-nums">{l.sign && l.amount > 0 ? `${l.sign} ` : ""}{money(l.amount)}</p>
              </li>
            ))}
            <li className="flex items-center justify-between gap-4 py-2.5">
              <p className="font-semibold">= Net sales</p>
              <p className="font-semibold tabular-nums">{money(c.netSales)}</p>
            </li>
            {total !== null &&
              charges.map((l) => (
                <li key={l.label} className="flex items-start justify-between gap-4 py-2.5">
                  <div className="min-w-0">
                    <p className="font-medium">{l.label}</p>
                    <p className="text-xs text-muted">{l.note}</p>
                  </div>
                  <p className="shrink-0 tabular-nums">{l.amount !== 0 ? `${l.amount > 0 ? "+" : "−"} ` : ""}{money(Math.abs(l.amount))}</p>
                </li>
              ))}
            {total !== null && (
              <li className="flex items-center justify-between gap-4 py-2.5 text-base">
                <p className="font-semibold">= Total sales</p>
                <p className="font-semibold tabular-nums">{money(total)}</p>
              </li>
            )}
          </ul>
        </Panel>
      )}

      <Panel id="d-sales-compare" title={COMPARE_TITLE[ov.previous.compare ?? "previous"]} help={`${fmtRange(ov.range.from, ov.range.to)} against ${prevPeriod}.`}>
        <div className="-mx-1 overflow-x-auto">
          <table className="w-full min-w-[26rem] text-sm">
            <thead className="text-left text-xs text-muted">
              <tr>
                <th className="px-1 pb-2 font-normal" />
                <th className="px-1 pb-2 text-right font-normal">These dates</th>
                <th className="px-1 pb-2 text-right font-normal">Before</th>
                <th className="px-1 pb-2 text-right font-normal">Change</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.label} className="border-t border-border">
                  <td className="px-1 py-2 font-medium">{row.label}</td>
                  <td className="px-1 py-2 text-right tabular-nums">{row.now}</td>
                  <td className="px-1 py-2 text-right tabular-nums text-muted">{row.before}</td>
                  <td className="px-1 py-2 text-right tabular-nums"><Change value={row.delta} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="mt-2 text-xs text-muted">{missing ?? <>&quot;—&quot; means there were no sales before to compare with.</>}</p>
      </Panel>

      {r && (
        <Panel id="d-sales-refunds" title="Returns" help="Refunds, cancellations and edits, booked on the day they were made, not the day of the order.">
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
            <Stat label="Returned" value={money(r.current.refunds)} note={<Delta value={r.deltas.refunds} invert label={versus} />} />
            <Stat label="Return rate" value={fmtPct(r.current.refundRate)} note="Share of sales (after discounts) given back." />
            <Stat label="Orders with a return" value={fmtNum(r.current.refundedOrders)} note="Orders refunded, cancelled or edited down in these dates." />
          </div>
        </Panel>
      )}

      {ov.hasData && s.series.length > 1 && (
        <DailySalesCard series={s.series} range={ov.range} today={ov.today} historyFrom={ov.data?.historyFrom ?? null} currency={currency} />
      )}
      {s.year && s.year.orders > 0 && <MonthlySalesCard year={s.year} historyFrom={ov.data?.historyFrom ?? null} currency={currency} />}
    </>
  );
}

function ProductsDetail({ ov, currency }: { ov: Overview; currency: string }) {
  const items = ov.modules.top_products?.items ?? [];
  const c = ov.modules.sales_overview?.current;
  const money = (n: number) => fmtMoney(n, currency);
  // Product sales are each product's net sales: together they make the store's net sales.
  const base = c ? c.netSales : null;
  const share = (n: number) => (base && base > 0 ? n / base : null);
  const top = items[0];
  const topTotal = items.reduce((a, i) => a + i.revenue, 0);
  const topRevenue = Math.max(0, ...items.map((i) => i.revenue));
  return (
    <>
      <InShort>
        {top ? (
          <>
            <p>
              <B>{top.title}</B> sold best: <B>{money(top.revenue)}</B> from {plural(top.units, "unit")}
              {share(top.revenue) !== null ? <>, {fmtPct(share(top.revenue))} of your sales</> : null}.
            </p>
            {items.length > 1 && share(topTotal) !== null && (
              <p>
                Your top {items.length} products made <B>{fmtPct(share(topTotal))}</B> of sales in these dates.
              </p>
            )}
          </>
        ) : (
          <p>No product sales in these dates yet.</p>
        )}
      </InShort>
      {ov.modules.top_products && (
        <Panel id="d-top-products" title="Top products" help="Ranked by net sales in these dates (after discounts and returns, before tax), as Shopify's sales by product counts them.">
          {items.length === 0 ? (
            <p className="text-sm text-muted">No product sales in these dates yet.</p>
          ) : (
            <ul className="space-y-4">
              {items.map((p, rank) => (
                <BarRow
                  key={p.productId ?? p.title}
                  label={
                    <>
                      <span className={`mr-2 inline-flex h-5 w-5 items-center justify-center rounded-full text-[11px] font-semibold ${rank === 0 ? "bg-accent-2 text-white" : "bg-border text-muted"}`}>{rank + 1}</span>
                      {p.title}
                    </>
                  }
                  value={money(p.revenue)}
                  fraction={topRevenue > 0 ? p.revenue / topRevenue : 0}
                  sub={[
                    plural(p.units, "unit"),
                    p.units ? `${money(r2(p.revenue / p.units))} each on average` : null,
                    share(p.revenue) !== null ? `${fmtPct(share(p.revenue))} of sales` : null,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                />
              ))}
            </ul>
          )}
        </Panel>
      )}
      {ov.modules.catalog && <CatalogCard m={ov.modules.catalog} currency={currency} />}
    </>
  );
}

function ShoppersDetail({ ov }: { ov: Overview }) {
  const f = ov.modules.funnel!;
  const leak = biggestDropOff(f.steps);
  const where = dropOffSection(leak);
  const bestEntry = bestEntryPage(f.entryPages);
  const visitsChange = f.previous.imported === false ? "no earlier data to compare" : upDown(f.deltas.visits);
  return (
    <>
      <InShort>
        {f.visits === 0 ? (
          <p>No storefront visits recorded in these dates yet.</p>
        ) : (
          <>
            <p>
              Your store had <B>{plural(f.visits, "tracked visit")}</B>{visitsChange ? <> ({visitsChange})</> : null}, and <B>{fmtPct(f.conversionRate)}</B> of them ended in a purchase ({plural(f.purchases, "purchase")}).
            </p>
            {leak && leak.left > 0 && (
              <p>
                The biggest drop-off: <B>{fmtNum(leak.left)}</B> shoppers stopped at &ldquo;{STEP_LABEL[leak.step].toLowerCase()}&rdquo;
                {where ? <>, most of them on <B>{SECTION_LABEL[where].toLowerCase()}</B></> : null}.
              </p>
            )}
            {bestEntry && bestEntry.purchases > 0 && (
              <p>
                Visits that started on <B>{bestEntry.path === "/" ? "the home page" : bestEntry.path}</B> bought most often ({fmtPct(bestEntry.purchases / bestEntry.visits)}).
              </p>
            )}
          </>
        )}
      </InShort>
      <FunnelCard m={f} versus={versusWords(ov)} />
      {f.visits > 0 && <JourneyCard m={f} />}
    </>
  );
}

function TimingDetail({ ov }: { ov: Overview }) {
  const t = ov.modules.order_timing!;
  const total = t.byWeekday.reduce((a, b) => a + b, 0);
  const days = weekdayNames("long");
  const quietest = total ? t.byWeekday.indexOf(Math.min(...t.byWeekday)) : null;
  const weekend = total ? (t.byWeekday[5]! + t.byWeekday[6]!) / total : null;
  const topHours = t.byHour
    .map((n, h) => ({ h, n }))
    .filter((x) => x.n > 0)
    .sort((a, b) => b.n - a.n || a.h - b.h)
    .slice(0, 3);
  const max = Math.max(0, ...t.byWeekday);
  return (
    <>
      <InShort>
        {total === 0 ? (
          <p>Not enough orders in these dates to spot a pattern yet.</p>
        ) : (
          <>
            <p>
              Most orders come on <B>{t.busiestDay}s</B>
              {t.busiestHour !== null ? <>, especially <B>{hourRange(t.busiestHour)}</B></> : null}. The quietest day is {days[quietest!]}.
            </p>
            {weekend !== null && <p>Weekends bring {fmtPct(weekend)} of orders. Times are in the store&apos;s time zone ({ov.store.timezone}).</p>}
          </>
        )}
      </InShort>
      <OrderTimingCard m={t} timezone={ov.store.timezone} />
      {total > 0 && (
        <div className="grid gap-4 lg:grid-cols-2">
          <Panel id="d-timing-days" title="Orders by day" help="Every order in these dates, by the day of the week it was placed.">
            <ul className="space-y-3">
              {t.byWeekday.map((n, i) => (
                <BarRow key={days[i]} label={days[i]} value={plural(n, "order")} fraction={max ? n / max : 0} sub={`${fmtPct(n / total)} of orders`} />
              ))}
            </ul>
          </Panel>
          <Panel id="d-timing-hours" title="Busiest hours" help="The three hours with the most orders.">
            <ol className="space-y-3 text-sm">
              {topHours.map((x, i) => (
                <li key={x.h} className="flex items-center justify-between gap-3">
                  <span className="flex items-center gap-2">
                    <span className="inline-flex h-6 w-6 items-center justify-center rounded-full bg-border text-xs font-semibold">{i + 1}</span>
                    {hourRange(x.h)}
                  </span>
                  <span className="tabular-nums">{plural(x.n, "order")} <span className="text-muted">({fmtPct(x.n / total)})</span></span>
                </li>
              ))}
            </ol>
          </Panel>
        </div>
      )}
    </>
  );
}

function ChannelsDetail({ ov, currency }: { ov: Overview; currency: string }) {
  const items = ov.modules.channels!.items;
  const top = items[0];
  return (
    <>
      <InShort>
        {top ? (
          <p>
            <B>{top.label}</B> brought in <B>{fmtPct(top.share)}</B> of sales ({fmtMoney(top.sales, currency)} from {plural(top.orders, "order")}).
            {items.length > 1 ? <> Sales came through {plural(items.length, "channel")} in these dates.</> : null}
          </p>
        ) : (
          <p>No sales in these dates yet.</p>
        )}
      </InShort>
      <ChannelsCard m={ov.modules.channels!} currency={currency} />
      {ov.modules.traffic && <TrafficCard m={ov.modules.traffic} currency={currency} />}
    </>
  );
}

function ShippingDetail({ ov }: { ov: Overview }) {
  const f = ov.modules.fulfillment!;
  const c = f.current;
  return (
    <>
      <InShort>
        <p>
          {f.openNow === 0 ? (
            <>Every order has shipped. Nothing is waiting.</>
          ) : (
            <>
              <B>{plural(f.openNow, "order")}</B> {f.openNow === 1 ? "is" : "are"} waiting to ship
              {f.oldestOpenDays !== null ? <>; the oldest has waited <B>{plural(f.oldestOpenDays, "day")}</B></> : null}.
            </>
          )}
        </p>
        {c.orders > 0 && (
          <p>
            Of the {plural(c.orders, "order")} placed in these dates, {fmtPct(c.fulfilled / c.orders)} have shipped
            {c.avgHoursToFulfill !== null ? <>, taking {fmtDuration(c.avgHoursToFulfill)} on average</> : null}.
          </p>
        )}
      </InShort>
      <FulfillmentCard m={f} />
    </>
  );
}

function StockDetail({ ov, currency }: { ov: Overview; currency: string }) {
  const inv = ov.modules.inventory!;
  const c = inv.current;
  const first = inv.lowStockItems[0];
  return (
    <>
      <InShort>
        {c.trackedVariants === 0 ? (
          <p>No stock levels yet. They appear once your products are imported, for items where Shopify tracks quantity.</p>
        ) : (
          <>
            <p>
              You hold <B>{plural(c.unitsInStock, "unit")}</B> across {plural(c.trackedVariants, "variant")}. <B>{fmtNum(c.lowStock)}</B> {c.lowStock === 1 ? "is" : "are"} running low and{" "}
              <B>{fmtNum(c.outOfStock)}</B> {c.outOfStock === 1 ? "is" : "are"} sold out.
            </p>
            {first && (
              <p>
                Restock first: <B>{first.productTitle}</B>
                {first.variantTitle && first.variantTitle !== "Default Title" ? <> ({first.variantTitle})</> : null}, {fmtNum(first.quantity)} left
                {first.daysOfCover !== null ? <>, about {plural(Math.max(0, Math.round(first.daysOfCover)), "day")} of sales</> : null}.
              </p>
            )}
          </>
        )}
      </InShort>
      <InventoryCard m={inv} currency={currency} />
    </>
  );
}

function DiscountsDetail({ ov, currency }: { ov: Overview; currency: string }) {
  const items = ov.modules.discount_codes!.items;
  const c = ov.modules.sales_overview?.current;
  const top = items[0];
  return (
    <>
      <InShort>
        {top ? (
          <p>
            Customers used <B>{plural(items.length, "code")}</B>; <B>{top.code}</B> was used most, on {plural(top.orders, "order")}.
            {c && c.grossSales !== undefined && c.discounts !== undefined && c.grossSales > 0 ? <> All discounts together took {fmtMoney(c.discounts, currency)} off, {fmtPct(c.discounts / c.grossSales)} of full price.</> : null}
          </p>
        ) : (
          <p>No discount codes were used in these dates.</p>
        )}
      </InShort>
      {items.length > 0 && (
        <Panel id="d-codes-bars" title="Codes by orders" help="How often each code was used in these dates, and the net sales those orders brought in.">
          <ul className="space-y-4">
            {items.map((d) => (
              <BarRow
                key={d.code}
                label={<span className="font-mono">{d.code}</span>}
                value={plural(d.orders, "order")}
                fraction={items[0]!.orders > 0 ? d.orders / items[0]!.orders : 0}
                sub={d.sales !== undefined && d.discount !== undefined ? `${fmtMoney(d.sales, currency)} in net sales · ${fmtMoney(d.discount, currency)} in discounts` : undefined}
              />
            ))}
          </ul>
        </Panel>
      )}
      <DiscountCodesCard m={ov.modules.discount_codes!} currency={currency} />
    </>
  );
}

function CustomersDetail({ ov, contactsOn }: { ov: Overview; contactsOn: boolean }) {
  const cu = ov.modules.customers;
  const rate = cu?.current.returningCustomerRate ?? null;
  const before = cu?.previous.returningCustomerRate ?? null;
  return (
    <>
      {cu && (
        <>
          <InShort>
            {rate === null ? (
              <p>No orders with a known customer in these dates yet.</p>
            ) : (
              <p>
                <B>{fmtPct(rate)}</B> of orders came from people who had bought before
                {before !== null ? <> (it was {fmtPct(before)} for {comparedOn(ov)})</> : null}. The rest were first-time customers.
              </p>
            )}
          </InShort>
          <Panel id="d-customers" title="Returning customers" help="A customer counts as returning if Shopify says they have more than one order, or we have an earlier order from them.">
            <div className="grid grid-cols-2 gap-3">
              <Stat label="These dates" value={fmtPct(rate)} note="Orders from returning customers." />
              <Stat label={COMPARE_LABEL[ov.previous.compare ?? "previous"]} value={fmtPct(before)} note={ov.previous.imported === false ? "No earlier data" : fmtComparison(ov.previous)} />
            </div>
            {rate !== null && (
              <div className="mt-5">
                <p className="mb-2 text-xs text-muted">Orders with a known customer in these dates</p>
                <StackedBar
                  label="Returning and first-time customers"
                  format={(v) => fmtPct(v / 1000)}
                  segments={[
                    { label: "Returning customers", value: Math.round(rate * 1000), fill: "bg-[var(--viz-cat-1)]" },
                    { label: "First orders", value: Math.round((1 - rate) * 1000), fill: "bg-[var(--viz-cat-3)]" },
                  ]}
                />
              </div>
            )}
          </Panel>
        </>
      )}
      {contactsOn && <ContactsCard key={ov.store.id} storeId={ov.store.id} storeName={ov.store.name ?? ov.store.shopDomain} shopDomain={ov.store.shopDomain} />}
    </>
  );
}

function OrdersDetail({ ov, currency }: { ov: Overview; currency: string }) {
  const items = ov.modules.recent_orders!.items;
  const cancelled = items.filter((o) => o.cancelled).length;
  return (
    <>
      <InShort>
        {items.length ? (
          <p>
            Your latest order is <B>{items[0]!.name}</B> for <B>{fmtMoney(items[0]!.total, currency)}</B>. Open any order to see it in Shopify.
            {cancelled ? <> {plural(cancelled, "order")} here {cancelled === 1 ? "was" : "were"} cancelled.</> : null}
          </p>
        ) : (
          <p>No orders imported yet.</p>
        )}
      </InShort>
      <RecentOrdersCard items={items} currency={currency} timezone={ov.store.timezone} shopDomain={ov.store.shopDomain} />
    </>
  );
}

/** Everything inside the detail panel for one topic: its own figures, then what to do about them and what they mean. */
export function TopicContents({
  topic,
  ov,
  currency,
  contactsOn,
  onOpen,
}: {
  topic: Topic;
  ov: Overview;
  currency: string;
  contactsOn: boolean;
  /** Open another topic from inside this one (the overview's rows). */
  onOpen: (t: Topic) => void;
}) {
  const m = ov.modules;
  // A topic whose module isn't there (scopes changed, another store) shows nothing rather than crash.
  const body: ReactNode =
    topic === "overview" ? <OverviewDetail ov={ov} currency={currency} onOpen={onOpen} />
    : topic === "sales" && m.sales_overview ? <SalesDetail ov={ov} currency={currency} />
    : topic === "ads" && m.ads ? <AdsDetail ov={ov} />
    : topic === "adsense" && m.adsense ? <AdsenseDetail ov={ov} />
    : topic === "products" && (m.top_products || m.catalog) ? <ProductsDetail ov={ov} currency={currency} />
    : topic === "shoppers" && m.funnel ? <ShoppersDetail ov={ov} />
    : topic === "timing" && m.order_timing ? <TimingDetail ov={ov} />
    : topic === "channels" && m.channels ? <ChannelsDetail ov={ov} currency={currency} />
    : topic === "shipping" && m.fulfillment ? <ShippingDetail ov={ov} />
    : topic === "stock" && m.inventory ? <StockDetail ov={ov} currency={currency} />
    : topic === "discounts" && m.discount_codes ? <DiscountsDetail ov={ov} currency={currency} />
    : topic === "customers" && (m.customers || contactsOn) ? <CustomersDetail ov={ov} contactsOn={contactsOn} />
    : topic === "orders" && m.recent_orders ? <OrdersDetail ov={ov} currency={currency} />
    // The sidebar's Marketing opens this before any ad account is connected: say where that's done.
    : topic === "ads" ? (
      <p className="text-sm text-muted">
        No ad accounts are connected to this store yet. Connect Meta Ads or Google Ads in{" "}
        <Link href="/settings/ads" className="font-medium text-accent underline">Settings → Advertising</Link> and their results show up here.
      </p>
    )
    : <p className="text-sm text-muted">There&apos;s nothing to show here for this store yet.</p>;
  return (
    <>
      {body}
      {/* Then, under every topic: what to do about it, and what each number means. */}
      <Explained topic={topic} ov={ov} currency={currency} />
    </>
  );
}
