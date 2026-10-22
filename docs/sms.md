# Customer Messaging (SMS through AWS End User Messaging)

Marketing → **Customer Messaging** in the dashboard: order updates, abandoned-checkout reminders,
win-back and VIP texts and merchant-written campaigns, sent by SMS through **AWS End User Messaging
SMS** (the `pinpoint-sms-voice-v2` API) from bizinsights' own AWS account (605411278365,
ap-southeast-2).

Nothing reaches a customer until all of these are true, and none is true by default:

1. The platform is **live**: `SMS_MODE=live` (apps/aws/src/settings.ts). It ships as `sandbox`.
2. The store has a **sender** that AWS confirms exists and is tagged for its workspace, a monthly
   **budget** above 0, and **sending switched on** by an owner or admin.
3. The **template** has an approved version, and the **rule** or **campaign** was approved.
4. The customer may receive it: for marketing, **Shopify's SMS marketing consent** (never a phone
   number or a past purchase); for order updates, the **basis the merchant chose**; and no opt-out.
5. Marketing only: `SMS_MARKETING_ENABLED` is on for the platform **and** the store turned
   marketing texts on. Rules start in **dry-run** mode.

## Where things live

| Part | Code |
| --- | --- |
| Pure rules: encoding and parts, variables and how untrusted values are cleaned, template checks, DLT matching, triggers, consent, statuses, AWS errors, retries, budgets, quiet hours, rules, segments, campaigns, attribution | `packages/shared/src/sms.ts` (`@app/shared/sms`) |
| The provider interface, and a fake AWS for tests and the local server | `packages/core/src/sms/provider.ts` |
| Contacts, consent history, suppression list, the opt-out link | `packages/core/src/sms/contacts.ts` |
| Templates and versions; senders, AWS checks, test numbers | `templates.ts`, `senders.ts` |
| The queue and the send path | `messages.ts` |
| AWS's delivery events, costs, budget alerts | `delivery.ts` |
| Rules, segments and campaigns | `automations.ts`, `campaigns.ts` |
| Shopify events, consent webhooks | `events.ts` |
| The 15-minute sweep, retention | `sweep.ts` |
| Figures (overview, analytics, billing); GDPR | `analytics.ts`, `privacy.ts` |
| AWS adapter (signed calls to sms-voice) | `apps/aws/src/smsProvider.ts` |
| API | `apps/api/src/routes/sms.ts`, `smsOps.ts`, `smsActivity.ts`, `smsPublic.ts` |
| Worker | `apps/worker/src/handlers/integrations.ts` (`runSmsJob`, `runSmsEvent`), `webhooks.ts`, `index.ts` (sweep) |
| Infrastructure | `infra/cdk/lib/app-stack.ts` (configuration set, events topic and queue, IAM, alarms) |
| Dashboard | `apps/web/src/app/(app)/messaging/*`, `apps/web/src/components/messaging/*`; the customers' `/stop` page |
| Tests | `packages/shared/test/sms.test.ts`, `apps/worker/test/sms.test.ts`, `apps/api/test/sms.test.ts`, `apps/aws/test/smsProvider.test.ts`, `infra/cdk/test/stacks.test.ts` |

The AWS calls are signed JSON requests (aws4fetch), the same API the AWS SDK calls, as the rest of
`apps/aws` does for SQS, SES and DynamoDB: the SDK would add hundreds of milliseconds to every cold
start.

## How a text gets sent

```
Shopify webhook ─► worker: webhooks.ts ─► core/sms/events.ts ─► contact + consent ─► rules (runSmsRules)
campaign (sweep) ─────────────────────────────────────────────► one row per recipient
                                     sms_message_jobs row (dedupe key) ─► sync queue {kind:"sms"} ─► sendSmsJob
                                     every check again ─► claim (scheduled → sending) ─► SendTextMessage
AWS: configuration set ─► SNS topic (only sms-voice may publish) ─► smsEvents queue ─► applySmsEvent
```

1. **Scheduling.** A row with a dedupe key: `rule:<ruleId>:<subject>` (`order:<id>`, `ful:<id>`,
   `cart:<token>`…), `campaign:<id>:<contact>`, `test:…`. A Shopify retry, a duplicate queue
   delivery or two events for the same order make one row. The same template reaches a customer
   once per subject even when two rules match.
2. **Queue.** Due within 12 hours → the `sync` queue (`kind: "sms"`); the `*/15` sweep catches the rest.
3. **Checks, again, right before sending:** platform mode; sender verified, sending on, not held;
   template version approved; contact still there, consent and suppression now; marketing switches;
   rule still active; campaign not paused or cancelled; checkout not completed; order not
   cancelled; quiet hours (the rule's, in the customer's zone where their country has one, else the
   store's; a text pushed more than 36 hours is dropped); 1 per day/2 per week caps and the rule's
   own cap; destination country allowed; India's DLT template; the text renders with every value
   (no broken links, no missing names) and is at most 6 parts; the store's monthly budget (hard
   stop) and quota; the platform's monthly ceiling (`SMS_ACCOUNT_MONTHLY_LIMIT_USD`); an account
   hold or an open circuit; the sender's parts per second.
4. **Claim, then send.** `scheduled → sending` in one statement, so only one worker sends a row.
   `SendTextMessage` carries the configuration set, `MaxPrice` (`SMS_MAX_PRICE_PER_PART_USD` × parts),
   a TTL (24 h order updates, 4 h marketing), `Context {job, ws}` and India's DLT ids.
5. **AWS's answer** (`classifySendError`):
   - `ThrottlingException`, or a request that never left (DNS, refused): retried with exponential
     backoff and full jitter (30 s doubling, capped at an hour), 6 attempts.
   - `ConflictException … OPTED_OUT`: `opted_out`, and the number goes on the suppression list.
   - `ServiceQuotaExceededException … SPEND_LIMIT`: every text held for an hour, critical alert.
   - `ResourceNotFoundException` / `AccessDeniedException`: the store's sender held, alert.
   - Validation failures: `failed` with the reason (an invalid number is suppressed until lifted).
   - **A 500, a timeout, a cut connection: `uncertain`. Never re-sent on its own**: AWS may have
     the text, and a duplicate is worse than a gap. Five of these in 5 minutes open the circuit
     for 10 minutes (texts wait). A row stuck in `sending` for 10 minutes becomes `uncertain`.
6. **Delivery.** AWS accepting a text is not a delivery. Its events (`TEXT_*`, up to 72 hours later)
   move the row: `pending` → `delivered` (handset receipt) or `carrier_accepted` (final
   `SUCCESSFUL` where the network gives no receipt) or `failed`/`unknown`. A status only moves
   forward; a final one is replaced only by a later final one; an event matches its row by the job
   id in its context, so it also settles an `uncertain` row. Each event is stored once
   (message id, type, time): a replayed event changes nothing. No final event after 74 hours →
   `unknown`.
7. **Cost.** The price AWS reports with the event (`totalMessagePrice` + `totalCarrierFee`, US$) is
   the message's cost, recorded once in `sms_cost_records`. Until then the estimate (the account's
   average billed price for that country, else `SMS_PRICE_TABLE`, else the maximum price) counts
   against the budget. 50/80/100% of the store's budget raise alerts, once each per month.

## Consent and opt-outs

- **Marketing** (abandoned checkouts, win-back, VIP, campaigns): only contacts whose Shopify SMS
  marketing state is `subscribed` (the customer's `sms_marketing_consent`, or the buyer ticking
  the checkout's SMS box), and not suppressed. A phone number on an order is never consent.
- **Order updates**: the merchant chooses in Sender configuration, and until then nothing is sent:
  `checkout_notice` (they attest their checkout tells customers who leave a mobile number that
  updates come by SMS; who chose it and when is recorded) or `sms_consent` (only subscribed customers).
- Every consent change is kept in `sms_consent_records` with its source and evidence (webhook
  topic and id, Shopify's `consent_collected_from` and `consent_updated_at`, the team member).
  An older signal never overwrites a newer one.
- **Opt-outs apply at once** and win over anything Shopify says later: the `{{opt_out_url}}` link
  every marketing template must carry (`/stop?c=<code>`: the page confirms before anything changes,
  so a link preview can't opt anyone out; only the code's SHA-256 is stored), AWS's opt-out list
  (STOP replies to two-way numbers, synced every 15 minutes), `ConflictException` on a send, a
  carrier's INVALID, Shopify's consent webhook, and opt-outs the team records. The team can lift
  only what it added (or an invalid number), never a customer's own opt-out.
- Withdrawn consent cancels the contact's waiting marketing texts; a checkout that turns into an
  order cancels its reminders.

## Abandoned checkouts

`checkouts/create` / `checkouts/update` with a mobile number create an `sms_checkouts` row
(anonymous checkouts are never stored). Each recovery rule is one stage, sent once per checkout,
due its WAIT after the customer's last change (moved back while they keep editing). Right before
sending: the checkout is still open (its order, by `checkout_token`, or `completed_at` closes it),
consent still holds, the rule is still active. Each order is credited at most once.

## Shopify events and what they need

Checked against Admin API 2026-10.

| Trigger | Source | Notes |
| --- | --- | --- |
| Order created | `orders/create` (or the first order topic seen) | |
| Payment completed | `orders/paid` | For card payments it comes with the order: choose one of the two |
| Order shipped | a new fulfillment on `orders/fulfilled`, `orders/partially_fulfilled`, `orders/updated` | `fulfillments/*` need `read_fulfillments`, not requested |
| Delivery confirmed | a fulfillment whose `shipment_status` is `delivered` | Only where the carrier reports delivery to Shopify |
| Order cancelled | `orders/cancelled` | Also cancels the order's other waiting texts |
| Refund issued | `refunds/create` | `{{order_total}}` is the refunded amount |
| Checkout abandoned | `checkouts/create`, `checkouts/update` | Marketing |
| Inactive customer / VIP | daily, from the orders seen per contact (`sms_contact_orders`) | Marketing; once per inactive stretch / once |
| Customer birthday | **not available**: Shopify customers have no birthday field | Needs a birthday metafield and `read_customers` |

Consent changes outside an order: `customers_marketing_consent/update`, subscribed per store
(`ensureSmsWebhooks`) once it grants `read_customers`.

**Protected customer data.** On a live store Shopify withholds names and phone numbers from
webhooks until the app is approved for **protected customer data, Level 2** (name, phone). Until
then every rule records "No mobile number on the order". Development stores are exempt, which is
how to test. Customer webhooks also need protected customer data approval.

## Data, retention, privacy

All 17 tables carry `workspace_id` (the tenant) and `store_id` under the `tenant_isolation` RLS
policy; the API reads through `withTenant` and filters by workspace and store. Consent history,
delivery events and the audit trail are append-only for tenant requests (migration
`20261022170000_sms_customer_messaging`, `infra/postgres/init.sql`).

- Numbers are AES-256-GCM encrypted (AAD `sms:<storeId>:<kind>`), found by a keyed hash
  (`HMAC(CUSTOMER_HASH_KEY, "sms:<store>:<e164>")`), shown masked. Logs never carry a number or a text.
- A message's values are cleared once it is sent; its text 30 days after its outcome.
- Delivery events 180 days; checkouts 90 (links dropped at 30); message history and costs 400 days.
- `customers/redact` deletes the customer's contacts, consent history, orders seen, checkouts and
  texts (a suppression stays, as a hash, so their opt-out keeps working); `shop/redact` and a
  removed store erase every table (`purgeStoreData`); `customers/data_request` exports their
  numbers, consent history and texts.

## Setting it up

### What exists in AWS after the deploy

The App stack creates the configuration set **`insights-production-sms`** (event destination
`TEXT_ALL` → SNS topic `insights-production-sms-events`, whose policy lets only
`sms-voice.amazonaws.com` from this account publish → SQS `insights-production-smsEvents`, raw
delivery → the jobs function), the IAM grants (jobs: `SendTextMessage` on this account's SMS
resources; api: sending tests, describing, verifying test numbers; cron: describing and
`DescribeOptedOutNumbers`), and alarms (`queue-smsEvents-age`, `sms-hold-jobs`, `sms-hold-api`).
Nothing else is provisioned automatically: the steps below are the platform owner's.

### 1. Get the account out of the SMS sandbox (owner, AWS console, ap-southeast-2)

A new account can text only up to 10 verified numbers, and its SMS spending limit is **US$1 a
month**. Both are lifted by AWS on request:

1. AWS End User Messaging SMS console → **Account settings** → *Request production access*
   (describe the use: order updates and opted-in marketing for Shopify stores; opt-in through
   Shopify's checkout; opt-out by link and STOP; volumes). Repeat per region used (ap-south-1 for India).
2. AWS Support → Service quotas → **SMS monthly spending limit** increase. Then set
   `SMS_ACCOUNT_MONTHLY_LIMIT_USD` (bizinsights' own ceiling) below it.

Check: Customer Messaging → Sender configuration shows "AWS account: production" and the limit.

### 2. Register a sender (owner, per merchant or one shared)

Per destination country (AWS user guide, checked 2026-10-22):

- **Australia**: alphanumeric sender IDs must be in **ACMA's SMS Sender ID Register** (enforced since
  1 July 2026). Console → Registrations → Create registration → *AU sender ID*; it applies only
  once the registration shows **Complete** (anything else counts as unregistered: "Unverified" or
  blocked). Alternatively a dedicated long code (US$22/month, about 3 weeks to provision).
- **United States**: a 10DLC campaign, a verified toll-free number (US$2/month + verification) or a short code.
- **India**: DLT registration (Principal Entity ID, header/sender ID, each template's id), and
  sending from **ap-south-1**. Each Indian template must match its DLT text exactly; the merchant
  needs their own DLT registration.
- **New Zealand, Canada**: long code or toll-free (no sender IDs).

Then **tag the identity** so only its store can use it:

```bash
aws pinpoint-sms-voice-v2 tag-resource --region ap-southeast-2 --resource-arn <identity ARN> --tags Key=bizinsights:workspace,Value=<workspace id>
```

A platform-wide shared sender is tagged `bizinsights:shared=true` and named in `SMS_SHARED_SENDER`.

### 3. The store (merchant, Customer Messaging)

Sender configuration: the identity's ARN or id, countries, a monthly budget, the basis for order
updates → **Check with AWS** (must say *verified*) → add and verify a test number → write templates,
submit, approve → send yourself a test → create a rule (it starts in dry-run: read Message History)
→ submit, approve → turn **Send texts** on. Marketing: turn on *Send marketing texts* (needs the
platform switch too).

### 4. Going live (owner, after 1 and 2)

1. In `apps/aws/src/settings.ts` set `SMS_MODE` to `"live"` (and, for campaigns and other marketing,
   `SMS_MARKETING_ENABLED` to `"1"`), merge to `main`: the Deploy workflow ships it.
2. One controlled real text: a test number of your own (Send SMS → Send a test), then one rule out
   of dry-run for a development store with your own number as the customer. Check Message History
   shows *Delivered* and its AWS events, and SMS billing shows AWS's price.

## Settings

| Setting | Default | What |
| --- | --- | --- |
| `SMS_MODE` | `off` (production: `sandbox`) | off / sandbox (test texts only) / live |
| `SMS_MARKETING_ENABLED` | empty | Marketing texts at all |
| `SMS_ACCOUNT_MONTHLY_LIMIT_USD` | 20 | bizinsights' monthly ceiling for all stores together |
| `SMS_MAX_PRICE_PER_PART_USD` | 0.25 | AWS refuses a dearer route (`MaxPrice`) |
| `SMS_PRICE_TABLE` | `{}` | Per-part prices by country from AWS's price list (CSV on the pricing page), for estimates before AWS has billed any |
| `SMS_PARTS_PER_SECOND` | 1 | A sender's MPS at AWS; campaigns are paced to it |
| `SMS_CAMPAIGN_MAX_RECIPIENTS` | 2000 | Largest campaign |
| `SMS_SHARED_SENDER` | empty | A shared, tagged origination identity |
| `SMS_DEFAULT_REGION` | `AWS_REGION` | SMS region unless a sender's countries need another |
| `SMS_CONFIGURATION_SET` | set by the App stack | Name, or JSON per region |

## Costs

Fixed, added by this module: the SNS topic, SQS queue and Lambda time are within the free tiers at
these volumes; 3 CloudWatch alarms and 2 log metrics are about **US$1 a month**. Per-store sender
fees are AWS's (for example an Australian long code US$22/month; US toll-free US$2/month; 10DLC
registration fees on AWS's pricing page). Per text: AWS's price per message part for the
destination plus any carrier fee, as AWS reports it on each delivery event; per-country prices are
in the CSV on https://aws.amazon.com/end-user-messaging/pricing/ and change regularly, so
bizinsights never shows a price it hasn't billed or been given (`SMS_PRICE_TABLE`).

Monthly estimate = Σ over countries (texts × parts per text × price per part) + sender fees + ~US$1.

## Limits and what isn't done

- **Not live yet**: production ships `SMS_MODE=sandbox`. The account's sandbox status, spending
  limit and sender registration are the owner's steps above; no customer is texted before them.
- Phone numbers on live stores need Shopify's protected customer data approval (Level 2).
- India needs a configuration set in ap-south-1 for delivery events (none is created: Indian texts
  are sent, and stay "Accepted by AWS" until they become "Unknown" after 74 hours) and the merchant's DLT registration.
- Inbound replies other than STOP aren't read (no two-way flow); STOP reaches AWS's opt-out list.
- Birthday texts need a birthday source Shopify doesn't have.
- "Delivery confirmed" only where carriers report delivery to Shopify.
- Attribution is "an order followed a text", last touch, within the window: not incremental revenue.
- Registrations (AU sender IDs, 10DLC, DLT) are done in the AWS console, not from the dashboard.

## Testing

```bash
pnpm --filter @app/shared exec vitest run test/sms.test.ts
```

```bash
TEST_PG_PORT=5463 TEST_DB=sms_test pnpm --filter @app/worker exec vitest run test/sms.test.ts
```

```bash
TEST_PG_PORT=5463 TEST_DB=sms_test pnpm --filter @app/api exec vitest run test/sms.test.ts
```

```bash
pnpm --filter @app/aws exec vitest run test/smsProvider.test.ts
```

AWS is faked in every test; nothing is texted. The local server (`pnpm --filter @app/aws dev`)
uses the same fake with a shared sender `LOCALTEST` and reports each text delivered a moment later.

## Rollback

- Stop all texting at once: `SMS_MODE=off` (or `sandbox`) in settings.ts and merge; or a store's
  owner turns *Send texts* off (waiting texts are cancelled, not kept).
- Code: the Deploy workflow rolls the Lambda aliases back on a failed migration or smoke test
  (`infra/cdk/scripts/rollback.mjs`); the migration only adds tables, so the previous release runs
  on the new schema unchanged.
- Infrastructure: the configuration set, topic and queue are removed by deploying a release
  without them (nothing else depends on them).
