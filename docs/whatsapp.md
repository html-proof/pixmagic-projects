# WhatsApp Automation

bizinsights sends a store's customers WhatsApp messages about their orders, automatically
(automations started by Shopify's events), personally (a message from the dashboard) and in bulk
(campaigns to customers who agreed to marketing), and records every message's real delivery as
WhatsApp reports it. The page is **WhatsApp Automation** at `/dashboard/whatsapp-automation` (the
sidebar's "WhatsApp"; the old `/whatsapp` redirects there).

Since 2026-10-26 it runs on **[Evolution API](https://github.com/evolution-foundation/evolution-api)**,
an open-source WhatsApp gateway that bizinsights hosts itself as a private service on AWS. A store
connects in one of two ways, and chooses knowingly (the page shows both side by side, with what each
means, before anything is created):

- **Link a WhatsApp phone with a QR code** (Evolution's Baileys integration). The store scans a code
  with the WhatsApp or WhatsApp Business app on its phone, as with WhatsApp Web. Quick, no Meta
  account needed; **not** Meta's official business API, so the page says so and asks the merchant to
  tick that they understand before the code is shown. bizinsights paces and caps what a linked phone
  sends to protect the number.
- **Official WhatsApp Business Platform (Cloud API)** (Evolution's WHATSAPP-BUSINESS integration).
  The store signs in with Meta's Embedded Signup and picks its WhatsApp Business account and number;
  bizinsights then sends through Evolution with that business's token. Meta's preferred way for
  businesses, with templates Meta approves. Meta onboards other businesses only once bizinsights is
  an approved Tech Provider ([Owner's steps](#owners-steps-cloud-api)); until then the option says
  so.

It replaced the Meta-only design of 2026-10-25 (Embedded Signup with the token kept at Nango,
release 119), which itself replaced the 2026-10-10 feature. Both earlier designs' tables are kept,
erase-only, until a later drop ([The old tables](#the-old-tables)).

**QR linking was switched off for a day and is back (2026-10-29).** Release 128 (PR #276,
2026-10-28) made the page Meta's Cloud API only: its cron disconnected the two QR-linked phones
(reason `qr_linking_retired`), cancelled their waiting messages, paused their automations and
deleted their Evolution instances. The owner asked for QR linking back the next day, so this design
was restored as it ran in release 127 (PR #276 reverted; #278, which would have removed the
Evolution service, was not merged). What release 128 left is worded, not undone: a retired
connection shows as disconnected and is linked again with a new QR code; its cancelled messages say
why; its `whatsapp_qr_retired` alert tells the merchant to link the phone again and turn their
automations back on, and is resolved when WhatsApp connects again. Paused automations stay paused
until the merchant turns them on: resuming them by itself could send messages nobody expects.
Kept from release 128 for a Cloud API number: free text only within Meta's 24-hour
customer-service window (refused from the dashboard, `outside_window`; skipped at sending if the
window closed meanwhile), and a template picked in the dashboard goes as Meta's template by its
name. A linked phone has no such window.

## What was verified first (2026-10-25)

Read from Evolution's source at tag `2.3.7` (the release tarball, not the docs site) and its Docker
Hub image:

| Question | Answer |
| --- | --- |
| Which release? | **2.3.7** (2025-12-05), the latest release; 2.4.0-rc2 is a pre-release. Image `evoapicloud/evolution-api:v2.3.7`, multi-arch (amd64 and arm64), pinned by digest `sha256:1bd8afc4…d339` (`infra/cdk/lib/whatsapp-stack.ts`, `docker-compose.yml`). |
| Licence? | Apache 2.0 with conditions: a **usage notification** visible to administrators (shown on the page's Settings tab: `EVOLUTION_NOTICE` in `@app/shared/whatsapp`), and the logo kept in its manager UI (not used: the manager is disabled). |
| Authentication? | An `apikey` header: the global key (Secrets Manager), or an instance's own token, set when bizinsights creates the instance. bizinsights uses each instance's own token for everything but creating and listing instances. |
| Endpoints used | `POST /instance/create`, `POST /webhook/set/{i}`, `GET /instance/connect/{i}` (QR or pairing code), `GET /instance/connectionState/{i}`, `POST /instance/restart/{i}`, `DELETE /instance/logout/{i}`, `DELETE /instance/delete/{i}`, `GET /instance/fetchInstances`, `POST /message/sendText/{i}`, `POST /message/sendMedia/{i}`, `POST /message/sendTemplate/{i}`, `POST /template/create/{i}`, `GET /template/find/{i}`, `POST /chat/whatsappNumbers/{i}`. Answers and errors as `packages/core/src/whatsapp/evolution.ts` reads them (an error is `{status, error, response: {message}}`; a number not on WhatsApp is a 400 with `exists: false`; a closed connection is "Connection Closed"). |
| Webhooks? | Per instance, the events bizinsights asks for, as `{event, instance, data, date_time, …}`. **No body signature.** A `jwt_key` in the webhook's headers makes Evolution send `Authorization: Bearer <HS256 JWT>` (claims `app: "evolution"`, `action: "webhook"`, valid 10 minutes). Retries 10 times with backoff; 4xx other than 429 aren't retried. |
| Message statuses | `PENDING` (accepted), `SERVER_ACK` (sent), `DELIVERY_ACK`, `READ`, `PLAYED`, `ERROR`. |
| State | Sessions in PostgreSQL (`DATABASE_SAVE_DATA_INSTANCE`); instances belong to a `DATABASE_CONNECTION_CLIENT_NAME`, which allows shards. |
| Checked running | 2.3.7 built from its source with the ECS task's settings on PostgreSQL 18, driven by bizinsights' own client (`evolution.ts`): create, webhook, a real QR code from WhatsApp on the first `connect` (and the same code again while pairing, not a restart), `connectionState`, a wrong token refused (401), logout, delete; its `CONNECTION_UPDATE` and `QRCODE_UPDATED` webhooks verified with `verifyEvolutionJwt` (and refused with another key). It showed three things the source reading hadn't: **`CORS_ORIGIN` must be `*`** (any other value answers 500 to a call without an `Origin` header, which is every server's call and the health check); delete answers before the instance is gone (it goes a moment later); a send to an instance still pairing waits for the client's timeout instead of failing (bizinsights only sends once the provider said "open"). `fetchInstances` returns instance tokens to the global key (server side only; webhooks carry none). |
| Quirks handled | The image's time zone is São Paulo and `date_time` carries a "Z": the task sets `TZ=UTC`. Its start script prints `DATABASE_URL`: only `DATABASE_CONNECTION_URI` is set. At LOG level it prints QR codes and at INFO numbers: `LOG_LEVEL=ERROR,WARN`. Its SQS mode needs static AWS keys and drops failures: webhooks are used instead. Its Cloud integration answers Meta's errors with a 2xx and stores every sent message: the client treats such an answer as a refusal, and the nightly cron prunes Evolution's own message rows after 7 days. Its code `console.log`s every message received (number and text) whatever `LOG_LEVEL` says, and libsignal (inside Baileys) prints whole Signal sessions, private keys included, with `console.info` ("Closing session", "Opening session", "Removing old closed session") and `console.warn` ("Session already closed"): the task loads a filter (`/tmp/quiet-console.cjs`) that drops everything printed through the console, on every method (`log`, `info`, `warn`, `error`, `debug`, `trace`, `dir`, `table`, …), except the lines of Evolution's own logger (`[Evolution API] …`, its ERROR and WARN lines included), so neither customers' messages nor session keys reach CloudWatch. Baileys' own error lines (pino's JSON) don't go through the console and stay, and so does a crash's stack; Node's own warnings (`(node:1) Warning: …`) go with the rest. `stacks.test.ts` runs the filter against every console method. |

## Architecture

```
Browser ──HTTPS──> CloudFront ──> api Lambda (Hono, apps/api)
                                      │  tenant check, permissions, rate limits
                                      ▼
                         core whatsapp/* (packages/core) ──> RDS PostgreSQL (wapp_* tables, RLS)
                                      │                 ──> SQS "whatsapp" queue ──> jobs Lambda (apps/worker)
                                      ▼
                   Evolution API (ECS Fargate, private subnets, no public address, no load balancer)
                   http://evolution-a.whatsapp.production.insights.internal:8080 (Cloud Map)
                                      │  its own database "evolution" on the same RDS instance
                                      ▼
                        WhatsApp (Baileys) / Meta Graph API (Cloud API), through the NAT instances

Evolution ──webhook (JWT)──> https://bizinsights.io/api/webhooks/whatsapp/evolution/<instance>
Meta (Cloud API numbers) ──webhook (X-Hub-Signature-256)──> https://bizinsights.io/api/webhooks/whatsapp
```

- **The browser never reaches Evolution.** Only the Lambda functions can (its security group admits
  port 8080 from theirs alone); its global key lives in Secrets Manager (`insights/<env>/evolution-api`)
  and in the task's secrets, never in a response, a log or the browser.
- **HTTPS wherever traffic leaves the VPC**: the browser to CloudFront, Evolution's webhooks to
  bizinsights' public address, Evolution to WhatsApp and Meta, the database (TLS, its certificate
  checked). The one hop inside the VPC, functions → Evolution, is plain HTTP to a private address
  only the functions' security group may open. TLS on it would need a private certificate authority
  (US$400 a month) or an internal load balancer (about US$20) for traffic that never leaves the VPC.
- **Reused, not duplicated:** the app's RDS instance (one more database and role), its VPC, NAT
  instances, SQS (one more queue), DynamoDB coordination (locks, rate limits, the send pace),
  Secrets Manager, CloudWatch alarms and the alarm topic, the cron's sweeps.
- **No ElastiCache:** one task keeps its sessions in memory (`CACHE_LOCAL_ENABLED`); bizinsights'
  own coordination is the DynamoDB table it already has. Redis would only be needed for several
  tasks sharing instances, which Evolution's sessions can't do anyway (see [Scaling](#scaling)).
- **No S3 for media:** attachments (3 MB at most) are kept in the payloads bucket only until they
  are sent (`wapp-media/<message>`), and Evolution is told not to store media.

### Cost

On-demand in Sydney, from AWS's price list (2026-10-25), before GST:

| Part | Month |
| --- | --- |
| Fargate task, 0.5 vCPU + 1 GB on Graviton, always on (0.5 × US$0.03885 + 1 × US$0.00426 per hour) | US$17.29 |
| Route 53 private hosted zone (Cloud Map's namespace) + one registered instance | ~US$0.60 |
| Two secrets (`evolution-api`, `evolution-db`) | US$0.80 |
| Three alarms (service down, memory, unreachable) | US$0.30 |
| Logs (errors and warnings only), the DB-init function, SQS | cents |
| **Total** | **~US$19** |

**Production runs on Fargate Spot** since 2026-11-06 (the owner's yes, change 5 of
[aws-migration/AWS_MIGRATION_PLAN.md](aws-migration/AWS_MIGRATION_PLAN.md)): `whatsapp.spot: true` in
`infra/cdk/lib/config.ts`. AWS doesn't publish Spot's rate in its price list (it states up to 70 %
off); the bill shows the real figure about a week after the switch. When AWS reclaims the task (two
minutes' notice), ECS starts another and every linked phone drops for the minute or two that takes;
sessions resume from the database, as after a deploy. If Spot capacity runs out, no task starts until
it returns, and the `whatsapp-service-down` alarm emails after 10 minutes.

Back to on demand: `whatsapp.spot: false`, by pull request. The service always runs through a
**capacity provider** (`FARGATE_SPOT` or `FARGATE`, the latter on demand) and never the `FARGATE`
launch type: moving between two capacity providers is an in-place update, but CloudFormation moves
a service from a capacity provider back to a launch type by replacing it, and the service's fixed
name makes that fail ("already exists"). All four switches were tried on a throwaway stack on
2026-11-06. Changing the provider forces a new deployment (`ForceNewDeployment`, its nonce is the
provider), so the running task moves at once.

## Where things live

| Part | Code |
| --- | --- |
| Pure rules: providers and their disclosures, statuses, consent, templates and variables, triggers and conditions, audiences, limits, the setup's steps | `packages/shared/src/whatsapp.ts` (`@app/shared/whatsapp`) |
| Tables (12, all with RLS on `workspace_id`) | `packages/db/prisma/schema.prisma` (`Wapp*`, `wapp_*`); migration `20261026120000_whatsapp_evolution` |
| Evolution API client (timeouts, retries for reads only, typed errors, Zod-checked answers) | `packages/core/src/whatsapp/evolution.ts` |
| Connecting, pairing, connection events, reconnect, disconnect, the reconcile | `whatsapp/connection.ts`; the Cloud API: `whatsapp/cloud.ts` |
| Contacts, consent, the do-not-message list | `whatsapp/contacts.ts` |
| The queue and the sender; delivery statuses | `whatsapp/messages.ts`; a message from the dashboard: `whatsapp/send.ts` |
| Evolution's webhook (JWT, storage, dedupe) | `whatsapp/webhook.ts`; customers' messages, STOP and START: `whatsapp/inbound.ts` |
| Automations; Shopify's events → automations | `whatsapp/automations.ts`, `whatsapp/events.ts` |
| Templates (and Meta's review on the Cloud API) | `whatsapp/templates.ts` |
| Campaigns | `whatsapp/campaigns.ts` |
| Settings, the test number, Pause all automation | `whatsapp/settings.ts` |
| The 15-minute sweep, retention | `whatsapp/sweep.ts` |
| Privacy (export, customers/redact, key rotation), erasing a store, the old tables | `whatsapp/privacy.ts`, `whatsapp/purge.ts`, `whatsapp/legacy.ts` |
| Merchant API | `apps/api/src/routes/whatsapp.ts`; machine endpoints: `whatsappWebhook.ts` |
| Jobs | `apps/worker/src/handlers/integrations.ts` (`runWhatsappJob`), `apps/worker/src/index.ts` (queue, sweep) |
| Evolution's database (role, database, nightly prune) | `apps/aws/src/evolutionDb.ts`, the cron's `evolution-db` action |
| Infrastructure | `infra/cdk/lib/whatsapp-stack.ts` (stack `InsightsWhatsapp-<env>`), secrets in `data-stack.ts`, queue/env/alarms in `app-stack.ts` |
| Dashboard | `apps/web/src/app/(app)/dashboard/whatsapp-automation/page.tsx`, `apps/web/src/components/whatsapp/*` |
| Local service | `docker-compose.yml`, profile `whatsapp` (`docker compose --profile whatsapp up -d evolution`) |

## The page

One page, its tabs in `?tab=`. Until the setup is done it opens on **Setup**; afterwards on
**Overview**. Every state on it comes from the API, which asks the provider: nothing says
"connected", "sent" or "delivered" before WhatsApp did, and no figure is made up.

- **Setup**, four steps, each marked done from stored facts:
  1. **Connect**: the two ways, side by side, with what each gives and its limits; the QR way needs
     the "I understand" box ticked.
  2. **Authorize**: the QR code Evolution got from WhatsApp (a PNG data URL, polled every 3 seconds
     while pairing; "Code n of 6"), or an 8-character pairing code for the number typed in, or Meta's
     Embedded Signup window. It moves on when the provider says the connection is open.
  3. **Configure**: business name, how customers agree to order updates (required), marketing on or
     off, whether Shopify's text-message consent covers WhatsApp, sending hours and time zone, daily
     limit, per-customer daily limit, how long message texts are kept.
  4. **Test and activate**: the merchant's own number, verified with a 6-digit code sent over the
     connected WhatsApp (the code isn't kept in bizinsights' history; on a linked phone it is also in
     that phone's own chat, so there the check is that the number is right and on WhatsApp); then a
     test message, whose real status the page follows. The step is done only when WhatsApp reports
     it **sent** (not when Evolution accepted it). Then a completion screen.
     **The linked phone's own number is verified as it is entered, with no code**: a message from a
     number to itself arrives as no new message (WhatsApp files it in that phone's "Message yourself"
     chat, without a notification; in production on 2026-10-26 the code was reported sent and never
     delivered, so the merchant never saw it). The number is the store's by WhatsApp's own word, and
     a test to it reaches no one else. The page then says its tests are in that chat
     (`settings.testIsLinkedNumber`). Cloud API numbers still get a code.
- **Overview**: connection health as last reported (Check again), the automation state, sent today
  against the limit, what waits and why, 7- and 30-day counts from each message's own record, the
  latest messages.
- **Messages**: every message, filtered by status, direction, source, automation, campaign, dates
  and (with contact access) a customer's number; each one's status history; **Retry** for a failed
  one; **Send a message** (reason, consent attestation, text or template, optional image or PDF).
- **Automations**: trigger → conditions → template → recipient → delay and sending hours; ready-made
  presets; switching on lists every reason it can't; **test mode is on for every new automation**
  (it sends only to the verified test number until switched off); each automation's runs and why
  each one did or didn't send.
- **Templates**: write with variables, checked as you type (unknown variables, marketing without a
  way to stop, link shorteners); starters; on the Cloud API, submit to Meta and follow its review.
- **Campaigns**: an audience of customers who agreed to marketing (country, new or returning,
  ordered within / not for N days, minimum orders or spend), a live count for the chosen template,
  launch now or later **only with the exact count confirmed**, cancel, a delivery report.
- **Customers** (with "View contact information"): consent and its history, recording consent or an
  opt-out given another way, the do-not-message list.
- **Settings**: Step 3's settings, Pause all automation / Resume, Reconnect, Disconnect, and
  Evolution API's licence notice.

## Connecting

**QR or pairing code.** `POST …/whatsapp/connection` makes a new Evolution instance named `bi_` + 24
random hex characters, with a random token of its own and a random webhook key, both kept encrypted
(AES-GCM with the token keyring, bound to the store). The row is written **before** the instance is
created, so its first webhook always finds it. Then the webhook is set (the events bizinsights needs:
`CONNECTION_UPDATE`, `QRCODE_UPDATED`, `LOGOUT_INSTANCE`, `REMOVE_INSTANCE`, `MESSAGES_UPSERT`,
`MESSAGES_UPDATE`) and `connect` asks WhatsApp for the first code. A store already connected is
refused; one still pairing gets its current code; ten starts an hour at most per store. Pairing
gives up after 10 minutes, or when Evolution's six codes run out ("Get a new code").

The connection is **connected only** when Evolution's `CONNECTION_UPDATE` says `open`, or when
`connectionState` says so (the page's poll, Check again, the sweep). The linked number (masked) and
profile name come from Evolution. A close with status 401 or 403 means WhatsApp logged the device
out: the connection becomes **logged out**, an alert is raised ("Link WhatsApp again"), and messages
wait. Other closes are **reconnecting** (Baileys reconnects by itself). A connection down 48 hours
has its waiting messages and running campaigns cancelled, and says so.

**Reconnect** restarts the instance with its saved session (no new code). **Disconnect** logs the
phone out (WhatsApp removes the linked device), deletes the instance and its session at Evolution,
cancels what waits, pauses automations and keeps the history. Uninstalling the Shopify app
disconnects the same way; erasing a store (shop/redact) deletes its instance first.

**Cloud API.** The page opens Meta's Embedded Signup (v4) with bizinsights' Meta app and its
configuration. The server then: exchanges the code (it lives 30 seconds) for the business's token;
checks with Meta's token inspector that it was issued to bizinsights' app with
`whatsapp_business_management` and `whatsapp_business_messaging` for the account chosen; checks the
number belongs to that account; subscribes the account's webhooks to bizinsights' app; registers the
number when it isn't on the Cloud API yet (with a random 6-digit two-step verification PIN that
bizinsights doesn't keep: reconnecting the same number never asks for it, and moving the number
elsewhere later means resetting two-step verification in WhatsApp Manager); and makes an Evolution
`WHATSAPP-BUSINESS` instance
with the token. The token (60 days, the configuration's setting) is renewed by the sweep 30 days
before it ends. Meta's webhooks for these numbers (statuses, customers' messages, template reviews)
come to bizinsights directly, signed with the app secret.

**Connecting with the app's own token** (bizinsights' own team only, PR #281, kept when QR came back).
Until Meta approves bizinsights as a Tech Provider, Embedded Signup onboards no one, so App Review's
recordings can't be made through it. The workspaces in `WHATSAPP_TOKEN_CONNECT_WORKSPACES` (the
PixMagic workspace since 2026-10-29; empty: no one) see a second way under Meta's button in step 2,
**bizinsights team: connect with the app's own token**: the WhatsApp Business account ID, the phone
number ID and a token of the Insights app made in Meta's dashboard by someone with a role on it (a
system user's in Business settings, or API Setup's temporary one). `POST …/whatsapp/connection/cloud-token`
(`connectCloudApiWithToken`) refuses every other workspace (403 `token_connect_off`) before Meta is
asked, then runs the steps above from the token inspector on, unchanged: the token must be the app's,
with both permissions, for that account, and the number in it; then the webhooks, the registration
and the `WHATSAPP-BUSINESS` instance. The token is kept like Embedded Signup's, never shown or logged;
the audit row says `via: "app_token"`. A system user's token never expires (nothing to renew).

## Webhooks and security

**Evolution → bizinsights** (`POST /api/webhooks/whatsapp/evolution/:instance`). Evolution 2.3.7
**cannot sign a webhook's body**. What it can do, and bizinsights uses: each connection has a random
32-byte key (`jwt_key`), and every delivery carries an HS256 JWT made from it. A delivery is accepted
only when:

- the path names an existing connection's instance (random names; an unknown name, a wrong key, a
  missing or expired token all get the same 401, so nothing tells a caller which names exist);
- the JWT verifies with **that connection's** key (HS256 only, constant-time compare), claims
  `app: "evolution"` and `action: "webhook"`, is not expired (30 seconds' slack), not issued in the
  future, and lives at most an hour;
- the body is JSON within 256 KB, fits the envelope's schema, and names the same instance;
- the instance sends fewer than 1,200 a minute (then 429, which Evolution retries); per source
  address, 300 refused deliveries a minute before it is answered 429 without logging.

**The limitation, plainly:** the JWT authenticates the sender (only Evolution and bizinsights know
the key) but **does not bind the body**: someone who could read one delivery in flight could replay
its token with another body for up to 10 minutes. The compensating controls: Evolution posts over
HTTPS to bizinsights' public address (TLS end to end through CloudFront), so a token can't be read
in flight; the 10-minute expiry is the replay window; each message event's body is stored once by its
SHA-256 (a replay of the same body is a duplicate); every field is schema-checked and only the
instance's own events are applied; connection events can only move a connection to what the
provider then confirms (`connectionState` is asked again on any doubt); statuses only move forward.
Nothing in the code or the page claims a signature is verified.

**Meta → bizinsights** (`/api/webhooks/whatsapp`): `X-Hub-Signature-256` HMAC with bizinsights' Meta
app secret, checked before anything is read; the subscription handshake answers only the verify
token (constant-time).

**Tenancy and secrets.**

- Every merchant route is `/workspaces/:ws/stores/:storeId/whatsapp/…`: the workspace comes from the
  path and is checked against the signed-in member (`requireWorkspace`), and the store must belong
  to it. Queries run under row-level security for that workspace, and every row carries
  `workspace_id` and `store_id`. A browser-supplied id is never trusted alone.
- Instance names, instance tokens, webhook keys, the global key, QR codes (except to the person
  pairing, with `cache-control: no-store`), Meta tokens and full phone numbers never
  appear in an answer; numbers are masked, stored encrypted and matched by a keyed hash.
- The logger redacts `apikey`, `token`, `jwt_key`, `qrcode`, `base64`, `pairingCode`, `remoteJid`,
  `ownerJid`, `wuid`, `text`.

## Who may do what

| Action | Needs |
| --- | --- |
| See the page and its data | **View campaigns** (`marketing.campaigns`) |
| See how the connection stands (Settings → Integrations) | **View integration connection status** too: the overview answers that person with the connection alone |
| See customers' numbers, names, what was said; the Customers tab | **View contact information** as well |
| Change what customers receive: settings, test number, templates, automations, campaigns, sends, retries, consent records, the do-not-message list | The store's **owners and admins** (`stores:manage`), signed in themselves |
| Connect, reconnect, disconnect | **Manage integrations**, signed in themselves |

A shared dashboard link never administers WhatsApp, whatever it was given (only "Check again"
refreshes the connection's state), and neither does a workspace API key. Every route is in
`apps/api/test/routeAccess.test.ts`'s deny-by-default matrix.

## Consent

Two separate permissions, checked when a message is queued and **again when it is sent** (a customer
may have replied STOP in between):

- **Order updates** (transactional): only under the store's chosen basis: "Customers told at
  checkout" (everyone with a number, unless they reply STOP) or "Only customers who agreed" (opted in,
  replied START, or the merchant recorded it). Unset: nothing goes. A customer who wrote in the last
  24 hours may be answered.
- **Marketing**: marketing switched on in Settings **and** the customer's own marketing yes. Every
  marketing template must say how to stop.
- **From a Zap** (Zapier's "Send WhatsApp Template Message", [zapier.md](zapier.md#the-action-send-whatsapp-template-message)):
  the store's templates only (on Meta's Business Platform, ones Meta approved), source `zapier` (counted, kept to the sending hours, held by Pause all
  automation). A Zap that says the customer agreed records it (consent source `zapier`, with where they
  agreed); a number bizinsights knows only from a Zap needs that agreement even under "Customers told
  at checkout".

STOP (and "unsubscribe", "opt out"…) from **anyone** puts the number on the store's do-not-message
list by its keyed hash, and one confirmation is sent; START undoes it. The list is checked for
**every** message, the store's own numbers' too (tests, codes, stock alerts, automations in test
mode). A STOP is applied even when the first try to record it failed halfway (the retry finds the
message recorded and still opts the customer out). The linked phone may be
someone's personal WhatsApp, so other messages are recorded only from numbers that are already the
store's contacts, and dropped unread otherwise. Group chats, statuses and broadcasts are ignored.

## Sending

`queueMessage` makes one row per purpose (`idempotencyKey`, unique per store), so Shopify's retries,
a duplicate queue delivery or a double press send once. The `whatsapp` queue's `wapp_send` job claims
the row and checks, in order: the connection is up (else held, cancelled after 48 hours), the
automation or campaign still runs, automation isn't paused, consent, the sending hours (store time),
the store's daily limit, the customer's daily limit, and the pace (a linked phone: one at a time, 4–8
seconds apart; the Cloud API: 20 a second). Then one call to Evolution.

- Evolution's answer makes the message **accepted**; **sent**, **delivered** and **read** come only
  from WhatsApp's reports (`MESSAGES_UPDATE`, or Meta's statuses), recorded once each, and a message
  never moves backwards.
- **A number not on WhatsApp** is skipped and remembered for 30 days.
- **The service couldn't be reached at all** (the connection was refused, the name didn't resolve):
  nothing was sent, so it is retried after 30 s, 2 min, 10 min, 30 min, then failed with the reason.
- **A send that may have gone** (it timed out, the connection dropped after the request went out,
  or the service answered 5xx): it is marked failed ("uncertain") and **never retried
  automatically**; the merchant decides (Retry). A send that never finished (the worker died) is
  marked the same way by the sweep.
- Limits: daily per store (linked phone default 200, at most 1,000; Cloud API 1,000 / 100,000),
  per customer 3 a day (at most 10), 20 dashboard messages a minute, campaigns at most 250
  recipients on a linked phone.

## Automations

Triggers: an order is placed, paid, ships (once per order, the first parcel), is cancelled; a
checkout is left unfinished (timed from the customer's last change; the order cancels it); a customer
signs up (needs `read_customers`; bizinsights subscribes `customers/create` for the store when one
is switched on); a customer sends a message (with a cool-down). Shopify's webhooks arrive verified
(HMAC, dedupe, shop binding) and are applied after the analytics write.

Each automation runs **at most once per order, checkout, customer or message window** (a unique run
row), records why it didn't send when it didn't (conditions, consent, no phone, stale event over 48
hours, missing values, paused…), never triggers another, and starts in **test mode**. A trigger the
store can't receive (the App Store app before Shopify approves protected customer data, no
`read_customers`) is shown with why and can't be switched on.

## Data and retention

Tables (`wapp_*`): connections, settings, templates, contacts, consent events, suppressions,
messages, message events, webhook events, automations, automation runs, campaigns. Message texts are
kept for the store's retention (default 90 days, 7–365), then only the record; records 365 days and automation runs 90 days (what the privacy policy says);
a webhook event's body until it is applied (the row 7 days, a set-aside one 30); attachments until
sent. Evolution's own database
keeps sessions and, for Cloud API numbers, sent messages, pruned nightly after 7 days.
`customers/redact` erases a customer's WhatsApp data by hash (also in the old tables); a data request
exports it; `shop/redact` and erasing a store delete everything, the instance first. Rotating
`TOKEN_ENCRYPTION_KEYS` re-encrypts every `wapp_*` secret; the retired tables are only erased by
hash, never decrypted, so they aren't re-encrypted (a rollback past this release after a key
rotation would find their old ciphertext unreadable).

## Scaling

One task serves every session of its shard: Baileys sessions are stateful sockets, so two tasks can't
share an instance, and a deployment stops the old task before starting the new one (`minHealthyPercent
0`, `maxHealthyPercent 100`): a minute or two without WhatsApp, after which sessions resume from the
database without a new QR code. Send pacing, idempotency and retries live in bizinsights (SQS,
DynamoDB), not in Evolution, so the functions scale as usual.

More stores than one task holds (watch the `whatsapp-service-memory` alarm; roughly a few hundred
idle sessions per GB) → **a second shard**: another `WhatsappStack` service with
`DATABASE_CONNECTION_CLIENT_NAME=insights_b`, its own Cloud Map name and URL, `EVOLUTION_SHARD`
handled by `evolutionServer()` in `evolution.ts`, and new connections assigned to it. Existing
connections keep their shard (stored on the row).

## Settings and secrets

| Setting | Where | What |
| --- | --- | --- |
| `EVOLUTION_API_URL` | CDK (`app-stack.ts`), every function | Evolution's private address |
| `EVOLUTION_API_KEY` | Secrets Manager `insights/<env>/evolution-api`, generated by CloudFormation; read by name at cold start (`EVOLUTION_SECRET_ARN`) | The global key; the task gets it as `AUTHENTICATION_API_KEY` |
| `EVOLUTION_DB_USER`, `EVOLUTION_DB_PASSWORD` | Secrets Manager `insights/<env>/evolution-db`, generated; the cron and the task only | Evolution's own database role |
| `EVOLUTION_SHARD` | default `a` | The shard new connections go to |
| `EVOLUTION_WEBHOOK_URL` | optional | Where Evolution posts (default `API_URL`); local development only |
| `EVOLUTION_TIMEOUT_MS` | default 15000 | Per call to Evolution |
| `WHATSAPP_CONFIG_ID`, `WHATSAPP_APP_ID` (empty: `META_APP_ID`), `WHATSAPP_API_VERSION` | `apps/aws/src/settings.ts` | Cloud API: Embedded Signup's configuration on the Meta app "Insights" 971575545351940 (`2228218088074576`) |
| `WHATSAPP_TOKEN_CONNECT_WORKSPACES` | `apps/aws/src/settings.ts` | Workspaces that may also connect with a token of the app ([Connecting](#connecting)): PixMagic's `cmvarpfwa000002jngkgh5ji2`; empty: no one |
| `META_APP_SECRET` (or `WHATSAPP_APP_SECRET`), `WHATSAPP_WEBHOOK_VERIFY_TOKEN` | Secrets Manager `insights/<env>/app` | Cloud API: code exchange, webhook signatures, the handshake |

Nothing is pasted by a merchant (only bizinsights' own team pastes the app's token). The Deploy run's config check prints "WhatsApp service on, Cloud API
off (needs …)" while a Cloud API setting is missing; the page then offers only the QR way.

## Owner's steps (Cloud API)

The QR way needs nothing from the owner. The Cloud API needs bizinsights' Meta app to be a **Tech
Provider**, which only the owner can do in Meta's consoles (never automated: it has blocked the admin
account before). Already done on 2026-10-25: WhatsApp added to the app "Insights" (971575545351940),
Facebook Login for Business settings and domains, the Embedded Signup configuration
`2228218088074576` (60-day system-user token, WhatsApp Cloud API only), the webhook verify token.
Still the owner's:

1. **Business verification** of Zodiix Pty Ltd (Business settings → Security Center), for the
   portfolio the app is linked to (bizinsights.io): **Approved** (2026-10-29).
2. **App Review**: in the app dashboard, **Use cases → WhatsApp (Connect with customers through
   WhatsApp) → Customize → Become Tech Provider**, Advanced Access for `whatsapp_business_messaging`
   and `whatsapp_business_management` (and `public_profile` if not granted), with screencasts of a
   message sent from bizinsights arriving and a template created in bizinsights (a reviewer can't be
   sent an emailed sign-in code: see docs/ads-review-packs.md for the reviewer account). The
   recordings, with the app's test number:
   1. Meta dashboard → the Insights app → **WhatsApp → API Setup**: note the test number's **Phone
      number ID** and the **WhatsApp Business Account ID**; under "To", add your own WhatsApp number
      (a test number sends only to the numbers listed there).
   2. Business settings (portfolio Zodiix Pty Ltd) → **Users → System users**: add an admin system
      user, give it the Insights app and the test WhatsApp account (full control), **Generate token**
      for the Insights app with `whatsapp_business_management` and `whatsapp_business_messaging`,
      expiry "Never". (API Setup's temporary token works too, for 24 hours.)
   3. bizinsights → PixMagic → WhatsApp → **Setup → 1. Choose how to connect** → Official WhatsApp
      Business Platform → Continue → **bizinsights team: connect with the app's own token**: paste
      the two ids and the token, **Connect with this token**. Then step 3 (Configure).
   4. **Video 1** (`whatsapp_business_messaging`): from your phone, write to the test number; in
      bizinsights send a reply from the Messages tab (or step 4's test message to your own number),
      with WhatsApp on the phone (or WhatsApp Web) in view as it arrives.
   5. **Video 2** (`whatsapp_business_management`): in bizinsights' **Templates** tab create a
      template and submit it to Meta; show it in WhatsApp Manager → Message templates.
   6. In App Review → Permissions and features, add both permissions back to the request (they were
      taken out on 2026-10-26: docs/ads-review-packs.md), attach each video, and submit.
3. In **WhatsApp → Configuration**, the app's webhook: `https://bizinsights.io/api/webhooks/whatsapp`
   with the verify token, fields `messages` and `message_template_status_update`.

Until then Meta's window refuses anyone without a role on the app ("can't onboard customers right
now"); people with a role (admins, developers, testers) can connect their own business.

## Runbook

- **`whatsapp-service-down`** (no task running) or **`whatsapp-service-unreachable`** (the sweep
  couldn't reach it): ECS console → cluster `insights-production-whatsapp` → service
  `insights-production-evolution-a` → its stopped tasks' reason; logs in `/ecs/insights-production-evolution-a`.
  A task that can't reach its database fails its migration at start: check the `evolution` database
  and role (re-run: invoke `insights-production-cron` with `{"action":"evolution-db"}`). Messages
  wait meanwhile; stores see "WhatsApp messages are waiting".
- **A store logged out**: only its owner can link again (new QR code). Messages wait 48 hours.
- **Upgrading Evolution**: test the new tag locally (`docker compose --profile whatsapp up -d
  evolution`, then the API tests' calls by hand), pin its digest in `whatsapp-stack.ts` and
  `docker-compose.yml`, merge; the deploy replaces the task (a minute or two without WhatsApp).
- **Rotating the global key**: Secrets Manager → `insights/production/evolution-api` → rotate
  (or put a new value), then run Deploy to AWS: the task and functions read it at start. Instance
  tokens are bizinsights' own and stay valid.
- **Orphaned instances** (a crash between creating an instance and saving it): the sweep deletes
  `bi_` instances no connection holds.

## Deployment, migration and rollback

1. Migration `20261026120000_whatsapp_evolution` is additive: 12 new tables with RLS, no change to
   any existing table. It also marks resolved any open alert of the retired module (`wa_reconnect`,
   `wa_account`, `wa_webhook_failed`), which nothing can resolve any more.
2. The new stack `InsightsWhatsapp-production` deploys after the App stack: its custom resource
   invokes the cron's `evolution-db` action (role and database, idempotent) and fails the deploy if
   that fails; the ECS service has a circuit breaker with rollback. The secrets come with
   `InsightsData-production`.
3. Rollback: Deploy to AWS moves the functions back to their previous versions; they read only the
   old tables, which this release doesn't touch. The release of 2026-10-25 (Meta + Nango) keeps
   working where it was; no store had connected through it.
4. Nothing of the previous design is copied over: its tokens (at Nango) and secrets are not reused.
   A store that had connected there would connect again; none had.

## The old tables

Two earlier designs, both erase-only now (`whatsapp/legacy.ts`): customers/redact and shop/redact
erase there, and a data request counts what they hold. No store connected through the 2026-10-25
design, so it left no token at Nango, and erasing a store no longer asks Nango for one
([ads-setup.md](ads-setup.md#leaving-nango), step (c)).

- 2026-10-10 to 2026-10-24: `whatsapp_*`, `order_trackings`, `order_tracking_events`,
  `abandoned_checkouts`, `customer_reviews`.
- 2026-10-25: `wa_*` (Meta Cloud API, the token at Nango).

**Next step, a follow-up pull request** once this release is the one a failed deploy rolls back to:
drop both sets (after recording their row counts), remove their models and `legacy.ts`.

## Testing

```bash
pnpm --filter @app/shared test
```

```bash
pnpm --filter @app/core exec vitest run test/whatsappEvolution.test.ts
```

```bash
TEST_PG_PORT=5463 TEST_PG_PASSWORD=app TEST_DB=wapp_test pnpm --filter @app/api exec vitest run test/whatsapp.test.ts
```

```bash
TEST_PG_PORT=5463 TEST_PG_PASSWORD=app TEST_DB=wapp_test pnpm --filter @app/worker exec vitest run test/whatsapp.test.ts
```

Evolution is `test-support/evolutionFake.ts` (answers as 2.3.7 does, signs webhooks as it does);
nothing leaves the machine. The API test covers pairing with the provider's QR, connecting with the app's own token (only the listed workspaces;
Meta's Graph API answered in the test), "connected" only on
the provider's word, every way a webhook is refused, the test number and the test's real status,
sends (consent, idempotency, attachments, uncertain sends, retries), STOP and START from anyone,
automations from Shopify's events (once per order, test mode, stale and paused), campaigns (exact
count, greeted by name), tenant isolation, viewers, a shared link, secrets never in answers, and
disconnecting. The worker test covers the queue (duplicate deliveries, retries, events set aside) and
the sweep (uncertain sends, the reconcile, the service down, 48 hours down, retention). The CDK test
covers the stack (pinned image, private, secrets only by reference, the database's CA).

In a real browser, with `apps/web/e2e/evolution-stub.mjs` as Evolution:
`apps/web/e2e/whatsapp.spec.ts` (the four steps end to end).

With a real phone: run Evolution locally (`docker compose --profile whatsapp up -d evolution`, or the
deployed one), link a spare number, send to your own number only. Don't message real customers while
testing.
