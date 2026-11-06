# AWS cost audit (2026-11-06)

Every figure is from the account's own billing data (Cost Explorer, `UnblendedCost`, read
2026-11-06) or, where a price is needed for something not yet billed, from AWS's Price List API for
Sydney. US dollars a month, **before the 10 % GST** that AWS Australia adds, unless a column says
otherwise. Cost Explorer runs about a day behind the Bills page. The resources behind each line are
in [AWS_CURRENT_INFRASTRUCTURE.md](AWS_CURRENT_INFRASTRUCTURE.md).

## The bill now

**November so far** (1–5 November): US$49.57 = Business Support+ 29.00 + GST 4.50 + usage 16.07.

**Steady monthly run rate**: the average of 2026-10-27 to 2026-11-05 without 1 November (the day
monthly charges land), times 30.42 days:

| Service | US$/month | What it is |
| --- | --- | --- |
| RDS | 44.54 | db.t4g.micro Multi-AZ 36.85 · 20 GB gp3 Multi-AZ 5.60 · backups beyond the free allowance 2.05 |
| ECS (Fargate) | 17.29 | The WhatsApp service (Evolution API), 0.5 vCPU + 1 GB, on demand |
| WAF | 10.08 | Web ACL 5.07 + 5 rules 5.07 (requests: cents) |
| EC2 instances | 7.68 | Two t4g.nano NAT instances |
| VPC | 7.30 | Two public IPv4 addresses (the NAT instances) |
| EC2 other | 3.36 | Three 8 GB disks (NAT a, NAT b, stopped admin host) 2.26 · daily snapshots 0.77 · rest |
| Secrets Manager | 2.43 | Six secrets × 0.40 + calls |
| CloudWatch | 1.68 | 36 alarms (1.01 after the 10 free) + metrics |
| KMS | 1.15 | The Cognito email key (1.00) + requests |
| X-Ray | 0.46 | Traces stored |
| S3 | 0.43 | Mostly PUT requests (CloudTrail and access-log delivery) |
| Cost Explorer | 0.30 | The daily cost email, one call a day |
| DynamoDB | 0.14 | `coord` table |
| SQS | 0.02 | |
| Lambda, CloudFront, Cognito, EventBridge Scheduler, SNS, SES, CloudTrail, SMS | 0.00 | Inside the always-free tiers, or nothing sent |
| **Usage** | **96.87** | |
| Route 53 | 0.50 | The WhatsApp service's private DNS zone (charged on the 1st) |
| **Business Support+** | **29.00** | The support plan's monthly minimum (charged on the 1st) |
| **Total** | **126.37** | **139.01 with GST** |

**From about 15 November** GuardDuty's 30-day trial ends (9 days left on 2026-11-06). GuardDuty's
own usage figures for the last 30 days put every feature except Advanced RDS at 2.61 a month, and
Advanced RDS (`RDS_DATA_RISK`) lists at 3.39 per vCPU-month, 6.78 for the database's 2 vCPUs. That
adds ~9.39: **~135.76 a month, ~149.34 with GST**, against a budget of 80 (tax included).

No line for data transfer reached 2 cents: traffic is inside the free tiers.

## Where the money is, and where it isn't

The services the migration brief proposes to rebuild inside the app cost, together, **US$2.73 a
month**: SNS 0, SQS 0.02, EventBridge 0, Lambda 0, Step Functions (none exist), CloudWatch 1.68 +
X-Ray 0.46, SES 0 (Resend sends the mail), S3 0.43, and DynamoDB 0.14 for the coordinator.

They run inside AWS's free tiers because they are billed per use and the use is small. A
replacement inside the app would need a process that is always running to poll its queue and fire
its schedule. The cheapest such host on AWS, a t4g.nano with its disk and a public IPv4 address,
costs about 8.24 a month at this account's measured prices (3.84 + 0.75 + 3.65). That is three
times what it would save. **Rebuilding them would raise the AWS bill, not lower it.**

94 % of the bill is five things: the support plan (29.00), the database (44.54), the WhatsApp
service (17.29), the way out to the internet (18.34 for the NAT instances, their disks and
addresses) and the WAF (10.08), plus GuardDuty after its trial.

## What would lower it

Each line is one change, with what it saves at the measured or listed price, what it costs in
function, and who can do it. Details, checks and rollback: [AWS_MIGRATION_PLAN.md](AWS_MIGRATION_PLAN.md).

| # | Change | Saves / month | Source of the figure | What is lost | Who |
| --- | --- | --- | --- | --- | --- |
| 1 | Support plan Business Support+ → Basic (allowed from ~2026-11-14, after the 30-day minimum) | 29.00 | Bill | AWS technical support cases (billing and limit-increase cases stay free) | Owner, in the console |
| 2 | 1-year No Upfront reserved instance for the database | 7.96 | List: 0.051 → 0.0401 /hour | Nothing (a 1-year commitment; still applies if the database grows to db.t4g.small) | Owner: two earlier orders failed payment |
| 3 | Switch X-Ray tracing off | 0.46 | Bill | Sampled traces nobody reads (no tracing code) | Code change |
| 4 | GuardDuty Advanced RDS off before the trial ends | 6.78 | List: 3.39 × 2 vCPU | Detection of unusual data access in the database (login monitoring stays) | Owner kept it on 2026-10-18 |
| 5 | WhatsApp service on Fargate Spot | up to ~12.10 | Bill 17.29; Spot's rate isn't in AWS's price list (AWS states up to 70 % off) | When AWS reclaims the task, every linked phone drops for a minute or two | Code change (`whatsapp.spot`) |
| 6 | AWS WAF → Cloudflare's free security rules (Cloudflare already proxies the site) | 10.08 | Bill | AWS's managed rule groups and the 60-second per-IP edge limit; CloudFront must then accept only Cloudflare | Code change + Cloudflare settings |
| 7 | Secrets Manager → SSM Parameter Store SecureString | up to 2.43 | Bill | Nothing used today (no rotation); moving the database logins is careful work | Code change |
| 8 | Database single-AZ | 21.74 | List: 0.051 → 0.025 /hour, storage halves | Automatic failover: a zone outage or maintenance stops the app until AWS recovers it | Owner chose Multi-AZ on 2026-10-17 |
| 9 | One NAT instance instead of two | ~8.24 | Bill | Outbound calls stop for both zones if that NAT's zone fails | Owner chose one per zone on 2026-10-17 |

## Before and after

| Stage | Changes | US$/month | With GST |
| --- | --- | --- | --- |
| Today, after GuardDuty's trial | — | 135.76 | 149.34 |
| Step 1: nothing lost | 1, 2, 3 | 98.34 | 108.17 |
| Step 2: small trade-offs | + 4, 6 | 81.48 | 89.63 |
| | + 5 (Spot, at AWS's "up to 70 %") | ~69.38 | ~76.32 |
| Step 3: give up high availability | + 8, 9 | ~39.40 | ~43.34 |

The owner's budget of US$80 a month, tax included, is reached in step 2 with the WhatsApp service on
Spot.

## Pressure in the other direction

The database's free memory went as low as 84 MiB this week (the `db-free-memory` alarm is at
100 MB). If it has to grow to db.t4g.small Multi-AZ, the instance doubles: +37.23 a month on
demand (the bill showed db.t4g.small single-AZ at 0.051 /hour in October). The reserved instance in
change 2 is size-flexible and would still cover half of that.

## How this was measured

Read-only, on 2026-11-06, as the account's root user through `aws login`: Cost Explorer
`GetCostAndUsage` (monthly and daily, by service, usage type and record type; about six calls at US$0.01),
`GetCostForecast` (refused: not enough history), the Price List API (RDS, ECS, GuardDuty in Sydney),
GuardDuty `GetUsageStatistics` and `GetRemainingFreeTrialDays`, CloudWatch metrics for the last 7
days, and `describe`/`list` calls for every service in the inventory. Nothing was changed.
