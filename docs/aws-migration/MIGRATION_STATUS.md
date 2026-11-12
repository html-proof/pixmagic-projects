# AWS cost reduction: status

Last updated **2026-11-12**. The plan and the numbers behind each change are in
[AWS_MIGRATION_PLAN.md](AWS_MIGRATION_PLAN.md). Update this page in the same pull request as each
change, or the day an owner-only step is done.

## Changes

| # | Change | Saves / month (before GST) | Status | Waiting on |
| --- | --- | --- | --- | --- |
| 1 | Support plan Business Support+ → Basic | 29.00 | Not started: AWS allows it from ~2026-11-14 04:43 UTC | Owner (console) |
| 2 | 1-year reserved instance for the database | 7.96 | Not started: two orders failed payment on 2026-10-18 | Owner: a payment method AWS can charge |
| 3 | X-Ray tracing off | 0.46 | **Live** (#343; checked 2026-11-08: api, jobs and cron `live` on `PassThrough`) | — |
| 4 | GuardDuty RDS protection off, both features (`RDS_LOGIN_EVENTS` 2.26 and Advanced RDS, `RDS_DATA_RISK`, 6.78) | ~9.04 | Our own checks in its place: change 10. Both features still `ENABLED` on 2026-11-12, 3 trial days left | Owner: one command ([aws-deployment.md](../aws-deployment.md#security-events)), once the alarm email is confirmed |
| 5 | WhatsApp service on Fargate Spot | up to ~12.10 | **Live** (#343; checked 2026-11-08: `insights-production-evolution-a` 1/1 on `FARGATE_SPOT`) | A week of billing for the real rate |
| 6 | AWS WAF → Cloudflare's rules | 10.08 | Not started | Owner's decision |
| 7 | Secrets Manager → SSM SecureString | up to 2.43 | Not started (optional) | — |
| 8 | Database single-AZ | 21.74 | **Live** 2026-11-08, release 174 (#357): `MultiAZ` false, primary 2b, same instance | — |
| 9 | One NAT instance (nat-b, in the database's zone) | ~8.24 | **Live** 2026-11-08, release 174 (#357): nat-a terminated, both app subnets route to nat-b | — |
| 10 | Our own security monitoring: `db-login-failures` alarm, five EventBridge rules to the alarm topic | −0.40 (it costs that) | Pull request 2026-11-12 | Its Deploy |
| 11 | Database: Enhanced Monitoring off, backups 14 → 7 days, the postgresql log expires after 90 days | ~1-3 (the bill gives the figure) | Pull request 2026-11-12, with change 10 | Its Deploy |
| 12 | The alarm email reaches someone | 0 | The topic had no subscriber on 2026-11-12; a confirmation email was sent that day | Owner: click "Confirm subscription" |
| 13 | WhatsApp service switched off (`AWS_WHATSAPP=off`: no Fargate task; everything else kept) | ~5-7 on Spot (17.29 on demand) | Pull request 2026-11-12; no message through it since 2026-10-30 | Its Deploy |

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
| Secrets Manager | Kept | Change 7 |
| Systems Manager | Kept | US$0 |
| CloudFront | Kept | US$0 |
| EC2 (NAT instance, admin host) | Kept | Change 9: one NAT instance from 2026-11-08 |
| NAT Gateway | Replaced 2026-10-17 by NAT instances | — |
| Load balancer | Not used | — |
| ECS Fargate (WhatsApp) | Off since 2026-11-12 (no task; the service, its database and secrets kept) | Changes 5 and 13 |
| WAF | Kept | Change 6 |
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
