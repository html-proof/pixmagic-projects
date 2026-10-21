# Product sales rankings

The former `topProducts` query in `packages/core/src/reports/sales.ts` returned only five products (`LIMIT 5`), sorted revenue before units, excluded nonpositive revenue (`HAVING SUM(...) > 0`), and grouped every null product ID together. There was no product comparison period, momentum score, or product table pagination. These are confirmed code defects; no claim is made that every production discrepancy had the same cause.

## Data and definitions

`reports/products.ts` uses the existing Shopify sales ledger, not product catalog order or synthetic sales. The existing Admin GraphQL import reads Order agreements and ProductSale records, fully paginates orders, line items and sales, uses shopMoney, excludes test orders, and upserts stable sale IDs. Webhook signature validation, idempotent queue processing, retry handling, scheduled reconciliation and 15-second dashboard polling remain in place. No database migration or backfill is introduced. DynamoDB coordinates this application; it does not use Redis.

All queries bind workspace and store IDs. The endpoint checks membership, `products.performance`, store ownership and order/product scopes. Product and collection filters apply before ranking; search applies to product title, stable ID and variant SKUs. All matching sales are aggregated before the top 100 cap. Variants are combined by stable parent product ID, with a separate breakdown. When Shopify no longer provides an ID, stable variant/line IDs keep unrelated historical items separate; an unknown parent cannot be reconstructed safely. Catalog names/images are preferred, with historical line titles retained as fallback.

- Net units = absolute ORDER quantities minus absolute RETURN quantities; UPDATE quantities do not add units.
- Gross units = ORDER quantities; returned units = RETURN quantities, irrespective of inventory restocking.
- Net revenue = sum(totalAmount.shopMoney - totalTaxAmount.shopMoney).
- Gross sales = ORDER value before tax + totalDiscountAmountBeforeTaxes.shopMoney.
- Discounts = allocated before-tax discounts on ORDER sales.
- Returns and adjustments = negative sum of non-ORDER product sale values. They can be negative when an edit increases sales.
- Net revenue = gross sales - discounts - returns and adjustments.
- Orders = distinct orders with an ORDER product sale in the selected period. A cancelled order still counts as an order; its reversal removes units and revenue.
- Last sold = latest ORDER product sale in the selected period. All financial events use their store-local event day. A refund today of an older order counts today.
- Money is shop currency, excluding shipping, tax, gift cards and unattributed order adjustments. These definitions can differ from a storewide total or a report including gift cards.

A selected period without recorded complete history, an active import status, verified sales, or a line-item mapping returns no ranked rows and an explicit incomplete state. Unavailable comparison history produces null growth and score, never a fake percentage. Missing `read_all_orders` is not automatically requested; Shopify's normal 60-day window is reflected by recorded import coverage. Previous-only variants remain in the baseline.

## Ranking and momentum

The default is descending net units, then descending net revenue, then stable key. Revenue, Trending, Fastest Growing, Most Returned (returned units), and Lowest Performing modes rank the entire eligible population before taking 100. Lowest Performing additionally includes real catalog products with zero sales. Descending/ascending order and server pagination are supported. Products without comparable growth sort after known growth in both directions. Growth ranking requires five current net units.

The comparison is the immediately preceding equal number of calendar days, independently of a dashboard year/custom comparison. A running final day compares with the same elapsed local time on the previous period's final day, including DST conversion. Growth = (current net units - previous net units) / previous net units * 100. Zero baseline is New; negative or unavailable baseline is No baseline.

The exported, testable weights are: current units 30%, unit momentum 20%, revenue momentum 15%, distinct orders 15%, recent velocity 10%, consistency 10%. Units, orders and recent three-day net units are divided by their positive population maxima; momentum = min(1, max(0, current - previous) / max(1, abs(current), abs(previous))); consistency = active sale days / reporting days, capped at one. The weighted sum is multiplied by 100. Fewer than five current net units score zero; unavailable baseline scores null. Scoring and actual money/units stay separate. Scores normalize over the active search/filter population.

## API and UI

`GET /workspaces/:ws/stores/:storeId/analytics/products/top-selling`

Accepts dateFrom/dateTo, existing date presets/custom dates, sortBy (units/revenue/trending/growth/returned/lowest), direction, limit (1-100), page, search, productId and collectionId. Invalid inputs are rejected. Responses include coverage, comparison window, last synchronization, and trend weights. The overview uses the same service with default ranking.

The table offers 10/25/50/100 rows, sticky headers, product/SKU/ID search, sortable metric columns, six ranking modes, product/variant details, CSV export, accessible textual trends, loading and permission/error states. CSV values are quoted and text that could execute as a spreadsheet formula is neutralized. Responses are matched to their request path so changing filters cannot show a previous period's figures. Existing dashboard date controls cover Today, Yesterday, 7/30/90 days and custom dates.

## Verification and operations

Unit tests cover default ordering, tie breakers, all sorting modes, the top-100 cap, pagination, zero baseline, unavailable history and trend minimums. Integration tests cover multiple variants/orders, distinct counts, previous-only variants, renamed/deleted products, missing product IDs, cancellations, partial refund event dates, negative-return rows, incomplete imports, tenant boundaries, invalid inputs, more than 100 products and more than 10,000 orders. Existing worker tests exercise webhook duplicates, pagination, financial normalization and reconciliation.

A read-only cron Lambda action `{ "action": "product-check" }` compares all active stores (or a named shop) with ShopifyQL product reports over the last seven finished store-local days. Optional dateFrom/dateTo select an explicit period. The report compares net items sold, net sales and ranking, reports differences without repairs, and marks missing permissions/history/columns as not verifiable. No new scopes are requested. A comparison against Shopify's live data is required before claiming production accuracy.

References: https://shopify.dev/docs/api/admin-graphql/latest/objects/ProductSale and https://shopify.dev/docs/api/shopifyql/2026-07/schemas/sales_revenue/sales
