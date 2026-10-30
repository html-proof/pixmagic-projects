# Repeat customers and monthly cohorts

The Customers page (`/dashboard?view=customers`) has two panels under "Returning customers":
**Repeat customers** and **Monthly cohorts**. Both are read from the orders bizinsights holds,
never estimated: a figure that can't be known says why, and a month that hasn't come has no cell.
Nothing here is a forecast; "lifetime" means "so far".

- Code: `packages/shared/src/customers.ts` (the arithmetic, `cohortGrid`, `customerHistoryStart`),
  `packages/core/src/reports/customers.ts` (`customerAnalytics`, the queries),
  `apps/api/src/routes/customerAnalytics.ts`, `apps/web/src/components/dashboard/CustomerCohorts.tsx`.
- Endpoint: `GET /workspaces/:ws/stores/:storeId/analytics/customers` with the dashboard's date
  query (`preset`, `from`, `to`) and `months` (1 to 24, default 12: first-order months listed).
- Tests: `packages/shared/test/customers.test.ts`, `apps/api/test/customerAnalytics.test.ts`.

## Who sees what

| Needs | Gets |
| --- | --- |
| "View returning vs new customers" (`customers.analytics`), and a store that granted orders and customers (the `customers` capability: `read_orders` + `read_customers`) | Customers, repeat customers, repeat purchase rate, cohort sizes and month-by-month retention, where customers start (`customersFrom`) |
| ... and "View sales and revenue" or "View order list" | Orders per customer, orders without a known customer, where the imported orders begin and how older ones can be had (`historyFrom`, `historyAccess`, `customersLater`), as the dashboard's own `data` is cut (`redactOverview`) |
| ... and "View sales and revenue" | Net sales per customer (otherwise customers × net sales per customer would be the store's net sales) |

Without the permission: 403 `forbidden`. Without the scopes: 403 `missing_scope`. Another
workspace's store: 404, before the query is read.

## Definitions

Each customer is counted once, by the keyed hash on their orders (`orders.customer_key`, written
only when the store granted `read_customers`; customers themselves are never stored). Orders of
gift cards only are left out, and a customer who bought only gift cards isn't one, as in Shopify's
customer reports. Cancelled orders count as orders (order history), as Shopify counts them and as
the returning-customer flag does.

| Figure | Definition |
| --- | --- |
| Repeat purchase rate (these dates) | Customers with two orders or more in the dates ÷ customers who ordered in the dates. Not the returning customer rate above it, which asks whether a customer had *ever* bought before |
| Orders per customer (these dates) | Those customers' orders in the dates ÷ customers |
| Net sales per customer (these dates) | Net sales of those orders as they stand now ÷ customers |
| Orders without a known customer | Orders in the dates with no customer: guest checkouts, deleted or redacted customers |
| Customers who first bought since {day} | Customers whose first purchase ever is in the cohorts listed. Repeat purchase rate: those with a second order so far; orders and net sales per customer: everything they ordered so far |
| Cohort | The store-local calendar month of a customer's first purchase ever |
| Month 0 / Month n | Month 0 is the cohort's own month, counting only orders after the first one; month n is the n-th calendar month after it. As Shopify's cohort report: "period 0" holds returning orders in the period of the first order |
| Retention (a cell) | Customers of the cohort who ordered in that month ÷ the cohort's customers; "—" for a cohort without customers. The current month is marked "so far" |
| Net sales per customer to date (a cell) | Net sales of the cohort's orders up to the end of that month, first orders included, ÷ the cohort's customers |
| Customers back from before | Customers who ordered in the cohorts' months but first bought before them: in no cohort, never counted as new |

**Net sales** here is the dashboard's net sales taken order by order: the order's product and
adjustment sales lines, after discounts and returns, before tax and shipping, with returns made
since taken off (counted in the month of the order, not of the return). Shopify's cohort report
offers "amount spent per customer", which includes tax and shipping: ours is labelled net sales and
differs from it by those. Net sales per customer is withheld (null, with the number of orders it is
waiting for, `salesPending`) while any counted order's sales haven't been read from Shopify yet,
rather than shown from a partial sum.

**First purchase.** An order is a customer's first purchase when Shopify counts it so:
`orders.is_returning_customer` false, settled by `settleReturningCustomers` (core `persist.ts`) from
the orders held and Shopify's own position of the order (`customer_order_index`, or the customer's
lifetime order count without one). So a customer whose first order is older than the imported
orders is known to be returning even with 60 days imported, and goes into "back from before", not
into a cohort. A webhook-only order without a position can briefly look like a first purchase until
it is read again; Shopify's position follows creation, not processing, so imported or offline POS
orders can differ by a few.

## Where it starts (`customersFrom`)

Customers are counted from the first store-local day on which every order's customer is known
(`customerHistoryStart` in @app/shared):

1. The first whole imported day: the day after the one the import window started on
   (`firstWholeDay` of `stores.orders_history_from`); with the full history, the first order's day.
2. Orders say who placed them only once the store granted `read_customers`. Granting it later
   re-reads Shopify's last 60 days, from a moment part way through a day; older orders stay without
   a customer. So when orders since that whole day went without a customer
   (`daily_store_metrics.orders = 0` with customers before the first day with
   `orders_with_customer > 0`), customers start on that first day, or the day after when some of its
   orders have none. Guest checkouts look the same, so a store whose first days had guest orders
   only starts a few days late: later, never earlier, than the truth.

A store that gave `read_customers` back and granted it again more than 60 days later has orders
without a customer in between: the cohorts of those months are smaller than they were, and their
customers' later orders count as "back from before" (Shopify's position still says they bought
before). Nothing marks those months yet.

Dates on screen that begin earlier are counted from `customersFrom` (`dates.clamped`); dates that
end before it have no figures (`dates: null`), which the page says is not the same as no
customers. The cohort whose month began before `customersFrom` is marked partial ("from {day}"):
its earlier first buyers aren't in it.

**History depth.** No app declares `read_all_orders` yet (docs/shopify-setup.md), so a store holds
Shopify's 60 days before it connected plus everything since: a cohort table shows 2 to 3 months at
first and gains one a month. The page says so, with the store's history access
(`historyAccess`: requestable, reconnect, or waiting for Shopify's approval). Once
`read_all_orders` is granted the full history is imported (with each order's customer, the store
holding `read_customers`) and the cohorts reach back at once, 24 months at most.

**Redacted customers.** `customers/redact` removes the hash from every order of the customer
(named by id, or by the orders it lists) and the days are counted again, so they drop out of every
figure here at once and out of the day totals once the aggregate runs.

## Cost

Computed when the Customers page opens and every 5 minutes while it is open, never in the
dashboard's 15-second poll. Every query filters workspace and store (RLS is the backstop) and is
bounded by the store's days (`orders (store_id, local_day)`). On a local Postgres 18 with the
default `work_mem` (4 MB), a store of 300,000 orders over 24 months, all of them in the cohorts
(the worst case), took about 1.5 s for 24 months with net sales (2.3 s before the net sales were
summed per cell instead of per order) and 0.2 to 0.4 s for 12 months; the dates' figures for 12
months about 0.45 s. If big stores make this slow, the next steps are an index on
`orders (store_id, customer_key, local_day)` (a migration) and then a cohort table kept by the
aggregate queue.
