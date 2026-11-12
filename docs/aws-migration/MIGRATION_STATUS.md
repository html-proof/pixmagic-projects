# AWS cost reduction: status

Last updated **2026-11-12**. The plan and the numbers behind each change are in
[AWS_MIGRATION_PLAN.md](AWS_MIGRATION_PLAN.md). Update this page in the same pull request as each
change, or the day an owner-only step is done.

## Changes

| # | Change | Saves / month (before GST) | Status | Waiting on |
| --- | --- | --- | --- | --- |
| 1 | Support plan Business Support+ → Basic | 29.00 | Not started: AWS allows it from ~2026-11-14 04:43 UTC | Owner (console) |
| 2 | 1-year reserved instance for the database | 3.65 single-AZ (US$0.025 → 0.020 an hour; 7.96 was the Multi-AZ figure) | Not started: two orders failed payment on 2026-10-18 | Owner: a payment method AWS can charge |
| 3 | X-Ray tracing off | 0.46 | **Live** (#343; checked 2026-11-08: api, jobs and cron `live` on `PassThrough`) | — |
| 4 | GuardDuty RDS protection off, both features (`RDS_LOGIN_EVENTS` 2.26 and Advanced RDS, `RDS_DATA_RISK`, 6.78) | ~9.04 | Our own checks in its place: change 10. Both features still `ENABLED` on 2026-11-12, 3 trial days left | Owner: one command ([aws-deployment.md](../aws-deployment.md#security-events)), once the alarm email is confirmed |
| 5 | WhatsApp service on Fargate Spot | up to ~12.10 | **Live** (#343; checked 2026-11-08: `insights-production-evolution-a` 1/1 on `FARGATE_SPOT`) | A week of billing for the real rate |
| 6 | AWS WAF → Cloudflare's rules | 10.08 (less 0.40 for the lock's secret) | **In progress** (owner's "just do it", 2026-11-12). Step 1 of 3, the origin lock: `"report"` **live** 2026-11-12, release 180 (#375), nothing refused yet; `/edge-lock` answers 403 until Cloudflare sends the header. The WAF still on | Owner: add the header in Cloudflare ([aws-deployment.md](../aws-deployment.md#origin-lock-only-cloudflare-reaches-cloudfront)); then the lock enforces, then the rate rule, then the WAF goes |
| 7 | Secrets Manager → Parameter Store SecureString, all seven secrets, in three steps ([SECRETS_TO_PARAMETER_STORE.md](SECRETS_TO_PARAMETER_STORE.md)) | 2.97 (7 × 0.40 and their requests), once the secrets are deleted in step 3; nothing yet | **In progress.** Step 1 of 3 (2026-11-12): every release copies each secret, unchanged, into a parameter of the same name, and the functions read the parameter first, the secret as fallback. The secrets all still exist | A week of `secrets loaded` log lines on `parameter`, then step 2 (nothing reads Secrets Manager), then step 3 (the secrets deleted with a 30-day recovery window) |
| 8 | Database single-AZ | 21.74 | **Live** 2026-11-08, release 174 (#357): `MultiAZ` false, primary 2b, same instance | — |
| 9 | One NAT instance (nat-b, in the database's zone) | ~8.24 | **Live** 2026-11-08, release 174 (#357): nat-a terminated, both app subnets route to nat-b | — |
| 10 | Our own security monitoring: `db-login-failures` alarm, five EventBridge rules to the alarm topic | −0.40 (it costs that) | **Live** 2026-11-12, release 178 (#371): the alarm in `OK`, five rules in Sydney and two in us-east-1 `ENABLED` | The alarm email confirmed (change 12) |
| 11 | Database: Enhanced Monitoring off, backups 14 → 7 days, the postgresql log expires after 90 days | ~1-3 (the bill gives the figure) | **Live** 2026-11-12, release 178 (#371): `MonitoringInterval` 0, backups 7 days, the log group on 90 days; the same instance (created 2026-10-15) | — |
| 12 | The alarm email reaches someone | 0 | The topic had no subscriber on 2026-11-12; a confirmation email was sent that day and the deploy's subscription (#371) is the same one. Still `PendingConfirmation` at release 179 | Owner: click "Confirm subscription" in AWS's email (spam too) |
| 13 | WhatsApp service switched off (`AWS_WHATSAPP=off`: no Fargate task; everything else kept) | ~5-7 on Spot (17.29 on demand) | **Live** 2026-11-12, release 179 (#372): the ECS service at 0 of 0 tasks, no `whatsapp-service-*` alarm, the app answers WhatsApp isn't set up | A week of billing for the figure |
| 14 | 26 unused tables dropped (the two old WhatsApp designs, `email_otps`, `funnel_daily`), all empty | ~0 (tidiness) | **Live** 2026-11-12, release 181 (#374; the owner's yes that day, kept on 2026-10-29): 131 tables left, none of the 26 among them | — |
| 15 | `refunds` dropped too (2 rows, written before returns were read from `order_sales` on 2026-10-16) | ~0 (tidiness) | **Live** 2026-11-12, release 182 (#378; the owner's "drop refunds too" that day): 130 tables left, `refunds` not among them | — |
| 16 | Budget US$80 → US$50, tax included: the owner's ceiling since 2026-11-12 ([aws-deployment.md](../aws-deployment.md), "The US$50 ceiling") | 0 (it only emails) | #379, 2026-11-12. November is already above US$50 (64.20 with GST on the 11th), so its emails come at once | The ceiling itself needs changes 1, 4 and 6: ~47 a month with GST once all three are done (re-measured 2026-11-12, [COST_CEILING_50.md](COST_CEILING_50.md)), ~58 with the WAF left, ~90 with the support plan left too |
| 17 | Budget emails at 50/70/85/95% (they were 50/75/90/100), and on a forecast above US$50: the thresholds of the owner's brief of 2026-11-12 | 0 (it only emails) | **Live** 2026-11-12, release 184 (#380): budget `insights-production-monthly-3b3edbc8`, the four alerts and the forecast one on it. November was already above US$47.50, so all four emails came at once | — |

## Services

| AWS service | Status | Notes |
| --- | --- | --- |
| SNS | Kept | US$0; alarm emails and SMS delivery events |
| SQS | Kept | US$0.02 |
| EventBridge Scheduler | Kept | US$0 |
| Lambda | Kept | US$0 (free tier) |
| Step Functions | Not used | — |
| CloudWatch | Kept | US$1.68; X-Ray to be switched off (change 3) |
| SES | Replaced earlier by Resend | SES stays as the unused fallback |
| S3 | Kept | US$0.43 |
| RDS | Kept | Pricing: changes 2, 8 (single-AZ from 2026-11-08) |
| ElastiCache | Not used | — |
| Cognito | Kept | US$0 |
| API Gateway | Not used | — |
| Secrets Manager | Kept until change 7's step 3 | Change 7: each secret has a copy in Parameter Store since step 1 |
| Systems Manager | Kept | US$0; Parameter Store holds the secrets' copies (standard tier, free) |
| CloudFront | Kept | US$0 |
| EC2 (NAT instance, admin host) | Kept | Change 9: one NAT instance from 2026-11-08 |
| NAT Gateway | Replaced 2026-10-17 by NAT instances | — |
| Load balancer | Not used | — |
| ECS Fargate (WhatsApp) | Off since 2026-11-12 (no task; the service, its database and secrets kept) | Changes 5 and 13 |
| WAF | Kept until change 6's last step | Change 6 |
| GuardDuty | Kept | Change 4 |
| Support plan | Business Support+ | Change 1 |

## Log

- **2026-11-06**: audit done (read-only); these pages written (#342). Run rate US$126.37 a month
  before GST today, ~135.76 after GuardDuty's trial. Nothing changed in AWS.
- **2026-11-06**: the owner said yes to changes 3 and 5. Before the pull request, the Spot switch was
  tried on a throwaway CloudFormation stack in the default VPC (one busybox task, deleted after):
  launch type → `FARGATE_SPOT` and both provider-to-provider moves update in place; capacity
  provider → launch type fails (replacement against the fixed name), so `spot: false` now means the
  `FARGATE` capacity provider.
- **2026-11-08**: the owner, on the bill "spiking": Cost Explorer shows usage flat at ~US$3.15 a day
  since 2026-10-26; November's jump is Business Support+'s US$29 on the 1st plus GST (US$54.64 by
  2026-11-07, more than all of October's 46.14). The owner said yes to changes 8 and 9 until the move
  to iKorex ([../ikorex-migration/](../ikorex-migration/README.md)). The database's primary is in 2b,
  so the NAT instance kept is nat-b (`natAz`) and nat-a goes: one zone's outage stops the app, not
  either. `cdk diff` against production before the pull request: the RDS instance "may be replaced"
  (CloudFormation's conditional flag for `MultiAZ`; its own reference says some interruptions, and
  the same instance, created 2026-10-15, went Multi-AZ in place on 2026-10-17), appSubnet1's route
  moves to nat-b, nat-a and its three alarms and launch snapshot are deleted. Nothing else changes.
- **2026-11-08**: #357 merged (e3f7811b), Deploy to AWS green, **release 174** live (`/api/version`,
  `readyz` 200). Checked after it: the database `available`, single-AZ in 2b, created 2026-10-15 (not
  replaced); nat-a terminated, appSubnet1 and appSubnet2 both `0.0.0.0/0` → nat-b, its three alarms
  OK; no errors in api, jobs or cron, no alarm in ALARM, the dead-letter queue empty, the WhatsApp
  task 1/1. Changes 3 and 5 (#343) checked live the same day. Left for the owner: change 1 from
  2026-11-14 04:43 UTC, change 4 before GuardDuty's trial ends (~2026-11-15).
- **2026-11-12**: the owner's "just do it" to the cost recommendations of that day (eight items).
  Read-only checks first: the alarm topic had **no subscriber** (the first subscription was never
  confirmed and SNS had dropped it), so a new confirmation email went to the owner's address;
  GuardDuty's `RDS_LOGIN_EVENTS` and `RDS_DATA_RISK` both `ENABLED` with 3 trial days left; the
  database on Enhanced Monitoring (60 s, 92 MB of `RDSOSMetrics`), 14-day backups, Performance
  Insights on its free 7 days. One pull request for changes 10 and 11 and the subscription's new
  id (change 12). Not done, each for its own reason: the support plan (AWS allows it from
  2026-11-14 04:43 UTC, root console); GuardDuty's two RDS features (the owner's command, after
  the alarm email is confirmed); the WAF, the WhatsApp service, the old tables and the old
  Cloudflare deployment (each waits for the owner's answer).
- **2026-11-12**: change 13. Before it: the `whatsapp` queue's `NumberOfMessagesSent` per day, 14
  days: 10 and 17 on 29 and 30 October, 0 on every day since; no line from the service's own log
  in the last day; WhatsApp is not offered to App Store workspaces. `AWS_WHATSAPP=off` set as a
  repository variable, and the pull request makes "off" clean: the functions get no
  `EVOLUTION_API_URL` (the page says WhatsApp isn't set up) and `whatsapp-service-unreachable`
  isn't made. Back on: delete the variable, run Deploy to AWS ([../whatsapp.md](../whatsapp.md), "Cost").
- **2026-11-12**: change 6 started, in the order of [the plan](AWS_MIGRATION_PLAN.md): the side
  door first. Read-only checks before it: the WAF's sampled requests of the last three hours (all
  258): 252 through Cloudflare on `bizinsights.io`, 2 on `www`, and the only direct calls of
  `d2mr8m2p1qkh58.cloudfront.net` were the smoke tests' and this check's own, so no webhook or
  client depends on that name; no rule but the common set's count matched anything. A POST straight
  to the cloudfront.net name reached the app that day (404 from `/api/healthz`): the side door is
  real. First pull request: the origin lock in `"report"`, the secret
  `insights/production/origin-lock`, `/edge-lock`, the smoke check.
- **2026-11-12**: #375 merged (920e82e3), Deploy to AWS green, **release 180** (`/api/version`,
  `healthz` 200, smoke tests 35 of 35). Checked after it: the secret exists and the live function's
  copy is the same 48 letters and digits (CloudFormation resolved the reference; compared by a
  script, never shown), `ENFORCE` false, the stack's `OriginLock` output `report`;
  `https://bizinsights.io/edge-lock` 403 (Cloudflare doesn't send the header yet), pages and the
  API as before, the cloudfront.net name still 301 for a page and still serving a POST. Before the
  merge the function ran in CloudFront's own runtime (`aws cloudfront test-function` on a
  throwaway, unpublished function, deleted after): 18 requests in both modes, each as designed.
  Left for the owner: the Transform Rule in Cloudflare; `"enforce"` follows once `/edge-lock`
  answers 204.
- **2026-11-12**: #371 merged (d56f0305), Deploy to AWS green, **release 178**; #372 merged
  (b54089df) with `AWS_WHATSAPP=off`, Deploy green, **release 179** (`/api/version`, `readyz` 200).
  Checked after each: the database `available` and the same instance, nothing pending; no alarm in
  ALARM; no API errors in the half hour after. Left for the owner: confirm the alarm email, then
  change 4 (the command in [aws-deployment.md](../aws-deployment.md#security-events)) before
  GuardDuty's trial ends ~2026-11-15, and change 1 from 2026-11-14 04:43 UTC.
- **2026-11-12**: change 14. All 26 tables at 0 rows right before the merge (the cron's `counts`),
  manual snapshot `insights-production-pre-table-drop-20261112` taken first (a fourth manual
  snapshot: it never expires by itself). #374 merged (d787b798), Deploy to AWS green, **release
  181**. Checked after it: 131 tables, the 12 `wapp_*` tables and `refunds` (2 rows) there, 67
  migrations applied, `readyz` 200, no alarm in ALARM, the dead-letter queue empty, no function
  errors in the half hour after.
- **2026-11-12**: change 15. `refunds` at 2 rows before the merge (they are in the snapshot
  `insights-production-pre-table-drop-20261112`). #378 merged (5456be17), Deploy to AWS green,
  **release 182**. Checked after it: 130 tables, `refunds` gone, `order_sales` 699 and `orders` 291
  as before, 68 migrations applied, `readyz` 200, no alarm in ALARM.
- **2026-11-12**: the owner set the ceiling at **US$50 a month with GST** ("last time it was
  $100"). Cost Explorer for 2026-11-10: US$1.88 a day, of which the WhatsApp service (0.18) is
  off since release 179. The month so far, to the 11th: 64.20 with GST, of it 29 the support plan
  and 5.83 GST. Budget lowered to 50 (change 16). What a day is made of and what the month comes
  to: [aws-deployment.md](../aws-deployment.md), "The US$50 ceiling".
- **2026-11-12**: the owner's brief "complete AWS cost reduction, maximum US$50 including tax".
  Read-only audit again, every Region: nothing forgotten anywhere, release 183 live, the WhatsApp
  service at 0 tasks, GuardDuty's trial at 2 days with both RDS features still `ENABLED`, the alarm
  email still `PendingConfirmation`, `/edge-lock` still 403 (change 6 waits on the header). The
  month to the 11th: US$64.99 with GST. Re-measured, the month with changes 1, 4 and 6 done is ~47
  with GST, so US$2-3 to spare: [COST_CEILING_50.md](COST_CEILING_50.md) has the inventory, the
  forecast against the brief's budget table and three smaller changes for more room (the database
  reservation, the three October snapshots, change 7). Nothing was deleted or switched off in
  AWS. Changed: the budget's thresholds (change 17).
- **2026-11-12**: #380 merged (a104f928). Its CI on `main` failed before any test ran (the
  browser tests' database container "unhealthy" a second after it started, as on #379's merge), so
  the Deploy was skipped; the failed job re-run passed and its Deploy to AWS was green: **release
  184** (`/api/version`, `readyz` 200). Checked after it: one budget,
  `insights-production-monthly-3b3edbc8`, US$50, alerts at 50/70/85/95% and on the forecast; no
  alarm in ALARM.
- **2026-11-12**: change 7, step 1 of 3 ([SECRETS_TO_PARAMETER_STORE.md](SECRETS_TO_PARAMETER_STORE.md)).
  Measured first (read-only): seven secrets, the largest (`app`) 1,201 characters with 18 keys, so
  each fits a free standard parameter as it is; none has to stay in Secrets Manager (the three
  values CloudFormation reads at deploy time go through a custom resource in step 2), so the saving
  is the whole US$2.97 a month, ~3.27 with GST, once step 3 deletes the secrets. Step 1 changes no
  value and removes nothing: a copier in the App stack writes each secret's text into
  `/insights/production/<name>` on every release, the functions read that first and the secret
  when they can't, and `put-secrets.mjs` writes both. Found on the way: the NAT instance's and the
  admin host's Systems Manager policy allows reading every parameter, so both roles now carry a
  Deny on the secrets' copies; and `db-owner` and `worker-cognito` would have been deleted with no
  recovery window if their resources ever left a template, so both are now kept on removal.
