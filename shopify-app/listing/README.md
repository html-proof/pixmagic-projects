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

The App Store app is the one in [../shopify.app.appstore.toml](../shopify.app.appstore.toml) (client
id cf5c717d…, Partner org 5229240, Dev Dashboard app 436930412545, registered 2026-10-18).
`shopify app deploy --config appstore` releases that file as a new app version (first one:
`bizinsights-appstore-1`, 2026-10-18): scopes (`read_orders,read_products`, plus the optional
ones), the webhook subscriptions including the three mandatory compliance topics, the API version
they are sent in, the app URLs, and the `insights-pixel` extension. Run it from `shopify-app/` after
any change to that toml. The main app (`shopify.app.toml`) has no Partner account and can never be
submitted.

That is the whole of what the CLI can do. **It does not create the listing and it does not
submit the app for review.** Those are Dashboard-only, and until review passes the app still
installs only on development stores in our own Partner org - see
`../../docs/shopify-setup.md` 3f.

## Where the submission stands (2026-10-18)

**Starting over with a new app.** The first App Store app (`public`, 658431ae…, checklist
https://partners.shopify.com/5229240/apps/436203126785/distribution/app-store) was submitted at
17:01 UTC and bounced to Draft by Shopify's automated install test: its stores' syncs got 403
"Non-expiring access tokens are no longer accepted" (fixed for every app by PR #118). The owner then
chose a brand-new registration, `appstore`, accepting that the listing, the protected customer data
request, the screencast and the review start over. Only one of the two may be published (App Store
requirement 1.1.5): decide what happens to `public`'s submission before submitting `appstore`.

The new app's checklist: https://partners.shopify.com/5229240/apps/436930412545/distribution/app-store.
Done on 2026-10-18: registered (`shopify app init`, Pixmagic organization), public distribution,
app icon uploaded, `bizinsights-appstore-1` released (bizinsights.io URLs, non-embedded, compliance
webhooks), client secret in `insights/production/app`. Everything below "Checked just before
submitting" describes the first app's submission and has to be done again for this one: listing
(`listing-copy.md`), protected customer data request, test account, screencast, automated checks,
capabilities, AI self-review.

What follows is the first app's record.

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

Still open, all for `appstore`'s first submission (checklist
https://partners.shopify.com/5229240/apps/436930412545/distribution/app-store):

1. **Listing**: done. The text, category, search terms and the Free plan were saved on 2026-10-18
   from `listing-copy.md` (submission 143753); the feature image and 5 desktop screenshots, with
   their alt text, on 2026-10-19 (see Screenshots below). The listing's issue list now names only
   the owner's Test account and Screencast URL.
2. **Owner**: the protected customer data request (API access requests), the test account
   (Username, Password, Account description) and the screencast URL.
3. **Run the reviewer path once** on a fresh development store of the Pixmagic organization:
   install, claim, import, dashboard, Sync now, uninstall, reinstall. Then the automated checks
   ("Run") and the capabilities step, last, since the checks expire after 30 days.
4. **Decide what happens to `public`'s submission** (requirement 1.1.5), then press **Submit for
   review** on `appstore`'s checklist. Never press **Submit fixes** on `public`'s page again.
5. **After approval**: set `SHOPIFY_INSTALL_APP` to `appstore` (`apps/aws/src/settings.ts`), add the
   order and refund webhook topics back to `../shopify.app.appstore.toml` once protected customer data
   is granted, and `shopify app deploy --config appstore`.

Approval is what unblocks every live merchant store at once. Budget days to weeks for it.

## Screenshots

Shopify wants 1600 x 900 desktop images of the real UI, one feature each, no browser chrome, no
personal data, and none repeating the feature image. `appstore`'s set (uploaded 2026-10-19) came
from the real UI built locally on fictional data, in an App Store workspace (how and what each one
shows: `listing-copy.md`). To retake them from production instead, use a development store whose
workspace is an App Store one. Never use a live merchant's store: its order details would be in
the recent orders list.

No image may show anything that carries the Shopify bag (the store switcher, the Shopify connect
buttons, Settings, Integrations): requirement 4.4.3 keeps Shopify's trademarks out of the app
icon, banner and screenshots. Since 2026-10-19 that bag is Shopify's official Shopping Bag, the files
from shopify.com/brand-assets copied unchanged (`apps/web/src/components/ShopifyIcon.tsx`), so the
app itself follows the brand rules. Requirement 4.4.3 still applies to the images. The current set
keeps the switcher out of frame: the panels are taken in a 1136 px window, where the 896 px panel
covers everything right of the sidebar, and Team & Access is framed from just under the top bar.

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
