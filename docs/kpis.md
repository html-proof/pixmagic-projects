# KPI definitions

Source of truth: `packages/shared/src/kpi.ts` (reference implementation) and `recomputeDays` in `packages/core/src/persist.ts` (SQL used in production). An integration test asserts they produce identical results.

## Metric registry: what each figure matches

Shopify is the reference for every figure it reports itself. Each dashboard figure, the Shopify
report it reproduces, where bizinsights gets it, and how exactly it can match. "Records" means
bizinsights adds up Shopify's own sales records (below), so the figure matches Shopify's report to
the cent for the same dates, and the daily check against Shopify (section "Checked against
Shopify") proves the records held are Shopify's current ones. "Reports" means Shopify's own report
total, read with ShopifyQL, which needs `read_reports` and Level 2 protected customer data
approval; until then the card says why it has no figure, never shows 0.

| Figure | Shopify reference | Source here | Parity | Notes |
| --- | --- | --- | --- | --- |
| Gross sales | Sales report: gross sales | Records (order sales) | Exact | Edit-added items count on the edit's day, as in Shopify |
| Discounts | Sales report: discounts | Records | Exact | Line and order discounts before tax; shipping discounts sit in shipping |
| Returns (sales reversals) | Sales report: sales reversals (formerly "returns") | Records | Exact | Refunds, returns, cancellations and edit removals, on the day they happened |
| Net sales | Sales report: net sales | Records | Exact | Gross − discounts − reversals |
| Shipping charges | Sales report: shipping charges | Records | Exact | After shipping discounts and refunds |
| Duties | Sales report: duties | Records | Exact | Duty sales, before tax (their tax is in taxes) |
| Additional fees | Sales report: additional fees | Records | Exact | Fee and additional-fee sales, and any sale Shopify gives no type, before tax |
| Taxes | Sales report: taxes | Records | Exact | Gift cards and tips left out, as Shopify does |
| Total sales | Sales report: total sales | Records | Exact | Net sales + additional fees + duties + shipping + taxes |
| Custom sales | none (the store's own calculation) | Records | Its own definition | The lines of total sales the store chose; always shown beside Shopify's figures, named, never instead of them (section "Total sales breakdown and Custom sales") |
| Orders | Sales report: orders | Orders placed | Exact | On the day Shopify processed them (`processedAt`, see Conventions). Cancelled included; test, deleted and gift-card-only orders never. An order edited on a later day counts once, on its own day, in Shopify's report by day too |
| Average order value | Sales report: AOV | Records | Exact | What the orders sold on the day they were placed (their items after discounts, before tax; gift cards and what an edit on a later day added left out: "excluding post-order adjustments") ÷ orders |
| Items sold (net) | Sales report: net items sold | Records | Exact | Ordered − reversed quantities, gift cards included |
| Returning customer rate | Customers: returning customer rate | Orders placed, by when they happened | Exact | Returning customers ÷ customers, each counted once; a customer who bought only gift cards isn't one. Returning = the customer has an earlier order by processed date (see Formulas). Needs `read_customers` |
| Refunded orders, refund rate | (bizinsights) | Records | n/a | Not a Shopify report figure |
| Top products, vendors | Sales by product / vendor: net sales | Records | Exact | |
| Discount codes | Discounts report | Records | Close | An order with two codes counts for both |
| Sales channels, traffic sources | Sales by channel / by referrer | Orders + journey | Close | Shopify's last visit before the order; ads platforms attribute differently |
| Sessions, visitors, conversion rate | Analytics: sessions, online store visitors, conversion rate | Reports (ShopifyQL) | Exact once granted | Bot sessions left out by Shopify. Without `read_reports` only the pixel's **tracked visits** exist, labelled as such and never called sessions |
| Gross profit | Profit reports: gross profit | Reports (ShopifyQL) | Exact once granted | Uses the cost Shopify recorded at the time of sale, which the Admin API doesn't expose; never estimated from today's unit costs |
| Net profit | none | | Not shown | No source holds the other costs (fees, postage, apps, staff, ads) |
| Checkout started, abandoned checkouts, add to cart | Analytics: funnel | Pixel (tracked visits) | BizInsights measure | Consent-dependent; shown as tracked visits. Shopify's figures come with the sessions report |
| Payment success / failure | none in the reports | | Not shown | |
| Sales by device | Sessions by device | Reports (ShopifyQL) | Not built | The orders carry no device |
| Ad spend, ROAS | Meta / Google | Ad platforms | Their figures | Never mixed into store sales; ROAS on the platform's purchases only, each platform's own |
| Estimated earnings | AdSense | AdSense | Its estimate | Finalized by AdSense after the month ends; only the store's chosen sites |

Currency is always the store's (shop money), days the store's time zone, as in Shopify's reports.

### Matching a Shopify screen

A figure and its change match Shopify's only when both screens ask the same question. Before
reading a difference as a bug, check in this order:

1. **The dates**: the same days (both in the store's time zone).
2. **The comparison**: Shopify's second date chip shows the dates it compares with; the
   bizinsights pill beside the dates shows its own. They must be the same dates. A custom
   comparison stays chosen in Shopify: PixMagic's Shopify screen compared with 14 Mar 2026 on both
   17 and 18 Oct 2026. On 18 Oct that gave ↓25% orders (3 against 4) and ↓48% net sales (A$792.73
   against about A$1,525), while bizinsights compared with 17 Oct (6 orders, A$1,794.58: ↓50% and
   ↓55.8%). The day's own figures matched to the cent.
3. **How far back the orders go**: a comparison before `historyFrom` (Shopify shares 60 days
   without `read_all_orders`) says "No earlier data"; getting the scope is in docs/shopify-setup.md
   ("Protected customer data").
4. **The login**: Team & Access hides figures a member may not see. Without `finance.breakdown`
   there is no Total sales tile (the headline falls back to Net sales) and no gross sales,
   discounts, shipping or taxes; the figures shown are the same as an owner's.
5. **Rounding**: Shopify's screen shows changes in whole percent (bizinsights' ↓55.8% is ↓56%
   there) and money to the cent, rounded after adding up, as here.

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
- **Deleted orders** leave the dashboard as they leave Shopify's reports: `orders/delete` removes the
  order, its line items and sales records and recomputes its days, and the daily check against
  Shopify removes any whose webhook was missed. Shopify lets a merchant delete only test, imported,
  draft-converted and manually paid orders, once archived or cancelled.

## Conventions

- **Currency:** the store's currency (Shopify `shop_money`). Presentment currencies are ignored. Money totals are rounded to cents before ratios are derived.
- **Day:** calendar day in the **store's IANA time zone** (from `shop.ianaTimezone`), not the viewer's and not UTC. Date presets resolve in that zone too.
- **Date presets** (`preset=` in the overview and export query; `DATE_PRESETS` and `resolvePreset`
  in packages/shared/src/dates.ts): Today (`today`), Yesterday, Last 7 / 30 / 90 days (`7d`, `30d`,
  `90d`, each ending today), This week (`wtd`: Monday to today; weeks start on Monday, as ISO 8601
  counts them. Shopify's ShopifyQL docs don't say which day its `this_week` starts on: if a store's
  Shopify screen differs, check that first), This month (`mtd`), Last month (`lastmonth`), This year
  (`ytd`), Last year (`lastyear`), All time (`all`) and Custom (`custom&from=…&to=…`).
- **The store's first day** (`startDay` in the overview's `data` and in the store list;
  `storeStartDay`): the store-local day Shopify created the store (`Shop.createdAt` from the Admin
  API, kept in `stores.shop_created_at`, `createdDay` in `data`), or an earlier order's day: an order
  brought in from another platform keeps the day it was processed there, which can be before the
  store existed on Shopify, and is never left out. The shop sync job reads the creation date with
  the store's name, currency and time zone, on the first import; a store connected before it was
  read gets it on its next dashboard view (`autoRefresh` queues a shop job, at most daily, until it
  is known). It needs no access scope. It is not the day the store was connected or the app
  installed. Until it is known, the first day is the first order's.
- **All time** runs from the store's first day to the store's today. Nothing before it can be
  compared, so All time has no comparison: whatever `compare` asks, it is "compared" with the period
  just before (`previous.compare` says `previous`), which lies before the store existed, and every
  change is `null`; the comparison pill says "No comparison".
- **Custom ranges** may start on the store's first day at the earliest once Shopify's creation date
  is known (`400 invalid_range`, "Range starts before the store's first day", before it; the date
  boxes offer no earlier day and say why), from 2000-01-01 while it isn't (the first order alone
  isn't a limit: a quiet first month before it is still the store's), are any length, and are
  reported only up to the store's today: picking 1–31 Oct on 9 Oct reports 1–9 Oct. A range that
  starts after today is refused (`400 invalid_range`). The same limits go for custom comparison
  dates. (The SMS and ad-report endpoints keep their own one-year limit.)
- **Before the imported history:** dates that reach back before `historyFrom` (below: Shopify
  shares 60 days of orders without `read_all_orders`) are still reported, and the dashboard says
  under its heading from which day the order figures count ("Order figures count from 24 August
  2026: Shopify shared orders from then on"), so days with nothing imported never read as days
  without sales. The heading line also states the dates exactly ("Store created: 15 March 2022 ·
  Showing data: 15 March 2022 – 23 October 2026 (Australia/Melbourne)").
- **Ranges over a year** (All time, long custom dates; `DAILY_CHART_MAX_DAYS`): the API still answers
  one point per day (the series and the Sales download), and the charts add them up a month at a
  time (`rowsByMonth`; rates from the month's sums). The ad platforms' own reports (Meta, Google,
  AdSense: asked live) cover up to a year at a time, so their panels say so instead of asking. The
  dashboard checks for new figures once a minute instead of every 15 s on these ranges: each check
  adds up every order in them.
- **Comparison period:** what the % changes compare with, chosen beside the dates as in Shopify
  Analytics' second date chip (`compare` in the overview and export query; `resolvePreset` in
  packages/shared/src/dates.ts):
  - **Previous period** (the default, `compare=previous` or absent): the same number of days
    immediately before the selected range (after that clamp); last month against the whole month
    before it, whatever its length.
  - **Previous year** (`compare=year`): the same dates a year earlier. 29 February, which most years
    lack, becomes the 28th, so February 2028 is compared with 1–28 February 2027.
  - **Custom** (`compare=custom&cfrom=…&cto=…`): any dates, under the custom-range rules above (from
    the store's first day, any length, reported up to the store's today, not starting after it). They
    may have another length than the range, sit after it or overlap it. A pair that breaks a rule is
    refused with `400 invalid_range`, as a bad custom range is.
  - **This week** against the period before is against the same days of the week before (Monday to
    Thursday against last Monday to Thursday), not the days just before, which would set a weekend
    against weekdays.

  The answer's `previous` holds the dates (`from`, `to`, `until`), `compare`, and `imported`. The
  comparison pill shows those dates ("vs 17 Oct 2026"), as Shopify's comparison chip shows its own
  ("Mar 14, 2026"), and a finished day's tiles say "vs 17 Oct", not "vs the day before".
  **Like for like, as Shopify's Analytics compares:** whatever the choice, while the range is still
  running (it ends on the store's today), the comparison stops at the same time of day on its last
  day. Today until 4:44:12 pm is compared with yesterday until 4:44:12 pm (or 17 Oct last year until
  4:44:12 pm, or 14 Mar until then), and the last 7 days with the 7 before up to the same
  moment, never with whole days (that made every day look down until it was nearly over).
  `resolvePreset` returns that time as `previous.until` (store-local "HH:MM:SS", by the clock, so a
  daylight-saving change doesn't shift it). The comparison's last day is then added up from the orders
  placed and the sales made before that moment, by the same query that fills daily_store_metrics
  (`dayTotals` in packages/core/src/persist.ts), and its store visits are the ones that started before
  it. Ad platforms (Meta, Google, AdSense) report whole days, so their comparisons are whole days
  only: while the range reaches a day still running (the store's today, or an ad account's today in
  its own time zone), both the range and the comparison lose that many days at their end and the
  change says "through yesterday"; Today on its own isn't compared (see "Ads" below). Their rows are
  read for the range and for the comparison separately, wherever the comparison sits.

  **No earlier data:** when the comparison starts before the store's imported history (`historyFrom`,
  below), `previous.imported` is false: the sales figures of the comparison come back `null`, every
  sales, refund and returning-customer change is `null`, and the dashboard says "No earlier data"
  instead of a change. A period mostly missing would otherwise read as a fake drop (or a fake rise,
  or 0%). It is the same rule as the month-by-month view's "not imported" months.

  Store visits and ad figures have histories of their own, and the same rule applies to each on its
  own: the funnel and the ads and AdSense modules return their own `historyFrom` and
  `previous.imported`, and when the comparison starts before their `historyFrom` their comparison
  figures come back `null`, every change is `null`, and their panels say "No earlier data" with the
  reason. So the sales can compare while the visits or ads don't, and the other way round. A
  comparison lying entirely before a history gives no change anyway (the change on 0 is `null`); one
  that straddles its start would show a rise that never happened.

  - **Visits** count from when the web pixel was put in place (`stores.pixel_installed_at`: the
    install_pixel job that worked first, or the first events accepted when no install was recorded;
    kept when the pixel is put in place again, cleared when the store's data is purged). That day was
    only partly counted, so the funnel's `historyFrom` is the day after, unless the pixel came at
    midnight (`visitsHistoryStart` in packages/shared/src/dates.ts). A store with visits from an
    earlier day, or with no install time, starts at its first visit's day.
  - **Ad figures** start, for each ad account, at the first day of the earliest window a sync fetched
    in full (`ad_connections.history_from`, in the account's own days, kept at the earliest): the 90
    days before it was connected (`ADS_BACKFILL_DAYS`). With several accounts added up, `historyFrom`
    is the latest start among the accounts counted (`commonCoverage`): before it, one of them is in
    the dates picked and missing from the dates compared with. An account not synced yet has no
    figures at all, so nothing it is part of is given (its `historyFrom` is null and the change says
    why, see "Ads"); hidden accounts and accounts in another currency aren't counted, so their starts
    don't matter.

  **Where the imported history starts (`data.historyFrom`):** the first store-local day whose orders
  were all imported. Shopify shares the last 60 days of orders without `read_all_orders`, so each
  import that covers a window of creation dates (the first import, "Refresh data", the 60-day
  re-read) records where its window began, in `stores.orders_history_from`, keeping the earliest.
  The day the window begins on was only partly covered, so `historyFrom` is the day after (unless it
  began at midnight). With `read_all_orders` the whole history is in: the epoch is recorded and
  `historyFrom` is `1970-01-01`, so nothing counts as not imported. A store holding an order from
  before its window (imported before the window was recorded) starts at that order's day instead:
  `historyFrom` is the earlier of the window's first whole day and `oldestOrderDay`. A quiet store's
  first order can come days after its window starts; those days were imported too, with no orders, so
  they compare as $0 rather than "No earlier data". Disconnecting a store deletes its orders and
  forgets the window. Stores imported before the record existed were given 60 days before their last
  successful orders sweep (a start they surely hold), and their next window import makes it exact.
  `oldestOrderDay`/`newestOrderDay` stay the orders actually held ("Orders from … to …").
- **Daily series** (the sales chart and sparklines) has one point per day of the range; days without orders or sales are 0. Over a year the charts draw it a month at a time (above).
- **Which date each figure goes by.** Every figure is filtered on the date that answers its
  question, never one date for everything:

  | Figures | Date | Kind |
  | --- | --- | --- |
  | Orders, average order value, customers (new, returning), channels, traffic sources, order timing, discount codes, recent orders, fulfillment rates | The day Shopify processed the order (`processedAt`, below) | Order date |
  | Gross sales, discounts, net sales, shipping, duties, fees, taxes, total sales, items sold, top products and vendors | The day each sale happened (the agreement's `happenedAt`): the order's own sales on its day, a refund, return, edit or cancellation on its own day | Transaction date |
  | Returns (sales reversals), refunded orders | The day of the refund, return or cancellation | Transaction date |
  | Orders cancelled (Orders details) | The day of the cancellation (`cancelled_at`), whenever the order was placed | Transaction date |
  | Orders waiting to ship, oldest waiting | Now (a live state, labelled as such), never the dates picked | Current |
  | Stock levels and value | Now; stock changes on the Inventory pages go by when each change happened, from when bizinsights started recording them | Current / movement date |
  | Store visits (pixel) | When each visit started | Visit date |
  | Ad spend and results, AdSense earnings | The ad account's own days | Platform date |

  An order's financial status today is never taken as its status on an earlier date: a refund
  counts on the day it was made, in the sales records, so last month's figures don't change when an
  order is refunded this month. bizinsights has no payment-transaction module: payment gateways,
  fees and payouts are not imported, so no figure is shown for them.
- **An order counts on the day Shopify processed it** (`Order.processedAt`), the date its reports and
  its order list use. For an order placed in the store that is the moment it was created; an order
  imported from another platform, synced from POS offline or brought in by a marketplace app was
  processed earlier than Shopify created it, and counts then, with its sales (its own agreement
  happened at `processedAt` too). Until 2026-10-19 orders counted on their creation day, so
  imported orders all showed as orders of the day they were imported while their sales sat on the
  right days. Orders stored before then keep their creation day until read again
  (`shopify_processed_at` empty: the next re-read of the 60-day window fills it in).
- **A sale counts on the day it happened**: an order's sales on the day it was placed, a refund, return, cancellation or edit on the day it was made (the agreement's `happenedAt`), whatever day the order was placed. Last month's numbers can change only if Shopify backdates a record, which it doesn't.
- **Cancelled orders** count as orders of the day they were placed, as in Shopify's reports; the cancellation is a return on the day it was made, so a cancelled order adds nothing to net sales once both are in the range. Operational modules (order timing, shipping, discount codes, vendors) still leave cancelled orders out.
- **Prices that include tax** (GST, VAT) are taken apart as Shopify does: a sale's value is its amount less its tax.
- **Every sale keeps the sign Shopify gave it**, as Shopify's reports add them up. A return's lines are
  mostly negative, but a refund that differs from the items' value carries adjustment lines of both
  signs (+225.10 and −225.10 on one PixMagic refund), and only their sum is what it took back. Until
  2026-10-17 every return line was forced negative, which counted those pairs twice; migration
  20261017140100 re-totalled the days stored that way.
- **Missing denominators** produce `null` (shown as "—"), never a fake 0.
- Tax and shipping are excluded from net sales and included in total sales. Gift card sales and tips are in neither (Shopify counts a gift card when it is spent, not when it is sold).
- **Gift cards** are items sold (net items sold counts them, ordered and returned), but an order of
  gift cards only is not an order: Shopify's reports count neither it nor its customer, so orders,
  customers, returning customers and average order value leave it out (`orders.gift_card_only`). An
  order with a gift card and anything else counts.

## Formulas

| KPI | Formula | Plain language (shown in UI) |
| --- | --- | --- |
| Gross sales | Σ (amount − tax + discount) of the product and adjustment sales of orders placed (action `order`) | Every item sold at its listed price, before tax |
| Discounts | Σ discount before tax of those sales | |
| Returns (`refunds`) | − Σ (amount − tax) of the other product and adjustment sales: returns, cancellations, edits | What refunds, cancellations and edits took back |
| **Net sales** | Gross − Discounts − Returns | What you kept, before tax and shipping |
| Shipping charges | Σ (amount − tax) of shipping sales | After shipping discounts and refunds |
| Duties | Σ (amount − tax) of duty sales | Refunded duties take it down on the day of the refund |
| Additional fees | Σ (amount − tax) of fee, additional-fee and unknown sales | A sale Shopify gives no type is counted here, so the lines always add up to total sales |
| Taxes | Σ tax of every sale (gift cards and tips aside) | On items, shipping, duties and fees alike, counted once |
| **Total sales** | Net sales + Additional fees + Duties + Shipping + Taxes | Shopify's headline figure; the first tile |
| Custom sales | Σ of the lines of total sales the store's calculation counts | The store's own figure, never Shopify's (below) |
| Orders | count of orders placed, on the day Shopify processed them (cancelled included; test orders never stored; gift-card-only orders left out) | |
| Units (items sold) | Σ quantity sold − Σ quantity returned, gift cards included | Shopify's net items sold |
| **Average order value** | Order value ÷ Orders. Order value (`daily_store_metrics.order_value`) = Σ (amount − tax) of the product and adjustment sales (action `order`) made on the day their order was placed: gross − discounts of the day's orders, an edit made that day included, one made on a later day not (as Shopify's AOV measures) | Typical spend per order as placed, after discounts, before tax, shipping and returns. Rows from before order_value was kept fall back to (Gross − Discounts) |
| **Refund rate** | Returns ÷ (Gross − Discounts) | Share of sales later taken back |
| **Returning customer rate** | returning customers ÷ customers, each customer counted once (orders placed in the range) | Shopify's definition. Requires `read_customers`. An order is a returning customer's when the customer has an earlier order by when it happened (processed date; same moment: by order id), an order of gift cards only aside, as Shopify's report judges it (checked order by order, 878 of 878, on a seeded dev store, 2026-10-19). Orders from before the imported history count through Shopify's position of the order (`CustomerJourneySummary.customerOrderIndex`, which follows creation) being above the customer's orders stored up to it, or without one (POS, draft orders) a lifetime order count (`numberOfOrders`) above the orders stored for them. Until 2026-10-19 the position decided alone, which imported orders (created in another order than they happened) got wrong. A customer who bought for the first time and again in the same range counts as both new and returning. Until 2026-10-18 the lifetime count alone decided, so a first order turned "returning" once the customer bought again, and the rate divided orders, not customers |
| New customers | customers whose very first purchase is in the range | |
| Top products | Σ net sales and Σ net items per product (its product sales in the range), top 5 | Requires `read_products`; the products together make net sales |
| Top vendors | Σ net sales and Σ net items of each vendor's products (their product sales in the range), top 5 | Same terms as top products; used to be line-item prices, tax included |
| Discount codes | per code, the orders placed with it (cancelled included, as Shopify counts them): Σ discount before tax of their items as sold, and their net sales | Reconciles with the Discounts line: shipping discounts are in shipping; an order with two codes counts for both. Used to be the orders' `totalDiscountsSet` (tax and shipping discounts in) |
| **Conversion rate** | visits that completed checkout ÷ visits | From the web pixel: shown as "Tracked visits that bought", never as Shopify's conversion rate, which divides by Shopify's sessions |
| Funnel step | visits whose furthest step is this one or later | Steps: visited → viewed a product → added to cart → started checkout → purchased |
| Left at a step | visits whose furthest step is exactly this one | Plus the site section they were last on |
| Section exit rate | visits that left the site from this section without buying ÷ visits that saw this section | |
| Δ vs previous | (current − previous) ÷ \|previous\| | Against the comparison chosen; `null` when previous is 0 or not imported; like for like while the range runs (Conventions) |

## Total sales breakdown and Custom sales

Shopify's total sales is the sum of five lines, which its reports give one by one (ShopifyQL
`net_sales`, `additional_fees`, `duties`, `shipping_charges`, `taxes`; checked on a dev store
2026-10-19: 612,740.29 + 0 + 0 + 6,439.55 + 61,849.30 = 681,029.14 = `total_sales`):

**Total sales = Net sales + Additional fees + Duties + Shipping charges + Taxes**, and
**Net sales = Gross sales − Discounts − Returns (sales reversals)**.

bizinsights adds up each line from Shopify's sales records (`daily_store_metrics.duties` and
`additional_fees` beside `shipping` and `taxes`; `dayTotals` in packages/core/src/persist.ts,
`aggregateDaily` in packages/shared/src/kpi.ts, tested for parity), so the lines add up to total
sales to the cent, day by day. Nothing is counted twice: a sale's tax goes to taxes only (its value
to its own line), so tax on shipping or duties is never in shipping or duties; a refund of shipping,
a duty or a fee takes that line down on the day of the refund, once; discounts on items are inside
net sales and shipping discounts inside shipping charges. Days stored before the lines had columns
of their own were split from their stored sales records by migration 20261019180000; their total
sales did not change. A day whose total predates Shopify's sales records altogether (none in the
60-day window) can hold some total sales that no line explains: the breakdown shows it as "Not
split into lines", never inside a line.

**Custom sales** is the store's own calculation from those lines (`@app/shared/salesCalculation`):
which of the five it counts. Each line can be left out (product revenue only, sales without tax for
prices that include it or tax passed on, without shipping, without duties for international sales).
Built in: Shopify standard (every line), Product revenue only (net sales), Sales excluding tax,
Sales excluding shipping, Sales excluding tax and duties; a store keeps up to 10 calculations of
its own, by name (default name "Custom business revenue").

- **Never Shopify's figure.** Shopify's total sales and every other Shopify figure stay exactly as
  above whatever is chosen. Custom sales is shown beside them, named ("Custom sales · Sales
  excluding tax"), with the difference (what the lines left out add up to).
- **Only the choice is stored** (`sales_calculations`: the five switches, a name, whether the
  dashboard shows it, the saved calculations), never an amount: every figure is worked out from the
  store's sales records for the dates on screen, in cents.
- **Where it shows.** The Sales details hold the breakdown card for everyone who may see the
  breakdown (Team & Access `finance.breakdown`; switches there last until the page is left). Once
  an owner or admin saves a calculation and applies it to the dashboard (`PUT .../sales-calculation`,
  in the audit log as `sales_calculation.changed`), it also shows under the Total sales tile, as a
  view of the sales chart (the one chosen until another is picked), as what the Sales section's
  "Day by day" and "Month by month" cards measure (also until Net sales is picked; section "Sales
  breakdown" below), in the overview report's key figures and as its own column in the Sales
  download, each time named. Without `finance.breakdown` a member gets neither the lines (for the
  range, each day or each month of the year) nor the calculation.
- **Comparisons**: the lines come for the dates compared with too, so Custom sales has its own
  change on them, with the same "No earlier data" rule as every sales figure. Each month of the
  year carries its lines and those of the dates it is compared with (`comparedLines`), so a month's
  Custom sales has its own change on the month before.

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

**Custom sales.** While the store shows its Custom sales on the dashboard, both cards measure it
by default (picker beside "Show table": "Custom sales · <name>" or "Net sales"): each day's or
month's figure is the lines its calculation counts, added up in cents, and the average day or
month, the day tiers, the best day, weekday and month, the running total and the month's change all
follow it. It is named in the picker, the headline (with Shopify's net sales for the same dates
beside it), each tooltip (with that day's or month's net sales) and the table, which keeps a Net
sales column; Shopify's figures never change. Without the lines (`finance.breakdown`) the cards
measure net sales only.

**Not imported.** Days and months before the store's imported history (`historyFrom`, see Conventions: the first whole day of Shopify's 60-day window, not the first order) are drawn hatched and labelled, never as $0. Shopify shares only the last 60 days of orders without `read_all_orders`; with it nothing is "not imported". A month that is only partly imported is drawn lighter, and no change is calculated for it or against it.

## Business overview (health check)

Reference implementation: the grading rules in `packages/shared/src/health.ts` (unit-tested), applied by `businessHealth` in `apps/web/src/components/dashboard/Overview.tsx`. Each area gets one of four labels, always shown as words beside a colored dot:

| Area | Looks good | Keep an eye on | Needs attention |
| --- | --- | --- | --- |
| Net sales, orders, average order, visitors who bought, returning customers | up or level on the comparison | down by less than 10% | down by 10% or more |
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

Reference implementation: `packages/shared/src/ads.ts` (`adTotals`, `adSeries`, the coverage helpers)
and `adsFigures` in `packages/core/src/reports/ads.ts`. Connection and sync: `docs/ads-setup.md`.

| KPI | Formula | Notes |
| --- | --- | --- |
| Ad spend | Σ spend per campaign per day | What the platform billed; in the ad account's currency |
| Impressions | Σ impressions | Times an ad was shown |
| Link clicks | Σ link clicks: Meta `inline_link_clicks`, Google `metrics.clicks` | Meta's `clicks` ("clicks (all)") also count likes, comments and profile taps: stored, never used for rates. `null` ("Being re-read") while any day added up was stored before its link clicks were read |
| Click-through rate (CTR) | link clicks ÷ impressions | |
| Cost per click (CPC) | spend ÷ link clicks | |
| Cost per 1,000 impressions (CPM) | spend × 1000 ÷ impressions | |
| Purchases (platform's count) | Meta: the first of `omni_purchase`, `purchase`, `offsite_conversion.fb_pixel_purchase`, `onsite_web_purchase` (never their sum: they overlap). Google: `metrics.conversions` of the conversion actions in the Purchase category (`segments.conversion_action_category = PURCHASE`, its own query) | The platform's own attribution, never the store's orders. `null` while any day added up has none read yet |
| Purchase value | the matching `action_values` (Meta), `metrics.conversions_value` of those Purchase actions (Google) | As for purchases |
| Return on ad spend (ROAS) | purchase value ÷ spend | Per platform it is that platform's own figure ("Google Ads-reported ROAS", "Meta-reported ROAS"); across platforms their claims added up, which can overlap |
| Cost per purchase | spend ÷ purchases | |
| Conversions (all conversion actions) | Google: `metrics.conversions`, every action set to count in Conversions (leads, sign-ups, calls and purchases) | Shown on the Google Ads card and the Ads panel only, never called or added up as purchases. Meta's conversions are its purchases |
| Cost per conversion | spend ÷ conversions | |
| Ads as share of sales | ad spend ÷ the store's net sales for the same dates | Only when both are in the same currency and every day of the ad spend is known |
| Sales per unit of ad spend (MER) | the store's net sales ÷ ad spend (every platform), for the same dates | The marketing efficiency ratio: every sale the store made, whatever brought it, against everything spent on ads. The store's own measure, kept apart from a platform's ROAS (which counts only the purchases the platform credits to itself). Same conditions as the share of sales; `null` while nothing was spent. Its change, and the cost per order's, only when the dates picked have ended (both sides whole ranges), since the store's figures are for the whole of each |
| Cost per Shopify order | ad spend ÷ the store's orders for the same dates (gift-card-only orders aside, as Shopify counts) | A derived cost, labelled as such: every order, not what an order from an ad cost. `null` without orders |
| Orders from a platform's ads (Shopify's visit record) | orders whose last visit before the order (Shopify's `customerJourneySummary.lastVisit`, see Traffic sources) came from Facebook or Instagram (Meta) or Google or YouTube (Google Ads) through a link tagged as an ad (`traffic_medium` paid), and their net sales | The store's attribution, shown beside the platform's own purchases and never added to them: a platform can claim a sale that would have happened anyway, Shopify sees only the last visit. Orders on the day they happened in the store's zone; the platforms count purchases on the day of the click in the ad account's zone. Sales from those orders ÷ that platform's spend is given too ("sales per unit, Shopify's record"), same currency only. Team & Access "View conversion attribution" |

- **Only days the accounts have stored.** Each counted account covers the days from where its history
  starts (`ad_connections.history_from`) to the last day stored without a gap (`synced_through`, both
  in the account's own days); never synced: nothing (`accountCoverage`). A closed account
  (`account_closed`) covers on to its today, since it spends nothing after it closed. A figure is given
  only when every account it adds up covers every day it needs: otherwise `current` is `null` (the
  card says "Unavailable", which account lacks which days and why, from its status and `errorCode`),
  `partial` gives the part of the range they all cover and its totals, and the daily series has
  `null` (drawn as "No data", never as 0) on the days not covered. A failing, ended or never-synced
  account, or a day that hasn't started yet in the account's time zone, is never counted as $0.
- **Up to a date, while only days not over yet are missing.** When `partial` starts on the range's
  first day and reaches the last day that is over everywhere (`lastWholeAdDay`), and every account
  that stops short still syncs (status `active`, or closed), the only days missing are still running
  or not begun: an account's today before its next sync, or (an account in a zone behind the store's)
  a store day it hasn't reached. `soFar` then holds that part, and the page shows it as the figure,
  dated "up to 18 Oct", with why the rest isn't in yet. `current` stays `null`, and so do "ads as share
  of sales" and the series' missing days. A gap after a failure, a sync more than a day behind, or a
  history that starts inside the range stays "Unavailable".
- **Per platform.** `byProvider` works the same out for each platform's counted accounts on their own,
  with the totals flat on the entry (all `null` when that platform's accounts don't cover the range),
  so one platform's gap never hides another's figures. Each entry, and the module, says when its
  least recently updated account last synced (`updatedAt`), shown as "updated 12 minutes ago".
- **Total ad spend** is a card of its own only when two platforms or more are counted (they are then
  in one currency).
- **Changes compare whole days only.** `compared` holds the days each side is worked out on and their
  totals: while the range reaches a day still running (the store's today, or a counted account's today
  in its own zone; `lastWholeAdDay`), both sides lose that many days at their end (`trimmed`), and the
  change says "through yesterday" (`adComparisonWindows`). Today alone (or yesterday while an account's
  day is still running) has no change: `notCompared` is `running` and the page says "today so far". The
  `previous` figures and dates are those compared, so what is shown as before is what was compared.
  `notCompared` is also `no_history` (the comparison starts before `historyFrom`: "No earlier data")
  or `incomplete` (a counted account lacks days of either side). Each platform is compared from its
  own history, so the comparison's days are read whenever any counted platform's figures reach back to
  them (`daysToRead`); when they aren't read, nothing is compared (`no_history`), never set against $0.
- **Days** are each ad account's own calendar days. When an account's time zone has other days than
  the store's (`otherTimeZone`, `sameDays`: not the name, the local date and time now and half a year
  either side), its card says "Google Ads days follow the ad account's time zone, America/Los_Angeles",
  and a store day the account hasn't reached yet is missing, not 0.
- **Currency:** only accounts in one currency are added together. That is the store's currency when any connected account uses it, otherwise the first account's. Other accounts are listed and left out, whatever state they're in.
- **Platform attribution is never mixed into store sales.** Meta and Google can both claim one sale, and neither matches Shopify's orders exactly.
- **Freshness:** the last 3 days are refreshed hourly. The last 30 days are fetched again daily, because purchases keep being credited after the click. A first connection fetches 90 days. An account whose stored history falls short of those 90 days (its first sync failed and a later one worked, or it was connected before `history_from` was recorded) gets the whole 90 days in its daily re-check instead, until they are in (`recheckDays` in packages/core/src/adConnections/sync.ts).
- **No earlier data:** comparisons go back only to where every counted account's figures start (see Conventions).

## Ad earnings (Google AdSense)

Reference implementation: `adsenseTotals` and `fromAdsenseReport` in `packages/shared/src/ads.ts`, and
`adsenseFigures` in `packages/core/src/reports/ads.ts`. Stored per AdSense account, site (`DOMAIN_CODE`)
and day in `adsense_daily`; never in `ad_campaign_daily`.

| KPI | Formula | Notes |
| --- | --- | --- |
| Estimated earnings | Σ `ESTIMATED_EARNINGS` | AdSense's estimate: accurate up to yesterday, finalized after the month ends, not money paid out; in the account's currency, read from the report |
| Page views | Σ `PAGE_VIEWS` | |
| Impressions | Σ `IMPRESSIONS` | AdSense counts one for each ad request where at least one ad was delivered, not one per ad shown (that is `INDIVIDUAL_AD_IMPRESSIONS`, not read) |
| Clicks | Σ `CLICKS` | |
| Page RPM | estimated earnings × 1000 ÷ page views | |
| Impression RPM | estimated earnings × 1000 ÷ impressions | |
| Earnings per click | estimated earnings ÷ clicks | |
| Click-through rate (CTR) | clicks ÷ impressions | AdSense's impression CTR |
| Next to your sales | estimated earnings ÷ the store's net sales for the same dates | Only when both are in the same currency and every day is known |

- **The store's sites only.** Each connection's `sites` (DOMAIN_CODE values chosen in Settings; none
  chosen: every site) say which sites' earnings belong to the store (`adsenseSiteChosen`). Rows of other
  sites on the same AdSense account count nowhere, "next to your sales" included, and are listed as
  left out (`sitesLeftOut`).
- **Days AdSense didn't split by site.** When AdSense won't split an account's report by site, its
  days are stored as one row with site "" (every site together). With no sites chosen they count as
  the store's. With sites chosen, the store's share of them isn't known: they are neither counted nor
  listed as left out, and the account's figures start after the last such day read
  (`unsplitThrough`, `coverageAfter`), so those days are "Unavailable", never $0.
- **Only days the account has stored**, as for ads: a day AdSense wasn't read for (before its history,
  after its last sync that worked) is missing, never $0, and the totals for a range that needs it are
  `null` with `partial` giving what is known (or `soFar`, as for ads, while only days not over yet are
  missing).
- **Changes** compare whole days only, as for ads.
- **Days** are the AdSense account's own calendar days (`reportingTimeZone=ACCOUNT_TIME_ZONE`).
- **Currency** is chosen as for ads: the store's when any AdSense account uses it, otherwise the first known.
- **Earnings are money in, ad spend is money out:** the two modules are separate and never summed.
  Estimated earnings are what AdSense expects to pay, never presented as money paid out.
- **Freshness:** as for ads (last 3 days hourly, last 30 days daily, 90 days on first connect).
- **No earlier data:** as for ads, from where every counted AdSense account's figures start.
- **By country, by device type:** asked of AdSense for the dates picked (GET `.../ads/adsense/report`,
  `level=country|platform`), limited to the connection's chosen sites like every other AdSense figure
  here (every site when none are chosen; the answer's `sites` says which), shown to members who may see
  the other live reports.

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

Visits are compared only from the first whole day after the pixel was put in place (`historyFrom`, see Conventions: "No earlier data").

`funnel_daily` is no longer written or read. It holds whatever the pre-visit pixel recorded and can be dropped once nothing needs that history.

## Shopify's own reports (sessions, gross profit, the check)

Some figures only Shopify's reports can give exactly, so bizinsights asks them (ShopifyQL,
`packages/core/src/shopifyReports.ts`; needs `read_reports` and Shopify's Level 2 protected
customer data approval, docs/shopify-setup.md) instead of estimating:

| Figure | ShopifyQL | Notes |
| --- | --- | --- |
| Sessions | `FROM sessions SHOW sessions`, human sessions only | Shopify ends a session after 30 minutes idle; bot sessions are left out (`human_or_bot_session = 'human'`, Shopify's own classification) |
| Visitors | `online_store_visitors` | Unique over the whole range: asked for the range whole, never summed from days |
| Conversion rate | `sessions_that_completed_checkout ÷ sessions` | Shopify's formula; the funnel steps (`sessions_with_cart_additions`, `sessions_that_reached_checkout`) and `pageviews` are shown too |
| Gross profit | `FROM sales SHOW gross_profit` | Net sales − cost of goods sold, from the cost Shopify recorded with each sale. Sales with no cost recorded count at no cost in Shopify's figure, so the card shows how much (`net_sales_without_cost_recorded`) and the margin on the sales whose cost is known. Not net profit: bizinsights knows none of the other costs |
| The check | `FROM sales SHOW gross_sales, discounts, sales_reversals, net_sales, shipping_charges, duties, additional_fees, taxes, total_sales, orders` | Our figures for exactly the same window, line by line, to the cent: both add up Shopify's sales records. Shopify's sign for discounts and reversals is read off its own identity (net = gross − discounts − reversals) |

- **Windows**: the dashboard's range and its comparison, in the store's time zone. While the range
  runs both stop at the last 5-minute mark (today up to 4:40 pm against yesterday up to 4:40 pm),
  so one answer serves every poll until the next mark.
- **Kept, not waited for**: answers are kept per store, dataset and window (`shopify_reports`); the
  dashboard asks the worker for missing or stale ones and fills in on a later poll. Stale: running
  windows after 10 minutes, the last two days after 30, older ones after 6 hours; a failed call
  after 10 minutes (the last figures stay shown), a refusal after 6 hours. Kept 14 days.
- **No figures, no numbers**: when Shopify refuses (no access, a report this plan can't run) or
  hasn't answered yet, the card says so. A comparison before bizinsights' imported history is
  still compared: Shopify's reports have the whole history.
- **The check's states**: match; differs; catching up (changes from Shopify are still being
  counted here, or our data is older than Shopify's answer); not reported.
- **Reconciliation report**: the same check for today, yesterday, the last 7/30/90 days, this month
  and last month at once, with Shopify's sessions against the pixel's tracked visits
  (`definition_mismatch`) and its gross profit (`shopifyCheckReport`, docs/RUNBOOK.md).

## Checked against Shopify

Every day, about 15 minutes after the daily re-pull, each connected store's last 7 finished days
are read back from Shopify and compared with what the dashboard holds (`startReconciliation` in
packages/core/src/reconcile.ts, the `verify` job in apps/worker/src/verify.ts). A first import is
checked the same way over its whole window once it is in. Owners and admins can check now from
"About this data" (`POST .../check`, 4 an hour); operators with the cron action `verify`
(docs/RUNBOOK.md).

- **What it reads**: every order Shopify changed since the window began (placing, refunding,
  returning, cancelling and editing an order all change it), whole, with its sales records: the
  query the import uses. Each order's share of the window (orders placed, gross sales, discounts,
  returns, net sales, shipping, taxes, total sales, items) is added up with the reference formulas
  (`aggregateDaily`) into Shopify's totals, and compared with the share of the copy stored here.
- **Why an order differs** (`findings`): missing (never arrived), outdated (Shopify changed it later,
  its webhook lost), its sales differ (same version, different records), a test order stored,
  deleted in Shopify (stored, not listed, and Shopify says it is gone), changed while the check ran
  (a sync delay, not an error), not listed (Shopify no longer shares it: created more than 60 days
  ago without `read_all_orders`, which to the API looks exactly like a deleted order, so it is never
  looked up or removed). Days whose stored totals had drifted from their own orders are found too
  (`stale_day`).
- **Set aside**: an order Shopify no longer shares can still have a share of the window (an edit,
  refund or return inside it), and Shopify's side can't hold it. So its stored share (its sales
  records in the window, `setAside`) is added up per day and taken off our totals before they are
  compared: a figure that then agrees is a `match`, and the check can be `verified`; one that still
  differs is judged as any other. The dashboard keeps its full figure; the check records how much it
  left out (`actions.setAside` on the check: how many orders and their share of each figure), and
  says so ("excluding A$37.00 of sales from 1 order Shopify no longer shares"). A stored order that
  Shopify does still have but didn't list is not set aside: the figures that differ are then not
  verifiable.
- **Repair**: any order that differs is written again from Shopify's copy (the upsert a webhook
  does), deleted and test orders are removed, and every day of the window is recomputed. Nothing
  else is ever deleted to make a figure match. `dryRun` only records.
- **Kept** (`reconciliations`, `reconciliation_results`, 90 days): per figure, Shopify's total, ours
  before and after the repair, its status (`match`, `repaired`, `difference`, `sync_delay`,
  `not_verifiable`) and the main cause; per check, the findings with a few order ids, what was set
  aside, and the days that still differ once it is left out. A difference nothing explains raises
  the `reconciliation_mismatch` alert, which the next check that matches resolves.
- **On the dashboard**: a pill beside the store's status ("Matches Shopify", "Mostly matches
  Shopify", "Differs from Shopify", "Checking with Shopify…") with the dates and time of the check
  and how many orders were set aside, and under "About this data" what it found; the figures side by
  side for members with the sales breakdown permission (`GET .../check`: per figure `setAside`, the
  part of ours left out, and `setAside` on the check), with an "Excluded" column when any was.
- **What it proves, and what it doesn't**: that every order and sales record held for those days is
  Shopify's current one, and that the day totals add them up. It can't prove the formulas are
  Shopify's report definitions: that is the report check (section above, ShopifyQL), kept apart as
  its own source. Today is left out until it is over; it is checked the next day.

## How current the numbers are

The pill beside the store's status says when the numbers last matched Shopify (`freshness` in the
overview, `dataFreshness` in packages/core/src/reports/overview.ts), not whether the page is polling:

- **Updated …**: the later of the last finished order import or re-read and the last order
  notification processed. Green while that is within 15 minutes.
- **Catching up**: order notifications received more than 5 minutes ago are still waiting to be
  counted, so the numbers are behind Shopify's by about that much.
- **Some updates failed**: order notifications failed for good in the last 24 hours; the nightly
  reconcile reads those orders again.
- **Reconnecting…**: the page itself can't reach bizinsights, so it shows its last answer.

Shopify's own reports can take a few minutes to include a new order too, so the two can differ
briefly in either direction.

## Known limitations

- A refund today on an order older than Shopify's 60 days (without `read_all_orders`) is in Shopify's
  reports and can't be read here: neither the order nor the refund is visible to the app.

- `read_orders` exposes 60 days of history. Longer ranges show data only from 60 days before the first import onward unless `read_all_orders` is approved.
- An edit reaches the dashboard through the `orders/updated` delivery it causes (`orders/edited` isn't subscribed): its totals change, so the order's sales are read again.
- Days before the switch to Shopify's sales records keep their old totals until their orders are read again (the dashboard's refresh re-reads the 60-day import window once); older days than that keep them for good.
