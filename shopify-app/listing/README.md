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

Done: API versions, configuration checks, emergency contact, automated checks, app capabilities
("Doesn't have specialized capabilities": not embedded, no theme, checkout or payments), and the English
listing (everything in `listing-copy.md`: copy, category, Free plan, feature image, 5 screenshots,
support, privacy policy, testing instructions). The listing form reports two issues left, both
owner-only:

1. **Test account** - create the reviewer's bizinsights login on https://bizinsights.io/signup
   (email and password, no Google sign-in) and type it into the form (requirement 4.5.4).
2. **Screencast URL** - record it (shot list in `listing-copy.md`) and paste a YouTube or direct
   video link.

Then, before **Submit for review** (owner's call):

3. **Protected customer data** - the checklist says "Doesn't need access to protected customer
   data", which is wrong for an app that reads orders. Change it and request **Level 1** (answers
   in `listing-copy.md`); Shopify won't take the request while the app is under review. Decide the
   optional scopes at the same time: get them covered, or remove `optional_scopes` from the public
   toml (today `appConfig.test.ts` ties all three tomls to one `SHOPIFY_OPTIONAL_SCOPES`, so that is
   a code change) and `shopify app deploy --config public`.
4. **The app and site, as a reviewer sees them** (code, one pull request): hide WhatsApp, Staff,
   advertising and email for App Store installs; send in-app "Connect" buttons to this app, not the
   unapproved main app; reword "within a minute" and "place a test order" in the dashboard; drop
   "Real-time analytics" and label the mock figures on /login and /signup; fix /support
   ("Settings → Stores", connecting another store) and /privacy (Cloudflare, Resend, Staff data).
5. **Run the reviewer path once** on a fresh development store: install, claim, import,
   dashboard, Sync now, uninstall, reinstall.

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
