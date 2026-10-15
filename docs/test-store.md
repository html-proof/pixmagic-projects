# One test store, no public listing

How to run bizinsights against your own Shopify test store without publishing anything, and how
to compare its numbers against third-party analytics apps installed on that same store.

Related: [shopify-setup.md](shopify-setup.md) (full app configuration), [kpis.md](kpis.md)
(formula reference), [local-dev.md](local-dev.md) (tunnelling localhost over HTTPS).

## 1. Nothing needs to be published

"Public distribution" and "published" are separate states, and only the second one involves
Shopify. The app (client id `57e9ef75…`) is on public distribution and **has never been
submitted for review**, which means Shopify installs it on **development stores in our own
Partner organization and nowhere else**. That is exactly the wanted behaviour right now, so
there is nothing to undo:

- Do **not** submit the app for review, and do not complete the App Store listing.
- Distribution is a one-way choice in the Dev Dashboard. It is already set, cannot be changed
  back to custom, and does not need to be.
- A custom-distribution app per store is the wrong tool here (it installs on exactly one store)
  and is not the product strategy — see [shopify-setup.md](shopify-setup.md) section 3c.

So the test store must be a **development store created from Partners → Stores → Add store**.
A live store, or a development store in somebody else's organization, gets Shopify's dead-end
"This installation link can't be used" page no matter what this repo does.

## 2. Pin the app to your test store

The app can currently be offered to *any* store, because `SHOPIFY_DEFAULT_APP_SHOPS` is empty
and empty means "no restriction". While only your test store should connect, name it.

In `apps/aws/src/settings.ts`, in `APP_SETTINGS`:

```ts
"SHOPIFY_DEFAULT_APP_SHOPS": "your-dev-store.myshopify.com",
```

Then merge it to `main`: the **Deploy to AWS** workflow puts it in the functions' environment
([aws-deployment.md](aws-deployment.md)). Two effects:

- Any other store is refused by our own backend with the `app_unavailable` message
  (`installApp` in [`apps/api/src/routes/shopify.ts`](../apps/api/src/routes/shopify.ts))
  instead of being handed to Shopify and dead-ending there.
- The one-click "pick a store on Shopify" handoff turns itself off and the UI asks for the
  store address instead, because letting a merchant choose only works while any store may
  install (`servesAnyShop`).

A typo in this list **fails closed**: a value that is not a `*.myshopify.com` domain leaves the
app installable nowhere, logs `SHOPIFY_DEFAULT_APP_SHOPS has no valid store`, and never
silently reverts to "any store" (`shopList` in
[`packages/core/src/apps.ts`](../packages/core/src/apps.ts), covered by
`packages/core/test/apps.test.ts`). If every store is suddenly refused, check that log line
first.

## 3. Connect it

No toml edit is needed for this path: `shopify.app.toml` already registers the app's URLs (they
take effect at Shopify with `shopify app deploy`):

| | |
| --- | --- |
| App URL | `https://d2mr8m2p1qkh58.cloudfront.net/api/shopify/launch` |
| Redirect URL | `https://d2mr8m2p1qkh58.cloudfront.net/api/shopify/callback` |
| Scopes | `read_orders,read_products` |
| Embedded | `false` (this is an external dashboard, not an admin-embedded app) |

1. Open `https://d2mr8m2p1qkh58.cloudfront.net/signup`, create an account and confirm your email.
2. On the connect page, **Continue with Shopify** (or enter the store address) and approve on
   Shopify. The workspace and store are created and the first import starts (see
   [shopify-setup.md](shopify-setup.md) section 3).
3. The dashboard fills in over the next few minutes and keeps itself current; there is no
   refresh button by design.

To add a second store later: Settings → Stores → connect, and add its domain to
`SHOPIFY_DEFAULT_APP_SHOPS`. The data model, API and UI are already per-store
(`workspaces/:ws/stores/:id/...`, store switcher in `AppContext`), so nothing else changes.

### Webhooks

Registered in `shopify.app.toml`, delivered to `/api/webhooks/shopify`: order
create/updated/paid/cancelled, `refunds/create`, product create/update/delete,
`app/uninstalled`, `app/scopes_update`, `app_subscriptions/update`, plus the three mandatory
compliance topics. Every delivery is HMAC-verified, de-duplicated by delivery id, and queued.

Webhooks are the live path; the 5-minute re-pull in `apps/api/src/sync.ts` is the safety net
that covers a missed delivery, so a dropped webhook costs freshness, never correctness.

Fire one by hand:

```bash
npx shopify app webhook trigger --topic orders/create --address https://d2mr8m2p1qkh58.cloudfront.net/api/webhooks/shopify
```

## 4. Comparing against third-party apps

Install the apps you want to compare **on the same development store, from the Shopify admin,
as ordinary apps**. Do not try to run or embed them inside bizinsights: their data is not
reachable through our access token, and an app's own numbers are only visible in its own UI.
Comparison means reading two dashboards side by side over the same date range, nothing more.

Good candidates on a dev store: Shopify's own **Analytics → Reports** (the baseline worth
trusting most), plus any two analytics apps from the App Store.

### Make the comparison fair before believing a discrepancy

Pick one date range, confirm both tools use the **store's** time zone, and expect these to
differ for reasons that are not bugs:

| Axis | What bizinsights does | Where |
| --- | --- | --- |
| Day boundaries | Buckets by `localDay(createdAt, store.timezone)`, the store's IANA zone as reported by Shopify | `packages/core/src/persist.ts:23` |
| History depth | **Last 60 days only.** `read_orders` is capped there; all history needs `read_all_orders`, which needs Shopify approval | `apps/worker/src/handlers.ts:65` |
| Gross sales | `sum(line price × qty)`, **before** discounts, **excluding** tax and shipping | `packages/shared/src/kpi.ts:7` |
| Net sales | `gross − discounts − refunds` | `packages/shared/src/kpi.ts:66` |
| Refund timing | Attributed to the day the **refund** was created, not the day the order was placed | `packages/shared/src/kpi.ts:9` |
| Cancelled orders | Excluded from order counts and sales | `packages/shared/src/kpi.ts:154` |
| AOV | `(gross − discounts) / orders`, i.e. before refunds | `packages/shared/src/kpi.ts:61` |
| Currency | `shopMoney` throughout — **shop** currency, never presentment currency | `packages/core/src/normalize.ts` |
| Sessions, funnel, conversion rate | **Not reported.** Needs the web pixel and `write_pixels` + `read_customer_events`, deliberately not requested | — |
| New vs returning | **Not reported.** Needs `read_customers`, deliberately not requested | — |

The last two are the most common source of "the other app shows more": they are scope choices,
not gaps. The dashboard reads the scopes actually granted and hides any module whose scopes are
missing, rather than showing an empty card.

The two differences that most often look like a bug and are not: **refund timing** (a refund
today against an order from last week moves money on a different day in each tool) and **gross
excluding tax and shipping** (an app reporting "total sales" from `totalPriceSet` always reads
higher).

### When a difference is real

Reconcile a single day rather than a month, in this order:

1. Compare order **counts** before money. A count mismatch is a *population* difference —
   cancelled, test or draft orders, or a day-boundary shift — not an arithmetic one.
2. Compare one order end to end: open it in the Shopify admin and check line totals, discounts
   and refunds against what the dashboard shows for that day.
3. If the stored row is wrong, recompute that day from the source ([RUNBOOK.md](RUNBOOK.md),
   "recompute") and see whether it changes. If it does, the aggregate drifted; if it does not,
   the import or the normalizer is wrong.
4. Check `grantedScopes` on the store before concluding data is missing — a field withheld for
   want of a scope comes back `null` with an errors entry, rather than failing the request.
