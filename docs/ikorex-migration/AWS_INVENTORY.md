# AWS inventory (2026-11-06)

Every AWS service bizinsights uses, where the code touches it, what depends on it, what it costs, and
what replaces it on the iKorex server. The account (`605411278365`, Sydney) was swept read-only on
2026-11-06; the raw measurements, the workload figures and the method are in
[../aws-migration/AWS_CURRENT_INFRASTRUCTURE.md](../aws-migration/AWS_CURRENT_INFRASTRUCTURE.md) and
[../aws-migration/AWS_COST_AUDIT.md](../aws-migration/AWS_COST_AUDIT.md). The target design is
[IKOREX_INFRASTRUCTURE_ARCHITECTURE.md](IKOREX_INFRASTRUCTURE_ARCHITECTURE.md); the move, service by
service, is [AWS_TO_IKOREX_MIGRATION_MATRIX.md](AWS_TO_IKOREX_MIGRATION_MATRIX.md).

"Monthly" is US dollars before the 10 % GST, measured from Cost Explorer (average of 2026-10-27 to
2026-11-05 without 1 November). Total today: **126.37**, ~135.76 once GuardDuty's trial ends (~15 Nov).

## How the code reaches AWS

There is **no AWS SDK in the application**. Every runtime call is a signed HTTPS request through
`aws4fetch`, in seven files: `apps/aws/src/{awsClient,dynamoCoord,s3Blobs,secrets,sesMailer,smsProvider}.ts`
and `apps/api/src/cognito.ts`. The API, the jobs and the domain logic use interfaces from
`packages/core` (`Queues`, `Coord`, `BlobStore`, `Mailer`, `SmsProvider`), so the provider layer the
brief asks for (StorageProvider, QueueProvider, ...) already exists; moving off AWS means writing new
implementations of these interfaces, not rewriting the modules that use them.

The AWS-specific entry point is `apps/aws/src/index.ts` (one package deployed as the `api`, `jobs`
and `cron` Lambda functions). `apps/aws/src/local.ts` already runs the same app as one Node process,
but keeps queues, coordination and blobs in memory, so it is for development only.

## Services in use

| AWS service | Where in the code | Feature that depends on it | Monthly | Replacement on iKorex | Complexity | Security requirements | Testing |
| --- | --- | --- | --- | --- | --- | --- | --- |
| **Lambda** `api` | `apps/aws/src/index.ts` (`handler`, Hono) | The whole web UI and API | 0.00 | `app` container: a production HTTP server (the same `buildApp` as today) | Medium | Only reachable through the tunnel; client IP only from Cloudflare's header | Smoke tests (`infra/cdk/scripts/smoke.mjs` adapted), e2e suite against it |
| **Lambda** `jobs` + **SQS** (6 queues, dead-letter queue) | `sqsQueues.ts`, `consumer.ts`; handlers in `apps/worker` | Shopify sync, webhooks, aggregates, email, SMS events, WhatsApp sends and campaigns | 0.02 | `worker` container: durable PostgreSQL queue (pg-boss), same queues, concurrency, retries and dead-letter queue | Medium–high | Jobs carry `workspace_id`; handlers run under row-level security as today | Unit + integration: retry, backoff, dead-letter, crash mid-job, duplicate delivery |
| **Lambda** `cron` + **EventBridge Scheduler** (every 15 min, 03:15 UTC nightly, 07:00 Melbourne cost email) | `runScheduled()` in `apps/worker/src/index.ts`; maintenance actions in `index.ts` | Token refresh, nightly reconcile, Shopify checks, cost email, migrations | 0.00 | Schedules in the worker (pg-boss `schedule`, one run per tick however many workers); maintenance actions as a CLI (`docker compose run`) | Low–medium | Migrations run with the owner login only | Restart between ticks: the next tick still runs; a tick never runs twice |
| **Lambda** `cognito-email` + **KMS** key | `apps/aws/src/cognitoEmail.ts` | Sign-up and reset codes, sent through Resend | 1.15 (KMS) | **Stays on AWS** with Cognito (see Cognito) | — | — | — |
| **Lambda** `migrate-before-live`, `evolution-db-init` | `infra/cdk/lib/migrate-before-live.ts`, `evolutionDb.ts` | Deploy gate: migrations before the switch; WhatsApp DB role | 0.00 | Steps of the deploy script | Low | — | Deploy with a failing migration rolls back |
| **RDS PostgreSQL 17.11** (db.t4g.micro Multi-AZ, 20 GB, databases `app` + `evolution`) | `packages/db`, `data-stack.ts` | **All customer data**, WhatsApp sessions | 44.54 | `postgres` container (PostgreSQL 17), WAL archiving + nightly dumps off the server | High | Not published on any port; roles and RLS unchanged; encrypted off-server backups | Row counts per table, migrations equal, RLS present, restore test |
| **DynamoDB** `coord` | `dynamoCoord.ts` | Rate limits, OAuth state, locks, signed-out sessions | 0.14 | `redis` container (append-only file on) | Low | Internal network only, password | Unit tests of the `Coord` contract against Redis |
| **S3** `payloads` (7 days) | `s3Blobs.ts`; `routes/webhooks.ts`, `whatsapp/send.ts` | Large webhook bodies, WhatsApp media awaiting send | 0.43 (all buckets) | Files on a volume, pruned after 7 days | Low | Volume private to the containers | Large webhook round trip |
| **S3** `site` | CDK `app-stack.ts` | UI build files, outage page | (above) | Served by the `app` container from its image (`local.ts` already does this) | Low | — | Page loads, cache headers |
| **S3** `artifacts`, CloudTrail, access logs, CDK assets | CDK | Database dumps (30 days), audit logs | (above) | Backups go **off the server** (Cloudflare R2 proposed); the rest leaves with AWS | Low | Encrypted before upload | Weekly automatic restore test |
| **Cognito** user pool + `auth.bizinsights.io` | `apps/api/src/cognito.ts`, `infra/aws/cognito.yaml` | Sign-in: password, emailed code, Google; 72 users | 0.00 | **Recommended: keep** (free up to 10,000 monthly users). Cognito never exports password hashes, so leaving means every user resets or a lazy migration (matrix) | High to replace | Admin calls with a dedicated IAM user limited to this pool | Password, email code, Google sign-in, reset, sign-out |
| **SES** | `sesMailer.ts` | Unused fallback; **Resend** sends every email (`mailers.ts`) | 0.00 | Nothing: Resend stays | — | — | — |
| **End User Messaging SMS** (sandbox, sender `BIZTEST`) | `smsProvider.ts` | Customer Messaging SMS | 0.00 (per message) | Owner's choice: keep (per message, needs an IAM user key) or another SMS provider | Low–medium | IAM user limited to `sms-voice` send | Sandbox send + delivery event |
| **SNS** `alarms`, `sms-events` | CDK only | Alarm emails; SMS delivery events → SQS | 0.00 | Alarms: Alertmanager. SMS events: an HTTPS subscription to the app if SMS stays on AWS | Low | SNS message signatures verified | Test alert; test SMS event |
| **Secrets Manager** (6) + **SSM** `/insights/production/runtime` | `secrets.ts` | Every secret and runtime setting | 2.43 | An env file on the server (mode 600) + an encrypted copy off the server | Medium | Never in Git, logs or chat; exported by a script that prints names only | `config` action: every provider configured |
| **CloudFront** (2) + viewer-request function + origin secret | `app-stack.ts`, `viewer-request.ts`, `cloudflare.ts` | Edge, caching, outage page failover, client IP | 0.00 | Cloudflare (already in front) + **Cloudflare Tunnel** to the server | Medium | No inbound port opened on the server | Client IP and geo headers, outage behaviour |
| **WAF** (us-east-1) | `edge-stack.ts` | Per-IP limits, managed rules | 10.08 | Cloudflare's free managed rules + one rate-limit rule; the app's own per-IP limits stay | Low | — | Rate limit trips at the set rate |
| **EC2** NAT instances ×2, admin host (stopped) | `nat-instances.ts`, `data-stack.ts` | Internet access for the functions | 18.34 | Not needed: the server reaches the internet directly | — | — | — |
| **ECS Fargate** (Evolution API) + Cloud Map + Route 53 private zone | `whatsapp-stack.ts` | WhatsApp QR linking and sends | 17.79 | `evolution` container, same pinned image, on the internal network | Medium | Internal only; API key | Linked numbers stay linked after the move |
| **CloudWatch** (36 alarms, 11 metric filters, logs 90 days) | CDK stacks | Paging, logs | 1.68 | Prometheus + Alertmanager + Grafana + Loki, plus an external uptime check | Medium | Grafana behind Cloudflare Access | Each alert fired once |
| **X-Ray** | — | — | 0.46 → 0 | Already switched off (#343) | — | — | — |
| **GuardDuty** (trial to ~15 Nov) | console | Threat detection | 0 → ~9.39 | Off at decommission; server: fail2ban, firewall, updates | — | — | — |
| **CloudTrail** | `audit-stack.ts` | Audit of AWS actions | 0.00 | Stays while any AWS resource stays (Cognito, SMS) | — | — | — |
| **Cost Explorer** | `costReport.ts` | Owner's daily AWS cost email | 0.30 | Keep while AWS has spend, or drop | Low | IAM user `ce:GetCostAndUsage` only | Email arrives |
| **Support plan** Business Support+ | — | Nothing in the app | 29.00 | Basic (free), allowed from ~2026-11-14, migration or not | — | — | — |
| **CloudFormation / CDK**, GitHub OIDC deploy role | `infra/cdk`, `.github/workflows/aws-deploy.yml` | Deploys | 0.00 | Compose + a deploy script over SSH | Medium | Deploy key restricted on the server | Deploy, failed health check rolls back |

## Not used, so nothing to replace

EC2 application servers, ElastiCache, API Gateway, Step Functions, EventBridge rules or buses,
NAT Gateway, load balancers, ECR, AWS Backup, Elastic IPs. Public DNS is at Cloudflare, not Route 53.

## Not files, despite the brief's list

S3 holds **no customer uploads, product images, reports, PDFs or exports**: the only objects are
transient webhook bodies and WhatsApp media waiting to be sent (both deleted after use, 7 days at
most), the UI build, and database dumps. So MinIO's feature list (signed upload URLs, per-tenant
buckets) has nothing to serve today; the `BlobStore` interface stays, so an object store can be
plugged in the day a feature needs one.
