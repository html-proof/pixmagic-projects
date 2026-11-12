# The US$50 ceiling: audit of 2026-11-12

The owner's brief of 2026-11-12 ("complete AWS cost reduction, maximum US$50 a month including
tax") asks for a full audit, an inventory, a budget and a forecast. This page is that audit, read
from the account itself that day (read-only AWS CLI, account `605411278365`, every enabled Region)
and from Cost Explorer. The changes and who each waits on are in
[MIGRATION_STATUS.md](MIGRATION_STATUS.md); the day-to-day reference is
[../aws-deployment.md](../aws-deployment.md), "The US$50 ceiling".

All amounts are US$. AWS Australia adds 10% GST, so US$50 with tax is **US$45.45 of charges**.

## The answer

| The month, from December 2026 (30 days) | Before GST | With GST |
| --- | --- | --- |
| Today's resources, with the support plan | ~82 | ~90 |
| Support plan on Basic (change 1) | ~53 | ~58 |
| and the WAF replaced by Cloudflare's rules (change 6) | ~43 | **~47** |
| The same, but GuardDuty's RDS protection left on (change 4 not done) | ~52 | ~57 |

The first three rows take GuardDuty's RDS protection as off.

- **US$50 holds only with changes 1, 4 and 6 all done.** All three wait on the owner
  ([What is left](#what-is-left)). Nothing else on the account is large enough to replace any of them.
- With all three the month comes to about US$47, and about US$48.50 in a 31-day month:
  **US$1.50-3 to spare**. That is too thin for a hard limit, so one of the three smaller changes under
  [More room](#more-room) should follow.
- **November 2026 can't come in under US$50**: US$64.99 by the 11th (the budget's own figure), of it
  29.00 the support plan charged on the 1st and 5.91 GST.
- No forgotten resource was found. Every Region but Sydney is empty of instances, disks, addresses,
  NAT gateways, databases and snapshots; `us-east-1` holds only what CloudFront requires there.

## What a day costs (Cost Explorer, 2026-11-11, by usage type)

US$1.89 that day, of it 0.18 the WhatsApp service, off since release 179. The month each line makes:

| Line | US$/day | US$/month | The brief's category |
| --- | --- | --- | --- |
| Database instance, db.t4g.micro single-AZ | 0.600 | 18.00 | Essential |
| WAF: web ACL, five rules, requests | 0.337 | 10.10 | Security (goes with change 6) |
| NAT instance, t4g.nano | 0.128 | 3.83 | Networking |
| Its public IPv4 address | 0.120 | 3.60 | Networking |
| Secrets Manager: 7 secrets since 2026-11-12 (6 the day measured) and their requests | 0.086 | 2.97 | Essential |
| Database backups above the free 20 GB | 0.096 | 2.89 | Storage and backups |
| Database storage, 20 GB gp3 (the smallest gp3 allows) | 0.092 | 2.76 | Storage and backups |
| CloudWatch alarms: 31, the first 10 free | 0.110 | 2.10 | Monitoring |
| Two 8 GB disks (NAT instance, admin host) | 0.051 | 1.54 | Storage and backups |
| KMS key and its requests | 0.038 | 1.15 | Essential |
| Disk snapshots (daily, kept 7 days) | 0.025 | 0.75 | Storage and backups |
| S3 (requests and 0.85 GB stored) | 0.012 | 0.36 | Storage and backups |
| Cost Explorer (the daily cost email) | 0.010 | 0.30 | Monitoring |
| DynamoDB | 0.003 | 0.08 | Essential |
| Route 53 private zone (charged on the 1st) | | 0.50 | Networking |
| GuardDuty once its trial ends (~2026-11-14), RDS protection off | | ~2.0 | Security |
| Lambda, SQS, SNS, EventBridge, Cognito, CloudFront, CloudTrail, SES, X-Ray | 0 | 0 | Free tiers |

Alarms: Cost Explorer shows 0.11 a day because the 10 free ones are used up early in the month;
over a month it is 21 × 0.10.

### Against the brief's budget table

The brief's allocations are planning figures (it says so) and assume 26% for tax; the real tax is
10%, which is where the room for the other lines comes from.

| Category | Brief's allocation | Forecast, changes 1, 4 and 6 done |
| --- | --- | --- |
| Essential AWS infrastructure | 20 | 22.20 (database 18.00, secrets 2.97, KMS 1.15, DynamoDB 0.08) |
| Storage and backups | 5 | 8.30 (database disk 2.76 and backups 2.89, disks 1.54, snapshots 0.75, S3 0.36) |
| Networking and data transfer | 5 | 7.93 (NAT 3.83, its address 3.60, private zone 0.50) |
| Monitoring and security | 5 | 4.40 (alarms 2.10, GuardDuty ~2.0, Cost Explorer 0.30) |
| Reserve | 2 | 0 |
| Tax (10% GST) | 13 | 4.28 |
| **Total** | **50** | **~47.1** |

## Inventory (2026-11-12)

Sydney (`ap-southeast-2`) unless said. "Required" means the live app stops or loses a protection
without it.

| Service | Resource | Status | US$/month | Required | Action |
| --- | --- | --- | --- | --- | --- |
| RDS | `insights-production`, db.t4g.micro, 20 GB gp3, single-AZ 2b, backups 7 days | available | 20.76 | Yes: every store's data | Keep. Reservation: [More room](#more-room) |
| RDS | Automated backups, 8 daily snapshots | — | part of 2.89 | Yes: recovery | Keep |
| RDS | Manual snapshots `pre-wipe-20261015-165804`, `pre-recovery-20261017`, `pre-deploy-20261018` | available | part of 2.89 | No: all three predate the current data | Delete with the owner's yes ([More room](#more-room)) |
| RDS | Manual snapshot `pre-table-drop-20261112` | available | part of 2.89 | For now: the only copy of the 27 dropped tables | Keep until the owner is sure nothing is missed |
| EC2 | `i-0c772de36d1dd7a84` nat-b, t4g.nano, public address 13.211.94.248 | running | 8.20 with disk and address | Yes: the functions' only way out to Shopify, Meta, Google | Keep |
| EC2 | `i-0ead8934b28556914` admin host, t4g.nano | stopped | 0.77 (its disk) | Yes: migrations by hand, the database copy | Keep stopped |
| EBS | 16 snapshots of those two disks (lifecycle policy `policy-0a722a278ad25689e`) | — | 0.75 | No (both are rebuilt from code) | Keep: Trusted Advisor's snapshot check |
| EC2 | Elastic IPs, NAT gateways, load balancers, unattached disks | none | 0 | — | — |
| VPC | Two gateway endpoints (S3, DynamoDB) | available | 0 | Yes | Keep (gateway endpoints are free) |
| Lambda | `api`, `jobs`, `cron`, `cognito-email`, `migrate-before-live`, `evolution-db-init`, 8 CloudFormation helpers | active | 0 | Yes | Keep |
| ECS Fargate | `insights-production-evolution-a` (WhatsApp) | 0 of 0 tasks since release 179 | 0 | Off by the owner's choice | Back on = ~5-7 on Spot, above the ceiling's spare room |
| ECR | CDK's asset repository | 0 images | 0 | — | — |
| CloudFront | `E17YTBLR04S64C` (the app), `E2O6ERGLFGXQQS` (the outage page) | deployed | 0 | Yes | Keep |
| WAF (us-east-1) | `insights-production`, five rules | on | 10.10 | Until Cloudflare's rules take over | Change 6 |
| Cognito | User pool `insights-production` | active | 0 | Yes, while sign-in moves to the app's own (`AUTH_MODE=migrating`) | Keep |
| KMS | One key (Cognito's email codes) | enabled | 1.15 | Yes, with Cognito | Keep |
| Secrets Manager | `app`, `db-owner`, `db-system`, `worker-cognito`, `origin-lock`, `evolution-api`, `evolution-db` | in use | 2.97 | Yes (the last two only for WhatsApp) | Parameter Store: [More room](#more-room) |
| SQS / SNS | 8 queues; topics `alarms`, `sms-events` | active | 0 | Yes | Keep |
| EventBridge | 3 schedules, 7 rules | enabled | 0 | Yes | Keep |
| DynamoDB | `insights-production-coord` | active | 0.08 | Yes | Keep |
| S3 | site 0.59 GB, trail 0.20 GB, logs 0.06 GB, artifacts, payloads, two CDK asset buckets | — | 0.36 | Yes | Keep (lifecycle rules already expire them) |
| CloudWatch | 31 alarms, 17 log groups (0.18 GB, free tier 5 GB), one dashboard | — | 2.10 | Yes: the only production monitoring | Keep |
| Route 53 | Private zone `whatsapp.production.insights.internal` | — | 0.50 | Only for WhatsApp | Keep while the service can come back |
| GuardDuty | Detector `2cc280b1…`, trial ends ~2026-11-14 | on | ~2 (+~9 with RDS protection) | Yes, without the RDS features | Change 4 |
| CloudTrail, Access Analyzer | Trail `insights-account`, 18 Regions | on | ~0.35 | Yes: the audit trail | Keep |
| Support | Business Support+ | on | 29.00 | No | Change 1 |
| Reserved instances | Two orders of 2026-10-18 | `payment-failed` | 0 | — | [More room](#more-room) |
| ElastiCache, API Gateway, Step Functions, AWS Backup, EKS, interface endpoints | not used | — | 0 | — | — |

DNS and the certificate's renewal are at Cloudflare, not Route 53; email goes through Resend, not SES.

## What the brief asks to keep

Shopify connections, the workspaces, sign-in (password, emailed code, Google), the database and its
history, the API, the jobs and schedules, Meta and Google Ads, the dashboard, file storage, HTTPS,
monitoring: all untouched by every change on this list, and each release's smoke tests check them
([../aws-deployment.md](../aws-deployment.md)). Two exceptions, both the owner's earlier decisions:
**WhatsApp** is switched off since 2026-11-12 (change 13; one repository variable brings it back, at
~US$5-7 a month) and **Apple sign-in** was removed in October.

## The brief's replacements

Each was weighed in an earlier audit; the verdicts stand, with today's numbers.

| The brief's suggestion | Verdict |
| --- | --- |
| EC2 → the existing server | The NAT instance has no counterpart outside AWS; it goes only when the whole app leaves |
| RDS → PostgreSQL on the existing server | Built and rehearsed ([../ikorex-migration/](../ikorex-migration/README.md)), **blocked**: the server has 2.5 GB of memory free against the 4 GB needed (inspected 2026-11-08 and 2026-11-12); waits on its administrator. A database on a server short of memory is the "silently compromising reliability" the brief rules out |
| ElastiCache, API Gateway, AWS Backup | Not used |
| SNS, SQS, Lambda | US$0 on the free tiers; a replacement needs an always-on host, which costs more ([AWS_COST_AUDIT.md](AWS_COST_AUDIT.md)) |
| CloudWatch → Prometheus, Grafana, Loki | US$2.10 of alarms; the replacement needs a host. Ready in the server's compose files for the day the app moves |
| Cognito → Keycloak | US$0 on AWS; the app's own sign-in is already live beside it. Keycloak declined by the owner on 2026-11-11 |
| SES → an SMTP provider | Done earlier: Resend |
| Secrets Manager → server-side secrets | On AWS the free counterpart is Parameter Store: [More room](#more-room) |
| ECR → another registry | Empty, US$0 |

So US$50 is reachable **on the current architecture**; no move is needed for it. Leaving AWS
altogether stays the larger saving and stays blocked on the server.

## Billing protection

- **Budget** US$50, tax included: emails at 50, 70, 85 and 95% (US$25, 35, 42.50, 47.50) and when
  AWS forecasts the month above US$50. The brief's four thresholds, live since release 184 (they
  were 50/75/90/100).
- **Cost Anomaly Detection**: an email for any anomaly of US$5 or more.
- **Daily cost email**, 07:00 Melbourne: yesterday by service and the month so far.
- None of these stops spending, and AWS's figures run hours to a day behind. What actually caps the
  bill is that nothing here scales with traffic except Lambda, S3 and CloudFront, all far inside
  their free tiers, and Lambda's concurrency is limited.

## What is left

| When | Who | Step |
| --- | --- | --- |
| Before ~2026-11-14 | Owner | Change 4: GuardDuty's two RDS features off, one command ([../aws-deployment.md](../aws-deployment.md#security-events)). Left on: ~US$9 a month more from the day the trial ends |
| From 2026-11-14 04:43 UTC | Owner | Change 1: support plan → Basic, root console. Done before 1 December, December carries no support charge |
| Now | Owner | Change 6: add the header in Cloudflare's Transform Rule; the lock, the rate rule and the WAF's removal follow by pull request |
| Now | Owner | Confirm the alarm email (the topic's one subscription is still `PendingConfirmation`): until then no alarm reaches anyone |

## More room

Each is separate from the three above and none is needed to get under US$50; one of them makes the
ceiling safe rather than just met.

| Change | Saves with GST | What it takes |
| --- | --- | --- |
| 1-year No Upfront reservation of the database (US$0.025 → 0.020 an hour) | ~4.0 | A card AWS can charge: both orders of 2026-10-18 failed payment. A one-year commitment, wrong if the app leaves AWS within the year |
| The three October manual snapshots deleted | up to ~3 (the bill gives the figure) | The owner's yes: permanent. All three predate the current data; the automated backups and `pre-table-drop-20261112` stay |
| Secrets Manager → Parameter Store (change 7) | ~3.3 | A pull request of its own: CloudFormation can't create encrypted parameters, so the database passwords have to be copied across by a helper without changing them |

With all three: about **US$37-40 a month with GST**.

## Checking it against the bill

Cost Explorer leaves out the support plan and GST until the invoice. The check that counts is the
Bills page: November's invoice (early December) will be above US$50 (see the top of this page);
**December's, in early January 2027, is the first that can be under it**, and the daily email's
"month so far" should stand near US$21 on 15 December and US$43 on the 31st, before GST.
