# WhatsApp (Cloud API)

Insights sends a store's customers WhatsApp messages from the store's own WhatsApp Business number, through Meta's
official **WhatsApp Business Platform (Cloud API)**: order and delivery updates, abandoned-cart reminders, review
requests, merchant-written campaigns and merchant-written automations. There is no WhatsApp Web automation, no
browser session, and no credential in the code.

Everything is off until a merchant turns it on. A store has WhatsApp "on" once it has a `whatsapp_settings` row
(saving WhatsApp settings or connecting a number creates it). Until then the Shopify event handlers do nothing extra.

## Where things live

| Part | Code |
| --- | --- |
| Pure logic: phone numbers, notification kinds, template library, error handling, sending hours, automation conditions | `packages/shared/src/whatsapp.ts` |
| Meta Graph API client (code exchange, number, templates, send) | `packages/core/src/whatsapp/graph.ts` |
| Encryption, contacts and consent, settings, template sync | `packages/core/src/whatsapp/store.ts` |
| The message queue and sender | `packages/core/src/whatsapp/messages.ts` |
| Shopify events → timeline, tracking links, notifications, carts, attribution, shipment poll, GDPR | `packages/core/src/whatsapp/events.ts` |
| Meta webhooks (statuses, STOP/START, preferences, template reviews) | `packages/core/src/whatsapp/webhook.ts` |
| Campaigns, automations, the sweeper and retention | `campaigns.ts`, `automations.ts`, `scheduler.ts` (same folder) |
| Merchant API | `apps/api/src/routes/whatsapp.ts`, `whatsappOps.ts`, `whatsappCommon.ts` |
| Public routes: Meta webhook, tracking page, review form, tracked links | `apps/api/src/routes/whatsappPublic.ts` |
| Worker wiring (queue consumer, Shopify webhooks, cron) | `apps/worker/src/handlers.ts`, `apps/worker/src/index.ts` |
| Dashboard | `apps/web/src/app/(app)/whatsapp/*`, `apps/web/src/components/whatsapp/*` |
| Customer pages | `apps/web/src/app/track`, `apps/web/src/app/review` |
| Tests | `packages/shared/test/whatsapp.test.ts`, `apps/worker/test/whatsapp.test.ts`, `apps/api/test/whatsapp.test.ts` |

## Data model (migration `20261010160159_whatsapp`)

Every table carries `workspace_id` and has the same row-level-security policy as the rest of the schema
(`tenant_isolation`). The merchant API reads through `withTenant` *and* filters by workspace and store; the public
routes and the worker use the owner role and are scoped by token, signature or store id.

| Table | Holds | Notes |
| --- | --- | --- |
| `whatsapp_connections` | The store's number: WABA, phone number id, name, quality, limit tier, status | One per store. Access token, app secret and verify token AES-256-GCM encrypted, AAD `wa:<storeId>:<kind>` |
| `whatsapp_settings` | The store's config (validated by `whatsappConfigSchema`): which notifications, which templates, consent basis, sending hours, limits | Who chose the consent basis, and when |
| `whatsapp_templates` | Templates in the WABA as Meta last reported them (status, category, components) | Synced on connect, Refresh, and template webhooks |
| `whatsapp_contacts` | A customer's number (encrypted), first name (encrypted), masked number, keyed hash, marketing status, opt-out | Opt-outs are kept so nobody who said STOP is messaged again |
| `whatsapp_messages` | The queue **and** the history: one row per message, unique per store and purpose (`dedupe_key`) | Campaign recipients are the rows with a `campaign_id`. Send details encrypted, cleared once sent |
| `whatsapp_message_events` | Meta's delivery callbacks, once per message and status | |
| `order_trackings` / `order_tracking_events` | An order's tracking page (random token, only its SHA-256 is looked up) and timeline | `shipment_rank` is the least advanced parcel |
| `abandoned_checkouts` | Checkouts with a phone number that weren't finished | Recovery link and name encrypted |
| `whatsapp_campaigns` | Campaigns: template, values, audience, schedule, who authorized it | |
| `customer_reviews` | One review per order and product (editable), moderation status and reason | |
| `whatsapp_automation_rules` / `whatsapp_automation_runs` | Trigger → conditions → action, and each run | A run is unique per rule, trigger and subject |

Audit events use the existing `audit_logs`; "notify the team" uses the existing `alerts` (severity `info`).

### Data and retention

Analytics still store no customer personal data. WhatsApp, once connected, keeps what messaging needs:

- Customers' WhatsApp numbers and first names, encrypted; a keyed hash (`HMAC(OTP_PEPPER, "wa:<store>:<number>")`)
  finds a contact from Meta's webhooks; the dashboard only ever shows masked numbers (`+91 ••••••• 210`).
- A message's details (name, delivery address, links) are encrypted in the row and deleted once it is sent.
  Failed/skipped messages keep them 7 days (so they can be retried), then lose them.
- Retention (`RETENTION` in `scheduler.ts`, applied daily): messages 180 days; checkout links and names 30 days,
  checkout rows 90; order timelines a year (links stop working after 120 days); automation runs 90 days.
- `customers/redact` deletes the customer's contact, messages, timelines and reviews; `shop/redact` purges every
  WhatsApp table for the store (`purgeStoreData`). `customers/data_request` is audited with the WhatsApp record count.

`/privacy` says all of this. Change it with the code.

## How it works

### Sending

1. An event (a Shopify webhook, a campaign starting, a rule firing) **schedules** a message: a row with a dedupe key,
   so Shopify retries, duplicate deliveries and two rules firing together still send once.
2. A message due within 12 hours goes on the queue (the existing `insights-sync` queue, `kind: "whatsapp"`, like ad
   syncs: nothing new to provision). The 15-minute cron sweeper catches everything else: later messages, lost queue
   messages, and campaign batches (`kind: "whatsapp_dispatch"`, 25 per invocation, chained).
3. Right before sending, everything is checked **again**: connection active and registered; template approved; the
   customer hasn't opted out; consent (below); the order not cancelled; the checkout not completed; no review yet;
   the campaign not paused or ended; marketing sending hours; the weekly marketing cap; the number's daily
   conversation limit; 20 sends per second per number.
4. Meta's answer decides what happens next (`classifyGraphError`): rate limits and outages retry with backoff
   (30 s, 2 min, 10 min, 30 min, 2 h, then failed); an expired or revoked token marks the connection "reconnect" and
   holds messages (cancelled after 48 h); a customer who stopped marketing is recorded; anything else fails with a
   readable reason.
5. A message cut off mid-send (the Worker killed) is marked failed, never re-sent on its own: Meta may have it, and a
   duplicate is worse than a retry the merchant chooses.

### Consent

- **Order and delivery updates** (templates Meta approved as *utility*): the merchant chooses how customers agree
  (WhatsApp → Settings). Until they do, nothing is sent. Choices: their checkout tells customers (attested, audited);
  only orders with the `whatsapp_opt_in` cart attribute; only customers who accepted Shopify's text-message marketing.
- **Marketing** (cart reminders, campaigns, anything Meta approved as *marketing*): only customers who opted in on
  WhatsApp (START, Meta's own preference) or, if the merchant says their wording covers WhatsApp, Shopify's
  text-message marketing consent.
- The category Meta actually gave a template decides which rule applies, not the category Insights asked for.
- **STOP** (and similar words) stops everything; the marketing templates' **Stop promotions** button and Meta's
  `user_preferences` webhook stop marketing only. Merchants can record an opt-out given another way.

#### The `whatsapp_opt_in` cart attribute

For the "only customers who tick a box" choice, add a checkbox to the cart page. In most themes, inside the cart
`<form>`:

```html
<label>
  <input type="checkbox" name="attributes[whatsapp_opt_in]" value="yes">
  Send me order and delivery updates on WhatsApp (reply STOP to end them)
</label>
```

Shopify copies cart attributes onto the order as `note_attributes`, which the order webhook carries.

### Order and delivery updates

- **Order confirmed**: the first time Shopify reports the order (any order topic; whichever arrives first). Not for an
  order that arrives cancelled, or one first seen more than 48 hours after it was placed.
- **Payment confirmed**: only when an order that wasn't paid at checkout becomes paid (COD, bank transfer).
- **Processing / Packed**: from order tags the merchant adds in Shopify (names in Settings), or the timeline buttons.
- **Shipped / Out for delivery / Delivered / Delivery failed**: from fulfillments in order payloads
  (`orders/updated`, `orders/fulfilled`, `orders/partially_fulfilled`), from `fulfillments/*` and
  `fulfillment_events/create` if the app is ever given `read_fulfillments`, and from a GraphQL poll every 2 hours for
  parcels in transit (`Order.fulfillments.displayStatus`, `read_orders` is enough).
- A stage is announced only when it moves that parcel forward (late or repeated webhooks are put on the timeline but
  never announced, and nothing older than 48 hours is announced). **Delivered** needs every parcel delivered, from
  the courier through Shopify or from the merchant's own button. It is never inferred from time. With no courier
  events, the tracking page says live delivery status isn't available.
- **Cancelled** cancels whatever is waiting for the order and (if turned on) tells the customer.
- **Refund processed**: from `refunds/create`, with the refunded amount.

### Abandoned carts

`checkouts/create` and `checkouts/update` with a phone number create a row (anonymous checkouts are never stored).
Reminder 1 is scheduled `cartFirstDelayMinutes` after the customer's last change (moved back while they keep
editing); reminder 2 (optional) after that if reminder 1 was sent. The link is Shopify's own recovery URL, through
a tracked redirect (`/api/r/<code>`). The order for that checkout (`checkout_token`), or `completed_at` on the
checkout, cancels pending reminders. A cart counts as **recovered** when its order arrives within 7 days after a
reminder was **sent**; each order once.

### Reviews

After a confirmed delivery a review request is scheduled `reviewDelayDays` later (and an optional single reminder).
The link is a separate random token for the order. Customers rate the order and each product (1 to 5) and can edit
for 60 days; one review per order and product. Merchants publish or remove; removing needs a policy reason (spam,
abusive, personal information, off topic, not a customer experience: "negative" is not one), and every moderation is
audited with the rating. Published reviews are at `GET /api/public/stores/<storeId>/reviews[?productId=]`.

### Campaigns

The merchant writes a campaign (occasion, approved *marketing* template, values, link, discount code, audience,
start and end) and schedules it after confirming the exact recipient count (`confirmRecipients` must equal the
current estimate). Scheduling needs a registered number and a verified webhook (so STOP replies can arrive).
Recipients are chosen when it starts, and each message re-checks consent. Pause, resume and cancel at any time;
unsent messages are cancelled at the end time. Nothing is sent because a date is near.

### Automations

Trigger → conditions (all must hold) → one action. Triggers: order created, payment confirmed, fulfillment created,
tracking updated, delivered, checkout abandoned, cart recovered, review request due, customer opted in, refund
created. Actions: send an approved template (now or later), cancel pending messages, notify the team, record an
audit event. A rule runs at most once per trigger and subject; actions never raise triggers (no loops); two rules
that would undo each other can't both be enabled; the same template from two rules reaches a customer once. "Test"
evaluates a rule against a recent order without doing anything (and can send the template to your own number).

### Attribution (be honest about it)

- **Recovered carts**: the checkout's own order within 7 days after a sent reminder.
- **Campaign conversions**: an order is credited once (a unique index), to the last campaign message its customer
  received within `attributionDays` (default 3) before buying. This is "followed", not "caused", and the dashboard
  says so. Orders using the campaign's discount code are shown separately (from anyone).
- **Costs**: Meta reports which messages are billable and their category, not prices, so Insights shows counts and
  points to WhatsApp Manager for amounts.

### Security

- Meta webhooks: `X-Hub-Signature-256` (HMAC-SHA256 of the raw body, app secret) is verified before anything is
  applied. Insights' own app secret vouches for every number connected through Embedded Signup; a manual connection's
  own app secret vouches only for its own WABA, and a change about any other account is ignored. The GET handshake
  answers only Insights' verify token or a connection's own (stored hashed). A status for a message we're still
  recording gets a 503 so Meta retries it.
- Shopify webhooks keep their existing HMAC check, dedupe and shop binding; WhatsApp runs after the analytics write,
  idempotently, inside the same job.
- Tokens and secrets never leave the server; tracking and review links are 24 random bytes (only SHA-256 stored),
  expire, and are `noindex` + `no-referrer`. Order ids never find anything.
- Rate limits: connect, refresh, template submission, test sends and cart reminders per store; tracking, review and
  link pages per IP; review submissions per order (`apps/api/src/rateLimit.ts`).
- Logs redact phone numbers, `wa_id`, PINs, verify tokens, the signature header and Meta tokens (`EA…`).

## Setting it up

### 1. Meta (owner, in a browser; none of this can be done from code)

1. A **Meta Business portfolio** for Insights, **business verification** done (Security Center).
2. A **Meta app** (type Business). The ad accounts' app can be reused: then `WHATSAPP_APP_ID`/`WHATSAPP_APP_SECRET`
   may stay empty and `META_APP_ID`/`META_APP_SECRET` are used.
3. Add the **WhatsApp** product. To onboard merchants with one click, become a Tech Provider and create a Facebook
   Login for Business **configuration** with the *WhatsApp Embedded Signup* login variation (Embedded Signup v4; v2
   is deprecated on 2026-10-15). Its id is `WHATSAPP_CONFIG_ID`.
4. Permissions `whatsapp_business_messaging` and `whatsapp_business_management` with **Advanced Access** (App Review).
5. App settings: add `insights.imeseban.workers.dev` to **App domains**, **Allowed domains for the JavaScript SDK**
   and **Valid OAuth redirect URIs** (Embedded Signup only returns ids to listed HTTPS domains).
6. WhatsApp → Configuration → **Webhook**: callback URL `https://insights.imeseban.workers.dev/api/webhooks/whatsapp`,
   verify token = the value you put in `WHATSAPP_WEBHOOK_VERIFY_TOKEN` (any long random string). Subscribe to
   `messages`, `message_template_status_update`, `template_category_update`, `message_template_quality_update`,
   `phone_number_quality_update`, `account_update` and `user_preferences`.
7. Each merchant adds a **payment method** in WhatsApp Manager and gets their **display name** approved; Meta's
   messaging limit grows with quality.

**Without an Insights Meta app** a merchant can still connect their own, in three steps on Connect WhatsApp:

1. Paste a system-user token (permanent, with the two permissions above, assigned to the WABA). Insights asks Meta
   (`debug_token`) which app it belongs to and which WABAs it was given, and lists their numbers
   (`POST …/whatsapp/manual/discover`; nothing is saved).
2. Pick the number. If Meta doesn't list the token's accounts, the page asks for the WABA id and phone number id.
3. Paste the app secret (the page links straight to that app's Basic settings). Insights checks it belongs to the
   token's app (an app access token call), saves the connection, then points the app's WhatsApp webhook at itself
   (`POST /{app-id}/subscriptions` with the connection's own verify token; Meta runs the handshake there and then).

An app whose WhatsApp webhook already goes to another URL is left alone, and the page shows the callback URL and
verify token to set by hand, as it does if Meta refuses the subscription.

### 2. Server (owner)

Public ids in `apps/cloudflare/wrangler.jsonc` `vars` (`WHATSAPP_APP_ID`, `WHATSAPP_CONFIG_ID`,
`WHATSAPP_API_VERSION`), secrets with `npx wrangler secret put WHATSAPP_APP_SECRET` and
`npx wrangler secret put WHATSAPP_WEBHOOK_VERIFY_TOKEN`. Example placeholders are in `.env.example` and
`apps/cloudflare/.dev.vars.example`. Without them the dashboard says Meta's sign-up isn't set up (and offers the
manual route); nothing pretends to be connected.

### 3. Shopify

- Webhook topics added to both `shopify-app/shopify.app*.toml`: `orders/fulfilled`, `orders/partially_fulfilled`,
  `checkouts/create`, `checkouts/update` (all `read_orders`; no new scope). They take effect with
  `cd shopify-app && shopify app deploy` (and `--config pixmagic` for the custom app).
- **Protected customer data, Level 2** (name, phone, address) must be approved for live stores: until then Shopify
  redacts them from webhooks and messages are recorded as skipped ("no WhatsApp number"). Development stores are
  exempt, which is how to test.
- `read_fulfillments` (carrier events by webhook) is optional and not requested; the poll covers it.

### 4. Deploy

Run the migration against production **before** deploying (as for every schema change; back up first):
`DATABASE_URL=... pnpm db:migrate`. Then deploy the Worker as usual. The new cron work rides the existing `*/15`
trigger and queue; nothing else to provision.

### 5. First use (merchant)

Connect WhatsApp → register the number (6-digit PIN) if asked → Message templates: submit Insights' templates (or
create your own) and wait for approval → Settings: choose the consent basis → turn notifications on and pick each
template → send yourself a test.

## Testing

```bash
pnpm --filter @app/shared test
```

```bash
TEST_PG_PORT=5447 TEST_DB=wa_test pnpm --filter @app/worker exec vitest run test/whatsapp.test.ts
```

```bash
TEST_PG_PORT=5447 TEST_DB=wa_test pnpm --filter @app/api exec vitest run test/whatsapp.test.ts
```

Use a throwaway Postgres for `TEST_PG_PORT`, not the one that hosts production. Meta is faked in tests; no message
leaves the machine.

A local demo with sample data: start the `wa-demo` launch configuration (`.claude/wa-demo-server.mjs`, port 8793,
database `wa_demo` on that throwaway Postgres), sign in with an emailed code from Mailpit, then
`WA_DEMO_EMAIL=<that email> npx vitest run --config demo/vitest.config.ts` from `apps/worker`.

For a real end-to-end check, use a development store, Meta's test phone number (WhatsApp → API Setup) and your own
phone as the only recipient. Don't send promotional messages to real customers while testing.
