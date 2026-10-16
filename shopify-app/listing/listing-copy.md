# Listing copy and reviewer instructions

Paste-ready text for the App Store listing form and the review submission, written against what
the released app actually does: install grant `read_orders,read_products`, three optional scopes
(`read_customers`, `write_pixels`, `read_customer_events`) asked for one feature at a time, and no
paid plans (billing is switched off, `apps/web/src/lib/features.ts`). Read "What must not be
claimed" before editing any of it, and [README.md](README.md) for what is still Dashboard-only.

Dev Dashboard: https://dev.shopify.com/dashboard/238480582/apps/430680145921

Items marked **OWNER** are business or legal statements the owner must confirm before submitting.

---

## Listing

**App name** (30 characters max; must match `name` in `../shopify.app.toml`)

```
bizinsights
```

**App introduction** (100 characters max)

```
Your store's sales, orders, products and stock, explained in plain language.
```

**App details** (500 characters max)

```
bizinsights turns your Shopify orders and products into a dashboard anyone on your team can read.
Net sales separate gross sales, discounts and refunds, so you see what you kept. Every figure is
compared with the previous period and explained in a sentence. Top products, stock on hand and
recent orders sit on the same page. Install from Shopify and the first import starts at once. The
app only reads your data: it never changes an order or a product.
```

**Feature list** (80 characters max each)

```
Net sales with discounts and refunds shown apart, against the previous period
Orders, units and average order value for any date range you pick
Top products by revenue after discounts, and the stock left for each
Every number explained in a plain sentence, so nobody has to guess what it means
Read-only access: bizinsights never edits an order, a product or a setting
```

**Pricing** — **OWNER**: confirm before submitting.

| Plan | Price | Includes |
| --- | --- | --- |
| Free | $0 | Everything in the app |

Billing is switched off in the app (`BILLING_ENABLED = false`), so nothing can be charged and the
listing must say Free. `PLANS` in `apps/api/src/routes/workspaces.ts` still lists Growth and Scale,
but nothing enforces their limits and there is no way to downgrade or cancel yet: see
`docs/shopify-app-store-compliance.md` ("Billing") before switching paid plans on.

**Category** — Store management → Analytics (or Reporting). Tags: analytics, reports, sales.

**Languages** — English only (the UI has no other language).

**Privacy policy URL**

```
https://bizinsights.io/privacy
```

**Support** — email `sales@ikorex.com.au` (from `apps/web/src/lib/contact.ts`), support page:

```
https://bizinsights.io/support
```

**Terms of service** — `https://bizinsights.io/terms`

**Demo store URL** — optional; leave empty unless a development store with the app is opened to the public.

**Integrations** (optional, up to six) — only list ones a reviewer can complete. WhatsApp, Meta Ads
and Google Ads need the merchant's own accounts and, for Meta and Google, platform approvals that
are still pending (see the compliance doc), so leave them out of the first submission.

**Screenshots** (3 to 6, 1600 x 900, desktop, alt text on each): the real production UI at
`https://bizinsights.io` on a development store with demo data — never a mock-up, a logo, browser
chrome, pricing, reviews or a customer's personal data. One feature per image:

| # | Shows | Alt text |
| --- | --- | --- |
| 1 | Dashboard: net sales, orders, average order value, with the period comparison | Dashboard with net sales, orders and average order value compared with the previous period |
| 2 | Sales breakdown: gross sales, discounts, refunds, net sales | Breakdown of gross sales, discounts and refunds into net sales |
| 3 | Top products by revenue | Top products by revenue after discounts |
| 4 | Inventory on hand | Stock left for each product variant |
| 5 | Recent orders | The most recent orders with totals and status |

`../../demo-screenshots/` no longer exists; take new captures (see README, "Screenshots").

---

## Reviewer instructions (the "Testing instructions" field)

```
bizinsights is a read-only analytics dashboard. It is not embedded in the Shopify admin: it opens
at https://bizinsights.io, with its own login.

Install
1. Install the app from the listing. Shopify asks you to approve read access to orders and
   products; approve it.
2. The app authorizes at once and opens on "<your store> is connected". The first import has
   already started.
3. Sign in with the test account below (or choose "Create account" and confirm your email with
   the 6-digit code we send), then click "Add store and open dashboard".
4. The import progress page shows orders, products and inventory arriving; it takes a minute or
   two on a store with demo data. Then open the dashboard.

What to look at
- Dashboard: net sales, orders and average order value for the last 30 days, each compared with
  the previous period and explained in a sentence. Change the date range at the top.
- Sales: gross sales, discounts, refunds and net sales.
- Top products, inventory on hand, recent orders.
- "More insights you can unlock": optional features that need extra Shopify permissions. Clicking
  Enable asks Shopify for that one permission.

Reinstall and uninstall
- Opening the app again from the Shopify admin goes straight to the dashboard.
- Uninstalling deletes our access token immediately. Reinstalling authorizes again and re-imports.
- 48 hours after an uninstall Shopify sends shop/redact and we erase everything about the store.

Billing
- The app is free; there is nothing to buy.

Test account (OWNER: create it on bizinsights.io and fill in before submitting)
- Email: <reviewer account email>
- Password: <password>

Data handling
- read_orders: sales, refunds and order figures. read_products: product names and stock.
- We store order, line item, refund and product records. No customer name, email or address is
  stored with them: a customer is kept only as a keyed hash, which lets us tell new customers from
  returning ones.
- Shopify access tokens are encrypted at rest (AES-256-GCM).
- customers/data_request: the store owner downloads that customer's data from Settings, Privacy
  requests. customers/redact: we delete what we hold about the customer. shop/redact: we erase
  the store.

Support: sales@ikorex.com.au
```

**Emergency developer contact** (Dashboard field) — **OWNER**: a name, email and phone that are
answered.

---

## Protected customer data request (Dashboard → API access)

Level 1 is required for `read_orders`. Suggested answers:

- **Why the app needs it**: to compute sales, refunds, orders and average order value for the
  merchant's own dashboard.
- **Data minimisation**: no customer name, email, phone or address is stored with the orders; the
  customer id is kept only as a keyed HMAC so new and returning customers can be counted.
- **Retention**: kept while the app is installed; tokens destroyed at uninstall; everything erased
  on shop/redact; customers/redact and customers/data_request handled as described above.
- **Encryption**: tokens and the few personal fields the optional WhatsApp feature keeps are
  encrypted with AES-256-GCM; data in transit uses TLS; the database is encrypted at rest (RDS).
- **Access**: workspace members only, by role; Postgres row-level security isolates each merchant.

Level 2 (name, email, phone) is only needed for the optional "Customers to follow up" card,
which reads them from Shopify on demand and never stores them. Request it only if that card is
part of the submission; otherwise leave it out of the listing.

---

## What must not be claimed

- **Conversion rate, add-to-cart rate, checkout completion** (`docs/kpis.md`, "Funnel"). These
  come from the web pixel, which needs the optional `write_pixels` and `read_customer_events`
  scopes and protected customer data approval. They may be described only as optional, after
  that approval.
- **Returning customer rate** needs the optional `read_customers`; same rule.
- **Paid plans, email alerts, API access**: billing is off and the API keys page is hidden.
- **WhatsApp, Meta Ads, Google Ads, email automations, staff and payroll**: they exist in the app,
  but a reviewer cannot complete them without third-party accounts and approvals the app does not
  have yet. Keep them out of the listing until each one works end to end for any merchant.
- No statistics, guarantees or superlatives ("the best", "increase sales by").

`read_orders` exposes the last 60 days of orders only; longer ranges fill in from the install date
onward unless `read_all_orders` is approved.
