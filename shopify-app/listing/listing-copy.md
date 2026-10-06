# Listing copy and reviewer instructions

Paste-ready text for the App Store listing form and the review submission. Written against the
scopes the released version actually declares (`read_orders,read_products`) — see
"What must not be claimed" at the bottom before editing any of it.

Dashboard: https://dev.shopify.com/dashboard/238480582/apps/430680145921

---

## Listing

**App name**

```
Insights
```

**Tagline** (short description, shown under the name)

```
Your store's numbers in plain language — sales, orders, products and stock.
```

**Full description**

```
Insights turns your Shopify data into numbers you can act on, without a spreadsheet and
without a setup project. Connect your store and the first import starts immediately; the
dashboard is ready in minutes.

What you get

• Net sales that mean something. Gross sales, discounts and refunds are separated, so you
  see what you actually kept rather than a headline number that quietly includes money you
  gave back.
• Orders, units and average order value, each against the previous period, so a good week
  is visible as a good week.
• Refund rate, tracked as a share of sales rather than a raw total.
• Top products by revenue, after discounts.
• Inventory on hand, so a product that is about to sell out is visible before it does.
• Recent orders, with the detail you need to answer a customer without opening the admin.

Every metric is written out in plain language next to the figure, so nobody has to guess
whether "sales" means before or after refunds.

Built to stay out of your way

• Read-only. Insights never writes to your store, never edits an order and never changes a
  product.
• We ask for two permissions and no more: your orders and your products.
• We keep no customer personal data — no names, no emails, no addresses.
• Uninstall and your store is disconnected at once; its records are erased.

Free to start. Paid plans add more stores and support.
```

**Pricing** (must match `PLANS` in `apps/api/src/routes/workspaces.ts`)

| Plan | Price | Includes |
| --- | --- | --- |
| Free | $0/month | 1 store, 30 days of history, core metrics |
| Growth | $29/month | 3 stores, email alerts, API access |
| Scale | $99/month | Unlimited stores, priority support, audit log export |

All charges run through Shopify's Billing API (`appSubscriptionCreate`).

**Privacy policy URL**

```
https://insights.imeseban.workers.dev/privacy
```

**Support URL / contact**

```
https://insights.imeseban.workers.dev/support
```

> Both pages render from `apps/web/src/lib/contact.ts`, which is still **blank**. They show a
> visible "[not set]" marker until it is filled and the Worker is redeployed. Submitting
> before then fails review on requirement 4.1 (reachable support contact) and on the privacy
> policy URL.

**Screenshots** — `../../demo-screenshots/`. Shopify wants at least 1600 x 900; the current
captures are 800 x 600 to 1200 x 900, so they must be retaken at that size rather than
upscaled. One feature per image, no browser chrome, no desktop background:

| Image | Shows |
| --- | --- |
| `03-dashboard-sales` | Net sales, orders, AOV with period comparison |
| `05-fulfillment-discounts-products` | Top products by revenue after discounts |
| `06-inventory` | Inventory on hand |
| `07-recent-orders` | Recent orders |
| `10-live-dashboard` | The dashboard against a real store |

---

## Reviewer instructions

```
Insights is a read-only analytics app. It requests read_orders and read_products and writes
nothing back to the store.

Install and first run

1. Go to https://insights.imeseban.workers.dev/start
2. Enter any email address you can receive mail at. No password is needed — we email a code.
3. Click "Continue with Shopify" and approve the two permissions.
4. You are returned to the app and the first import starts automatically. It takes under a
   minute on a store with a normal order history.
5. The dashboard opens on net sales, orders and average order value for the last 30 days.
   Each figure carries a plain-language explanation and a comparison with the previous
   period. Use the date range control to change the window.

What to look at

• Sales — gross sales, discounts, refunds and net sales, separated.
• Products — top products by revenue after discounts.
• Inventory — units on hand per variant.
• Orders — the most recent orders with their totals and status.

Billing

Billing runs through Shopify's Billing API (appSubscriptionCreate). To see the charge flow:
Settings → Billing → choose Growth or Scale. Outside production this creates a test charge, so
the confirmation page appears and no money moves. The Free plan needs no charge, so the app
is fully usable without going through billing.

Data handling

• read_orders is used for the sales, refund and order figures. read_products is used for
  product names and inventory.
• We store the order, line item, refund and product records needed to compute the metrics
  above. No customer personal data is stored: a customer is held only as a keyed hash, which
  is what lets us count orders per customer without keeping names, emails or addresses.
• Shopify access tokens are encrypted at rest.
• Uninstalling triggers app/uninstalled, which immediately marks the store disconnected and
  erases its access tokens, so no further API call is possible. The store's records are
  deleted when Shopify sends shop/redact 48 hours later.
• The mandatory GDPR webhooks (customers/data_request, customers/redact, shop/redact) are
  subscribed and handled: customers/redact clears the keyed hash from that customer's orders,
  and shop/redact deletes every order, line item, refund, product, variant and metric row for
  the store.

Support: <support email from contact.ts>
Emergency contact: <name, email and phone — Dashboard field, not in the repo>
```

---

## What must not be claimed

The released version declares `read_orders,read_products` and nothing else. Two features
exist in the codebase but **cannot work on a merchant store under those scopes**, so they
must stay out of the listing, the screenshots and the reviewer instructions — a listing that
describes functionality the app does not deliver is a rejection:

- **Conversion rate, add-to-cart rate, checkout completion** (`docs/kpis.md`, "Funnel"). These
  come from the web pixel, which needs `write_pixels` and `read_customer_events`.
- **Returning customer rate**. Needs `read_customers`.

All three are protected customer data and are deliberately not declared
(`../shopify.app.toml`). `PLANS` in `apps/api/src/routes/workspaces.ts` advertised "Funnel
insights" on the Growth plan, which the billing page renders and a reviewer would see; that
string has been removed. Re-add it only alongside the scopes.

`read_orders` also exposes only 60 days of history; longer ranges fill in from the install
date onward unless `read_all_orders` is approved.
