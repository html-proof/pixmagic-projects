# Shopify app configuration

The integration is a **public** app using the **authorization code grant** with **permanent offline access tokens**. It is **not embedded**: merchants use our own web app at https://bizinsights.io. Non-embedded is still allowed for public apps: a Shopify staff answer of 2026-08-24 says "fully non-embedded public apps are still allowed in the Shopify App Store" and that App Bridge and requirements 2.2.2/2.2.3 don't apply while `embedded = false` ([forum thread](https://community.shopify.dev/t/non-embedded-shopify-apps-still-allowed/27111)). Everything else in the [App Store requirements](https://shopify.dev/docs/apps/launch/shopify-app-store/app-store-requirements) applies; [shopify-app-store-compliance.md](shopify-app-store-compliance.md) checks each one.

> **Unlisted still means reviewed.** "Unlisted" controls *visibility* in the App Store, not *eligibility*. Both listed and unlisted public apps go through Shopify's app review, and **until that review passes the app installs only on development stores in our own Partner organization.** No install link, scope change or code change gets a live merchant store past that gate — see [3d](#3d-troubleshooting-installs).

## 1. Create the app

1. Shopify Partners → Apps → Create app → *Create app manually*. Name it "bizinsights".
2. Distribution → **Public distribution**, then choose **Unlisted** when submitting.
3. Copy the **Client ID** → `SHOPIFY_API_KEY`, **Client secret** → `SHOPIFY_API_SECRET` (server only; in production in AWS Secrets Manager, `node infra/cdk/scripts/put-secrets.mjs --set SHOPIFY_API_SECRET`).
4. Submit for review and get it approved — step [3f](#3f-getting-approved-so-live-stores-can-install). Everything else works on a development store before this; nothing works on a client's store until it is done.

## 2. Configure with the CLI (recommended)

Edit `shopify-app/shopify.app.toml`: set `client_id` and the app's address (`APP_DOMAIN` below; production: `bizinsights.io`). Then:

```bash
cd shopify-app && npx shopify app deploy
```

This pushes, as one versioned config:

| Setting | Value |
| --- | --- |
| App URL | `https://APP_DOMAIN/api/shopify/launch` (HMAC-verified: authorizes a store we hold no working token for, otherwise opens it) |
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

## 3. Connecting a store

There are two ways in, and both end in Shopify's own OAuth screen; merchants are never asked to type their store's address (App Store requirement 2.3.1).

**Installing from Shopify** (the App Store listing, an install link, or a reinstall). Shopify opens the app URL, `/api/shopify/launch`, signed. A store we hold no working token for (new, uninstalled, or one whose token Shopify refuses) is sent to Shopify's authorize URL at once, whoever is or isn't signed in (requirements 2.3.2 and 2.3.4). The callback stores the token and decides where the store lives:

- a store we have never seen: a new workspace named after it, with **no members** and `awaiting_claim` set;
- a store still in its workspace (not uninstalled, e.g. its token stopped working): that workspace;
- a store an account had until the merchant **uninstalled** the app: back to that account only when the person signed in on this browser manages its stores; otherwise a new workspace of its own, and the old account loses the store and its copy of the data (uninstalling is how a merchant cuts an account off).

It then starts the first import and opens `/claim` (requirement 2.3.3), or the dashboard for an account that already has the store. `/claim` says the store is connected and adds it to a bizinsights account: create one or sign in (both come back to `/claim`), then "Add store and open dashboard" (`POST /api/shopify/claim`) makes that person the workspace's owner and clears `awaiting_claim`. The right to claim is a single-use `shopify_claim` cookie (24 h, `GET /api/shopify/claim` says which store) given only to a browser that came back from Shopify's own approval: opening an unclaimed store from the admin goes through the authorize URL again (no prompt, the app is installed) rather than trusting the signed launch link. Only workspaces with `awaiting_claim` can be claimed. Claims and store moves lock the workspace row, so they can't interleave. A store installed by someone already signed in who manages exactly one workspace goes straight to that workspace instead, as it always has. A workspace nobody claims is erased with its store on `shop/redact`.

**From inside the app** (Settings → Shopify, or the first-run page `/onboarding`). "Continue with Shopify" sends a signed-in user to Shopify's managed install link, where they pick the store and approve; Shopify then opens `/api/shopify/launch`, which finishes the connection for the workspace remembered in this browser (`shopify_pending` cookie). The store address field appears only when the API answers `shop_required`, i.e. the main app is limited to named stores (`SHOPIFY_DEFAULT_APP_SHOPS`). Connecting a store that sits unclaimed in a workspace of its own moves it into the connecting workspace (Shopify's approval proves as much as a claim) and drops the empty workspace; a store another account has claimed is refused (`store_taken`).

The public "Continue with Shopify" sign-up (`/auth/shopify/start`, per-user grant, claim) was retired from the UI on 2026-10-10 and removed from the API on 2026-10-11; see git history before then for how it worked.

## 3b. In-app OAuth flow (signed-in users)

1. `POST /workspaces/:ws/shopify/install {shop}` — user must be signed in, email verified and have `stores:manage`. The shop is normalised to `x.myshopify.com` (custom domains rejected). A random `state` is stored in the coordinator (DynamoDB on AWS; 10 min, bound to user + workspace + shop) **and** in an httpOnly cookie.
2. Browser goes to `https://{shop}/admin/oauth/authorize?client_id&scope&redirect_uri&state`.
3. `GET /shopify/callback` verifies, in order: query HMAC (timing-safe), shop format and exact match, timestamp within 10 min, state cookie == state param, state exists in the coordinator (taken on read, so single use), same signed-in user, then exchanges the code for a permanent offline token (no `expiring` flag - see "Why not expiring tokens" below).
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
coordinator lock, and the `*/15` cron still rotates tokens expiring within the hour every 15
minutes. Both paths are now **dormant for new connections** - `accessTokenExpiresAt` is null, so
`getAccessToken` returns the stored token without ever calling Shopify. They are kept for store
rows connected while `expiring: 1` was in force, which still carry an expiry and a refresh token.
Those rows keep rotating until they are reconnected; a reconnect replaces them with a permanent
token and clears both expiry columns.

### What the first import fetches

| Data | Query | Notes |
| --- | --- | --- |
| Store details | `shop` | name, currency, time zone |
| Orders | `orders` (5 per page) | totals, tax, shipping, discounts + codes, sales channel, fulfillment status and time, line items (product, variant, SKU), test flag, and Shopify's sales records (`agreements` → `sales`: what was sold, returned, cancelled or edited, and when), which the sales figures are built from (docs/kpis.md). Orders with more lines/sales than fit in a page are completed with per-order queries. Last 60 days, or all history once `read_all_orders` is granted |
| Products | `products` (100 per page) | title, status, vendor, type |
| Variants | `productVariants` (100 per page) | price, stock on hand, unit cost |

Every query's requested cost is kept under Shopify's 1000-point limit (worked out in `packages/core/src/normalize.ts`, checked by `packages/core/test/queryCost.ts`). If Shopify still answers `MAX_COST_EXCEEDED`, the sync job halves the page size and retries the same page. Webhooks keep orders, refunds and products current (an order or refund webhook whose money changed reads that order's sales records); a daily reconcile re-pulls recent orders, products and stock.

### Protected customer data

Shopify treats order data as customer data. If an import fails with "Shopify withheld orders (access denied)", request access in the Partner Dashboard: **Apps → Insights → API access → Protected customer data access → Request access** (pick the data and reasons). Development stores get access as soon as the request is filled in; production stores need Shopify's review. The optional scopes (`read_customers`, `write_pixels`, `read_customer_events`) also need this approval before they can be requested.

To import more than 60 days of history, request **Read all orders** in the same place, then add `read_all_orders` to `SHOPIFY_OPTIONAL_SCOPES` (and `optional_scopes` in the toml).

## 3c. A client's store with its own app (custom distribution) — not the product strategy

> **This is not how bizinsights is distributed.** bizinsights is a public app that merchants sign up for themselves and that is billed outside Shopify, so one app per client does not scale and is not an acceptable answer to "the install failed". The route to a client's live store is **getting the main app approved** ([3f](#3f-getting-approved-so-live-stores-can-install)). Keep this section for the multi-app machinery it documents, and reach for a per-client app only as a deliberate, temporary exception.

Until the main app passes Shopify's review, Shopify only lets it be installed on stores in your own developer organization. For a client's live store that cannot wait, a second app distributed only to that store will work. The backend serves any number of apps; every store remembers which one it connected through (`stores.shopify_app_key`) and uses that app's credentials for OAuth, webhooks and token refreshes.

1. Shopify Dev Dashboard → **Create app** (e.g. "bizinsights for PixMagic"). Copy its **Client ID**.
2. The app's **Distribution** → **Custom distribution** → enter the client's `*.myshopify.com` domain → **Generate link** → copy the install link. (Custom distribution installs on one store, or on several stores in the same Plus organization.)
3. Put the Client ID in `shopify-app/shopify.app.pixmagic.toml`, then push URLs, scopes and webhooks: `cd shopify-app && shopify app deploy --config pixmagic`.
4. Tell the app about it. In `apps/aws/src/settings.ts` (`APP_SETTINGS`): `"SHOPIFY_EXTRA_APPS": "[{\"key\":\"pixmagic\",\"clientId\":\"<client id>\",\"shops\":[\"pixmagic.myshopify.com\"]}]"`, and the secret (from the clipboard or prompted, never written to a file): `node infra/cdk/scripts/put-secrets.mjs --set SHOPIFY_APP_SECRET_PIXMAGIC`. Merge to `main` (Deploy to AWS). The functions read secrets when they start, so a secret set on its own needs a **Deploy to AWS** run too (Actions → Run workflow). Until then a store on that app gets `invalid_hmac` on every webhook and launch, so do this before pointing the app at the new address.
5. The store owner opens the install link from step 2, approves, and lands on the connect page (after logging in or signing up) to finish. Typing the store address in **Settings → Shopify** also picks that store's app automatically.

A misconfigured extra app is logged and skipped; the main app keeps working.

### Which app a store is sent to

`SHOPIFY_DEFAULT_APP_SHOPS` (comma separated) lists the stores the **main** app may be installed on. Leave it empty once Shopify has approved the app for public distribution; until then, set it to your development stores. `shops` in `SHOPIFY_EXTRA_APPS` does the same for each client app. Given a store address, the API picks the app distributed to it, falling back to the main app only when the main app may be installed anywhere:

| Store | Main app unrestricted | Main app limited to named stores |
| --- | --- | --- |
| Listed in an extra app's `shops` | that client app | that client app |
| Listed in `SHOPIFY_DEFAULT_APP_SHOPS` | main app | main app |
| Anything else | main app | refused up front: `app_unavailable` |

Shopify's **store picker** (the managed install link one-click connect uses when the merchant has not given an address) can only offer the main app, so it is only used while the main app is unrestricted. Otherwise the API answers `shop_required` and the web app opens the store-address field, which routes to the right app.

## 3e. Optional scopes, and why the env var can't fix an install

This app runs **Shopify managed installation** (`use_legacy_install_flow = false`). That one line decides where scopes come from:

> Merchants are asked to grant exactly the scopes declared in `shopify.app*.toml`. The `scope` parameter our authorize URL carries is **ignored**.

So `SHOPIFY_SCOPES` and `SHOPIFY_OPTIONAL_SCOPES` in the app's settings (`apps/aws/src/settings.ts`) describe what we *believe* we asked for. They cannot widen, narrow or correct what Shopify actually grants — **only `shopify app deploy` can**. `packages/core/test/appConfig.test.ts` fails the build if the toml and the env default drift apart, because that drift has already caused an outage (see below).

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
`apps/aws/src/settings.ts`, and redeploy both Shopify apps (`shopify app deploy`) and the app (merge to `main`) —
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
2. Uncomment `optional_scopes` in **both** tomls, mirror it into `SHOPIFY_OPTIONAL_SCOPES` in `apps/aws/src/settings.ts`, then `shopify app deploy` and merge to `main` (Deploy to AWS).

`packages/core/test/appConfig.test.ts` fails the build if the tomls and `settings.ts` disagree about the optional scopes. Note the env var can only ever *narrow* what we ask for: a scope in `SHOPIFY_OPTIONAL_SCOPES` that the deployed toml does not declare gives merchants an "Enable" button that lands them on a Shopify error.

Giving scopes back follows the same switch: see [Giving a scope back](#giving-a-scope-back) above.

## 3d. Troubleshooting installs

**"This installation link can't be used — It may have expired, or the app may not be available for this store."**

Shopify's own page, shown at `admin.shopify.com/store/<store>/app/grant?...`. Shopify never calls back when it refuses, so no error reaches the app. What *is* recorded is the handoff: every redirect we hand a merchant logs `shopify_install_handoff` with the shop, app key and client id, and a successful return logs `shopify_install_return`. **A handoff with no matching return is a merchant Shopify turned away** — search the API's logs (CloudWatch Logs `/aws/lambda/insights-production-api`) for those two events to see exactly who tried and with which app.

**"Works on our development store, fails on the client's live store" does not narrow this down.** Every cause below behaves that way, because development stores are exempt from both app review and protected customer data review. An earlier version of this document claimed the symptom pointed at protected customer data specifically; it does not, and acting on that reading cost a round of changes that could never have fixed it. Rule out the causes in order instead.

Check, in order:

1. **App review.** Dev Dashboard → the app → **Distribution**. A public app — *listed or unlisted* — can only be installed on development stores in your own Partner organization until Shopify approves it. In Shopify's words: "before your app is approved, it can only be installed on development shops from your Partners account." This is the gate that nothing on our side can move: the install link is fine, the scopes are fine, the code is fine, and the merchant is still refused. If the app has not been submitted and approved, stop here — the other checks cannot be the cause. See [3f](#3f-getting-approved-so-live-stores-can-install).
2. **Protected customer data.** Partner Dashboard → **Apps** → the app → **API access requests** → **Protected customer data access** (it is *not* in the Dev Dashboard; Shopify's 25 Sep 2026 Dev Dashboard post still lists moving it there as future work). `read_orders` is Level 1 protected customer data.

   > **PCD does not gate installation.** Shopify is explicit that "Protected customer data is reviewed separately, and that review isn't scope approval. You can declare the scopes that access protected customer data before your app is approved to use it." Without approval the API returns HTTP 200 with the protected field `null` and an errors entry — it does **not** refuse the install. An earlier version of this document said approval was needed "before a live store can install"; that was wrong, and it is a third false trail for the same symptom. The install gate is app review ([3f](#3f-getting-approved-so-live-stores-can-install)) and nothing else.

   Request it anyway, and **before** submitting: "Applying for protected customer data isn't possible while the app is under review", so submitting first forces a withdraw-and-resubmit and loses queue position.
3. **The released version matches the toml.** Editing a toml changes nothing until `cd shopify-app && shopify app deploy`. Dev Dashboard → **Versions** → the active version shows the scopes and URLs merchants are actually being asked for. Compare them with `shopify-app/shopify.app.toml`.
4. **The right `client_id`.** The one in the failing URL must be the app that store is allowed to install. For a store with its own app ([3c](#3c-a-clients-store-with-its-own-app-custom-distribution--not-the-product-strategy)) this is the check that has actually failed in production, so verify it against the deployed app rather than the repo: signed in, open **Settings → Shopify → Enter store address instead**, enter the store and press Connect. The `client_id` in the Shopify address the browser opens (also in the response to `POST /api/workspaces/<ws>/shopify/install`, DevTools → Network) is the app that store is really being sent to. If it is the main app's, the store's own app is not in the registry — and the cause is almost always that **the configuration never reached production**: `SHOPIFY_EXTRA_APPS` lives in `apps/aws/src/settings.ts`, and editing that file changes nothing until it is merged to `main` and its **Deploy to AWS** run has succeeded. Confirm with `aws lambda get-function-configuration --function-name insights-production-api --qualifier live --query Environment.Variables.SHOPIFY_EXTRA_APPS`, which shows what the live version actually has. A missing secret (`SHOPIFY_APP_SECRET_<KEY>`, set with `put-secrets.mjs --set` and read by the functions only when an instance starts) does the same thing. Either way the store is now refused by us with `app_unavailable` instead of being handed to Shopify's dead end (`packages/core/src/apps.ts`, `blocked`), so the merchant gets a message that names the problem — but the install is still broken until the configuration is deployed.
5. **A stale link.** `access_change_uuid` is single use and short lived, and it is bound to the install attempt that created it — so a grant URL copied out of one person's address bar and sent to someone else *always* lands on this page. Send merchants to `/signup` (then Settings → Shopify), never to an `admin.shopify.com/.../app/grant?...` URL.

While the app is unapproved, set `SHOPIFY_DEFAULT_APP_SHOPS` to our development stores. Merchants we cannot serve then get `app_unavailable` ("This store can't install our app yet…") from us, instead of being handed to a Shopify page that cannot work. Clear it again the day the app is approved, or the store picker stays disabled — see "Which app a store is sent to" above.

**"Unauthorized access"** on the grant screen: the released app version asks for protected customer data scopes it has not been approved for. Fix it in the toml and redeploy — clearing `SHOPIFY_OPTIONAL_SCOPES` in the app's settings does **not** change what Shopify asks for (see 3e).

**A merchant reports a blank page or raw JSON after clicking the app in their admin:** they reached `/shopify/launch` with a link Shopify didn't sign (usually a bookmark or a hand-edited URL). They are now redirected to `/onboarding?error=launch_unverified` with an explanation; the event is logged as `shopify_launch_rejected`.

### "bizinsights.io refused to connect" inside the admin

Seen 2026-10-16 on the Insights Test dev store: although both apps' released configuration says
`embedded = false`, the admin opened the app at `admin.shopify.com/store/<store>/apps/<handle>` with
the app URL in an iframe (`/api/shopify/launch?embedded=1&id_token=…`). Every API response refuses
framing (`X-Frame-Options: DENY`, `frame-ancestors 'none'`), so Chrome showed "refused to connect".
A launch that arrives framed (`Sec-Fetch-Dest: iframe`) now gets a small page that only that store's
admin may frame (`frame-ancestors https://<shop> https://admin.shopify.com`); it loads App Bridge and
calls `open(<same signed launch>, "_top")`, with an "Open bizinsights" link as the fallback, so the
app opens as the whole tab and goes through the usual launch. Nothing else became framable.

## 3g. The App Store app (public distribution, Pixmagic Partner organization)

Only an app in a **Partner organization** can be submitted to the App Store, and a distribution
choice is permanent. Our three apps, all named "bizinsights" and all served by this backend:

| App | Client ID | Organization | Distribution | Backend key |
| --- | --- | --- | --- | --- |
| Main (`shopify.app.toml`) | `57e9ef75…` | "My Store" (Dev Dashboard only, no Partner account) | can't be submitted | `default` |
| PixMagic (`shopify.app.pixmagic.toml`) | `bb0ea9e4…` | Pixmagic (Partner 5229240) | custom, pixmagic.myshopify.com | `pixmagic` |
| **App Store** (`shopify.app.public.toml`) | `658431ae…` | Pixmagic (Partner 5229240) | **public** (chosen 2026-10-16) | `public` |

- Secret: `SHOPIFY_APP_SECRET_PUBLIC` in `insights/production/app` (put-secrets.mjs). Installs from
  its listing are recognised by their signature, so they work without anything else.
- New stores (one-click connect, typed-in stores) go to `SHOPIFY_INSTALL_APP`
  (apps/aws/src/settings.ts). It stays `default` until Shopify approves the App Store app: an
  unapproved app installs only on development stores of its own organization, and ours are in the
  main app's. Approved: set it to `public` and deploy.
- Webhooks: as a public app it may not subscribe to order, refund or checkout topics until
  **Protected customer data access** is granted for it (Partner Dashboard → the app → API access
  requests). The toml lists what to add back then.
- 2026-10-16: its first version, made in the Dashboard, was `embedded = true` with a secret the
  backend didn't have, so opening it from a store's admin showed "bizinsights.io refused to
  connect". `bizinsights-2` (the toml) made it non-embedded.

## 3f. Getting approved, so live stores can install

This is the only thing that makes a client's store installable, and it is entirely done in Shopify's Dev Dashboard — there is no code change that substitutes for it. Expect the review itself to take days to weeks, and plan client onboarding around that.

1. **Protected customer data access.** Dev Dashboard → the app → **API access → Protected customer data access** → request it, selecting the data and giving the reasons. `read_orders` needs it. Request **Level 2 (name, email, phone)** as well: the dashboard's "Customers to follow up" card (`apps/api/src/routes/contacts.ts`) reads shoppers' names, emails and phone numbers live from Shopify so merchants can contact people who abandoned checkout or subscribed. It never stores them, so say so in the request ("displayed to the merchant on demand, not persisted"). Until Level 2 is approved, live stores get those fields withheld and the card says so; development stores show them straight away.
2. **Check what the app actually asks for.** `cd shopify-app && shopify app deploy`, then Dev Dashboard → **Versions** → confirm the active version declares `read_orders,read_products`, no optional scopes, and our URLs. `packages/core/test/appConfig.test.ts` keeps the repo side honest; only a deploy changes Shopify's side.
3. **Billing through Shopify.** A public app that charges merchants has to bill through the Billing API — section 4. Billing is switched off and the listing says Free; once paid plans launch, the reviewer must be able to approve, upgrade, downgrade and cancel a plan on their development store.
4. **The listing.** App name, icon, description, pricing, a privacy policy URL, and support contact. Unlisted apps still need a complete listing: choose **Unlisted / limited visibility** at submission so it is reachable by link without appearing in search.
5. **Reviewer access.** Give test credentials and step-by-step instructions for a reviewer who has never seen the app (`shopify-app/listing/listing-copy.md`): install from the listing, approve, sign in on the "is connected" page, "Add store and open dashboard", wait for the first import, see the dashboard.
6. **Submit for review**, then answer Shopify's feedback. Approval flips the gate for every live store at once.

Once approved: clear `SHOPIFY_DEFAULT_APP_SHOPS` so Shopify's store picker and one-click connect work again for everyone, and give clients the app's install link or `/signup` — never a copied `app/grant` URL.

## 4. Billing

Public apps must charge through the **Shopify Billing API** (App Store requirements 1.2.1-1.2.3). Plans and their one enforced difference, the number of stores a workspace may have, are in `packages/core/src/billing.ts`; the routes are in `apps/api/src/routes/workspaces.ts`.

- **Switched off** until paid plans launch: `BILLING_ENABLED` in `apps/web/src/lib/features.ts` hides Settings → Billing, and the API's `BILLING_ENABLED` setting (`apps/aws/src/settings.ts`) refuses to start a charge and leaves every workspace unlimited. Turn both on together.
- **Starting or changing a plan:** `POST /workspaces/:ws/billing/subscribe` calls `appSubscriptionCreate` with `replacementBehavior: APPLY_IMMEDIATELY` (an approved change replaces the charge in force at once, with Shopify's proration, so two charges never run) and sends the owner to Shopify's approval page. Test charges outside production and on development stores (`shop.plan.partnerDevelopment`), which is what Shopify's reviewers use. While a charge is in force, a change goes on the same store's bill (`subscriptions.billing_store_id`). The plan changes only when `app_subscriptions/update` reports the charge active.
- **Back to Free:** `POST /workspaces/:ws/billing/cancel` ("Switch to Free" on Settings → Billing, owners only) calls `appSubscriptionCancel` with `prorate: true` and drops the plan at once.
- **Uninstall and reinstall:** Shopify cancels an app's charges when it is uninstalled. `app/uninstalled` puts the workspace billed on that store back on Free (and drops a change awaiting approval); a store that comes back starts on Free, so its plan is approved again. A store authorized again while we took it to be installed, or a late `app/uninstalled`, reads the charges' status back from Shopify (`nodes(ids:)`).
- **Store limits:** Free 1 store, Growth 3, Scale any number, counted as live stores in the workspace. A store new to a full workspace is refused at `/shopify/install` and `/shopify/start` (before Shopify installs anything); an install from Shopify for a full workspace lands in a workspace of the store's own. Stores already connected are never cut off, so a downgrade keeps them.

## 5. Test on a development store

1. Partners → Stores → Add store → Development store.
2. Expose your local web app over HTTPS (see [local-dev.md](local-dev.md)), set the tunnel URL in the toml and `APP_URL`, run `shopify app deploy`.
3. Sign in to bizinsights, onboarding → enter the dev store → approve.
4. Trigger webhooks: `npx shopify app webhook trigger --topic orders/create --address https://API_DOMAIN/webhooks/shopify` (uses your app secret for the HMAC).
