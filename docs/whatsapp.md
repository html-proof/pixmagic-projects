# WhatsApp Automation

bizinsights sends a store's customers WhatsApp messages from the store's own WhatsApp Business
number, through Meta's official **WhatsApp Business Platform (Cloud API)**. The merchant connects
the number with Meta's own sign-up window ("Connect WhatsApp"), writes or picks message templates,
builds workflows (trigger → conditions → template → timing) and campaigns, and reads every
message's delivery in the history. There is no WhatsApp Web automation, no browser session, and
nobody ever pastes a token, an app secret or a webhook URL.

This page replaced the earlier WhatsApp feature (2026-10-10 to 2026-10-24) on 2026-10-25: see
[The old WhatsApp tables](#the-old-whatsapp-tables) for what happened to it.

## What was verified before building it (2026-10-25)

| Question | Answer, and where it came from |
| --- | --- |
| Does Nango have a WhatsApp integration? | Yes, `whatsapp-business`, but its auth mode is **API_KEY** (Nango's `providers.yaml`; its setup guide says "Add your access token as the API key"). Its Connect UI would ask the merchant to paste a token. It has no Embedded Signup, and no pre-built syncs or actions. |
| Can Nango store a token bizinsights got some other way? | Yes: `POST /connections` imports a connection with `credentials: { type: "API_KEY", apiKey }` and up to 10 tags, and updates one with the same id instead of making a second ([Nango API reference](https://nango.dev/docs/reference/api/connection/post)). |
| How does a business connect its WhatsApp to a platform? | Meta's **Embedded Signup** (current version v4; v2 and v3 were retired on 2026-10-15): the JavaScript SDK's `FB.login` with a Facebook Login for Business configuration (`config_id`, `response_type: "code"`, `override_default_response_type: true`, `extras.setup`). It returns a code that lives **30 seconds**, and a `WA_EMBEDDED_SIGNUP` window message (from `facebook.com`) with `waba_id`, `phone_number_id`, `business_id` and how it finished (`FINISH`, `FINISH_ONLY_WABA`, `FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING`, `CANCEL` with `current_step`). |
| What must a Tech Provider do after it? | Server side: exchange the code (`GET /oauth/access_token` with the app id and secret) for the **business token**; subscribe the app to the account's webhooks (`POST /{waba}/subscribed_apps`); register the number (`POST /{phone}/register` with a 6-digit PIN, which becomes its two-step verification PIN). The business adds a payment method in WhatsApp Manager. ([Meta: onboarding customers as a Tech Provider](https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/onboarding-customers-as-a-tech-provider)) |

So the design is: **Meta's Embedded Signup runs on bizinsights' page; bizinsights' server exchanges
the code and checks the token; Nango keeps the token** (one Nango connection per store, imported as
an API key into bizinsights' `whatsapp-business` integration); bizinsights calls the Cloud API
with its own client, asking Nango for the token right before each call. Nango manages the connection
(storage, encryption at rest, deletion, its dashboard); it does not run the sign-up or send messages.

## Where things live

| Part | Code |
| --- | --- |
| Pure rules: templates and their checks, variables, consent, statuses, Meta's error codes, workflow triggers and conditions, campaign audiences, Embedded Signup's window messages | `packages/shared/src/whatsapp.ts` (`@app/shared/whatsapp`); phone numbers and sending hours, shared with SMS, in `packages/shared/src/messaging.ts` |
| Dependencies, errors, encryption, bizinsights' Meta app settings, queue jobs | `packages/core/src/whatsapp/common.ts` |
| Meta Graph API client (code exchange, token inspector, account, numbers, webhooks, registration, templates, sending) | `whatsapp/graph.ts`, over the transport the ads share (`core/metaGraph.ts`) |
| The token at Nango | `whatsapp/nango.ts`; what happens when access ends: `whatsapp/tokens.ts` |
| Connecting, the number, the PIN, the health check, disconnecting | `whatsapp/connect.ts` |
| Contacts and consent | `whatsapp/contacts.ts` |
| Templates | `whatsapp/templates.ts` |
| The queue and the sender | `whatsapp/messages.ts`; one message from the dashboard and team alerts: `whatsapp/manual.ts` |
| Meta's webhooks | `whatsapp/webhook.ts` (payload schemas: `whatsapp/metaPayloads.ts`) |
| Workflows, custom events, the event key | `whatsapp/workflows.ts`; Shopify's events → workflows: `whatsapp/events.ts` |
| Campaigns | `whatsapp/campaigns.ts` |
| The 15-minute sweep and retention | `whatsapp/sweep.ts` |
| Privacy (export, customers/redact, key rotation); erasing a store | `whatsapp/privacy.ts`, `whatsapp/purge.ts`; the old tables: `whatsapp/legacy.ts` |
| Merchant API | `apps/api/src/routes/whatsapp.ts` (overview, connecting, settings, templates, messages, contacts, test events), `whatsappAutomation.ts` (workflows, campaigns), `whatsappCommon.ts` |
| Public endpoints (Meta's webhook, custom events) | `apps/api/src/routes/whatsappWebhook.ts` |
| Background jobs | `apps/worker/src/handlers/integrations.ts` (`runWhatsappJob`), `apps/worker/src/index.ts` (the `*/15` cron runs `sweepWhatsapp`), `handlers/webhooks.ts` (Shopify topics, GDPR) |
| Dashboard | `apps/web/src/app/(app)/whatsapp/page.tsx` (one page, tabs in `?tab=`), `apps/web/src/components/whatsapp/*` |
| Tests | `packages/shared/test/whatsapp.test.ts`, `packages/core/test/whatsappAppSecret.test.ts`, `apps/api/test/whatsapp.test.ts`, `apps/worker/test/whatsapp.test.ts`, `apps/web/e2e/whatsapp.spec.ts` |

## The page

**WhatsApp Automation** (`/whatsapp`, the sidebar's "WhatsApp"), one page with tabs:

- **Overview.** Not connected: three plain steps and the **Connect WhatsApp** button (or, when the
  server isn't set up yet, a note saying connecting isn't switched on; owners and admins see which
  settings are missing). Connected: the account (verified name, number, account, status, quality,
  daily limit), what needs attention (reconnect, an account problem, a step to finish, replies not
  arriving, low quality, failures of the last 7 days, the consent choice not made), a setup
  checklist with a link to each fix, sent / delivered / read / failed / waiting / received for 7 and
  30 days, and the latest messages.
- **Templates.** What the account holds, with Meta's status and reasons; Refresh; delete; send a test
  to yourself; a writer that starts from a starter (order confirmation, shipping update, abandoned
  checkout, follow-up, welcome, appointment reminder, promotion, stock alert to your team) or blank,
  checks what Meta would refuse as you type, previews it, and submits it for review.
- **Workflows.** Ready-made ones and a four-step builder (trigger, conditions, message, timing),
  each step explained, then a review that lists anything stopping it from being switched on.
  Switch on, pause, test, delete; each workflow's runs (what happened each time, and to its message).
- **Campaigns.** Audience (country, new or returning customers, ordered within / not for N days,
  minimum orders or spend) with a live count of opted-in customers; an approved Marketing template;
  preview; test to yourself; schedule now or later after confirming the exact count; cancel; a
  delivery report.
- **Activity.** Every message, sent and received, with filters, its delivery reports, Retry for a
  failed one, and **Send a message** (an approved template, or a free-form reply within the
  customer's 24-hour window).
- **Contacts** (with "View contact information"). Customers' consent and its history; record consent
  or an opt-out given another way (with a note).
- **Settings.** The connection, Check again, Disconnect, the number's PIN (owners and admins), how
  customers agree to updates, whether Shopify's text-message consent covers WhatsApp, sending
  hours, a daily limit, your own test number, and the custom-event key.

Who sees what: reading needs **View campaigns** (`marketing.campaigns`); connecting and
disconnecting **Manage integrations**; templates, workflows, campaigns, settings and sends the
store's **owners and admins**; customers' numbers, names and what was said **View contact
information** as well. A shared-link session and API keys only read.

## Connecting ("Connect WhatsApp")

```
Browser                                  bizinsights API                          Meta / Nango
  Connect WhatsApp
  POST …/whatsapp/connect/start   ──►    nonce (20 min, bound to person + store),
                                  ◄──    appId, configId, version
  load connect.facebook.net SDK, FB.login({config_id, response_type: code, ...})
  Meta's window: sign in, business portfolio, WhatsApp Business account, number (new or existing)
  window message WA_EMBEDDED_SIGNUP (origin facebook.com only): FINISH + waba_id, phone_number_id
  authResponse.code (30 s)
  POST …/whatsapp/connect/finish  ──►    take the nonce (same person, same store)
                                         exchange the code                         ──► GET /oauth/access_token
                                         inspect the token (bizinsights' app token) ──► GET /debug_token
                                           app_id = ours, both WhatsApp permissions,
                                           the account among those granted
                                         the account and its numbers                ──► GET /{waba}, /{waba}/phone_numbers
                                           the number in the account, not another store's
                                         token to Nango (connection wa-<storeId>)   ──► POST api.nango.dev/connections
                                         webhooks to bizinsights' app               ──► POST /{waba}/subscribed_apps
                                         register a new number with a random PIN    ──► POST /{phone}/register
                                         templates                                  ──► GET /{waba}/message_templates
                                  ◄──    the connection (never the token)
```

A window that closes is never a connection: only the server's answer is. Every refusal says what to
do in plain words: the sign-in wasn't started here or took too long; the code expired; the token
isn't for bizinsights' app; a permission was unticked; the account wasn't granted; the number isn't
in it, or is already another store's. Nothing goes to Nango until every check passed.

What can still be needed afterwards (`step`, shown on the Overview with its fix):

| Step | When | Fix |
| --- | --- | --- |
| `choose_number` | The account has several numbers and Meta didn't say which | Pick one (`POST …/connect/number`) |
| `no_number` | Meta finished without a number (`FINISH_ONLY_WABA`) | Add one in WhatsApp Manager, then Check again |
| `pin_required` | The number already has its own two-step PIN (Meta 133005) | Enter that PIN (`POST …/connect/pin`) |
| `business_app_number` | A WhatsApp Business app number (coexistence) not on the Cloud API yet | bizinsights never registers it (that would take it off the app); Check again once Meta has moved it |
| `register_failed` | Meta refused or didn't answer the registration | Check again (it tries again) |

The PIN bizinsights sets is kept encrypted; owners and admins can see it (audited) to move the number
to another provider.

**Health check.** Every 15-minute tick checks up to 20 connections last checked over 6 hours ago:
the token works, bizinsights is still subscribed to the account (subscribed again if not), the
number's registration, quality, name and limit, and the templates. Meta refusing the token puts the
connection on **Reconnect** (an alert to owners and admins); a rate limit or an outage waits for the
next check.

**Reconnect** is the same button: the row is updated in place (the same Nango connection, a new
token), and messages held while it was needed are sent if that happens within 48 hours.

**Disconnect** unsubscribes bizinsights from the account's webhooks, deletes the Nango connection
(the token with it), cancels what was waiting and every running campaign, and keeps the history. The
number keeps working in WhatsApp. To remove bizinsights from the business entirely, the merchant
removes the app in Meta Business Suite → Settings → Integrations (Meta then sends `PARTNER_REMOVED`,
which puts a connection still here on Reconnect).

## Consent

Meta requires that customers agree before a business messages them, and the category Meta gave a
template (not the one asked for) decides which rule applies (`consentProblem` in
`@app/shared/whatsapp`):

- **STOP** (or "unsubscribe", "opt out"...) stops everything; only the customer's **START** undoes
  it, never the store or Shopify. "cancel" isn't a stop word: about an order it usually means the order.
- **Marketing** templates (campaigns, checkout reminders, welcome and follow-up messages) go only to
  customers who opted in to marketing: START, WhatsApp's own marketing setting, a "yes" the store
  recorded (with a note, audited), a custom event saying so, or Shopify's text-message marketing
  consent when the store says its wording covers WhatsApp (Settings). "Stop promotions" and Meta's
  marketing opt-out (error 131050 or the `user_preferences` webhook) stop marketing only.
- **Order and service updates** (Utility templates) go to customers who opted in, or to everyone
  with a number when the store attests its checkout or terms tell customers about WhatsApp updates
  (`checkout_notice`, audited with who chose it). Until the store chooses, none are sent.
- **Free-form replies** (text, image, document, video) only within 24 hours of the customer's last
  message (Meta's customer service window).

Every change is a row in `wa_consent_events` (scope, status, source, who, note, when). A change older
than the last one recorded (Meta and Shopify redeliver late) changes nothing; an opt-out cancels what
was waiting for that customer.

## Sending

1. Something queues a message (a workflow, a campaign, a person, a test, a stock alert): a row in
   `wa_messages` with an idempotency key unique per store (`wf:<workflow>:<order>`,
   `campaign:<id>:<contact>`, `manual:<request id>`...), so Shopify's retries, duplicate queue
   deliveries and double clicks make one message.
2. Due within 12 hours: on the existing `insights-sync` queue (`kind: "whatsapp"`); later ones and
   lost queue messages: the sweep.
3. Right before sending, everything is checked again: the connection, the store still installed,
   consent by the template's current category, the 24-hour window, the template still approved, the
   workflow still on, the campaign not cancelled, sending hours, the store's daily limit (Meta's tier
   or the store's own cap, counted as distinct customers messaged with templates in 24 hours), and
   the number's pace (20 a second).
4. The row is claimed (`queued → sending`) before Meta is called. The send carries
   `biz_opaque_callback_data` = the message's id, so its status webhooks find it even before its
   Meta id is stored. Meta's answer:
   - accepted → `accepted` with Meta's id (only now is it "sent" anywhere in the dashboard);
   - rate limits and Meta busy → tried again after 30 s, 2 min, 10 min, 30 min, 2 h (with jitter), then failed;
   - the token refused → the connection on Reconnect, the message held (cancelled after 48 hours);
   - an account problem (no payment method, restricted, not registered) → failed with the reason, and an alert;
   - the customer stopped marketing → recorded, failed;
   - anything else → failed with Meta's reason in plain words (`metaErrorExplanation`);
   - **no answer at all** → failed as "uncertain" and never repeated on its own (Meta may have it);
     the merchant can Retry it.
5. Meta's status webhooks move it on: `sent`, `delivered`, `read`, `failed`. Statuses only move
   forward (`statusAfterEvent`): a late "sent" after "delivered" changes nothing; "failed" after
   "delivered" changes nothing; "delivered" after "failed" wins.

Media: free-form replies take an image, document or video by its https link (Meta fetches it); a
template with a media header created in WhatsApp Manager takes the link at send time. Templates
written here have a text header or none (Meta's media-header examples need its upload API).

## Workflows

Trigger → conditions (all must hold) → an approved template with each variable mapped → timing.

| Trigger | Started by | Can use |
| --- | --- | --- |
| New order | `orders/create` | name, store, order number, total, status page, products |
| Order paid | `orders/paid` | the same |
| Order shipped | `orders/fulfilled`, `orders/partially_fulfilled` (once per order) | the same + tracking number, link, courier |
| Order cancelled | `orders/cancelled` (it also cancels what other workflows still wait to send about that order) | the same |
| Checkout abandoned | `checkouts/create`, `checkouts/update` with a phone number; timed from the customer's latest change; the order (its `checkout_token`) or `completed_at` cancels it | name, store, products, total, the checkout link |
| New customer | `customers/create` (the store is subscribed per store when such a workflow is switched on; needs `read_customers`) | name, store |
| Custom event | the store's own tools, with its event key; or "Send a test event" | name, store, event date and time, any value sent |

Conditions: order total at least / at most, customer's country in / not in, a product's name
contains, new or returning customer, order tag has / lacks, payment method contains. Timing: at once
or N minutes after the trigger, or (custom events with a time) N minutes before it; marketing
workflows default to sending hours 09:00-20:00 store time. Checkout reminders and welcome messages
must use a Marketing template; a workflow using a Utility template can't be switched on until the
store chose how customers agree.

A workflow runs **at most once per order, checkout, customer or event** (`wa_workflow_runs` unique on
workflow and subject). A run that doesn't send says why (conditions, no number, consent, template,
a missing value, stale). Events older than 48 hours start nothing. Workflows never trigger each other.

**Custom events** (appointment and service reminders, sign-ups from another tool): Settings → Event
key makes a `whev_...` key (shown once; only its SHA-256 is kept; a new one replaces it). Then:

```bash
curl -X POST https://bizinsights.io/api/whatsapp/events -H "Authorization: Bearer whev_..." -H "Content-Type: application/json" -d '{"event":"appointment_booked","eventId":"bk_1042","phone":"+61412345678","firstName":"Priya","at":"2026-11-03T10:30:00+11:00","values":{"service":"Haircut"}}'
```

The answer says how many workflows it started. The same `eventId` again starts nothing.
`marketingConsent: true` records the customer's marketing consent ("recorded by your team").

## Campaigns

An approved **Marketing** template to the customers who agreed to WhatsApp marketing and never
replied STOP, filtered by the audience. Scheduling needs a working, registered number subscribed to
its webhooks (so STOP replies arrive), every variable filled (a campaign knows the customer's first
name, the store's name and fixed text), and the merchant confirming the exact count the estimate
showed. At its time it starts: its messages are made in batches of 500 (idempotent per campaign and
customer), spread at 10 a second, each checked again right before it goes. Cancel stops what hasn't
gone to Meta. A campaign reaches at most 100,000 customers. The report counts each status and the
commonest failure reasons.

## Meta's webhooks

`GET /api/webhooks/whatsapp` answers Meta's handshake only with `WHATSAPP_WEBHOOK_VERIFY_TOKEN`.
`POST /api/webhooks/whatsapp`:

1. `X-Hub-Signature-256` (HMAC-SHA256 of the raw body with bizinsights' app secret) is checked
   before anything is read. Every number is connected through bizinsights' app, so its secret
   vouches for every delivery. Refusals are limited per IP.
2. The body is stored once in `wa_webhook_events`, keyed by its SHA-256 (Meta retries the same body),
   **encrypted** (it carries numbers and messages), and queued (`kind: "whatsapp_webhook"`). Meta
   gets its 200 at once.
3. The worker applies it: statuses (by our id, then Meta's; another store's message or one sent
   another way is left alone), customers' messages (stored once per Meta id; STOP / START /
   Stop promotions; the 24-hour window), `user_preferences`, template reviews, categories and
   quality, the number's quality, limit and name, and `account_update` (`PARTNER_REMOVED` →
   Reconnect; disabled or restricted → account problem). Each change applies only to the store whose
   number (or account) it names. The body is cleared once applied.
4. A delivery that fails is retried by the queue; one that keeps failing (6 tries) is set aside
   (`dead`), and the stores it names get an alert. The sweep queues again anything left waiting.

## Data and retention

Every `wa_*` table except `wa_webhook_events` carries `workspace_id` with the tenant RLS policy; the
merchant API reads through `withTenant` *and* filters by workspace and store; webhooks and jobs use
the owner role and are scoped by number, account, signature or row id.

| Table | Holds |
| --- | --- |
| `wa_connections` | The store's number (one per store): status and step, account and number ids and names, quality, limit, registration, the Nango connection id, the PIN (encrypted), when subscribed, checked, last heard from |
| `wa_settings` | How customers agree to updates (who chose, when), Shopify consent covers WhatsApp, sending hours, daily limit, the test number (encrypted), the event key's hash |
| `wa_templates` | The account's templates as Meta last reported them |
| `wa_contacts` | A customer's number (encrypted), first name (encrypted), masked number, keyed hash, country, consent, last message, Shopify's order count and spend |
| `wa_consent_events` | Every consent change, with its source |
| `wa_messages` | Every message, sent and received: the queue and the history. A campaign's recipients are its messages |
| `wa_message_events` | Meta's delivery reports, once per message and status |
| `wa_webhook_events` | Meta's deliveries until applied (body encrypted, then cleared) |
| `wa_workflows`, `wa_workflow_runs` | Workflows and each time one fired |
| `wa_campaigns` | Campaigns |

- Numbers: `HMAC(CUSTOMER_HASH_KEY, "wa:<storeId>:<digits>")` finds a contact without decrypting
  (the same hash the earlier feature used, so a recorded privacy request finds both); ciphertexts
  are AES-256-GCM under `TOKEN_ENCRYPTION_KEYS` with AAD `wa2:<storeId>:<kind>`.
- The dashboard shows masked numbers (`+61 •••••• 678`); message text only to people with "View
  contact information".
- Retention (`RETENTION` in `sweep.ts`, daily): messages and their reports 365 days after they ended;
  a failed message's details 7 days (for Retry); applied webhook bodies are cleared at once, the rows
  go after 7 days (set-aside ones 30); workflow runs 90 days; consent records as long as the contact.
- `customers/redact` deletes the customer's contact, consent records, messages and runs (and their
  records in the old tables); `shop/redact` deletes every WhatsApp record of the store and its token at
  Nango; `customers/data_request` exports the contact, consent history and messages, and how many
  records the old tables still hold. `/privacy` says all of this, and names Nango as a sub-processor.
- Key rotation (`ops:reencrypt`) re-encrypts every WhatsApp Automation ciphertext; the old tables are
  left as they are (nothing reads them).

## Security

- Tokens never reach the browser or a log; the business token lives at Nango, fetched per call and
  kept in memory for 4 minutes. Every business-token call carries `appsecret_proof`.
- Embedded Signup: a single-use nonce bound to the person and store; window messages read only from
  `facebook.com`; Meta's token inspector confirms the token is for bizinsights' app with both
  permissions and the account granted; one number per store (a unique index).
- Webhooks: signature first; stored once; per-IP limits on refusals.
- Custom events: a per-store key (only its hash kept), limited per key and per IP for unknown keys.
- Every change a merchant makes is audited (`whatsapp.connected`, `.disconnected`,
  `.settings_changed`, `.template_submitted`, `.workflow_*`, `.campaign_*`, `.consent_recorded`,
  `.message_sent`, `.pin_viewed`, `.event_key_*`...).
- Rate limits per store (connect, Check again, templates, tests, estimates, sends) and per user (PIN).
- Logs redact phone numbers, `wa_id`, PINs and Meta tokens (`core/logger.ts`).

## Scale

Built to grow without a redesign, not proven at a million users. The API and worker are stateless
Lambda functions; sends, webhook deliveries and campaign batches are SQS jobs with retries and a
dead-letter queue; everything is idempotent (unique keys, claims, monotonic statuses); lists are
cursor-paged; the hot paths are indexed (`status, send_after`; `store_id, created_at`; `campaign_id,
status`; the unique keys); per-store limits cap what one store can use. The limits that bind first:

- **Meta**: each number's messaging tier (250 → 1K → 10K → 100K → unlimited new customers a day,
  growing with quality) and about 80 messages a second per number; bizinsights paces each number at
  20 a second and campaigns at 10.
- **Nango**: the free plan holds 10 connections in all (ad accounts included); each WhatsApp store
  is one more. Past that it is Nango's paid plan (from US$50 a month), and token reads go through its
  API (cached 4 minutes per process).
- **The jobs Lambda's concurrency and RDS** (`db.t4g.micro` today): a 100,000-recipient campaign is
  100,000 sends plus their status webhooks over about three hours.

Before claiming production readiness for a million users: load-test the send and webhook paths
against Meta's test number, test failure recovery (Meta down, Nango down, RDS failover), and plan
capacity (RDS class, Lambda concurrency, Nango plan, SQS throughput).

## Setting it up (the owner; none of this can be done from code)

What the server needs, and where each goes (secrets with
`node infra/cdk/scripts/put-secrets.mjs --set NAME`, public ids in `apps/aws/src/settings.ts`):

| Setting | Where | Today |
| --- | --- | --- |
| `WHATSAPP_APP_ID` | settings.ts | `1799660384680551` ("pixmagic"); empty uses the Meta Ads app `971575545351940` |
| `WHATSAPP_CONFIG_ID` | settings.ts | **empty**: the Embedded Signup v4 configuration id (step 3 below) |
| `WHATSAPP_APP_SECRET` | secret | that app's secret (not needed when WhatsApp runs on the Meta Ads app, whose `META_APP_SECRET` is set) |
| `WHATSAPP_WEBHOOK_VERIFY_TOKEN` | secret | any long random string (`put-secrets.mjs --generate WHATSAPP_WEBHOOK_VERIFY_TOKEN`) |
| `NANGO_SECRET_KEY` | secret | **set** (the ad platforms use it) |
| `WHATSAPP_API_VERSION` | settings.ts | `v26.0` |

Until every one is set the page says connecting isn't switched on, the Deploy run's config check
names what is missing ("WhatsApp Embedded Signup off (needs ...)"), and nothing pretends to be connected.

In Meta (developers.facebook.com and business.facebook.com, in a browser; automating these consoles
has blocked the admin account before, so the owner clicks):

1. **Choose the app.** Either keep WhatsApp on "pixmagic" (1799660384680551, portfolio "Testbusiness",
   not verified) or, recommended, add the WhatsApp product to **"Insights" (971575545351940)**, whose
   portfolio **Zodiix Pty Ltd** has business verification submitted: then empty `WHATSAPP_APP_ID`
   (and `WHATSAPP_APP_SECRET`) in settings.ts so it uses that app and `META_APP_SECRET`.
2. **Business verification** of the portfolio (Security Center), and **Tech Provider** onboarding
   for the app (WhatsApp → Quickstart). Until then only people with a role on the app can connect.
3. **Embedded Signup configuration**: Facebook Login for Business → Configurations → Create
   configuration (not a template; the "60 Expiration Token" template disconnects every store after 60
   days): login variation **WhatsApp Embedded Signup**, version **v4**, token expiration **Never**,
   assets **WhatsApp accounts**, permissions `whatsapp_business_management` and
   `whatsapp_business_messaging`. Its id is `WHATSAPP_CONFIG_ID`.
4. **App Review**: Advanced Access for `whatsapp_business_management` and
   `whatsapp_business_messaging` (a screencast of a merchant connecting and sending a template).
5. **App settings → Basic**: app domain `bizinsights.io`; Facebook Login for Business → Settings:
   `https://bizinsights.io` in **Allowed domains for the JavaScript SDK** and **Valid OAuth Redirect
   URIs** (press the page's Save Changes, then reload to check).
6. **Webhook**: nothing to click. Once the app secret and verify token are set, the sweep points the
   app's WhatsApp webhook at `https://bizinsights.io/api/webhooks/whatsapp` with every field it reads
   (`ensureAppWebhook`, every 6 hours). If the app's webhook already points somewhere else it is left
   alone and logged: then set it by hand in WhatsApp → Configuration with the verify token.

Nango needs nothing more: the `whatsapp-business` integration (provider `whatsapp-business`) is
already in the prod environment (made in Nango's dashboard on 2026-10-24); bizinsights would make it
itself if it were missing. Watch the plan's connection count.

Shopify: the order and checkout topics are already in the apps' tomls; "New customer" workflows
subscribe `customers/create` per store (with `read_customers`). Live stores need **protected
customer data Level 2** (name, phone, address) approved, or Shopify redacts the phone number and the
runs say "No phone number on the order". Development stores are exempt, which is how to test.

## Deployment checklist

1. The migration `20261024200000_whatsapp_automation` is additive (11 new tables with RLS, no change to
   any existing table); Deploy to AWS applies it after the deploy. Rollback is safe: the release
   before reads only the old tables, which are untouched.
2. Merge to `main`; check the Deploy run succeeded and `/api/version` serves the merge commit.
3. Smoke: `GET https://bizinsights.io/api/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=1`
   answers 403; an unsigned `POST /api/webhooks/whatsapp` answers 401; `POST /api/whatsapp/events`
   without a key answers 401.
4. The owner's Meta steps above, then the secrets and `WHATSAPP_CONFIG_ID` (a settings.ts change goes
   out with the next deploy).
5. A first real connect on a development store with Meta's test number or a spare number; a template
   approved; a test message to the owner's own phone; one workflow on; one delivery report seen in
   Activity.

## Connecting WhatsApp and sending your first message (for merchants)

1. Open **WhatsApp** in the menu and press **Connect WhatsApp**. Allow pop-ups if the browser asks.
2. In Meta's window, sign in with the Facebook account that manages your business, choose (or create)
   your business portfolio and WhatsApp Business account, then add or pick the phone number customers
   will see, verify it with the code Meta sends, and keep both permissions ticked.
3. Back on bizinsights, wait a few seconds while it checks and sets up the number. If it asks for one
   more thing (choose a number, your existing 6-digit PIN), do that on the same page.
4. In WhatsApp Manager, add a **payment method** for the account (Meta charges for business-started
   conversations), if you haven't yet.
5. **Settings**: add your own WhatsApp number as the test number, and choose how customers agree to
   order updates.
6. **Templates**: pick "Order confirmation", check the wording, and submit it. Meta usually reviews it
   within minutes, sometimes up to a day.
7. Once it shows **Approved**, press **Send test**: the message arrives on your phone.
8. **Workflows**: choose "Order confirmation", check the steps, and switch it on. From the next order,
   customers who can receive it get it; **Activity** shows each message and whether it was delivered.

## The old WhatsApp tables

The earlier feature's tables (`whatsapp_connections`, `whatsapp_settings`, `whatsapp_templates`,
`whatsapp_contacts`, `whatsapp_messages`, `whatsapp_message_events`, `whatsapp_campaigns`,
`whatsapp_automation_rules`, `whatsapp_automation_runs`, `order_trackings`, `order_tracking_events`,
`abandoned_checkouts`, `customer_reviews`) are no longer read or written, except: shop/redact and
customers/redact still erase from them, the data request export counts what they hold about a
customer, and a store that had a connection there is told it was retired and must connect again
(its token, a pasted one under the merchant's own Meta app, is not carried over: the new design
only connects through bizinsights' app). Its pages (order tracking `/track`, reviews `/review`,
tracked links `/api/r/...`, the published reviews API) are gone; links already sent stop working.

They are kept so a rollback to the release before the rebuild still works. **Next step (a follow-up
pull request, after this release has been live and is the one a failed deploy rolls back to):** a
migration that drops them, removes their models from `schema.prisma`, and removes `whatsapp/legacy.ts`
and the two `purgeLegacyWhatsappOps` / `legacyRecordCount` uses. Before it, back up their row counts
(`SELECT count(*)` per table through the admin host) in case anyone needs to be told.

## Testing

```bash
pnpm --filter @app/shared test
```

```bash
TEST_PG_PORT=5487 TEST_PG_PASSWORD=app PGREQUIREAUTH=scram-sha-256 TEST_DB=wa_test pnpm --filter @app/api exec vitest run test/whatsapp.test.ts
```

```bash
TEST_PG_PORT=5487 TEST_PG_PASSWORD=app PGREQUIREAUTH=scram-sha-256 TEST_DB=wa_test pnpm --filter @app/worker exec vitest run test/whatsapp.test.ts
```

Use a throwaway Postgres for `TEST_PG_PORT`. Meta and Nango are faked; no message leaves the machine.
The API test connects through the whole Embedded Signup finish (code exchange, token inspector,
account, numbers, Nango import, webhooks, registration, templates), the PIN and choose-a-number
steps, refusals (state, code, app, permissions, account), tenant isolation (another workspace gets
404, a viewer only reads, one number per store), webhooks (signature, dedupe, statuses out of order,
STOP), sending (retry, reconnect hold, uncertain, Retry), templates, workflows (once per order,
conditions, consent choice, checkout reminder cancelled by its order), campaigns (exact count,
opted-in only), custom events (key, idempotency, before-the-event timing) and disconnect.

The page in a real browser, with Meta's SDK stubbed: `apps/web/e2e/whatsapp.spec.ts`.

For a real end-to-end check, use a development store, Meta's test phone number (WhatsApp → API
Setup) and your own phone as the only recipient. Don't send promotional messages to real customers
while testing.
