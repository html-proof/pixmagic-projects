# KPI definitions

Source of truth: `packages/shared/src/kpi.ts` (reference implementation) and `recomputeDays` in `packages/core/src/persist.ts` (SQL used in production). An integration test asserts they produce identical results.

## Conventions

- **Currency:** the store's currency (Shopify `shop_money`). Presentment currencies are ignored. Money totals are rounded to cents before ratios are derived.
- **Day:** calendar day in the **store's IANA time zone** (from `shop.ianaTimezone`), not the viewer's and not UTC. Date presets (`today`, `7d`, `mtd`, …) resolve in that zone too.
- **Comparison period:** the same number of days immediately before the selected range.
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
