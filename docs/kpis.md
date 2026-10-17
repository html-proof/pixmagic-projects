# KPI definitions

Source of truth: `packages/shared/src/kpi.ts` (reference implementation) and `recomputeDays` in `packages/core/src/persist.ts` (SQL used in production). An integration test asserts they produce identical results.

## Where the sales figures come from

The sales figures are Shopify's own. Shopify's reports are built from its **sales records**: each
order's agreements (`Order.agreements`, one per event: the order placed, an edit, a refund, a
return or cancellation), each holding sales (`sales`: one line sold, returned or changed, with its
amount, discount and tax). bizinsights stores those records as they are (`order_sales`) and adds
them up the same way, so a range shows the same gross sales, discounts, returns, net sales,
shipping, taxes and total sales as Shopify's sales reports for the same dates.

- **Read with the order**: the import (bulk and paged), the reconcile and the dashboard's refresh
  read an order's agreements with it. A webhook carries none, so after an `orders/*` or
  `refunds/create` delivery the worker reads the order's sales (`ORDER_SALES_QUERY`), but only
  when the payload's money state changed (`restSalesKey`: totals now and as placed, cancellation,
  refunds, items left), so paid/fulfilled/tagged deliveries cost no call.
- **Provisional sales**: until an order's sales have been read (a brand-new order whose read
  failed, say), the webhook's payload stands in, estimated in the same shape (a sale per line and
  per shipping line, valued after discounts, with their tax). The first successful read replaces
  them; `orders.sales_updated_at` stays empty until then, and the dashboard's refresh re-reads any
  order in the import window that has it empty (at most daily).
- **Test orders** (`Order.test`) are never stored, and one stored before is removed, as Shopify's
  reports leave them out.

## Conventions

- **Currency:** the store's currency (Shopify `shop_money`). Presentment currencies are ignored. Money totals are rounded to cents before ratios are derived.
- **Day:** calendar day in the **store's IANA time zone** (from `shop.ianaTimezone`), not the viewer's and not UTC. Date presets (`today`, `7d`, `mtd`, …) resolve in that zone too.
- **Custom ranges** run from 2000-01-01 at the earliest, cover at most 366 days, and are reported only up to the store's today: picking 1–31 Oct on 9 Oct reports 1–9 Oct. A range that starts after today is refused (`400 invalid_range`).
- **Comparison period:** the same number of days immediately before the selected range (after that clamp).
  **Like for like, as Shopify's Analytics compares:** while the range is still running (it ends on the
  store's today), the comparison stops at the same time of day on its last day. Today until 4:44:12 pm
  is compared with yesterday until 4:44:12 pm, and the last 7 days with the 7 before up to the same
  moment, never with whole days (that made every day look down until it was nearly over).
  `resolvePreset` returns that time as `previous.until` (store-local "HH:MM:SS", by the clock, so a
  daylight-saving change doesn't shift it). The comparison's last day is then added up from the orders
  placed and the sales made before that moment, by the same query that fills daily_store_metrics
  (`dayTotals` in packages/core/src/persist.ts), and its store visits are the ones that started before
  it. Ad platforms (Meta, Google, AdSense) report whole days, so their comparisons stay whole days.
- **Daily series** (the sales chart and sparklines) has one point per day of the range; days without orders or sales are 0.
- **A sale counts on the day it happened**: an order's sales on the day it was placed, a refund, return, cancellation or edit on the day it was made (the agreement's `happenedAt`), whatever day the order was placed. Last month's numbers can change only if Shopify backdates a record, which it doesn't.
- **Cancelled orders** count as orders of the day they were placed, as in Shopify's reports; the cancellation is a return on the day it was made, so a cancelled order adds nothing to net sales once both are in the range. Operational modules (order timing, shipping, discount codes, vendors) still leave cancelled orders out.
- **Prices that include tax** (GST, VAT) are taken apart as Shopify does: a sale's value is its amount less its tax.
- **A return is never money in**: a return is counted as negative whatever sign it came with.
- **Missing denominators** produce `null` (shown as "—"), never a fake 0.
- Tax and shipping are excluded from net sales and included in total sales. Gift card sales and tips are in neither (Shopify counts a gift card when it is spent, not when it is sold).

## Formulas

| KPI | Formula | Plain language (shown in UI) |
| --- | --- | --- |
| Gross sales | Σ (amount − tax + discount) of the product and adjustment sales of orders placed (action `order`) | Every item sold at its listed price, before tax |
| Discounts | Σ discount before tax of those sales | |
| Returns (`refunds`) | − Σ (amount − tax) of the other product and adjustment sales: returns, cancellations, edits | What refunds, cancellations and edits took back |
| **Net sales** | Gross − Discounts − Returns | What you kept, before tax and shipping |
| Shipping charges | Σ (amount − tax) of shipping sales | After shipping discounts and refunds |
| Taxes | Σ tax of every sale (gift cards and tips aside) | |
| **Total sales** | Net sales + Shipping + Taxes + duties and fees | Shopify's headline figure; the first tile |
| Orders | count of orders placed (cancelled included, test orders never stored) | |
| Units (items sold) | Σ quantity sold − Σ quantity returned | |
| **Average order value** | (Gross − Discounts) ÷ Orders | Typical spend per order, after discounts, before returns |
| **Refund rate** | Returns ÷ (Gross − Discounts) | Share of sales later taken back |
| **Returning customer rate** | orders from returning customers ÷ orders with a customer | Requires `read_customers`. A customer is "returning" if Shopify reports more than one order for them, or we have an earlier order from them |
| Top products | Σ net sales and Σ net items per product (its product sales in the range), top 5 | Requires `read_products`; the products together make net sales |
| **Conversion rate** | visits that completed checkout ÷ visits | From the web pixel |
| Funnel step | visits whose furthest step is this one or later | Steps: visited → viewed a product → added to cart → started checkout → purchased |
| Left at a step | visits whose furthest step is exactly this one | Plus the site section they were last on |
| Section exit rate | visits that left the site from this section without buying ÷ visits that saw this section | |
| Δ vs previous | (current − previous) ÷ \|previous\| | `null` when previous is 0; like for like while the range runs (Conventions) |

## Sales breakdown (Sales section)

Reference implementation: `packages/shared/src/sales.ts`.

**Day by day** (the dates picked, two days or more):

- **Average day**: net sales of finished, imported days ÷ their count. Today is still running, so it is left out.
- **Day tiers**: a *strong* day is ≥ 1.5 × the average day, a *best* day ≥ 2 × it, each rounded to a figure a merchant would set as a target (A$1,530 → A$1,500). They are relative to the store, not fixed amounts, and only set once the range has 14 finished days.
- **Best weekday**: the weekday with the highest average net sales over finished days, shown from 14 finished days.
- **Running total**: net sales from the first imported day of the range to the end of each day. It is drawn as its own strip under the columns, not on a second axis.

**Month by month** (this calendar year in the store's time zone, whatever dates are picked):

- Net sales, orders and average order value per month, January to the current month.
- **Change**: on the month before (January on December). The current month is compared with the same days of the month before (1–9 Oct with 1–9 Sep), never with the whole month.
- **Average month**: over finished months that were fully imported.

**Not imported.** Days and months before the store's first imported order are drawn hatched and labelled, never as $0. Shopify shares only the last 60 days of orders without `read_all_orders`. A month that is only partly imported is drawn lighter, and no change is calculated for it or against it.

## Business overview (health check)

Reference implementation: the grading rules in `packages/shared/src/health.ts` (unit-tested), applied by `businessHealth` in `apps/web/src/components/dashboard/Overview.tsx`. Each area gets one of four labels, always shown as words beside a colored dot:

| Area | Looks good | Keep an eye on | Needs attention |
| --- | --- | --- | --- |
| Net sales, orders, average order, visitors who bought, returning customers | up or level on the period before | down by less than 10% | down by 10% or more |
| Refunds | up to 5% of sales | over 5% and up to 10% | over 10% |
| Stock | nothing sold out or low | something running low | something sold out |
| Shipping | nothing waiting | orders waiting, none over 3 days | an order waiting over 3 days |

Best seller, top channel and busiest time are information only. With nothing earlier to compare with, an area is information only too. When the only day picked is today, trends aren't graded, because the day isn't over.

## Where sales come from (Sales channels → "Where your sales come from")

Shopify's own record of the visit before each order, so it works for every store with nothing but
`read_orders` and no ad account: GraphQL `Order.customerJourneySummary.lastVisit` during the import,
a webhook's `landing_site` / `referring_site` live (`packages/shared/src/traffic.ts`, `classifyVisit`).

- **Source**: the link's `utm_source`, else a click id (`gclid`/`gbraid`/`wbraid` Google, `ttclid` TikTok,
  `msclkid` Bing), else the referring site (facebook.com, instagram.com, google.*, youtube.com, wa.me...),
  else `fbclid` (Facebook), else Shopify's own `source` word; email from utm_medium or Shopify's message
  tactics; another site by its host; no referrer on an online-store visit = Direct; no visit at all (POS,
  draft orders) = "Not recorded".
- **Tagged ads** (`paid`): utm_medium cpc/ppc/paid/paid_social/ads/display/retargeting..., a Google/TikTok/Bing
  click id, or Shopify's `AD`/`DISPLAY`/`RETARGETING` tactic. `fbclid` alone is not an ad: Facebook adds it to
  every outgoing link. Facebook/Instagram ads count as tagged only if their URL parameters say so.
- **Campaign**: `utm_campaign` (120 characters at most).
- **Money**: net sales (after discounts and returns, before tax and shipping) from the sales that happened in
  the range, the same as sales by channel; orders are the orders placed in the range. Every source together
  makes the range's net sales.
- Stored per order (`orders.traffic_source`, `traffic_medium`, `traffic_campaign`, `referrer_host`), never the
  URLs (a landing page can carry a customer's email or a cart token). Shopify's journey replaces a webhook's
  guess; a webhook only fills a gap; a journey Shopify hasn't processed yet (`ready: false`) changes nothing.
- Orders stored before this existed show as "being read": the dashboard's refresh (`autoRefresh`) re-reads
  the 60-day import window once (at most daily while any lack a source).
- It's the store's view (the last visit before buying). An ad platform credits sales by its own rules
  (view-throughs, other devices), so its numbers differ, and the two are never added together.

## Ads (Meta Ads, Google Ads)

Reference implementation: `packages/shared/src/ads.ts`. Connection and sync: `docs/ads-setup.md`.

| KPI | Formula | Notes |
| --- | --- | --- |
| Ad spend | Σ spend per campaign per day | What the platform billed; in the ad account's currency |
| Views, clicks | Σ impressions, Σ clicks | |
| Click-through rate | clicks ÷ views | |
| Cost per click, per 1,000 views | spend ÷ clicks, spend × 1000 ÷ views | |
| Purchases | Meta: the first of `omni_purchase`, `purchase`, `offsite_conversion.fb_pixel_purchase`, `onsite_web_purchase` (never their sum: they overlap). Google: `metrics.conversions` | The platform's own attribution |
| Sales value | the matching `action_values` (Meta), `metrics.conversions_value` (Google) | The platform's own attribution |
| Return on ad spend | sales value ÷ spend | |
| Cost per purchase | spend ÷ purchases | |
| Ads as share of sales | ad spend ÷ the store's net sales for the same dates | Only when both are in the same currency |

- **Days** are each ad account's own calendar days. They line up with the store's days when the time zones match.
- **Currency:** only accounts in one currency are added together. That is the store's currency when any connected account uses it, otherwise the first account's. Other accounts are listed and left out.
- **Platform attribution is never mixed into store sales.** Meta and Google can both claim one sale, and neither matches Shopify's orders exactly.
- **Freshness:** the last 3 days are refreshed hourly. The last 30 days are fetched again daily, because purchases keep being credited after the click. A first connection fetches 90 days.

## Ad earnings (Google AdSense)

Reference implementation: `adsenseTotals` and `fromAdsenseReport` in `packages/shared/src/ads.ts`.
Stored per AdSense account, site (`DOMAIN_CODE`) and day in `adsense_daily`; never in `ad_campaign_daily`.

| KPI | Formula | Notes |
| --- | --- | --- |
| Estimated earnings | Σ `ESTIMATED_EARNINGS` | AdSense finalizes a month after it ends; in the account's currency, read from the report |
| Page views, ads shown, clicks | Σ `PAGE_VIEWS`, Σ `IMPRESSIONS`, Σ `CLICKS` | |
| Earnings per 1,000 views (page RPM) | earnings × 1000 ÷ page views | |
| Earnings per click | earnings ÷ clicks | |
| Click rate | clicks ÷ ads shown | |
| Next to your sales | earnings ÷ the store's net sales for the same dates | Only when both are in the same currency |

- **Days** are the AdSense account's own calendar days (`reportingTimeZone=ACCOUNT_TIME_ZONE`).
- **Currency** is chosen as for ads: the store's when any AdSense account uses it, otherwise the first known.
- **Earnings are money in, ad spend is money out:** the two modules are separate and never summed.
- **Freshness:** as for ads (last 3 days hourly, last 30 days daily, 90 days on first connect).

## Funnel (web pixel)

Events: `page_viewed`, `product_viewed`, `product_added_to_cart`, `checkout_started`, `checkout_completed`, each with the page's pathname. Events are deduplicated by Shopify event id, then folded into one row per **visit** in `funnel_visits`: one shopper (hashed Shopify client id) on one store-local day.

Each visit records:

- **Entry**: the section and page of its earliest event. Sections are home, collection, product, search, cart, checkout, pages & blog, customer account and other (`packages/shared/src/journey.ts`).
- **Exit**: the section and page of its latest event.
- **Furthest step**: 0 visited … 4 purchased.
- **Sections seen**: a bitmask.
- **Page views**: a count.

Funnel steps count visits that reached a step *or a later one*, so the funnel never widens. For example, a quick add-to-cart from a collection page counts as having viewed a product.

An **exit** is a visit that ended without a purchase. Purchases are not exits.

Stored paths drop the query string, fragment and market prefix (`/en-au`). Product pages reached through a collection are stored as `/products/<handle>`. Checkout, thank-you, order-status, cart-permalink and account pages carry shopper tokens, so they collapse to `/checkout`, `/cart` and `/account`.

Shoppers who decline analytics consent are not tracked, so funnel numbers are behavioural trends. Today's numbers include visits still in progress, which count as exits from the page they are on. Revenue KPIs never use pixel data.

`funnel_daily` is no longer written or read. It holds whatever the pre-visit pixel recorded and can be dropped once nothing needs that history.

## Known limitations

- `read_orders` exposes 60 days of history. Longer ranges show data only from the install date onward unless `read_all_orders` is approved.
- An edit reaches the dashboard through the `orders/updated` delivery it causes (`orders/edited` isn't subscribed): its totals change, so the order's sales are read again.
- Days before the switch to Shopify's sales records keep their old totals until their orders are read again (the dashboard's refresh re-reads the 60-day import window once); older days than that keep them for good.
