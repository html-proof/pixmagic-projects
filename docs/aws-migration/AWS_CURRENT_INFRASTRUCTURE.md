# AWS infrastructure in use (audit of 2026-11-06)

What bizinsights runs on AWS, service by service, read from the account itself (read-only AWS CLI
sweep of account `605411278365` on 2026-11-06) and from the code. The money side is in
[AWS_COST_AUDIT.md](AWS_COST_AUDIT.md); what to do about it in [AWS_MIGRATION_PLAN.md](AWS_MIGRATION_PLAN.md).
The runbook ([../aws-deployment.md](../aws-deployment.md)) stays the reference for how each piece is
built and operated.

All of it is in Sydney (`ap-southeast-2`) except the WAF web ACL and the CloudFront certificates
(`us-east-1`, a CloudFront rule) and Cost Explorer (`us-east-1`). Cloudflare (Free plan) proxies
`bizinsights.io` in front of CloudFront.

## How the code reaches AWS

- **No AWS SDK in the application.** No `package.json` lists `@aws-sdk/*`. Every runtime call is a
  SigV4-signed HTTPS request made with `aws4fetch` (`apps/aws/src/awsClient.ts`, and
  `apps/api/src/cognito.ts` for Cognito). The only SDK code is inline in two CDK custom resources,
  which use the copy built into the Lambda runtime.
- **Adapters in one place.** The API, the jobs and the domain logic know nothing of AWS. They use
  interfaces (`Queues`, `Coord`, `BlobStore`, `Mailer`, `SmsProvider`), and `apps/aws/src` holds
  the AWS implementation of each. [INTERNAL_SERVICES_ARCHITECTURE.md](INTERNAL_SERVICES_ARCHITECTURE.md)
  lists them and their non-AWS counterparts.

## Workload (7 days to 2026-11-06, CloudWatch)

| Measure | Value |
| --- | --- |
| `api` function | 45,811 invocations, 121 ms average |
| `jobs` function | 34,719 invocations, 572 ms average |
| `cron` function | 798 invocations, 5.1 s average |
| Messages sent to the queues | sync 31,843 · webhooks 4,651 · aggregate 801 · whatsapp 17 · email 0 · dead-letter 0 |
| Database CPU | 5.6–6.6 % daily average, highest 5-minute peak 55 % |
| Database connections | about 7 on average, at most 32 (alarm at 60 of ~80) |
| Database free memory | lowest 84 MiB. The `db-free-memory` alarm is set at 100 MB, so the micro instance is at its memory limit |
| Database disk | 18.2 GB free of 20 GB |
| CloudWatch Logs stored | 146 MB in all (the free tier is 5 GB) |
| DynamoDB `coord` | 12 items, 673 bytes |
| Cognito users | 72 (Essentials tier, free up to 10,000 monthly active users) |

## Service by service

"Monthly" is the measured cost from Cost Explorer: the average of 2026-10-27 to 2026-11-05 without
1 November (the day monthly charges land), scaled to a month, before the 10 % GST.

| AWS service | In use? | What it does here | Code | Data held | Essential? | Internal alternative feasible? | Complexity | Monthly |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| **SNS** | Yes, 2 topics | `insights-production-alarms`: alarm emails to the owner. `insights-production-sms-events`: SMS delivery events → SQS `smsEvents` | CDK only (`app-stack.ts`); no app code calls SNS | none | Alarms: yes. SMS events: yes while SMS is on AWS | Partly: alarm email could come from the app, but CloudWatch alarms publish only to SNS | Low | 0.00 |
| **SQS** | Yes, 8 queues | `sync`, `webhooks`, `aggregate`, `email`, `smsEvents`, `whatsapp`, the dead-letter queue, `cron-missed` | `apps/aws/src/sqsQueues.ts`, `consumer.ts` | Messages for at most 4 days (DLQ 14) | Yes: every background job goes through it | Yes: a PostgreSQL queue (design in INTERNAL_SERVICES_ARCHITECTURE.md), but it needs an always-on worker process | Medium | 0.02 |
| **SES** | Set up, not sending | Fallback mailer only. App email goes through **Resend** (`chooseMailer`, `apps/aws/src/mailers.ts`); Cognito's codes too | `sesMailer.ts` | none | No | Already replaced: Resend is the sender. SES has production access (50,000/day), sent 0 in the last 24 h | Done | 0.00 |
| **Lambda** | Yes | `api` (HTTP behind CloudFront), `jobs` (SQS consumers), `cron` (schedules), `cognito-email`, `migrate-before-live`, `evolution-db-init`, CDK helpers | `apps/aws/src/index.ts` | none | Yes: it is the compute | Yes, as long-running Node processes, but that compute has to run somewhere (see below) | High | 0.00 (free tier: ~128,000 GB-s and ~353,000 requests a month, of 400,000 and 1,000,000 free) |
| **EventBridge** | Scheduler only; no rules, no buses | `every15min` and `nightly` (UTC) → `cron`; `costreport` (07:00 Melbourne) | CDK `app-stack.ts`; `runScheduled()` in `apps/worker` | none | Yes | Yes: an in-process scheduler with a lease in PostgreSQL | Low–medium | 0.00 |
| **Step Functions** | **No** | — | — | — | — | Nothing to replace | — | — |
| **CloudWatch** | Yes | 36 alarms, 11 log metric filters, 1 dashboard, log groups (90 days; RDS OS metrics 30) | CDK (`app-stack.ts`, `data-stack.ts`, `auth-stack.ts`, `whatsapp-stack.ts`) | 146 MB of logs | Yes: the alarms are the only paging | Partly: an in-app status page, yes; replacing the alarms on RDS, NAT and Lambda metrics would mean reading those metrics from CloudWatch anyway | Medium | 1.68 |
| **X-Ray** | Yes | Sampled traces of `api`, `jobs`, `cron` (`tracing: ACTIVE`; no tracing code) | CDK | traces | No | Can simply be switched off | Low | 0.46 |
| **S3** | Yes, 8 buckets | `site` (UI build files + outage page), `payloads` (large webhook bodies, WhatsApp attachments; 7 days), `artifacts` (database dumps; 30 days), CloudTrail trail, access logs, CDK assets | `s3Blobs.ts` | small | Yes (`site` serves the UI) | Possible (disk or another object store) but saves cents | Low–medium | 0.43 |
| **RDS** | Yes | PostgreSQL 17.11 `insights-production`, db.t4g.micro, **Multi-AZ**, 20 GB gp3, 14-day backups, Performance Insights, Enhanced Monitoring. Databases `app` and `evolution` (WhatsApp service) | `packages/db`, `data-stack.ts` | All customer data | **Yes** | Self-hosted PostgreSQL is possible but loses managed backups, point-in-time restore and failover | High, risky | 44.54 (instance 36.85, storage 5.60, backups beyond the free allowance 2.05) |
| **ElastiCache** | **No** | The app has no Redis; DynamoDB does coordination | — | — | — | Nothing to replace | — | — |
| **Cognito** | Yes | Sign-in (email + password, Google), managed login on `auth.bizinsights.io` | `apps/api/src/cognito.ts`, `infra/aws/cognito.yaml` | 72 user accounts with passwords | Yes | Technically, but passwords can't be exported: every user would have to reset theirs | High | 0.00 |
| **API Gateway** | **No** | The API is a Lambda function URL behind CloudFront | — | — | — | Nothing to replace | — | — |
| **Secrets Manager** | Yes, 6 secrets | `app`, `db-owner`, `db-system`, `worker-cognito`, `evolution-api`, `evolution-db` | `apps/aws/src/secrets.ts` | secrets | Yes (secrets must live somewhere) | SSM Parameter Store SecureString (free) could hold them | Medium | 2.43 |
| **Systems Manager** | Yes | Parameter `/insights/production/runtime` (settings); Session Manager to the admin host and NAT instances | `secrets.ts` | settings | Yes | — | — | 0.00 |
| **KMS** | Yes | One customer key for Cognito's emailed codes; everything else uses AWS-managed keys | `cognitoEmail.ts` | — | Yes while Cognito sends codes through the app | — | — | 1.15 |
| **CloudFront** | Yes, 2 distributions | The site + API (with the WAF), and the outage-page fallback | `app-stack.ts` | cache | Yes | Cloudflare already sits in front; CloudFront also does origin failover and the origin secret | High | 0.00 |
| **WAF** | Yes | Web ACL `insights-production` (us-east-1): per-IP rate limits, IP reputation, known bad inputs, common rules (count only) | `edge-stack.ts` | — | Partly: the app has its own per-IP limits; Cloudflare is in front | Yes: Cloudflare's free-plan security rules (see the plan) | Medium | 10.08 |
| **EC2** | Yes, 3 instances | NAT instances `nat-a`, `nat-b` (t4g.nano, running, one per AZ); admin host (t4g.nano, **stopped**) | `nat-instances.ts`, `data-stack.ts` | 3 × 8 GB disks, daily snapshots kept 7 days | NAT: yes (the functions call Shopify, Meta, Google... through them) | — | — | 18.34 (instances 7.68, disks and snapshots 3.36, two public IPv4 addresses 7.30) |
| **NAT Gateway** | **No** | Replaced by the NAT instances on 2026-10-17 | — | — | — | Already replaced | — | — |
| **Load balancer** | **No** | The WhatsApp service is found through Cloud Map DNS | — | — | — | Nothing to replace | — | — |
| **ECS Fargate** | Yes, 1 task | Evolution API (WhatsApp QR linking), 0.5 vCPU + 1 GB, Graviton, on demand | `whatsapp-stack.ts` | sessions in its `evolution` database | Yes, while WhatsApp QR linking is offered | Could run on any always-on host | Medium | 17.29 |
| **Route 53** | Private zone only | The Cloud Map namespace `whatsapp.production.insights.internal` (public DNS is at Cloudflare) | `whatsapp-stack.ts` | — | With Fargate | — | — | 0.50 |
| **DynamoDB** | Yes | `coord`: rate limits, OAuth state, locks, signed-out sessions | `dynamoCoord.ts` | 12 items | Yes | Yes: a PostgreSQL table | Low | 0.14 |
| **End User Messaging (SMS)** | Yes, **sandbox** | Customer Messaging SMS; one sender ID `BIZTEST` (AU), no phone numbers | `smsProvider.ts` | — | Yes for SMS | Another SMS provider would do; the user asked to keep an external one | — | 0.00 |
| **GuardDuty** | Yes, **free trial (9 days left)** | Threat detection incl. RDS protection and Advanced RDS (`RDS_DATA_RISK`) | turned on by hand | findings | Owner's choice (security) | — | — | 0.00 now; see the cost audit for after the trial |
| **CloudTrail** | Yes | Trail `insights-account` (all Regions, kept 1 year) | `audit-stack.ts` | events | Yes (audit) | — | — | 0.00 (first copy of management events) |
| **Cost Explorer** | Yes | The daily cost email (one call a day) | `costReport.ts` | — | Owner asked for it | — | — | 0.30 |
| **AWS Backup** | **No** | RDS has its own automated backups; EBS snapshots come from Data Lifecycle Manager | — | — | — | — | — | — |
| **Support plan** | **Business Support+** | AWS's paid support (US$29/month minimum) | — | — | No: the app does not use it | Basic support is free | Owner's click | 29.00 |

## Things that are not there

The sweep found no Elastic IP addresses, no NAT gateway, no load balancer, no API Gateway, no Step
Functions state machine, no ElastiCache, no EventBridge rule or bus, no AWS Backup plan, no
unattached EBS volume and no running instance that isn't needed (the admin host is stopped). Two
reserved-instance records for the database say `payment-failed` and cost nothing.

## Snapshots and backups kept

- RDS: automated backups for 14 days, and three manual snapshots (2026-10-15, -17, -18). The owner
  decided on 2026-10-29 to keep the three. Together they now pass the free backup allowance
  (`ChargedBackupUsage`, ~2.05 a month).
- EBS: Data Lifecycle Manager takes a daily snapshot of each disk and keeps 7 days.
