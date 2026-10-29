# Zapier

bizinsights has its own app on Zapier's Developer Platform ("bizinsights", [integrations/zapier](../integrations/zapier/README.md)).
A merchant connects their bizinsights store inside **their own Zapier account** (OAuth, one click:
bizinsights is the provider, there are no keys or addresses to copy) and uses bizinsights' triggers
and searches in their Zaps: an alert in Slack, ad spend over budget in an email, yesterday's
advertising in a Google Sheet.

## Contents

1. [What Zapier can and can't do here](#what-zapier-can-and-cant-do-here)
2. [Architecture](#architecture)
3. [OAuth endpoints](#oauth-endpoints)
4. [Zapier's API](#zapiers-api)
5. [Events and payloads](#events-and-payloads)
6. [Delivery](#delivery)
7. [Security](#security)
8. [Settings → Integrations](#settings--integrations)
9. [Owner setup](#owner-setup)
10. [Troubleshooting](#troubleshooting)
11. [Tests](#tests)
12. [Not built, and why](#not-built-and-why)

## What Zapier can and can't do here

| Kind | Key | What a Zap gets |
| --- | --- | --- |
| Trigger | `alert_raised` | Every bizinsights alert for the store, worded as the bell words it (`describeAlert`): a Shopify sync or webhook problem, an ad account that needs reconnecting, WhatsApp disconnected, an email account to reconnect... |
| Trigger | `ad_spend_threshold` | Once per day or month (the trigger's choice) when the store's stored Meta, Google or combined ad spend reaches an amount |
| Trigger | `adsense_earnings_threshold` | The same on AdSense's estimated earnings |
| Trigger | `ads_daily_summary` | Once a day: yesterday's spend, impressions, clicks, conversions and platform-attributed purchase value / ROAS per platform, AdSense's estimates, and Shopify's own sales for the day |
| Trigger | `whatsapp_message_failed` | A WhatsApp message to a customer failed (number masked) |
| Search | `find_ad_performance` | Meta / Google Ads totals for dates, from stored data, with the last sync's time |
| Search | `find_adsense_earnings` | AdSense estimated earnings for dates |

Zapier **can't** change anything in bizinsights, Shopify or an ad account, send customers anything,
see customers' names, emails or full phone numbers, or reach another store or workspace. Each
trigger also stays within what the member who connected it may see (below).

## Architecture

```
 Zapier (merchant's account) ── "Connect bizinsights" ──► bizinsights.io/connect/zapier (consent page, apps/web)
        │                                                    │ member's session: GET /api/oauth/zapier/authorize
        │◄──────────── redirect with ?code&state ────────────┘                  POST /api/workspaces/:ws/stores/:id/zapier/authorize
        │── POST /api/oauth/token (client secret) ─► tokens zat_ (1 h) + zrt_ (rotating)
        │── /api/zapier/* (Bearer zat_) ─► me, hooks (subscribe/unsubscribe), samples, searches
        ▼
 hooks.zapier.com/hooks/... ◄── POST event ── worker (sync queue, kind "zapier") ◄── zapier_deliveries ◄── zapier_events (outbox)
                                                                                                          ▲
   raiseAlert (core notify.ts) ── alert_raised ──────────────────────────────────────────────────────────┤
   runAdsSync (worker) ── zapierAfterAdSync ── thresholds, daily summary ─────────────────────────────────┤
   applyMessageStatus (core whatsapp/messages.ts) ── whatsapp_message_failed ─────────────────────────────┘
   cron */15 (last in the tick) ── sweepZapier: unqueued and due deliveries, stuck ones, summaries, retention
```

| Part | Where |
| --- | --- |
| Event catalog, thresholds, backoff, hook URL rule, delivery wording | `packages/shared/src/zapier.ts` (`@app/shared/zapier`) |
| Alert visibility (the bell's rule, shared) | `mayFixAlert` in `packages/shared/src/alerts.ts` |
| OAuth provider, tokens, revocation | `packages/core/src/zapier/oauth.ts`, `access.ts`, `config.ts` |
| Outbox and events | `packages/core/src/zapier/events.ts`, `ads.ts` |
| Hooks and samples | `packages/core/src/zapier/hooks.ts` |
| Delivery and sweep | `packages/core/src/zapier/delivery.ts`; worker `apps/worker/src/handlers/zapier.ts` |
| Settings card's data, disconnect, store purge | `packages/core/src/zapier/manage.ts` |
| API | `apps/api/src/routes/zapierOAuth.ts`, `apps/api/src/routes/zapier.ts` |
| Consent page | `apps/web/src/app/connect/zapier/page.tsx` |
| Settings card | `apps/web/src/components/integrations/ZapierCard.tsx`, flag `ZAPIER_ENABLED` in `apps/web/src/lib/features.ts` |
| Tables | migration `20261028120000_zapier_integration` |
| The Zapier app | `integrations/zapier` (outside the pnpm workspace) |

Tables (all with `workspace_id` and RLS; none has a Prisma relation to users, workspaces or stores,
so the code that removes those removes these too):

| Table | Holds |
| --- | --- |
| `zapier_grants` | A connection: workspace, store, the member who allowed it, the client, last use, `revoked_at` and why |
| `zapier_tokens` | The grant's tokens as SHA-256 hashes, kind, expiry, a refresh token's `used_at`. The tenant role (`app_rls`) has no rights on it at all |
| `zapier_hooks` | A Zap's trigger: event, `target_url` (always hooks.zapier.com), its inputs, last delivery, a threshold's check note |
| `zapier_events` | The outbox: event, payload (the envelope), `dedupe_key` UNIQUE, an optional `hook_id` (thresholds). Kept 30 days |
| `zapier_deliveries` | One event for one trigger: status, attempts, next attempt, Zapier's last HTTP status, error code. UNIQUE (event, hook) |

## OAuth endpoints

Authorization code with refresh tokens, confidential client (RFC 6749). All answer `503
not_configured` until `ZAPIER_CLIENT_ID`, `ZAPIER_CLIENT_SECRET` and `ZAPIER_REDIRECT_URI` are set
(after asking who is calling, where they do).

| Endpoint | Who | What |
| --- | --- | --- |
| `GET /connect/zapier?client_id&redirect_uri&response_type=code&state` | the merchant's browser | The consent page. Signed out: sign in, then back (returnTo keeps the query). |
| `GET /api/oauth/zapier/authorize?…` | the member's own session (never a shared link) | Checks the request: `client_id` is ours, `redirect_uri` matches exactly, `response_type=code`, a state. A wrong one is answered 400 with words and never redirected to. Answers the person's workspaces, each `allowed` when they hold "Manage integrations" there, with its stores, and the Cancel URL (`error=access_denied&state=…`). |
| `POST /api/workspaces/:ws/stores/:storeId/zapier/authorize` | the member's own session, "Manage integrations" | Allow. Answers `{ redirect }`: the redirect URI with `code` and `state` (untouched). Codes: `zac_` + 256 random bits, single use, 5 minutes, kept in the coordinator under their SHA-256, bound to client, redirect URI, member, workspace and store. |
| `POST /api/oauth/token` | Zapier's server | `grant_type=authorization_code` (`code`, `redirect_uri`) or `refresh_token`. Form-encoded or JSON; the client's credentials in the body (`client_secret_post`) or HTTP Basic, never both. Answers `{ access_token, token_type: "Bearer", expires_in: 3600, refresh_token }`, errors as `{ error, error_description }` (`invalid_client` 401, `invalid_grant`, `invalid_request`, `unsupported_grant_type` 400). |

- Tokens: `zat_` (access, 1 hour) and `zrt_` (refresh, a year from issue), 256 random bits, stored only
  as SHA-256. The client secret is compared in constant time (both sides hashed first).
- A refresh token is used once: each refresh issues a new pair. One presented again within 60 s
  (Zapier's tasks refreshing at once) gets a pair too; after that it was copied, and **the whole grant
  is revoked** (`refresh_token_reused`).
- A code used twice is refused and revokes the grant its first use made (`code_reused`).
- Every exchange re-checks the member: still a member, access not revoked or ended, still holding
  "Manage integrations", the store still connected. Otherwise `invalid_grant` (Zapier asks to reconnect).

## Zapier's API

`/api/zapier/*` takes **only** `Authorization: Bearer zat_…`. Session cookies are never read there,
a shared link or a workspace API key (`sk_`) is a 401, and a `zat_` token opens nothing outside it
(every other route reads cookies or `sk_` keys only). The store is the connection's: no route takes
one. Each request re-checks the member (as above): one who lost access gets **401** with
`WWW-Authenticate: Bearer error="invalid_token"`, so Zapier refreshes, fails, and asks for the
connection again. Per connection 300 requests a minute; tokens that don't verify, 120 per IP per 10
minutes. Exempt from the app-wide per-IP limit (Zapier calls for every merchant from a few addresses).

| Route | What |
| --- | --- |
| `GET /zapier/me` | The connection test and its label: workspace, store (name, domain, currency, time zone), who connected it |
| `POST /zapier/hooks` | Subscribe: `{ event, targetUrl, zapId?, platform?, period?, amount? }` → `{ id, event }`. `targetUrl` must be `https://hooks.zapier.com/hooks/…` (no other host, port, credentials or IP). At most 50 per connection. A trigger the member may not have: 403 `no_permission` |
| `DELETE /zapier/hooks/:id` | Unsubscribe (this connection's triggers only; another's is a 404) |
| `GET /zapier/samples/:event` | The store's last 3 real events of the kind as this member would receive them; with none sent yet, its latest alerts, failed WhatsApp messages or yesterday's stored advertising; thresholds: `[]` until one fires. Never made-up data |
| `GET /zapier/search/ad-performance?platform&since&until` | Totals from stored data; `[]` without an ad account. Dates `YYYY-MM-DD`, default the 7 days to yesterday, at most 400 days |
| `GET /zapier/search/adsense-earnings?since&until` | The same for AdSense |

## Events and payloads

Every event is posted as one envelope; `id` is the happening's own key (the same for every Zap and
every retry, which Zapier uses to tell items apart):

```json
{ "id": "alert_raised:<alertId>:<storeId>", "event": "alert_raised", "occurred_at": "2026-10-28T09:00:00.000Z",
  "store": { "id": "…", "name": "Acme", "shop_domain": "acme.myshopify.com" }, "data": { … } }
```

| Event | `data` | Written by | Once per |
| --- | --- | --- | --- |
| `alert_raised` | `alert_id, severity, area, title, body, fix_url, raised_at`: `describeAlert`'s wording, never the internal message | `raiseAlert` (an alert about no store goes to every store's triggers in the workspace) | alert and store |
| `ad_spend_threshold` | `trigger {platform, period, amount}, period, period_start, period_end, period_complete, spend, currency, accounts[], last_successful_sync_at, freshness_note` | `zapierAfterAdSync` (worker, after a successful ad sync), for that trigger only | trigger and period |
| `adsense_earnings_threshold` | the same with `earnings_estimated` and `estimates_note` (Google's estimates, adjusted after the month) | the same | trigger and period |
| `ads_daily_summary` | `day, platforms[{platform, spend, currency, mixed_currencies, impressions, clicks, conversions, platform_attributed_purchase_value, platform_attributed_roas, accounts}], adsense, shopify {net_sales, total_sales, orders, currency}, accounts_without_the_day, freshness_note, attribution_note` | after an ad sync, and the cron sweep | store and day |
| `whatsapp_message_failed` | `message_id, source, type, category, phone_masked, reason, reason_text, automation_id, campaign_id, failed_at, view_url` | `applyMessageStatus` when a customer's message becomes failed (not tests, codes or team alerts) | message |

- **Thresholds** are checked after each ad sync, for the store's current period and the one before
  (platforms report late) when that one ended after the trigger was made. Periods are the store's
  calendar; each platform's rows are its account's own days. The Google Ads demo is left out (its
  figures are generated). Amounts in **different currencies are never added up**: such a trigger is
  not checked, and Settings says why (`check_note = mixed_currencies:AUD,USD`). A trigger made when
  the period's total is already over its amount fires at the next sync.
- **Daily summary**: once every connected account has yesterday stored (`synced_through`), or from
  noon at the store with what there is (`accounts_without_the_day` lists the rest). Purchase value and
  ROAS are each platform's own attribution, never store revenue; Shopify's sales are beside them.
- **Per person**: an alert goes only to triggers whose member could see it in the bell (`mayFixAlert`:
  ads → Manage integrations, WhatsApp → View campaigns, email → View integration status, staff →
  attendance, privacy → audit log, Shopify and general → owners and admins). Ad triggers need
  "View advertising analytics", WhatsApp's "View campaigns and their performance". The daily summary's
  `shopify` block is `null` for someone without "View sales and revenue". Checked when the event is
  written and again at delivery.

## Delivery

- Each delivery rides the **sync queue** as `{ kind: "zapier", deliveryId }` (like texts and ad syncs):
  no new SQS queue, no CDK change. Written with a queue at hand (the worker's jobs, `raiseAlert` called
  from a job's failure) it is queued at once; otherwise (an alert raised in an API request, a WhatsApp
  status report) the cron sweep sends it, last in each 15-minute tick, so alerts the tick's own sweeps
  raised go out in the same tick.
- At most **3 per store** in flight (coordinator slots); a fourth comes back 5–15 s later, spending nothing.
- Claimed with a conditional update (`pending|retrying → delivering`): a message delivered twice sends once.
- POST with `redirect: "manual"` and a 10 s timeout. **2xx** delivered. **410** the trigger is deleted
  and its waiting deliveries cancelled (Zapier's REST hook convention). **408, 429, 5xx, timeout, no
  answer**: retried with exponential backoff and jitter (30 s doubling to 1 h, ±20 %; a 429's
  Retry-After is honoured) up to **8 attempts**, then failed. **3xx** (never followed) and other 4xx:
  failed at once. Retries later than 15 minutes are sent by the sweep.
- A delivery left `delivering` for 5 minutes (the function stopped) is tried again by the sweep.
- Retention: events (and their deliveries) after 30 days, expired tokens after a day, revoked grants
  after 90 days; once a day.

## Security

- Tenancy: every row carries `workspace_id` with RLS; the grant fixes the store; Zapier's routes never
  take a workspace or store id; the settings routes look the store up inside the workspace.
- SSRF: only `https://hooks.zapier.com/hooks/…` is ever stored or posted to (checked on subscribe and
  again before every attempt), and redirects are not followed.
- Tokens and codes are random 256-bit values stored as hashes only; the client secret in Secrets
  Manager, compared in constant time; `zapier_tokens` unreadable by the tenant role.
- Revocation: Settings → Disconnect; removing the member (`removeMemberReleasingAds`); deleting the
  account; an unverified account taken over (`relinquishSetUp`); erasing or disconnecting the store
  (`purgeStoreData` deletes grants, triggers and outbox). Revoking cancels waiting deliveries and
  deletes the triggers; the tokens stop working at once. Revoked or lost permissions without removal
  (a membership revoked, "Manage integrations" taken away) make every request 401 and every delivery
  fail until restored.
- Audit log: `zapier.connected`, `zapier.disconnected`, `zapier.revoked` (with the reason).
- The route-access matrix (`apps/api/test/routeAccess.test.ts`) lists `/zapier/*` as bearer-only and
  checks owner cookies, shared links, API keys and made-up tokens all get 401 there.

## Settings → Integrations

`ZapierCard` (behind `ZAPIER_CARD`: `ZAPIER_ENABLED`, on in production since 2026-10-29, or `next dev`),
from `GET /api/workspaces/:ws/stores/:storeId/zapier` ("View integration connection status"):

- Not set up (`configured: false`): "Zapier isn't set up for bizinsights yet" to people who may manage
  integrations, no button; owners and admins see the setup checklist (which settings are set, never a
  value).
- Configured: **Connect** opens `ZAPIER_INVITE_URL` in Zapier ("Manage integrations"); each connection
  with who allowed it, when, its last use, its active triggers (a threshold that can't be checked says
  why), and **Disconnect** (`DELETE …/zapier/connections/:grantId`, "Manage integrations").
- Recent deliveries (last 20) with their outcome: Delivered, Sending, Retrying (reason, next try),
  Failed (reason and Zapier's HTTP status), Not sent.
- App Store workspaces don't see it (`APP_STORE_MODULES.zapier`).

## Owner setup

The exact commands are in [integrations/zapier/README.md](../integrations/zapier/README.md#owner-setup-register-and-push-the-app). In short:

1. `npx zapier-platform-cli login`, `register "bizinsights"`, `push` (from `integrations/zapier`).
2. Make a client id (any name) and a secret (32 random bytes, base64url); `zapier env:set <version>
   BASE_URL=https://bizinsights.io CLIENT_ID=… CLIENT_SECRET=…`.
3. Read the redirect URI (`zapier describe`) and the invite link (`zapier users:links`).
4. bizinsights: `ZAPIER_CLIENT_ID`, `ZAPIER_REDIRECT_URI`, `ZAPIER_INVITE_URL` in
   `apps/aws/src/settings.ts`; `node infra/cdk/scripts/put-secrets.mjs --set ZAPIER_CLIENT_SECRET`;
   pull request, merge, Deploy. The deploy's config check reports `zapier: { configured, inviteUrl }`
   and warns when the client id is set without its secret.
5. Try a Zap, then `ZAPIER_ENABLED = true` in `apps/web/src/lib/features.ts`.

Done for app 248720 (v1.0.0): live since release 130 (2026-10-29), and the first test Zap passed that
day on the owner's Zapier account. That Zap connected store PixMagic, and its New Alert, Find Ad
Performance and Find AdSense Earnings steps matched bizinsights' own figures. Turning it on and off
added and removed its hook. The owner then turned `ZAPIER_ENABLED` on, so merchants see the card.

| Setting | Where | What |
| --- | --- | --- |
| `ZAPIER_CLIENT_ID` | settings.ts | The OAuth client id, the same as the Zapier app's `CLIENT_ID` |
| `ZAPIER_CLIENT_SECRET` | Secrets Manager | The same as the Zapier app's `CLIENT_SECRET` (put-secrets refuses fewer than 40 characters) |
| `ZAPIER_REDIRECT_URI` | settings.ts | Zapier's OAuth return for this app, exactly (https) |
| `ZAPIER_INVITE_URL` | settings.ts | The app's invite link: what Connect opens |

## Troubleshooting

| Symptom | Why, and what to do |
| --- | --- |
| Pressing **Sign in** on Zapier seems to do nothing, and bizinsights' logs show no "zapier authorization allowed" | Zapier's sign-in pop-up first shows its own page (connect.zapier.com, "Connect to Zapier … Connect"), and only after **Connect** shows bizinsights' consent page (`/connect/zapier`). A pop-up behind the Zapier window, or one the browser blocked, sits on that first page. Bring it to the front (or allow pop-ups for zapier.com), press Connect, then sign in to bizinsights and Allow. |
| Zapier shows bizinsights' page saying the request "would send you somewhere other than Zapier" | `ZAPIER_REDIRECT_URI` isn't exactly the app's redirect URI (trailing slash, App id). Copy it from `zapier describe`. |
| "This request doesn't come from bizinsights' Zapier app" | The Zapier app's `CLIENT_ID` differs from `ZAPIER_CLIENT_ID`. |
| Connecting fails after Allow (Zapier says the token request failed) | `invalid_client`: `CLIENT_SECRET` differs from `ZAPIER_CLIENT_SECRET`, or the version's environment isn't set (`zapier env:get <version>`). Logs: "zapier token request refused" with the OAuth error. |
| Zapier keeps asking to reconnect | The member who connected it lost "Manage integrations", their access ended, they left, or the store was disconnected; or a refresh token was reused after the grace (logs: "refresh token reused"). Someone with Manage integrations connects again. |
| A trigger can't be set up: "can't see advertising figures" | The member lacks "View advertising analytics" (or "View campaigns" for WhatsApp). |
| Events don't arrive | Settings → Integrations → Recent events: Failed with a reason, Retrying, or Not sent (the Zap was turned off: Zapier answered 410). Alerts raised outside a job reach Zapier within one cron tick (15 minutes). |
| A threshold never fires | "Not checked: … report in AUD and USD": accounts in two currencies. Or no sync has run since the spend crossed it (thresholds are checked after syncs). |
| Everything answers `not_configured` | One of the three settings is missing; the config check names which. |

## Tests

- `apps/api/test/zapier.test.ts`: the OAuth happy path, Basic and JSON, wrong redirect URI, code reuse,
  expired code, refresh rotation and reuse detection, wrong client secret, not configured, a member who
  loses the permission (401) or is removed, store deleted, cookies / links / `sk_` keys refused,
  cross-tenant 404s, SSRF on subscribe, data permissions, alerts into the outbox, searches with mixed
  currencies, the Settings card and Disconnect.
- `apps/api/test/routeAccess.test.ts`: every new route classified; Zapier's bearer-only routes.
- `apps/worker/test/zapier.test.ts`: delivered once, dedupe, 5xx backoff, max attempts, 410, refusals
  and redirects, lost access, the per-store cap, the sweep, redaction, thresholds (once per period,
  mixed currencies, demo excluded, AdSense), the daily summary, WhatsApp failures.
- `packages/shared/test/zapier.test.ts`: periods, currency totals, thresholds, hook URLs, backoff,
  wording, `mayFixAlert`.
- `integrations/zapier`: `npm test` (Node's own test runner, appTester, nock, and Zapier's schema).

## Not built, and why

- **Meta Ads insights and AdSense through Zapier**: Zapier has no app that reads Meta Ads insights or
  spend, nor any Google AdSense app, so bizinsights keeps reading them with its own API clients and
  Zapier only receives what bizinsights stored.
- **Embedding Zapier in bizinsights** (Zapier's Workflow API, the embedded Zap editor): needs a publicly
  listed integration, which needs Zapier's review. v1 links to the app's invite URL instead.
- **Actions (sending messages from a Zap)**: none in v1. TODO, once WhatsApp runs on Meta's Cloud API
  only: a "Send WhatsApp template message" action, with its own permission, consent and rate checks, and
  its own consent-page line. Not before: the WhatsApp module is being rewritten.
- **Real-time alerts from API requests**: written without a queue, they wait for the next cron tick.
- **Not verified here**: a real Zapier account (registering, pushing, a live Zap), Zapier's own style
  checks (`zapier validate` against Zapier's servers), and the consent page in a browser against the
  deployed site.
