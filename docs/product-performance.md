# Product sales rankings

The former `topProducts` query in `packages/core/src/reports/sales.ts` returned only five products (`LIMIT 5`), sorted revenue before units, excluded nonpositive revenue (`HAVING SUM(...) > 0`), and grouped every null product ID together. There was no product comparison period, momentum score, or product table pagination. Order refreshes also replaced line items wholesale, erasing previously known product/variant IDs when Shopify returned null after deletion. These are confirmed code defects; no claim is made that every production discrepancy had the same cause.

## Data and definitions

`reports/products.ts` uses the existing Shopify sales ledger, not product catalog order or synthetic sales. The existing Admin GraphQL import reads Order agreements and ProductSale records, fully paginates orders, line items and sales, uses shopMoney, excludes test orders, and upserts stable sale IDs. Webhook signature validation, idempotent queue processing, retry handling, scheduled reconciliation and 15-second dashboard polling remain in place. No database migration or backfill is introduced. DynamoDB coordinates this application; it does not use Redis.

All queries bind workspace and store IDs. The endpoint checks membership, `products.performance`, store ownership and order/product scopes. Product and collection filters apply before ranking; search applies to product title, stable ID and variant SKUs. All matching sales are aggregated before the top 100 cap. Bounded unique-key lookups keep fresh large imports from using a quadratic join plan before tenant statistics are collected; the 20-second transaction limit is unchanged. Variants are combined by stable parent product ID, with a separate breakdown. Single-order and bulk writes now retain previously known product/variant IDs, SKUs and titles when a refresh no longer provides them, under the existing order locks. Explicit non-null corrections still replace old values. If a parent product ID was already lost before this fix, rankings are withheld rather than guessing a grouping; historical records are needed to repair those identities. Catalog names/images are preferred, with historical line titles retained as fallback.

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

A selected period without recorded complete history, an active import status, verified sales, or a line-item/product identity mapping returns no ranked rows and an explicit incomplete state. Unavailable comparison history produces null growth and score, never a fake percentage. Missing `read_all_orders` is not automatically requested; Shopify's normal 60-day window is reflected by recorded import coverage. Previous-only variants remain in the baseline.

## Ranking and momentum

The default is descending net units, then descending net revenue, then stable key. Revenue, Trending, Fastest Growing, Most Returned (returned units), and Lowest Performing modes rank the entire eligible population before taking 100. Lowest Performing additionally includes real catalog products with zero sales. Descending/ascending order and server pagination are supported. Products without comparable growth sort after known growth in both directions. Growth ranking requires five current net units.

The comparison is the immediately preceding equal number of calendar days. A running final day compares with the same elapsed local time on the previous period's final day, including DST conversion. Growth = (current net units - previous net units) / previous net units * 100. Zero baseline is New; negative or unavailable baseline is No baseline.

The exported, testable weights are: current units 30%, unit momentum 20%, revenue momentum 15%, distinct orders 15%, recent velocity 10%, consistency 10%. Units, orders and recent three-day net units are divided by their positive population maxima; momentum = min(1, max(0, current - previous) / max(1, abs(current), abs(previous))); consistency = active sale days / reporting days, capped at one. The weighted sum is multiplied by 100. Fewer than five current net units score zero; unavailable baseline scores null. Scoring and actual money/units stay separate. Scores normalize over the active search/filter population.

## API and UI

`GET /workspaces/:ws/stores/:storeId/analytics/products/top-selling`

Accepts dateFrom/dateTo, existing date presets/custom dates, sortBy (units/revenue/trending/growth/returned/lowest), direction, limit (1-100), page, search, productId and collectionId. Invalid inputs are rejected. Responses include coverage, comparison window, last synchronization, and trend weights. The overview uses the same service with default ranking.

The table offers 10/25/50/100 rows, sticky headers, product/SKU/ID search, sortable metric columns, four ranking modes (top selling by units, highest revenue, most returned, lowest performing), product/variant details, CSV export, loading and permission/error states. The API's `trending` and `growth` sorts, and each product's growth and trend score, are in the answers only: the table, its menu, the details and the CSV don't show them. CSV values are quoted and text that could execute as a spreadsheet formula is neutralized. Responses are matched to their request path so changing filters cannot show a previous period's figures. Existing dashboard date controls cover Today, Yesterday, 7/30/90 days and custom dates.

## Sales by collection

The products page has a "Sales by collection" panel (`d-collection-sales`) under Top products: each Shopify collection's product sales for the dashboard's dates. The answer also carries each collection's sales in the period before the dates (`previous`, `deltas`; a running day stops at the same time of day), which the panel and its CSV don't show. `reports/collections.ts` reads the same `order_sales` ledger with the same definitions as Top products above: net sales = sum of product sale values before tax, after discounts and returns; gross sales, discounts and returns and adjustments as above; net units = ORDER quantities less RETURN quantities; returns, cancellations and edits on their own store-local day. Orders = distinct orders with an ORDER sale of a product in the collection, so one order with two of its products counts once. Products sold = distinct products with an ORDER sale. Money is shop currency.

- Membership is the collections each product is in now (`products.collections`, `[{id, title}]` as the catalog read last found it), not when it sold, as Shopify's reports group sales by `product_collections`. Moving a product to another collection moves its past sales with it. The panel says when the catalog was last read (`membershipAsOf`: the last finished `products` sync).
- A product in several collections counts in each. Collections therefore add up to more than the store's product sales, and their shares to more than 100%. There is no row adding the collections up; the line under the table gives every product sale once (`totals`), which the shares are of.
- Sales of products in no collection are their own row, "Not in a collection". Sales of products whose collections aren't known (`products.collections` NULL: added since the last catalog read and not yet read, or no longer in the catalog) are a separate row, "Collections not known", never put in a collection or said to be in none.
- The panel shows nothing until the dates' product sales are all imported, verified and tied to their products: the same check as Top products (`productSalesCoverage` in `reports/products.ts`). The answer's changes need the period before to pass it too and to be imported (`comparisonImported`); otherwise they are null, never a made-up percentage.
- At most 500 collections are listed, best-selling first (then by title); the answer's `total` says how many sold, and the panel says when some are left out. A collection that sold only in the period before is listed with 0.
- Clicking a collection narrows Top products to its products (`collectionId`), which also has a Collection list; CSV export follows `reports.export` with the same formula neutralisation.

`GET /workspaces/:ws/stores/:storeId/analytics/collections/sales` takes the dashboard's date question (`preset`, `from`/`to`). The page asks as the dashboard was asked (the overview's `preset`: the same preset, or the same custom dates), so both sides are the dashboard's own days; the store's first day isn't enforced on them (a preset's dates may start before it), and days before it simply have no sales. It needs "View product performance" and orders and products access, like top-selling, and answers 404 for another workspace's store before reading the question.

How membership is kept:

- The products page query reads a product's first 10 collections with their `pageInfo` (903 points a page of 50). A product in more has the rest read with `PRODUCT_COLLECTIONS_QUERY` (250 a page, 254 points), up to 1,000 more; past that the rest are left out and a warning names the product. Before, a product's 11th and later collections were dropped silently.
- Collections Shopify withholds or that don't read as a list keep the stored ones. They used to overwrite them with an empty list, which made a product look as if it was in no collection.
- `products/create` reads the new product's collections once, so what it sells before the next catalog read counts in its collections. If that read fails, the product is stored and its collections wait for the catalog read. `products/update` reads none: Shopify sends it for every order of the product.
- Otherwise membership is refreshed by the daily catalog read and "Refresh data", so it can be up to a day behind. No `collections/*` webhook is subscribed. Shopify's `collections/update` wouldn't cover a product moved by an automated collection's rules either.

## Verification and operations

Unit tests cover default ordering, tie breakers, all sorting modes, the top-100 cap, pagination, zero baseline, unavailable history and trend minimums. Integration tests cover multiple variants/orders, distinct counts, previous-only variants, renamed/deleted products, missing product IDs, cancellations, partial refund event dates, negative-return rows, incomplete imports, tenant boundaries, invalid inputs, more than 100 products and more than 10,000 orders. `apps/api/test/collectionSales.test.ts` covers sales by collection: overlap, distinct orders per collection, products in none and of unknown membership, refunds on their own day, the comparison (adjacent, a year earlier before the imported history, a running day), incomplete imports, more than 10,000 orders, permissions, another workspace's store, and top products narrowed to a collection. Existing worker tests exercise webhook duplicates, pagination, financial normalization and reconciliation.

A read-only cron Lambda action `{ "action": "product-check" }` compares all active stores (or a named shop) with ShopifyQL product reports over the last seven finished store-local days. Optional dateFrom/dateTo select an explicit period. The report compares net items sold, net sales and ranking, reports differences without repairs, and marks missing permissions/history/columns as not verifiable. No new scopes are requested. A comparison against Shopify's live data is required before claiming production accuracy.

References: https://shopify.dev/docs/api/admin-graphql/latest/objects/ProductSale and https://shopify.dev/docs/api/shopifyql/2026-07/schemas/sales_revenue/sales
