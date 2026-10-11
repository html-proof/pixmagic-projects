# Shopify app configuration

The integration is a **public, unlisted** app (installable by any merchant who has the link, not listed in the App Store), using the **authorization code grant** with **permanent offline access tokens**. It is **not embedded**: merchants use our own web app. Non-embedded is still allowed for public apps — `embedded = false` in the toml turns off the App Bridge and session-token review checks that only apply to embedded apps.

> **Unlisted still means reviewed.** "Unlisted" controls *visibility* in the App Store, not *eligibility*. Both listed and unlisted public apps go through Shopify's app review, and **until that review passes the app installs only on development stores in our own Partner organization.** No install link, scope change or code change gets a live merchant store past that gate — see [3d](#3d-troubleshooting-installs).

## 1. Create the app

1. Shopify Partners → Apps → Create app → *Create app manually*. Name it "Insights".
2. Distribution → **Public distribution**, then choose **Unlisted** when submitting.
3. Copy the **Client ID** → `SHOPIFY_API_KEY`, **Client secret** → `SHOPIFY_API_SECRET` (server only; stored in Secret Manager in prod).
4. Submit for review and get it approved — step [3f](#3f-getting-approved-so-live-stores-can-install). Everything else works on a development store before this; nothing works on a client's store until it is done.

## 2. Configure with the CLI (recommended)

Edit `shopify-app/shopify.app.toml`: set `client_id`, replace `app.example.com` / `api.example.com` with your domains. Then:

```bash
cd shopify-app && npx shopify app deploy
```

This pushes, as one versioned config:

| Setting | Value |
| --- | --- |
| App URL | `https://APP_DOMAIN/api/shopify/launch` (HMAC-verified, sends merchant to onboarding) |
| Redirect URL | `https://APP_DOMAIN/api/shopify/callback` |
| Scopes | `read_orders,read_products` (required) |
| Optional scopes | `read_customers`, `write_pixels`, `read_customer_events` — declared in both tomls and mirrored in `SHOPIFY_OPTIONAL_SCOPES` since 2026-10-04; merchants grant them per module with **Enable**, see [3e](#3e-optional-scopes-and-why-the-env-var-cant-fix-an-install) |
| Webhooks | see [webhooks.md](webhooks.md), delivered to `https://APP_DOMAIN/api/webhooks/shopify` |
| Compliance webhooks | `customers/data_request`, `customers/redact`, `shop/redact` |
| Web pixel extension | `extensions/insights-pixel` |

`SHOPIFY_SCOPES` / `SHOPIFY_OPTIONAL_SCOPES` in the API env must match the toml.

### Scope → feature map (least privilege)

| Scope | Unlocks | Why |
| --- | --- | --- |
| `read_orders` | Sales overview, refunds (required) | Orders, line items, refunds. Gives the **last 60 days** only; request `read_all_orders` (needs Shopify approval) for longer history |
| `read_products` | Top products, inventory, catalog | Products (title, status, vendor, type) and variants (price, stock, unit cost) |
| `read_customers` (optional) | New vs returning | Only the customer id is used, and only as a keyed hash |
| `write_pixels`, `read_customer_events` (optional) | Shopping funnel | Install the web pixel and receive storefront events |

The dashboard reads the scopes **actually granted** (from the token response and `app/scopes_update`) and hides any module whose scopes are missing.

## 3. Connecting a store (inside the app)

Since 2026-10-10 a store is connected only by a signed-in user: from **Settings → Shopify** (`/settings/stores`) or the first-run connect page (`/onboarding`), through Shopify's own OAuth screen. `POST /workspaces/:ws/shopify/install {shop, from?}` returns the authorize URL with single-use state bound to the browser; `/api/shopify/callback` exchanges the code server-side, stores the token encrypted, and sends the merchant back where they started (`from: "settings"` → `/settings/stores?connected=<id>`, otherwise the first-sync page). When Shopify opens the app (`/api/shopify/launch`) for someone who isn't signed in, they go to `/onboarding?shop=…`, which asks them to log in or sign up and then carries on with that store. The old public entry `/start` now forwards there (or to `/signup`).

### The retired "Continue with Shopify" sign-up

The flow below is no longer offered in the UI. Its API is kept so sign-ups already under way finish, and documented for reference.

1. `POST /auth/shopify/start {email, shop?}` (from the web app's origin only, rate limited) stores a short-lived signup record (`signup:<nonce>`, 30 min, Durable Object) and sets the httpOnly `shopify_signup` cookie. Without a store address the browser goes to Shopify's managed install (`admin.shopify.com/oauth/install?client_id=…`), where the merchant signs in, picks a store and approves; Shopify then opens `/api/shopify/launch`, which continues the signup from the cookie. With a store address it goes straight to that store's authorize screen.
2. **Per-user grant** (`grant_options[]=per-user`): `/shopify/callback` learns which Shopify staff account approved (email + `email_verified`).
3. **Offline grant**: a second authorize (no prompt, the app is installed) returns the permanent offline token used for background sync. It is kept AES-GCM encrypted in the signup record until claimed.
4. `/start?step=finish` → `POST /auth/shopify/finish`: when Shopify's verified email is the one typed (or the visitor chooses "Continue as <Shopify email>"), it returns a Firebase custom token; otherwise the page proves the typed email with a 6-digit code (`/auth/otp/*`). The sign-in token is handed out once (plus a 2-minute retry window).
5. The browser signs in (`/auth/session`), then `POST /auth/shopify/claim` connects the store: into the user's own solo workspace, or a new workspace named after the store. A store already connected to someone else's workspace is refused (409). The record is single use; `Start again` (`/auth/shopify/cancel`) and logout delete it.
6. The first import runs (shop → orders, products, inventory/variants) and the user lands on the progress screen, then the dashboard.

Signed-in users can still connect more stores from **Settings → Stores → Connect a store** (the flow below).

## 3b. In-app OAuth flow (signed-in users)

1. `POST /workspaces/:ws/shopify/install {shop}` — user must be signed in, email verified and have `stores:manage`. The shop is normalised to `x.myshopify.com` (custom domains rejected). A random `state` is stored in Redis (10 min, bound to user + workspace + shop) **and** in an httpOnly cookie.
2. Browser goes to `https://{shop}/admin/oauth/authorize?client_id&scope&redirect_uri&state`.
3. `GET /shopify/callback` verifies, in order: query HMAC (timing-safe), shop format and exact match, timestamp within 10 min, state cookie == state param, state exists in Redis (deleted on read, so single use), same signed-in user, then exchanges the code for a permanent offline token (no `expiring` flag - see "Why not expiring tokens" below).
4. The access token is AES-256-GCM encrypted (store id as AAD) and saved with the granted scopes. A permanent offline token carries no expiry and no refresh token, so those columns stay null. Initial sync jobs are seeded and the user lands on the onboarding progress screen.

### Why not expiring tokens

Sending `expiring: 1` on the token exchange opts into Shopify's expiring tokens: a 1-hour access
token plus a single-use 90-day refresh token. The app did that until 2026-10-04 and it is
deliberately reversed, because it made successful rotation a liveness requirement for **every**
store:

- A store whose refresh failed even once was dead until the merchant reconnected. There was no
  permanent credential to fall back on.
- The refresh token is single use, and any later authorize for the same app and shop invalidates
  the outstanding one. Leg 2 stashes its token in the signup record and only writes it to the
  store on claim, so an **abandoned signup could kill a live store's token while leaving its row
  untouched** - which is what it looked like had happened to `9kdgux-gq.myshopify.com`.

A permanent offline token has no expiry and no refresh token, so there is nothing to rotate and
nothing for a later authorize to invalidate. It stays valid until the merchant uninstalls.

Token rotation: `packages/core/src/tokens.ts` still refreshes 5 minutes before expiry under a
Durable Object lock, and the worker still rotates tokens expiring within the hour every 15
minutes. Both paths are now **dormant for new connections** - `accessTokenExpiresAt` is null, so
`getAccessToken` returns the stored token without ever calling Shopify. They are kept for store
rows connected while `expiring: 1` was in force, which still carry an expiry and a refresh token.
Those rows keep rotating until they are reconnected; a reconnect replaces them with a permanent
token and clears both expiry columns.

### What the first import fetches

| Data | Query | Notes |
| --- | --- | --- |
| Store details | `shop` | name, currency, time zone |
| Orders | `orders` (7 per page) | totals, tax, shipping, discounts + codes, sales channel, fulfillment status and time, line items (product, variant, SKU), refunds. Orders with more lines/refunds than fit in a page are completed with per-order queries. Last 60 days, or all history once `read_all_orders` is granted |
| Products | `products` (100 per page) | title, status, vendor, type |
| Variants | `productVariants` (100 per page) | price, stock on hand, unit cost |

Every query's requested cost is kept under Shopify's 1000-point limit (worked out in `packages/core/src/normalize.ts`, checked by `packages/core/test/queryCost.ts`). If Shopify still answers `MAX_COST_EXCEEDED`, the worker halves the page size and retries the same page. Webhooks keep orders, refunds and products current; a daily reconcile re-pulls recent orders, products and stock.

### Protected customer data

Shopify treats order data as customer data. If an import fails with "Shopify withheld orders (access denied)", request access in the Partner Dashboard: **Apps → Insights → API access → Protected customer data access → Request access** (pick the data and reasons). Development stores get access as soon as the request is filled in; production stores need Shopify's review. The optional scopes (`read_customers`, `write_pixels`, `read_customer_events`) also need this approval before they can be requested.

To import more than 60 days of history, request **Read all orders** in the same place, then add `read_all_orders` to `SHOPIFY_OPTIONAL_SCOPES` (and `optional_scopes` in the toml).

## 3c. A client's store with its own app (custom distribution) — not the product strategy

> **This is not how Insights is distributed.** Insights is a public app that merchants sign up for themselves and that is billed outside Shopify, so one app per client does not scale and is not an acceptable answer to "the install failed". The route to a client's live store is **getting the main app approved** ([3f](#3f-getting-approved-so-live-stores-can-install)). Keep this section for the multi-app machinery it documents, and reach for a per-client app only as a deliberate, temporary exception.

Until the main app passes Shopify's review, Shopify only lets it be installed on stores in your own developer organization. For a client's live store that cannot wait, a second app distributed only to that store will work. The backend serves any number of apps; every store remembers which one it connected through (`stores.shopify_app_key`) and uses that app's credentials for OAuth, webhooks and token refreshes.

1. Shopify Dev Dashboard → **Create app** (e.g. "Insights for PixMagic"). Copy its **Client ID**.
2. The app's **Distribution** → **Custom distribution** → enter the client's `*.myshopify.com` domain → **Generate link** → copy the install link. (Custom distribution installs on one store, or on several stores in the same Plus organization.)
3. Put the Client ID in `shopify-app/shopify.app.pixmagic.toml`, then push URLs, scopes and webhooks: `cd shopify-app && shopify app deploy --config pixmagic`.
4. Tell the Worker about it. In `apps/cloudflare/wrangler.jsonc` `vars`: `"SHOPIFY_EXTRA_APPS": "[{\"key\":\"pixmagic\",\"clientId\":\"<client id>\",\"shops\":[\"pixmagic.myshopify.com\"]}]"`, and the secret (prompted, never written to a file): `npx wrangler secret put SHOPIFY_APP_SECRET_PIXMAGIC`. Deploy.
5. The store owner opens the install link from step 2, approves, and lands on the connect page (after logging in or signing up) to finish. Typing the store address in **Settings → Shopify** also picks that store's app automatically.

A misconfigured extra app is logged and skipped; the main app keeps working.

### Which app a store is sent to

`SHOPIFY_DEFAULT_APP_SHOPS` (comma separated) lists the stores the **main** app may be installed on. Leave it empty once Shopify has approved the app for public distribution; until then, set it to your development stores. `shops` in `SHOPIFY_EXTRA_APPS` does the same for each client app. Given a store address, the API picks the app distributed to it, falling back to the main app only when the main app may be installed anywhere:

| Store | Main app unrestricted | Main app limited to named stores |
| --- | --- | --- |
| Listed in an extra app's `shops` | that client app | that client app |
| Listed in `SHOPIFY_DEFAULT_APP_SHOPS` | main app | main app |
| Anything else | main app | refused up front: `app_unavailable` |

Shopify's **store picker** (the managed install link used by "Continue with Shopify" and one-click connect, where the merchant has not given an address) can only offer the main app, so it is only used while the main app is unrestricted. Otherwise the API answers `shop_required` and the web app opens the store-address field, which routes to the right app.

## 3e. Optional scopes, and why the env var can't fix an install

This app runs **Shopify managed installation** (`use_legacy_install_flow = false`). That one line decides where scopes come from:

> Merchants are asked to grant exactly the scopes declared in `shopify.app*.toml`. The `scope` parameter our authorize URL carries is **ignored**.

So `SHOPIFY_SCOPES` and `SHOPIFY_OPTIONAL_SCOPES` in the Worker env describe what we *believe* we asked for. They cannot widen, narrow or correct what Shopify actually grants — **only `shopify app deploy` can**. `packages/core/test/appConfig.test.ts` fails the build if the toml and the env default drift apart, because that drift has already caused an outage (see below).

`optional_scopes` is a second trap. Optional scopes are never granted during installation; the app has to ask for them **after** install through a dynamic scope request. A scope listed there is declared to Shopify (and subject to protected customer data review) whether or not we ever ask for it, so declaring one we are not approved for breaks installs on live stores while granting nothing.

### What is declared optional, and why it is on

Enabled **2026-10-04** on both apps, so a merchant can unlock every module themselves instead of
being stuck with whatever the install screen asked for:

| Scope | Unlocks | Module |
| --- | --- | --- |
| `read_customers` | repeat-customer share | `customers` ("New vs returning") |
| `write_pixels` + `read_customer_events` | storefront sessions and conversion | `funnel` ("Shopping funnel") |

Everything else — sales, refunds, top products, channels, order timing, fulfillment, discount
codes, recent orders, inventory, catalog — needs only `read_orders` / `read_products` and is
already covered by the install grant. `inventory` in particular needs **no** extra scope; it is
derived from product variants.

All three are protected customer data, and declaring them before **Protected customer data
access** is approved makes Shopify refuse *new installs on live merchant stores* (development
stores are exempt). That is accepted deliberately, because today it costs nothing:

- the main app is unapproved, so it cannot install on a live store at all; and
- the custom app's single store is already installed, and the install screen is not shown again.

**Re-check this when the main app is submitted for review.** If PCD approval has not landed by
then, comment `optional_scopes` back out of both tomls, clear `SHOPIFY_OPTIONAL_SCOPES` in
`apps/cloudflare/wrangler.jsonc`, and redeploy both apps and the Worker —
otherwise approval of the *app* will be gated behind installs that Shopify is refusing.

### The dynamic scope request flow

This **is** implemented, and it is what the "Enable" button on a locked dashboard module does:

| Piece | Where |
| --- | --- |
| Request URL, scope query, follow-up rules | [`packages/core/src/scopes.ts`](../packages/core/src/scopes.ts) |
| `POST /workspaces/:ws/stores/:id/scopes/request`, `.../scopes/refresh` and `.../scopes/revoke` | [`apps/api/src/routes/scopes.ts`](../apps/api/src/routes/scopes.ts) |
| Which locked modules offer a button (`requestableScopes`) | `resolveCapabilities`, [`packages/shared/src/capabilities.ts`](../packages/shared/src/capabilities.ts) |
| Reacting to a grant we didn't initiate | `app/scopes_update`, [`apps/worker/src/handlers.ts`](../apps/worker/src/handlers.ts) |

The app is `embedded = false`, so App Bridge's `shopify.scopes.request()` is not available and we use Shopify's [request URL](https://shopify.dev/docs/apps/build/authentication-authorization/manage-access-scopes):

```
https://admin.shopify.com/store/<handle>/oauth/install?client_id=<id>&optional_scopes=<csv>
```

**It takes no `redirect_uri` and no `state`, and returns no authorization code.** Shopify asks the merchant, records the answer and then opens our `application_url` (`/shopify/launch`) with nothing to say what happened. So the grant is *learned*, never received, by two independent paths:

1. the `app/scopes_update` webhook — covers a merchant who grants and never comes back, or who changes scopes in their admin where we are not watching;
2. `POST .../scopes/refresh`, which queries `currentAppInstallation { accessScopes }` — the web app calls it once when the merchant returns, so the module unlocks immediately instead of whenever the webhook lands.

Both then queue the same follow-up import, because **granting a scope does not backfill the data behind it** (`scopeFollowUpKinds`):

- `read_customers` changes what the orders query asks for, so every order already imported carries no customer hash → a **full** orders re-import, not a recent-days one. Without it "New vs returning" reads as 100% new, which is worse than the module staying locked.
- `write_pixels` only grants permission to create the web pixel → `install_pixel`. Until it exists the storefront sends no events.

### Giving a scope back

`POST /workspaces/:ws/stores/:id/scopes/revoke` runs Shopify's [`appRevokeAccessScopes`](https://shopify.dev/docs/api/admin-graphql/latest/mutations/appRevokeAccessScopes). Shopify's advice is to hold only the scopes a feature currently needs: an optional scope the app has stopped using is blast radius on a token that leaks, and this is the only way to give one up short of the merchant uninstalling.

The asymmetry with requesting is the point:

- **Only optional scopes.** A required scope is part of the install grant and Shopify will not take it back. `revocableScopes` filters those out before the call, so the API answers `scope_unavailable` instead of relaying a `userErrors` entry.
- **No merchant round trip.** A revoke is the app's own decision and takes effect immediately — there is no Shopify screen and nothing to learn afterwards.
- **A refusal arrives as a success.** Shopify reports problems in `userErrors` inside an HTTP 200 with no GraphQL error, so `revokeAccessScopes` throws `ScopeRevokeError` on a non-empty list (→ 409 `scope_not_revocable`) rather than reporting a revoke that did not happen.
- **The stored scopes are reconciled, not edited.** After the mutation the route re-reads `currentAppInstallation` exactly as `refresh` does, because `grantedScopes` is a cache and the authoritative answer is one call away. The locked module then offers **Enable** again, so a revoke is reversible by the merchant.

What a revoke does *not* do: it does not delete data the scope let us import, and it does not remove a web pixel that `write_pixels` allowed us to create. It changes what the token can do next.

### Turning it on

**Current state (2026-10-06): turned on.** `optional_scopes` is declared in both tomls and mirrored in `SHOPIFY_OPTIONAL_SCOPES`, so the dashboard offers **Enable** and Settings → Stores offers **Remove** (see "What is declared optional, and why it is on"). The steps below are how it was switched on, and in reverse how to switch it off again before app review if protected customer data approval has not landed. With `SHOPIFY_OPTIONAL_SCOPES` empty the flow is dormant: `declaredOptionalScopes()` finds nothing, no module offers a button, and `request` and `revoke` both answer `scope_unavailable`. In this order:

1. Get **API access → Protected customer data access** granted for `read_customers`, `write_pixels`, `read_customer_events`.
2. Uncomment `optional_scopes` in **both** tomls, mirror it into `SHOPIFY_OPTIONAL_SCOPES` in `apps/cloudflare/wrangler.jsonc`, then `shopify app deploy` and `npx wrangler deploy`.

`packages/core/test/appConfig.test.ts` fails the build if the tomls and `wrangler.jsonc` disagree about the optional scopes. Note the env var can only ever *narrow* what we ask for: a scope in `SHOPIFY_OPTIONAL_SCOPES` that the deployed toml does not declare gives merchants an "Enable" button that lands them on a Shopify error.

Giving scopes back follows the same switch: see [Giving a scope back](#giving-a-scope-back) above.

## 3d. Troubleshooting installs

**"This installation link can't be used — It may have expired, or the app may not be available for this store."**

Shopify's own page, shown at `admin.shopify.com/store/<store>/app/grant?...`. Shopify never calls back when it refuses, so no error reaches the app. What *is* recorded is the handoff: every redirect we hand a merchant logs `shopify_install_handoff` with the shop, app key and client id, and a successful return logs `shopify_install_return`. **A handoff with no matching return is a merchant Shopify turned away** — search the Worker logs for those two events to see exactly who tried and with which app.

**"Works on our development store, fails on the client's live store" does not narrow this down.** Every cause below behaves that way, because development stores are exempt from both app review and protected customer data review. An earlier version of this document claimed the symptom pointed at protected customer data specifically; it does not, and acting on that reading cost a round of changes that could never have fixed it. Rule out the causes in order instead.

Check, in order:

1. **App review.** Dev Dashboard → the app → **Distribution**. A public app — *listed or unlisted* — can only be installed on development stores in your own Partner organization until Shopify approves it. In Shopify's words: "before your app is approved, it can only be installed on development shops from your Partners account." This is the gate that nothing on our side can move: the install link is fine, the scopes are fine, the code is fine, and the merchant is still refused. If the app has not been submitted and approved, stop here — the other checks cannot be the cause. See [3f](#3f-getting-approved-so-live-stores-can-install).
2. **Protected customer data.** Partner Dashboard → **Apps** → the app → **API access requests** → **Protected customer data access** (it is *not* in the Dev Dashboard; Shopify's 25 Sep 2026 Dev Dashboard post still lists moving it there as future work). `read_orders` is Level 1 protected customer data.

   > **PCD does not gate installation.** Shopify is explicit that "Protected customer data is reviewed separately, and that review isn't scope approval. You can declare the scopes that access protected customer data before your app is approved to use it." Without approval the API returns HTTP 200 with the protected field `null` and an errors entry — it does **not** refuse the install. An earlier version of this document said approval was needed "before a live store can install"; that was wrong, and it is a third false trail for the same symptom. The install gate is app review ([3f](#3f-getting-approved-so-live-stores-can-install)) and nothing else.

   Request it anyway, and **before** submitting: "Applying for protected customer data isn't possible while the app is under review", so submitting first forces a withdraw-and-resubmit and loses queue position.
3. **The released version matches the toml.** Editing a toml changes nothing until `cd shopify-app && shopify app deploy`. Dev Dashboard → **Versions** → the active version shows the scopes and URLs merchants are actually being asked for. Compare them with `shopify-app/shopify.app.toml`.
4. **The right `client_id`.** The one in the failing URL must be the app that store is allowed to install. For a store with its own app ([3c](#3c-a-clients-store-with-its-own-app-custom-distribution--not-the-product-strategy)) this is the check that has actually failed in production, so verify it against the deployed Worker rather than the repo:

   ```bash
   curl -s -X POST https://insights.imeseban.workers.dev/api/auth/shopify/start \
     -H 'Content-Type: application/json' -H 'Origin: https://insights.imeseban.workers.dev' \
     -d '{"email":"probe@example.com","shop":"THE-STORE.myshopify.com"}'
   ```

   The `client_id` in the returned URL is the app that store is really being sent to. If it is the main app's, the store's own app is not in the registry — and the cause is almost always that **the configuration never reached production**: `SHOPIFY_EXTRA_APPS` lives in `apps/cloudflare/wrangler.jsonc`, and editing that file changes nothing until `npx wrangler deploy`. `wrangler secret put` does deploy a new version, which makes it look as though the var went out too; it does not — it carries over the *previous* version's vars. Confirm with `npx wrangler versions view <id>`, which lists the bindings the live version actually has. A missing secret (`SHOPIFY_APP_SECRET_<KEY>`) does the same thing for the same reason. Either way the store is now refused by us with `app_unavailable` instead of being handed to Shopify's dead end (`packages/core/src/apps.ts`, `blocked`), so the merchant gets a message that names the problem — but the install is still broken until the Worker is redeployed.
5. **A stale link.** `access_change_uuid` is single use and short lived, and it is bound to the install attempt that created it — so a grant URL copied out of one person's address bar and sent to someone else *always* lands on this page. Send merchants to `/signup` (then Settings → Shopify), never to an `admin.shopify.com/.../app/grant?...` URL.

While the app is unapproved, set `SHOPIFY_DEFAULT_APP_SHOPS` to our development stores. Merchants we cannot serve then get `app_unavailable` ("This store can't install our app yet…") from us, instead of being handed to a Shopify page that cannot work. Clear it again the day the app is approved, or the store picker stays disabled — see "Which app a store is sent to" above.

**"Unauthorized access"** on the grant screen: the released app version asks for protected customer data scopes it has not been approved for. Fix it in the toml and redeploy — clearing `SHOPIFY_OPTIONAL_SCOPES` in the Worker env does **not** change what Shopify asks for (see 3e).

**A merchant reports a blank page or raw JSON after clicking the app in their admin:** they reached `/shopify/launch` with a link Shopify didn't sign (usually a bookmark or a hand-edited URL). They are now redirected to `/onboarding?error=launch_unverified` with an explanation; the event is logged as `shopify_launch_rejected`.

## 3f. Getting approved, so live stores can install

This is the only thing that makes a client's store installable, and it is entirely done in Shopify's Dev Dashboard — there is no code change that substitutes for it. Expect the review itself to take days to weeks, and plan client onboarding around that.

1. **Protected customer data access.** Dev Dashboard → the app → **API access → Protected customer data access** → request it, selecting the data and giving the reasons. `read_orders` needs it. Request **Level 2 (name, email, phone)** as well: the dashboard's "Customers to follow up" card (`apps/api/src/routes/contacts.ts`) reads shoppers' names, emails and phone numbers live from Shopify so merchants can contact people who abandoned checkout or subscribed. It never stores them, so say so in the request ("displayed to the merchant on demand, not persisted"). Until Level 2 is approved, live stores get those fields withheld and the card says so; development stores show them straight away.
2. **Check what the app actually asks for.** `cd shopify-app && shopify app deploy`, then Dev Dashboard → **Versions** → confirm the active version declares `read_orders,read_products`, no optional scopes, and our URLs. `packages/core/test/appConfig.test.ts` keeps the repo side honest; only a deploy changes Shopify's side.
3. **Billing through Shopify.** A public app that charges merchants has to bill through the Billing API — section 4. This is implemented; it has to be *demonstrable* to the reviewer.
4. **The listing.** App name, icon, description, pricing, a privacy policy URL, and support contact. Unlisted apps still need a complete listing: choose **Unlisted / limited visibility** at submission so it is reachable by link without appearing in search.
5. **Reviewer access.** Give test credentials and step-by-step instructions for a reviewer who has never seen the app: sign up at `/signup`, verify the email, connect the store (Settings → Shopify), approve on Shopify, wait for the first import, see the dashboard.
6. **Submit for review**, then answer Shopify's feedback. Approval flips the gate for every live store at once.

Once approved: clear `SHOPIFY_DEFAULT_APP_SHOPS` so Shopify's store picker and one-click connect work again for everyone, and give clients the app's install link or `/signup` — never a copied `app/grant` URL.

## 4. Billing

Public apps must charge through the **Shopify Billing API**. `POST /workspaces/:ws/billing/subscribe` calls `appSubscriptionCreate` (test charges outside production) and redirects the owner to Shopify's confirmation page. Status updates arrive via `app_subscriptions/update`.

## 5. Test on a development store

1. Partners → Stores → Add store → Development store.
2. Expose your local web app over HTTPS (see [local-dev.md](local-dev.md)), set the tunnel URL in the toml and `APP_URL`, run `shopify app deploy`.
3. Sign in to Insights, onboarding → enter the dev store → approve.
4. Trigger webhooks: `npx shopify app webhook trigger --topic orders/create --address https://API_DOMAIN/webhooks/shopify` (uses your app secret for the HMAC).
