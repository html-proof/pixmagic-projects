# AWS cost reduction: status

Last updated **2026-11-08**. The plan and the numbers behind each change are in
[AWS_MIGRATION_PLAN.md](AWS_MIGRATION_PLAN.md). Update this page in the same pull request as each
change, or the day an owner-only step is done.

## Changes

| # | Change | Saves / month (before GST) | Status | Waiting on |
| --- | --- | --- | --- | --- |
| 1 | Support plan Business Support+ → Basic | 29.00 | Not started: AWS allows it from ~2026-11-14 04:43 UTC | Owner (console) |
| 2 | 1-year reserved instance for the database | 7.96 | Not started: two orders failed payment on 2026-10-18 | Owner: a payment method AWS can charge |
| 3 | X-Ray tracing off | 0.46 | Pull request open (2026-11-06), with change 5 | Its Deploy |
| 4 | GuardDuty Advanced RDS off | 6.78 | Not started; trial ends ~2026-11-15 | Owner's decision |
| 5 | WhatsApp service on Fargate Spot | up to ~12.10 | Owner said yes 2026-11-06; pull request open with change 3; switch tried on a throwaway stack first | Its Deploy, then a week of billing for the real rate |
| 6 | AWS WAF → Cloudflare's rules | 10.08 | Not started | Owner's decision |
| 7 | Secrets Manager → SSM SecureString | up to 2.43 | Not started (optional) | — |
| 8 | Database single-AZ | 21.74 | Owner said yes 2026-11-08 (the bill); pull request with change 9 | Its Deploy |
| 9 | One NAT instance (nat-b, in the database's zone) | ~8.24 | Owner said yes 2026-11-08; pull request with change 8 | Its Deploy |

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
| ECS Fargate (WhatsApp) | Kept | Change 5 |
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
