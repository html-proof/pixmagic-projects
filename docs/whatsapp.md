# WhatsApp Automation

bizinsights sends a store's customers WhatsApp messages from the store's own WhatsApp Business
number, through Meta's official **WhatsApp Business Platform (Cloud API)**. The merchant connects
the number with Meta's own sign-up window ("Connect WhatsApp Business"), writes or picks message
templates, builds workflows (trigger → conditions → template or reply → timing), answers customers
who write in, runs campaigns, and reads every message's delivery in the history. There is no
WhatsApp Web automation, no browser session, and nobody ever pastes a token, an app secret or a
webhook URL.

**Today (2026-10-25) every setting is in place**: WhatsApp runs on the Meta app "Insights"
(971575545351940, business portfolio "bizinsights.io"), whose secret and the webhook verify token
are set, and `WHATSAPP_CONFIG_ID` is its Embedded Signup configuration "bizinsights WhatsApp Signup"
(`2228218088074576`). Until the app is a Tech Provider (its terms accepted, business verification,
App Review), Meta's window stops at "bizinsights.io can't onboard customers right now" for everyone,
the app's admin included ([Setting it up](#setting-it-up-the-owner-none-of-this-can-be-done-from-code), step 7).

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
| Workflows, which triggers a store can use, replies to customers' messages, custom events, the event key | `whatsapp/workflows.ts`; Shopify's events → workflows: `whatsapp/events.ts` |
| "Pause all automation", the Meta app webhook's last check | `whatsapp/automation.ts` |
| Campaigns | `whatsapp/campaigns.ts` |
| The 15-minute sweep and retention | `whatsapp/sweep.ts` |
| Privacy (export, customers/redact, key rotation); erasing a store | `whatsapp/privacy.ts`, `whatsapp/purge.ts`; the old tables: `whatsapp/legacy.ts` |
| Merchant API | `apps/api/src/routes/whatsapp.ts` (overview, connecting, settings, templates, messages, contacts, test events), `whatsappAutomation.ts` (workflows, campaigns), `whatsappCommon.ts` |
| Public endpoints (Meta's webhook, custom events) | `apps/api/src/routes/whatsappWebhook.ts` |
| Background jobs | `apps/worker/src/handlers/integrations.ts` (`runWhatsappJob`), `apps/worker/src/index.ts` (the `*/15` cron runs `sweepWhatsapp`), `handlers/webhooks.ts` (Shopify topics, GDPR) |
| Dashboard | `apps/web/src/app/(app)/whatsapp/page.tsx` (one page, tabs in `?tab=`), `apps/web/src/components/whatsapp/*` (status tiles, health, pause: `Status.tsx`; "Send test message": `SendTest.tsx`) |
| Tests | `packages/shared/test/whatsapp.test.ts`, `packages/core/test/whatsappAppSecret.test.ts`, `apps/api/test/whatsapp.test.ts`, `apps/worker/test/whatsapp.test.ts`, `apps/web/e2e/whatsapp.spec.ts` |

## The page

**WhatsApp Automation** (`/whatsapp`, the sidebar's "WhatsApp"), one page with tabs:

- **Overview.** Four status tiles, the same whether connected or not and always read from what the
  API stored: the connection, automation (Active, Paused, Needs attention, No workflow on,
  Disconnected; `automationState` in `@app/shared/whatsapp`), the last update from WhatsApp, and
  what is waiting to send (and why any of it is held).
  - Not connected: the **Connect WhatsApp Business** button, how connecting works in three lines,
    and what Meta will ask the business for (with Meta's own pages). While the server isn't set up
    the button is disabled and the page says exactly that: bizinsights' own Meta app isn't set up
    yet, nothing is connected, nothing is sent, and there is nothing to change in the merchant's
    accounts. People who may connect also see each missing setting and what it is.
  - Connected: the account (verified name, number, the business portfolio, WhatsApp Business account
    and phone number ids, quality, daily limit), **Manage automation** and **Send test message**,
    what needs attention (reconnect, an account problem with a link to WhatsApp Manager, a step to
    finish, replies not arriving, a switched-on workflow that can't send, automation paused, low
    quality, failures of the last 7 days, the consent choice not made), the automation card with
    **Pause all automation** / **Resume**, the connection's health check by check (access, both
    permissions, account standing, number registered, webhooks and the last update, the last check,
    with **Check again**), what is waiting and the last week's failures with Meta's reason, a setup
    checklist, sent / delivered / read / failed / waiting / received for 7 and 30 days, and the
    latest messages. People who may connect see whether bizinsights' Meta app webhook points here,
    as Meta last answered.
  - **Send test message**: an approved template, with sample values, to the merchant's own test
    number only, after they press Send; the dialog then follows that message's real status every 3
    seconds for two minutes (queued → accepted → sent → delivered → read, or failed with Meta's
    reason). "Accepted" is never shown as delivered.
- **Templates.** What the account holds, with Meta's status and reasons; Refresh; delete; send a test
  to yourself; a writer that starts from a starter (order confirmation, shipping update, abandoned
  checkout, follow-up, welcome, appointment reminder, promotion, stock alert to your team) or blank,
  checks what Meta would refuse as you type, previews it, and submits it for review.
- **Workflows.** Ready-made ones (order confirmation, shipping update, abandoned checkout, follow-up,
  welcome, appointment reminder, support auto-reply, away message) and a four-step builder
  (trigger, conditions, message, timing), each step explained, then a review that lists anything
  stopping it from being switched on. A trigger the store can't use is shown with why and can't be
  picked (see [Which triggers a store can use](#which-triggers-a-store-can-use)). Switch on, pause,
  test, delete; each workflow's runs (what happened each time, and to its message).
- **Campaigns.** Audience (country, new or returning customers, ordered within / not for N days,
  minimum orders or spend) with a live count of opted-in customers; an approved Marketing template;
  preview; test to yourself; schedule now or later after confirming the exact count; cancel; a
  delivery report.
- **Activity** ("Message history"). Every message, sent and received, filtered by status, direction,
  source, workflow, reason or error, template, store-time days, and (for people who may see contact
  information) a customer's number, matched by its keyed hash. Each message shows its delivery
  reports, bizinsights' and Meta's message ids, when it was created, accepted, delivered, read or
  failed, its tries and its workflow; Retry for a failed one; and **Send a message** (an approved
  template, or a free-form reply within the customer's 24-hour window).
- **Contacts** (with "View contact information"). Customers' consent and its history; record consent
  or an opt-out given another way (with a note).
- **Settings.** The connection and its ids, **Reconnect WhatsApp** (refreshes bizinsights' access
  through Meta's window; the same connection is updated), Disconnect, the number's PIN (owners and
  admins), the connection's health with Check again (which also retries a failed setup step:
  webhooks, registration), Pause all automation / Resume, links to templates and to customers'
  consent and opt-outs, how customers agree to updates, whether Shopify's text-message consent
  covers WhatsApp, sending hours, a daily limit, your own test number, and the custom-event key.

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

While Meta's window is open the button reads "Waiting for Meta…", with **Stop waiting** under it
(bizinsights can't close Meta's window, but nothing stays stuck on this page; a code that still
arrives because the person finished in Meta's window after all is sent on as usual). After 15
seconds the page also says what can hold it up: Meta's window behind this one, or Meta's own page
"… can't onboard customers right now" ([why Meta shows it](#setting-it-up-the-owner-none-of-this-can-be-done-from-code), step 7). That is a hint, never a time
limit: a real signup (a new business, a phone code) takes minutes. An error Meta posts to the page
is shown at once instead of when its window is closed.

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

**Tokens that expire.** bizinsights' Embedded Signup configuration issues system user tokens that
last 60 days (Meta offered this app only its template, whose expiry can't be changed). So each
health check first asks Meta's token inspector when the store's token expires, and with under 30
days left exchanges it for a fresh 60-day one (`GET /oauth/access_token`, `grant_type=fb_exchange_token`,
`set_token_expires_in_60_days=true`; Meta: "Install Apps, Generate, Refresh, and Revoke Tokens") and
hands that to Nango under the same connection (`refreshIfExpiring` in `connect.ts`). A refresh that
fails keeps the old token, which still works, and the next check tries again: with checks every 6
hours there are about 120 tries before a token runs out. A token that never expires is left alone.

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
     a refusal that holds for the whole number (Meta's throttles 4, 80007, 130429, 131048; Meta
     busy 1, 2, 131000, 133004; a 429 or 5xx without a code) also trips the number's **circuit
     breaker**: its other waiting messages wait it out (30 s, doubling to 10 minutes while Meta keeps
     refusing, no attempt spent, reason "meta_throttled") instead of each being refused in turn; the
     next message Meta takes closes it;
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

Trigger → conditions (all must hold) → an approved template with each variable mapped (or, for a
customer's message, the merchant's own reply) → timing.

| Trigger | Started by | Can use |
| --- | --- | --- |
| New order | `orders/create` | name, store, order number, total, status page, products |
| Order paid | `orders/paid` | the same |
| Order shipped | `orders/fulfilled`, `orders/partially_fulfilled` (once per order) | the same + tracking number, link, courier |
| Order cancelled | `orders/cancelled` (it also cancels what other workflows still wait to send about that order) | the same |
| Checkout abandoned | `checkouts/create`, `checkouts/update` with a phone number; timed from the customer's latest change; the order (its `checkout_token`) or `completed_at` cancels it | name, store, products, total, the checkout link |
| New customer | `customers/create` (the store is subscribed per store when such a workflow is switched on; needs `read_customers`) | name, store |
| Custom event | the store's own tools, with its event key; or "Send a test event" | name, store, event date and time, any value sent |
| Customer sends a message | a customer's message in Meta's webhook (never STOP, START or "stop promotions", reactions or system notices) | sends the merchant's own text (up to 1,000 characters), no template |

Conditions: order total at least / at most, customer's country in / not in, a product's name
contains, new or returning customer, order tag has / lacks, payment method contains; for a
customer's message, its words contain any of a list (any case), and it arrives outside / within
store-time hours (an away message). Timing: at once or N minutes after the trigger, or (custom
events with a time) N minutes before it; a reply within 12 hours; marketing workflows default to
sending hours 09:00-20:00 store time. Checkout reminders and welcome messages must use a Marketing
template; a workflow using a Utility template can't be switched on until the store chose how
customers agree.

A workflow runs **at most once per order, checkout, customer, event or message** (`wa_workflow_runs`
unique on workflow and subject). A run that doesn't send says why (conditions, no number, consent,
template, a missing value, stale, automation paused, replied recently). Events older than 48 hours
start nothing. Workflows never trigger each other.

### Replies to customers' messages (support auto-replies)

A "Customer sends a message" workflow answers a customer who writes to the store's number with the
merchant's own text. WhatsApp allows that without a template because the customer has just written
(its 24-hour window is open; the sender checks the window again right before it goes, and Meta
would refuse otherwise). It is a service message, so no marketing or order-update consent is
needed, but a customer who replied STOP gets nothing.

- **Once per message**: the run is keyed `message:<Meta's id>`, so Meta redelivering the webhook (or
  a retry after a failure part-way) answers nothing twice.
- **Once per customer in its cool-down** (default 24 hours, 0 = every message): a lease per workflow
  and customer stops two messages answered at the same moment, and the run history stops it across
  leases; the run says "replied recently".
- A message more than an hour old when it is applied (Meta held the webhook back) gets no reply.
- Switching one on needs WhatsApp's webhooks to reach bizinsights (the connection subscribed).
- Ready-made: **Support auto-reply** (any message, once a day) and **Away message** (outside 9am to
  5pm store time, at most every 12 hours). The workflow's Test sends its text to the merchant's own
  number, which WhatsApp delivers only if that number wrote to the business in the last 24 hours.

### Which triggers a store can use

`triggerAvailability` in `workflows.ts` (the builder shows it; Activate refuses anything else):

- Shopify's order and checkout triggers only where the store's Shopify app receives those topics
  (`APP_WEBHOOK_TOPICS`): a store connected through the App Store app gets none until Shopify
  approves protected customer data, and the builder says so instead of offering them.
- **New customer** needs `read_customers` (and subscribes the store to `customers/create` when it is
  switched on).
- **Customer sends a message** needs the connection subscribed to Meta's webhooks.
- Custom events always work. A store without Shopify can't open WhatsApp Automation at all: the
  page asks to connect a store first.

A switched-on workflow that something later stops (a template Meta rejects, the consent choice
undone, a trigger no longer received) is listed on the Overview, and automation shows **Needs
attention** rather than Active (`blockedActiveWorkflows`).

## Pausing all automation

Settings or the Overview → **Pause all automation** (owners and admins, confirmed, audited
`whatsapp.automation_paused` / `.automation_resumed`; `wa_settings.automation_paused_at`):

- workflows start nothing: each trigger is still recorded as a run that sent nothing
  ("automation_paused"), so the merchant sees what was missed;
- messages workflows and campaigns were already waiting to send are held (no attempt spent);
- due campaigns don't start, sending ones make no more batches; scheduling one keeps it scheduled;
- tests, messages a person sends from the dashboard and team alerts still go (explicit actions);
- **Resume** releases what was held at once, carries on sending campaigns and starts due ones;
- held for more than 48 hours, a message is cancelled ("automation paused") rather than sent late.

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
   Stop promotions; the 24-hour window; then the store's "Customer sends a message" workflows, once
   per message even when Meta redelivers), `user_preferences`, template reviews, categories and
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
| `wa_settings` | How customers agree to updates (who chose, when), Shopify consent covers WhatsApp, sending hours, daily limit, the test number (encrypted), the event key's hash, since when automation is paused (and by whom) |
| `wa_templates` | The account's templates as Meta last reported them |
| `wa_contacts` | A customer's number (encrypted), first name (encrypted), masked number, keyed hash, country, consent, last message, Shopify's order count and spend |
| `wa_consent_events` | Every consent change, with its source |
| `wa_messages` | Every message, sent and received: the queue and the history. A campaign's recipients are its messages |
| `wa_message_events` | Meta's delivery reports, once per message and status |
| `wa_webhook_events` | Meta's deliveries until applied (body encrypted, then cleared) |
| `wa_workflows`, `wa_workflow_runs` | Workflows (a reply workflow keeps its text and cool-down; its template columns are empty) and each time one fired |
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
dead-letter queue (alarms on its depth and on each queue's oldest job, and the CloudWatch dashboard's
queue-depth graph, in `infra/cdk/lib/app-stack.ts`); everything is idempotent (unique keys, claims,
monotonic statuses); lists are cursor-paged; the hot paths are indexed (`status, send_after`;
`store_id, created_at`; `campaign_id, status`; the unique keys); per-store limits cap what one store
can use (rate limits on every merchant action, the daily cap, Meta's tier), each number is paced at
20 sends a second, and a number Meta throttles waits behind its circuit breaker instead of being
hammered. Retries are classified (retry, reconnect, account, opt-out, fail, uncertain) and bounded
with exponential backoff and jitter. The limits that bind first:

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

What the server needs, and where each goes. Public ids live in `apps/aws/src/settings.ts` (they
reach the browser anyway: Meta's SDK needs them); secrets live only in AWS Secrets Manager
(`insights/<env>/app`), set with `node infra/cdk/scripts/put-secrets.mjs --env production --set NAME`
(`--set` reads the value from the clipboard, or a prompt that shows only `*`, prints no value, and
refuses a Meta secret Meta says isn't that app's). There is no `.env` in production. Development and staging use their
own Meta app (or none) and their own `insights/<env>/app` secret: never production's values.

| Setting | What it is | Where | How to get it | Today (production) |
| --- | --- | --- | --- | --- |
| `WHATSAPP_APP_ID` | The Meta app every store connects through (empty: `META_APP_ID`) | settings.ts | Meta app dashboard → App settings → Basic → App ID | **empty since 2026-10-25**: WhatsApp runs on the Meta Ads app **"Insights" `971575545351940`** (portfolio Zodiix Pty Ltd). It ran on "pixmagic" `1799660384680551` before; nothing was ever connected through it |
| `WHATSAPP_CONFIG_ID` | The Insights app's Facebook Login for Business configuration of the Embedded Signup variation: what Meta's window shows and grants | settings.ts | Step 4 below (Configurations → its ID) | `2228218088074576` ("bizinsights WhatsApp Signup", 2026-10-25) |
| `WHATSAPP_APP_SECRET` | The app's secret when WhatsApp runs on an app of its own: exchanges the sign-up code, signs `appsecret_proof`, and is what Meta signs every webhook with (`X-Hub-Signature-256`) | secret | — | **not needed**: on the Insights app, `META_APP_SECRET` (set) does all three. Leave it unset: when set it wins over `META_APP_SECRET` |
| `WHATSAPP_WEBHOOK_VERIFY_TOKEN` | A random string Meta repeats back (`hub.verify_token`) when it checks the webhook address; `GET /api/webhooks/whatsapp` answers the challenge only for it (constant-time compare) | secret | Generated, never chosen: `put-secrets.mjs --env production --generate WHATSAPP_WEBHOOK_VERIFY_TOKEN` | set (release 116's config check no longer lists it) |
| `NANGO_SECRET_KEY` | Nango's key: Nango keeps each store's WhatsApp token | secret | Nango dashboard (prod environment) → Environment settings | set (the ad platforms use it) |
| `WHATSAPP_API_VERSION` | The Graph API version every call uses | settings.ts | Meta's changelog | `v26.0` |

Until every one is set the page says connecting isn't available yet (and, to people who may
connect, which settings are missing and what each is), `POST …/connect/start` answers 503
`not_configured`, the Deploy run's config check names what is missing ("WhatsApp Embedded Signup off
(needs ...)") as a warning on the run, and nothing pretends to be connected. A secret changed in
Secrets Manager reaches the functions on their next start: run **Deploy to AWS** (Actions → Run
workflow, on main) after setting one.

In Meta (developers.facebook.com and business.facebook.com, in a browser; automating these consoles
has blocked the admin account before, so the owner clicks). Checked against Meta's docs on
2026-10-25 ([Embedded Signup implementation](https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/implementation/),
[Embedded Signup v4](https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/version-4),
[Facebook Login for Business](https://developers.facebook.com/documentation/facebook-login/facebook-login-for-business),
[Become a Tech Provider](https://developers.facebook.com/documentation/business-messaging/whatsapp/solution-providers/get-started-for-tech-providers));
Meta renames buttons now and then, so a label may differ slightly.

1. **Open the app.** Sign in to [developers.facebook.com/apps](https://developers.facebook.com/apps/)
   with the Facebook account that administers **"Insights" (App ID 971575545351940)**
   (sebanceo@gmail.com) and open it.
2. **Add WhatsApp to it.** Left menu **Use cases** → **Add use case** (on older dashboards: **Add
   product** → WhatsApp → **Set up**) → **Connect with customers through WhatsApp** → add it. Done
   2026-10-25. Its setup asks for a business portfolio (the app's is **bizinsights.io**) and, to
   claim a free test number, accepts Meta's WhatsApp Business Platform and Cloud API terms; on
   2026-10-25 "Claim test number" answered "An error occurred while creating the test account" (not
   needed for Embedded Signup).
3. **Facebook Login for Business → Settings.** Under **Client OAuth settings** set to **Yes**: Client
   OAuth login, Web OAuth login, Enforce HTTPS, Embedded Browser OAuth Login, Use Strict Mode for
   redirect URIs, **Login with the JavaScript SDK**. Add `https://bizinsights.io/` to **Allowed
   Domains for the JavaScript SDK** and to **Valid OAuth Redirect URIs** (keep every entry already
   there: Meta Ads' sign-in through Nango uses them). Embedded Signup returns
   nothing to a page whose domain isn't in both. Press the page's own **Save changes** at the bottom
   (the toast after typing a URI doesn't save it), then reload to check it stayed. Done 2026-10-25
   (and checked after a reload).
4. **Create the configuration** (this is `WHATSAPP_CONFIG_ID`). Meta offers the WhatsApp Embedded
   Signup variation only to an app linked to a business portfolio (Review → Verification →
   Business portfolio). On 2026-10-25 the Insights app had none; it was linked to **bizinsights.io**
   (business 1415197520268134, the only portfolio its admin has; shown "Unverified" then). Even then,
   **+ Create configuration** offered only the "General" variation, so the configuration was made
   with **Templates → WhatsApp Embedded Signup Configuration With 60 Expiration Token → Use template**
   and then **Edit**ed:
   - Name: `bizinsights WhatsApp Signup` (Meta allows 30 characters).
   - Login variation: **WhatsApp Embedded Signup** (fixed by the template).
   - Products: **WhatsApp Cloud API** only (untick "Marketing Messages API for WhatsApp", which Meta
     ticks with it). Selecting products is what makes it a **v4** configuration (v2 and v3 stopped
     working on 2026-10-15).
   - Access token: **System-user access token**, expiring after **60 days**. The template fixes both
     ("can't be changed later"), so the health check refreshes each store's token
     ([Tokens that expire](#connecting-connect-whatsapp)). Once the app is a Tech Provider and Meta offers
     the variation under **+ Create configuration**, a configuration with expiration **Never** can
     replace it: a new id in `WHATSAPP_CONFIG_ID` serves new connections, and tokens already issued
     keep being refreshed.
   - Assets: **WhatsApp accounts** only (Meta's six WhatsApp account tasks, which the template sets).
   - Permissions: `whatsapp_business_management` and `whatsapp_business_messaging`, nothing else.
   - Its **Configuration ID** is in the Configurations list. It is not a secret: it goes in
     `WHATSAPP_CONFIG_ID` in `apps/aws/src/settings.ts`, in a pull request merged on green.
5. **Deploy and check.** Once a release with the configuration id is live, `/whatsapp` shows **Connect
   WhatsApp Business** instead of "not available yet", and within 15 minutes the sweep points the
   app's WhatsApp webhook at `https://bizinsights.io/api/webhooks/whatsapp` (`ensureAppWebhook`, then
   every 6 hours; Meta calls the URL with the verify token before it accepts, so "set" proves Meta
   can reach it). The Overview shows people who may connect how Meta last answered. If the app's
   webhook already points somewhere else it is left alone and logged: then set it by hand in
   **WhatsApp → Configuration** with the verify token. Nothing to do in AWS: `META_APP_SECRET` and
   `WHATSAPP_WEBHOOK_VERIFY_TOKEN` are already set.
6. **Connect your own business first**, once Meta lets the app onboard anyone (step 7): add a
   payment method in WhatsApp Manager, get a template approved and send yourself a test (the
   merchant guide below). Choose a business portfolio other than **bizinsights.io**: Meta doesn't
   onboard a WhatsApp Business account through Embedded Signup into the portfolio that owns the app.
   On 2026-10-25 the app's admin, signed in, got no further than Meta's page "bizinsights.io can't
   onboard customers right now … would you like to share your contact information" (its button kept
   spinning), straight after signing in: so a role on the app is not enough while step 7 is open.
7. **Open it to every business (Tech Provider).** Meta's "can't onboard customers right now" page
   is what everyone gets until this is done. Meta's docs say no business can be onboarded before App
   Review grants Advanced Access to the permissions, and developers who hit the same page report
   needing all three of: business verification, App Review, and accepting the Tech Provider terms in
   the dashboard (**Use cases** → **Connect with customers through WhatsApp** → **Customize** →
   **Tech Provider onboarding** / **Become a Tech Provider**; being verified is not the same as
   being registered). Then Meta allows 10 new businesses per rolling 7 days, 200 after Access
   Verification. The steps:
   - **Tech Provider terms**: open the wizard above and accept what it asks (the owner: it's an
     agreement with Meta). Not done as of 2026-10-25.
   - **Business verification** of Zodiix Pty Ltd (Business settings → Security Center): submitted
     2026-10-20, waiting for Meta. App Review can't start before it's approved. The app's portfolio
     must be the verified one: on 2026-10-25 the only portfolio the app's admin could pick was
     **bizinsights.io** ("Unverified"), and the app was linked to it. If Zodiix Pty Ltd's
     verification belongs to another portfolio, check in business.facebook.com that it is this one
     (renamed) before App Review.
   - **App Review**: Advanced Access for `whatsapp_business_messaging` and
     `whatsapp_business_management` (and `public_profile`, which a Facebook Login for Business app
     needs before it serves other businesses, if it isn't granted yet), with two screencasts: a
     message sent from bizinsights arriving in WhatsApp, and a message template created in
     bizinsights. Meta's changelog says Access Verification is no longer required for Tech Providers.
   Until all of it is done, Meta's window stops at "can't onboard customers right now" for
   everyone, the app's own admin included (seen 2026-10-25).

Meta's permissions this needs: `whatsapp_business_management` (read the account, its numbers and
templates; subscribe to its webhooks; submit templates) and `whatsapp_business_messaging` (send).
Both need Advanced Access (App Review) for businesses without a role on the app. Meta's webhook
fields bizinsights subscribes: `messages`, `message_template_status_update`,
`message_template_quality_update`, `template_category_update`, `phone_number_quality_update`,
`phone_number_name_update`, `account_update`, `user_preferences`.

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
   before reads only the old tables, which are untouched. `20261025120000_whatsapp_pause_and_replies`
   adds four nullable columns (`wa_settings.automation_paused_at/_by`, `wa_workflows.reply_text`,
   `reply_cooldown_minutes`); a reply workflow keeps empty template columns, so the release before
   still reads every row (it just never runs a trigger it doesn't know).
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

1. Open **WhatsApp** in the menu and press **Connect WhatsApp Business**. Allow pop-ups if the browser asks.
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
7. Once it shows **Approved**, press **Send test message** on the Overview: the dialog shows it
   accepted by WhatsApp, then delivered to your phone (or what went wrong).
8. **Workflows**: choose "Order confirmation", check the steps, and switch it on. From the next order,
   customers who can receive it get it; **Message history** shows each message and whether it was
   delivered. "Support auto-reply" or "Away message" answers customers who write to you.
9. Need a break (a sale gone wrong, a holiday)? **Pause all automation** on the Overview or in
   Settings; **Resume** when you're ready. Settings also has **Reconnect WhatsApp** (refresh access)
   and **Disconnect WhatsApp**.

If something doesn't work, the Overview says what and what to do: the connection's health, check
by check, with **Check again**; anything Meta asks for (a payment method, a display-name review, a
restricted account) with a link to WhatsApp Manager.

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
STOP), sending (retry, the circuit breaker, reconnect hold, uncertain, Retry), templates, workflows
(once per order, conditions, consent choice, checkout reminder cancelled by its order), which
triggers a store can use (an App Store store, no `read_customers`, no webhooks yet), replies to
customers' messages (once per message, the cool-down, conditions, never STOP, nothing to someone
who stopped), pausing (runs recorded, messages held and released, cancelled after 48 hours), the
history's filters, campaigns (exact count, opted-in only), custom events (key, idempotency,
before-the-event timing) and disconnect.

The page in a real browser, with Meta's SDK stubbed: `apps/web/e2e/whatsapp.spec.ts`.

For a real end-to-end check, use a development store, Meta's test phone number (WhatsApp → API
Setup) and your own phone as the only recipient. Don't send promotional messages to real customers
while testing.
