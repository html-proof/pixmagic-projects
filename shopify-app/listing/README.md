# App Store listing assets

Everything Shopify's App Store listing form asks for that can live in the repo.
The listing form itself is Dashboard-only — see "What is left" below.

| File | What it is |
| --- | --- |
| `app-icon-1200.png` | The app icon. Upload this one. |
| `app-icon-1200-sizes.png` | The icon at 160/96/64/48/32 px, to check legibility. Not uploaded. |
| `../../apps/web/scripts/make-icons.py` | Regenerates the icon (and the web app's favicons) from the mark in `apps/web/src/components/Brand.tsx`. `python apps/web/scripts/make-icons.py` from the repository root (needs Pillow). |
| `listing-copy.md` | Paste-ready listing text, pricing, the reviewer instructions and the protected customer data answers. Read its last section before editing any of it: several features in the codebase must stay out of the listing. |

## The icon

1200 x 1200 PNG. The bizinsights mark: three rising bars in a green gradient (`#7be3a8` to
`#23935c`), the tallest tipping upward, on the dark tile (`#1b1c19`). The same mark is the web
app's logo and favicon.

It is built to Shopify's published spec:

- the mark is 820 px across, inside Shopify's 750-900 px band
- it is centred, leaving a 190 px clear margin on the sides and more above and below (Shopify asks for >= 75 px)
- no text, no screenshot, no Shopify trademark, no pricing - all four are explicit rejections
- shipped as a full square: Shopify rounds the corners itself, so don't pre-round it

If you change it, keep it inside that band. Re-run `make-icons.py` rather than editing the PNG.

## What is already pushed

`shopify app deploy` releases the contents of `../shopify.app.toml` as a new app version: scopes
(`read_orders,read_products`, plus the optional ones), the webhook subscriptions including the
three mandatory compliance topics, the API version they are sent in, the app URLs, and the
`insights-pixel` extension. Run it from `shopify-app/` after any change to the toml (the API
version moved to 2026-10 on 2026-10-16; see `docs/shopify-app-store-compliance.md`).

That is the whole of what the CLI can do. **It does not create the listing and it does not
submit the app for review.** Those are Dashboard-only, and until review passes the app still
installs only on development stores in our own Partner org - see
`../../docs/shopify-setup.md` 3f.

## What is left (Dashboard only)

Dashboard: https://dev.shopify.com/dashboard/238480582/apps/430680145921

1. **Protected customer data access** - API access -> Protected customer data access.
   Request **Level 1**; `read_orders` needs it (suggested answers in `listing-copy.md`). Do this
   *before* submitting: Shopify will not accept the request while the app is under review.
   The optional scopes in the toml are protected customer data too: if Level 1 (and, for
   `read_customers`, the matching fields) is not approved by submission day, remove
   `optional_scopes` from both tomls and `SHOPIFY_OPTIONAL_SCOPES` (`apps/aws/src/settings.ts`),
   merge, and `shopify app deploy` again (docs/shopify-setup.md, "Optional scopes").
2. **Listing** - name, the icon above, introduction, details, features, pricing (Free), privacy
   policy URL, support contact: all in `listing-copy.md`.
3. **Screenshots** - see below.
4. **Screencast** - 2-3 minutes, English: install from a development store, the "is connected"
   page, sign in, Add store, the import page, the dashboard (date range, sales breakdown, top
   products, inventory, recent orders), then uninstall. Real production UI only.
5. **Reviewer instructions and a test account** - the text is in `listing-copy.md`. Create the
   reviewer's bizinsights account on https://bizinsights.io yourself and put its email and
   password in the form (requirement 4.5.4); check it signs in on the day you submit.
6. **Emergency developer contact** - name, email and phone.
7. **Automated checks**, then **Submit for review** (owner's call).

Approval is what unblocks every live merchant store at once. Budget days to weeks for it.

## Screenshots

Shopify wants 1600 x 900 desktop images of the real UI, one feature each, no browser chrome. Take
them from https://bizinsights.io signed in to an account whose store is a development store with
demo data (`npx shopify store create dev ... --demo-data`), in a 1600 x 900 viewport, e.g. with
Chrome DevTools' device toolbar set to 1600 x 900 and "Capture screenshot". Never use a live
merchant's store: its customers' names would be in the recent orders list.

## Cost

| | |
| --- | --- |
| Submitting for review | free |
| App Store registration | **one-time $19 USD per Partner account** |
| Revenue share | **0%** on the first $1,000,000 USD of gross app revenue per year; **15%** above that |
| Processing fee | **2.9%** on all billing, plus applicable sales tax |

The 0% band applies while App Store earnings are under $20M/yr and company revenue is under
$100M; past either threshold it is 15% from the first dollar.

Sources: [revenue share](https://shopify.dev/docs/apps/launch/distribution/revenue-share),
[App Store requirements](https://shopify.dev/docs/apps/launch/shopify-app-store/app-store-requirements),
[submit for review](https://shopify.dev/docs/apps/launch/app-store-review/submit-app-for-review).
