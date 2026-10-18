# Shopify App Store compliance

Each requirement in Shopify's [App Store requirements](https://shopify.dev/docs/apps/launch/shopify-app-store/app-store-requirements)
(read 2026-10-16) that applies to bizinsights, what the app does about it, and the evidence. Re-check
this page before every submission: Shopify changes the list, and so does the app.

Status: **PASS** (met, with the evidence given), **FIXED** (met since the change named), **OWNER**
(needs a person in the Dev Dashboard or a business decision), **REVIEW** (can only be judged by
using the live app or by Shopify's reviewer), **N/A** (does not apply to this kind of app).

The app is **public, non-embedded** (`embedded = false`): merchants use https://bizinsights.io with
its own login. Shopify staff confirmed on 2026-08-24 that "fully non-embedded public apps are still
allowed in the Shopify App Store" and that App Bridge and requirements 2.2.2/2.2.3 don't apply while
the app stays non-embedded ([thread](https://community.shopify.dev/t/non-embedded-shopify-apps-still-allowed/27111)).
Embedding it would mean session-token auth for every API route and an App Bridge front end: a
project of its own, not needed for review. The admin may still frame the app URL; the launch then reopens itself as the
whole tab (docs/shopify-setup.md, "refused to connect" inside the admin).

## 1. Policy

| Req | What it asks | Status | Evidence | Action |
| --- | --- | --- | --- | --- |
| 1.1.1 | Embedded apps use session tokens, work without third-party cookies | N/A | `shopify-app/shopify.app.toml`: `embedded = false` | Becomes required if the app is ever embedded |
| 1.1.2 | Orders go through Shopify checkout | N/A | The app reads orders; it sells nothing | |
| 1.1.4 | No falsified data | PASS | Metrics come from the store's own orders; a metric without data shows "—"/"N/A" or a locked module, never a placeholder (`packages/core/src/reports/overview.ts`: modules only when their scopes are granted) | |
| 1.1.3, 1.1.5-1.1.16 | Themes, duplicates, marketplaces, payments, POS, buyer charges, shipping, browser extensions, desktop apps, product data, agencies, refunds, lending | N/A | None of these features exist | |
| 1.2.1 | Charges only through Shopify App Pricing / Billing API | PASS | No charges: billing is off (`BILLING_ENABLED` in `apps/web/src/lib/features.ts`, and the API's own setting, which refuses to start one: `apps/api/test/billing.test.ts` "no charge can be started"). The only charge path is `appSubscriptionCreate` (`apps/api/src/routes/workspaces.ts`) | |
| 1.2.2 | Accept/decline, re-approval on reinstall | FIXED (billing off) | Every plan change goes through Shopify's approval page and counts only once Shopify reports the charge active. Before: a plan billed on a store could stay in force after the app was uninstalled from it (Shopify needn't send `app_subscriptions/update` to an app that is gone), so a reinstall skipped approval. Now `app/uninstalled` and a store coming back both put it on Free (`apps/worker/test/billing.test.ts`, `apps/api/test/billing.test.ts` "a store back after an uninstall…") | |
| 1.2.3 | Upgrade and downgrade without support | FIXED (billing off) | Before: no way back to Free, and an upgrade could put a second charge on another store's bill. Now "Switch to Free" (`appSubscriptionCancel`) and plan changes that replace the charge in force (`APPLY_IMMEDIATELY`, same store's bill) from Settings → Billing (`billing.test.ts` "upgrades and downgrades…", "switching to Free"; e2e `settings.spec.ts` "…switches to Free…") | |
| 1.3.1 | No incentives for reviews | PASS | The app never asks for an App Store review. (The WhatsApp "review request" is the merchant asking *their* customers to review *products*.) | |

## 2. Functionality

| Req | What it asks | Status | Evidence | Action |
| --- | --- | --- | --- | --- |
| 2.1.1-2.1.3 | No critical or minor errors, operable UI | REVIEW | Unit, integration and e2e suites in CI; live walk-through needed after each deploy | Walk the reviewer path on a dev store before submitting |
| 2.1.4 | Synced data is accurate | REVIEW | Webhooks (orders, refunds, products) keep data current, idempotent and order-safe (`apps/worker/src/handlers/webhooks.ts`); a daily reconcile re-pulls recent orders. **On AWS the schedules are off** (`AWS_SCHEDULES` GitHub variable unset), so the daily reconcile and the stuck-import reaper don't run | OWNER: turn schedules on (the cutover plan) |
| 2.2.1 | Uses Shopify APIs | PASS | Admin GraphQL API for every read | |
| 2.2.2, 2.2.3 | Consistent embedded experience, latest App Bridge | N/A | Non-embedded (see top) | |
| 2.2.4 | GraphQL Admin API only (new public apps since 2025-04-01) | PASS | One Admin API endpoint in the codebase: `https://${shop}/admin/api/${version}/graphql.json` (`packages/core/src/shopify.ts`). Other Shopify URLs are OAuth (`/admin/oauth/authorize`, `/admin/oauth/access_token`) and install links. All 25 GraphQL documents validate against the 2026-10 schema (script below) | |
| 2.2.5-2.2.9 | Admin extensions, max modal, Sidekick | N/A | None (the one extension is a web pixel) | |
| 2.3.1 | Installed only from Shopify surfaces; never ask for the myshopify.com address | FIXED | The address field used to sit one click under "Continue with Shopify" on onboarding and Settings → Shopify. It now appears only when the API answers `shop_required` (only if `SHOPIFY_DEFAULT_APP_SHOPS` limits the main app to named stores; empty in production) (`apps/web/src/app/onboarding/page.tsx`, `apps/web/src/components/ShopifyConnect.tsx`; e2e "Shopify is connected from Settings…") | |
| 2.3.2 | OAuth immediately after install, before any other step | FIXED | Before: a merchant installing from Shopify landed on sign-up, and OAuth ran only after they made an account. Now `/api/shopify/launch` sends any store without a working token straight to Shopify's authorize URL (`apps/api/src/routes/shopify.ts`; `apps/api/test/shopifyInstall.test.ts` "authorizes at once, with nobody signed in") | |
| 2.3.3 | Redirect to the app UI after the merchant approves | FIXED | The callback stores the token, starts the import and opens `/claim` ("<store> is connected"), then the dashboard once the merchant signs in (`shopifyInstall.test.ts` "stores the token… and opens the app") | A bizinsights login is still needed to see data: give the reviewer a test account (4.5.4) |
| 2.3.4 | OAuth again on reinstall | FIXED | A store that is uninstalled, holds no token, or whose token Shopify refuses (401/403) is authorized again on launch (`shopifyInstall.test.ts` "authorizes again on reinstall…", "…when Shopify refuses the token it holds"). A store uninstalled from an account goes back to it only when that account's store manager is the one reinstalling; anyone else gets a fresh workspace ("doesn't hand a store back…") | |

## 3. Security

| Req | What it asks | Status | Evidence | Action |
| --- | --- | --- | --- | --- |
| 3.1.1 | Valid TLS | PASS | `bizinsights.io`: Amazon RSA 2048 M04 certificate, valid to 2027-05-01; HSTS `max-age=31536000; includeSubDomains`; checked 2026-10-16 | |
| 3.2.1-3.2.5 | Special scopes only when needed | PASS | Not requested: install grant is `read_orders,read_products`; `read_all_orders` is not asked for | |

## 4. Listing

| Req | What it asks | Status | Evidence | Action |
| --- | --- | --- | --- | --- |
| 4.1.1 | Same name in Dashboard and listing | PASS | `name = "bizinsights"` in the toml; listing uses the same | |
| 4.1.2 | Unique name | OWNER | | Search the App Store for similar names ("BizInsights", "Biz Insights") before submitting |
| 4.2.1-4.2.3 | Complete pricing, none in images | PASS | Free; the icon has no text (`shopify-app/listing/README.md`) | |
| 4.3.2 | Accurate languages | PASS | English only | |
| 4.3.3-4.3.8 | No unsubstantiated claims, reviews, accurate tags | PASS | `shopify-app/listing/listing-copy.md` ("What must not be claimed") | |
| 4.4.1-4.4.3 | Subtitle, details, Shopify brand use | PASS | `listing-copy.md` | |
| 4.4.4, 4.4.5 | Real UI images, no duplicates | OWNER | Screenshots must be taken from production on a dev store (README, "Screenshots") | Take 3-6 at 1600 x 900 |
| 4.5.1, 4.5.2 | Sales channel config | PASS | No sales channel configuration | |
| 4.5.3 | Demo screencast | OWNER | Script in README | Record it |
| 4.5.4, 4.5.5 | Working test credentials | OWNER | Reviewer instructions in `listing-copy.md` | Create the reviewer account, put it in the form |
| 4.5.6 | Emergency developer contact | OWNER | | Dev Dashboard field |
| Icon | 1200 x 1200, no text | PASS | `shopify-app/listing/app-icon-1200.png` (mark 820 px, 190 px margin) | |
| Privacy policy | Public URL describing real practices | PASS | https://bizinsights.io/privacy (200), updated for the privacy request export | OWNER: legal review of the wording |

## 5. Category-specific

| Req | Status | Note |
| --- | --- | --- |
| 5.1.x Online store | N/A | No theme changes or storefront widgets. The optional web pixel is a Shopify web pixel extension (sandboxed; no theme code) |
| 5.2-5.11 | N/A | Not a payment, purchase option, sourcing, checkout, sales channel, post-purchase, app builder, donation or blockchain app |

## Mandatory compliance webhooks and privacy

[privacy-law-compliance](https://shopify.dev/docs/apps/build/compliance/privacy-law-compliance): every
App Store app must handle `customers/data_request`, `customers/redact` and `shop/redact`, answer an
invalid HMAC with 401 and a valid request with 2xx, and act within 30 days.

| Check | Status | Evidence |
| --- | --- | --- |
| Subscribed | PASS | `compliance_topics` in both tomls, `uri = https://bizinsights.io/api/webhooks/shopify` |
| HMAC verified, 401 when invalid | PASS | `apps/api/src/routes/webhooks.ts` (timing-safe, raw body); tests `shopify.test.ts` "rejects missing or forged signatures", `security.test.ts`, `hardening.test.ts` (a signed body can't be replayed as another topic or shop) |
| 200 on success, idempotent | PASS | Unique webhook id; redelivery answered 200 `duplicate` (`shopify.test.ts`) |
| `customers/data_request` | FIXED | Before: only an audit entry; nothing reached the store owner. Now recorded once per Shopify request (keyed hashes only, `data_requests` table with RLS), owners and admins are alerted (email + in-app alert), and they download the customer's data from Settings → Privacy requests (`packages/core/src/privacy.ts`; `apps/worker/test/worker.test.ts`, `apps/api/test/privacy.test.ts`) |
| `customers/redact` | PASS | Unlinks the customer hash from orders, deletes WhatsApp and email records, and now the matching data requests |
| `shop/redact` | FIXED | Before: erased data even for a store installed again since, and kept the store row. Now skipped for a reinstalled store, proven by Shopify still accepting its token (2026-10-18: going by status left three closed review stores' data in place); otherwise deletes all data, the store row, its jobs, alerts and requests, and a workspace nobody claimed (`worker.test.ts` "GDPR: …") |
| Protected customer data | OWNER | Request Level 1 in the Dev Dashboard before submitting (answers in `listing-copy.md`). The optional scopes in the toml are protected data: remove them if approval hasn't landed by submission day |

## Billing (before paid plans are switched on)

Billing is off, and the listing must say Free. What is in place for when it goes on
(`packages/core/src/billing.ts`, the routes in `apps/api/src/routes/workspaces.ts`, the webhooks
in `apps/worker/src/handlers/webhooks.ts`; how it works: [shopify-setup.md](shopify-setup.md#4-billing)):

| Piece | Evidence |
| --- | --- |
| Approval for every charge; the plan changes only when Shopify reports the charge active | `apps/api/test/billing.test.ts` "asks Shopify for a charge…" |
| Upgrade or downgrade between paid plans replaces the charge in force (`replacementBehavior: APPLY_IMMEDIATELY`), on the same store's bill | "upgrades and downgrades between paid plans…" (one active charge at the end) |
| Downgrade to Free: "Switch to Free" for owners, `appSubscriptionCancel(prorate: true)`, plan ends at once | "switching to Free" (6 cases), e2e `apps/web/e2e/settings.spec.ts` |
| Uninstall ends the plan billed on that store; a reinstall starts on Free and asks for approval again | `apps/worker/test/billing.test.ts`, `billing.test.ts` "uninstalling and reinstalling" |
| Test charges on development stores, also in production (Shopify's reviewers use one) | `shop.plan.partnerDevelopment` in the subscribe route |
| Plan features are true: the one difference between plans, the store limit (Free 1, Growth 3, Scale any), is enforced; claims with nothing behind them ("30 days of history", "Email alerts", "API access", "Priority support", "Audit log export") were removed from `PLANS` | `billing.test.ts` "store limits" |
| Nobody can be charged, and nobody is limited, while billing is off | `billing.test.ts` "while paid plans are switched off" |

To launch paid plans (owner):

1. Decide the plans and prices. If a plan should offer more than its store limit, build and
   enforce that first, then list it in `PLANS`: the billing page is part of what the reviewer reads.
2. Set `BILLING_ENABLED` to `true` in `apps/web/src/lib/features.ts` and to `"1"` in
   `apps/aws/src/settings.ts`, in the same pull request.
3. List the plans in the Dev Dashboard listing (pricing must match `PLANS`).
4. On a development store, after the deploy: choose Growth and approve it, upgrade to Scale,
   switch back to Free, uninstall and reinstall (the plan must be Free and ask for approval again).

A store that was in a workspace already never counts as new, so a store that comes back after an
uninstall may take a workspace past its limit; and a downgrade keeps every store already connected.

## Shopify API version

`SHOPIFY_API_VERSION` and the webhook `api_version` were **2025-10, which Shopify stopped serving
on 2026-10-16 15:00 UTC**; both are 2026-10 now (accessible until 2027-10-16). Every GraphQL
document was validated against the 2026-10 schema with Shopify's public schema proxy:

```bash
# schema: POST an introspection query to https://shopify.dev/admin-graphql-direct-proxy/2026-10
# then graphql.validate() each document (ordersQuery(true/false), bulkOrdersQuery, the constants in
# packages/core/src/shopifyQueries.ts, scopes.ts, apps/api/src/routes/contacts.ts, whatsapp/events.ts)
```

Result: 22 of 22 valid; the billing documents added since (`APP_SUBSCRIPTION_CANCEL`,
`APP_SUBSCRIPTION_STATUSES`, `SHOP_PARTNER_DEVELOPMENT`, and `APP_SUBSCRIPTION_CREATE` with
`replacementBehavior`) were validated the same way on 2026-10-16. Schema validation does not check
Shopify's bulk-operation rules: `bulkOrdersQuery` passed it while every live store rejected the
export for the `refundLineItems` connection inside the `refunds` list. That connection is gone:
refunds, cancellations and edits now come from the orders' sales records (`agreements` → `sales`,
docs/kpis.md), two levels of connections below `orders`, and
`packages/core/test/pipeline.test.ts` fails the build on a connection anywhere but `orders`,
`orders.lineItems`, `orders.agreements` and `orders.agreements.sales`. `CustomerPhoneNumber.marketingState`, deprecated in 2026-10, was replaced by
`smsMarketingConsent.state`. One deprecated field is still served and left for the next bump:
`QueryRoot.currentBulkOperation` (use `bulkOperations` with a status filter). 2026-10 also returns
`FULFILLMENT_NOT_REQUIRED` for orders with nothing to ship; the parser keeps the status as text, so
it is stored as `fulfillment_not_required`. `packages/core/test/appConfig.test.ts` now fails the
build 90 days before the configured version stops being served.

Shopify's side changes only with `cd shopify-app && shopify app deploy --config <app>`, once per app
(`appstore` is the App Store app; the webhook version is part of the app version).

## What can't be checked from the repository

- The automated checks in the Dev Dashboard, and Shopify's review itself.
- The live reviewer walk-through on a development store (install, claim, import, dashboard,
  uninstall, reinstall), after each production deploy.
- Lighthouse impact of the optional web pixel on a storefront (Shopify's sandboxed web pixel).
