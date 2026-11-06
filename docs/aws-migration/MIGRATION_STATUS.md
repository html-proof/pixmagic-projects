# AWS cost reduction: status

Last updated **2026-11-06**. The plan and the numbers behind each change are in
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
| 8 | Database single-AZ | 21.74 | Not proposed for now (owner chose Multi-AZ) | Owner |
| 9 | One NAT instance | ~8.24 | Not proposed for now (owner chose one per zone) | Owner |

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
| RDS | Kept | Pricing: changes 2, 8 |
| ElastiCache | Not used | — |
| Cognito | Kept | US$0 |
| API Gateway | Not used | — |
| Secrets Manager | Kept | Change 7 |
| Systems Manager | Kept | US$0 |
| CloudFront | Kept | US$0 |
| EC2 (NAT instances, admin host) | Kept | Change 9 |
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
