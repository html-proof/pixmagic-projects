# Automations (one setup and one history over every messaging channel)

Marketing → **Automations** (`/automations`) is where a business connects a messaging channel,
picks what starts a message, writes it, and turns it on: four steps, the same for SMS and email.
After that it shows every automation of every channel with its real state and controls, one
message history with delivery statuses, the period's figures and an audit log.

It is a **hub over the channels' own engines**, not a third engine. Customer Messaging's SMS rules
([sms.md](sms.md)) and the email module's rules ([email.md](email.md)) are what run: the hub saves,
switches and reads *their* rows, through *their* functions, with every one of their checks. So a
store never gets two systems sending the same message, and an automation made in the hub also
shows (and can be edited) on the channel's own pages, and the other way round.

WhatsApp has its own pages (`/whatsapp`, [whatsapp.md](whatsapp.md)), and its module is being
rebuilt in another branch: the hub shows it as a card pointing there and doesn't read or change
its tables. It joins as a third adapter once that lands ([WhatsApp](#whatsapp)).

## Contents

1. [The four steps](#the-four-steps)
2. [Architecture](#architecture)
3. [What runs where: the brief's AWS services in this repository](#what-runs-where)
4. [How one message travels](#how-one-message-travels)
5. [Multi-tenant security](#multi-tenant-security)
6. [The channel adapters](#the-channel-adapters)
7. [Statuses](#statuses)
8. [API](#api)
9. [Capacity, scaling and cost](#capacity-scaling-and-cost)
10. [Setting up the providers](#setting-up-the-providers)
11. [Deploying, staging, rollback](#deploying-staging-rollback)
12. [Runbook](#runbook)
13. [Tests](#tests)
14. [Limits and what isn't done](#limits-and-what-isnt-done)

## The four steps

`/automations/new` (`?channel=&id=` edits one; `?trigger=` starts from a trigger):

1. **Connect.** A card per channel with its real connection state (the API's answer:
   `connected`, `needs_attention` with each problem and the page that fixes it, `not_connected`,
   `unavailable`, or `elsewhere` for WhatsApp), what the channel needs and what bizinsights may do
   with it. **SMS** connects here: bizinsights asks AWS about the platform's SMS account with the
   Lambda's own role (`DescribeAccountAttributes`); the merchant has no AWS account and gives no
   keys. *Test connection* asks again; *Disconnect* stops texting at once (waiting texts are
   cancelled). **Email** connects through the email module's own flow (Sign in with Google or
   Microsoft, OAuth with PKCE; or SMTP), opened from the card (`/settings/email/accounts?add=1`);
   each mailbox has *Test* (the provider is asked now) and *Disconnect* (tokens or password
   deleted, revoked where the provider allows, its automations switched off). No password or token
   ever reaches the browser.
2. **Trigger.** Every trigger, with its state for the chosen channel and the store: *Available*,
   *One step needed* (with the step), or *Not available* with the reason. The states come from
   what the store's Shopify app really receives (`APP_WEBHOOK_TOPICS`, per-store subscriptions
   Shopify confirmed, the last event of the trigger's topics). A store connected through the App
   Store app gets no order or checkout topics until Shopify approves protected customer data, so
   those triggers say so on both channels. *Check with Shopify* asks about the per-store topics now.

   | Trigger | SMS | Email |
   | --- | --- | --- |
   | Order placed | `order_created` | `order.created` |
   | Payment confirmed | `payment_completed` | `order.paid` |
   | Order shipped or fulfilled | `fulfillment_created` | `order.fulfilled` |
   | Order delivered | `delivery_confirmed` (carriers that report it) | not yet |
   | Abandoned checkout | `checkout_abandoned` (marketing) | `checkout.abandoned` (marketing) |
   | Customer signup | `customer_registered` (needs `read_customers`) | not yet (topic not subscribed) |
   | Order cancelled, Refund issued, Inactive customer, VIP customer | yes | cancelled only |
   | Scheduled message | a campaign, not an automation: links to SMS Campaigns | not built |
   | Customer replies (inbound) | not offered: one-way senders, only STOP is read | not offered: send-only mailboxes |
   | Event from another app | not offered | yes: the event API (`POST /api/v1/events`, `ek_live_` key) |

3. **Message.** SMS: ready-made messages, the editor with a button per detail the trigger can
   fill, the discount code where the text shows one, the delay, *Test mode* (records what it
   would send, sends nothing), who gets it in words, the checks as typed
   (`checkAutomationMessage`: opt-out link on marketing, no detail the trigger can't fill, length)
   and a phone showing the text with a sample customer. Email: the sender (verified addresses
   only), subject and text with a button per field of the event, the delay, how often per
   customer, who gets it, the checks as typed (`checkEmailMessage`: unknown or broken variables,
   empty parts) and the server's rendered preview with sample data (the business's name and
   address, the marketing footer). *Save and continue* saves: SMS as Customer Messaging's rule and
   its own template; email as the email module's rule and its own template (the text turned into
   simple HTML, `textToEmailHtml`). Nothing is sent by saving; a new automation starts off.
4. **Review and turn on.** What was saved, as the API has it; what still stops it reaching anyone
   (the channel's problems, test mode); the cost basis; a test to the team's own verified number
   (SMS, one `requestId` per press) or the member's own verified address (email), followed to its
   real outcome; and **Turn on** behind an "I understand" box. The API refuses activation without
   `confirm`, and for a trigger the channel doesn't receive for the store. Turning an SMS
   automation on approves its message and rule in the member's name (audited), as Customer
   Messaging's own builder does.

The list (`/automations`) shows each automation's channel, trigger, timing, message, status
(*Draft*, *Waiting for approval*, *Active*, *Paused*, *Disabled*: the rule's own, as stored), test
mode, saved changes not yet live, its last message and the last 30 days on the hub's status
scale, with the controls its status allows (`hubActionsFor`: Turn on, Pause, Resume, Disable for
SMS; Turn on, Pause, Resume for email), Edit, Messages and Delete, each behind a confirmation.

## Architecture

```
 Browser (/automations, /automations/new, /history, /audit)
   │ session cookie; the workspace in the path only selects
   ▼
 CloudFront + WAF ─► Lambda "api" ─► apps/api/src/routes/automations.ts
                                       hub(): requireWorkspace (any channel's read), store looked up in the workspace,
                                       hubPermissions(access) per channel, API keys refused, writes rate-limited
                                       ▼
                              packages/core/src/automations (no state of its own)
                               hub.ts ── connections, triggers, automations, merged history + cursor, stats, audit
                                ├─ sms.ts ───► packages/core/src/sms   (Customer Messaging: builder, rules, sends)
                                ├─ email.ts ─► packages/core/src/email (accounts, rules, engine, delivery)
                                └─ whatsapp.ts  card only (the WhatsApp pages own it)
                                       ▼
                              RDS PostgreSQL (RLS): sms_* and email_* tables (no new tables; two indexes)
 Shopify webhooks ─► SQS webhooks ─► Lambda "jobs" ─► smsOnShopifyEvent / emailOnShopifyEvent ─► rules
 Event API (POST /api/v1/events) ─────────────────────► email business events ─► rules
 SQS sync {kind:"sms"} / email {email_send} ─► Lambda "jobs" ─► AWS End User Messaging SMS / Gmail, Graph, SMTP
 AWS SMS events ─► SNS ─► SQS smsEvents ─► Lambda "jobs" ─► delivery status
 EventBridge Scheduler */15, nightly ─► Lambda "cron" ─► due and stuck sends, retention, opt-out sync
```

Code:

| Part | Where |
| --- | --- |
| Shared rules: channels, the trigger catalog and each channel's mapping, the one status scale, controls per status, email messages written in the hub | `packages/shared/src/automations.ts` (`@app/shared/automations`) |
| The adapters and the hub | `packages/core/src/automations/` (`@app/core/automations`: `common.ts`, `sms.ts`, `email.ts`, `whatsapp.ts`, `hub.ts`) |
| Manual retry and template test sends, shared by Settings → Email and the hub | `packages/core/src/email/actions.ts` |
| API | `apps/api/src/routes/automations.ts` |
| Pages | `apps/web/src/app/(app)/automations/`, `apps/web/src/components/automations/` |
| Menu switch | `AUTOMATIONS_HUB` in `apps/web/src/lib/features.ts` |
| Indexes | migration `20261025010000_automations_hub_indexes` |
| Alarm | `messaging-send-failures` in `infra/cdk/lib/app-stack.ts` |
| Dead-letter queue tool | `infra/cdk/scripts/dlq.mjs` |
| Load run | `apps/worker/load/automations.load.ts` |

## What runs where

The brief named AWS services; this is what each became in this repository, which already ran on
AWS with CDK (no second infrastructure framework was added).

| Brief | Here | Why |
| --- | --- | --- |
| API Gateway | CloudFront + WAF in front of the api Lambda's function URL (origin-verify header) | The app's existing, authenticated entry; a second API layer would add cost and a second auth path. |
| Lambda | `api`, `jobs`, `cron` functions | Existing. Sends and delivery events run in `jobs`. |
| SQS | `sync` (SMS sends, `kind: "sms"`), `email`, `smsEvents`, `webhooks`, with `dlq` | Existing, durable, retried; `maxReceiveCount` above the worker's own retries. |
| EventBridge | EventBridge Scheduler `*/15` and nightly → `cron` | Due and stuck sends, retention, AWS opt-out sync, delivery timeouts. |
| DynamoDB | The coordinator table: rate limits, locks, OAuth state, holds and circuits | Tenant settings, automations, idempotency records and message metadata stay in PostgreSQL with row-level security: one tenant-isolated store, joins with orders and customers, and idempotency by unique keys (`sms_message_jobs (store_id, dedupe_key)`, `email_messages (workspace_id, idempotency_key)`, one execution per rule and event) plus conditional updates (`scheduled → sending`, `queued → processing`). A second store of the same facts would need its own tenancy and could disagree with the first. |
| Secrets Manager / KMS | `insights/<env>/app` secret; tokens AES-256-GCM (`TOKEN_ENCRYPTION_KEYS`, rotatable); email credentials envelope-encrypted (`EMAIL_CREDENTIAL_KEYS`); RDS and SQS encrypted at rest | Existing ([security.md](security.md)). |
| Amazon SES | Merchant email goes through the merchant's own mailbox (Gmail API, Microsoft Graph, SMTP). Platform mail (sign-in codes, invitations) goes through Resend. | Mail from the merchant's own address and domain reputation, with no per-merchant domain setup at AWS. bizinsights' SES production access was denied on 2026-10-16, so SES can only reach verified addresses today. An SES adapter for merchants would need production access and a verified identity per merchant domain. |
| AWS End User Messaging Social (WhatsApp) | Not used: WhatsApp runs on Meta's WhatsApp Cloud API through the WhatsApp module (token added through Nango). | Linking a merchant's WhatsApp Business account to End User Messaging Social puts it inside bizinsights' AWS account (and Meta's conversation charges on bizinsights' AWS bill), which needs a per-merchant linking and billing story. To decide when the rebuilt WhatsApp module joins the hub. |
| AWS End User Messaging SMS | Used: the platform's account, `SendTextMessage` with a configuration set, events → SNS → SQS | [sms.md](sms.md). Sandbox until the owner's steps in "Going live". |
| CloudWatch | Logs (redacted), queue-age and DLQ alarms, error lines, SMS holds, and the new `messaging-send-failures` alarm | Alarms email the alarm topic's subscribers. |
| Nango | Meta Ads, AdSense, Google Ads and the WhatsApp token | Email sign-in stays direct OAuth (Google, Microsoft): no broker sees mail-sending tokens, and Nango's free plan has 10 connections. SMS has no merchant credentials at all. |

## How one message travels

The brief's flow, step by step, and where each step is:

1. **Validate and authenticate the event.** Shopify webhooks: HMAC (`X-Shopify-Hmac-Sha256`) checked
   with the app's secret before anything is stored (`routes/webhooks.ts`). The event API: a
   SHA-256-stored `ek_live_` key, scoped to one workspace. AWS SMS events: the SNS topic accepts
   publishes only from `sms-voice.amazonaws.com` in this account, and reaches only the queue.
2. **Resolve the tenant and active workflow.** The webhook's shop domain → the store → its
   workspace; the event key → its workspace. Only rules whose status is active (SMS) or enabled
   (email) run.
3. **Consent, suppression, conditions.** SMS: Shopify's SMS marketing consent for marketing, the
   merchant's chosen basis for order updates, the suppression list, opt-outs; email: marketing
   consent, the suppression list, the rule's conditions and frequency.
4. **Idempotent execution record.** SMS: one `sms_message_jobs` row per `rule:<id>:<subject>`
   (unique per store); email: one execution per rule and event, one message per execution key. A
   Shopify retry, a duplicate SQS delivery or two workers make one row.
5. **Enqueue.** Due within the queue's delay window → SQS; later ones are picked up by the sweep.
6. **Lambda worker.** `jobs` consumes the queue; a job that throws is retried with backoff.
7. **Rate limits and backoff.** SMS: the sender's parts per second, the account hold, a circuit
   after repeated AWS failures, quiet hours; email: the workspace's per-minute and daily limits and
   the provider's own (`PROVIDER_LIMITS`), held without spending attempts.
8. **Provider adapter.** `SmsProvider` (AWS, `apps/aws/src/smsProvider.ts`), `EmailProviderAdapter`
   (Gmail, Graph, SMTP).
9. **Provider id and status.** Stored on the row when the provider accepts.
10. **Signed delivery events.** SMS: AWS's `TEXT_*` events through the account's own SNS topic (only
    AWS can publish), matched by the job id in the message's context. Email: the connected
    mailboxes report no deliveries; immediate SMTP refusals are recorded as bounces.
11. **Bounded retries.** SMS: throttling and connection failures, 6 attempts, 30 s doubling to an
    hour, full jitter. Email: temporary failures up to the rule's `maxAttempts` (default 5) with
    exponential backoff. Neither re-sends a message whose outcome is uncertain (a timeout after the
    provider may have taken it): those become *Outcome unknown*.
12. **Dead-letter queue.** What the worker can't settle after SQS's `maxReceiveCount` lands in
    `insights-<env>-dlq` (alarm `dlq-not-empty`); see [Runbook](#runbook).
13. **Alerts and visible errors.** `raiseAlert` (the bell and the admins' email) for things a person
    must fix (budget reached, a sender refused, a mailbox needing sign-in); every message's
    reason in the history; CloudWatch alarms for the platform.

**Exactly once can't be promised across an external provider**: if a send times out after the
provider took it, bizinsights can't know whether it went. It records *Outcome unknown* and never
sends it again by itself; a person may (email), knowing the customer could get it twice.

## Multi-tenant security

- **Tenant from the session, never from the request.** The workspace in the path only selects; the
  member's membership is checked on every request (`requireWorkspace`; a non-member gets 404, a
  revoked or expired membership 403). The store comes from `?storeId=` and is looked up *inside*
  that workspace (`smsStore`): another workspace's store is 404. Every adapter query filters by
  workspace (and store for SMS); the email ones also run under PostgreSQL row-level security
  (`withTenant`).
- **Each channel's own permissions** (`hubPermissions`), the same as the channel's pages:

  | | SMS | Email |
  | --- | --- | --- |
  | See the channel and its automations | `marketing.campaigns` | `email:read` |
  | Create, change, turn on and off, test, delete | `stores:manage` (owners, admins) | `email:automate` (owners, admins) |
  | Connect, test, disconnect | `stores:manage` | `email:manage` |
  | Message history | `marketing.campaigns` | `email:activity` |
  | Numbers, addresses and texts in the history | `customers.contact` | `customers.contact` |
  | Audit log | `audit:read` | `audit:read` |

  The hub lets in anyone with either channel's read permission; each call then checks its own.
  A shared dashboard link is read-only (its session holds no manage permission). Knowing a URL
  grants nothing.
- **API keys are refused** (403): the hub changes what customers receive.
- **Secrets never reach the browser.** SMS has no merchant credentials; email tokens and passwords
  are encrypted at rest and write-only through the API.
- **Rate limits.** Writes per workspace (`automations`: 120 per 10 minutes), tests per store or
  workspace (`smsTest`, `emailTestSend`), previews per member, retries per workspace, plus the
  global per-IP limit and WAF.
- **Quotas.** SMS: the store's monthly budget (hard stop), message quota and caps, and the platform's
  monthly ceiling (`SMS_ACCOUNT_MONTHLY_LIMIT_USD`); email: the workspace's daily limit (≤
  `EMAIL_MAX_DAILY_LIMIT`) and per-minute limit; at most 200 email automations per workspace.
- **Logs** carry ids, codes and counts, never a phone number, address, message text or token. The
  audit view shows only small, non-identifying metadata (`safeMetadata`).
- **Credential rotation and revocation:** `TOKEN_ENCRYPTION_KEYS` and `EMAIL_CREDENTIAL_KEYS` rotate
  (RUNBOOK, `ops:reencrypt`); disconnecting a mailbox deletes its tokens and revokes Google's grant;
  disconnecting SMS stops sending at once.

## The channel adapters

Each adapter speaks for one engine and offers the same operations (`packages/core/src/automations`):

| Operation | SMS (`sms.ts`) | Email (`email.ts`) |
| --- | --- | --- |
| Connection state | setup row, sender, `sendingProblems` | accounts, senders, workspace settings |
| Connect / validate | `connectSms` (asks AWS) | the email module's OAuth / SMTP; `testEmailConnection` |
| Disconnect | `disconnectSms` | `disconnectEmailAccount` |
| Triggers for the store | `triggerCapabilities` (+ `verifyTriggerSubscriptions`) | the store's app topics and last events |
| List, save | builder `listAutomations`, `saveAutomation` | `listRules` + templates; `createTemplate`/`updateTemplate`, `createRule`/`updateRule` |
| Turn on, pause, resume, disable | `activateAutomation`, `pauseAutomation`, `ruleAction("disable")` | `setRuleEnabled` |
| Delete | `deleteAutomation` | `deleteRule` (its template archived) |
| Test | `testAutomation` (verified number) | `sendTemplateTest` (own verified address) |
| History, detail | `sms_message_jobs`, delivery events | `email_messages`, message events |
| Retry | never (see [Statuses](#statuses)) | `retryEmailMessage` (failed or unknown automation email) |
| Figures, usage | counts, AWS's billed prices, month spend vs budget | counts, today's sends vs the daily limit |

Sending, receiving delivery events, normalizing provider errors and statuses stay inside each
engine, behind its own provider interface (`SmsProvider`, `EmailProviderAdapter`): the hub never
calls a provider.

## Statuses

One scale for every channel (`HUB_STATUS_INFO`), never calling acceptance a delivery:

| Hub status | SMS rows | Email rows | Means |
| --- | --- | --- | --- |
| Queued | `scheduled` | `queued`, `deferred` | Waiting for its time, quiet hours or a limit. |
| Processing | `sending` | `processing` | Being handed to the provider. |
| Accepted by provider | `accepted`, `pending`, `carrier_accepted` | `accepted_by_provider` | The provider took it. Not proof of delivery. |
| Delivered | `delivered` | `delivered` | The provider's delivery report confirmed it. |
| Undelivered | `failed` after AWS accepted it | `bounced` | Accepted, then reported undeliverable. |
| Failed | `failed` before acceptance | `failed` | Couldn't be sent; the reason is shown. |
| Not sent | `opted_out`, `skipped`, `cancelled` | `suppressed`, `cancelled` | Deliberately not sent (consent, opt-out, rules, stopped). |
| Test only | `dry_run` | | Recorded, not sent (test mode, or SMS not live). |
| Outcome unknown | `unknown`, `uncertain` | `unknown` | Cut off after the provider may have taken it, or no final report. Never re-sent by itself. |

The delivery rate is delivered ÷ (delivered + undelivered), only where a provider reports
deliveries: SMS has AWS's reports (up to 72 hours later); email through a mailbox has none, so the
page says so instead of a number.

**Retry.** Email: a failed or unknown automation email can be sent again by an owner or admin
(confirmation warns that an unknown one may arrive twice); every check runs again. SMS: transient
AWS errors are retried automatically; a text that failed for another reason, was refused by a
carrier, or whose outcome is uncertain is never sent again by hand, so a customer can't be
texted twice; each says why.

## API

All under `/api/workspaces/{ws}/automations`, signed-in members only, `?storeId=` for the page's
store, errors `{ "error": code, "message": text }`.

| Method and path | What |
| --- | --- |
| `GET /` | Permissions, SMS mode, every channel's connection, every automation |
| `GET /connections` | The channels' connections |
| `POST /connections/sms/connect`, `/test`, `/disconnect` | SMS connection |
| `POST /connections/email/{accountId}/test`, `/disconnect` | A mailbox |
| `GET /triggers`, `POST /triggers/verify` | Each trigger's state per channel; ask Shopify now |
| `POST /preview/email` | Render an email with sample data |
| `GET /items/{channel}/{id}` | One automation |
| `POST /items/{channel}`, `PUT /items/{channel}/{id}` | Save (SMS: Customer Messaging's automation input; email: `hubEmailAutomationSchema`) |
| `POST /items/{channel}/{id}/activate`, `/pause`, `/resume`, `/disable` | Controls; `activate` and `resume` need `{ "confirm": true }` |
| `DELETE /items/{channel}/{id}` | Delete |
| `POST /items/{channel}/{id}/test` | Test (`testNumberId`, `requestId` for SMS) |
| `GET /messages` | History: `from`, `to` (the store's days), `channel`, `status` (hub statuses, comma separated), `automation=<channel>:<id>`, `cursor`, `limit` ≤ 100 |
| `GET /messages/{channel}/{id}`, `POST /messages/{channel}/{id}/retry` | Detail with timeline; retry |
| `GET /stats` | The period's counts per channel and day, rates, usage, billed SMS cost |
| `GET /audit` | Both channels' audit trails (`before`, `limit`) |

The history's cursor is opaque (`createdAt`, channel, id): pages never skip or repeat a message,
including ones created in the same millisecond on both channels.

## Capacity, scaling and cost

**Measured** (`pnpm --filter @app/worker load:automations`, 2026-10-25, the owner's laptop while the
CI runner was busy, local PostgreSQL 18, AWS and Gmail faked and answering at once): 5 stores × 60
orders, every webhook delivered twice concurrently, every event and send worked by two racing
workers, concurrency 12. Exactly once held: 300 texts, 300 email messages, no customer twice; 150
emails waited on Google Workspace's 30-a-minute limit per mailbox, as designed. Throughput of
bizinsights' own pipeline there: ~31 webhook deliveries/s into both engines, ~29 email rule
evaluations/s, ~79 texts/s and ~150 emails/s handed to the fakes. **These are not production
figures**: they exclude provider latency and limits and ran on one laptop.

What bounds production today, in order:

1. **Provider limits.** AWS SMS: parts per second per origination identity (`SMS_PARTS_PER_SECOND`,
   1 by default: a sender ID's MPS at AWS; numbers and short codes differ), the account's spending
   limit and sandbox. Email: each mailbox's own limits, as bizinsights paces them (`PROVIDER_LIMITS`: Gmail 20 a
   minute and 400 a day, Google Workspace 30 and 1,800, Outlook.com 15 and 250, Microsoft 365 30
   and 9,000, SMTP 30 and 1,000 unless set lower).
2. **The jobs function's queue concurrency** (`infra/cdk/lib/app-stack.ts`, `sources`): `sync`
   (SMS sends) 2 at a time, one message per invocation; `email` 2 at a time, 10 per batch. Sized
   for the database's connections; raise them together with the RDS instance.
3. **The database.** One `db.t4g.micro` instance (~80 connections). Every running job holds
   one connection.

Toward many tenants (the brief's one million registered users, few of whom send at once): the
queues absorb bursts (backpressure: messages wait, nothing is dropped, queue-age alarms at 30
minutes); per-tenant limits keep one store from starving others (SMS budgets and caps, email daily
and per-minute limits, the hub's write limit); history queries use `(store_id, created_at)`,
`(workspace_id, created_at)` and the new per-automation indexes. Before claiming a throughput:
raise queue concurrency and the database size together, then run the load run against a staging
stack with the providers' real quotas.

**Retention:** SMS texts 30 days after their outcome (history and costs 400 days, events 180); email
event data 35 days, events and executions 90, messages 180 ([sms.md](sms.md), [email.md](email.md)).

**Cost of the hub itself:** no new tables, queues or functions; one CloudWatch metric filter and
alarm (~US$0.40 a month). Per message, unchanged: SMS is AWS's price per part for the country plus
carrier fees (shown from AWS's events, billed to bizinsights' AWS account, counted against each
store's budget); email costs nothing per message through the merchant's own mailbox; WhatsApp
conversations are Meta's, billed on the merchant's Meta account.

## Setting up the providers

- **SMS:** [sms.md](sms.md), "Setting it up" and "Going live": `SMS_MODE=live` ships since
  2026-10-25; production access and spending limit at AWS and a registered and tagged sender per
  merchant are the owner's steps. Until AWS grants production access only verified numbers
  receive texts, and the dashboard says the account is still being verified.
- **Email:** [email.md](email.md) sections 5–7: Google (Gmail API, `gmail.send`, verification) and
  Microsoft (Entra app, `Mail.Send`) OAuth clients (`EMAIL_GOOGLE_CLIENT_ID`/`SECRET`,
  `EMAIL_MICROSOFT_CLIENT_ID`/`SECRET`); SMTP needs nothing from the platform.
- **WhatsApp:** [whatsapp.md](whatsapp.md) and [nango.md](nango.md).
- **Event API (external apps):** Settings → Email → Settings → event API keys; the sender's system
  posts to `/api/v1/events` ([email.md](email.md), "API").

The hub adds no environment variables.

## Deploying, staging, rollback

- **Production:** merge to `main`; CI, then **Deploy to AWS** (CDK, migrations, smoke tests,
  automatic rollback of the Lambda aliases on failure) ([aws-deployment.md](aws-deployment.md)).
  The migration only adds two indexes.
- **Staging:** `cdk deploy --all -c env=staging` builds a separate set of stacks
  (`infra/cdk/lib/config.ts`) for a rehearsal or a load run with real quotas; it isn't kept
  running (cost).
- **Rollback:** `node infra/cdk/scripts/rollback.mjs` moves the aliases back (the previous release
  runs on the new schema: indexes only). To take the hub out of the menus without a rollback, set
  `AUTOMATIONS_HUB = false` (`apps/web/src/lib/features.ts`) and merge; automations keep running
  in their channels. To stop sending: SMS `SMS_MODE=off`/`sandbox` or a store's *Send texts* off;
  email: Settings → Email → pause sending, or switch the automation off.

## Runbook

- **Alarm `messaging-send-failures`** (25+ refusals in 5 minutes, twice): open the jobs log group,
  search `sms send refused` (its `type` and `reason` are AWS's) or `email send failed`
  (`errorCode`); the hub's history filtered by *Failed* shows which store and automation. Common
  causes: an SMS sender not found or not allowed (the store's sender is held, the merchant is
  alerted), AWS throttling (retries absorb it), a mailbox needing sign-in (alert
  `email_account_reauth`).
- **Queue age alarms** (`queue-sync-age`, `queue-email-age`, `queue-smsEvents-age`): the jobs function
  is failing or saturated; check its errors and throttles first.
- **Dead-letter queue** (`dlq-not-empty`): look first, then redrive once the cause is fixed. Every job
  is safe to run twice (claims and unique keys):

  ```bash
  node infra/cdk/scripts/dlq.mjs
  ```

  ```bash
  node infra/cdk/scripts/dlq.mjs --redrive --yes
  ```

  ```bash
  node infra/cdk/scripts/dlq.mjs --status
  ```

- **A merchant says a message didn't arrive:** Automations → Message history, their automation and
  dates. *Accepted by provider* with no report: SMS reports can take up to 72 hours (then
  *Outcome unknown*); email can't be followed further. *Not sent* says why (consent, opt-out, quiet
  hours, a cap). *Undelivered*: the carrier or mail server refused that number or address.
- **Health:** `GET /api/readyz`, `GET /api/version` (what is live).

## Tests

```bash
pnpm --filter @app/shared exec vitest run test/automations.test.ts
```

```bash
TEST_PG_PORT=<port> TEST_DB=hub_test pnpm --filter @app/api exec vitest run test/automations.test.ts
```

```bash
TEST_PG_PORT=<port> TEST_DB=load_test LOAD_STORES=5 LOAD_ORDERS=60 LOAD_CONCURRENCY=12 pnpm --filter @app/worker load:automations
```

E2E: `apps/web/e2e/automations.spec.ts` (the four steps for SMS against the local server's stand-in
for AWS, a test text to delivery, turning on, pause and resume, the history and audit pages).

| Suite | Covers |
| --- | --- |
| Shared unit (10) | The trigger catalog maps only real channel triggers and covers every Shopify email event; every channel status lands on the hub's scale; accepted is never delivered; carrier refusals vs send failures; the delivery rate only from reports; controls per status; text → HTML keeps placeholders and escapes the rest; email message checks; the email automation schema |
| API integration (13) | Tenancy (another workspace's automations, messages and stores are 404 everywhere, nothing changes); per-channel permissions, API keys refused, audit for owners; connections (SMS connect, test, disconnect, AWS down is a failure; email state and test); triggers per channel and store (App Store stores); SMS and email four steps through their engines' rows; controls only as the status allows (confirm required, no double activation); email test to oneself; one Shopify order delivered twice → one text and one email; the merged history's order and paging across channels with same-instant ties; status filters; contact details hidden without permission; email retry once, SMS never; figures per channel and day; the audit trail |
| Load run | Exactly once under duplicate webhooks and racing workers, and throughput of the pipeline |
| E2E (2) | The four steps in the browser; pause and resume from the list |

The channels' own suites cover the engines (consent, quiet hours, retries, delivery events,
signatures, OAuth, SMTP): [sms.md](sms.md#testing), [email.md](email.md#13-tests).

## WhatsApp

The WhatsApp module is being rebuilt in its own branch (workflows, templates, Nango connect). When
it lands, `packages/core/src/automations/whatsapp.ts` becomes an adapter like the other two over
its public functions (connection, workflows, message history), and its triggers and statuses get
their columns in `@app/shared/automations`. Meta's rules then apply in step 3: only approved
templates outside the 24-hour customer service window.

## Limits and what isn't done

- WhatsApp isn't built in the hub yet (above).
- Inbound messages can't start an automation on SMS or email (one-way senders, send-only mailboxes).
- Email: no delivery reports or late bounces (send-only access), no customer-signup or refund
  triggers, delays are absolute (no "9 am the customer's time"), conditions are edited on Settings
  → Email's own builder (the hub keeps them when it saves).
- SMS automations from the hub use Customer Messaging's defaults for quiet hours, caps and conditions;
  their Advanced settings are on Customer Messaging's page.
- The figures' days are the store's time zone (UTC without a store); the email part belongs to the
  whole workspace, the SMS part to the page's store.
- Not verified against live providers from this branch: real AWS SMS sends (the platform is in
  sandbox), real Gmail, Microsoft and SMTP sends, throughput at the providers' real quotas.
