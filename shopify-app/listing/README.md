# App Store listing assets

Everything Shopify's App Store listing form asks for that can live in the repo.
The listing form itself is Dashboard-only — see "What is left" below.

| File | What it is |
| --- | --- |
| `app-icon-1200.png` | The app icon. Upload this one. |
| `app-icon-1200-sizes.png` | The icon at 160/96/64/48/32 px, to check legibility. Not uploaded. |
| `make-icon.py` | Regenerates the icon. `python make-icon.py app-icon-1200.png` (needs Pillow). |
| `listing-copy.md` | Paste-ready listing text, pricing, and the reviewer instructions. Read its last section before editing any of it: two features in the codebase cannot work under the declared scopes and must stay out of the listing. |

## The icon

1200 x 1200 PNG. Three ascending pills that brighten as they rise, on `--accent` (`#2f6f4f`)
with `--bg` (`#f7f7f5`), so it matches the web app.

It is built to Shopify's published spec:

- the mark is 750 x 750, which is the floor of Shopify's 750-900 px band
- it is centred, leaving a 225 px clear margin on all four sides (Shopify asks for >= 75 px)
- no text, no screenshot, no Shopify trademark, no pricing - all four are explicit rejections
- shipped as a full square: Shopify rounds the corners itself, so don't pre-round it

If you change it, keep it inside that band. Re-run `make-icon.py` rather than editing the PNG.

## What is already pushed

`shopify app deploy` has released version **insights-9**. That put the contents of
`../shopify.app.toml` on Shopify: scopes (`read_orders,read_products`), the webhook
subscriptions including the three mandatory GDPR compliance topics, the app URLs, and the
`insights-pixel` extension.

That is the whole of what the CLI can do. **It does not create the listing and it does not
submit the app for review.** Those are Dashboard-only, and until review passes the app still
installs only on development stores in our own Partner org - see
`../../docs/shopify-setup.md` 3f.

## What is left (Dashboard only)

Dashboard: https://dev.shopify.com/dashboard/238480582/apps/430680145921

1. **Protected customer data access** - API access -> Protected customer data access.
   Request **Level 1**; `read_orders` needs it. Do this *before* submitting: Shopify will not
   accept the request while the app is under review, so submitting first costs a
   withdraw-and-resubmit and the queue position.
2. **Listing** - name, the icon above, description, pricing, privacy policy URL, support
   contact. Choose **Unlisted / limited visibility** at submission if it should be reachable
   by link without appearing in App Store search.
3. **Screenshots** - the listing needs real UI, not the logo. `../../demo-screenshots/` has
   candidates. Each image must be unique and show a different feature; a feature image is
   1600 x 900 with a 100 px margin; no desktop backgrounds or browser chrome.
4. **Reviewer instructions** - test credentials and steps for someone who has never seen it:
   sign up at `/signup`, confirm the email, Continue with Shopify, approve, wait for the first
   import, see the dashboard. (`/start`, in earlier instructions, still forwards to sign-up.) Billing has to be demonstrable too - charges run through `appSubscriptionCreate`.
5. **Automated checks**, then **Submit for review**.

Approval is what unblocks every live merchant store at once. Budget days to weeks for it.

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
