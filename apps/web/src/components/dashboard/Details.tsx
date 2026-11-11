"use client";
import type { ReactNode } from "react";
import { seesModule } from "@app/shared/access";
import type { CompareMode } from "@app/shared/dates";
import { useApp } from "@/components/AppContext";
import { MoreDetail } from "@/components/MoreDetail";
import { seesTopic } from "@/lib/access";
import { fmtMoney, fmtNum, fmtPct } from "@/lib/api";
import { BarRow } from "./Charts";
import { noEarlierData, versusWords } from "./DateRange";
import { fmtComparison, fmtRange, hourRange, plural, weekdayNames } from "./format";
import { ChannelsCard, DiscountCodesCard, FulfillmentCard, InventoryCard, OrderTimingCard, TrafficCard } from "./Modules";
import { Explained } from "./Explain";
import { B, Change, InShort } from "./Narrative";
import { OverviewDetail } from "./Overview";
import { Delta, Panel, Stat } from "./Primitives";
import { profitCardFigures } from "./profitFigures";
import { DailySalesCard, MonthlySalesCard } from "./SalesBreakdown";
import { SectionName } from "./SalesFrame";
import { ComparedFoot, CustomersTab, OrdersTab, ProductsTab, SalesOverviewTab } from "./SalesViews";
import { ProfitCard, ShopifyCheckCard } from "./ShopifyReports";
import { openView, type Topic } from "./topics";
import type { Overview } from "./types";
import { appliedCustom, salesLinesOf } from "./redacted";
import { TotalSalesBreakdown } from "./TotalSalesBreakdown";

export type { Topic } from "./topics";

// ---------------------------------------------------------------------------
// Topics (./topics.ts): everything the dashboard knows, each a page of its own (?view=<topic>,
// app/(app)/dashboard/page.tsx). Overview, Products, Customers and Orders & shipping are drawn as
// the owner's approved Stitch design draws the Sales tabs (./SalesViews.tsx); the rest, and the
// panels with more detail under the Overview, are here. Loaded when a topic is first opened, so the
// Home starts without it.
// ---------------------------------------------------------------------------

/** The sales comparison table's title, by what the dates are compared with. */
const COMPARE_TITLE: Record<CompareMode, string> = {
  previous: "This period and the one before",
  year: "This period and the same dates last year",
  custom: "This period and the dates compared",
};

// ---------------------------------------------------------------------------
// Each topic.
// ---------------------------------------------------------------------------

/**
 * Under the Sales overview: the panels with more detail than its layout has room for (total sales
 * line by line with Custom sales, the check against Shopify, gross profit, the comparison table,
 * returns, and sales day by day and month by month).
 */
function SalesMore({ ov, currency }: { ov: Overview; currency: string }) {
  const { access, offers } = useApp();
  // Advertising as the home page has it (app/(app)/dashboard/page.tsx), so Shopify's gross profit
  // card gives the same net profit as Business profit overview.
  const adsOn = offers("ads") && seesTopic(access, "ads", offers);
  const s = ov.modules.sales_overview!;
  const c = s.current;
  const p = s.previous;
  const money = (n: number) => fmtMoney(n, currency);
  const total = c.totalSales ?? null;
  const r = ov.modules.refunds;
  const prevPeriod = fmtComparison(ov.previous);
  const versus = versusWords(ov);
  // Null when the imported orders don't reach back to the dates compared with: nothing is compared.
  const missing = ov.previous.imported === false ? noEarlierData(ov.data?.historyFrom) : null;
  const rows: Array<{ label: string; now: string; before: string; delta: number | null }> = [
    ...(total !== null ? [{ label: "Total sales", now: money(total), before: p?.totalSales !== undefined ? money(p.totalSales) : "—", delta: s.deltas.totalSales ?? null }] : []),
    { label: "Net sales", now: money(c.netSales), before: p ? money(p.netSales) : "—", delta: s.deltas.netSales },
    ...(c.grossSales !== undefined ? [{ label: "Gross sales", now: money(c.grossSales), before: p?.grossSales !== undefined ? money(p.grossSales) : "—", delta: s.deltas.grossSales ?? null }] : []),
    { label: "Orders", now: fmtNum(c.orders), before: p ? fmtNum(p.orders) : "—", delta: s.deltas.orders },
    { label: "Items sold", now: fmtNum(c.units), before: p ? fmtNum(p.units) : "—", delta: s.deltas.units },
    { label: "Average order", now: money(c.averageOrderValue ?? 0), before: p && p.averageOrderValue !== null ? money(p.averageOrderValue) : "—", delta: s.deltas.averageOrderValue },
  ];
  // The store's own calculation (Custom sales), when it shows it on the dashboard: beside Shopify's figures, named.
  const custom = appliedCustom(s);

  const daily = ov.hasData && s.series.length > 1;
  const monthly = !!s.year && s.year.orders > 0;
  // What the fold says is inside: only the panels this store has, in the order they are drawn.
  const holds = [
    ...(salesLinesOf(c) ? ["Total sales line by line"] : []),
    ...(ov.modules.shopify_check ? ["the check against Shopify"] : []),
    ...(ov.modules.profit ? ["gross profit"] : []),
    "these dates against the ones before",
    ...(r ? ["returns"] : []),
    ...(daily ? ["sales day by day"] : []),
    ...(monthly ? ["sales month by month"] : []),
  ];

  return (
    <MoreDetail id="sales" holds={holds} heading={<h2 className="pt-2 text-xl leading-7 font-semibold tracking-[-0.01em]">More detail</h2>}>
      {/* Net sales to total sales, line by line, and the store's own calculation from those lines. */}
      {salesLinesOf(c) && <TotalSalesBreakdown ov={ov} currency={currency} />}

      {ov.modules.shopify_check && <ShopifyCheckCard m={ov.modules.shopify_check} currency={currency} />}
      {ov.modules.profit && <ProfitCard m={ov.modules.profit} currency={currency} versus={versus} f={profitCardFigures(ov, currency, { offered: offers("ads"), shown: adsOn }, seesModule(access, "profit"))} />}

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

      {daily && <DailySalesCard series={s.series} range={ov.range} today={ov.today} historyFrom={ov.data?.historyFrom ?? null} currency={currency} custom={custom} />}
      {monthly && s.year && <MonthlySalesCard year={s.year} historyFrom={ov.data?.historyFrom ?? null} currency={currency} custom={custom} />}
    </MoreDetail>
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

/** The topics that share the Overview tab: their own name over their panels, and the way back. */
const SECTION: Partial<Record<Topic, string>> = { overview: "Business overview", channels: "Sales channels", discounts: "Discount codes", timing: "Busiest times" };

/** Everything on a topic's page: its own figures, then what to do about them and what they mean. */
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
  const section = SECTION[topic];
  // A topic whose module isn't there (scopes changed, another store) shows nothing rather than crash.
  const body: ReactNode =
    topic === "overview" ? <OverviewDetail ov={ov} currency={currency} onOpen={onOpen} />
    : topic === "sales" && m.sales_overview ? (
      <>
        <SalesOverviewTab ov={ov} currency={currency} onOpen={onOpen} />
        <SalesMore ov={ov} currency={currency} />
      </>
    )
    : topic === "products" && (m.top_products || m.catalog) ? <ProductsTab ov={ov} currency={currency} />
    : topic === "timing" && m.order_timing ? <TimingDetail ov={ov} />
    : topic === "channels" && m.channels ? <ChannelsDetail ov={ov} currency={currency} />
    : (topic === "orders" || topic === "shipping") && (m.recent_orders || m.fulfillment || m.order_outcomes) ? (
      <>
        <OrdersTab ov={ov} currency={currency} />
        {m.fulfillment && <FulfillmentCard m={m.fulfillment} />}
      </>
    )
    : topic === "stock" && m.inventory ? <StockDetail ov={ov} currency={currency} />
    : topic === "discounts" && m.discount_codes ? <DiscountsDetail ov={ov} currency={currency} />
    : topic === "customers" && (m.customers || contactsOn) ? <CustomersTab ov={ov} currency={currency} contactsOn={contactsOn} />
    : <p className="home-card p-5 text-sm text-muted">There&apos;s nothing to show here for this store yet.</p>;
  return (
    <>
      {section && <SectionName title={section} onBack={m.sales_overview ? () => openView("sales") : undefined} />}
      {body}
      {topic !== "overview" && topic !== "stock" && <ComparedFoot ov={ov} />}
      {/* Then, under every topic: what to do about it, and what each number means. Ads and AdSense have their own pages (/advertising). */}
      <Explained topic={topic} ov={ov} currency={currency} />
    </>
  );
}
