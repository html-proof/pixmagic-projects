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

The App Store app is the one in [../shopify.app.public.toml](../shopify.app.public.toml) (client id
658431ae…, Partner org 5229240, Dev Dashboard app 436203126785). `shopify app deploy --config public`
releases that file as a new app version: scopes (`read_orders,read_products`, plus the optional
ones), the webhook subscriptions including the three mandatory compliance topics, the API version
they are sent in, the app URLs, and the `insights-pixel` extension. Run it from `shopify-app/` after
any change to that toml. The main app (`shopify.app.toml`) has no Partner account and can never be
submitted.

That is the whole of what the CLI can do. **It does not create the listing and it does not
submit the app for review.** Those are Dashboard-only, and until review passes the app still
installs only on development stores in our own Partner org - see
`../../docs/shopify-setup.md` 3f.

## Where the submission stands (2026-10-18)

Submission checklist: https://partners.shopify.com/5229240/apps/436203126785/distribution/app-store

**Submitted for review on 2026-10-18 at 17:01 UTC.** Shopify shows "Submitted - We're assigning a
reviewer to your submission"; it emails sales@ikorex.com.au if anything needs changing. Don't press
**Withdraw** on that page: it takes the app out of the review queue. If the reviewer asks for
changes, fix them and use **Submit fixes** on the same page for this app; never start a new listing
or app.

Checked just before submitting:

- Every checklist step green: API versions, configuration, emergency contact, English listing
  (`listing-copy.md`), listing check, automated checks, "Doesn't have specialized capabilities", AI
  self-review box ticked.
- **Protected customer data**: Level 1 (reasons Store management, Analytics), no name, email,
  phone or address fields, 9 of 9 data protection questions answered. Status Draft; Shopify reviews
  it together with the listing.
- **Test account**: a password login (no Google sign-in, two-factor off in Cognito), confirmed and
  email-verified. It owns one workspace whose only store is the "Insights Test" development store,
  so a reviewer sees no live merchant's data. Keep it that way: never invite it to a merchant's
  workspace while the app is in review.
- **Screencast**: unlisted YouTube video "bizinsights - Shopify App Store review demo"
  (https://youtu.be/cQDJjtduHys), reachable.
- Listing visibility after approval: "only accessible to merchants who have its direct URL" until
  someone clicks **Make fully visible** on the same page (owner's call).

Done since (2026-10-18): **the app and site, as a reviewer sees them**. A workspace whose stores came
through this app (and the test account's, through `SHOPIFY_APP_STORE_PREVIEW_SHOPS`) shows no
WhatsApp, Staff, advertising or email (`APP_STORE_MODULES` in `apps/web/src/lib/features.ts`), and
its in-app Continue with Shopify / Connect / Reconnect go through this app, while a store keeps the
app it came through (`connectApp`, `packages/core/src/apps.ts`). The dashboard no longer promises
"within a minute" or suggests test orders; /login and /signup dropped "Real-time analytics" and
label their figures as an illustration; /support and /privacy were corrected (Settings → Shopify,
another store, Cloudflare, Resend, Staff data). The testing instructions in `listing-copy.md` were
rewritten to match: paste them into the form when the review feedback comes back.

Still open:

1. **Paste the new testing instructions** (`listing-copy.md`) into the listing form with the next
   **Submit fixes**.
2. **Run the reviewer path once** on a fresh development store: install, claim, import,
   dashboard, Sync now, uninstall, reinstall.
3. **After approval**: set `SHOPIFY_INSTALL_APP` to `public` (`apps/aws/src/settings.ts`), add the
   order and refund webhook topics back to `../shopify.app.public.toml` once protected customer data
   is granted, and `shopify app deploy --config public`.

Approval is what unblocks every live merchant store at once. Budget days to weeks for it.

## Screenshots

Shopify wants 1600 x 900 desktop images of the real UI, one feature each, no browser chrome, no
personal data, and none repeating the feature image. The current set came from the real UI built
locally on fictional data (how: `listing-copy.md`). To retake them from production instead, use a
development store and a 1600 x 900 viewport. Never use a live merchant's store: its order details
would be in the recent orders list. The store switcher shows a redrawn Shopify bag
(`apps/web/src/components/ShopifyIcon.tsx`); Shopify's brand rules forbid altered logos, so crop it
out or switch to the official asset before retaking them.

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
