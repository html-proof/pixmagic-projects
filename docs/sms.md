# Customer Messaging (SMS through AWS End User Messaging)

Marketing → **Customer Messaging** in the dashboard: order updates, abandoned-checkout reminders,
win-back and VIP texts and merchant-written campaigns, sent by SMS through **AWS End User Messaging
SMS** (the `pinpoint-sms-voice-v2` API) from bizinsights' own AWS account (605411278365,
ap-southeast-2).

Nothing reaches a customer until all of these are true:

1. The platform is **live**: `SMS_MODE=live` (apps/aws/src/settings.ts), since 2026-10-25. AWS
   still decides who can receive: while bizinsights' AWS account is in the **SMS sandbox** (it was
   on 2026-10-25: `ACCOUNT_TIER` SANDBOX, spending limit US$1 a month, no sender IDs, numbers or
   registrations), only numbers verified with AWS get texts, and the dashboard says so ("Your SMS
   account is still being verified"). The owner's steps to leave it are in "Going live" below.
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
| Send SMS: chosen customers, now or scheduled, followed and cancelled | `sends.ts`; rules in `@app/shared/sms` (`smsSendSchema`, `sendValueProblems`, `SMS_SEND_MAX_RECIPIENTS`, `smsStage`); API `apps/api/src/routes/smsSends.ts`; page `/messaging/send` (`components/messaging/SendSms.tsx`) |
| Shopify events, consent webhooks | `events.ts` |
| The 15-minute sweep, retention | `sweep.ts` |
| Figures (overview, analytics, billing); GDPR | `analytics.ts`, `privacy.ts` |
| Set up SMS (the five-step setup) and SMS Settings | `setup.ts`; rules in `@app/shared/sms` (`checkSenderName`, `SENDER_ID_SUPPORT`, `SETUP_AUTOMATIONS`); API `apps/api/src/routes/smsSetup.ts`; pages `/messaging/setup`, `/messaging/settings` (`components/messaging/Setup.tsx`, `SmsSettings.tsx`, `PhonePreview.tsx`) |
| The Automations hub (one setup and history over SMS and email, [automations.md](automations.md)) | `packages/core/src/automations/sms.ts` calls the builder below; nothing else |
| Automations (Create SMS Automation: when, who, message, test, review) | `builder.ts`, `readiness.ts`; rules in `@app/shared/sms` (`AUTOMATION_TRIGGER_CARDS`, `TRIGGER_SOURCES`, `AUTOMATION_STARTERS`, `smsAutomationSchema`, `smsAudienceSchema`, `segmentConditions`, `checkAutomationMessage`, `SKIP_LABEL`); each app's toml topics in core `apps.ts` (`APP_WEBHOOK_TOPICS`); API `apps/api/src/routes/smsAutomations.ts`; pages `/messaging`, `/messaging/automations`, `/messaging/automations/edit`, `/messaging/history`, `/messaging/settings` (`components/messaging/Overview.tsx`, `Automations.tsx`, `AutomationBuilder.tsx`, `AutomationAudience.tsx`, `AutomationReview.tsx`, `AutomationUi.tsx`, `History.tsx`, `SmsSettings.tsx`) |
| AWS adapter (signed calls to sms-voice) | `apps/aws/src/smsProvider.ts` |
| API | `apps/api/src/routes/sms.ts`, `smsOps.ts`, `smsActivity.ts`, `smsPublic.ts`, `smsSends.ts` |
| Worker | `apps/worker/src/handlers/integrations.ts` (`runSmsJob`, `runSmsEvent`), `webhooks.ts`, `index.ts` (sweep) |
| Infrastructure | `infra/cdk/lib/app-stack.ts` (configuration set, events topic and queue, IAM, alarms) |
| Dashboard | `apps/web/src/app/(app)/messaging/*`, `apps/web/src/components/messaging/*`; the customers' `/stop` page |
| Tests | `packages/shared/test/sms.test.ts`, `apps/worker/test/sms.test.ts`, `apps/api/test/sms.test.ts`, `apps/api/test/smsSetup.test.ts`, `apps/api/test/smsAutomations.test.ts`, `apps/api/test/smsReadiness.test.ts` (production readiness, below), `apps/web/e2e/messaging.spec.ts`, `apps/aws/test/smsProvider.test.ts`, `infra/cdk/test/stacks.test.ts` |

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
5. **AWS's answer** (`classifySendError`; AWS's `Reason` is read before the exception's name, since
   one reason comes under several: the SMS sandbox refuses an unverified number with
   `ConflictException DESTINATION_PHONE_NUMBER_NOT_VERIFIED`, which a DryRun from this account
   returned on 2026-10-25):
   - `ThrottlingException`, or a request that never left (DNS, refused): retried with exponential
     backoff and full jitter (30 s doubling, capped at an hour), 6 attempts.
   - `… OPTED_OUT`: `opted_out`, and the number goes on the suppression list.
   - `… NOT_VERIFIED` (the sandbox): `failed`, "Until your SMS account is verified, texts only reach
     approved test recipients". `DESTINATION_COUNTRY_BLOCKED`: `country_blocked`; a sender ID not
     registered for the country: `sender_unregistered`; an identity that can't text the country:
     `sender_not_for_country`. None of these suppresses the customer.
   - `ServiceQuotaExceededException … SPEND_LIMIT`: every text held for an hour, critical alert.
   - `ResourceNotFoundException` / `AccessDeniedException`: the store's sender held, alert.
   - Other validation failures: `failed` with the reason; only a number AWS can't use
     (`INVALID_PHONE_NUMBER`, `CANNOT_PARSE`…) is suppressed until lifted.
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
   What the merchant reads (`smsStage`, `SMS_STAGE_LABEL`): **Queued** (scheduled), **Sending**,
   **Sent** (AWS has it, or the carrier, without a receipt yet), **Delivered**, and for failures who
   said no: **Rejected** (AWS refused the send, or the carrier blocked it or called it spam),
   **Undeliverable** (the carrier couldn't reach the phone: unreachable, not a mobile, expired),
   **Failed** (bizinsights gave up: the provider stayed busy); also *Unknown outcome*, *Opted out*,
   *Not sent* (a check stopped it, with the reason), *Cancelled* and *Practice run*.
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
| Customer registered | `customers/create`, subscribed per store once it grants `read_customers` | Marketing (a welcome text): only customers subscribed to SMS marketing; once per customer |
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
- Key rotation covers every value kept encrypted (contacts' numbers and first names, checkouts'
  recovery links, texts' values and bodies, test numbers): `ops:reencrypt` seals them again with the
  active key, under the same AAD (`sms/keys.ts`; docs/RUNBOOK.md, "Rotate the token encryption key").
- A message's values are cleared once it is sent; its text 30 days after its outcome.
- Delivery events 180 days; checkouts 90 (links dropped at 30); message history and costs 400 days.
- `customers/redact` deletes the customer's contacts, consent history, orders seen, checkouts and
  texts (a suppression stays, as a hash, so their opt-out keeps working); `shop/redact` and a
  removed store erase every table (`purgeStoreData`); `customers/data_request` exports their
  numbers, consent history and texts.

## Set up SMS (for merchants)

Customer Messaging → **Set up SMS** (`/messaging/setup`, the menu's *Setup guide* under Advanced) is the one-time setup: five steps next to a
phone showing the text as a customer gets it, with **Save draft** and **Continue later** (the step
and everything typed are kept in `sms_setups`). It drives the same rows as the advanced pages
(sender, templates, rules, test texts), with the same checks; nothing is sent another way.
**Settings** (`/messaging/settings`) shows the result in plain words: the SMS setup (sender,
messaging verification, customer messaging permissions, monthly messaging limit, account), the
Automatic SMS switch and the test recipients; under **Advanced** (owners and admins) links to the
specialist pages, the provider configuration (the connection, with Disconnect and Reconnect) and the
activity log (`GET …/sms/audit`).

1. **Connect.** The API asks AWS End User Messaging SMS about the platform's account with the
   function's role (`DescribeAccountAttributes`, `DescribeSpendLimits`). The merchant has no AWS
   account and gives no keys; nothing secret reaches the browser. *Connected* means AWS answered;
   *Connection failed* says why (`platform_off`: `SMS_MODE=off`; `aws_unreachable`). Disconnect
   turns sending off (waiting texts are cancelled) and keeps everything else.
2. **Sender name.** The business name (`{{business_name}}`), the country most customers are in and
   the sender name, checked as typed and again on the server (`checkSenderName`: AWS's sender ID
   rules, 3 to 11 of A-Z a-z 0-9 and inner hyphens, a letter, no generic names; France: no
   hyphens). What customers in that country will see comes from `SENDER_ID_SUPPORT` (AWS's
   "Supported countries" table, checked 2026-10-23): `registered` (AU, GB, IE, SG, IN…: only a
   registered name shows), `dynamic` (DE, FR, NL, HK…: no registration), `none` (US, CA, NZ, MY,
   ZA…: a number). **Register / Request sender name** records the request and emails
   `SMS_SENDER_REQUESTS_TO` once (below); where names aren't shown it asks for a number instead.
   **Check status** asks AWS: the name is *Approved* only when AWS has that sender ID in that
   country, tagged `bizinsights:workspace=<id>`, with its registration `COMPLETE` (or none
   required), and then it becomes the store's sender (verified like Sender Configuration's).
   Other states: *Requested* (AWS has nothing yet), *Pending approval* (tagged, registration not
   complete), *Needs changes* (registration sent back or closed), *Not available* (another
   workspace's). India is refused here: it needs the merchant's own DLT registration (Sender
   Configuration). Where `SMS_SHARED_SENDER` is set, *Use bizinsights' shared sender for now*.
3. **Message.** The order confirmation, with buttons for the details (customer name, business
   name, order number, order status, tracking link where the event has one, order total,
   product); *Appointment date* is shown switched off (Shopify records no appointments). Aliases
   (`{{order_id}}`, `{{business}}`…) are named and fixed (`fixVariableAliases`). Saved as a draft
   template, approved when the merchant turns it on in step 5.
4. **Test SMS.** A verified test number (AWS texts a code first, so tests reach only a phone the
   member holds), then **Send Test SMS**: one `requestId` per press, so a retried request returns
   the text already sent; the same message to the same number again within 30 seconds is refused
   (`test_repeat`). The page follows the text to its outcome: *Accepted by AWS* is said to be not
   yet a delivery; *Delivered* only on AWS's `DELIVERED` event; failures come with a suggested fix.
5. **Automatic SMS.** The monthly spending limit and the basis for order updates (the same fields
   as Sender Configuration), then the order updates: *New order confirmed*, *Payment confirmation*,
   *Order shipped*, *Order delivered* (each its own message; *Appointment reminder* shown as not
   available). Turning one on asks for confirmation (the API refuses it without `confirm`) and
   then approves its template and rule in the member's name (audited, `selfApproved`) and starts
   it with `dryRun: false`; off pauses it. **Enable Automatic SMS** is the store's sending switch
   (Sender Configuration's *Send texts*): on needs the connection, an approved sender, a basis and
   a budget above 0, and asks first. With `SMS_MODE=sandbox` the dialogs say no customer is texted.

New variables: `{{business_name}}` (the setup's business name, else the store's name, filled at
send time) and `{{order_status}}` (`ORDER_STATUS_WORD`: confirmed, paid, shipped, delivered,
cancelled, refunded, filled by `runSmsRules`).

## Send SMS (for merchants)

Customer Messaging → **Send SMS** (`/messaging/send`, in the main menu and on the overview): the
merchant texts customers they choose, in four steps, without meeting AWS. Owners and admins only
(`stores:manage`), with "View contact information" (the list shows masked numbers).

1. **Choose customers.** What they're sending first: a *service message* (an order or an
   appointment; it reaches customers under the store's basis for order updates) or a *marketing
   message* (only customers subscribed to SMS marketing in Shopify, with an opt-out link). Then up
   to 200 customers (`SMS_SEND_MAX_RECIPIENTS`; a bigger audience is a campaign), found by first
   name or the number's last digits (`GET …/sms/sends/customers`). Each says whether they can get
   that kind now, and why not ("The customer opted out", "Sending to this country isn't switched
   on", "The number's country couldn't be told"…).
2. **Choose message.** An approved saved message of that kind, or a new one written here (the
   variables as buttons: `{{customer_name}}`, `{{business_name}}`, `{{date}}`, and for one customer
   the order's details, typed in; with several customers only what is the same for everyone,
   `sendValueProblems`). Characters and SMS parts as it is typed, with a warning when it takes more
   than one part.
3. **Preview** (`POST …/sms/sends/preview`, changes nothing): the text as the first customer will
   read it (their first name, the date where they are), its parts, who won't get it and why, how
   many fall in quiet hours at that time, the estimated cost and the month's limit, and what stops
   the send altogether (`blockers`: the store's setup on a live platform, marketing switched off,
   the SMS account still in AWS's sandbox).
4. **Send or schedule** (`POST …/sms/sends`): now, or at a time up to 60 days ahead, after a
   confirmation. `requestId` (one per press) makes a repeated request return the send already made;
   a second request with the same id while the first is being made waits behind a lock and is
   refused (`send_in_progress`). Refused up front, with nothing recorded: the setup or the account
   (`setup_incomplete`, `account_sandbox`, `platform_off`, `marketing_platform_off`), a message that
   doesn't pass its checks (`message_invalid`), nobody who can get it (`no_recipients`), more than
   is left of the month's limit at the longest the text can be (`over_budget`). A message written
   here is saved as a template and approved in the sender's name (audited).

A send is a batch of ordinary messages (purpose `manual`, dedupe key `send:<id>:<contact>`,
subject `send:<id>`): customers who can't get it are recorded as *Not sent* with the reason; the
others are queued, spread to the sender's pace (`SMS_PARTS_PER_SECOND`), and go through every
check of the send path again right before they go. The page follows the send
(`GET …/sms/sends/:id`, every few seconds while texts wait or travel): each customer's stage, from
Queued to Delivered. **Cancel** (`POST …/sms/sends/:id/cancel`) stops every text that hasn't gone
(audited); one being handed to AWS at that moment still goes. *Your sends* lists the last 60
days'. Rate limits: 10 sends per store per 10 minutes (`smsSend`), the preview as the template
editor's. **Send yourself a test** (a test recipient, with sample details) is under the wizard.

## Automations (for merchants)

Since 2026-10-25 Customer Messaging is built around one button. A merchant goes from the overview to
an active automation without meeting the provider: **Create SMS Automation** → when → who → the
message → a test → review and activate. The one-time setup (sender, verification, monthly limit,
customer permissions, test recipients) is asked for once, under Settings and the Advanced pages, and
an automation's review lists only what is still missing, each with a **Fix this** link.

The menu is **Overview**, **Automations**, **Message History**, **Settings**; under **Advanced**
(owners and admins; members who can't change anything see only Campaigns and Delivery analytics,
under **More**): Setup guide (Set up SMS), SMS Sender (Sender Configuration), Customer permissions
(Consent & Suppression), Messaging costs (Billing), Message templates, Campaigns, Customer
segments, Send one SMS, Delivery analytics. The words the merchant reads: *SMS sender*, *Messaging
verification*, *Monthly messaging limit*, *Test recipient*, *Customer messaging permissions*,
*Activate automation*; "AWS" appears only on the advanced pages and under a message's *Technical
details*.

### How the pieces depend on each other

```
Pages (apps/web/src/components/messaging/*: Overview, Automations, AutomationBuilder,
       AutomationAudience, AutomationReview, History, SmsSettings)
  → API (apps/api/src/routes/sms.ts overview + readiness, smsAutomations.ts: list, triggers,
         audience, audience/customers, :id/checks, save, activate, pause, duplicate, delete, test;
         smsActivity.ts: messages with automation and customer names)
  → messaging service (packages/core/src/sms):
      readiness.ts  messagingReadiness (the overview's status), validateAutomation (the review's
                    checks), accountStatus (the provider's account tier, cached 10 minutes)
      builder.ts    save / activate / pause / duplicate / delete / test, sendingProblems,
                    setupBlockers, audienceProblem, estimateAudience
      automations.ts  the rule engine: runSmsRules → conditions → audiencePasses → consent → dedupe
      messages.ts   scheduleSms → the send path's checks → the provider → classifySendError
      delivery.ts   the provider's delivery events → statuses, cost, budget alerts
  → provider (apps/aws/src/smsProvider.ts: AWS End User Messaging SMS, signed calls)
  → database (sms_automation_rules, sms_templates, sms_segments, sms_contacts, sms_message_jobs…)
```

An event runs: Shopify webhook (or the daily sweep) → `runSmsRules` → the rule's conditions → its
audience → consent and opt-outs (`mayReceive`) → duplicate checks → `scheduleSms` (recorded in
Message History, whatever happens next) → at send time the send path checks again: the number, the
customer's consent and opt-outs, the store's sending switch, the sender, the country, quiet hours,
caps, the monthly limit and the platform's ceiling → the provider → its answer (`classifySendError`)
→ delivery events. A text that can't legally or technically go is never sent; its reason is in
Message History in words.

### Errors in plain words

The provider's exception and reason are logged server-side (`sms send refused`, with the job id)
and kept as the message's `errorCode`; the merchant reads `skipLabel(code)` (`SKIP_LABEL` in
`@app/shared/sms`: every reason the module records and every code `classifySendError` returns) and,
where they can fix it, `skipFix(code)`. A code nobody listed reads "The SMS provider didn't accept
this text", never the code. API refusals are `SmsError`s written for the merchant
(`setup_incomplete`: "SMS sending isn't ready yet. Your SMS sender still needs to be verified.").

### The overview

**Status** is `messagingReadiness`: *Ready*; *Setup required* (one of the store's steps is missing,
or the account is still being verified: "Your SMS account is still being verified. Test messages
can be sent to approved numbers until verification is complete." with *View setup requirements*);
*Action required* (something temporary: sending held after a provider problem, this month's limit
used up). Then **Create SMS Automation**, View Automations, Message History and Settings; active and
paused automations; messages sent this month, the delivery rate, and messages against the cap
(`monthlyMessageQuota`) or the monthly limit; the store's automations; and only the setup items still
missing (SMS sender, Messaging verification, Customer messaging permissions, Monthly messaging limit,
Automatic SMS; Test recipient is optional), each with **Fix this**.

### Create SMS Automation (`/messaging/automations/edit`)

`?id=` opens one on its review (or `?step=` on another step, as the checks' *Fix this* links do);
`?trigger=` starts a new one from a trigger. Five steps beside a phone showing the text with a sample
customer (Sarah, order #1042), updated as it is typed:

1. **When.** Trigger cards: Order placed, Order paid, Order shipped or fulfilled, Order delivered,
   Abandoned checkout, Customer registered, Customer joins a segment, Scheduled message, Custom event;
   under *More triggers* Order cancelled, Refund issued, Inactive customer, VIP customer, Customer
   birthday. Each says whether Shopify sends its event for this store (`triggerCapabilities`: the
   app's toml topics `APP_WEBHOOK_TOPICS`, per-store subscriptions such as `customers/create` with
   `read_customers` and Shopify's acceptance, kept 26 hours in `sms:webhooks:<storeId>`, and the last
   event received). *Scheduled message* is a campaign (a one-off text to a segment, approved and
   scheduled with its count confirmed): the card links to Campaigns. *Custom event* and *Customer
   birthday* can't be chosen (no event of the merchant's own; no birthday on Shopify customers).
   *Customer joins a segment* (`customer_segment`, marketing) asks for the segment here. Then: send
   immediately or after a delay (up to 30 days), the name, and under *More timing options* quiet
   hours, the customer's time zone, the per-customer cap (`automationCapDefaults`) and a practice run.
2. **Who.** The automation's audience (`smsAudienceSchema`): *the customer the event is about*
   (default), *Customer segment* (only if that customer is in a saved segment, judged on the event's
   facts when it happens: `segmentConditions`; refused when the segment compares what the trigger's
   event lacks, `segmentMisfit`), or *Specific customers* (up to 50, chosen by first name or the
   number's last digits; needs "View contact information"). **Recipients** is the API's count
   (`estimateAudience`): "1 customer per event", or those of the segment or choice who could get this
   kind of text today. Optional conditions (*Only when…*) as before. A segment used by an automation
   can't be deleted.
3. **Message.** Ready-made messages (`AUTOMATION_STARTERS`), the editor, **Personalize** (the
   details the trigger's event has, grouped Customer / Order / Store / Links / Offer:
   `SMS_VARIABLE_GROUP`), *Characters* and *Estimated SMS segments* with a warning when it takes more
   than one, and `checkAutomationMessage`. Other tools' names (`{{customer.first_name}}`,
   `{{order.number}}`…) are aliases: named in the error and fixed with *Fix them*. *Save and
   continue* saves it (the message as the automation's own template, the settings as its rule).
4. **Test.** The saved message to an approved test recipient (a code is texted to a new number
   first: in the provider's sandbox only such numbers receive texts), one `requestId` per press,
   followed to the delivery event: "✓ Test message sent" or "⚠ Test message could not be sent" with
   the reason in words. Can be skipped.
5. **Review and activate.** The automation as a flow (WHEN → WHO → SEND → MESSAGE → TIMING →
   STATUS), each block opening its step; its name, estimated recipients and status; and the API's
   checks (`GET …/automations/:id/checks`, `validateAutomation`, read-only: it never asks Shopify,
   activating does): trigger, recipients, message,
   personal details, SMS sender, sender can send, messaging verification, monthly limit, customer
   messaging permissions, opt-outs, mobile numbers, provider connection, account can send. Failing
   ones first with *Fix this*; passing ones folded. **Activate Automation** asks first, then
   `activateAutomation` needs `confirm`, a trigger Shopify sends, a valid message and audience, and,
   **with `SMS_MODE=live`, the store's own setup done** (`setupBlockers`: no sender, not verified, no
   countries, Automatic SMS off, a limit of 0, no basis for order updates; for marketing, marketing
   off). In test mode it may be activated (its texts are recorded, not sent), and the review says
   so. A hold or a used-up month doesn't block it. Activation approves the template's and the
   rule's latest versions in the member's name (audited `automation_activated`,
   `automation_republished`). *Pause* cancels its waiting texts; edits of a running automation wait
   under *Changes not live* until *Put changes live*.

The list (`/messaging/automations`) shows each automation as a card: what starts it and when, who
gets it, its message, ✓ Active or ● Paused, the texts it sent in 30 days, its last text, a switch,
Edit, and a menu: **Duplicate** (a draft named "… — Copy", "… — Copy 2"…, with a template of its own,
opened on its review to change and activate), **View history** (Message History for it, `?ruleId=`),
**Advanced settings** (the WHEN / IF / WAIT / THEN editor: priority, version history, "Test with
recent orders"), **Delete** (its waiting texts cancelled, its texts kept in history, its template
archived unless something else uses it). Search and filters appear past four automations.

**Message History** reads Customer (first name, with "View contact information"), Message,
Automation (by its name now), Status, Sent, Delivery; a message's details add the recipient, the
trigger, the failure reason in words and the message id, and under **Technical details** (owners and
admins) the provider's status, error code and message id, the template version, parts, cost and
delivery reports. Only the builder changes who an automation texts: the advanced rule editor
shows the audience and sends it back unchanged, the rules routes drop any audience they're sent
(`withoutAudience` in `smsOps.ts`), and a client that sends none (the hub's editor) keeps the
automation's own (`saveAutomation`, `updateRule`).

**Customer joins a segment** runs in the daily sweep (`customerRules`): each subscribed customer in
the segment who passes the automation's conditions (both in the query, `segmentWhere` +
`contactConditionsWhere`), once per automation, including those already in it when it is switched on.
Contacts are read in pages of 500 with the ones it already recorded left out, so the day's 500 reach
new members and no query grows with history. A practice run (the rule's, or the platform's test mode)
records under its own key (`segment:<contact>:practice`), so the real text still goes once the platform
is live. A deleted segment stops it. Like VIP texts, "once" lasts as long as the history (400 days).
The same daily run now holds each inactive and VIP automation to its own threshold, so a second VIP
automation never texts a customer who only reached the first one's.

### Sender names from Set up SMS (platform owner)

A request emails `SMS_SENDER_REQUESTS_TO` (`apps/aws/src/settings.ts`) with the store, the
workspace id, who asked, and the commands. bizinsights doesn't create sender IDs or submit
registrations from a merchant's click: the AWS account and its registrations are the platform's,
and a name is someone's brand, so check it is theirs first. Then, in ap-southeast-2:

```bash
aws pinpoint-sms-voice-v2 request-sender-id --region ap-southeast-2 --sender-id <NAME> --iso-country-code <CC> --message-types TRANSACTIONAL --tags Key=bizinsights:workspace,Value=<workspace id>
```

Where the country requires registration (AU: ACMA's register; GB, IE, SG…): AWS console →
Registrations → the country's sender ID registration with the merchant's business details, and
associate the sender ID. For a country without sender names, provision a number that can text it
(US: toll-free with verification, or 10DLC) and tag it the same way. Nothing else is needed in
bizinsights: the merchant's *Check status* finds it by its tag.

## Production readiness audit (2026-10-25)

The owner asked for the test-mode SMS system to become a production one. What the audit of this
module found, and what changed:

| Checked | Found | Now |
| --- | --- | --- |
| Test-only code, mock APIs | The fake AWS (`fakeSmsProvider`) is wired only in tests and the local server, which refuses `NODE_ENV=production`; the Lambdas get `awsSmsProvider` (apps/aws/src/index.ts) | Unchanged: dev and production stay apart |
| Fake delivery statuses | Only the local server's stand-in reports "delivered"; production statuses come from AWS's events | Unchanged |
| Test mode in production | `SMS_MODE=sandbox`: automations and campaigns recorded dry runs | `SMS_MODE=live`, `SMS_MARKETING_ENABLED=1` |
| Hardcoded numbers, credentials | None (placeholders in inputs only); AWS calls signed with the function role, no keys anywhere | Unchanged |
| Client-side AWS credentials | None: the browser calls the API only | Unchanged |
| Authentication, authorization | Every route behind a session and a permission (routeAccess.test.ts) | Send SMS routes added and classified |
| Consent | Shopify's SMS marketing consent, the merchant's basis for order updates, suppression list, opt-out link, AWS opt-out list | Unchanged; checked again by the readiness suite |
| Rate limits | Per-store limits on tests, one-off texts, previews, estimates | `smsSend` added; 200 customers per send |
| Delivery tracking | AWS's events through SNS and SQS, statuses only forward | The merchant's words: Queued, Sending, Sent, Delivered, Rejected, Undeliverable, Failed (`smsStage`) |
| Error handling | **Bug:** AWS's sandbox refusal (`ConflictException DESTINATION_PHONE_NUMBER_NOT_VERIFIED`, seen with a DryRun) read as "the provider didn't accept this text"; `DESTINATION_COUNTRY_BLOCKED` as an invalid number, which suppressed the customer | Reason read first (`classifySendError`); new reasons in words |
| Idempotency | Automations, campaigns and tests keyed; one-off texts were not | `requestId` on one-off texts and on sends |
| Country validation | E.164 with known calling codes, the sender's countries, India's DLT | Unknown countries said as such before sending |
| One-click and bulk sending | One approved template to one customer, under Advanced | Send SMS: up to 200 chosen customers, a saved or new message, preview, now or scheduled, followed and cancelled |
| Templates | No `{{date}}` | `{{date}}` (the day it goes, where the customer is); `{{order_id}}`, `{{company_name}}` are named and fixed as before |

Not code: the AWS account itself ("Going live" below).

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

### 4. Going live

The platform side is done: `SMS_MODE=live` and `SMS_MARKETING_ENABLED=1` ship in
`apps/aws/src/settings.ts` since 2026-10-25. What AWS showed for account 605411278365 in
ap-southeast-2 that day (`aws pinpoint-sms-voice-v2 describe-account-attributes`,
`describe-spend-limits`, `describe-sender-ids`, `describe-phone-numbers`, `describe-registrations`):

| | 2026-10-25 | Needed |
| --- | --- | --- |
| Account tier | SANDBOX | PRODUCTION (step 1) |
| Text spending limit | US$1 a month (max US$1) | Raised by AWS Support (step 1) |
| Sender IDs, phone numbers, pools | none | One per merchant, or one shared (step 2) |
| Registrations | none | AU sender ID registration (ACMA), per sender (step 2) |
| Verified destination numbers | none | Only for testing while in the sandbox |
| Configuration set `insights-production-sms` | exists, `TEXT_ALL` → SNS | done |

Until steps 1 and 2 are done no customer can receive a text, whatever the dashboard does: every
send to a customer comes back from AWS as "Until your SMS account is verified…", and Send SMS
refuses up front while AWS reports the sandbox.

The production access request (AWS console → End User Messaging SMS → Account settings → *Request
production access*, ap-southeast-2) asks for the use case. A draft of the answers, for the owner to
check before sending:

- Company: Zodiix Pty Ltd (ACN 613 577 834), Australia; the product is bizinsights (https://bizinsights.io).
- Use: transactional order updates (order confirmed, paid, shipped, delivered) and opted-in
  marketing texts that Shopify merchants send to their own customers from the bizinsights dashboard.
- Opt-in: Shopify's own SMS marketing consent (the checkout's SMS box or the customer's account);
  order updates only to customers the merchant's checkout tells that updates come by text. A
  phone number on an order is never taken as marketing consent.
- Opt-out: every marketing text carries a link (`https://bizinsights.io/stop?c=…`) that stops them
  at once; AWS's opt-out list (STOP replies on two-way numbers) is synced every 15 minutes; an
  opt-out wins over anything Shopify reports later.
- Volumes: the owner's estimate (for example below 1,000 texts a month to start); per-store monthly limits and a
  platform ceiling (`SMS_ACCOUNT_MONTHLY_LIMIT_USD`) stop sending before the account's limit.
- Countries: Australia first; others only where a registered or permitted sender exists.

Then, once AWS grants it: raise `SMS_ACCOUNT_MONTHLY_LIMIT_USD` (bizinsights' own ceiling, 20)
below the new AWS limit if needed, register and tag a sender (step 2), and send one controlled
real text: a test recipient of your own (Send SMS → Send yourself a test), then Send SMS to a
development store's customer with your own number. Message History must show *Delivered* with
AWS's events, and Messaging costs AWS's price, before calling it operational.

## Settings

| Setting | Default | What |
| --- | --- | --- |
| `SMS_MODE` | `off` (production: `live`; the local server and e2e: `sandbox`) | off / sandbox (texts to customers recorded, not sent; test texts go) / live |
| `SMS_MARKETING_ENABLED` | empty (production: `1`) | Marketing texts at all (each store also turns them on) |
| `SMS_ACCOUNT_MONTHLY_LIMIT_USD` | 20 | bizinsights' monthly ceiling for all stores together |
| `SMS_MAX_PRICE_PER_PART_USD` | 0.25 | AWS refuses a dearer route (`MaxPrice`) |
| `SMS_PRICE_TABLE` | `{}` | Per-part prices by country from AWS's price list (CSV on the pricing page), for estimates before AWS has billed any |
| `SMS_PARTS_PER_SECOND` | 1 | A sender's MPS at AWS; campaigns are paced to it |
| `SMS_CAMPAIGN_MAX_RECIPIENTS` | 2000 | Largest campaign |
| `SMS_SHARED_SENDER` | empty | A shared, tagged origination identity |
| `SMS_SENDER_REQUESTS_TO` | empty (production: the owner's address) | Where Set up SMS's sender-name requests are emailed |
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

- **AWS's sandbox**: production is live, but the AWS account was still in the SMS sandbox with a
  US$1 limit and no sender on 2026-10-25. Leaving it, the limit and sender registration are the
  owner's steps above; no customer is texted before them.
- Phone numbers on live stores need Shopify's protected customer data approval (Level 2).
- India needs a configuration set in ap-south-1 for delivery events (none is created: Indian texts
  are sent, and stay "Accepted by AWS" until they become "Unknown" after 74 hours) and the merchant's DLT registration.
- Inbound replies other than STOP aren't read (no two-way flow); STOP reaches AWS's opt-out list.
- Birthday texts need a birthday source Shopify doesn't have.
- "Delivery confirmed" only where carriers report delivery to Shopify.
- Attribution is "an order followed a text", last touch, within the window: not incremental revenue.
- Registrations (AU sender IDs, 10DLC, DLT) are done in the AWS console, not from the dashboard:
  Set up SMS records the merchant's request and emails the platform owner, and approves the name
  only once AWS has it registered and tagged.
- Set up SMS sets one sender for one country (the one most customers are in); more countries, or
  a pool, are set in Sender Configuration.

## Testing

```bash
pnpm --filter @app/shared exec vitest run test/sms.test.ts
```

```bash
TEST_PG_PORT=5463 TEST_DB=sms_test pnpm --filter @app/worker exec vitest run test/sms.test.ts
```

```bash
TEST_PG_PORT=5463 TEST_DB=sms_test pnpm --filter @app/api exec vitest run test/sms.test.ts test/smsSetup.test.ts test/smsAutomations.test.ts
```

```bash
pnpm --filter @app/aws exec vitest run test/smsProvider.test.ts
```

### Production readiness

`apps/api/test/smsReadiness.test.ts` runs the module on a live platform (`SMS_MODE=live`, marketing
on) end to end through the API, with only AWS faked at the provider interface and the queue drained
as the jobs function drains it:

```bash
TEST_PG_PORT=5463 TEST_DB=sms_test pnpm --filter @app/api exec vitest run test/smsReadiness.test.ts
```

| Area | What it proves |
| --- | --- |
| Authentication | Every Send SMS route answers 401 without a session |
| Authorization | Viewers read sends without numbers; only owners and admins with contact rights send |
| Tenant isolation | Another business gets 404 for this one's sends, customers and messages, and its ids are not found in its own store |
| Phone validation | E.164 normalisation; unknown countries and countries the sender doesn't cover aren't texted, with the reason |
| Consent | Marketing only with Shopify's consent; opted-out numbers never; an opt-out after scheduling stops the text; the platform's marketing switch |
| Single SMS | Preview text (name, `{{date}}`), queue, the request AWS gets (identity, type, max price, context), Sent ≠ Delivered until the carrier's event, cost, audit |
| Bulk SMS | Four customers paced to the sender's speed; delivered, rejected (BLOCKED) and undeliverable (UNREACHABLE) told apart |
| Automation | A Shopify order texts its customer through the same queue; a webhook retry sends nothing twice |
| New message | Saved and approved in the sender's name; order details only for one customer |
| Setup gates | No sender, sending off, the AWS sandbox, the month's limit: refused before anything is recorded |
| Scheduling | A scheduled send waits; Cancel stops it; nothing is left to send at its time; 60 days at most |
| Failure handling | AWS's real sandbox refusal, a blocked country and an invalid number: Rejected in words, only the invalid number suppressed; a 500 is never re-sent and AWS's later event settles it |
| Retries | Throttling backs off and goes; six throttles end as Failed |
| Duplicates | A repeated request makes one send; a job run twice at once hands AWS one text; a replayed event changes nothing; the one-off endpoint's `requestId` |
| Rate limiting | 10 sends per store per 10 minutes; 200 customers per send; the customer's daily cap |

`apps/web/e2e/messaging.spec.ts` drives the Send SMS page itself (against the local server, in test
mode). Real delivery can only be shown with a real text, after the owner's AWS steps ("Going live").

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
