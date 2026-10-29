# WhatsApp Automation

bizinsights sends a store's customers WhatsApp messages about their orders, automatically
(automations started by Shopify's events), personally (a message from the dashboard) and in bulk
(campaigns to customers who agreed to marketing), and records every message's real delivery as
Meta reports it. The page is **WhatsApp Automation** at `/dashboard/whatsapp-automation` (the
sidebar's "WhatsApp"; the old `/whatsapp` redirects there).

Since 2026-10-28 it runs on **Meta's official WhatsApp Business Platform (Cloud API) only**, the
owner's decision ("Official only"). A store connects with Meta's **Embedded Signup**; bizinsights
then sends through Meta's Graph API with that business's own token. There is one way to connect.

Before that (2026-10-26 to 2026-10-28) a store could also link a WhatsApp phone with a QR code through
**Evolution API**, an open-source gateway bizinsights hosted on ECS. QR linking is retired: nothing
creates, pairs or sends through Evolution any more, and the phones that were linked are disconnected
by a one-time cleanup ([Removing Evolution](#removing-evolution)). Earlier designs (2026-10-10, and
Meta + Nango on 2026-10-25) left tables that are erase-only ([The old tables](#the-old-tables)).

## Where Meta's approval stands

Meta lets other businesses connect through bizinsights' app only once it has approved bizinsights as
a **Tech Provider**. On 2026-10-28: business verification of Zodiix Pty Ltd is **done**; App Review for
`whatsapp_business_messaging` and `whatsapp_business_management` is **not submitted yet**
([Owner's steps](#owners-steps-meta)); its recordings are made with the app's own test number,
connected with a token of the app ([Connecting](#connecting)). Until Meta approves:

- no merchant can connect WhatsApp: Meta's window stops on "can't onboard customers right now", and
  the page says what that means (it never shows a connection Meta didn't confirm). People with a role
  on the app (admins, developers, testers) can connect their own business;
- the owner's phone that was linked with a QR code is disconnected by the cleanup;
- automations that would send on WhatsApp have no WhatsApp to send through: the Autopilot work
  (stacked on PR #272, not on `main` yet) falls back to SMS, then email.

## Architecture

```
Browser ──HTTPS──> CloudFront ──> api Lambda (Hono, apps/api)
   │                                  │  tenant check, permissions, rate limits
   │  Meta's Embedded Signup          ▼
   │  (Meta's own window)   core whatsapp/* (packages/core) ──> RDS PostgreSQL (wapp_* tables, RLS)
   │                                  │                     ──> SQS "whatsapp" queue ──> jobs Lambda (apps/worker)
   ▼                                  ▼
Meta (facebook.com)       Meta Graph API (graph.facebook.com), through metaGraph.ts and the NAT instances:
                          the business's token in the Authorization header, with appsecret_proof

Meta ──webhook (X-Hub-Signature-256)──> https://bizinsights.io/api/webhooks/whatsapp
       statuses, customers' messages, template reviews
```

- **One transport.** Every call to Meta goes through `packages/core/src/metaGraph.ts` (the token in a
  header, never a URL; `appsecret_proof` with bizinsights' app secret; paging links only to
  graph.facebook.com). WhatsApp's calls are in `whatsapp/cloud.ts` (connecting) and
  `whatsapp/cloudApi.ts` (messages, media, the number, templates).
- **The token stays on the server**: the business's token is kept on the connection row, encrypted
  (AES-GCM with the token keyring, bound to the store), never in an answer, a log or the browser.
- **Attachments** (3 MB at most) wait in the payloads bucket (`wapp-media/<message>`) until they are
  sent, then go to Meta's media endpoint and are named in the message by Meta's media id.
- **Nothing of bizinsights' own runs for WhatsApp** beyond the functions, the queue and the cron:
  no container, no gateway. (Evolution's ECS service still runs in release 1, for the cleanup only.)

### Cost

Nothing per message for bizinsights. Meta charges the **merchant's** WhatsApp Business account for
the conversations Meta bills (marketing and utility templates; service replies inside the 24-hour
window are free), on the account's own payment method. Removing Evolution (release 2) saves
**~US$19 a month** (on-demand in Sydney, priced 2026-10-25, before GST):

| Part removed in release 2 | Month |
| --- | --- |
| Fargate task, 0.5 vCPU + 1 GB on Graviton, always on | US$17.29 |
| Route 53 private hosted zone (Cloud Map's namespace) + one registered instance | ~US$0.60 |
| Two secrets (`evolution-api`, `evolution-db`) | US$0.80 |
| Three alarms (service down, memory, unreachable) | US$0.30 |
| Logs, the DB-init function | cents |
| **Total** | **~US$19** |

## Where things live

| Part | Code |
| --- | --- |
| Pure rules: the provider and what to know before connecting, statuses, consent, templates and variables, triggers and conditions, audiences, limits, the setup's steps, the retired-QR reason | `packages/shared/src/whatsapp.ts` (`@app/shared/whatsapp`) |
| Tables (12, all with RLS on `workspace_id`) | `packages/db/prisma/schema.prisma` (`Wapp*`, `wapp_*`); migration `20261026120000_whatsapp_evolution` (no migration since: the token reuses `instance_token_enc`) |
| Connecting (Embedded Signup), token renewal, Meta's webhook | `whatsapp/cloud.ts` |
| Meta's Graph API for a number: messages, media, the number, templates; Meta's error codes in words | `whatsapp/cloudApi.ts` |
| The connection's state: Check again, reconnect needed, disconnect | `whatsapp/connection.ts` |
| Contacts, consent, the do-not-message list | `whatsapp/contacts.ts` |
| The queue and the sender (window, pace, circuit breaker); delivery statuses | `whatsapp/messages.ts`; a message from the dashboard: `whatsapp/send.ts` |
| Customers' messages, STOP and START | `whatsapp/inbound.ts` |
| Automations; Shopify's events → automations | `whatsapp/automations.ts`, `whatsapp/events.ts` |
| Templates and Meta's review | `whatsapp/templates.ts` |
| Campaigns | `whatsapp/campaigns.ts` |
| Settings, the test number, Pause all automation | `whatsapp/settings.ts` |
| The 15-minute sweep, retention | `whatsapp/sweep.ts` |
| Retiring QR linking (release 1 only) | `whatsapp/retireQr.ts`; Evolution's client `whatsapp/evolution.ts`, its webhook `whatsapp/webhook.ts` |
| Privacy (export, customers/redact, key rotation), erasing a store, the old tables | `whatsapp/privacy.ts`, `whatsapp/purge.ts`, `whatsapp/legacy.ts` |
| Merchant API | `apps/api/src/routes/whatsapp.ts`; machine endpoints: `whatsappWebhook.ts` |
| Jobs | `apps/worker/src/handlers/integrations.ts` (`runWhatsappJob`), `apps/worker/src/index.ts` (queue, sweep) |
| Dashboard | `apps/web/src/app/(app)/dashboard/whatsapp-automation/page.tsx`, `apps/web/src/components/whatsapp/*` (Meta's window: `CloudSignup.tsx`) |

## The page

One page, its tabs in `?tab=`. Until the setup is done it opens on **Setup**; afterwards on
**Overview**. Every state on it comes from the API, which asks Meta: nothing says "connected",
"sent" or "delivered" before Meta did, and no figure is made up.

- **Setup**, four steps, each marked done from stored facts:
  1. **Connect WhatsApp Business**: what Meta's platform gives and what to know first (a Facebook
     sign-in, a business portfolio, templates for business-started messages, Meta's charges, a number
     that can't be in the WhatsApp app at the same time), then one button that opens Meta's Embedded
     Signup. When bizinsights' Meta app isn't configured, the step says so (and, to people who may
     manage integrations, which settings are missing); while Meta hasn't approved bizinsights as a
     Tech Provider, Meta's window says it "can't onboard", and the page explains that after a while.
  2. **Authorize**: what Meta confirmed (the permissions granted for that account, the number in it,
     its webhooks, its registration). Done with step 1, on Meta's word only.
  3. **Configure**: business name, how customers agree to order updates (required), marketing on or
     off, whether Shopify's text-message consent covers WhatsApp, sending hours and time zone, daily
     limit, per-customer daily limit, how long message texts are kept.
  4. **Test and activate**: the merchant's own number, verified with a 6-digit code sent from the
     connected number (the code isn't kept in bizinsights' history). It is free text, which Meta
     delivers only to a phone that wrote to the business number in the last 24 hours, so the step
     asks the merchant to send their business number a message first; a code Meta refused says so
     (131047) in the message history. Then a test message (a short text, or an approved template with
     sample values), whose real status the page follows. The step is done only when Meta reports it
     **sent**. Then a completion screen.
- **Overview**: connection health as last reported (Check again asks Meta), the automation state,
  sent today against the limit, what waits and why, 7- and 30-day counts from each message's own
  record, the latest messages. A store whose phone was linked with a QR code sees that it was retired
  and a link to connect.
- **Messages**: every message, filtered by status, direction, source, automation, campaign, dates
  and (with contact access) a customer's number; each one's status history; **Retry** for a failed
  one; **Send a message** (reason, consent attestation, text or an approved template, optional image
  or PDF; free text only to a customer who wrote in the last 24 hours).
- **Automations**: trigger → conditions → template → recipient → delay and sending hours; ready-made
  presets; switching on lists every reason it can't (a template Meta hasn't approved among them);
  **test mode is on for every new automation**; each automation's runs and why each one did or didn't send.
- **Templates**: write with variables, checked as you type; starters; submit to Meta and follow its
  review (Meta's webhook, and the sweep for those still pending). Only approved templates send.
- **Campaigns**: an audience of customers who agreed to marketing, a live count for the chosen
  template, launch now or later **only with the exact count confirmed**, cancel, a delivery report.
- **Customers** (with "View contact information"): consent and its history, recording consent or an
  opt-out given another way, the do-not-message list.
- **Settings**: Step 3's settings, Pause all automation / Resume, Check again, Connect again (after
  Meta ended the access), Disconnect.

## Connecting

The page loads Meta's JavaScript SDK and opens Embedded Signup (v4) with bizinsights' Meta app and
its configuration (`WHATSAPP_CONFIG_ID` = `2228218088074576`: Cloud API, WhatsApp accounts, both
`whatsapp_*` permissions, a 60-day system-user token). Meta's window does the sign-in, the business,
the WhatsApp Business account and the number, posts what was picked to the page (only messages from
facebook.com are read) and hands back a code that lives 30 seconds. `POST …/whatsapp/connection/cloud`
then, server side (`connectCloudApi`):

1. exchanges the code for the business's token (`GET /oauth/access_token`);
2. asks Meta's token inspector (`GET /debug_token`, with the app token): it must have been issued to
   **bizinsights' app**, hold **both** `whatsapp_business_management` and `whatsapp_business_messaging`,
   and cover the account picked. Refused otherwise (`wrong_app`, `missing_permissions`,
   `waba_not_granted`), with nothing changed;
3. checks the number is **in that account** (`GET /{waba-id}/phone_numbers`; else `phone_not_in_account`)
   and not connected to another store here (`number_taken`);
4. subscribes the account's webhooks to bizinsights' app (`POST /{waba-id}/subscribed_apps`) and
   registers the number with the Cloud API when it isn't yet (`POST /{phone-number-id}/register`, with
   a random 6-digit two-step verification PIN bizinsights doesn't keep; a number that already has a PIN
   is refused with how to turn it off);
5. keeps the token on the connection row, encrypted (`instance_token_enc`, the column Evolution's
   instance keys used: no migration), with its expiry, and marks the connection **connected**. A
   phone the store had linked with a QR code is retired first (its waiting messages cancelled with
   that reason).

Ten attempts an hour per store at most.

**Token renewal.** Embedded Signup tokens last 60 days. The sweep renews a token in its last 30 days
(`renewCloudToken`: `fb_exchange_token`, on the row, only over the token it read). A token Meta no
longer accepts (190, an expired one, or access removed in Meta's business settings) makes the
connection **Needs reconnecting** (`logged_out`, reason `token_expired` or `access_removed`), raises
the alert `whatsapp_reconnect` once, and holds messages; going through Meta's window again (same
account and number) resolves it and the held messages go. Down 48 hours: waiting messages and running
campaigns are cancelled, and the store is told.

**Connecting with the app's own token** (bizinsights' own team only). Until Meta approves bizinsights
as a Tech Provider, Embedded Signup onboards no one, so App Review's recordings can't be made through
it. The workspaces in `WHATSAPP_TOKEN_CONNECT_WORKSPACES` (the PixMagic workspace since 2026-10-29;
empty: no one) see a second way under the button, **bizinsights team: connect with the app's own
token**: the WhatsApp Business account ID, the phone number ID and a token of the Insights app made in
Meta's dashboard by someone with a role on it (a system user's in Business settings, or API Setup's
temporary one). `POST …/whatsapp/connection/cloud-token` (`connectCloudApiWithToken`) refuses every
other workspace (403 `token_connect_off`) before Meta is asked, then runs steps 2-5 above unchanged:
the token must be the app's, with both permissions, for that account, and the number in it. The
token is kept like Embedded Signup's, never shown or logged; the audit row says `via: "app_token"`. A
system user's token never expires (nothing to renew); API Setup's temporary one is renewed like any.

**Check again** (and the sweep, every 6 hours per connection) asks Meta for the number
(`GET /{phone-number-id}`): an answer means connected; a refused token means reconnect.

**Disconnect** forgets the token, lets the number go (it may be connected again, here or elsewhere),
cancels what waits, pauses automations, stops campaigns, keeps the history, and unsubscribes the
account's webhooks from bizinsights' app when no other store here uses that account. Uninstalling the
Shopify app disconnects the same way; erasing a store (shop/redact) undoes what was set up at Meta first.

## Sending

`queueMessage` makes one row per purpose (`idempotencyKey`, unique per store), so Shopify's retries,
a duplicate queue delivery or a double press send once. The `whatsapp` queue's `wapp_send` job claims
the row (`queued` → `sending`, one claim wins) and checks, in order: the connection is up (else held,
cancelled after 48 hours; a message queued for a retired QR phone is cancelled with
`qr_linking_retired`), the automation or campaign still runs, automation isn't paused, consent, the
sending hours (store time), the store's daily limit, the customer's daily limit, **Meta's 24-hour
window** (free text or an attachment to a customer who last wrote more than 24 hours ago is skipped
as `outside_window` without asking Meta; a template is fine), the **number's circuit breaker**, and the
pace (20 a second per number). Then one call: `POST /{phone-number-id}/messages`.

- **What goes**: an approved template with its body's values in order (`type: template`), free text
  (`type: text`, link previews on), or an image or PDF uploaded first (`POST /{phone-number-id}/media`,
  then `type: image|document` by media id, the text as caption). Every message carries bizinsights'
  message id as `biz_opaque_callback_data`, which Meta returns on each status report.
- Meta's answer makes the message **accepted**; **sent**, **delivered** and **read** come only from
  Meta's status reports, recorded once each, and a message never moves backwards. A report that comes
  before the answer was recorded finds the message by its reference and keeps its status.
- **There is no "is this number on WhatsApp?"** on the Cloud API: a number that isn't is only known
  from Meta's failed report afterwards (131026, "undeliverable").
- **Meta never reached** (the connection was refused, the name didn't resolve): retried after 30 s,
  2 min, 10 min, 30 min, then failed with the reason.
- **A send that may have gone** (it timed out, the connection dropped after the request went out,
  Meta answered 5xx, or a 2xx without a message id): marked failed ("uncertain") and **never retried
  automatically**; the merchant decides (Retry). If Meta then reports it sent or delivered (found by
  its reference), the message is settled as sent. A send that never finished (the worker died) is
  marked uncertain by the sweep.
- **Meta's limits** (130429, 4, 80007: the number, app or account; 131056: one customer): the message
  is sent again later, a try spent, never twice; 130429 and its kin also **open the number's circuit**
  for a minute, which holds that number's other messages without spending their tries. Five
  failures in five minutes (unreachable, 5xx) open it too.
- **Meta's access ended** (190, the permission errors 10 and 2xx, 131005, 133010): the connection
  needs reconnecting (above); the message waits.
- **Refused for this message**: failed with Meta's code (`meta_<code>`) and its meaning in words:

  | Code | Means | Shown as |
  | --- | --- | --- |
  | 131047 | More than 24 hours since the customer last wrote: only an approved template | `outside_window` |
  | 131026 | Undeliverable: not on WhatsApp, an old app, terms not accepted | `undeliverable` |
  | 132000, 132001, 132005, 132007, 132012, 132015, 132016 (and 132xxx) | The template: values that don't fit, missing, too long, paused, disabled | `template_unavailable` |
  | 131030 | A test number sends only to the numbers listed on it in WhatsApp Manager | `provider_rejected` |
  | 131050 | The customer stopped marketing from the business in WhatsApp | `no_marketing_consent` |
  | 131049, 130472 | Meta chose not to deliver (marketing limits, an experiment) | `provider_rejected` |
  | 368, 131031, 131042, 131048, 130497, 131037 | The account can't send (policy, locked, payment, spam limit, country, display name) | `provider_rejected` |

- Limits: daily per store (default 1,000, at most 100,000), per customer 3 a day (at most 10), 20
  dashboard messages a minute, campaigns at most 100,000 recipients.

**Test sends.** A number that is still Meta's test number (WhatsApp Manager → API Setup) sends only to
up to five numbers listed there; anything else fails with 131030, worded as such.

## Webhooks and security

**Meta → bizinsights** (`/api/webhooks/whatsapp`), the only source of statuses, customers' messages and
template reviews:

- `POST`: `X-Hub-Signature-256` HMAC of the raw body with bizinsights' Meta app secret, checked
  before anything is read; past 300 refused deliveries a minute from one address it is answered 429
  without logging.
- `GET`: the subscription handshake answers only the verify token (constant-time).
- A delivery is applied part by part, each idempotent (Meta delivers again what it didn't get a 200
  for): a status is recorded once per message and status, a customer's message once by its id, a
  template review by Meta's template id. A report for a number disconnected here (its phone number id
  was let go) belongs to nobody and is skipped. Statuses only move forward.

**Evolution → bizinsights** (`/api/webhooks/whatsapp/evolution/:instance`) stays in release 1 only,
receive-only: until an instance is deleted, its customers' messages (a STOP above all) and delivery
reports are still taken, with the instance's HS256 JWT as before; connection events change nothing.
Removing the route in this release would drop a customer's STOP sent to a linked phone between the
deploy and the cleanup's tick (Evolution doesn't retry a 404). Release 2 removes it.

**Tenancy and secrets.**

- Every merchant route is `/workspaces/:ws/stores/:storeId/whatsapp/…`: the workspace comes from the
  path and is checked against the signed-in member (`requireWorkspace`), and the store must belong
  to it. Queries run under row-level security for that workspace, and every row carries
  `workspace_id` and `store_id`. A browser-supplied id is never trusted alone.
- Meta's webhook finds the connection by the phone number id Meta names, and a status only the
  message sent through that same connection: a report naming another store's message (or its
  reference) under another number changes nothing.
- Meta tokens, the app secret and full phone numbers never appear in an answer; numbers are
  masked, stored encrypted and matched by a keyed hash.
- The logger redacts `token`, `apikey`, `text` and the rest of the credential fields.

## Who may do what

| Action | Needs |
| --- | --- |
| See the page and its data | **View campaigns** (`marketing.campaigns`) |
| See how the connection stands (Settings → Integrations) | **View integration connection status** too: the overview answers that person with the connection alone |
| See customers' numbers, names, what was said; the Customers tab | **View contact information** as well |
| Change what customers receive: settings, test number, templates, automations, campaigns, sends, retries, consent records, the do-not-message list | The store's **owners and admins** (`stores:manage`), signed in themselves |
| Connect, disconnect | **Manage integrations**, signed in themselves |

A shared dashboard link never administers WhatsApp, whatever it was given (only "Check again"
refreshes the connection's state), and neither does a workspace API key. Every route is in
`apps/api/test/routeAccess.test.ts`'s deny-by-default matrix. The retired QR routes
(`POST …/connection`, `GET …/connection/pairing`, `POST …/connection/reconnect`) answer 410
`qr_linking_retired` with words a page loaded before the change shows.

## Consent

Two separate permissions, checked when a message is queued and **again when it is sent** (a customer
may have replied STOP in between):

- **Order updates** (transactional): only under the store's chosen basis: "Customers told at
  checkout" (everyone with a number, unless they reply STOP) or "Only customers who agreed" (opted in,
  replied START, or the merchant recorded it). Unset: nothing goes. A customer who wrote in the last
  24 hours may be answered.
- **Marketing**: marketing switched on in Settings **and** the customer's own marketing yes. Every
  marketing template must say how to stop.

STOP (and "unsubscribe", "opt out"…) from **anyone** puts the number on the store's do-not-message
list by its keyed hash, and one confirmation is sent; START undoes it. The list is checked for
**every** message, the store's own numbers' too (tests, codes, stock alerts, automations in test
mode). A STOP is applied even when the first try to record it failed halfway. Messages from numbers
that aren't the store's contacts are dropped unread (only a STOP or START is kept, by hash).

## Automations

Triggers: an order is placed, paid, ships (once per order, the first parcel), is cancelled; a
checkout is left unfinished (timed from the customer's last change; the order cancels it); a customer
signs up (needs `read_customers`); a customer sends a message (with a cool-down). Shopify's webhooks
arrive verified (HMAC, dedupe, shop binding) and are applied after the analytics write.

Each automation sends its **template as Meta approved it** (a template starts a conversation, so no
24-hour window applies), runs **at most once per order, checkout, customer or message window**,
records why it didn't send when it didn't, never triggers another, and starts in **test mode**.

## Data and retention

Tables (`wapp_*`): connections, settings, templates, contacts, consent events, suppressions,
messages, message events, webhook events (a QR-linked phone's, until release 2), automations,
automation runs, campaigns. Message texts are kept for the store's retention (default 90 days,
7–365), then only the record; records 365 days and automation runs 90 days (what the privacy policy
says); attachments until sent (and Meta keeps an uploaded file 30 days). `customers/redact` erases a
customer's WhatsApp data by hash (also in the old tables); a data request exports it; `shop/redact`
and erasing a store delete everything. Rotating `TOKEN_ENCRYPTION_KEYS` re-encrypts every `wapp_*`
secret, the business's token included.

## Settings and secrets

| Setting | Where | What |
| --- | --- | --- |
| `WHATSAPP_CONFIG_ID` | `apps/aws/src/settings.ts` | Embedded Signup's configuration on the Meta app "Insights" 971575545351940: `2228218088074576` |
| `WHATSAPP_APP_ID` (empty: `META_APP_ID`), `WHATSAPP_API_VERSION` (`v26.0`) | `apps/aws/src/settings.ts` | WhatsApp runs on the Meta Ads app |
| `WHATSAPP_TOKEN_CONNECT_WORKSPACES` | `apps/aws/src/settings.ts` | Workspaces that may also connect with a token of the app ([Connecting](#connecting)): PixMagic's `cmvarpfwa000002jngkgh5ji2`; empty: no one |
| `META_APP_SECRET` (or `WHATSAPP_APP_SECRET` on an app of its own), `WHATSAPP_WEBHOOK_VERIFY_TOKEN` | Secrets Manager `insights/<env>/app` | Code exchange, `appsecret_proof`, webhook signatures, the handshake |
| `EVOLUTION_API_URL`, `EVOLUTION_API_KEY`, `EVOLUTION_*` | CDK and `insights/<env>/evolution-api` | Release 1 only: the cleanup's access to Evolution |

Nothing is pasted by a merchant (only bizinsights' own team pastes the app's token). The Deploy run's config check prints "Cloud API off (needs …)" while
a Meta setting is missing; the page then offers nothing to connect and says why.

## Owner's steps (Meta)

Only the owner can do these, in Meta's consoles (never automated: it has blocked the admin account
before). Done: WhatsApp added to the app "Insights" (971575545351940), Facebook Login for Business
settings and domains, the Embedded Signup configuration `2228218088074576`, the webhook verify token,
**business verification** of Zodiix Pty Ltd. Still the owner's:

1. **App Review**: in the app dashboard, **Use cases → WhatsApp (Connect with customers through
   WhatsApp) → Customize → Become Tech Provider** (1 of 2 steps done on 2026-10-29: business
   verification Approved), request Advanced Access for `whatsapp_business_messaging` and
   `whatsapp_business_management`, with screencasts of a message sent from bizinsights arriving and a
   template created in bizinsights (a reviewer can't be sent an emailed sign-in code: see
   docs/ads-review-packs.md for the reviewer account). The recordings, with the app's test number:
   1. Meta dashboard → the Insights app → **WhatsApp → API Setup**: note the test number's **Phone
      number ID** and the **WhatsApp Business Account ID**; under "To", add your own WhatsApp number
      (a test number sends only to the numbers listed there).
   2. Business settings (portfolio Zodiix Pty Ltd) → **Users → System users**: add an admin system
      user, give it the Insights app and the test WhatsApp account (full control), **Generate token**
      for the Insights app with `whatsapp_business_management` and `whatsapp_business_messaging`,
      expiry "Never". (API Setup's temporary token works too, for 24 hours.)
   3. bizinsights → PixMagic → WhatsApp → **Setup → 1. Connect** → **bizinsights team: connect with
      the app's own token**: paste the two ids and the token, **Connect with this token**. Then step 3
      (Configure).
   4. **Video 1** (`whatsapp_business_messaging`): from your phone, write to the test number; in
      bizinsights send a reply from the Messages tab (or step 4's test message to your own number),
      with WhatsApp on the phone (or WhatsApp Web) in view as it arrives.
   5. **Video 2** (`whatsapp_business_management`): in bizinsights' **Templates** tab create a
      template and submit it to Meta; show it in WhatsApp Manager → Message templates.
   6. In App Review → Permissions and features, add both permissions back to the request (they were
      taken out on 2026-10-26: docs/ads-review-packs.md), attach each video, and submit.
2. **Tech Provider onboarding**: once App Review passes, finish Meta's Tech Provider steps for the app
   (WhatsApp → Quickstart / Partner settings) so Embedded Signup onboards other businesses.
3. In **WhatsApp → Configuration**, the app's webhook: `https://bizinsights.io/api/webhooks/whatsapp`
   with the verify token, fields `messages` and `message_template_status_update`.

Templates each need Meta's approval (submitted from the Templates tab). A test send from a number that
is still Meta's test number reaches only the numbers listed on it.

## Removing Evolution

QR linking ran on Evolution API 2.3.7 on ECS Fargate (stack `InsightsWhatsapp-<env>`). It is removed
in steps, so nothing a merchant or customer did is lost and `cdk deploy --all` never has to destroy
something another stack still needs.

**Release 1 (`claude/whatsapp-official-only`).** No code path creates, pairs or sends through Evolution.
The cron's WhatsApp sweep runs `retireQrLinking` (its own lock, idempotent) every tick until nothing
is left:

- each QR-linked connection: disconnected with reason `qr_linking_retired`, its queued messages
  cancelled with that reason (never sent), its automations paused and campaigns cancelled, the alert
  `whatsapp_qr_retired` raised ("Connect WhatsApp Business to keep sending"; resolved when the store
  connects Meta), an audit row `whatsapp.qr_linking_retired`; then its instance **logged out** (the
  phone loses the linked device) and **deleted**. If Evolution doesn't answer, the connection is
  retired in bizinsights at once and the instance is deleted on a later tick;
- each Cloud API connection made before 2026-10-28 (its token held by an Evolution instance): the
  instance is deleted, the token stays on the row and the number keeps sending, through Meta now;
- each `bi_` instance no connection holds: deleted. Once nothing is left, a marker stops the listing
  for a week.

From the moment release 1 runs, the page shows a QR-linked connection as **Retired** (even before the
tick reaches it), and a message queued for it is cancelled with the reason when its turn comes. Until
an instance is deleted, a customer's STOP to that phone is still applied (the Evolution webhook route
stays, receive-only). Infrastructure is unchanged.

**Release 2 (`claude/whatsapp-remove-evolution`, stacked on release 1).** Merge it only after release
1's Deploy succeeded and the cron logged its cleanup done (`whatsapp qr linking: what was left of it
retired` no longer appears and the last one said `left: 0`, or `whatsapp:retire-qr:done` is set in
the coordinator table). It removes the service:

1. **Code**: Evolution's client (`whatsapp/evolution.ts`), its webhook route
   `/api/webhooks/whatsapp/evolution/:instance` with its JWT verification (`whatsapp/webhook.ts`) and
   its smoke check, the `EVOLUTION_*` settings, the deploy check's reachability of the service, the
   nightly prune of its database, `docker-compose.yml`'s `whatsapp` profile, `e2e/evolution-stub.mjs`
   and `test-support/evolutionFake.ts`. `retireQr.ts` stays without Evolution: it retires any QR row
   release 1 didn't reach (same reason, cancellations, alert, audit) and sets Evolution's stored
   webhook events aside; the queue's `wapp_event` job only sets its event aside.
2. **The database**: the cron's `evolution-db` action becomes **`evolution-db-drop`** (`apps/aws/src/
   evolutionDb.ts`): `DROP DATABASE evolution WITH (FORCE)` and `DROP ROLE evolution`, idempotent.
3. **The WhatsApp stack** keeps only what CloudFormation needs: it stays in the app (the deploy never
   destroys a stack that leaves it) with **one** custom resource that runs `evolution-db-drop` once.
   The ECS cluster and service, the task definition, the Cloud Map namespace, the security group and
   its rule on the database, the alarms and the DB-init custom resource leave the template, so
   **CloudFormation deletes them** in that deploy's cleanup (the log group
   `/ecs/insights-production-evolution-a` is kept until its retention ends). The drop runs before the
   cleanup stops the task, hence `FORCE`.
4. **The App stack** stops wiring Evolution: `EVOLUTION_API_URL`, `EVOLUTION_SECRET_ARN`,
   `EVOLUTION_DB_SECRET_ARN`, the two secrets' grants, and the `whatsapp-service-unreachable` alarm.
5. **The Data stack** deploys first, while the WhatsApp stack's previous version still imports four of
   its exports (the VPC, the database's security group, the two Evolution secrets) and CloudFormation
   refuses to delete an export in use. So it keeps exporting them under the same names
   (`exportValue`), and keeps the two secrets, their removal policy now Delete.

**Release 3** (after release 2's Deploy succeeded, so nothing imports those exports any more): the Data
stack drops the four `exportValue`s and the two secrets (Delete: Secrets Manager schedules their
deletion); the WhatsApp stack's custom resource gives way to a placeholder
(`AWS::CloudFormation::WaitConditionHandle`: a stack needs one resource), and the cron's
`evolution-db-drop` action, `evolutionDb.ts`, `retireQr.ts` and the `wapp_event` job go; then a later
pull request may drop the `instance_name`, `instance_id`, `webhook_key_enc` columns and the
`wapp_webhook_events` table with the other old tables. Deleting the empty stack is optional and by
hand (`aws cloudformation delete-stack --stack-name InsightsWhatsapp-production`, after removing it
from `bin/insights.ts`).

Each release ships through `main` → CI → Deploy like any other; none needs a hand deploy.

## Runbook

- **A store says its WhatsApp stopped**: the Overview's connection. "Needs reconnecting" is Meta
  ending bizinsights' access (alert `whatsapp_reconnect`): the merchant connects again from Setup.
  "Retired" is a phone that was linked with a QR code: connect Meta.
- **Messages wait with "Meta's WhatsApp service wasn't answering"**: a number's circuit is open for a
  minute after repeated failures or Meta's rate limit (`whatsapp circuit opened` in the logs).
- **A template doesn't send**: its Meta status on the Templates tab (pending, rejected, paused,
  disabled); 132xxx failures say which.
- **Release 1's cleanup**: `whatsapp qr link retired` per store, `evolution instance deleted` per
  instance, `whatsapp qr linking: what was left of it retired` with what is left.

## Deployment, migration and rollback

1. **No migration**: the business's token reuses `instance_token_enc`, the new reasons are strings
   (`status_reason`, `reason`), and `schema.prisma` changed only in its comments.
2. Release 1 deploys like any other. Its first cron tick retires the QR links (above).
3. **Rollback** (Deploy to AWS moves the functions back): the previous release reads the same tables.
   A QR link already retired stays disconnected (the merchant would link the phone again in that
   release); a Cloud API connection made in release 1 has no Evolution instance, which the previous
   release needs to send, so it shows as not connected there until it is connected again.

## The old tables

Two earlier designs, both erase-only now (`whatsapp/legacy.ts`): customers/redact and shop/redact
erase there, and a data request counts what they hold. No store connected through the 2026-10-25
design, so it left no token at Nango, and erasing a store no longer asks Nango for one
([ads-setup.md](ads-setup.md#leaving-nango), step (c)).

- 2026-10-10 to 2026-10-24: `whatsapp_*`, `order_trackings`, `order_tracking_events`,
  `abandoned_checkouts`, `customer_reviews`.
- 2026-10-25: `wa_*` (Meta Cloud API, the token at Nango).

**Next step, a follow-up pull request**: drop both sets (after recording their row counts), remove
their models and `legacy.ts`.

## Testing

```bash
pnpm --filter @app/shared test
pnpm --filter @app/core exec vitest run test/whatsappCloudApi.test.ts test/whatsappEvolution.test.ts
```

```bash
TEST_PG_PORT=5501 TEST_PG_PASSWORD=app TEST_DB=wacloud_test pnpm --filter @app/api exec vitest run test/whatsapp.test.ts
TEST_PG_PORT=5501 TEST_PG_PASSWORD=app TEST_DB=wacloud_test pnpm --filter @app/worker exec vitest run test/whatsapp.test.ts
```

Meta's Graph API is `test-support/cloudApiFake.ts`: it checks what Meta checks (the token in the
header, its `appsecret_proof`, the token's app and permissions) and signs its webhooks as Meta does;
Evolution (for the cleanup) is `test-support/evolutionFake.ts`. Nothing leaves the machine. The API
test covers Embedded Signup (connected only after every check; another app's token, a missing
permission, a number outside the account, an expired code; Meta's app not set up), Meta's webhook
(signature, duplicate deliveries, accepted → sent → delivered → read, failed with Meta's code, an
uncertain send settled by its reference), the test number and the test's real status, sends (consent,
the 24-hour window, templates, attachments by media id, uncertain sends, retries, Meta's rate limit
and the circuit, an access Meta ended → reconnect), STOP and START, automations and campaigns as
approved templates, tenant isolation (including Meta's reports), viewers, a shared link, disconnecting,
and a QR-linked phone shown retired, its STOP kept and retired on connecting. The worker test covers
the queue (duplicate deliveries, retries, the circuit), the sweep (uncertain sends, checks with Meta,
token renewal and expiry, 48 hours down, retention) and the QR cleanup (instances logged out and
deleted, connections disconnected with the reason, queued messages cancelled, Evolution down,
idempotent second run).

In a real browser: `apps/web/e2e/whatsapp.spec.ts`, with Meta's JavaScript SDK stubbed in the page and
`apps/web/e2e/meta-graph-stub.mjs` as the Graph API (the local server sends Meta's calls to it,
`LOCAL_GRAPH_URL`): the four steps end to end, and a retired QR link.

Embedded Signup itself can't be tested end to end until Meta approves bizinsights as a Tech
Provider; until then only people with a role on the app can go through Meta's window, with a real
business. Don't message real customers while testing.
