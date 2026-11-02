"use client";
import Link from "next/link";
import { useState, type ReactNode } from "react";
import { ArrowRight, ChevronRight, CircleCheck, CircleX, ClipboardCheck, Clock, Info, Lightbulb, Megaphone, OctagonAlert, Package, PackageCheck, Plus, ReceiptText, Rocket, ShoppingCart, Split, TriangleAlert, Wallet, type LucideIcon } from "lucide-react";
import type { Health } from "@app/shared/health";
import type { AdSpendProvider } from "@app/shared/ads";
import type { AdConnectionState } from "@app/shared/adsFromShopify";
import { PROFIT_GAP_WORDS } from "@app/shared/expenses";
import type { OrderOutcomes } from "@app/shared/orders";
import { adSourcesOf, SourceBadge, type BadgeSource } from "@/components/advertising/sources";
import { GoogleAdsIcon, MetaIcon } from "@/components/BrandIcons";
import { StoreMetaDiscovery } from "@/components/integrations/MetaDiscovery";
import { ShopifyIcon } from "@/components/ShopifyIcon";
import { fmtMoney, fmtNum, fmtPct } from "@/lib/api";
import { shownFigures, upToWords } from "./adFigures";
import { Donut, type DonutSlice } from "./Charts";
import { fmtDateTime, fmtDay, fmtMoneyCompact, fmtTimes, humanize, plural } from "./format";
import { ChangeText } from "./HomeCards";
import { LineChart } from "./LineChart";
import { OrderName, TrafficSplitBar, TrafficSplitNote } from "./Modules";
import { businessHealth } from "./Overview";
import { adsLeftOut, comparableAds, costsOf, leftOutWords, marginKnown, profitOf, type CostState, type ProductCostState } from "./profitFigures";
import type { Topic } from "./topics";
import type { Overview, RecentOrder } from "./types";

// ---------------------------------------------------------------------------
// The dashboard under its four headline numbers, in the owner's design (2026-10-24): sales against
// ad spend and what is left after the costs we know, then sales, advertising and best sellers,
// then costs, recent orders and key insights, and the integrations strip at the foot. Every figure
// is one the overview already carries. Fees, postage, apps and staff come only from the costs the
// owner enters (Settings → Costs); shoppers' names never. What isn't known isn't drawn, and the
// panels say so rather than guess.
// ---------------------------------------------------------------------------

/** One colour per thing, the same in every panel (the reference palette's first three slots, validated together). */
const SALES = "var(--viz-cat-3)";
const PRODUCT_COSTS = "var(--viz-cat-1)";
const AD_SPEND = "var(--viz-cat-2)";
/** The owner's own costs (Settings → Costs). */
const YOUR_COSTS = "var(--viz-running)";

const PROVIDER: Record<AdSpendProvider, { name: string; Icon: (p: { size?: number }) => ReactNode }> = {
  google: { name: "Google Ads", Icon: GoogleAdsIcon },
  meta: { name: "Meta Ads", Icon: MetaIcon },
};

/** An icon on a solid disc, as each panel's header has one. */
function Disc({ icon: IconCmp, className }: { icon: LucideIcon; className: string }) {
  return (
    <span aria-hidden className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-full ${className}`}>
      <IconCmp className="h-5 w-5" strokeWidth={2} />
    </span>
  );
}

/** "View details →" at a panel's top right: opens the area's details, or its own page. */
function DetailsLink({ onClick, href, children = "View details" }: { onClick?: () => void; href?: string; children?: ReactNode }) {
  const cls = "inline-flex items-center gap-1 whitespace-nowrap rounded-md text-xs font-semibold text-accent hover:underline";
  const inner = (
    <>
      {children}
      <ArrowRight aria-hidden className="h-3.5 w-3.5" />
    </>
  );
  return href ? (
    <Link href={href} className={cls}>{inner}</Link>
  ) : (
    <button type="button" onClick={onClick} className={cls}>{inner}</button>
  );
}

/** A panel of the home page: a heading with its one line, a way into the details, and its body. */
function HomeCard({ id, title, sub, icon, action, className = "", children }: { id: string; title: string; sub?: ReactNode; icon?: ReactNode; action?: ReactNode; className?: string; children: ReactNode }) {
  return (
    <section id={id} aria-labelledby={`${id}-h`} data-testid={`home-${id}`} className={`card animate-rise flex min-w-0 flex-col rounded-2xl ${className}`}>
      <div className="flex items-start gap-3">
        {icon}
        <div className="min-w-0 flex-1">
          <h2 id={`${id}-h`} className="font-semibold leading-tight">{title}</h2>
          {sub && <p className="mt-1 text-xs text-muted">{sub}</p>}
        </div>
        {action && <div className="shrink-0 pt-0.5">{action}</div>}
      </div>
      <div className="mt-4 flex min-w-0 flex-1 flex-col">{children}</div>
    </section>
  );
}

/** A figure in a panel's row of three: label under the number, the change under that. */
function Figure({ label, value, change }: { label: string; value: ReactNode; change?: ReactNode }) {
  return (
    <div className="min-w-0">
      <p className="truncate text-lg font-bold tabular-nums tracking-tight sm:text-xl">{value}</p>
      <p className="truncate text-xs text-muted">{label}</p>
      {change && <div className="mt-1.5">{change}</div>}
    </div>
  );
}

/** A legend row: swatch (or none, for a line that only adds up the others), name, figure and its share. */
function LegendRow({ color, label, value, share, sub = false }: { color?: string; label: ReactNode; value: ReactNode; share?: string | null; sub?: boolean }) {
  return (
    <li className={`flex min-w-0 items-center gap-2 ${sub ? "pl-4 text-xs text-muted" : "text-sm"}`}>
      {!sub && <span aria-hidden className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: color ?? "transparent", boxShadow: color ? undefined : "inset 0 0 0 1.5px var(--muted)" }} />}
      <span className="min-w-0 flex-1 truncate">{label}</span>
      <span className="font-medium tabular-nums">{value}</span>
      {share !== undefined && <span className="w-12 text-right text-xs tabular-nums text-muted">{share ?? ""}</span>}
    </li>
  );
}

// ---- What the costs are (./profitFigures.ts) ----------------------------------------------------

/** "product costs, ads and your costs". */
const listOf = (items: string[]) => new Intl.ListFormat("en", { style: "long", type: "conjunction" }).format(items);

/**
 * A cost with no figure, in words: product costs need Shopify's reports and a cost per item on the
 * products sold, ad spend an ad account.
 */
const PRODUCT_WORDS: Record<Exclude<ProductCostState, "known">, string> = { loading: "Loading…", missing: "Not available", unavailable: "Not available", not_recorded: "Not recorded in Shopify" };
const AD_WORDS: Record<Exclude<CostState, "known">, string> = { loading: "Loading…", missing: "Not connected", unavailable: "Unavailable" };
/** Where product costs come from when it isn't Shopify's profit report (`productSource`). */
const PER_ITEM_WORDS = "Product costs are the items sold at their cost per item in Shopify.";

/** Under an ad spend: the accounts not in it, as they report in another currency (`leftOutWords`). */
function LeftOutRow({ words }: { words: string | null }) {
  return words ? <li className="pl-4 text-xs text-muted" data-testid="ads-left-out">{words}</li> : null;
}

// ---- Orders at a glance -------------------------------------------------------------------------

/** Each outcome's colour, as the order status pills have them; checkouts and shipping their own. */
const GLANCE_TONE = {
  completed: { tile: "border-emerald-200/80 bg-emerald-50/70 dark:border-emerald-400/20 dark:bg-emerald-400/[0.08]", ink: "text-emerald-700 dark:text-emerald-300", bar: "bg-emerald-500 dark:bg-emerald-400" },
  waiting: { tile: "border-amber-200/80 bg-amber-50/70 dark:border-amber-400/20 dark:bg-amber-400/[0.08]", ink: "text-amber-700 dark:text-amber-300", bar: "bg-amber-400 dark:bg-amber-300" },
  failed: { tile: "border-red-200/80 bg-red-50/70 dark:border-red-400/20 dark:bg-red-400/[0.08]", ink: "text-red-700 dark:text-red-300", bar: "bg-red-500 dark:bg-red-400" },
  checkout: { tile: "border-violet-200/80 bg-violet-50/70 dark:border-violet-400/20 dark:bg-violet-400/[0.08]", ink: "text-violet-700 dark:text-violet-300", bar: "" },
  sent: { tile: "border-sky-200/80 bg-sky-50/70 dark:border-sky-400/20 dark:bg-sky-400/[0.08]", ink: "text-sky-700 dark:text-sky-300", bar: "" },
} as const;

/** One figure of the panel: what it is, the number, and a line saying what's in it. Opens its details when there are some. */
function GlanceTile({ id, tone, icon: IconCmp, label, value, sub, onClick, className = "" }: { id: string; tone: keyof typeof GLANCE_TONE; icon: LucideIcon; label: string; value: ReactNode; sub: ReactNode; onClick?: () => void; className?: string }) {
  const t = GLANCE_TONE[tone];
  const body = (
    <>
      <span className="flex min-w-0 items-start gap-2 text-sm font-medium leading-tight text-text/80">
        <IconCmp aria-hidden className={`h-4 w-4 shrink-0 ${t.ink}`} strokeWidth={2.25} />
        <span className="min-w-0">{label}</span>
      </span>
      <span className="mt-1 block truncate text-2xl font-bold tabular-nums tracking-tight sm:text-[1.75rem] sm:leading-9">{value}</span>
      <span className="mt-1 block text-xs text-muted">{sub}</span>
    </>
  );
  const cls = `flex min-w-0 flex-col rounded-xl border p-3.5 text-left sm:p-4 ${t.tile} ${className}`;
  return onClick ? (
    <button type="button" onClick={onClick} className={`lift ${cls}`} data-testid={`glance-${id}`}>{body}</button>
  ) : (
    <div className={cls} data-testid={`glance-${id}`}>{body}</div>
  );
}

/** "2 cancelled · 1 payment failed": the reasons there are, or that there are none. */
function unsuccessfulWords(o: NonNullable<OrderOutcomes["outcome"]>): string {
  const parts = [
    o.cancelled ? `${fmtNum(o.cancelled)} cancelled` : null,
    o.paymentFailed ? `${fmtNum(o.paymentFailed)} payment failed` : null,
    o.refunded ? `${fmtNum(o.refunded)} refunded in full` : null,
  ].filter(Boolean);
  return parts.length ? parts.join(" · ") : "None cancelled, failed or refunded";
}

/**
 * How the orders placed in the dates went, in plain numbers (the owner, 2026-10-30: how many orders
 * went through and how many didn't, how many people left at checkout, how much was sent). Completed,
 * awaiting payment and unsuccessful add up to the Orders tile (`orderOutcome` in @app/shared/orders);
 * checkouts left come from the storefront pixel; products sent are of the orders still on. A part this
 * member may not see (Team & Access) isn't in the answer and isn't drawn.
 */
export function OrdersAtAGlance({ ov, period, onOpen }: { ov: Overview; period: string; onOpen: (t: Topic) => void }) {
  const { orders, outcome, shipping, checkouts } = ov.modules.order_outcomes!;
  // Each figure opens the details behind it, where this member has them.
  const openOrders = ov.modules.recent_orders ? () => onOpen("orders") : undefined;
  const openShipping = ov.modules.fulfillment ? () => onOpen("shipping") : undefined;
  const openFunnel = ov.modules.funnel ? () => onOpen("shoppers") : undefined;
  const share = (n: number) => (orders ? `${fmtPct(n / orders)} of orders` : "No orders yet");
  const bar = outcome && orders
    ? [
        { key: "completed", n: outcome.completed, cls: GLANCE_TONE.completed.bar },
        { key: "waiting", n: outcome.awaitingPayment, cls: GLANCE_TONE.waiting.bar },
        { key: "failed", n: outcome.unsuccessful, cls: GLANCE_TONE.failed.bar },
      ].filter((s) => s.n > 0)
    : [];
  // Two to a row on a phone: a last tile on its own takes the whole row.
  const odd = ((outcome ? 3 : 0) + (checkouts !== undefined ? 1 : 0) + (shipping ? 1 : 0)) % 2 === 1;
  return (
    <HomeCard
      id="orders-glance"
      title="Orders at a glance"
      sub={orders === undefined ? `How the orders placed ${period} went.` : orders === 0 ? `No orders placed ${period}.` : `How the ${plural(orders, "order")} placed ${period} went.`}
      icon={<Disc icon={ClipboardCheck} className="bg-sky-600 text-white dark:bg-sky-500" />}
      action={openOrders && <DetailsLink onClick={openOrders}>View orders</DetailsLink>}
    >
      {bar.length > 0 && (
        <div
          role="img"
          aria-label={`${plural(outcome!.completed, "order")} completed, ${fmtNum(outcome!.awaitingPayment)} awaiting payment, ${fmtNum(outcome!.unsuccessful)} unsuccessful`}
          className="mb-4 flex h-2.5 w-full gap-0.5 overflow-hidden rounded-full bg-text/[0.06]"
          data-testid="glance-bar"
        >
          {bar.map((s) => <span key={s.key} className={s.cls} style={{ flex: `${s.n} 1 0%` }} />)}
        </div>
      )}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-3 xl:grid-cols-5">
        {outcome && (
          <>
            <GlanceTile id="completed" tone="completed" icon={CircleCheck} label="Completed" value={fmtNum(outcome.completed)} sub={`Paid · ${share(outcome.completed)}`} onClick={openOrders} />
            <GlanceTile id="awaiting" tone="waiting" icon={Clock} label="Awaiting payment" value={fmtNum(outcome.awaitingPayment)} sub="Not paid in full yet, such as cash on delivery" onClick={openOrders} />
            <GlanceTile id="unsuccessful" tone="failed" icon={CircleX} label="Unsuccessful" value={fmtNum(outcome.unsuccessful)} sub={unsuccessfulWords(outcome)} onClick={openOrders} />
          </>
        )}
        {checkouts !== undefined && (
          <GlanceTile
            id="checkouts"
            tone="checkout"
            icon={ShoppingCart}
            label="Left at checkout"
            value={checkouts ? fmtNum(checkouts.left) : <span className="text-base font-semibold text-muted sm:text-lg">Not tracked</span>}
            sub={
              checkouts
                ? `Of ${plural(checkouts.started, "shopper")} who started checkout, ${fmtNum(checkouts.completed)} bought${checkouts.from ? ` · counted from ${fmtDay(checkouts.from)}` : ""}`
                : "Counted once storefront tracking is on for these dates"
            }
            onClick={openFunnel}
          />
        )}
        {shipping && (
          <GlanceTile
            id="sent"
            tone="sent"
            icon={PackageCheck}
            label="Products sent"
            className={odd ? "col-span-2 lg:col-span-1" : ""}
            value={
              <>
                {fmtNum(shipping.itemsSent)} <span className="text-sm font-medium text-muted">{shipping.itemsSent === 1 ? "item" : "items"}</span>
              </>
            }
            sub={
              shipping.orders === 0
                ? "Nothing to send yet"
                : [
                    `${fmtNum(shipping.sent)} of ${plural(shipping.orders, "order")} sent in full`,
                    shipping.partlySent ? `${fmtNum(shipping.partlySent)} partly sent` : null,
                    shipping.notSent ? `${fmtNum(shipping.notSent)} still to send` : null,
                  ]
                    .filter(Boolean)
                    .join(" · ")
            }
            onClick={openShipping}
          />
        )}
      </div>
    </HomeCard>
  );
}

// ---- Sales vs ad spend --------------------------------------------------------------------------

/**
 * Net sales day by day beside what the ads cost that day: the mock's "Revenue vs Expenses", with
 * the one cost that is known day by day. Product costs come from Shopify's profit report, for the
 * dates as a whole, so they are in the profit panel beside this one.
 */
export function SalesVsAdSpend({ ov, currency, adsOn, manage }: { ov: Overview; currency: string; adsOn: boolean; manage: boolean }) {
  const s = ov.modules.sales_overview!;
  const ads = adsOn ? comparableAds(ov, currency) : null;
  const days = s.series.map((d) => d.day);
  const spend = new Map(ads?.series.map((d) => [d.day, d.spend]) ?? []);
  const series = [
    { key: "sales", label: "Net sales", color: SALES, values: s.series.map((d) => d.netSales) },
    ...(ads ? [{ key: "ads", label: "Ad spend", color: AD_SPEND, values: days.map((d) => spend.get(d) ?? null) }] : []),
  ];
  const money = (n: number) => fmtMoney(n, currency);
  const other = adsOn ? ov.modules.ads : undefined;
  const leftOut = ads ? leftOutWords(adsLeftOut(ov, currency)) : null;
  return (
    <HomeCard
      id="sales-vs-ads"
      title="Sales vs ad spend"
      sub={ads ? "Net sales each day, beside what your ads cost that day." : "Net sales each day."}
      className="xl:col-span-2"
    >
      <div className="mb-3 flex flex-wrap gap-x-8 gap-y-2">
        <Figure label="Net sales" value={money(s.current.netSales)} />
        {ads && <Figure label="Ad spend" value={ads.current ? money(ads.current.spend) : "—"} />}
        {ads?.shareOfSales !== null && ads?.shareOfSales !== undefined && <Figure label="Ads cost, of net sales" value={fmtPct(ads.shareOfSales)} />}
      </div>
      <LineChart
        days={days}
        series={series}
        bars
        today={ov.today}
        height={240}
        label={ads ? "Net sales and ad spend by day" : "Net sales by day"}
        format={money}
        fmtAxis={(v) => fmtMoneyCompact(v, currency)}
      />
      {leftOut && (
        <p className="mt-3 text-xs text-muted" data-testid="ads-left-out">
          {leftOut}
        </p>
      )}
      {!ads && adsOn && (
        <p className="mt-3 text-xs text-muted">
          {other?.demo
            ? "The Google Ads demo's spend is simulated, so it isn't set against your sales."
            : other && other.accounts.length > 0 && other.currency !== currency
              ? `Your ad accounts report in ${other.currency}, so their spend isn't set against your ${currency} sales.`
              : <>Connect Meta or Google Ads to see your ad spend beside your sales.{manage && <> <Link href="/settings/integrations" className="font-medium text-accent hover:underline">Connect ad accounts</Link></>}</>}
        </p>
      )}
    </HomeCard>
  );
}

// ---- Profit overview ----------------------------------------------------------------------------

/**
 * What is left of net sales after the costs bizinsights can see: Shopify's cost of goods sold (once
 * it recorded a cost for some of the sales: its 0 for a store that keeps none is "Not recorded in
 * Shopify"), the ad spend and the owner's own costs (Settings → Costs). It is called net profit only
 * when every one is known and the owner has said the costs list is complete for the dates
 * (`profitOf`); then it is worked out from revenue (net sales, shipping and fees). Otherwise it says
 * what is missing.
 */
export function ProfitOverview({ ov, currency, adsOn, adsOffered, costsOn, manageCosts }: { ov: Overview; currency: string; adsOn: boolean; adsOffered: boolean; costsOn: boolean; manageCosts: boolean }) {
  const net = ov.modules.sales_overview!.current.netSales;
  const k = costsOf(ov, currency, adsOn);
  const profit = profitOf(ov, k, { offered: adsOffered, shown: adsOn }, costsOn);
  const isNet = profit?.value !== null && profit?.value !== undefined;
  const money = (n: number) => fmtMoney(n, currency);
  // Net profit is out of revenue; what is left without it, out of net sales.
  const base = isNet ? profit!.revenue : net;
  const share = (n: number) => (base > 0 ? fmtPct(n / base) : null);
  const taken = (k.productCosts ?? 0) + (k.adSpend ?? 0) + (k.yourCosts ?? 0);
  const left = isNet ? profit!.value! : net - taken;
  // With an account left out (another currency), only the ads in the store's currency were taken off.
  const after = [k.productCosts !== null ? "product costs" : null, k.adSpend !== null ? (k.adState === "partial" ? `ads in ${currency}` : "ads") : null, k.yourCosts ? "your costs" : null].filter((x): x is string => x !== null);
  const what = isNet ? "Net profit" : after.length ? `After ${listOf(after)}` : "Net sales";
  const slices: DonutSlice[] = [
    { key: "left", label: isNet ? "Net profit" : "Left after these costs", value: left, color: SALES },
    { key: "products", label: "Product costs", value: k.productCosts ?? 0, color: PRODUCT_COSTS },
    { key: "ads", label: "Ad spend", value: k.adSpend ?? 0, color: AD_SPEND },
    { key: "yours", label: "Your costs", value: k.yourCosts ?? 0, color: YOUR_COSTS },
  ];
  const gaps = profit?.gaps ?? [];
  return (
    <HomeCard id="profit" title="Business profit overview" sub={isNet ? "Your net profit for these dates, from every cost you've told bizinsights about." : "What's left of your net sales after the costs bizinsights can see."}>
      {/* Ring and legend side by side when the panel is wide enough, else one above the other. */}
      <div className="@container">
        <div className="flex flex-col items-center gap-5 @[25rem]:flex-row">
          <Donut slices={slices} label={`${what}: ${money(left)}${base > 0 ? `, ${fmtPct(left / base)} of ${isNet ? "revenue" : "net sales"}` : ""}`}>
            <span className={`text-lg font-bold tabular-nums tracking-tight ${left < 0 ? "text-danger" : ""}`} data-testid="profit-left">{money(left)}</span>
            <span className="text-[11px] leading-tight text-muted" data-testid="profit-what">{what}</span>
            {/* A margin needs the cost of what was sold (`marginKnown`): ad spend alone taken off sales isn't one. */}
            {base > 0 && taken > 0 && (marginKnown(k) ? (
              <span className="mt-0.5 text-[11px] font-semibold text-good">{fmtPct(left / base)} {isNet ? "net " : ""}margin</span>
            ) : (
              <span className="mt-0.5 text-[11px] text-muted">{fmtPct(left / base)} of net sales</span>
            ))}
          </Donut>
          <ul className="w-full min-w-0 flex-1 space-y-2.5">
            {isNet ? (
              <>
                <LegendRow label="Revenue" value={money(profit!.revenue)} share={fmtPct(1)} />
                <LegendRow sub label="Net sales, shipping and fees, without tax" value={money(net)} />
              </>
            ) : (
              <LegendRow label="Net sales" value={money(net)} share={net > 0 ? fmtPct(1) : null} />
            )}
            {costsOn && <LegendRow color={PRODUCT_COSTS} label="Product costs" value={k.productCosts !== null ? money(k.productCosts) : PRODUCT_WORDS[k.productState as Exclude<ProductCostState, "known">]} share={k.productCosts !== null ? share(k.productCosts) : null} />}
            {adsOn && (
              <>
                <LegendRow color={AD_SPEND} label="Ad spend" value={k.adSpend !== null ? money(k.adSpend) : AD_WORDS[k.adState as Exclude<CostState, "known">]} share={k.adSpend !== null ? share(k.adSpend) : null} />
                <LeftOutRow words={leftOutWords(k.adLeftOut)} />
              </>
            )}
            {k.yourCosts !== null && <LegendRow color={YOUR_COSTS} label="Your costs" value={money(k.yourCosts)} share={share(k.yourCosts)} />}
            <LegendRow color={SALES} label={isNet ? "Net profit" : "Left after these costs"} value={money(left)} share={share(left)} />
          </ul>
        </div>
      </div>
      <p className="mt-4 text-xs text-muted" data-testid="profit-note">
        {isNet ? (
          <>Revenue less {k.productSource === "cost_per_item" ? "product costs" : "Shopify's product costs"}, your ad spend and your costs (Settings → Costs), which you&apos;ve marked complete for these dates.</>
        ) : (
          <>
            Not net profit
            {profit ? `: ${gaps.map((g) => PROFIT_GAP_WORDS[g].replace(/\.$/, "")).join("; ")}.` : ": fees, shipping costs, apps and staff aren't taken off."}
            {k.productState === "known" && k.uncosted !== null && k.uncosted > 0 && <> {money(k.uncosted)} of sales had no cost recorded in Shopify, so their cost isn&apos;t included.</>}
          </>
        )}
        {costsOn && k.productState === "known" && k.productSource === "cost_per_item" && <> {PER_ITEM_WORDS}</>}
        {profit && manageCosts && (ov.modules.expenses!.count === 0 || gaps.includes("costs_not_complete")) && (
          <>
            {" "}
            <Link href="/settings/costs" className="font-medium text-accent hover:underline">{ov.modules.expenses!.count === 0 ? "Add your costs" : "Review your costs"}</Link>
          </>
        )}
      </p>
    </HomeCard>
  );
}

// ---- Sales performance --------------------------------------------------------------------------

export function SalesPerformance({ ov, currency, onOpen }: { ov: Overview; currency: string; onOpen: (t: Topic) => void }) {
  const s = ov.modules.sales_overview!;
  const total = s.current.totalSales !== undefined;
  const money = (n: number) => fmtMoney(n, currency);
  return (
    <HomeCard
      id="sales-performance"
      title="Sales performance"
      sub="Total sales and orders from your Shopify store."
      icon={
        <span aria-hidden className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-border bg-white">
          <ShopifyIcon size={20} />
        </span>
      }
      action={<DetailsLink onClick={() => onOpen("sales")} />}
    >
      <div className="grid grid-cols-3 gap-3 divide-x divide-border">
        <Figure label={total ? "Total sales" : "Net sales"} value={money(total ? s.current.totalSales! : s.current.netSales)} change={<ChangeText value={total ? s.deltas.totalSales : s.deltas.netSales} />} />
        <div className="pl-3">
          <Figure label="Orders" value={fmtNum(s.current.orders)} change={<ChangeText value={s.deltas.orders} />} />
        </div>
        <div className="pl-3">
          <Figure label="Average order" value={s.current.averageOrderValue !== null ? money(s.current.averageOrderValue) : "—"} change={<ChangeText value={s.deltas.averageOrderValue} />} />
        </div>
      </div>
      <div className="mt-4 flex-1">
        <LineChart
          days={s.series.map((d) => d.day)}
          series={[{ key: "sales", label: total ? "Total sales" : "Net sales", color: SALES, values: s.series.map((d) => (total ? (d.totalSales ?? d.netSales) : d.netSales)) }]}
          area
          today={ov.today}
          height={190}
          label={total ? "Total sales by day" : "Net sales by day"}
          format={money}
          fmtAxis={(v) => fmtMoneyCompact(v, currency)}
        />
      </div>
    </HomeCard>
  );
}

// ---- Advertising performance --------------------------------------------------------------------

/** The sites each spend platform's visits come from, in words. */
const SITES: Record<AdSpendProvider, string> = { meta: "Facebook and Instagram", google: "Google and YouTube" };

/** Where to connect an ad platform, or the line for a member who can't. */
function ConnectAds({ manage, label }: { manage: boolean; label: string }) {
  return manage ? (
    <Link href="/settings/integrations" className="btn-primary text-xs">
      {label}
    </Link>
  ) : (
    <p className="text-xs text-muted">A workspace admin can connect it.</p>
  );
}

/** "Source:" and the badge naming where a tab's figures come from. */
function SourceLine({ provider, source }: { provider: AdSpendProvider; source: BadgeSource }) {
  return (
    <p className="mb-3 flex items-center gap-1.5 text-xs text-muted">
      Source <SourceBadge provider={provider} source={source} />
    </p>
  );
}

/**
 * A platform's own figures (its API, through the connected ad accounts): spend, clicks and return on ad
 * spend, the rest of what it reports beneath, and the orders Shopify itself credits to its ads beside
 * them, each labelled with where it comes from.
 */
function PlatformAds({ ov, provider, state, manage }: { ov: Overview; provider: AdSpendProvider; state: AdConnectionState; manage: boolean }) {
  const ads = ov.modules.ads;
  const p = ads?.byProvider.find((x) => x.provider === provider);
  const { name } = PROVIDER[provider];
  const lost = state === "access_lost" && (
    <p className="mt-2 text-xs text-warn" data-testid="home-ads-access-lost">
      bizinsights&apos; access to {name} has ended: these are the days it reported before.{" "}
      {manage ? (
        <Link href="/settings/integrations" className="font-medium underline">
          Reconnect {name}
        </Link>
      ) : (
        "A workspace admin can reconnect it."
      )}
    </p>
  );
  if (!ads || !p) {
    // Its accounts report in another currency than the platform added up here: its own page shows them.
    return (
      <>
        <SourceLine provider={provider} source="platform" />
        <p className="text-sm text-muted">
          Your {name} accounts report in another currency than your other ad accounts, so they aren&apos;t added up here.{" "}
          <Link href={`/advertising/${provider}`} className="font-medium text-accent hover:underline">
            See {name}
          </Link>
        </p>
        {lost}
      </>
    );
  }
  const { totals, through } = shownFigures(p);
  const money = (n: number) => fmtMoney(n, ads.currency);
  const series = ads.seriesByProvider.find((x) => x.provider === provider)?.series ?? [];
  const clicks = totals ? (totals.linkClicks ?? totals.clicks) : null;
  const sourced = p.demo ? undefined : ads.sourced?.find((x) => x.provider === provider);
  const more: Array<[string, string]> = totals
    ? [
        ["Impressions", fmtNum(totals.impressions)],
        ["CTR", fmtPct(totals.ctr)],
        ["CPC", totals.cpc === null ? "—" : money(totals.cpc)],
        ["CPM", totals.cpm === null ? "—" : money(totals.cpm)],
        ["Conversions", fmtNum(totals.conversions)],
        ["Conversion value", totals.conversionValue === null ? "—" : money(totals.conversionValue)],
      ]
    : [];
  return (
    <>
      <SourceLine provider={provider} source="platform" />
      <div className="grid grid-cols-3 gap-3 divide-x divide-border">
        <Figure label="Ad spend" value={totals ? money(totals.spend) : "—"} change={<ChangeText value={p.deltas.spend} neutral />} />
        <div className="pl-3">
          <Figure label={totals?.linkClicks !== null ? "Link clicks" : "Clicks"} value={clicks !== null ? fmtNum(clicks) : "—"} change={<ChangeText value={p.deltas.linkClicks} />} />
        </div>
        <div className="pl-3">
          <Figure label="ROAS" value={fmtTimes(totals?.roas ?? null)} change={<ChangeText value={p.deltas.roas} />} />
        </div>
      </div>
      {more.length > 0 && (
        <dl className="mt-3 grid grid-cols-3 gap-x-3 gap-y-1.5 text-xs" data-testid="home-ads-more">
          {more.map(([label, value]) => (
            <div key={label} className="min-w-0">
              <dt className="truncate text-muted">{label}</dt>
              <dd className="truncate font-semibold tabular-nums">{value}</dd>
            </div>
          ))}
        </dl>
      )}
      {!totals && !lost && <p className="mt-2 text-xs text-muted">Some days of these dates haven&apos;t been read from {name} yet.</p>}
      {totals && through && <p className="mt-2 text-xs text-muted">Figures {upToWords(through)}.</p>}
      {lost}
      {sourced && (
        <p className="mt-2 flex flex-wrap items-center gap-1.5 text-xs text-muted" data-testid="home-ads-sourced">
          <SourceBadge provider={provider} source="shopify" />
          {plural(sourced.orders, "order")} · {fmtMoney(sourced.sales, ov.store.currency)} from {SITES[provider]}&apos;s tagged ads
          {sourced.salesPerSpend !== null && <> · {fmtTimes(sourced.salesPerSpend)} the spend in sales</>}
        </p>
      )}
      <div className="mt-4 flex-1">
        <LineChart
          days={series.map((d) => d.day)}
          series={[{ key: "spend", label: "Ad spend", color: AD_SPEND, values: series.map((d) => d.spend) }]}
          bars
          today={ov.today}
          height={150}
          label={`${name} spend by day`}
          format={money}
          fmtAxis={(v) => fmtMoneyCompact(v, ads.currency)}
        />
      </div>
    </>
  );
}

/**
 * A platform's sales as the store's Shopify orders record them (the last visit before each order came
 * from its sites): sales, orders and the tagged-ad part or the share of sales, the storefront's visits
 * from it while the pixel records them, the campaign that sold most. Nothing of what was spent, shown
 * or clicked, which only the platform knows: no spend, no ROAS, never a 0 standing in for them.
 */
function ShopifyAds({ ov, provider, state, manage }: { ov: Overview; provider: AdSpendProvider; state: AdConnectionState; manage: boolean }) {
  const m = ov.modules.ads_from_shopify;
  const p = m?.platforms.find((x) => x.provider === provider);
  const { name } = PROVIDER[provider];
  const lost = state === "access_lost";
  if (!m || !p) return <NoAdSource provider={provider} state={state} manage={manage} />;
  const money = (n: number) => fmtMoney(n, m.currency);
  const none = p.orders === 0 && p.sales === 0;
  const tagged = p.paidSales !== undefined;
  const top = p.campaigns?.[0];
  const visits = p.visits ?? null;
  return (
    <>
      <SourceLine provider={provider} source="shopify" />
      {none ? (
        <div className="flex flex-1 flex-col items-center justify-center rounded-xl border border-dashed border-border px-4 py-6 text-center" data-testid="home-ads-shopify-none">
          <p className="max-w-sm text-sm text-muted">
            No sales from {SITES[provider]} recorded in these dates: none of your Shopify orders came from a visit there.
          </p>
        </div>
      ) : (
        <>
          <div className="grid grid-cols-3 gap-3 divide-x divide-border">
            <Figure label={`Sales from ${SITES[provider]}`} value={money(p.sales)} change={<ChangeText value={p.deltas.sales} />} />
            <div className="pl-3">
              <Figure label="Orders" value={fmtNum(p.orders)} change={<ChangeText value={p.deltas.orders} />} />
            </div>
            <div className="pl-3">
              {tagged ? (
                <Figure label="From tagged ads" value={money(p.paidSales ?? 0)} change={<ChangeText value={p.deltas.paidSales ?? null} />} />
              ) : (
                <Figure label="Share of sales" value={fmtPct(p.share)} />
              )}
            </div>
          </div>
          <p className="mt-3 text-xs text-muted" data-testid="home-ads-shopify-more">
            {tagged && <>{fmtPct(p.share)} of your sales</>}
            {visits !== null && (
              <>
                {tagged ? " · " : ""}
                {plural(visits, "store visit")} from them{m.visitsFrom && m.visitsFrom > ov.range.from ? ` since ${fmtDay(m.visitsFrom)}` : ""}
              </>
            )}
            {top && (
              <>
                {tagged || visits !== null ? " · " : ""}
                Top campaign: <span className="font-medium text-text">{top.campaign}</span> ({money(top.sales)})
              </>
            )}
          </p>
          <div className="mt-4 flex-1">
            <LineChart
              days={p.daily.map((d) => d.day)}
              series={[{ key: "sales", label: `Sales from ${SITES[provider]}`, color: SALES, values: p.daily.map((d) => d.sales) }]}
              area
              today={ov.today}
              height={150}
              label={`Sales from ${SITES[provider]} by day, from your Shopify orders`}
              format={money}
              fmtAxis={(v) => fmtMoneyCompact(v, m.currency)}
            />
          </div>
        </>
      )}
      <p className="mt-3 text-xs text-muted">
        The visit Shopify recorded before each order (the last click). Ad spend, impressions, clicks and ROAS come only from {name} itself:{" "}
        {lost ? `its access has ended, so reconnect it to bring them back.` : `connect it to add them.`}
      </p>
      {/* Meta, found through the store's Shopify connection: seen in these orders, or a sign-in of theirs to use here. */}
      {provider === "meta" && !lost && (
        <div className="mt-3 border-t border-border pt-3 empty:hidden">
          <StoreMetaDiscovery compact />
        </div>
      )}
      <div className="mt-3">
        <ConnectAds manage={manage} label={`${lost ? "Reconnect" : "Connect"} ${name}`} />
      </div>
    </>
  );
}

/**
 * A platform's spend, impressions and clicks as its app (Facebook & Instagram, Google & YouTube) reports
 * them to Shopify (`shopify_marketing`), while its own API isn't connected: the channel's own count, a
 * figure it didn't report "Data unavailable", and the store's orders from its sites beside it when read.
 */
function MarketingAds({ ov, provider, state, manage }: { ov: Overview; provider: AdSpendProvider; state: AdConnectionState; manage: boolean }) {
  const m = ov.modules.shopify_marketing;
  const g = m?.platforms.find((x) => x.platform === provider);
  const { name } = PROVIDER[provider];
  if (!m || !g?.totals) return <NoAdSource provider={provider} state={state} manage={manage} />;
  const t = g.totals;
  const money = (n: number) => fmtMoney(n, m.currency);
  const or = (v: number | null, show: (n: number) => string) => (v === null ? "Data unavailable" : show(v));
  const orders = ov.modules.ads_from_shopify?.platforms.find((x) => x.provider === provider);
  return (
    <>
      <SourceLine provider={provider} source="marketing" />
      <div className="grid grid-cols-3 gap-3 divide-x divide-border">
        <Figure label="Spend" value={or(t.spend, money)} change={g.previous ? <ChangeText value={g.deltas.spend} neutral /> : undefined} />
        <div className="pl-3">
          <Figure label="Clicks" value={or(t.clicks, fmtNum)} change={g.previous ? <ChangeText value={g.deltas.clicks} /> : undefined} />
        </div>
        <div className="pl-3">
          <Figure label="ROAS (its count)" value={or(t.roas, (n) => fmtTimes(n))} change={g.previous ? <ChangeText value={g.deltas.roas} /> : undefined} />
        </div>
      </div>
      <p className="mt-3 text-xs text-muted" data-testid="home-ads-marketing-more">
        {or(t.impressions, fmtNum)} impressions · CTR {or(t.ctr, fmtPct)} · CPC {or(t.cpc, money)}
        {orders && (orders.orders !== 0 || orders.sales !== 0) && <> · {money(orders.sales)} of your Shopify sales came from {SITES[provider]}</>}
      </p>
      {g.availability === "reported" && (
        <div className="mt-4 flex-1">
          <LineChart
            days={g.daily.map((d) => d.day)}
            series={[{ key: "spend", label: `${name} spend reported to Shopify`, color: AD_SPEND, values: g.daily.map((d) => d.spend) }]}
            area
            today={ov.today}
            height={150}
            label={`${name} spend by day, as its app reports it to Shopify`}
            format={money}
            fmtAxis={(v) => fmtMoneyCompact(v, m.currency)}
          />
        </div>
      )}
      <p className="mt-3 text-xs text-muted">
        What {g.apps.join(", ") || name} reports to Shopify, {m.sync.lastSyncedAt ? `read ${fmtDateTime(m.sync.lastSyncedAt, ov.store.timezone)}` : "not read yet"}. Connect {name} for its own report: it then replaces these, never adds to them.
      </p>
      <div className="mt-3">
        <ConnectAds manage={manage} label={`${state === "access_lost" ? "Reconnect" : "Connect"} ${name}`} />
      </div>
    </>
  );
}

/** Neither the platform nor the store's orders have anything to show: what that means, and the way to connect it. */
function NoAdSource({ provider, state, manage }: { provider: AdSpendProvider; state: AdConnectionState; manage: boolean }) {
  const { name, Icon } = PROVIDER[provider];
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-border px-4 py-8 text-center" data-testid="home-ads-no-source">
      <Icon size={22} />
      <p className="max-w-xs text-sm text-muted">
        {state === "access_lost" ? `bizinsights' access to ${name} has ended. Reconnect` : `${name} isn't connected. Connect`} it to see what your ads cost and what they bring back. Your Shopify
        orders&apos; visit sources aren&apos;t available here, so there&apos;s nothing from {SITES[provider]} to show meanwhile.
      </p>
      <ConnectAds manage={manage} label={`${state === "access_lost" ? "Reconnect" : "Connect"} ${name}`} />
    </div>
  );
}

/**
 * Meta Ads and Google Ads, a tab each, every one from its own source (adSourcesOf: the API's
 * `ad_sources`): the platform's API once its ad accounts are connected; before that or while its access
 * is lost, what its app reports to Shopify, or else the store's Shopify orders; said by a badge on each. Connecting, disconnecting or
 * reconnecting a platform switches its tab by itself on the next read. Nothing from either: the way
 * to connect them, never a $0.
 */
export function AdvertisingPerformance({ ov, manage }: { ov: Overview; manage: boolean }) {
  const sources = adSourcesOf(ov);
  const [picked, setPicked] = useState<AdSpendProvider | null>(null);
  const icon = <Disc icon={Megaphone} className="bg-sky-600 text-white dark:bg-sky-500" />;
  if (sources.every((s) => s.source === "none" && !s.marketing)) {
    return (
      <HomeCard id="advertising" title="Advertising performance" sub="Ad spend, clicks and return on ad spend across your ad platforms." icon={icon}>
        <div className="flex flex-1 flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-border px-4 py-8 text-center">
          <span aria-hidden className="flex items-center gap-2">
            <GoogleAdsIcon size={22} />
            <MetaIcon size={22} />
          </span>
          <p className="max-w-xs text-sm text-muted">Connect Google Ads or Meta Ads to see what your ads cost and what they bring back.</p>
          {manage ? (
            <Link href="/settings/integrations" className="btn-primary text-xs">Connect ad accounts</Link>
          ) : (
            <p className="text-xs text-muted">A workspace admin can connect them.</p>
          )}
        </div>
      </HomeCard>
    );
  }
  const sold = (p: AdSpendProvider) => ov.modules.ads_from_shopify?.platforms.some((x) => x.provider === p && (x.orders !== 0 || x.sales !== 0));
  // A platform's own figures first, then one whose spend Shopify has, then the one with Shopify sales, then the first.
  const first = sources.find((s) => s.source === "platform") ?? sources.find((s) => s.marketing) ?? sources.find((s) => s.source === "shopify" && sold(s.provider)) ?? sources[0]!;
  const s = sources.find((x) => x.provider === picked) ?? first;
  const demo = (p: AdSpendProvider) => !!ov.modules.ads?.byProvider.find((x) => x.provider === p)?.demo;
  return (
    <HomeCard
      id="advertising"
      title="Advertising performance"
      sub="Each platform's own figures once it's connected; until then, what its app reports to Shopify, or your Shopify orders that came from it."
      icon={icon}
      action={<DetailsLink href={`/advertising/${s.provider}`} />}
    >
      <div role="tablist" aria-label="Ad platform" className="flex gap-1 rounded-xl bg-bg p-1">
        {sources.map((x) => {
          const { name, Icon } = PROVIDER[x.provider];
          const on = x.provider === s.provider;
          return (
            <button
              key={x.provider}
              id={`home-ads-tab-${x.provider}`}
              type="button"
              role="tab"
              aria-selected={on}
              aria-controls="home-ads-panel"
              onClick={() => setPicked(x.provider)}
              className={`flex flex-1 items-center justify-center gap-1.5 rounded-lg px-2 py-1.5 text-xs font-semibold transition-colors ${on ? "bg-surface text-text shadow-[var(--shadow)]" : "text-muted hover:text-text"}`}
            >
              <Icon size={16} />
              {name}
              {x.source === "platform" && demo(x.provider) && <span className="rounded-full bg-warn/10 px-1.5 text-[10px] font-semibold text-warn">Demo</span>}
            </button>
          );
        })}
      </div>
      <div
        id="home-ads-panel"
        role="tabpanel"
        aria-labelledby={`home-ads-tab-${s.provider}`}
        className="mt-4 flex min-w-0 flex-1 flex-col"
        data-testid={`home-ads-${s.provider}`}
        data-source={s.source}
        data-marketing={s.marketing ? "true" : undefined}
      >
        {s.source === "platform" ? (
          <PlatformAds key={s.provider} ov={ov} provider={s.provider} state={s.state} manage={manage} />
        ) : s.marketing ? (
          <MarketingAds key={s.provider} ov={ov} provider={s.provider} state={s.state} manage={manage} />
        ) : s.source === "shopify" ? (
          <ShopifyAds key={s.provider} ov={ov} provider={s.provider} state={s.state} manage={manage} />
        ) : (
          <NoAdSource provider={s.provider} state={s.state} manage={manage} />
        )}
      </div>
    </HomeCard>
  );
}

// ---- Paid vs organic ----------------------------------------------------------------------------

/**
 * The store's sales by how each order's last visit came (the traffic module's split): paid ads against
 * organic search, social and other websites, then email, direct and not recorded. Shopify's own record
 * of the visit (last click), so it needs no ad account and never mixes in what a platform claims.
 */
export function PaidVsOrganic({ ov, currency, onOpen }: { ov: Overview; currency: string; onOpen: (t: Topic) => void }) {
  const t = ov.modules.traffic!;
  const split = t.split!;
  const paid = split.find((p) => p.id === "paid");
  const organic = split.find((p) => p.id === "organic");
  const any = split.some((p) => p.orders > 0 || p.sales !== 0);
  const money = (n: number) => fmtMoney(n, currency);
  return (
    <HomeCard
      id="paid-organic"
      title="Paid vs organic sales"
      sub="Net sales by the visit Shopify recorded before each order: an ad, or a search, post or website."
      icon={<Disc icon={Split} className="bg-emerald-600 text-white dark:bg-emerald-500" />}
      action={<DetailsLink onClick={() => onOpen("channels")} />}
    >
      {any ? (
        <>
          <div className="grid grid-cols-2 gap-3 divide-x divide-border">
            <Figure label="From paid ads" value={fmtPct(paid?.share ?? null)} change={<span className="text-xs tabular-nums text-muted">{paid ? money(paid.sales) : "—"}</span>} />
            <div className="pl-3">
              <Figure label="Organic" value={fmtPct(organic?.share ?? null)} change={<span className="text-xs tabular-nums text-muted">{organic ? money(organic.sales) : "—"}</span>} />
            </div>
          </div>
          <div className="mt-4">
            <TrafficSplitBar split={split} currency={currency} />
          </div>
        </>
      ) : (
        <p className="text-sm text-muted">{t.pending > 0 ? "Where these orders came from is still being read from Shopify." : "No sales with a recorded visit in these dates."}</p>
      )}
      {t.pending > 0 && any && (
        <p className="mt-2 text-xs text-muted">
          {fmtNum(t.pending)} more {t.pending === 1 ? "order is" : "orders are"} still being read from Shopify, and {t.pending === 1 ? "isn't" : "aren't"} in these figures yet.
        </p>
      )}
      <TrafficSplitNote />
    </HomeCard>
  );
}

// ---- Top products -------------------------------------------------------------------------------

export function TopProductsHome({ ov, currency, onOpen }: { ov: Overview; currency: string; onOpen: (t: Topic) => void }) {
  const tp = ov.modules.top_products!;
  const net = ov.modules.sales_overview?.current.netSales ?? 0;
  const items = [...tp.items].sort((a, b) => b.revenue - a.revenue).slice(0, 5);
  const top = Math.max(0, ...items.map((p) => p.revenue));
  return (
    <HomeCard
      id="top-products"
      title="Top products"
      sub="Your best sellers by net revenue."
      icon={<Disc icon={Package} className="bg-blue-600 text-white dark:bg-blue-500" />}
      action={<DetailsLink onClick={() => onOpen("products")}>View all</DetailsLink>}
    >
      {!tp.complete ? (
        <p className="text-sm text-muted">Rankings show once every sale of these dates is imported and verified.</p>
      ) : items.length === 0 ? (
        <p className="text-sm text-muted">No products sold in these dates.</p>
      ) : (
        <ol className="space-y-3.5">
          {items.map((p, i) => (
            <li key={p.key} className="flex min-w-0 items-center gap-3">
              <span className="w-4 shrink-0 text-center text-sm font-semibold tabular-nums text-muted">{i + 1}</span>
              {p.imageUrl ? (
                <img src={p.imageUrl} alt="" width={40} height={40} loading="lazy" className="h-10 w-10 shrink-0 rounded-lg border border-border object-cover" />
              ) : (
                <span aria-hidden className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-border bg-bg text-muted">
                  <Package className="h-5 w-5" strokeWidth={1.6} />
                </span>
              )}
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline justify-between gap-2">
                  <p className="truncate text-sm font-medium" title={p.title}>{p.title}</p>
                  <p className="shrink-0 text-sm font-semibold tabular-nums">{fmtMoney(p.revenue, currency)}</p>
                </div>
                <div className="mt-1.5 flex items-center gap-2">
                  <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-text/[0.07]">
                    <span className="animate-grow-x block h-full rounded-full" style={{ width: `${top > 0 ? Math.max(2, (p.revenue / top) * 100) : 0}%`, background: SALES }} />
                  </span>
                  <span className="w-11 shrink-0 text-right text-[11px] tabular-nums text-muted">{net > 0 && p.revenue > 0 ? fmtPct(p.revenue / net) : ""}</span>
                </div>
              </div>
            </li>
          ))}
        </ol>
      )}
    </HomeCard>
  );
}

// ---- Expenses breakdown -------------------------------------------------------------------------

export function ExpensesBreakdown({ ov, currency, adsOn, costsOn, manage, manageCosts }: { ov: Overview; currency: string; adsOn: boolean; costsOn: boolean; manage: boolean; manageCosts: boolean }) {
  const k = costsOf(ov, currency, adsOn);
  const money = (n: number) => fmtMoney(n, currency);
  const total = (k.productCosts ?? 0) + (k.adSpend ?? 0) + (k.yourCosts ?? 0);
  const share = (n: number) => (total > 0 ? fmtPct(n / total) : null);
  const any = k.productCosts !== null || k.adSpend !== null || !!k.yourCosts;
  return (
    <HomeCard
      id="expenses"
      title="Expenses breakdown"
      sub="The costs bizinsights can see for these dates."
      icon={<Disc icon={Wallet} className="bg-emerald-600 text-white dark:bg-emerald-500" />}
    >
      <div className="@container">
        <div className="flex flex-col items-center gap-5 @[25rem]:flex-row">
          <Donut
            slices={[
              { key: "products", label: "Product costs", value: k.productCosts ?? 0, color: PRODUCT_COSTS },
              { key: "ads", label: "Ad spend", value: k.adSpend ?? 0, color: AD_SPEND },
              { key: "yours", label: "Your costs", value: k.yourCosts ?? 0, color: YOUR_COSTS },
            ]}
            label={any ? `Costs we can see: ${money(total)}` : "No costs to show yet"}
            size={150}
            thickness={20}
          >
            <span className="text-base font-bold tabular-nums tracking-tight">{any ? money(total) : "—"}</span>
            <span className="text-[11px] leading-tight text-muted">Costs we can see</span>
          </Donut>
          <ul className="w-full min-w-0 flex-1 space-y-2.5">
            {costsOn && <LegendRow color={PRODUCT_COSTS} label="Product costs" value={k.productCosts !== null ? money(k.productCosts) : PRODUCT_WORDS[k.productState as Exclude<ProductCostState, "known">]} share={k.productCosts !== null ? share(k.productCosts) : null} />}
            {adsOn && (
              <>
                <LegendRow color={AD_SPEND} label="Ad spend" value={k.adSpend !== null ? money(k.adSpend) : AD_WORDS[k.adState as Exclude<CostState, "known">]} share={k.adSpend !== null ? share(k.adSpend) : null} />
                {k.byProvider.length > 1 && k.byProvider.map((b) => <LegendRow key={b.provider} sub label={PROVIDER[b.provider].name} value={money(b.spend)} share={share(b.spend)} />)}
                <LeftOutRow words={leftOutWords(k.adLeftOut)} />
              </>
            )}
            {k.yourCosts !== null && (
              <>
                <LegendRow color={YOUR_COSTS} label="Your costs" value={money(k.yourCosts)} share={share(k.yourCosts)} />
                {k.yourByCategory.map((c) => <LegendRow key={c.label} sub label={c.label} value={money(c.amount)} share={share(c.amount)} />)}
              </>
            )}
          </ul>
        </div>
      </div>
      <p className="mt-4 text-xs text-muted" data-testid="expenses-note">
        {costsOn && k.productState === "known" && k.productSource === "cost_per_item" && <>{PER_ITEM_WORDS} </>}
        {k.yourCosts === null ? (
          <>Shipping costs, fees, apps and staff aren&apos;t included: bizinsights can&apos;t see them.</>
        ) : (
          <>
            Your costs are the ones you keep in Settings → Costs, spread over the days each covers.
            {manageCosts && (
              <>
                {" "}
                <Link href="/settings/costs" className="font-medium text-accent hover:underline">{ov.modules.expenses!.count === 0 ? "Add your costs" : "Manage your costs"}</Link>.
              </>
            )}
          </>
        )}
        {adsOn && k.adState === "missing" && manage && (
          <>
            {" "}
            <Link href="/settings/integrations" className="font-medium text-accent hover:underline">Connect your ad accounts</Link> to add ad spend.
          </>
        )}
      </p>
    </HomeCard>
  );
}

// ---- Recent orders ------------------------------------------------------------------------------

const PILL = {
  green: "bg-emerald-50 text-emerald-700 dark:bg-emerald-400/10 dark:text-emerald-300",
  blue: "bg-sky-50 text-sky-700 dark:bg-sky-400/10 dark:text-sky-300",
  amber: "bg-amber-50 text-amber-700 dark:bg-amber-400/10 dark:text-amber-300",
  red: "bg-red-50 text-red-700 dark:bg-red-400/10 dark:text-red-300",
  grey: "bg-text/[0.06] text-muted",
} as const;

/**
 * One word for where an order stands, as the design's status column has: cancelled, then shipped,
 * then its payment. Payment, fulfillment and cancellation each need their own permission (Team &
 * Access): with none of them in the answer there is no word, rather than a guess.
 */
function orderStatus(o: RecentOrder): { label: string; tone: keyof typeof PILL } | null {
  if (o.cancelled) return { label: "Cancelled", tone: "red" };
  if (o.fulfillmentStatus === "fulfilled") return { label: "Fulfilled", tone: "blue" };
  const f = o.financialStatus;
  if (!f) return null;
  if (f === "paid") return { label: "Paid", tone: "green" };
  if (f === "pending" || f === "authorized" || f === "partially_paid" || f === "expired") return { label: humanize(f), tone: "amber" };
  return { label: humanize(f), tone: "grey" };
}

export function RecentOrdersHome({ ov, currency, onOpen }: { ov: Overview; currency: string; onOpen: (t: Topic) => void }) {
  const items = ov.modules.recent_orders!.items.slice(0, 5);
  const tz = ov.store.timezone;
  return (
    <HomeCard
      id="recent-orders"
      title="Recent orders"
      sub="The latest orders, whatever dates are picked."
      icon={<Disc icon={ReceiptText} className="bg-emerald-600 text-white dark:bg-emerald-500" />}
      action={<DetailsLink onClick={() => onOpen("orders")}>View all</DetailsLink>}
    >
      {items.length === 0 ? (
        <p className="text-sm text-muted">Orders show here as soon as they come in from Shopify.</p>
      ) : (
        <div className="-mx-1 overflow-x-auto">
          <table className="w-full min-w-[22rem] text-sm">
            <thead className="text-left text-[11px] text-muted">
              <tr>
                <th className="px-1 pb-2 font-medium">Order</th>
                <th className="px-1 pb-2 font-medium">Channel</th>
                <th className="px-1 pb-2 text-right font-medium">Amount</th>
                <th className="px-1 pb-2 font-medium">Status</th>
                <th className="px-1 pb-2 text-right font-medium">Date</th>
              </tr>
            </thead>
            <tbody>
              {items.map((o) => {
                const st = orderStatus(o);
                return (
                  <tr key={o.id} className={`border-t border-border ${o.cancelled ? "text-muted" : ""}`}>
                    <td className="whitespace-nowrap px-1 py-2.5 font-medium"><OrderName o={o} shopDomain={ov.store.shopDomain} /></td>
                    <td className="max-w-[7rem] truncate px-1 py-2.5 text-muted">{o.channel}</td>
                    <td className="whitespace-nowrap px-1 py-2.5 text-right tabular-nums">{fmtMoney(o.total, currency)}</td>
                    <td className="px-1 py-2.5">{st && <span className={`whitespace-nowrap rounded-md px-1.5 py-0.5 text-[11px] font-semibold ${PILL[st.tone]}`}>{st.label}</span>}</td>
                    <td className="whitespace-nowrap px-1 py-2.5 text-right text-xs text-muted">{fmtDateTime(o.createdAt, tz)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </HomeCard>
  );
}

// ---- Key insights -------------------------------------------------------------------------------

const INSIGHT: Record<Health, { icon: LucideIcon; row: string; disc: string; word: string }> = {
  attention: { icon: OctagonAlert, row: "border-red-200/70 bg-red-50/60 dark:border-red-400/20 dark:bg-red-400/[0.07]", disc: "bg-red-100 text-red-700 dark:bg-red-400/15 dark:text-red-300", word: "Needs attention" },
  watch: { icon: TriangleAlert, row: "border-amber-200/70 bg-amber-50/60 dark:border-amber-400/20 dark:bg-amber-400/[0.07]", disc: "bg-amber-100 text-amber-700 dark:bg-amber-400/15 dark:text-amber-300", word: "Keep an eye on" },
  good: { icon: CircleCheck, row: "border-emerald-200/70 bg-emerald-50/60 dark:border-emerald-400/20 dark:bg-emerald-400/[0.07]", disc: "bg-emerald-100 text-emerald-700 dark:bg-emerald-400/15 dark:text-emerald-300", word: "Looking good" },
  info: { icon: Info, row: "border-sky-200/70 bg-sky-50/60 dark:border-sky-400/20 dark:bg-sky-400/[0.07]", disc: "bg-sky-100 text-sky-700 dark:bg-sky-400/15 dark:text-sky-300", word: "For your info" },
};

/**
 * The business health check's first four (worst first, `businessHealth`), each opening its area;
 * `report`: whether the full report (the overview panel) is shared with this member ("View reports").
 */
export function KeyInsights({ ov, currency, onOpen, report }: { ov: Overview; currency: string; onOpen: (t: Topic) => void; report: boolean }) {
  const checks = businessHealth(ov, currency).slice(0, 4);
  return (
    <HomeCard
      id="insights"
      title="Key insights"
      sub="What stands out for these dates."
      icon={<Disc icon={Lightbulb} className="bg-amber-400 text-white dark:bg-amber-500" />}
      action={report ? <DetailsLink onClick={() => onOpen("overview")}>View all</DetailsLink> : undefined}
    >
      {checks.length === 0 ? (
        <p className="text-sm text-muted">Nothing to point out yet: insights show once orders come in.</p>
      ) : (
        <ul className="space-y-2.5">
          {checks.map((c) => {
            const look = INSIGHT[c.health];
            return (
              <li key={c.id}>
                <button type="button" onClick={() => onOpen(c.topic)} className={`flex w-full items-center gap-3 rounded-xl border px-3 py-2.5 text-left transition-colors hover:border-accent/40 ${look.row}`} data-testid={`insight-${c.id}`}>
                  <span aria-hidden className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full ${look.disc}`}>
                    <look.icon className="h-4 w-4" strokeWidth={2.2} />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-semibold leading-snug">
                      {c.area} <span className="font-normal text-muted">· {look.word}</span>
                    </span>
                    <span className="mt-0.5 block text-xs leading-relaxed text-muted">{c.text}</span>
                  </span>
                  <ChevronRight aria-hidden className="h-4 w-4 shrink-0 text-muted" />
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </HomeCard>
  );
}

// ---- Grow your business -------------------------------------------------------------------------

function Connection({ icon, name, on }: { icon: ReactNode; name: string; on: boolean }) {
  return (
    <li className="flex min-w-[9.5rem] items-center gap-2.5 rounded-xl border border-border bg-surface px-3 py-2.5">
      <span aria-hidden className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-border bg-white">{icon}</span>
      <span className="min-w-0">
        <span className="block truncate text-xs font-semibold">{name}</span>
        <span className={`mt-0.5 flex items-center gap-1 text-[11px] ${on ? "text-good" : "text-muted"}`}>
          {on ? <CircleCheck aria-hidden className="h-3 w-3" strokeWidth={2.5} /> : <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-muted" />}
          {on ? "Connected" : "Not connected"}
        </span>
      </span>
    </li>
  );
}

/** The foot of the page for those who connect things: what is connected, and the way to more. */
export function GrowBusiness({ ov, adsOn }: { ov: Overview; adsOn: boolean }) {
  const con = ov.modules.ad_connections;
  return (
    <section aria-labelledby="grow-h" className="animate-rise flex flex-col gap-4 rounded-2xl border border-accent/20 bg-gradient-to-r from-accent/[0.08] to-accent/[0.02] p-5 xl:flex-row xl:items-center" data-testid="home-grow">
      <div className="flex min-w-0 flex-1 items-center gap-3.5">
        <span aria-hidden className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-accent text-accent-ink">
          <Rocket className="h-5 w-5" strokeWidth={2} />
        </span>
        <div className="min-w-0">
          <h2 id="grow-h" className="font-semibold">Grow your business</h2>
          <p className="mt-0.5 text-xs text-muted">Connect more channels to see your sales, ads and costs side by side.</p>
        </div>
        <Link href="/settings/integrations" className="btn-primary ml-auto hidden shrink-0 text-xs sm:inline-flex xl:ml-4">
          Connect more integrations
          <ArrowRight aria-hidden className="h-3.5 w-3.5" />
        </Link>
      </div>
      <ul className="flex flex-wrap gap-2.5">
        <Connection icon={<ShopifyIcon size={18} />} name="Shopify" on />
        {adsOn && <Connection icon={<GoogleAdsIcon size={18} />} name="Google Ads" on={(con?.google ?? 0) > 0} />}
        {adsOn && <Connection icon={<MetaIcon size={18} />} name="Meta Ads" on={(con?.meta ?? 0) > 0 || !!con?.waiting?.includes("meta")} />}
        <li>
          <Link href="/settings/integrations" className="flex h-full min-h-[3.25rem] items-center gap-2 rounded-xl border border-dashed border-accent/40 px-3.5 text-xs font-semibold text-accent hover:bg-accent/[0.05]">
            <Plus aria-hidden className="h-4 w-4" />
            Add integration
          </Link>
        </li>
      </ul>
    </section>
  );
}
