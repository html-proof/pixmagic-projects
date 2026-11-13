"use client";
import type { ReactNode } from "react";
import { claimsAddUp } from "@app/shared/ads";
import { gradeRefundRate, shippingIsLate } from "@app/shared/health";
import { bestEntryPage, biggestDropOff, dropOffSection } from "@app/shared/journey";
import { dailyBreakdown } from "@app/shared/sales";
import { MoreDetail } from "@/components/MoreDetail";
import { fmtMoney, fmtNum, fmtPct } from "@/lib/api";
import { FOLD_DETAIL } from "@/lib/features";
import { SECTION_LABEL, STEP_LABEL } from "./Funnel";
import { fmtTimes, hourRange, plural, weekdayName } from "./format";
import { Icon } from "./Icons";
import { Panel } from "./Primitives";
import { asSalesDays } from "./redacted";
import type { Topic } from "./topics";
import type { Overview } from "./types";

// ---------------------------------------------------------------------------
// The bottom of every topic's page: what to do about these numbers, worked out from the store's
// own figures, and what each figure means in plain words. Nothing here is advice from outside
// the data: each "next" line names the number it comes from.
// ---------------------------------------------------------------------------

type Terms = Array<[string, ReactNode]>;

const TERMS: Record<Topic, Terms> = {
  overview: [
    ["Needs attention", "More than 10% of sales refunded or cancelled, something sold out, or an order waiting over 3 days to ship."],
    ["Keep an eye on", "Refunds between 5% and 10% of sales, something running low, or orders waiting to ship."],
    ["Looks good", "Refunds at 5% of sales or less, nothing low or sold out, nothing waiting to ship."],
    ["For your info", "Facts with no good or bad, like your best seller."],
  ],
  sales: [
    ["Same as Shopify", "Every sales figure here is worked out from Shopify's own sales records, the way Shopify's reports do, so the same dates show the same numbers in both. Test orders aren't counted."],
    ["Total sales", "What customers paid: net sales plus additional fees, duties, shipping charges and taxes. Shopify's home page shows this figure."],
    ["Refunds (under total sales)", "How much refunds, returns and cancellations took off total sales in these dates, tax and shipping included: the money given back. Total sales is already after them, on the day each refund was made, so a refund today lowers today even for an order placed earlier. An item returned with no money given back takes nothing off."],
    ["Custom sales", "Your own calculation from the lines of total sales: for example without taxes, or product revenue only. It is always shown next to Shopify's total sales and named after the calculation, and never changes Shopify's figures. Owners and admins choose it in the Total sales breakdown."],
    ["Net sales", "What your products sold for: gross sales, minus discounts, minus returns. Tax and shipping aren't included. It is sales, not profit: what the products cost you isn't taken off."],
    ["Gross sales", "Every item sold at its listed price, before any discount and before tax."],
    ["Discounts", "Money taken off by discount codes and automatic discounts."],
    ["Returns", "What refunds, cancellations and order edits took back. Each counts on the day it was made, so it can lower a later period than the order's."],
    ["Orders", "Orders placed in these dates, cancelled ones included, as Shopify counts them. A cancellation then shows up as a return."],
    ["Average order value", "Sales after discounts divided by the number of orders: what a typical order is worth."],
    ["Items sold", "Items sold less items returned. Two mugs in one order count as two."],
    ["Shipping and taxes", "Collected on top of your prices and passed on or spent on postage: part of total sales, not of net sales."],
    ["Day-by-day bars", "One bar per day. Darker bars are your stronger days: about 1.5 and 2 times your average day. The orange line underneath adds the days up as you go."],
    ["Month-by-month bars", "One bar per month this year."],
    ["Not imported", "Shopify shares only the last 60 days of orders with most apps, so earlier days are marked instead of shown as $0."],
    ["Checked against Shopify", "The same dates in Shopify's own sales report, next to ours, figure by figure. They should agree to the cent. “Catching up” means changes from Shopify are still being counted here, or Shopify's report hasn't included the newest orders yet."],
    ["Gross profit (Shopify)", "Shopify's figure: net sales less the cost of the goods sold, from the cost per item recorded with each sale. Sales with no cost recorded in Shopify count as if they cost nothing, so the card says how much that is. It isn't net profit: fees, postage, apps, staff and ads aren't taken off."],
  ],
  ads: [
    ["Ad spend", "What Meta and Google charged for your ads on those days, in the ad account's currency."],
    ["Impressions and link clicks", "Impressions are times an ad was shown; link clicks are clicks on the ad's link, to your store or another page. Meta's own \"clicks (all)\" also count likes, comments and profile taps, so they aren't used."],
    ["Click-through rate (CTR)", "Link clicks divided by impressions: how often people who saw an ad clicked it."],
    ["Cost per click (CPC) / per 1,000 impressions (CPM)", "Spend divided by link clicks, or by thousands of impressions."],
    ["Purchases (platforms' count)", "Purchases Meta or Google credit to their own ads, from their pixel or conversion tracking (for Google, its conversion actions of the Purchase category). Both can claim the same sale, so they won't add up to your Shopify orders."],
    ["Purchase value and return on ad spend (ROAS)", "The value of those purchases, and that value divided by spend: each platform's own figure. 3× means the platform counts $3 of purchases for every $1 spent."],
    ["Cost per purchase", "Spend divided by the purchases the platform counts."],
    ["Conversions (all conversion actions)", "Google Ads' own conversions: every action it's set to count, so leads, sign-ups and calls as well as purchases. Shown on their own, never added to purchases."],
    ["Ads as share of sales", "Ad spend divided by your store's own net sales for the same dates: what ads cost out of every dollar of net sales."],
    ["Unavailable", "Shown instead of a figure when an ad account has no figures for some of the dates: it's still being read for the first time, its updates stopped (for example, access ended), or its history doesn't reach back that far. A missing day is never counted as $0. A closed account spends nothing, so its days since it closed count as 0."],
    ["Up to (a date)", "While the only days missing are the newest ones, still running or not started yet in an ad account's own time zone, the figure covers the dates up to the last day every account has, and says so. The next update brings the rest."],
    ["Days", "Each ad account's own calendar day, in its time zone. They line up with your store's days when the time zones match; the cards say when they don't."],
    ["Updated", "Every hour, and the last 30 days are fetched again daily because the platforms keep counting purchases for a while after the click."],
  ],
  adsense: [
    ["Estimated earnings", "What Google AdSense estimates the ads shown on your site earned, in the AdSense account's currency. AdSense finalizes each month in the first days of the next, so recent days can still change."],
    ["Page views", "Pages on your site that showed AdSense ads, as AdSense counts them."],
    ["Page RPM", "Estimated earnings divided by thousands of page views: what a thousand page views are worth in ad money."],
    ["Impressions", "AdSense counts one for each ad request where at least one ad was delivered to the page, not one for every ad shown."],
    ["Click-through rate (CTR)", "Clicks divided by impressions."],
    ["Earnings per click", "Estimated earnings divided by clicks."],
    ["Next to your sales", "Estimated earnings divided by your store's own net sales for the same dates. Earnings are never mixed with what you spend on ads."],
    ["By site", "Each of the store's sites the ads were shown on. Other sites on the same AdSense account aren't counted when sites are chosen for the store in Settings, and the page lists them."],
    [
      "Unavailable",
      "Shown instead of a figure when AdSense hasn't been read for some of the dates, or, with sites chosen for the store, when AdSense reported those days for all of the account's sites together, so the store's share isn't known. A missing day is never counted as $0.",
    ],
    ["Up to (a date)", "While the only days missing are the newest ones, still running or not started yet in the AdSense account's time zone, the figure covers the dates up to the last day read, and says so."],
    ["Days", "The AdSense account's own calendar day, in its time zone."],
    ["Updated", "Every hour, and the last 30 days are fetched again daily while AdSense settles its estimates."],
  ],
  products: [
    ["Sales (per product)", "The product's net sales in these dates: what it sold for after discounts and returns, before tax, as Shopify's sales by product counts it."],
    ["Units", "How many of that product were sold, less those returned."],
    ["Each on average", "The product's sales divided by its units: what one sold for, after discounts."],
    ["Share of sales", "How much of all your sales (after discounts) came from that product."],
    ["Active, draft, archived", "Active products are on sale; drafts are hidden from customers; archived ones are put away."],
    ["Top vendors", "The brands whose products sold best in these dates, by net sales (after discounts and returns, before tax)."],
  ],
  shoppers: [
    ["Sessions (Shopify)", "Shopify Analytics' own count of visits to your online store: a session ends after 30 minutes without activity, and bot sessions are left out by Shopify's own classification."],
    ["Visitors (Shopify)", "The different people behind those sessions, over the whole of the dates picked (one person on three days is one visitor)."],
    ["Conversion rate (Shopify)", "Sessions that completed checkout divided by sessions, Shopify's own formula."],
    ["Tracked visit", "One shopper on one day, however many pages they looked at, as the bizinsights pixel saw it. Not Shopify's session: Shopify ends a session after 30 minutes idle and counts shoppers who decline tracking too."],
    ["Tracked visits that bought", "The share of tracked visits that ended with a finished checkout. Shopify's conversion rate divides by its sessions instead, so the two differ."],
    ["The steps", "Visited your store → viewed a product → added to cart → started checkout → completed a purchase. A visit counts for every step it reached."],
    ["Left at this step", "Visits whose furthest step was this one: they went no further."],
    ["Last page they were on", "Where those shoppers were when they left: product pages, the cart, and so on."],
    ["Landed here / left from here", "The page a visit started on, and the page it ended on without buying."],
    ["Exit rate", "Of the visits that saw a part of your store, the share that left the site from there without buying."],
    ["Why numbers are trends", "Shoppers who decline tracking in your store's cookie banner aren't counted, so read these as direction, not exact totals."],
  ],
  timing: [
    ["Busiest day and hour", "When the most orders were placed in these dates."],
    ["Time zone", "Days and hours follow your store's time zone, not the viewer's."],
    ["By day / by hour", "Every order in these dates, counted by the day of the week and the hour it was placed."],
  ],
  channels: [
    ["Channel", "Where the order was placed: your online store, point of sale, a marketplace or another app."],
    ["Share of sales", "How much of your sales (after discounts) came through that channel."],
  ],
  shipping: [
    ["Waiting to ship", "Every open order, from any date, that is unfulfilled, partly fulfilled, on hold or scheduled."],
    ["Average time to ship", "From the order to its first shipment, for orders placed in these dates."],
    ["Fulfilled", "Orders with everything shipped."],
    ["Partly fulfilled", "Orders with some items shipped and some still to go."],
  ],
  stock: [
    ["Units in stock", "Everything on hand across all your locations, for products where Shopify tracks quantity."],
    ["Stock value at cost", "What you paid for the stock you hold, from the cost per item you entered in Shopify."],
    ["Retail value", "What that stock would bring in at today's prices."],
    ["Running low", "At or under the low-stock threshold (10 unless you set one in Inventory → Stock settings), counting every location: the same rule as the Inventory section."],
    ["Sells per day", "Average items sold per day over the last 30 days, returns taken off. Needs 14 days of imported orders."],
    ["Runs out in", "Units left divided by sells per day."],
  ],
  discounts: [
    ["Code", "A discount code customers typed at checkout. Codes are matched whatever the capital letters."],
    ["Orders", "Orders placed with the code, cancelled ones included, as Shopify counts them. An order with two codes counts for both."],
    ["Discounts on these orders", "What those orders' items were discounted, automatic discounts included, before tax: the same terms as the Discounts line. Shipping discounts are in shipping."],
    ["Net sales", "Those orders' sales after discounts and after their returns and cancellations, before tax and shipping."],
  ],
  customers: [
    ["Returning customer", "A customer whose order came after an earlier one, as Shopify counts them. Their very first purchase counts as new, even if they bought again since."],
    ["First order", "An order from someone buying from you for the first time."],
    ["Customers to follow up", "People who left items in checkout, or signed up for emails, with their details straight from Shopify. Nothing is stored by bizinsights."],
    ["Link back to their cart", "Shopify's own link for an unfinished checkout. Opening it takes the shopper straight back to checkout with everything still in their cart, so they can pay and finish."],
    ["WhatsApp, Email, Text message", "Each opens that app on your phone or computer with the message and link already written. Check it, then press send yourself. Other apps opens your phone's share menu for anything else you use."],
    ["Your message", "The words every button sends, with each person's name, items and link filled in. Change it once and it's kept for this store in this browser."],
    ["Agreed to marketing", "Whether the person said yes to marketing emails or texts in your store. Send offers only to people who agreed."],
    ["Phone from the checkout", "When a shopper has no customer record yet, the phone number and name come from what they typed into the checkout's address."],
  ],
  orders: [
    ["Orders", "Every order placed in the dates picked, newest first unless you sort them. Cancelled ones are shown and marked."],
    ["Payment status", "Paid, pending, refunded and so on, as Shopify reports it."],
    ["Fulfillment status", "Whether the order has shipped."],
    ["Channel", "Where the order was placed."],
  ],
};

/** "What you could do next": each line comes straight from a number on the page. */
function nextSteps(topic: Topic, ov: Overview, currency: string): ReactNode[] {
  const m = ov.modules;
  const money = (n: number) => fmtMoney(n, currency);
  const out: ReactNode[] = [];
  switch (topic) {
    case "overview":
    case "sales": {
      const s = m.sales_overview;
      if (!s) break;
      const r = m.refunds?.current;
      if (r?.refundRate && gradeRefundRate(r.refundRate) !== "good") out.push(<>Refunds are {fmtPct(r.refundRate)} of sales ({money(r.refunds)}). <b>Recent orders</b> links each order to Shopify to see why.</>);
      const b = dailyBreakdown(asSalesDays(s.series), ov.today, ov.data?.historyFrom ?? null);
      if (b.bestWeekday) out.push(<>{weekdayName(b.bestWeekday.weekday, "long")}s sell best ({money(b.bestWeekday.average)} on average): a good day for emails, posts or new products.</>);
      if (topic === "overview") {
        const inv = m.inventory?.current;
        if (inv && inv.outOfStock > 0) out.push(<>{plural(inv.outOfStock, "variant is", "variants are")} sold out. <b>Stock</b> lists what to reorder first.</>);
        const f = m.fulfillment;
        if (f && shippingIsLate(f.oldestOpenDays)) out.push(<>An order has waited {plural(f.oldestOpenDays!, "day")} to ship. <b>Shipping</b> shows what&apos;s still open.</>);
      }
      break;
    }
    case "ads": {
      const a = m.ads;
      // Only on figures for every day: a short total would point the wrong way.
      if (!a?.current || a.current.spend === 0) break;
      // Purchases against purchases only: Google's other conversions (leads, calls) aren't sales.
      const [p1, p2] = [...a.byProvider].filter((p) => p.costPerPurchase !== null).sort((x, y) => x.costPerPurchase! - y.costPerPurchase!);
      if (p1 && p2) {
        const name = (p: typeof p1) => (p.provider === "meta" ? "Meta" : "Google Ads");
        out.push(<>{name(p1)} gets a purchase for {fmtMoney(p1.costPerPurchase!, a.currency)} against {fmtMoney(p2.costPerPurchase!, a.currency)} on {name(p2)}, by their own counts.</>);
      }
      const worst = a.campaigns?.find((c) => c.complete !== false && c.spend > 0 && c.purchases === 0 && c.conversions === 0);
      if (worst) out.push(<>&ldquo;{worst.name}&rdquo; spent {fmtMoney(worst.spend, a.currency)} with no purchase or other conversion counted. Check whether it&apos;s meant to bring sales, or something else such as awareness.</>);
      if (a.shareOfSales !== null) out.push(<>Ads cost {fmtPct(a.shareOfSales)} of your net sales. Compare that with your profit margin: if ads cost more than you make on a sale, they lose money even when they bring sales.</>);
      // Every sale the store made against everything spent on ads (MER): the store's own measure, beside the platforms' claims.
      // With more than one platform counted, each one's own ROAS: their claims added up could count an order twice.
      const own = a.byProvider.map((p) => ({ name: p.provider === "meta" ? "Meta" : "Google Ads", roas: p.current?.roas ?? null }));
      const claims = claimsAddUp(a.byProvider.map((p) => p.provider))
        ? a.current.roas !== null
          ? `the platforms credit themselves with ${fmtTimes(a.current.roas)} by their own counts`
          : null
        : own.every((p) => p.roas !== null)
          ? `${own.map((p, i) => (i ? `${p.name} with ${fmtTimes(p.roas)}` : `${p.name} credits itself with ${fmtTimes(p.roas)}`)).join(" and ")}, each by its own count, and both can claim the same order`
          : null;
      if (a.sales?.salesPerSpend != null && claims) {
        out.push(
          <>
            Counting every sale, your store made {fmtTimes(a.sales.salesPerSpend)} what you spent on ads; {claims}. The gap is
            sales from everything else you do (repeat customers, search, word of mouth) and sales the platforms claim that would have happened anyway.
          </>,
        );
      }
      break;
    }
    case "adsense": {
      const a = m.adsense;
      if (!a?.current || a.current.pageViews === 0) break;
      const site = a.sites.length > 1 ? a.sites[0] : null;
      if (site && site.site && a.current.earnings > 0) out.push(<>{site.site} brings {fmtPct(site.earnings / a.current.earnings)} of your estimated ad earnings.</>);
      if (a.vsSales !== null && a.vsSales > 0) out.push(<>Ad earnings add {fmtPct(a.vsSales)} to your net sales. Ads on a store can also distract shoppers: if fewer visitors buy after adding them, they may cost more than they earn.</>);
      break;
    }
    case "products": {
      const top = m.top_products?.items[0];
      const c = m.sales_overview?.current;
      // Product sales are each product's net sales: together they make the store's net sales.
      const base = c?.netSales ?? null;
      if (top && base !== null && base > 0) {
        const low = m.inventory?.lowStockItems.some((i) => i.productTitle === top.title);
        out.push(<>{top.title} brings in {fmtPct(top.revenue / base)} of your sales{low ? <>, and it&apos;s running low: reorder it first</> : <>: keep it in stock</>}.</>);
      }
      if (m.catalog && m.catalog.products.draft > 0) out.push(<>{plural(m.catalog.products.draft, "product is", "products are")} still a draft, hidden from customers.</>);
      break;
    }
    case "shoppers": {
      const f = m.funnel;
      if (!f || f.visits === 0) break;
      const leak = biggestDropOff(f.steps);
      if (leak && leak.left > 0) {
        const where = dropOffSection(leak);
        const hint: Record<string, string> = {
          visited: "make products easier to find from the pages people land on",
          viewed_product: "check product photos, descriptions, price and the shipping cost shown",
          added_to_cart: "check the cart page and any surprise costs before checkout",
          started_checkout: "check shipping costs, delivery times and payment options at checkout",
        };
        out.push(
          <>
            Most shoppers who leave stop at &ldquo;{STEP_LABEL[leak.step].toLowerCase()}&rdquo; ({plural(leak.left, "visit")}){where ? <>, mostly on {SECTION_LABEL[where].toLowerCase()}</> : null}. That&apos;s where a small change helps most: {hint[leak.step] ?? "look at that step"}.
          </>,
        );
      }
      const bestEntry = bestEntryPage(f.entryPages);
      if (bestEntry && bestEntry.purchases > 0) out.push(<>Visits that start on {bestEntry.path === "/" ? "your home page" : bestEntry.path} buy most often ({fmtPct(bestEntry.purchases / bestEntry.visits)}): it&apos;s a good page to link to from ads and emails.</>);
      break;
    }
    case "timing": {
      const t = m.order_timing;
      if (!t?.busiestDay || t.busiestHour === null) break;
      out.push(<>Most orders come on {t.busiestDay}s around {hourRange(t.busiestHour)}. Send emails or post a little before then to reach people when they buy.</>);
      const total = t.byWeekday.reduce((a, b) => a + b, 0);
      if (total) out.push(<>{weekdayName(t.byWeekday.indexOf(Math.min(...t.byWeekday)), "long")} is your quietest day: a good day for restocking and admin.</>);
      break;
    }
    case "channels": {
      const top = m.channels?.items[0];
      if (top && top.share !== null && top.share > 0.8 && (m.channels?.items.length ?? 0) > 1) out.push(<>{fmtPct(top.share)} of sales come through {top.label}, so most of your business depends on that one channel.</>);
      break;
    }
    case "shipping": {
      const f = m.fulfillment;
      if (f && f.openNow > 0) out.push(<>Ship the oldest first: {plural(f.openNow, "order")} {f.openNow === 1 ? "is" : "are"} waiting{f.oldestOpenDays !== null ? <>, the oldest for {plural(f.oldestOpenDays, "day")}</> : null}.</>);
      break;
    }
    case "stock": {
      const items = m.inventory?.lowStockItems ?? [];
      for (const i of items.slice(0, 3)) {
        out.push(
          <>
            Reorder {i.productTitle}
            {i.variantTitle && i.variantTitle !== "Default Title" ? <> ({i.variantTitle})</> : null}: {i.quantity <= 0 ? "it's sold out" : <>{fmtNum(i.quantity)} left{i.daysOfCover !== null ? <>, about {plural(Math.max(0, Math.round(i.daysOfCover)), "day")} of sales</> : null}</>}.
          </>,
        );
      }
      break;
    }
    case "discounts": {
      const c = m.sales_overview?.current;
      if (c && c.grossSales !== undefined && c.discounts !== undefined && c.grossSales > 0 && c.discounts > 0) out.push(<>Discounts took {money(c.discounts)} off full price, {fmtPct(c.discounts / c.grossSales)} of it. Compare that with the sales the codes brought in, in the table above.</>);
      break;
    }
    case "customers": {
      const r = m.customers?.current.returningCustomerRate;
      if (r !== undefined && r !== null && r < 0.25) out.push(<>Only {fmtPct(r)} of your customers had bought before. A thank-you email, or a small code for a second order, can bring first-time buyers back.</>);
      break;
    }
    case "orders":
      break;
  }
  return out;
}

export function Explained({ topic, ov, currency }: { topic: Topic; ov: Overview; currency: string }) {
  const next = nextSteps(topic, ov, currency);
  const terms = (
    <dl className="divide-y divide-border">
      {TERMS[topic].map(([term, text]) => (
        <div key={term} className="grid gap-0.5 py-2.5 text-sm sm:grid-cols-[13rem_1fr] sm:gap-4">
          <dt className="font-medium">{term}</dt>
          <dd className="text-muted">{text}</dd>
        </div>
      ))}
    </dl>
  );
  return (
    <>
      {next.length > 0 && (
        <Panel id={`d-next-${topic}`} title="What you could do next" help="Worked out from your own numbers above.">
          <ul className="space-y-3 text-sm">
            {next.map((n, i) => (
              <li key={i} className="flex items-start gap-2.5">
                <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-accent/12 text-accent">
                  <Icon name="check" className="h-3.5 w-3.5" />
                </span>
                <span className="leading-relaxed">{n}</span>
              </li>
            ))}
          </ul>
        </Panel>
      )}
      {/* The glossary: one fold for every topic, so a device that opened it has it open on each page. */}
      <MoreDetail id="terms" label="What these numbers mean" holds={TERMS[topic].map(([term]) => term)}>
        {FOLD_DETAIL ? (
          // The fold's own row is the heading.
          <section id={`d-terms-${topic}`} className="card min-w-0" aria-label="What these numbers mean" data-testid={`module-d-terms-${topic}`}>
            {terms}
          </section>
        ) : (
          <Panel id={`d-terms-${topic}`} title="What these numbers mean" help="Every figure on this page, in plain words.">
            {terms}
          </Panel>
        )}
      </MoreDetail>
    </>
  );
}
