# KPI definitions

Source of truth: `packages/shared/src/kpi.ts` (reference implementation) and `recomputeDays` in `packages/core/src/persist.ts` (SQL used in production). An integration test asserts they produce identical results.

## Conventions

- **Currency:** the store's currency (Shopify `shop_money`). Presentment currencies are ignored. Money totals are rounded to cents before ratios are derived.
- **Day:** calendar day in the **store's IANA time zone** (from `shop.ianaTimezone`), not the viewer's and not UTC. Date presets (`today`, `7d`, `mtd`, …) resolve in that zone too.
- **Custom ranges** run from 2000-01-01 at the earliest, cover at most 366 days, and are reported only up to the store's today: picking 1–31 Oct on 9 Oct reports 1–9 Oct. A range that starts after today is refused (`400 invalid_range`).
- **Comparison period:** the same number of days immediately before the selected range (after that clamp).
- **Daily series** (the net sales chart and sparklines) has one point per day of the range; days without orders or refunds are 0.
- **Cancelled orders** are excluded entirely.
- **Refunds** are booked on the day the refund was **created**, not the day of the original order. Last month's numbers can change only if a refund is backdated, which Shopify doesn't allow.
- **Missing denominators** produce `null` (shown as "—"), never a fake 0.
- Tax and shipping are excluded from sales figures.

## Formulas

| KPI | Formula | Plain language (shown in UI) |
| --- | --- | --- |
| Gross sales | Σ line `price × quantity` | Full price of items sold |
| Discounts | Σ line discount allocations | |
| Refunds | Σ refunded line subtotals, by refund date | Money returned to customers |
| **Net sales** | Gross − Discounts − Refunds | What you kept, before tax and shipping |
| Orders | count of non-cancelled orders | |
| Units | Σ quantity | |
| **Average order value** | (Gross − Discounts) ÷ Orders | Typical spend per order, after discounts |
| **Refund rate** | Refunds ÷ (Gross − Discounts) | Share of sales later refunded |
| **Returning customer rate** | orders from returning customers ÷ orders with a customer | Requires `read_customers`. A customer is "returning" if Shopify reports more than one order for them, or we have an earlier order from them |
| Top products | Σ (price × qty − discount) per product, top 5 | Requires `read_products` |
| **Conversion rate** | visits that completed checkout ÷ visits | From the web pixel |
| Funnel step | visits whose furthest step is this one or later | Steps: visited → viewed a product → added to cart → started checkout → purchased |
| Left at a step | visits whose furthest step is exactly this one | Plus the site section they were last on |
| Section exit rate | visits that left the site from this section without buying ÷ visits that saw this section | |
| Δ vs previous | (current − previous) ÷ \|previous\| | `null` when previous is 0 |

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

Reference implementation: `businessHealth` in `apps/web/src/components/dashboard/overview.tsx`. Each area gets one of four labels, always shown as words beside a colored dot:

| Area | Looks good | Keep an eye on | Needs attention |
| --- | --- | --- | --- |
| Net sales, orders, average order, visitors who bought, returning customers | up or level on the period before | down by less than 10% | down by 10% or more |
| Refunds | up to 5% of sales | over 5% and up to 10% | over 10% |
| Stock | nothing sold out or low | something running low | something sold out |
| Shipping | nothing waiting | orders waiting, none over 3 days | an order waiting over 3 days |

Best seller, top channel and busiest time are information only. With nothing earlier to compare with, an area is information only too. When the only day picked is today, trends aren't graded, because the day isn't over.

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
- `orders/edited` is not re-fetched immediately; the daily reconcile picks up edits.
