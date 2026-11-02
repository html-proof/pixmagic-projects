# Zapier

bizinsights has its own app on Zapier's Developer Platform ("bizinsights", [integrations/zapier](../integrations/zapier/README.md)).
A merchant connects their bizinsights store inside **their own Zapier account** (OAuth, one click:
bizinsights is the provider, there are no keys or addresses to copy) and uses bizinsights' triggers,
searches and its one action in their Zaps: an alert in Slack, ad spend over budget in an email,
yesterday's advertising in a Google Sheet, and a WhatsApp template to a new Meta or Google Ads lead
within minutes.

## Contents

1. [What Zapier can and can't do here](#what-zapier-can-and-cant-do-here)
2. [Architecture](#architecture)
3. [OAuth endpoints](#oauth-endpoints)
4. [Zapier's API](#zapiers-api)
5. [Events and payloads](#events-and-payloads)
6. [The action: Send WhatsApp Template Message](#the-action-send-whatsapp-template-message)
7. [Delivery](#delivery)
8. [Security](#security)
9. [Settings → Integrations](#settings--integrations)
10. [Owner setup](#owner-setup)
11. [Troubleshooting](#troubleshooting)
12. [Tests](#tests)
13. [Not built, and why](#not-built-and-why)

## What Zapier can and can't do here

| Kind | Key | What a Zap gets |
| --- | --- | --- |
| Trigger | `alert_raised` | Every bizinsights alert for the store, worded as the bell words it (`describeAlert`): a Shopify sync or webhook problem, an ad account that needs reconnecting, WhatsApp disconnected, an email account to reconnect... |
| Trigger | `ad_spend_threshold` | Once per day or month (the trigger's choice) when the store's stored Meta, Google or combined ad spend reaches an amount (for a platform without an ad account here, the spend its app reported to Shopify: [below](#ad-spend-reported-to-shopify)) |
| Trigger | `adsense_earnings_threshold` | The same on AdSense's estimated earnings; or, with "When" set to below, once a finished day or month ended under the amount |
| Trigger | `ads_daily_summary` | Once a day: yesterday's spend, impressions, clicks, conversions and platform-attributed purchase value / ROAS per platform, AdSense's estimates, and Shopify's own sales for the day |
| Trigger | `whatsapp_message_failed` | A WhatsApp message to a customer failed (number masked) |
| Trigger | `integration_connected` / `integration_disconnected` | Meta Ads, Google Ads, AdSense, WhatsApp or Zapier connected to, or disconnected from, the store |
| Trigger | `sync_completed` | An ad account's figures were read (at most once an hour per account), with the last day stored |
| Trigger | `order_paid` | A Shopify order was paid: number, amounts, items; never who bought it |
| Search | `find_ad_performance` | Meta / Google Ads figures for dates, each platform's own and together, from stored data (or reported to Shopify), with the last sync's time |
| Search | `find_adsense_earnings` | AdSense estimated earnings for dates |
| Action | `send_whatsapp_template` | Send WhatsApp Template Message: one customer, one of the store's WhatsApp templates, the values the Zap maps in. Only for a connection allowed to send ([below](#the-action-send-whatsapp-template-message)) |
| Trigger (hidden) | `whatsapp_templates` | The action's template dropdown: the store's templates that can send now |

Zapier **can't** change anything in bizinsights, Shopify or an ad account, see customers' names,
emails or full phone numbers, or reach another store or workspace. It sends customers nothing unless
an owner or admin ticked "Send WhatsApp template messages to your customers" when connecting it, and
then only the store's own WhatsApp templates, through the store's own WhatsApp rules. Each trigger also
stays within what the member who connected it may see (below).

The Zaps this makes possible across Meta Ads, Google Ads and WhatsApp (the ad apps are Zapier's own,
connected in the merchant's Zapier account; bizinsights is the last step):

| Zap | Trigger (app) | Action |
| --- | --- | --- |
| Thank a new Meta lead on WhatsApp | New Lead (Facebook Lead Ads) | Send WhatsApp Template Message (bizinsights): map the lead's phone, first name, the form's WhatsApp opt-in and the lead id as Unique key |
| Thank a new Google Ads lead on WhatsApp | New Lead Form Entry (Google Ads) | The same |
| Ad spend over budget | Ad Spend Passed an Amount (bizinsights) | An email, Slack, SMS... |
| Yesterday's ads in a sheet | Daily Advertising Summary (bizinsights) | Create Spreadsheet Row (Google Sheets) |
| A WhatsApp message to a customer failed | WhatsApp Message Failed (bizinsights) | A task, an email to the team |

## Architecture

```
 Zapier (merchant's account) ── "Connect bizinsights" ──► bizinsights.io/connect/zapier (consent page, apps/web)
        │                                                    │ member's session: GET /api/oauth/zapier/authorize
        │◄──────────── redirect with ?code&state ────────────┘                  POST /api/workspaces/:ws/stores/:id/zapier/authorize
        │── POST /api/oauth/token (client secret) ─► tokens zat_ (1 h) + zrt_ (rotating)
        │── /api/zapier/* (Bearer zat_) ─► me, hooks (subscribe/unsubscribe), samples, searches,
        │                                  whatsapp/templates, whatsapp/messages ─► core whatsapp/* queueMessage ─► Meta
        ▼
 hooks.zapier.com/hooks/... ◄── POST event ── worker (sync queue, kind "zapier") ◄── zapier_deliveries ◄── zapier_events (outbox)
                                                                                                          ▲
   raiseAlert (core notify.ts) ── alert_raised ──────────────────────────────────────────────────────────┤
   audit (core notify.ts) ── integration_connected / integration_disconnected ────────────────────────────┤
   runAdsSync (worker) ── zapierAfterAdSync ── thresholds, daily summary, sync_completed ─────────────────┤
   orders/paid webhook (worker handlers/webhooks.ts) ── order_paid ──────────────────────────────────────┤
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
| The WhatsApp action: scope, templates, consent, queueing | `packages/core/src/zapier/whatsapp.ts`; its input schema, scopes and limits in `@app/shared/zapier` |
| API | `apps/api/src/routes/zapierOAuth.ts`, `apps/api/src/routes/zapier.ts` |
| Consent page | `apps/web/src/app/connect/zapier/page.tsx` |
| Settings card | `apps/web/src/components/integrations/ZapierCard.tsx`, flag `ZAPIER_ENABLED` in `apps/web/src/lib/features.ts` |
| Tables | migrations `20261028120000_zapier_integration`, `20261029090000_zapier_grant_scopes` |
| The Zapier app | `integrations/zapier` (outside the pnpm workspace) |

Tables (all with `workspace_id` and RLS; none has a Prisma relation to users, workspaces or stores,
so the code that removes those removes these too):

| Table | Holds |
| --- | --- |
| `zapier_grants` | A connection: workspace, store, the member who allowed it, the client, its `scopes` (`whatsapp_send` when ticked on the consent page), last use, `revoked_at` and why |
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
| `GET /api/oauth/zapier/authorize?…` | the member's own session (never a shared link) | Checks the request: `client_id` is ours, `redirect_uri` matches exactly, `response_type=code`, a state. A wrong one is answered 400 with words and never redirected to. Answers the person's workspaces, each `allowed` when they hold "Manage integrations" there and its `scopes` (what they may also tick: `whatsapp_send` for owners and admins), with its stores, and the Cancel URL (`error=access_denied&state=…`). |
| `POST /api/workspaces/:ws/stores/:storeId/zapier/authorize` | the member's own session, "Manage integrations" | Allow, with `scopes` (none by default; `whatsapp_send` only from someone who may send from the WhatsApp page, else 403; anything else 400). Answers `{ redirect }`: the redirect URI with `code` and `state` (untouched). Codes: `zac_` + 256 random bits, single use, 5 minutes, kept in the coordinator under their SHA-256, bound to client, redirect URI, member, workspace, store and scopes. |
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
| `GET /zapier/me` | The connection test and its label: workspace, store (name, domain, currency, time zone), who connected it, its `scopes` |
| `POST /zapier/hooks` | Subscribe: `{ event, targetUrl, zapId?, platform?, period?, amount?, direction? }` → `{ id, event }` (`direction`: AdSense's threshold only, `above` by default or `below`). `targetUrl` must be `https://hooks.zapier.com/hooks/…` (no other host, port, credentials or IP). At most 50 per connection. A trigger the member may not have: 403 `no_permission` |
| `DELETE /zapier/hooks/:id` | Unsubscribe (this connection's triggers only; another's is a 404) |
| `GET /zapier/samples/:event` | The store's last 3 real events of the kind as this member would receive them; with none sent yet, its latest alerts, failed WhatsApp messages, yesterday's stored advertising, integrations connected or disconnected (its audit log), ad accounts' last syncs or paid orders; thresholds: `[]` until one fires. Never made-up data |
| `GET /zapier/search/ad-performance?platform&since&until` | Each platform's figures (`platforms`) and their totals, from stored data; `[]` with neither an ad account nor spend reported to Shopify. Dates `YYYY-MM-DD`, default the 7 days to yesterday, at most 400 days ([below](#find-ad-performance-each-platforms-own)) |
| `GET /zapier/search/adsense-earnings?since&until` | The same for AdSense |
| `GET /zapier/whatsapp/templates` | The store's templates that can send now (switched on; on Meta's Business Platform, approved by Meta too): `id, name, category, language, body, variables` (what the Zap fills in), `automatic` (`store_name`). Scope `whatsapp_send` |
| `POST /zapier/whatsapp/messages` | Send WhatsApp Template Message ([below](#the-action-send-whatsapp-template-message)): 201 queued, 200 for a key already sent. Scope `whatsapp_send` |

## Events and payloads

Every event is posted as one envelope; `id` is the happening's own key (the same for every Zap and
every retry, which Zapier uses to tell items apart). `schema_version` is the envelope's shape
(`ZAPIER_SCHEMA_VERSION`, now 1): raised only for a change that would break a Zap already mapping
fields (a field renamed, removed or changing type), never for a field added. Events written before it
existed go out as 1 too.

```json
{ "id": "alert_raised:<alertId>:<storeId>", "event": "alert_raised", "schema_version": 1, "occurred_at": "2026-10-28T09:00:00.000Z",
  "store": { "id": "…", "name": "Acme", "shop_domain": "acme.myshopify.com" }, "data": { … } }
```

No event carries a customer's name, email, address, phone number (WhatsApp's is masked), customer id
or discount code.

| Event | `data` | Written by | Once per |
| --- | --- | --- | --- |
| `alert_raised` | `alert_id, severity, area, title, body, fix_url, raised_at`: `describeAlert`'s wording, never the internal message | `raiseAlert` (an alert about no store goes to every store's triggers in the workspace) | alert and store |
| `ad_spend_threshold` | `trigger {platform, period, amount, direction}, period, period_start, period_end, period_complete, spend, currency, platforms[{platform, name, source, spend, currency, last_synced_at}], accounts[], last_successful_sync_at, freshness_note`; `shopify_marketing_note` when a platform's spend is from Shopify | `zapierAfterAdSync` (worker, after a successful ad sync), and `zapierAfterMarketingRead` (after a read of Shopify's marketing report), for that trigger only | trigger and period |
| `adsense_earnings_threshold` | the same with `earnings_estimated`, each account's `data_through`, and `estimates_note` (Google's estimates, adjusted after the month); `trigger.direction` says whether it was reached or ended below | the same | trigger and period |
| `ads_daily_summary` | `day, platforms[{platform, name, source, spend, currency, mixed_currencies, impressions, clicks, conversions, platform_attributed_purchase_value, platform_attributed_roas, accounts}], adsense, shopify {net_sales, total_sales, orders, currency}, accounts_without_the_day, freshness_note, attribution_note`; `shopify_marketing_note` when a platform's figures are from Shopify | after an ad sync or a read of Shopify's marketing report, and the cron sweep | store and day |
| `whatsapp_message_failed` | `message_id, source, type, category, phone_masked, reason, reason_text, automation_id, campaign_id, failed_at, view_url` | `applyMessageStatus` when a customer's message becomes failed (not tests, codes or team alerts) | message |
| `integration_connected` | `integration` (`meta_ads`, `google_ads`, `adsense`, `whatsapp`, `zapier`), `integration_name, accounts` (ad accounts connected, else null), `connected_at, settings_url`. Never who did it | `audit()` (core notify.ts), from the rows `ads.connected`, `whatsapp.connected`, `zapier.connected` (not the Google Ads demo, nor a sign-in still waiting for an ad account) | audit row |
| `integration_disconnected` | the same with `disconnected_at`, from `ads.disconnected`, `whatsapp.disconnected`, `zapier.disconnected` | the same | audit row |
| `sync_completed` | `integration, integration_name, connection_id, account_id, account_name, synced_at, data_through`. No figures: those are the advertising triggers' and searches' | `zapierAfterAdSync` after each successful sync of a real ad account | account and hour (UTC) |
| `order_paid` | `order_id, order_name, currency, total_price, subtotal, total_discounts, total_tax, total_shipping, financial_status, items, line_items[{product_id, variant_id, sku, title, quantity, price}]` (first 100), `sales_channel, processed_at` | the worker's `orders/paid` webhook (not test orders) | order |

- **Thresholds** are checked after each ad sync and each read of Shopify's marketing report (not its
  walk back through history), for the store's current period and the one before
  (platforms report late) when that one ended after the trigger was made. Periods are the store's
  calendar; each platform's rows are its account's own days. The Google Ads demo is left out (its
  figures are generated). Amounts in **different currencies are never added up**: such a trigger is
  not checked, and Settings says why (`check_note = mixed_currencies:AUD,USD`). A trigger made when
  the period's total is already over its amount fires at the next sync.
- **Falls below** (AdSense, `direction: "below"`): a period still running can't have ended below an
  amount, and one whose last days aren't stored would look lower than it was. So only the period
  before the current one is checked (the day or month just finished, when it ended after the trigger
  was made), and only once every connected AdSense account has `synced_through` on or after its last
  day; until then the next sync looks again. A finished period that ends exactly at the amount is not
  below it. One event per trigger and period, as above.
- **Integrations**: the audit log is where every connect and disconnect is already written, so
  `audit()` passes each row to `zapierAuditEvent`, which keeps only the six actions above. Written
  without a queue (most come from API requests): the cron sweep sends them within 15 minutes.
- **Ad account synced**: an account syncs every few minutes; a Zap hears of it once per account and
  UTC hour (the first sync of the hour). A use: refresh a sheet with Find Ad Performance.
- **Order paid**: from Shopify's `orders/paid` webhook, queued at once (the worker has its queue).
  Shopify sends webhooks more than once: the order's key makes one event.
- **Daily summary**: once every connected account has yesterday stored (`synced_through`) and, where
  Meta or Google has no ad account here, Shopify's marketing report is read through yesterday (only
  while its reads work: a refused or failing one isn't waited for), or from noon at the store with what
  there is (`accounts_without_the_day` lists the accounts without it). Purchase value and ROAS are each
  platform's own attribution, never store revenue; Shopify's sales are beside them.

### Ad spend reported to Shopify

A merchant whose Meta or Google Ads account isn't connected (until Meta's App Review, only people with
a role on bizinsights' Meta app can connect Meta) often has one ad figure only: the spend the
platform's app (Facebook & Instagram, Google & YouTube) reports to Shopify, which the dashboard shows
from `shopify_marketing_days` ([advertising.md](advertising.md), "Shopify marketing"). The ad spend
threshold, the daily summary and Find Ad Performance count it too (`reportedSpendByPlatform` in
`packages/core/src/zapier/ads.ts`):

- **Only for a store that reads it**: the capability "Ad spend reported to Shopify" (`shopify_marketing`,
  scope `read_reports`) is on, and its tables exist.
- **Never beside the platform's own figures**: per platform, as the dashboard picks it
  (`adPlatformSources`, without the store's orders): its ad accounts while they sync, or while their
  stored days reach into the dates; otherwise Shopify's, when Shopify has its spend for them. A
  platform from Shopify leaves its accounts out (their access ended before the dates), so no spend is
  counted from both. The Google Ads demo isn't an account here, as everywhere in Zapier.
- **As the dashboard counts it**: the channel's whole days only (`campaign = ''`, never its campaign
  rows, which are parts of those days); only the days read from Shopify with none missing
  (`covered_from` to `synced_through`); only spend above 0. A platform that reported no spend has no
  entry, never a 0. Its money is the store's currency.
- **Tagged**: such a platform is `source: "shopify_marketing"` in `platforms[]` (the others are
  `"platform_api"`), with `accounts: []`, `reported_by` (the apps, as Shopify names them),
  `last_synced_at` (Shopify's report last read) and `data_through`; its `conversions` and
  `platform_attributed_purchase_value` are the channel's own count of orders and their sales, and its
  ROAS is worked out from the days it reported spend, as the dashboard does. The payload's
  `shopify_marketing_note` says where the spend comes from and that it can reach Shopify a day late.
- **When**: a store with no ad account has no ad sync, so thresholds and the summary are also checked
  after each read of the report (`zapierAfterMarketingRead`, from the worker's `runShopifyMarketing`),
  every 6 hours and once a day for the last week; the cron sweep sends the summary as before.

### Find Ad Performance: each platform's own

`platforms[]` holds each platform's figures for the dates, the same entries as the daily summary's:
`platform, name, source, spend, currency, mixed_currencies, impressions, clicks, conversions,
platform_attributed_purchase_value, platform_attributed_roas, accounts`. A Zap that needs Meta's and
Google's purchase value or ROAS reads them there (or searches one platform).

**Deprecated**: with platform "Meta and Google Ads" and both in, the top-level
`platform_attributed_purchase_value` and `platform_attributed_roas` add Meta's claim to Google's.
Each platform credits purchases to its own ads by its own rules and both can claim the same order, so
that sum can count an order twice ([kpis.md](kpis.md): purchase claims are never added across
platforms). Those two fields stay, with the same values as before, for the Zaps that already map them;
`claims_add_up` is `false` when they add up two platforms' claims (`true` with one). New Zaps use
`platforms[]`. They will be removed only with a `schema_version` raise. Spend, impressions, clicks and
conversions at the top still add up across platforms.
- **Per person**: an alert goes only to triggers whose member could see it in the bell (`mayFixAlert`:
  ads → Manage integrations, WhatsApp → View campaigns, email → View integration status, staff →
  attendance, privacy → audit log, Shopify, Zapier's undelivered events and general → owners and
  admins). Ad triggers need "View advertising analytics", WhatsApp's "View campaigns and their
  performance", the integration and sync triggers "View integration connection status" (which every
  member who may connect Zapier has), "Order paid" "View sales and revenue". The daily summary's
  `shopify` block is `null` for someone without "View sales and revenue". Checked when the event is
  written and again at delivery.

## The action: Send WhatsApp Template Message

A Zap hands bizinsights a customer's number, one of the store's templates and the values
for its variables; bizinsights queues it on the store's own WhatsApp ([whatsapp.md](whatsapp.md),
"Sending") as source `zapier`, so it is the same message a dashboard send would be:

- **Who may**: a connection whose `scopes` hold `whatsapp_send`, ticked on the consent page (unticked
  by default, offered only to owners and admins: `stores:manage`, the people who may send from the
  WhatsApp page), while the member who connected it still may. A connection made without it answers
  403 `scope_missing` ("connect again and tick it"); a member who lost the permission, 403
  `no_permission`.
- **Templates only**, switched on, and on Meta's Business Platform approved by Meta and sent by Meta's
  name for it; a phone linked by QR code sends the template's text, as the store's automations do
  (`template_unavailable` otherwise). A Zap can't know whether the customer wrote in the last 24 hours,
  so free text isn't offered. `{{store_name}}` is
  the business's name from WhatsApp Settings; `{{customer_first_name}}` is the Zap's value, else the
  name bizinsights has for the number (the First name field fills it in). Values are put on one line
  (Meta refuses new lines, tabs and runs of spaces in a parameter), at most 200 characters
  (`value_too_long`); a value the template needs and the Zap didn't give is refused (`missing_values`)
  before anything is recorded.
- **Consent**, checked now and again when it is sent ([whatsapp.md](whatsapp.md), "Consent"). "The
  customer agreed to WhatsApp messages from you" = Yes records the customer's consent (order updates,
  or marketing for a marketing template) with source `zapier`, the member as actor and "Where they
  agreed" as the note. No: it goes only if the customer's consent is already there. A number
  bizinsights knows only from a Zap (no Shopify customer, no order) needs the customer's own
  agreement even under "Customers told at checkout", which covers the store's own customers. A
  customer who replied STOP: 409 `opted_out` (only their START undoes it). Marketing templates need
  marketing switched on and the customer's marketing yes.
- **Once per key**: Unique key (required: map the lead's or order's id; Zapier doesn't give an action
  the trigger item's id) makes a template go once per key **per store**, whichever Zap or connection
  sends it: a replayed task, a copied Zap, Zapier connected again or by another owner (a new grant)
  all find the first message (`duplicate: true`). Another template with the same key (a follow-up
  Zap) is another message. Nothing compares a Zap with bizinsights' own WhatsApp automations: an
  automation on "order paid" and a Zap on the same order both send (the customer's daily limit still
  applies), so use one or the other for an event.
- **WhatsApp's limits**: counted in the store's daily limit and the customer's daily limit, kept to
  the sending hours (a lead at 2 am gets it when the hours open), held by Pause all automation, paced
  per number, Meta's own limits and the circuit breaker. On top, 60 a minute per store from Zapier
  (429: Zapier holds the task and tries again).
- **What Zapier gets back**: the message id, its status (`queued`), the masked number, the template,
  whether consent was recorded, when it may go out, and a link to the WhatsApp page's Messages (source
  "Zapier"). What happens next is the WhatsApp page's; a message Meta refuses fires **WhatsApp Message
  Failed**.
- **Audit**: `whatsapp.message_sent` with `via: "zapier"`, the grant, the Zap's id and whether consent
  was recorded.
- **Testing the step in Zapier sends a real message** (Zapier runs an action for real when it is
  tested); the phone field's help says to use your own number.

A store with no WhatsApp connected gets `not_connected`. Any store can link a phone by QR code;
until Meta approves bizinsights as a Tech Provider, only businesses with a role on the Meta app can
connect Meta's Business Platform ([whatsapp.md](whatsapp.md)).

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
- **Failed for good** (any reason): the store's owners and admins get the alert
  `zapier_delivery_failed`, "Some events didn't reach Zapier" (bell, email; area `integrations`,
  linking to Settings → Integrations), once while it is open. It is resolved once none of the store's
  triggers has a failed delivery left: each was sent again with **Retry**, or its trigger is gone (the
  Zap turned off, Zapier disconnected, the outbox's 30 days). Checked after each delivery that lands
  and by the sweep. The alert is itself a "New alert" event, so another Zap (Slack, email) hears of it.
- **Retry** (`POST …/zapier/deliveries/:id/retry`, owners and admins): a failed delivery whose trigger
  is still there goes back to pending with its attempts at 0, and is queued at once; the member
  behind the connection is checked again at delivery. 409 `not_failed` for one that isn't failed, 409
  `trigger_gone` when its trigger is gone. Audit `zapier.delivery_retried`.
- Retention: events (and their deliveries) after 30 days, expired tokens after a day, revoked grants
  after 90 days; once a day.

## Security

- Tenancy: every row carries `workspace_id` with RLS; the grant fixes the store; Zapier's routes never
  take a workspace or store id (another store's template id is "not found"); the settings routes look
  the store up inside the workspace.
- Scopes: sending is a scope of its own, ticked by an owner or admin, kept on the grant and checked
  with the member's permission on every request. A code carries the scopes it was issued with; an
  unknown scope is refused at Allow, never stored.
- SSRF: only `https://hooks.zapier.com/hooks/…` is ever stored or posted to (checked on subscribe and
  again before every attempt), and redirects are not followed.
- Tokens and codes are random 256-bit values stored as hashes only; the client secret in Secrets
  Manager, compared in constant time; `zapier_tokens` unreadable by the tenant role.
- Secret rotation: `ZAPIER_CLIENT_SECRET_PREVIOUS` (Secrets Manager) is accepted too while every
  version of the Zapier app moves to the new secret; each request still using it is logged ("zapier
  client used the previous secret"). Steps: [RUNBOOK](RUNBOOK.md#rotate-the-zapier-client-secret).
- Revocation: Settings → Disconnect; removing the member (`removeMemberReleasingAds`); deleting the
  account; an unverified account taken over (`relinquishSetUp`); erasing or disconnecting the store
  (`purgeStoreData` deletes grants, triggers and outbox). Revoking cancels waiting deliveries and
  deletes the triggers; the tokens stop working at once. Revoked or lost permissions without removal
  (a membership revoked, "Manage integrations" taken away) make every request 401 and every delivery
  fail until restored.
- Audit log: `zapier.connected`, `zapier.disconnected`, `zapier.revoked` (with the reason),
  `zapier.trigger_subscribed` and `zapier.trigger_unsubscribed` (a Zap turned on or off, as the member
  who connected it; metadata: event, Zap id, connection; Zapier's 410 with no actor and
  `reason: zapier_answered_410`), `zapier.delivery_retried`.
- The route-access matrix (`apps/api/test/routeAccess.test.ts`) lists `/zapier/*` as bearer-only and
  checks owner cookies, shared links, API keys and made-up tokens all get 401 there.

## Settings → Integrations

`ZapierCard` (behind `ZAPIER_CARD`: `ZAPIER_ENABLED`, on in production since 2026-10-29, or `next dev`),
from `GET /api/workspaces/:ws/stores/:storeId/zapier` ("View integration connection status"):

- Not set up (`configured: false`): "Zapier isn't set up for bizinsights yet" to people who may manage
  integrations, no button; owners and admins see the setup checklist (which settings are set, never a
  value).
- Configured: **Connect** opens `ZAPIER_INVITE_URL` in Zapier ("Manage integrations"); each connection
  with who allowed it, when, its last use, whether it may send WhatsApp template messages, its active
  triggers (a threshold that can't be checked says why), and **Disconnect** (`DELETE …/zapier/connections/:grantId`, "Manage integrations").
- Recent deliveries (last 20) with their outcome: Delivered, Sending, Retrying (reason, next try),
  Failed (reason and Zapier's HTTP status), Not sent. Owners and admins see **Retry** beside a failed
  one whose trigger is still there (`retryable`).
- An AdSense trigger watching for "below" reads "Estimated earnings ending a day below 20".
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
6. A new version of the Zapier app (1.2.0 added the WhatsApp action): `push`, give it the three values
   (`env:set`, or copied from the previous version), then `promote` it so existing Zaps move onto it.

Done for app 248720 (v1.0.0): live since release 130 (2026-10-29), and the first test Zap passed that
day on the owner's Zapier account. That Zap connected store PixMagic, and its New Alert, Find Ad
Performance and Find AdSense Earnings steps matched bizinsights' own figures. Turning it on and off
added and removed its hook. The owner then turned `ZAPIER_ENABLED` on, so merchants see the card.

A new version of the Zapier app (new triggers, changed fields) goes out only after the bizinsights
side it calls is live, through a staging version the owner tries first:
[integrations/zapier/README.md](../integrations/zapier/README.md#a-new-version-staging-then-promote).

| Setting | Where | What |
| --- | --- | --- |
| `ZAPIER_CLIENT_ID` | settings.ts | The OAuth client id, the same as the Zapier app's `CLIENT_ID` |
| `ZAPIER_CLIENT_SECRET` | Secrets Manager | The same as the Zapier app's `CLIENT_SECRET` (put-secrets refuses fewer than 40 characters) |
| `ZAPIER_CLIENT_SECRET_PREVIOUS` | Secrets Manager | Only during a rotation: the secret before it, still accepted. `put-secrets --set ZAPIER_CLIENT_SECRET` keeps the replaced one here; `--unset ZAPIER_CLIENT_SECRET_PREVIOUS` ends the rotation |
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
| The WhatsApp action: "wasn't allowed to send WhatsApp messages" | The connection was made without the tick. An owner or admin connects bizinsights again in Zapier and ticks "Send WhatsApp template messages to your customers". |
| The WhatsApp action: "The customer hasn't agreed to WhatsApp updates" | A lead (a number with no Shopify order) needs their own consent: map the form's opt-in into "The customer agreed to WhatsApp messages from you" and say where in "Where they agreed". |
| The WhatsApp action: the template isn't in the dropdown | Only templates switched on are listed, and on Meta's Business Platform only those Meta approved (WhatsApp page → Templates). |
| The WhatsApp action: "WhatsApp isn't connected" | The store has no WhatsApp connected: link a phone by QR code, or connect Meta's Business Platform (until Meta approves bizinsights as a Tech Provider, only businesses with a role on the Meta app can). |
| The action ran, but the message hasn't gone | Sending hours (it waits until they open), Pause all automation, the daily limits: WhatsApp page → Messages, source Zapier, says why it waits. |
| Events don't arrive | Settings → Integrations → Recent events: Failed with a reason, Retrying, or Not sent (the Zap was turned off: Zapier answered 410). Alerts raised outside a job reach Zapier within one cron tick (15 minutes). |
| A threshold never fires | "Not checked: … report in AUD and USD": accounts in two currencies. Or no sync has run since the spend crossed it (thresholds are checked after syncs). |
| An AdSense "below" trigger doesn't fire for a day that was low | Only the day (or month) just finished is checked, and only once every AdSense account has it stored (`synced_through` on or after its last day). A day that ended exactly at the amount isn't below it. A day finished before the trigger was made is skipped. |
| "Some events didn't reach Zapier" in the bell | Settings → Integrations → Zapier → Recent events: the failed one says why. Fix that in Zapier (the Zap turned back on, the step that refused it), then Retry. The alert resolves once none is left failed. |
| Logs: "zapier client used the previous secret" | A secret rotation isn't finished: a version of the Zapier app still has the old `CLIENT_SECRET` (`env:get` each version in use, without printing it: RUNBOOK). |
| "Integration connected" arrives up to 15 minutes late | Written in the API request, which has no queue at hand: the cron sweep sends it. |
| Everything answers `not_configured` | One of the three settings is missing; the config check names which. |

## Tests

- `apps/api/test/zapier.test.ts`: the OAuth happy path, Basic and JSON, wrong redirect URI, code reuse,
  expired code, refresh rotation and reuse detection, wrong client secret, the previous secret during
  a rotation and not after, not configured, a member who loses the permission (401) or is removed,
  store deleted, cookies / links / `sk_` keys refused, cross-tenant 404s, SSRF on subscribe, data
  permissions (the new triggers' too), AdSense's direction, trigger audit rows, the new triggers'
  samples, alerts into the outbox, searches with mixed currencies, the Settings card, Disconnect and
  Retry.
- `apps/api/test/zapierWhatsapp.test.ts`: the scope on the consent page (owners and admins only,
  unticked by default, unknown scopes refused), the template list, a lead who agreed sent a template
  with the Zap's values through the store's linked phone, consent recorded with its note, once per key
  per store (Zapier connected again, a second owner; another template with the same key sends; no key
  refused), missing values (nothing recorded), a lead without consent, STOP, marketing consent, Pause all
  automation, another store's template, a demoted member, not connected, a bad number; on Meta's
  Business Platform, a template Meta hasn't approved isn't offered or sent.
- `apps/api/test/routeAccess.test.ts`: every new route classified; Zapier's bearer-only routes.
- `apps/worker/test/zapier.test.ts`: delivered once, dedupe, 5xx backoff, max attempts, 410, refusals
  and redirects, lost access, the per-store cap, the sweep, redaction, thresholds (once per period,
  mixed currencies, demo excluded, AdSense, falls below), the daily summary, WhatsApp failures,
  `schema_version` on old events, the failed-delivery alert and Retry, ad accounts synced, integrations
  from audit rows, orders paid through the real `orders/paid` webhook (no customer details).
- `packages/shared/test/zapier.test.ts`: periods, currency totals, thresholds (below too), hook URLs,
  backoff, wording, permissions, `mayFixAlert`, the failed-delivery alert's wording.
- `infra/cdk/test/put-secrets.test.ts`: the previous secret's shape, what `--set` keeps and `--unset` may remove.
- `integrations/zapier`: `npm test` (Node's own test runner, appTester, nock, and Zapier's schema).

## Not built, and why

- **Meta Ads insights and AdSense through Zapier**: Zapier has no app that reads Meta Ads insights or
  spend, nor any Google AdSense app, so bizinsights keeps reading them with its own API clients and
  Zapier only receives what bizinsights stored.
- **Embedding Zapier in bizinsights** (Zapier's Workflow API, the embedded Zap editor): needs a publicly
  listed integration, which needs Zapier's review. v1 links to the app's invite URL instead.
- **Free-text WhatsApp messages from a Zap**: a Zap can't know whether the customer wrote in the last
  24 hours, outside which Meta delivers only approved templates. Templates only.
- **Other actions** (changing bizinsights, SMS or email from a Zap): none. Zapier's own email and SMS
  apps cover those.
- **A "WhatsApp message received" trigger**: it would hand customers' messages and full numbers to
  Zapier, which the consent page promises it never sees.
- **Real-time alerts and integration events from API requests**: written without a queue, they wait
  for the next cron tick.
- **"Falls below" for ad spend**: only AdSense has it. Spend below a budget is rarely news in itself,
  and a day's spend keeps arriving for days after it (platforms report late).
- **Shopify syncs in "Ad account synced"**: only ad accounts; Shopify's own syncs are continuous
  (webhooks), so there is no "finished" moment to report.
- **A `zapier` module in `GET …/integrations`**: that route comes with PR #283, not on `main` when
  this was built; add the module there once it lands.
- **Not verified here**: a real Zapier account (registering, pushing, a live Zap), Zapier's own style
  checks (`zapier validate` against Zapier's servers), and the consent page in a browser against the
  deployed site.
