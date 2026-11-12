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
| Total refunded | (bizinsights; Shopify's order page "Refunded", added up) | Records | n/a | What refunds, returns and cancellations took off total sales, tax and shipping in; shown under the Total sales tile, which is already after it |
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
| Your costs | none (the owner's own figures) | Settings → Costs | Their own definition | Shopify plan, apps, staff, rent, shipping labels, fees...: each spread over the days it covers; never checked against anything |
| Net profit | none | Profit report + ad platforms + your costs | Shown only when complete | Revenue − cost of goods − ad spend − your costs, and only for dates the owner marked the costs list complete for ("Costs and net profit") |
| Checkout started, left at checkout, add to cart | Analytics: funnel | Pixel (tracked visits) | BizInsights measure | Consent-dependent; shown as tracked visits on the Shopping Funnel page (section "Shopping Funnel page"). Shopify's figures come with the sessions report |
| Abandoned checkouts, recovered, their value | Orders → Abandoned checkouts | Shopify's checkout list (Admin API, `read_orders`) | Exact counts; value up to 2,000 a window | Last 60 days only; section "Abandoned checkouts (Shopify)" |
| Payment success / failure | none in the reports | | Not shown | |
| Sales by device | Sessions by device | Reports (ShopifyQL) | Not built | The orders carry no device |
| Ad spend, ROAS | Meta / Google | Ad platforms | Their figures | Never mixed into store sales; ROAS on the platform's purchases only, each platform's own, never added across platforms |
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
- **Day:** calendar day in the **store's IANA time zone** (from `shop.ianaTimezone`), not the viewer's and not UTC. Date presets (`today`, `7d`, `mtd`, …) resolve in that zone too.
- **Weeks** run **Monday to Sunday** everywhere (`WEEK_STARTS_ON` in packages/shared/src/dates.ts,
  ISO 8601), whichever platform the figures come from: the week presets, the charts grouped by week,
  and the Google Ads analytics page. Meta and Google both offer Monday weeks in their own screens; pick
  them there when comparing.
- **Presets:** Today, Yesterday, **This week** (`wtd`: Monday to today) and **Last week** (`lastweek`:
  the Monday-to-Sunday week before this one), Last 7 / 30 / 90 days, **Last 6 months** and **Last 12 months**
  (`6m`, `12m`: from the day after the same date 6 or 12 months earlier, up to today: on 24 Oct 2026,
  25 Apr – 24 Oct and 25 Oct 2025 – 24 Oct 2026), This month, Last month, This year, Last year, and
  every **calendar year** of the store under "Calendar years" in the same menu (1 January to
  31 December; this year up to today), from the year Shopify created the store. The custom dates also
  move **a year earlier or later** with a click, so the same months of two years are compared quickly.
- **At most 12 months at a time, however far back** (`latestRangeEnd`, `MAX_RANGE_MONTHS` in
  packages/shared/src/dates.ts): a range starting on 15 Mar 2025 may end on 14 Mar 2026 at the latest,
  one starting on 1 Jan 2024 on 31 Dec 2024 (366 days, a leap year), one starting on 29 Feb on the 28th
  a year later. One day more is refused (`400 invalid_range`, "pick up to 12 months at a time"), for
  the dates picked and for comparison dates alike; the dates menu offers nothing longer, and the end
  date's calendar stops there. Older periods are not limited: 1 Jan – 31 Dec 2023 is a question like
  any other, and its comparison with the previous year is 2022. The downloads and Customer Messaging
  read the same rule; the ad platforms' own report endpoints keep their 366-day limit.
- **Custom ranges** run from 2000-01-01 at the earliest, or from the store's first day once Shopify's
  creation date is known (`storeRangeLimits`: `Shop.createdAt`, `stores.shop_created_at`, read by the
  shop sync job, and daily by the dashboard's refresh until it is; or an earlier order's day, since an
  order imported from another platform can predate the store), and are reported only up to the
  store's today: picking 1–31 Oct on 9 Oct reports 1–9 Oct. A range that starts after today, or before
  the store's first day, is refused (`400 invalid_range`). Comparison dates may reach back before the
  store's first day: they then hold no orders, and the change says "No earlier data".
- **Comparison period:** what the % changes compare with, chosen beside the dates as in Shopify
  Analytics' second date chip (`compare` in the overview and export query; `resolvePreset` in
  packages/shared/src/dates.ts):
  - **Previous period** (the default, `compare=previous` or absent): the same number of days
    immediately before the selected range (after that clamp); this week so far against the same
    weekdays of the week before (Monday to Wednesday against Monday to Wednesday, up to the same time
    of day), never against the days just before it; last month against the whole month
    before it, whatever its length; last year, or any calendar year picked (1 Jan – 31 Dec), against
    the whole calendar year before it, leap or not.
  - **Previous year** (`compare=year`): the same dates a year earlier. 29 February, which most years
    lack, becomes the 28th, so February 2028 is compared with 1–28 February 2027.
  - **Custom** (`compare=custom&cfrom=…&cto=…`): any dates, under the custom-range rules above (from
    2000-01-01, at most 12 months, reported up to the store's today, not starting after it). They may
    have another length than the range, sit after it or overlap it. A pair that breaks a rule is
    refused with `400 invalid_range`, as a bad custom range is.

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
  began at midnight). With `read_all_orders` the whole history is imported **one calendar year at a
  time, newest first** (`order_history_windows`, packages/core/src/orderHistory.ts, and "History
  import" in docs/shopify-setup.md): as each year comes in with every newer one, `historyFrom` moves
  back to its 1 January, and once the oldest year (the one holding the store's first order) is in, the
  epoch is recorded and `historyFrom` is `1970-01-01`, so nothing counts as not imported. The
  overview's `data.history` says how the store can have that history (`access`: `granted`,
  `reconnect`, `requestable`, `awaiting_shopify`) and how far its import has got (`years`: each year's
  status and orders), and the line under the dates says it in words. A store holding an order from
  before its window (imported before the window was recorded) starts at that order's day instead:
  `historyFrom` is the earlier of the window's first whole day and `oldestOrderDay`. A quiet store's
  first order can come days after its window starts; those days were imported too, with no orders, so
  they compare as $0 rather than "No earlier data". Disconnecting a store deletes its orders and
  forgets the window. Stores imported before the record existed were given 60 days before their last
  successful orders sweep (a start they surely hold), and their next window import makes it exact.
  `oldestOrderDay`/`newestOrderDay` stay the orders actually held ("Orders from … to …").
- **Daily series** (the sales chart and sparklines) has one point per day of the range; days without orders or sales are 0, days before the imported history are "not imported" (null in the breakdown, drawn hatched).
- **Every section follows the dates picked**, in the store's time zone: the tiles, both sales panels'
  daily view, the sales, product, customer, channel, discount and fulfillment details, recent orders
  (the latest 10 placed in the dates, and how many orders were cancelled in them, counted on the day of
  the cancellation) and the downloads. The exceptions say so where they show: the monthly panel is the
  calendar year to date against the two years before (whole months), stock is as of now, and the
  ad platforms' own report pages have their own limits.
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
| Total refunded (`total_refunded`) | − Σ amount (tax in) of every sale of a return action (refunds, returns, cancellations), gift cards and tips aside, with the signs Shopify gave them | Under the Total sales tile as "Refunds −A$62.00": what refunds took off total sales in the dates, which is already after them. A refund's adjustment lines count, so it is the money given back: an item returned with nothing refunded (Shopify adds a refund discrepancy that evens it out, PixMagic #2821S on 2026-10-23) takes nothing off. Edits (action `update`) aren't refunds. Team & Access: needs both "View refunds" and the breakdown, as it holds the refunds' tax and shipping |
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

## The simple Home (2026-11-05)

What /dashboard shows first (`SIMPLE_HOME` in apps/web/src/lib/features.ts), drawn as the owner's
approved Stitch design draws it (prototype v2, project 4270728427536011606: screen 01, 03 for a store
without automations, 04 on a phone): `apps/web/src/components/dashboard/SimpleHome.tsx` and
`homeNeeds.ts`. Plain white panels with a small radius and a faint shadow, soft tinted rows and
buttons (globals.css `home-card`, `home-btn`, `--home-*`). The header is the greeting, "Updated 3 min
ago · Matches Shopify" (the full dashboard's status pills in words, `StatusWords`) and one date card
(`DateChip`: the dates over "vs" the dates compared with, the same two menus as the full dashboard's
pills). How far back the orders go moves to the foot ("Shopify shares your last 60 days of orders ·
Allow full history", `HistoryFoot`), with About this data under it. "Show the full dashboard" under
the greeting brings back every panel below ("Dashboard home") on that device (localStorage
`home-layout`), and "Back to the simple Home" returns. Every figure is the full dashboard's, worked
out by the same code:

- **Needs you** (`needsOf`), worst first: the bell's open problems (warnings and critical alerts, for
  this store or the whole workspace; not its notes, nor a sync that stopped, which is explained above
  the numbers), orders waiting to ship ("Open in Shopify": bizinsights doesn't ship), stock running
  out (the first of `inventory.lowStockItems` and how many more need stock, graded as the health
  check grades stock; "See stock" opens Inventory → Low stock where the member has it) and sales with
  no cost per item in Shopify ("Add in Shopify", for a member shown product costs). Nothing to do
  says so.
- **Four numbers**: Total sales (Net sales without `finance.breakdown`, with the same Refunds and
  Custom sales lines), Orders, then **Left over** once some cost is known: Business profit
  overview's figure (`leftOverOf` in profitFigures.ts), "Net profit" only when it is one, otherwise
  "41¢ of every $1, after product costs, ads and your costs" (a share of net sales in other
  currencies) and, on hover and for screen readers, "Not profit". Without a cost known, Average order
  value instead. Last, **Visits that bought** (the funnel's conversion rate, of the visits the pixel
  tracked) where there are tracked visits, otherwise Average order value (or Total products sold).
  Each change is "+12.7%" under the number (beside its name on a phone); the date card says what
  it is compared with. The "i" in a tile's corner says what the figure measures, in the words of
  `components/dashboard/figureHelp.ts` (the Sales Overview's figures use the same): keep them in
  step with "Formulas" above.
- **Sales by day**: total sales (net without the breakdown) each day of the dates as dark green
  bars, today's paler with "today so far" over it, and the dates compared with as a dotted line, day
  i over day i (`sales_overview.previousSeries`: each day's net and total sales, null when those
  dates weren't imported). No axis: hovering, the arrow keys and a table for screen readers give
  each day's figures.
- **What changed**: the first three checks of the business health check, each opening its details.
- **Working for you**: the Automations hub's own answer (GET …/automations), as "Order confirmation
  (SMS), On, 381 sent in 30 days" (handed to the provider: sent, delivered or undelivered), busiest
  first, and one that's off with "Turn on" (the Automations page, which asks to confirm). Only where
  the menu shows Automations; elsewhere (App Store stores) What changed sits beside the chart.
- **More insights you can unlock** (owners and admins, when Shopify access is missing): one quiet
  list under the panels, the same rows and buttons as the full dashboard's cards.

## The Sales pages (2026-11-06)

The dashboard's topics as pages of their own, in the Stitch design's layouts (screens 05–08:
`apps/web/src/components/dashboard/SalesViews.tsx`, frame and tabs in `SalesFrame.tsx`). Each reads
the same overview answer as the Home (GET …/overview for the dates picked), so a figure is the same
wherever it shows. Under the Overview's layout, "More detail" keeps the earlier panels (Total sales
breakdown, the check against Shopify, gross profit, the comparison table, returns, sales by day and
by month).

- **Overview**:
  - **In short**: total sales (net sales without `finance.breakdown`), its change on the dates
    compared with, orders and items sold.
  - **Four numbers**: Total sales (or Net sales), Orders, Average order (net sales ÷ orders, as
    "Formulas"), and Visits that bought (the funnel's conversion rate of tracked visits) or, with no
    tracked visits, Items sold.
  - **How your sales add up**: Gross sales − Discounts − Returns = Net sales, + Shipping (+ Duties,
    + Additional fees when there were any) + Taxes = Total sales, the lines of Shopify's total sales
    breakdown. Only for a member shown every line. Returns is `returns` from the API, or gross −
    discounts − net where an older answer lacks it.
  - **Sales by day**, as on the simple Home. Under it:
    - **Best day**: the day with the highest total sales (net without the breakdown).
    - **Best weekday**: the weekday whose days add up to the most, in the store's time zone.
    - **Average day**: the dates' total ÷ their days, today included (so far).
  - **Sales by channel**: net sales per sales channel (`channels`).
  - **Where buyers came from**: orders by how their last visit came, from Shopify's record of each
    order's visit (`traffic.split`: paid, organic, email, direct, not recorded; `traffic.items` when
    the member isn't shown attribution).
  - **Top products**: the top five of `top_products` by net sales, the same ranking as Products.
  - **Busiest times**: orders by weekday and by hour of the day, each counted on its own (the API
    returns no weekday-by-hour grid, so there is none). The peak is `busiestDay` and `busiestHour`.
  - **Discount codes**: the three most used, the money each took off, and the total discounts.
- **Products**:
  - **Items sold**: units less returns, with items per order.
  - **Top product**: the first of `top_products`, its share of net sales. While the ranking is held back
    (`top_products.complete` false: some sales can't be grouped by product yet) it reads "Not
    available", never "no sales".
  - **Products in your shop**: the catalogue's active products, with draft and archived.
  - Then Top 100 products, Sales by collection and Catalog, unchanged.
- **Customers**: customers who ordered, new, returning (and the returning rate), and the returning
  rate for the dates compared with, as "Repeat customers and monthly cohorts" counts them. The bar
  splits customers who ordered into bought before (`returningCustomers`) and first purchase
  (customers − returning). Someone whose first and second orders both fall in the dates is both new
  and returning, so new + returning can be more than customers.
- **Orders & shipping**:
  - **Orders at a glance**: completed, awaiting payment and unsuccessful (cancelled, payment failed,
    refunded in full) add up to the orders placed in the dates, as "Orders at a glance" on the full
    dashboard (`order_outcomes`), with shoppers left at checkout where the pixel counted them.
  - **Shipping**: waiting to ship (open orders from any date), average time to ship and the share
    shipped of the dates' orders (`fulfillment`).
  - **Orders**: every order placed in the dates (GET …/orders), searchable by order number and
    filtered by payment, shipping and cancellation where the member is shown them, 25 to a page;
    each opens in Shopify. Until it loads (or if it can't), the overview's 10 latest.
  - **Refunds**: refunds booked in the dates, as a share of sales.

## Dashboard home (the owner's design)

The full dashboard, one click from the simple Home. Reference implementation: `apps/web/src/components/dashboard/HomePanels.tsx` (and the tiles in
`HomeCards.tsx`), from the owner's mock of 2026-10-24. Every figure is one the overview already
carries; nothing is estimated.

- **Headline tiles**: Total sales (Net sales without `finance.breakdown`), Orders, Average order
  value, Total products sold, each with its change and a sparkline of the same figure day by day
  (`series`; a day's `units` are its net items sold). Under Total sales: "Refunds −A$…", what
  refunds took off it in the dates (`sales_overview.current.totalRefunded`, Total refunded above),
  then the store's Custom sales when it shows them.
- **Orders at a glance** (asked for by the owner on 2026-10-30, under the tiles; module
  `order_outcomes`, `orderOutcomes` in core's reports/orders.ts): how the orders placed in the dates
  went, the same orders as the Orders tile (by processed day, gift-card-only orders left out). Each
  order is exactly one of these (`orderOutcome` in `@app/shared/orders`), so the three add up to the
  Orders tile:
  - **Completed**: not cancelled, paid (`paid`, `partially_refunded`, or no payment state read yet).
  - **Awaiting payment**: `pending` (cash on delivery, bank transfer), `authorized` (to capture),
    `partially_paid`.
  - **Unsuccessful**: cancelled (whatever its payment says), payment failed (`voided`, `expired`),
    or refunded in full (`refunded`).
  - **Left at checkout**: shoppers who started a checkout in the dates and didn't buy, from the
    storefront pixel's visits (one per shopper per day, as the funnel counts them; online store
    only). Counted from the first day the pixel counted in full ("counted from …"); "Not tracked"
    without the pixel or for dates before it. Not Shopify's abandoned checkouts list, which holds
    only checkouts where the shopper left an email or phone.
  - **Products sent**: of the completed and awaiting-payment orders, the items of those sent in full
    (`fulfilled`), and how many were partly sent or are still to send (the fulfillment module's open
    statuses). Shopify's per-line shipped quantities aren't stored, so a partly sent order's items
    aren't split.

  Team & Access: the panel shows with "View order list", "View fulfillment status" or "View checkout
  abandonment"; completed / awaiting / unsuccessful need "View payment status" and "View
  cancellations", products sent "View fulfillment status", left at checkout "View checkout
  abandonment" (`redactOverview`).
- **Sales vs ad spend** (the mock's "Revenue vs Expenses"): net sales per day beside the ad spend
  per day. Ad spend is the only cost known day by day; it is drawn only when the ad accounts report
  in the store's currency and none is the Google Ads demo, as for MER. An account in another currency
  isn't in it, and the panel says so ("Left out: EU shop (EUR), in another currency.").
- **Business profit overview**: net sales less the costs bizinsights can see, the product costs
  (Shopify's cost of goods sold from its profit report, for the dates as a whole; while that report
  gives none, the items sold at their cost per item: **Product costs** below), the ad spend for the
  whole range (`ads.current`, null while a day is missing; with an account in another currency, only
  the accounts in the store's currency, taken off as "ads in AUD", with a "Left out" line) and the
  owner's own costs (Settings → Costs). It is **net profit** only when every input is known and the
  owner has marked the costs list complete for the dates ("Costs and net profit" below); otherwise
  it says "Not net profit" and why, and sales with no cost recorded in Shopify are named. Shopify
  counts a sale with no cost per item at no cost, so when no sale of the dates had one, its cost of
  goods sold of 0 isn't a cost: product costs read "Not recorded in Shopify" and aren't taken off.
  Its share is called a **margin** only when the cost of every sale was taken off; with ad spend
  alone, or sales with no cost recorded, it is "of net sales", since sales less ad spend is no
  margin. Team & Access: the Product costs line, here and in Expenses breakdown, is only for a
  member shown Shopify's cost of goods sold ("View costs and stock value" with the breakdown,
  `costsOn`); without it there is no net profit.
- **Expenses breakdown**: the same costs as a ring (ad spend split by platform when there are two, the
  accounts left out in another currency named under it, the owner's costs by category). The mock's
  shipping, software and other expenses come only from the owner's costs: nothing else holds them.
- **Product costs** (both panels): Shopify's cost of goods sold while its profit report answers
  (`profit`, with `read_reports`) or is on its way ("Loading…"). Otherwise (the reports not granted,
  or Shopify refused or failed) the `product_costs` module (`productCosts` in
  packages/core/src/reports/products.ts, with `read_orders` and `read_products`): the items sold
  (returns taken off, as Top products counts them) × each variant's cost per item in Shopify now
  (`product_variants.unit_cost`), with the net sales of product lines with and without a cost per
  item, so the same rules apply: none with one is "Not recorded in Shopify", some without is named and
  keeps it from net profit. Shopify's report takes the cost recorded with each sale, so the two differ
  only where a cost per item changed since; the panels say when the costs are the items at their cost
  per item. Same permissions as Shopify's (`product_costs`: the breakdown and "View costs and stock value").
- **Top products**: the top five of `top_products` by net revenue, each with its share of net sales;
  withheld while the period's sales aren't all imported (`complete` false), as the full list is.
- **Recent orders**: the five latest, with one status word (cancelled, fulfilled, then payment).
  The mock's customer column is the sales channel: names are protected customer data.
- **Key insights**: the first four checks of the business health check below, worst first.
- **Advertising performance** and the integrations strip only where the workspace offers
  advertising and the member is shown it (Team & Access); the strip only for those who can manage
  integrations. TikTok Ads isn't offered.

## Sales panels (dashboard overview)

Reference implementation: `apps/web/src/components/dashboard/OverviewCharts.tsx`, in the owner's
design (2026-10-24). Two panels under the home page's panels, each with its total in large type, a
line on what is in it, a key, and the running total drawn as a violet line over the columns, read
off its own scale on the right (its labels sit on the left scale's gridlines). The Sales section's
cards above keep the running total in a strip of its own.

- **Daily** (the dates picked): Total sales per day by default (Custom sales while the store shows
  it), or Net sales, Orders or Returns ("Sales chart shows"). Sales days are coloured by the day
  tiers above (best green, strong yellow, the rest cyan); today is light cyan (not over yet). Each
  column carries its figure when every figure fits, otherwise only the best day's and today's;
  weekend dates are in orange. Finished days with nothing are named in the line under the total.
  "Sales chart groups" adds the days up **by week** (Monday to Sunday) once the dates hold more than a
  week, and **by month** once they reach into a second month and run past a month (`periodBreakdown`
  in packages/shared/src/sales.ts). A week or month that the dates picked cut short (a range starting
  on a Wednesday) is named with the days it holds; one holding today, or with days not imported, is
  lighter and "partial"; one with no day imported has no column, never $0. Day tiers are for days only.
- **Monthly comparison** (this calendar year, January to the current month): each month beside the
  same month of the two years before, **whole** (`pastYearBreakdown`: August last year is all of
  August, while this August is so far), so a year's columns read as the month to beat. Total sales
  by default, or Custom sales or Net sales ("Comparison shows"; Net sales only without
  `finance.breakdown`). The percentage over this year's columns is the change on the month before,
  as Month by month's (the current month on the same days of the month before). A year with nothing
  imported isn't drawn; a month not imported has no column, a partly imported one is lighter.
  Team & Access: the whole panel needs `finance.reports`, as Month by month does; the earlier
  years' lines and refunds are redacted as this year's months are (`redactOverview`).

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

### Paid vs organic (dashboard "Paid vs organic sales", and on "Where your sales come from")

The same net sales, grouped by how each order's last visit came (`TRAFFIC_SPLITS` and `trafficSplitOf` in
`packages/shared/src/traffic.ts`; the traffic module's `split`):

| Split | `traffic_medium` | What it is |
| --- | --- | --- |
| Paid ads | `paid` | a link tagged as an ad (above) |
| Organic | `unpaid`, `referral` | a search engine, social network or other website, without an ad tag |
| Email and messages | `email` | email, SMS and Shopify's message tactics |
| Direct | `direct` | a typed or bookmarked address |
| Not recorded | `unknown` | no visit recorded (point of sale, draft orders, apps) |

- **Last click, from Shopify's journey**: never what Meta or Google credit to their ads, which count earlier clicks
  and views too. Every place it shows says so.
- An ad whose links carry no tags reads as organic (Facebook and Instagram add none by themselves): the note says to
  add utm_medium=paid.
- Each split's share is of the sales whose source is read; orders still being read (`pending`) are left out and
  counted beside it. A split with no orders is listed at zero.
- Team & Access: "View conversion attribution", like the tagged-ads figures (`redactOverview` drops `split`).

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
| Purchases (platform's count) | Meta: the first of `omni_purchase`, `purchase`, `offsite_conversion.fb_pixel_purchase`, `onsite_web_purchase` (never their sum: they overlap). Google: `metrics.conversions` of the conversion actions in the Purchase category (`segments.conversion_action_category = PURCHASE`, its own query) | The platform's own attribution, never the store's orders. `null` while any day added up has none read yet. Never shown added across platforms (below) |
| Purchase value (attributed revenue) | the matching `action_values` (Meta), `metrics.conversions_value` of those Purchase actions (Google) | As for purchases: what the platform credits to its ads, not the store's sales |
| Return on ad spend (ROAS) | purchase value ÷ spend | Each platform's own figure ("Google Ads-reported ROAS", "Meta-reported ROAS"); never one ROAS across platforms (below) |
| Cost per purchase | spend ÷ purchases | Per platform, as ROAS |
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
- **Purchases are never added across platforms.** Meta and Google each credit purchases to their own
  ads by their own rules (Meta's attribution windows, Google's conversion settings), and both can claim
  the same order, so their purchases, purchase value, ROAS and cost per purchase added together can
  count it twice. Spend, impressions and clicks are each platform's own and add up. With one platform
  counted, the module's totals are its figures. With Meta and Google both counted, the module's
  `claimsAddUp` is false (`claimsAddUp` in packages/shared/src/ads.ts): its purchase totals add the
  claims up, so the pages show each platform's own from `byProvider` instead, named as its claim
  ("Meta Ads attributed revenue", "Claimed by Google Ads"), and as the one figure across platforms the
  store's own sales: Shopify's net sales and the sales per unit of ad spend (MER), which count every
  order once. The Advertising overview has a tile per platform (its attributed revenue, purchases, ROAS
  and cost per purchase) beside "Your store's net sales" in place of the Purchases, Ad revenue, ROAS
  and Cost per purchase tiles; Profitability gives each platform's attributed revenue, ROAS and profit
  before product costs under the spend added up, never an advertising profit worked out from their sum.
  The overview's Performance overview chart draws the spend added up beside each platform's purchase
  value, and a ROAS line per platform (its purchase value ÷ its own spend), from `seriesByProvider`.
  Key insights (`advertisingInsights`) set the break-even ROAS against each platform's own ROAS, name
  the one that falls short, say what each platform's ROAS means, and give the purchase value's change
  and "spend up while purchases fell" per platform on its own comparison. The Meta Ads and Google Ads
  pages' details (`AdsDetail`) give a figure per platform of its purchases (their value, its ROAS and
  cost per purchase) in place of the four added up, in "In short" and on the daily spend chart's days
  too, and "What you could do next" names each platform's ROAS beside MER. The Advertising summary CSV
  (`ads_summary`) gives each platform's purchases, purchase value, ROAS and conversions as rows of
  their own ("Meta Ads purchases (its own count)") under a "Purchases: Each platform's own" row, never
  the totals' sum. On the dashboard, Business health's Ads line names each platform's purchase value
  and ROAS ("Meta Ads credits … in purchases to its ads (2.4×) and Google Ads … (1.9×), each by its own
  count"), and Overview's details have a "Return on ad spend (Meta Ads' own)" row per platform in place
  of the platforms' one (`businessHealth`, `OverviewDetail`).
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
- **Currency:** only accounts in one currency are added together. That is the store's currency when any connected account uses it, otherwise the first account's. Other accounts are listed and left out, whatever state they're in: `accounts` marks them `counted: false`, and `leftOut` lists them once (the Google Ads demo aside, its spend being simulated). Nothing is converted, so a cost worked out from the spend shown is short by theirs: wherever ad spend is shown as a cost (Sales vs ad spend, Business profit overview, Expenses breakdown, Profitability, the Profit sheet's spend rows) it says "Left out: EU shop (EUR), in another currency.", and net profit isn't given ("Costs and net profit"). The Profit sheet's profit and loss takes none of that spend off: its ad spend is "Not usable" with the same sentence, and its profit is missing data ("Profit and loss (Profit sheet)"). The Advertising summary CSV has a "Left out" row under the spend; the Advertising overview's "Left out of these figures" line lists the same accounts, never the demo.
- **Platform attribution is never mixed into store sales.** Meta and Google can both claim one sale, and neither matches Shopify's orders exactly.
- **Clicks, reach and visits are different counts, never added together.** Meta's reach is people Meta
  showed an ad to; impressions, clicks and Meta's landing page views are each platform's own count; Shopify's
  sessions and visitors are counted on the store, and tracked visits by the bizinsights pixel. A click
  doesn't always become a session, and one person can be reached, click and visit more than once. The
  Advertising overview says so under its figures.
- **By week, by month:** the Advertising charts ("Ad charts group", and the Meta and Google pages' "Trend
  groups") add the days up per Monday-to-Sunday week or calendar month (`groupSeries` in
  packages/shared/src/ads.ts): each figure is the sum of its days, a rate is worked out from the sums
  (never an average of daily rates), and a week or month missing any day's figures is left blank, as a
  missing day is.
- **Freshness:** the last 3 days are refreshed hourly. The last 30 days are fetched again daily, because purchases keep being credited after the click. A first connection fetches 90 days. An account whose stored history falls short of those 90 days (its first sync failed and a later one worked, or it was connected before `history_from` was recorded) gets the whole 90 days in its daily re-check instead, until they are in (`recheckDays` in packages/core/src/adConnections/sync.ts).
- **No earlier data:** comparisons go back only to where every counted account's figures start (see Conventions).

### Live reports: figures read for the dates picked

The Meta Ads and Google Ads pages' live reports (`GET .../ads/meta/report`, `.../ads/google/report`)
ask the platform for exactly the dates picked, at the level picked, and carry figures not stored per day:

| Figure | Formula | Notes |
| --- | --- | --- |
| Reach, frequency (Meta) | Meta's `reach`; impressions ÷ reach | People, counted once over the whole range: never added up over days |
| Landing page views (Meta) | the first of `omni_landing_page_view`, `landing_page_view` in `actions` (never their sum) | Link clicks after which the page loaded, as Meta's pixel saw it: Meta's count, not the store's sessions |
| Cost per landing page view (Meta) | spend ÷ landing page views | |
| Conversion rate (Google) | `metrics.conversions` ÷ `metrics.clicks` | Google's "conv. rate", on every conversion action; not the store's conversion rate |

The reports are cached briefly (10 minutes while they include today, an hour otherwise) under a
versioned key (`ads-report:v2:`, `ads-greport:v2:`), moved whenever a report gains figures.

### With no ad account connected: from the Shopify orders

Reference implementation: `adsFromShopify` in `packages/shared/src/adsFromShopify.ts` and
`adsFromShopifyModule` in `packages/core/src/reports/adsFromShopify.ts` (docs/advertising.md, "No ad
account connected").

| KPI | Formula | Notes |
| --- | --- | --- |
| Sales from Facebook and Instagram / Google and YouTube | net sales of the orders whose last visit's source is `facebook` or `instagram` (Meta) / `google` or `youtube` (Google Ads) | As "Where sales come from" counts them: the sales that happened in the range |
| Orders | those orders placed in the range | Gift-card-only orders aside, as everywhere |
| Share of your sales | the platform's sales ÷ the store's net sales over the range, every source together | Orders whose visit isn't read yet count in the whole, in no platform (`pending`) |
| From links tagged as ads | the same for `traffic_medium = 'paid'` | An untagged Meta ad counts as a visit from Facebook or Instagram, not as an ad |
| Change | (now − before) ÷ before, for the dates compared with | Only with their orders imported; a running day is cut at the same time of day (orders by processed time, sales by when they happened) |

Each day of the range is given, a day before the store's imported orders as unknown (never 0). These are
the store's last-click view and never added to, or shown as, a platform's own figures.

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

`funnel_daily`, which the pre-visit pixel wrote, was dropped empty on 2026-11-12.

### Shopping Funnel page (/funnel)

The page (`apps/web/src/app/(app)/funnel`, components in `apps/web/src/components/funnel/`) asks the
dashboard's overview with `parts=funnel` (apps/api/src/routes/dashboard.ts): the funnel in full
(`funnelDetail`, packages/core/src/reports/funnel.ts), the store's orders (sales overview), Shopify's
own sessions when granted, and orders by traffic source. Its maths is in `packages/shared/src/funnel.ts`.
`?view=shoppers` on the dashboard opens it.

Every visit figure is a count of **tracked visits** and every rate divides tracked visits by tracked
visits in the same dates and filter, so no rate mixes two sources:

| Figure | Formula |
| --- | --- |
| Visits at a stage | Visits whose furthest step is that stage or a later one |
| Share of visits | Visits at the stage ÷ all visits |
| Progression rate | Visits at the stage ÷ visits at the stage before |
| Drop-off rate | 1 − progression rate; visits lost = visits at the stage before − visits at the stage |
| Conversion rate | Visits that completed checkout ÷ visits |
| Checkout completion | Visits that completed checkout ÷ visits that started checkout |
| View to cart rate (a product) | Visits that added the product to cart on its page ÷ visits that viewed its page |
| Checkout completion (a product) | Visits that bought the product ÷ visits that started a checkout holding it (`checkoutCompletion`; every buying visit started that checkout) |
| Change of a stage | (visits now − visits then) ÷ visits then, against the comparison (`stepDeltas`) |

- **Largest drop-off**: the transition that lost the most visits (`largestDropOff`; a tie goes to the
  earlier step). Rates are never called good or bad: there is no benchmark, only the store's own
  earlier dates.
- **A clear change**: a transition's progression differs from the comparison by more than chance, by
  the pooled two-proportion z-test at 95% (`proportionZ`, |z| ≥ 1.96) with at least 30 visits on each
  side and five expected successes and failures in each group; otherwise "within normal variation".
- **Observations** (`funnelInsights`, at most six): where most visits are lost (30 visits or more);
  visits up or down (Poisson test, at least 50 a side, only between dates of the same length); the
  conversion rate or a transition changed (the z-test); mobile against desktop, or new against
  returning visitors, buying or completing checkout at different rates (the z-test); a product page
  added to cart less often than the store's other product pages (the z-test). Nothing else is said,
  and reasons are offered as things to check, never as measured causes.
- **Segments** (each a funnel of its own on the same visits): device, country, landing page (the
  section the visit started on), new or returning (returning: the same hashed browser has a visit on
  an earlier day since the pixel's history began), traffic source. The **filter** (`device`,
  `visitor`, `landing`, `country`, `source`) narrows every visit figure on the page, the CSV included.
  Orders, revenue and product sales are never narrowed: the orders carry no device or visit.
- **Device and country** come from the pixel's own request: the browser's User-Agent read into
  mobile, tablet, desktop or unknown (`funnelDevice`; an iPad asking for desktop sites counts as a
  desktop), and the country the edge placed the request in (`locationOf`). Kept as one word each on
  the visit (`funnel_visits.device`, `.country`), from the visit's first batch. Visits from before
  2026-10-24 have neither: they show as "Not recorded", from `detailsFrom` on they have them.
- **Traffic source** (`funnel_visits.source`, one of `TRAFFIC_SOURCES` in
  packages/shared/src/traffic.ts): with the page view of a page reached from outside the store, the
  pixel sends the referring site's host, the link's `utm_source` and `utm_medium` (cut to 100
  characters) and the names of the ad click ids it carried (`gclid`, `gbraid`, `wbraid`, `fbclid`,
  `ttclid`, `msclkid`; never their values). `arrivalSource` sorts that by the same rules as an
  order's last visit (`classifyVisit`), so visits and orders by source use the same words; an arrival
  with no referrer and no tags is Direct. Only the word is kept, and nothing of the referrer, tags or
  address. Not an arrival: a page whose referrer is the store's own host (the pixel leaves those
  out), checkout, thank-you and account pages (reached back from a payment provider or a sign-in),
  and referrers on `myshopify.com` or `shopify.com`. A visit keeps its **first** arrival
  (`COALESCE`, as the device): a shopper who comes back from elsewhere the same day keeps the first
  source. Null shows as "Not recorded": visits from before the pixel sent arrivals (`sourcesFrom` is
  the first day one has a source), and visits whose first tracked page wasn't the one they arrived on
  (tracking accepted on a later page). Visits by source are the traffic sources permission's
  (`analytics.traffic`, as orders by source): without it the segment isn't computed for the member,
  `source` is dropped from their filter (`funnelViewOf`), and `redactOverview` removes both. The
  Breakdown's Traffic source tab shows the store's orders by source under the visits, never divided
  by them.
- **Products** (`funnel_product_visits`, one row per visit and product; `productStepsOf`): bit 0
  (1) the product page was viewed, bit 1 (2) added to cart on that page, bit 2 (4) added to cart
  anywhere else (a quick add from a collection, search or cart drawer, or another product's page),
  bit 3 (8) in a checkout the visit started, bit 4 (16) in a checkout the visit completed (16 sets 8
  too). Bits 2-4 come from the products the pixel names with an add (the cart line's product) and a
  checkout (its line items), by the handle in the product's storefront address; an older pixel names
  none, so its add is put down to the product page it happened on and its quick adds to no product.
  Quick adds, checkouts and purchases are null ("Not recorded", the column hidden) for dates before
  `sourcesFrom`, which the same pixel release starts. Beside them, each product's orders, units (net
  of returns) and net sales come from the store's orders in the dates (only for members with the top
  products permission), never divided by views or tracked purchases: orders count every order,
  tracked or not. `productSuggestion` names what to look at: a page added to cart less often than
  the others (z-test, 20 viewing visits or more), added from its page by 10 visits or more with no
  order holding it, a landing page that visits leave from more often than the store's other product
  pages' (z-test), or ordered with no tracked view, quick add or checkout.
- **Not measured**: paid or unpaid per visit (only the source word is kept), a visit's purchase
  matched to its order, people across devices, and Shopify Analytics' own sessions without
  `read_reports`. Traffic sources and checkouts per product need the updated pixel released to each
  app (`shopify app deploy`, docs/shopify-setup.md); until then they show as "Not recorded".
- **Checklist**: `FUNNEL_ACTIONS`, ticked per store by any member who sees the funnel
  (`PUT …/funnel/actions/:id`, `funnel_action_checks`; audited as `funnel.action_done` /
  `funnel.action_undone`). A shared, view-only dashboard and API keys can't tick.
- **Download**: `GET …/export?section=funnel` with the dates and filter: the dates, the filter, the
  funnel now and before, every transition, every day, every segment and the products (with quick
  adds, checkouts and purchases, empty where not recorded). "Print or save as PDF" prints the page.

## Profit sheet (/sheet)

Every figure bizinsights has for the store laid out like the owner's own spreadsheet: a row per
figure, the days shown added up first, then a column per day, week (Monday to Sunday) or calendar
month (`?by=`; without it days up to 45 days, weeks up to 190, then months). Its data is the
dashboard's own answer narrowed to it (`GET …/overview?parts=sheet`: `sales_overview`, `funnel` with
`visitsByDay`, `ads`, `ad_connections`, `product_costs` with `byDay`, `expenses` with `terms`);
`@app/shared/sheet` adds the days up. Nothing is estimated. Page access: "View sales and revenue"
(`analytics.sales`); each row needs what its figure needs. Above the table the page opens on the
store's **profit and loss** for a day and a month ("Profit and loss" below).

| Row | Day by day from | Notes |
| --- | --- | --- |
| Total sales, Total sales ex tax, Tax (as a share of total sales ex tax) | `series[].totalSales`, `.tax` | "View gross sales, discounts, tax, shipping and total sales" |
| Net sales | `series[].netSales` | Every ratio below is worked out on it, as the dashboard's are |
| Orders, Items sold | `series[].orders`, `.units` | |
| New customer orders, New customer % | `series[].newCustomerOrders` = orders with a customer − returning customers' orders | "View returning vs new customers". An order with no customer record is neither |
| Store visits | `funnel.visitsByDay` (the pixel's visits, as the funnel counts them) | Blank before the pixel counted them |
| Conversion rate, Sales per visit | orders ÷ visits, net sales ÷ visits | |
| Items per order, Average order value | units ÷ orders, `series[].orderValue` ÷ orders | Weeks and months divide the sums, never average the averages |
| Meta / Google ad spend, Total ad spend | `ads.seriesByProvider` | In the ad accounts' currency |
| Ads as share of sales (marketing expense ratio), its 3 days, Sales per unit of ad spend (MER), Ad spend per visit / per order, Net sales less ad spend | spend against net sales, visits, orders | Only when the ads report in the store's currency and none is the Google Ads demo (as "Ads as share of sales"). The 3-day share is for day columns: the day and the two before it, whatever the filter, blank on a day whose two before aren't in the dates |

With an ad account left out in another currency (`ads.leftOut`), every row worked out from the spend
(the spend rows, and those that set it against sales, visits and orders) is the spend shown only, never
converted or guessed: its help ends with "Left out: EU shop (EUR), in another currency." and the row
carries the sentence (`sheetRows`' `leftOut`, `SheetRow.leftOut`), as does the ads' share of sales in
"Business events in these dates".

A period one of whose days isn't known (visits before the pixel, a day an ad account has no figures
for) is blank for the whole period, never a part. "Net sales less ad spend" is not profit.

**Profit and loss rows** (for a member with the breakdown, who is shown the owner's costs): Revenue,
Product costs, Gross profit, Gross margin, Your variable costs, Variable costs, Fixed costs, Operating
profit, Operating margin, Interest/tax/depreciation, Net profit, Net margin, each column worked out by
`profitAndLoss` (@app/shared/profit) from its own days as in "Profit and loss" below. A column's
fixed costs are its days' share (a day column ₹50,000 ÷ 30, a month column the whole ₹50,000); with a
filter, each run of consecutive days shown is counted on its own. The product cost rows need "View
costs and stock value" too. A profit that can't be given is blank, and the notes under the table say
why. Product costs day by day are the items sold at each product's cost per item in Shopify now
(`productCostsByDay`); Business profit overview takes Shopify's profit report when it has one, so the
two can differ where a cost per item changed. Without the breakdown the sheet stops at net sales less
ad spend and says so.

**Days shown** (`?days=`): every day, weekdays, weekends or any weekdays picked (`0,2,4`, Monday = 0).
**Business events** (`?events=`): every day, the days with an event, those without, those with an
event of a kind (`kind:sale`), or the days of one event (`event:<id>`). The total and every column add
up only the days shown; a week or month column says how many of its days that is.

**Business events** (`business_events`, `@app/shared/businessEvents`): a name, a kind (sale or
discount, ad campaign, product launch, email or SMS sent, holiday or season, stock problem, website
change, other), a first and last store-local day (up to 366 days) and a note; 1,000 per store.
Notes only: no figure is worked out from them. `GET/POST …/business-events`, `PUT/DELETE
…/business-events/:id`: anyone with "View sales and revenue" may read, add, change and remove them,
as the team's shared calendar; a shared (view-only) dashboard and API keys may only read. Audited as
`business_event.created` / `.updated` / `.deleted` (kind and days, never the note). They show under
their days in the sheet (the pencil on a column marks one there) and in "Business events in these
dates": a day with an event against a day without one (net sales and orders a day, conversion, ads'
share), then each event's own days, with "Only its days" to narrow the sheet to them.

**Download CSV** ("Export approved reports" permission): the sheet as on screen, built in the browser (the
same figures the page shows), plain numbers, the events as a row. **Print** prints the page.

## Profit and loss (Profit sheet)

Reference implementation: `packages/shared/src/profit.ts` (`profitAndLoss`, `costsOver`, `outcomeOf`),
`packages/core/src/reports/profit.ts` (`profitReport`), `GET /workspaces/:ws/stores/:storeId/profit?month=YYYY-MM`
(`apps/api/src/routes/profit.ts`) and the sheet's "Profit and loss" (`components/sheet/ProfitPanel.tsx`).

Whether the store made money on a day and in a month. The page picks a month (this month by default,
any month back to the store's first) and a day in it (today by default): `?month=` and `?day=`. The
API answers the month's days, the month (so far, while it runs) and the 12 months ending with it, all
worked out on the server from the store's own records; the page lays them out as Daily performance,
Monthly performance, Expense breakdown and Profit analysis (daily profit or loss, monthly profit or
loss, sales vs expenses, fixed vs variable costs, profit margin trend). Days are store-local.

| Figure | Formula | From |
| --- | --- | --- |
| Net sales | gross sales − discounts − returns | `daily_store_metrics` (Shopify's sales records) |
| Revenue ("Sales") | net sales + shipping + additional fees: total sales less taxes and duties | the same |
| Product costs | items sold (returns off) × each variant's cost per item in Shopify now | `productCostsByDay` |
| Gross profit, gross margin | net sales − product costs; ÷ net sales | Shopify's own definition |
| Variable costs | product costs + the connected ad accounts' spend + your variable costs | ads module `series`; costs below |
| Fixed costs (allocated) | your fixed costs' share of the days: a monthly cost ÷ its month's days (28, 29, 30 or 31), or ÷ its open days | `expenseInRange` |
| Operating profit, operating margin | revenue − variable costs − fixed costs; ÷ revenue | |
| Net profit, net margin | operating profit − interest, income tax, depreciation and other costs below operating profit; ÷ revenue | the dashboard's net profit, worked out day by day |

The brief's example: rent ₹15,000 + salaries ₹30,000 + software ₹3,000 + other ₹2,000 = ₹50,000 a
month; in a 30-day month a day carries ₹1,666.67, never the whole ₹50,000; a ₹10,000 day with ₹4,000
of variable costs makes ₹4,333.33 of operating profit (`packages/shared/test/profit.test.ts`,
`apps/api/test/profit.test.ts`). A whole month carries its whole fixed costs whatever its length.

- **Nothing is counted twice**: product costs and ad spend are variable costs; each of the owner's
  costs is in exactly one group by its category (fixed, variable, below operating profit), so net
  profit is revenue less every cost once, as the dashboard's.
- **Missing data, never 0** (`ProfitLossGap`): days before the store's imported orders
  (`sales_not_imported`); product costs not shared, not shown to the member, none recorded, or some
  sold products without a cost per item (gross, operating and net profit all wait); an ad account's
  spend not known for a day; the spend in another currency than the store's, leaving out an account
  in another currency (named: "Left out: EU shop (EUR), in another currency."), or the demo's
  (`profitAds`); the costs list not marked complete
  for the days. Each figure that can't be given says "Missing data" with its reason, and "Left after
  the costs bizinsights knows" (never called profit). With no ad account connected the spend is 0
  (ads paid elsewhere are the owner's costs).
- **Outcome**: profit above 0, loss below, break-even at exactly 0 to the cent, missing data.
- **Cash flow** is shown as "Not connected": bizinsights doesn't read payouts or bank accounts, and
  cash flow isn't profit.
- **Access**: `finance.breakdown` with `analytics.sales` (revenue takes shipping and fees; the costs
  list goes with the breakdown); product costs also need "View costs and stock value", the ad spend
  "View advertising analytics", otherwise they are "hidden" and the profit they'd give away isn't given. A
  shared link and API keys may read it. The month must not be in the future (400 `invalid_month`).

## Profit & Loss page (/profit)

Reference implementation: `profitStatement` (`packages/core/src/reports/profit.ts`),
`GET /workspaces/:ws/stores/:storeId/profit/statement` (the dashboard's date question, `preset`,
`from`, `to`, `compare`, `cfrom`, `cto`, and `grain=day|week|month|year`), the page
`apps/web/src/app/(app)/profit/page.tsx` and `components/profit/`.

The owner's own profit and loss workbook (EEq.xlsx, a "Dashboard" sheet with a column a day and an
"Add Cost" sheet) as a page: any dates and the dates they're compared with (the dashboard's pickers:
today, yesterday, this week, this month, last month, this year, last year, custom; previous period,
previous year, custom), a column per day, week, month or year (at most `MAX_STATEMENT_COLUMNS`, 62;
coarser when the dates need more), overview cards with the change from the comparison, charts
(revenue, expenses and profit per column; daily profit or loss; the expense breakdown; advertising;
fixed vs variable), the statement, the expenses table and the recurring expenses. Every figure is
`profitAndLoss`'s (`packages/shared/src/profit.ts`), worked out on the server; the page formats it.

| Row | Formula |
| --- | --- |
| Revenue (tax included) | Shopify's total sales: what customers paid, tax and duties included |
| Revenue before tax | net sales + shipping + additional fees (the revenue profit is worked out from) |
| Tax collected | revenue (tax included) − revenue before tax: never the store's income |
| Orders, items sold | the sales records' |
| Advertising | each connected platform's synced spend (Meta, Google) + your advertising costs (other paid channels, ad spend adjustments) |
| Variable costs | product costs (each product's cost per item in Shopify) + your variable costs (shipping, pick and pack, packaging, transaction and merchant fees, commissions, product cost adjustments, your own variable categories) |
| Fixed costs | your fixed costs' share of the dates (a monthly cost spread over its calendar month) |
| Below operating profit | interest, income tax, depreciation (only when there are any) |
| Total expenses | advertising + variable + fixed (+ below operating profit) |
| Profit or loss | revenue before tax − total expenses (the dashboard's net profit) |
| Profit margin | profit ÷ revenue before tax |
| MER (marketing expense ratio) | advertising ÷ revenue tax included |
| VCR, FCR | variable costs ÷ revenue before tax; fixed costs ÷ revenue before tax |
| Sitewide ROAS | revenue tax included ÷ advertising |

A ratio whose denominator is 0 or below (no sales, a day of refunds) is "—", never a figure.

**Checked against the workbook** (`packages/shared/test/workbook.test.ts`): its October, day by day
(sales with and without GST, orders, items, Meta spend, product costs, shipping $20, packaging $3 and
transaction fees $0.30 an order, merchant fees 2% of sales with tax on days with sales, and five
monthly fixed costs), gives its every cost total to the cent: advertising $11,950.77, variable
$12,019.88, fixed $11,734.00, total $35,704.65, MER 35.43%, ROAS 2.82; 1 October's profit −$736.89.
Two differences are deliberate and named in the test:
- the workbook's month profit is −$5,039.65: it takes $33,731.50 ÷ 1.1 = $30,665.00 for the month,
  where its own days before tax add up to $30,664.99 (as Shopify's do), giving −$5,039.66 here;
- it divides profit %, VCR and FCR by revenue **with** tax (−14.94%, 35.63%, 34.79%); bizinsights
  divides them by revenue before tax (−16.43%, 39.20%, 38.27%), since the tax collected is the
  government's. MER and ROAS keep the workbook's base (revenue with tax).
The workbook's merchant fee on the day of a refund (−$431) is 0: a percentage cost is never below 0
on a day refunds outweigh sales.

## Costs and net profit

Reference implementation: `packages/shared/src/expenses.ts` (`expenseInRange`, `occurrences`,
`expenseTotals`, `netProfit`), `packages/core/src/expenses.ts`, Profit & Loss (`/profit`), Settings →
Costs (`/settings/costs`) and the Profit sheet's Expense breakdown, which all edit costs with the one
form (`components/costs/CostForm.tsx`).

What Shopify, its profit report and the ad platforms can't tell bizinsights (rent, salaries, software,
the Shopify plan and apps, shipping labels, packaging, payment fees, commissions, ads on platforms that
aren't connected, loan interest, income tax) comes only from the store's owner, as **costs** kept per
store in the store's currency (`store_expenses`; a cost in another currency is refused, 400
`currency_mismatch`: nothing is converted). Members with "Manage costs" (`finance.costs`: owners and
admins, and whoever they give it to; never a shared link or an API key) add, change, pause and remove
them; members with "View gross sales, discounts, tax, shipping and total sales" (`finance.breakdown`)
see them, on the pages and as the dashboard's `expenses` module. Each change is in the audit log with
what it was before (`expense.added`, `expense.changed`, `expense.removed`, `expense.paused`,
`expense.resumed`, `expense.ended`, `expense.payment_changed`, `expense_category.*`; the description and
note, free text, are never copied into it), and each cost's page shows its history
(`GET …/expenses/:id/history`).

A cost has a name, a description, a category, how it is worked out, an amount, the currency, how
often it is paid, its start and end dates, a vendor, a payment method and notes:

- **How it is worked out** (`EXPENSE_METHODS`): a fixed amount; a percentage of each day's total sales
  (tax included), revenue before tax or net sales (`PERCENT_BASES`); an amount per order; an amount
  per item sold. The last three follow each day's sales from the start date to the end date (kept as
  `cadence` `daily`) and are never below 0 on a day refunds outweigh sales.
- **How often** an amount is paid (`EXPENSE_CADENCES`): once, every day, week, fortnight, month,
  quarter, six months or year. Only an amount paid once may be below 0 (a refund, a credit, a
  correction).
- **Categories**: the built-in ones, each in one section (`EXPENSE_CATEGORY_SECTION`), and up to 50 of
  the store's own (`expense_categories`; a cost names one `custom:<id>`), each in the section the owner
  picks. A category a cost is in can't be removed (409 `category_in_use`); renamed or moved, its costs
  go with it.

| Section | Built-in categories |
| --- | --- |
| Advertising | other paid channels, ad spend adjustment |
| Variable | shipping and delivery, pick pack and 3PL, packaging, payment and transaction fees, merchant fees, sales commissions, product cost adjustment, other variable costs |
| Fixed | rent and utilities, salaries and staff, software subscriptions, Shopify plan, Shopify apps, internet and phone, insurance, maintenance contracts, operating expenses, fixed advertising costs, other fixed costs |
| Below operating profit | loan interest, income tax, depreciation, other costs below operating profit |

Advertising counts with the variable costs in operating profit (`groupOfSection`). Synced figures
(Shopify's product costs, each ad platform's spend) are never changed: an **adjustment** is a cost of
its own (product cost adjustment, ad spend adjustment) beside the synced figure, which stays as it was
synced, so nothing is counted twice. The form says so where a cost could be: ads in a connected account
are already counted.

**Recurring payments** (`expense_entries`): each payment of a recurring amount is recorded once it falls
due (the cron sweep every 15 minutes, `recordDuePaymentsEverywhere`, and whenever the cost is saved),
one row per cost and due day (unique), so a retried sweep never records a second. A month keeps its
first payment's day of the month (31 Jan → 28 Feb → 31 Mar). Each payment can be changed (its amount,
a note) or skipped on its own, keeping what the cost said (`scheduled_amount`), and put back. A change
to a recurring cost's amount, frequency or start applies **from its next payment** by default
(`PUT …/expenses/:id?apply=next`): the cost ends the day before it and a new cost with the new terms
takes over (`replaces_id`), so no month already reported changes; `apply=all` changes every payment,
past ones too (a payment changed on its own keeps its amount). **Pause** stops payments from the next
one (`paused_from`); **resume** records those that fell due while paused as skipped; **end** (cancel)
sets the last day to the one before the next payment.

**Open days** (`store_expense_settings.operating_weekdays`, Monday = 0; empty: every day): the owner
may say which weekdays the store is open. Recurring costs are then spread over those days only (a
month's cost ÷ the month's open days; a closed day carries none; a whole month is still the whole
amount). Saved with `PUT …/expenses/settings` `{ operatingWeekdays }` (audited as
`expenses.operating_days_changed`), from the Profit sheet.

| Figure | Formula | Notes |
| --- | --- | --- |
| A cost over the dates | once: the amount, on its day; daily, weekly, fortnightly: each payment spread over the days it pays for (a weekly one a seventh a day); monthly, quarterly, six-monthly, yearly: per calendar month (quarter, half year, year), the payment due in it × its days in the dates ÷ the period's days (366 days in a leap year); a percentage or an amount per order or item: each day's own, from its sales. With open days: the open days in the dates ÷ the period's open days | Only the days from its start to its end (or on, with none). A whole month is the whole monthly amount, whatever its length; a payment recorded with another amount counts in its own period, a skipped one (or one due while paused) counts nothing. Rounded to the cent once per cost and run of consecutive days |
| Your costs | Σ of every cost over the dates, by category | Compared with the same over the dates compared with (whole days: a cost has no time of day) |
| Revenue (for net profit) | net sales + shipping + additional fees: total sales less taxes and duties | What the store kept from its sales; taxes and duties are collected for governments |
| **Net profit** | revenue − product costs (Shopify's cost of goods sold, or the items sold at their cost per item) − the connected ad accounts' spend − your costs | Given only when every input is known (below) |

Net profit is never a partial figure (`netProfit`, `ProfitGap`). It is given only when:

- the product costs are known for the dates (Shopify's profit report, `read_reports`, or else each
  product's cost per item, `product_costs`) and every sale has a cost recorded in Shopify
  (`net_sales_without_cost_recorded`, or `netSalesWithoutCost`, is 0). A member not shown
  Shopify's cost of goods sold (without "View costs and stock value": `seesModule(access, "profit")`
  is false) gets no net profit either, since it would give the cost away (`product_costs_hidden`);
- the connected ad accounts' spend is known for every day, in the store's currency. With no ad
  account connected it is 0: ads elsewhere are then among the owner's costs. An account in another
  currency is left out of the spend (Ads, "Currency"), so with one connected the spend known is only
  part of it (`costsOf`'s `adState` "partial", `adLeftOut`): the panels show that part with the "Left
  out" line, and net profit has the `ad_spend` gap. A member not shown the ads gets no net profit,
  since it would give the spend away;
- the owner has said the costs list holds every cost from a day on (`store_expense_settings.complete_from`,
  "This list holds every cost from"), and the dates start on or after that day.

Otherwise the card shows what is left of net sales after the costs it does know, says "Not net
profit" with each missing input, and links owners and admins to Settings → Costs. The figures are the
owner's own: bizinsights checks none of them against anything.

## Shopify's own reports (sessions, gross profit, the check)

Some figures only Shopify's reports can give exactly, so bizinsights asks them (ShopifyQL,
`packages/core/src/shopifyReports.ts`; needs `read_reports` and Shopify's Level 2 protected
customer data approval, docs/shopify-setup.md) instead of estimating:

| Figure | ShopifyQL | Notes |
| --- | --- | --- |
| Sessions | `FROM sessions SHOW sessions`, human sessions only | Shopify ends a session after 30 minutes idle; bot sessions are left out (`human_or_bot_session = 'human'`, Shopify's own classification) |
| Online store visitors | `online_store_visitors` | Shopify's own name and count of the different shoppers: unique over the whole range, asked for the range whole, never summed from days; people, not sessions, and not Meta's reach |
| Conversion rate | `sessions_that_completed_checkout ÷ sessions` | Shopify's formula; the funnel steps (`sessions_with_cart_additions`, `sessions_that_reached_checkout`) and `pageviews` are shown too |
| Gross profit | `FROM sales SHOW gross_profit` | Net sales − cost of goods sold, from the cost Shopify recorded with each sale. Sales with no cost recorded count at no cost in Shopify's figure, so the card shows how much (`net_sales_without_cost_recorded`) and the margin on the sales whose cost is known; with none recorded, cost of goods sold reads "Not recorded in Shopify". Not net profit: beside it the card gives Business profit overview's net profit for the same dates, or why there is none in its words |
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

## Abandoned checkouts (Shopify)

Shopify's own abandoned checkouts list, counted and added up for the dates: the card "Abandoned
checkouts (Shopify)" on the Shopping Funnel page (`GET …/abandoned-checkouts`,
`packages/core/src/shopifyCheckouts.ts`). Read from the Admin API (`abandonedCheckoutsCount`,
`abandonedCheckouts`) with `read_orders`: no ShopifyQL, so no `read_reports`. Counts, money and
dates only: no name, email, phone or address is asked for or kept.

| Figure | Definition |
| --- | --- |
| Abandoned checkouts | Shopify's count of the checkouts in its abandoned checkouts list created in the dates, on the store's days: the shopper gave an email or phone number and didn't pay. Recovered and archived ones included, as Shopify's list keeps both. Shown with a "+" when Shopify gives the count only as a lower bound (`precision: AT_LEAST`); it then has no change and no rate |
| Recovered so far | Of them, the ones Shopify marks recovered (`recovery_state:recovered`): completed later |
| Recovered rate | Recovered ÷ abandoned, both by the day the checkout was created. Keeps rising for recent dates as late recoveries come in, hence "so far": a range that just ended compares unfavourably with an older one, so its change is shown uncoloured, never as better or worse |
| Abandoned checkout value | Each checkout's total price added up (`totalPriceSet.shopMoney`: items after discounts, shipping and taxes) in the shop's currency, recovered ones included |
| Recovered value | The total price of the ones completed later (`completedAt` set) |

Not the same as two neighbouring figures, and never shown as them:

- **Left at checkout**: the web pixel's tracked visits that started a checkout and didn't complete
  it (consent-dependent, online store only), with no value and no recovery.
- **Sessions that reached checkout**: Shopify Analytics' sessions (ShopifyQL), whether or not the
  shopper ever gave contact details.

Limits, each shown in words, never as 0:

- **60 days.** Shopify puts `AbandonedCheckout` under `read_orders`, which covers what was created
  in the last 60 days ("For older orders, add `read_all_orders`", shopify.dev access scopes).
  Without `read_all_orders` (no bizinsights app asks for it yet) a window starting before the
  store's today − 59 days is never asked for: the card says Shopify shares the last 60 days of
  checkouts and from which day, and a comparison that old has no change. With `read_all_orders`
  older windows are asked for; how long Shopify keeps abandoned checkouts isn't documented
  (community posts say about three months), so an old comparison deserves care.
- **Approval.** Abandoned checkouts are protected customer data (Shopify's "Orders" category);
  without names or contact details that is Level 1, the same approval the orders import waits on.
  An app Shopify hasn't approved yet (the App Store app on live stores) gets `ACCESS_DENIED`, kept
  as `access_denied`: the card says bizinsights is waiting on Shopify's approval.
- **Value up to 2,000 checkouts a window.** The counts are Shopify's own and complete. The value is
  added up from the list, 250 a page (753 cost points) and 8 pages at most; with more checkouts
  than that, prices in more than one currency, or a price Shopify withheld, the card says why
  instead of a value, and the day-by-day chart is left out.
- **Kept, not waited for.** Kept in `shopify_reports` (dataset `abandoned_checkouts`) like the
  reports above: the same windows (5-minute marks while the range runs, the range and its
  comparison cut at the same one), the same staleness and 14 days' keep. The worker asks only
  stores that granted `read_orders` (`REPORT_SCOPE`).
- **Search lag.** Shopify's search can lag a moment behind a checkout; the chart is added up from
  the list, the totals are Shopify's counts.
- **Who sees it.** View checkout abandonment (`analytics.abandonment`). Who the shoppers were is
  "Customers to follow up" (`GET …/contacts`, its own permissions), read live and never stored.

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

- `read_orders` exposes 60 days of history. Older dates show as not imported (hatched, "Not
  imported", and a line under the dates saying from when the orders are in), never as zero sales,
  until `read_all_orders` is granted and its year-by-year import has reached them. No figure is ever
  estimated for them. A public app gets `read_all_orders` only once Shopify approves it for the scope
  (docs/shopify-setup.md), so until then no store can reach further back than its import window.
- An edit reaches the dashboard through the `orders/updated` delivery it causes (`orders/edited` isn't subscribed): its totals change, so the order's sales are read again.
- Days before the switch to Shopify's sales records keep their old totals until their orders are read again (the dashboard's refresh re-reads the 60-day import window once); older days than that keep them for good.

## Repeat customers and monthly cohorts

The Customers page's repeat purchase rate, orders and net sales per customer, and monthly
first-order cohorts with month-by-month retention: definitions, where they start
(`customersFrom`: the first whole day every order's customer is known) and who sees which figure
are in [customer-analytics.md](customer-analytics.md). All of them come from the orders held, never
estimated; a cohort month that began before customers are known is marked partial, and a month
that hasn't come has no figure.
