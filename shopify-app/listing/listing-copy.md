# Listing copy and reviewer instructions

What the App Store listing of the **App Store app** says, as saved in the listing form on 2026-10-18.
Every claim was checked against the code at main 1daf7c3 and against Shopify's form limits. Read
"What must not be claimed" before changing any of it, and [README.md](README.md) for what is still
missing before the app can be submitted.

- Listing form: https://apps.shopify.com/services/partner-app-submissions/658431ae6a22c880e0ab2a0e2040a28a/en
- Submission checklist: https://partners.shopify.com/5229240/apps/436203126785/distribution/app-store
- Dev Dashboard (icon, versions): https://dev.shopify.com/dashboard/238834824/apps/436203126785/settings
- Config: [../shopify.app.public.toml](../shopify.app.public.toml) (client id 658431ae…, never the main or PixMagic app)

The app as reviewed: install grant `read_orders,read_products`, non-embedded (its own tab and login),
free (billing is off, `apps/web/src/lib/features.ts`), no order or refund webhooks until protected
customer data access is granted, and the last 60 days of orders (`read_all_orders` not requested).

---

## Basic app information

| Field | Value |
| --- | --- |
| App name (30) | `bizinsights` (matches `name` in the toml) |
| Primary category | Store management › Operations › Analytics |
| Category details | Visuals and reports: Analytics dashboard. Customer behavior and Marketing and sales: not applicable (their tags need the optional scopes or don't exist). |
| Languages | English |

## Listing content

**App introduction** (100)

```
Track sales, orders, top products and stock in one place. See which areas need attention first.
```

**App details** (500)

```
Turn your orders and products into a dashboard your team can follow. Total sales, net sales, orders and value per order are built from Shopify's sales records, compared with the previous period or dates you pick, and explained in plain words. Top products, low stock, discount codes, sales channels and busiest times each open as a report you can save as CSV. History starts with recent orders and grows over time. bizinsights opens in its own tab, with its own login, and installs read-only.
```

**Features** (5, 80 each)

```
Break total sales into gross sales, discounts, returns, shipping and taxes
Compare your dates with the period before or with dates you choose
Get a one-sentence summary and a health check of each area of your store
Spot top products, low stock, unshipped orders and your busiest days and hours
Invite your team by email with a role and the permissions each person needs
```

The form's automatic review tips flag "best" and "average" as unverifiable claims, even inside
"best sellers" and "average order value". That is why the copy says "top products" and "value per
order". The testing instructions keep the app's real labels.

**Feature media**: image, 1600 x 900, the dashboard's main area (headline cards and the two daily
charts) without the top bar, so no store name and no Shopify bag icon. Alt text: `Dashboard of
sales, orders and average order value over 30 days`.

**Desktop screenshots** (1600 x 900, alt text 64):

| # | Shows | Alt text |
| --- | --- | --- |
| 1 | Sales panel, "How your total sales add up" | Sales breakdown: gross sales, discounts, returns and net sales |
| 2 | Best sellers panel, top vendors | Best-selling products and top vendors ranked by net sales |
| 3 | Stock panel, restock soon | Stock levels with low-stock and sold-out items to reorder |
| 4 | Recent orders panel | Recent orders with channel, payment and fulfillment status |
| 5 | Team & Access members list | Team & Access page with roles and permissions for each member |

A full dashboard screenshot was removed because it repeated the feature image (requirement 4.4.5).
The images are not in the repo. They were captured from the real UI at main 1daf7c3, built and run
locally against a throwaway Postgres holding an invented store ("Harbour & Pine Co.", AUD,
fictional names on the reserved `.example` domain): headless Chromium, 1600 x 900, reduced motion,
every request leaving the machine blocked. Never capture a live merchant's store.

**Support and resources**

| Field | Value |
| --- | --- |
| Preferred support channel | Support email |
| Support email | `sales@ikorex.com.au` (`apps/web/src/lib/contact.ts`) |
| Support portal | https://bizinsights.io/support |
| Privacy policy | https://bizinsights.io/privacy |
| Developer website, FAQ | left empty: the homepage still promises live updates the App Store app doesn't have (see README) |
| Integrations | none (Meta, Google and WhatsApp need approvals a reviewer can't complete) |

## Pricing

Manual pricing (legacy), one public plan. Not Shopify App Pricing: opting in would stop the Billing
API charges the paid-plan code uses (`appSubscriptionCreate`).

| Handle | Billing | Display name | Top features (40 each) |
| --- | --- | --- | --- |
| `free` | Free | Free | Sales, orders and stock dashboard · Comparisons with earlier periods · Plain-language summaries · CSV download and printable reports · Team roles and permissions |

Never list Growth or Scale (`PLANS` in `packages/core/src/billing.ts`) while billing is off.

## Discovery

| Field | Value |
| --- | --- |
| App card subtitle (62) | `Understand your sales, orders and stock in plain language` |
| Search terms (5, 20 each) | analytics · sales report · dashboard · store performance · reporting |
| Title tag (60) | `bizinsights: sales, orders and stock in plain language` |
| Meta description (160) | `See your store's total and net sales, orders, top products and low stock, compared with earlier periods and explained in plain sentences.` |

## Install requirements and contact

- Sales channel: "My app doesn't require the Shopify Online Store or Shopify POS". Orders from
  every channel are counted; only the optional Shopping funnel needs a storefront.
- Geographic requirements: none (each store is reported in its own currency).
- Merchant review email and app submission email: `sales@ikorex.com.au`. Allow `noreply@shopify.com`.

---

## Testing instructions (2,800 max)

```
bizinsights is a free, read-only sales and stock dashboard. It is not embedded in the Shopify admin: it opens in its own browser tab at bizinsights.io with its own login (see Test account).

Before you start
- Install only from this listing or our install link. Until approval, the connect buttons inside bizinsights.io (Continue with Shopify, Connect a store, Reconnect) go through our earlier app and can't install on your store.
- Test orders (Bogus Gateway, test mode) are left out, as in Shopify's reports. Create orders in the admin instead: Orders > Create order > Collect payment > Mark as paid.
- Shopify shares the last 60 days of orders with the app.

1. Install the app and approve read access to orders and products. bizinsights opens on "<your store> is connected" (if the admin shows "Open bizinsights", click it). The import has already started.
2. Click Sign in, use the test account, then click "Add store and open dashboard".
3. The import page counts orders, products and inventory. Click "Go to dashboard".
4. Dashboard: Total sales, Orders, Average order value and Total products sold with a % change and daily charts. If the earlier period has no sales (for example all orders were made today), the change reads "No earlier data"; that is expected. Click the "Last 30 days" chip (Today, Last 7 days, This month, Pick dates) and the "vs Previous period" chip (Previous year, Pick dates).
5. Click an area card (Sales, Best sellers, Stock, Recent orders, Discount codes, Sales channels, Busiest times, Shipping). Each panel opens with "In short" and ends with "What these numbers mean"; "What you could do next" appears when the numbers suggest an action. "Download CSV" saves the section shown and "Print or save as PDF" prints it.
6. Team & Access > Invite Member: enter an email you can open and pick a role. The invitation shows its delivery status, and its link opens a view-only dashboard.
7. Create another paid order, then Settings > Shopify > Sync now. It appears in Recent orders (or within about 5 minutes while the dashboard is open).
8. Uninstall: the access token is deleted at once, and shop/redact erases the store's data. Reinstalling authorizes again and re-imports.

Not in this listing: the optional "More insights you can unlock" cards (each asks Shopify for an extra permission), and the WhatsApp, Staff, advertising and email modules, which need the merchant's own third-party accounts.

Data: read_orders and read_products only. The reports store no customer name, email, address or phone. Tokens are encrypted (AES-256-GCM). customers/data_request appears in Settings > Privacy requests; customers/redact and shop/redact are handled.

Support: sales@ikorex.com.au
```

Delete the "Not in this listing" paragraph once those modules are hidden from App Store installs,
and the first "Before you start" bullet once `SHOPIFY_INSTALL_APP` is `public`.

**Test account** (OWNER): a bizinsights login created at https://bizinsights.io/signup with email
and password (no Google sign-in, no two-factor), typed into the form's Username and Password
fields. Sign in with it on the day you submit. If you connect a development store to it first, do
it by installing this app from its install link, never with the in-app connect buttons.

**Screencast URL** (OWNER): 3-8 minutes in English, on YouTube (unlisted) or a direct video file:
not Google Drive or Vimeo. Show install on a development store, "is connected", sign-in, the import,
the dashboard and the panels above, Sync now, uninstall and reinstall. Leave out WhatsApp, Staff,
advertising, email and the "More insights you can unlock" Enable flows.

---

## Protected customer data request (API access requests)

`read_orders` is protected customer data (Level 1). Without approval Shopify returns no order data
on live stores and refuses the order and refund webhook topics. Suggested answers, corrected
against the code:

- **Purpose**: the merchant's own sales reporting: total and net sales, orders, value per order,
  returns, discount codes, sales channels, order timing and orders waiting to ship.
- **Minimum data**: orders are stored with no customer name, email, phone, address or customer
  identifier. A `customers/data_request` from Shopify is recorded with that customer's Shopify id
  and hashed contact details until it is answered and redacted.
- **Retention**: until the merchant disconnects the store (deleted at once) or uninstalls
  (token deleted at once, everything erased on `shop/redact` 48 hours later); `customers/redact`
  and `customers/data_request` handled.
- **Encryption**: access tokens AES-256-GCM; database encrypted at rest (Amazon RDS, Sydney); TLS.
- **Access**: members of the merchant's workspace by role and per-area permission, plus view-only
  invitation links an owner or admin issues to a named email (expire within 60 days, revocable,
  every open logged); Postgres row-level security per workspace.

The organisation questions (staff access, incident response, policies) are the owner's to answer.
Level 2 (name, email, phone) is needed only for the optional "Customers to follow up" card.

---

## What must not be claimed

- **Real-time or live updates.** The App Store app has no order or refund webhooks until protected
  customer data access is granted: orders arrive by the import, Sync now, the 5-minute refresh
  while the dashboard is open, and the nightly reconcile.
- **Conversion, add-to-cart, checkout completion, sessions, new vs returning customers.** They need
  the optional scopes (`write_pixels`, `read_customer_events`, `read_customers`) and protected
  customer data approval.
- **Profit, costs, margin, "Ask" or AI answers.** The landing page shows these as illustrations
  only; the app has none of them.
- **Long history or year-on-year from day one.** Without `read_all_orders` the import covers 60
  days; earlier comparisons read "No earlier data".
- **A full data export.** "Download CSV" saves the section on screen (top 5 products, up to 10
  low-stock items, the 10 latest orders), not the store's data.
- **Paid plans, email alerts, API access**, and the **WhatsApp, Meta Ads, Google Ads, AdSense,
  email automation, staff and payroll** modules: billing is off, the API keys page is hidden, and a
  reviewer can't complete the third-party flows.
- No statistics, guarantees or superlatives, and no "best" or "average" in the listing text.
