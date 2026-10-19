# bizinsights on AWS: architecture

bizinsights runs entirely on AWS, region **ap-southeast-2 (Sydney)**. This document is the design and
its reasoning; it has been built and runs since 2026-10-15. What actually runs, under which names, is
in [aws-deployment.md](aws-deployment.md), which wins where the two differ (for example, the domain
bizinsights.io has its DNS at Cloudflare, not Route 53; pages come from the `api` function and only the
build files from S3; there is no RDS Proxy or CodeDeploy canary yet). Sign-in:
[cognito-setup.md](cognito-setup.md). (The Phase 1 CloudShell staging template, `infra/aws/staging.yaml`, was never deployed and was removed on 2026-10-18; a staging environment would be `cdk deploy -c env=staging`.)

Principles:

- **Same application code.** The API (Hono), the jobs (`apps/worker`), the domain logic
  (`packages/core`), the database layer (`packages/db`, Prisma) and the UI know nothing of AWS. Only
  the platform adapters do, in `apps/aws`; `apps/aws/src/local.ts` runs the same app on one machine
  for development, with in-process queues and an in-memory coordinator.
- **Managed services, no servers to patch.** Lambda, RDS, SQS, DynamoDB, S3, CloudFront.
- **Private by default.** The database sits in isolated subnets; functions reach it through RDS
  Proxy; the API is reachable only through CloudFront and WAF.
- **Everything as code.** One AWS CDK app (TypeScript, like the rest of the repo), one copy per
  environment, deployed from GitHub Actions with short-lived credentials (OIDC).

## 1. What runs where

| Used for | On AWS | Why this service |
| --- | --- | --- |
| The web UI (Next.js static export) | **S3** (private) + **CloudFront** (Origin Access Control) | Static files at the edge, cached; no compute. |
| `/api/*`, `/webhooks/*`, `/pixel/*`, `/shopify/*`, health (the Hono API) | **Lambda** (Node 22, arm64) behind **CloudFront** (function URL origin) | Per-request code; scales to zero. Only requests carrying CloudFront's secret origin header are served (section 2). |
| The app's address | A custom domain + **ACM** certificate: https://bizinsights.io since 2026-10-16 (DNS at Cloudflare, not Route 53) | A custom domain is what Google's OAuth app verification asks for. |
| Coarse API flood protection (300 requests/min/IP) | **AWS WAF** rate-based rule on CloudFront, plus AWS managed rule groups | Blocks floods before they cost a Lambda invocation. |
| Per-key rate limits, one-time OAuth state, locks, signed-out sessions, export grants (the coordinator) | **DynamoDB** table (on-demand, TTL) | `apps/aws/src/dynamoCoord.ts`; the local server keeps it in memory. |
| Webhook bodies too big for a queue message (over 100 KB) | **S3** bucket `payloads` (7-day lifecycle) | Only the rare large body; the message carries its key. |
| Background jobs (sync, webhooks, aggregate, email), retries with backoff | **SQS** standard queues + a DLQ; **Lambda** consumers (event source mappings) | At-least-once delivery; the handlers are idempotent (below). |
| `*/15 * * * *`: token refresh, stale jobs, ads sync, WhatsApp, open shifts, email sweeps; `15 3 * * *`: nightly reconcile | **EventBridge Scheduler** → the `scheduled` Lambda | Managed cron, UTC. |
| Connection pooling to Postgres (two logins: the owner role and the RLS role) | Capped Lambda concurrency first; **RDS Proxy** when traffic needs it | Pools Lambda's many short connections; see section 4 for the pinning check it needs first. |
| All data | **RDS for PostgreSQL 17** (encrypted, automated backups, point-in-time restore) | No single machine to keep running (the old deployment's database on the owner's PC went down when Docker Desktop stopped). |
| Invitations, alerts, staff emails | **Amazon SES** (domain identity with DKIM/SPF/DMARC) | Also Cognito's sender (raises the 50/day limit) and enables passwordless codes. |
| Merchants' own SMTP accounts (email integrations) | Node `net`/`tls` from Lambda through the NAT gateway | Plain outbound TCP; ports 465/587/2525. |
| Logs, traces | **CloudWatch Logs**, metric filters, alarms, **X-Ray** (sampled) | One place for logs, metrics and alarms. |
| Sign-in | **Cognito** (Phase 1) | Replaced Firebase Authentication; since 2026-10-18 the app never calls Firebase ([cognito-setup.md](cognito-setup.md), section 4). |
| Session, encryption, OAuth client secrets | **Secrets Manager** (+ **KMS** key) | Read at cold start; rotation for database passwords. |
| Safe deploys, instant rollback | **Lambda versions + aliases** with **CodeDeploy** canary | 10% for 5 minutes, automatic rollback on alarms. |
| Backups | RDS automated backups (14 days) + **AWS Backup** monthly copy | Point-in-time restore to any second. |
| Live dashboards (push updates; on an unmerged branch) | **AppSync Events** (managed WebSocket pub/sub), or keep polling | Decide when that branch lands; polling works meanwhile. |

Third parties (Shopify, Meta Graph/WhatsApp Cloud API, Google Ads/AdSense, Gmail/Microsoft Graph,
Slack) call back on the app's address (section 7).

## 2. Target architecture

```
                         Route 53  app.<domain>  (+ auth.<domain> for Cognito's managed login)
                                │
            ┌───────────────────▼──────────────────────┐
            │ CloudFront  (ACM cert, HTTP/2+3)         │◄── AWS WAF: managed rules, 300 req/min/IP
            │  default        → S3 "web" (UI)          │
            │  /api/* /webhooks/* /pixel/* /shopify/*  │
            │                 → Lambda "api" (+secret) │
            └──────────┬───────────────────────────────┘
                       │
   ┌───────────────────▼──────────────────── VPC (2 AZs) ─────────────────────────────────┐
   │ private subnets                                                                      │
   │  Lambda api ───────┐        Lambda consumers (sync, webhooks, aggregate, email)      │
   │  Lambda scheduled ─┼──────► (RDS Proxy) ─► RDS PostgreSQL 17  (isolated subnets)     │
   │  Lambda migrate ───┘                                                                 │
   │        │  gateway endpoints: S3, DynamoDB (free)                                     │
   │        └─► NAT gateway (public subnet) ─► Cognito, Shopify, Meta, Google, Microsoft, │
   │                                            SMTP servers, Slack, Secrets Manager, SQS │
   └──────────────────────────────────────────────────────────────────────────────────────┘
        │                 ▲                        │
        ▼                 │                        ▼
   SQS queues ───► event source mappings      DynamoDB "coord" (rate limits, OAuth state, locks)
   (+ DLQs)                                   S3 "payloads" (large webhook bodies)
   EventBridge Scheduler ─► Lambda scheduled  Secrets Manager + KMS
   Cognito user pool (Google, email) ─► SES (verified domain) ─► people's inboxes
   CloudWatch Logs / metrics / alarms ─► SNS ─► email (+ Slack via Amazon Q Developer in chat apps)
```

### Request paths

- **Pages**: browser → CloudFront → S3. Hashed `/_next/static/*` cached for a year; HTML not cached.
  Security headers (the ones in `public/_headers`) from a CloudFront response headers policy.
- **API**: browser → CloudFront (+WAF) → Lambda `api` function URL. CloudFront adds a secret
  `x-origin-verify` header (value in Secrets Manager, rotated) and the app answers 403 without it, so
  the function URL can't be used to go around WAF. (CloudFront's origin access control for function
  URLs is not used: it requires every POST to carry a SHA-256 of its body in `x-amz-content-sha256`,
  which Shopify, Meta and browsers don't send.) Forwarded: all viewer headers except `Host`
  (`AllViewerExceptHostHeader`), cookies and query strings; nothing cached. Same origin as the UI, so
  sessions stay first-party. The client IP is the address CloudFront saw (a viewer-request function
  passes it on; the API reads it as `x-insights-client-ip`), trusted only on requests that carry the
  origin secret.
- **Shopify webhooks**: Shopify → `/api/webhooks/shopify` (HMAC-checked) → SQS `webhooks`.
  Later option: Shopify's native **Amazon EventBridge** delivery (no public endpoint, no HMAC).
- **Web pixel**: storefront → `/api/pixel/*`. The WAF rate rule leaves `/pixel/*`, `/webhooks/*` and the
  health checks out of the per-IP limit, exactly as `GLOBAL_LIMIT_EXEMPT` does in the app.
- **Sign-in**: as built in Phase 1, with Cognito's managed login on `auth.<domain>` (custom domain)
  and SES as its email sender.

### Background work

| Queue | Batch | Max concurrency | Visibility timeout | Retries → DLQ |
| --- | --- | --- | --- | --- |
| sync | 1 | 4 | 15 min | 6 receives |
| webhooks | 10 (2 s window) | 10 | 2 min | 6 |
| aggregate | 5 (1 s) | 4 | 5 min | 6 |
| email | 10 (2 s) | 5 | 2 min | 6 |

What is built is smaller while the account's Lambda concurrency is 10 (`sources` in
`infra/cdk/lib/app-stack.ts`; a message goes to the DLQ after 10 receives).

A job's `retry({ delaySeconds })` is `ChangeMessageVisibility` (up to 12 h, so the 15-minute
backoff cap fits), `ack()` a successful batch item, `attempts` the message's `ApproximateReceiveCount`
(partial batch failures reported with `ReportBatchItemFailures`). A job that fails while the database
is unreachable spends no attempt (`deferForDb`): it is re-sent as a new message, backing off to every
5 minutes, for up to 24 hours.

EventBridge Scheduler invokes the `scheduled` function at `cron(0/15 * * * ? *)` and
`cron(15 3 * * ? *)` (UTC) with the cron name, which `runScheduled()` already dispatches on.

## 3. Network and security

- **VPC** across two Availability Zones: public subnets (NAT gateway), private subnets (Lambdas,
  RDS Proxy), isolated subnets (RDS, no route out). Gateway endpoints for S3 and DynamoDB (free).
- **NAT**: the functions call the internet (Cognito, Shopify, Meta, Google, SMTP). Built as a NAT
  instance per AZ (t4g.nano, `infra/cdk/lib/nat-instances.ts`) since 2026-10-17: high availability
  for a third of one NAT gateway's price (docs/aws-deployment.md, Fault tolerance).
- **Security groups**: Lambda → RDS (or RDS Proxy) 5432 only; RDS Proxy → RDS 5432 only; nothing inbound
  from the internet to the VPC.
- **IAM**: one role per function, least privilege (its queue, its table, its secrets). Humans sign
  in through IAM Identity Center with MFA; GitHub Actions deploys with an OIDC role. No long-lived
  access keys anywhere (Cognito admin calls use the function role, as built in Phase 1).
- **Encryption**: a customer-managed KMS key for RDS, S3, SQS, Secrets Manager and DynamoDB; TLS on
  every hop (CloudFront ↔ viewer and ↔ Lambda; `rds.force_ssl=1`, verified against Amazon's CA as in Phase 1). Application-level AES-GCM of tokens
  (`TOKEN_ENCRYPTION_KEYS`) and Postgres row-level security stay as they are.
- **Certificates**: ACM certificates for CloudFront and for Cognito's custom domain must be issued in
  **us-east-1** (a CloudFront rule), validated by DNS in Route 53; everything else stays in Sydney.
- **Edge protection**: WAF (AWS managed Common, Known Bad Inputs and IP reputation rule groups, the
  rate rule), Shield Standard (free, automatic).
- **Detection and audit**: CloudTrail (management events, all regions), GuardDuty, IAM Access
  Analyzer; AWS Budgets and Cost Anomaly Detection alerts.

## 4. Data

- **RDS PostgreSQL 17**, gp3 storage with autoscaling, encrypted, deletion protection, 14-day
  automated backups with point-in-time restore, Performance Insights (free tier), Enhanced
  Monitoring every 60 seconds (OS metrics in CloudWatch Logs, `RDSOSMetrics`), parameter group
  with `rds.force_ssl=1`. Single-AZ (lean) or Multi-AZ (high availability, automatic failover).
- **Connections**: two logins in Secrets Manager, `app` (owner: migrations, system paths, jobs) and
  `app_rls` (tenant reads under RLS); passwords rotate through Secrets Manager. Each function
  instance keeps one small pool per role, and Lambda
  concurrency is capped per function (reserved concurrency) so the total stays under the database's
  connection limit (about 80 on db.t4g.micro, 200 on db.t4g.small).
- **RDS Proxy**, added when concurrency outgrows those caps: tenant queries run
  `set_config('app.workspace_id', …, true)` inside each transaction, and RDS Proxy *pins* a connection
  on `set_config`, which would undo its pooling. The setting is transaction-local, the case AWS
  documents as safe for the `EXCLUDE_VARIABLE_SETS` pinning filter; confirm in staging with the
  `DatabaseConnectionsCurrentlySessionPinned` metric before relying on it.
- **Migrations**: the `migrate` function (Phase 1) runs in the pipeline before traffic moves, as
  `prisma migrate deploy` would, with the same `_prisma_migrations` bookkeeping.
- **Database admin access** (psql, restores): an SSM Session Manager port forward through a tiny
  managed instance that is stopped when not in use (no SSH keys, no public database).
- **DynamoDB** `coord`: on-demand, TTL, point-in-time recovery.
- **S3**: `web` (UI build, versioned), `payloads` (7-day lifecycle), `artifacts` (deploy packages),
  `logs` (CloudFront/WAF logs, 90-day lifecycle). All private, encrypted, public access blocked.

## 5. Email

- **SES** in ap-southeast-2: verify the domain (DKIM, SPF, DMARC records in Route 53), request
  production access (leaves the sandbox), one configuration set with bounce and complaint
  notifications → SNS → the app's suppression list (the email module already keeps one).
- Cognito sends through SES (DEVELOPER mode), lifting the 50-a-day default and enabling
  passwordless sign-in codes (`COGNITO_EMAIL_OTP=1`).
- Merchants' connected accounts (Gmail, Microsoft 365, SMTP) keep sending through their own
  providers, exactly as now.

## 6. Observability

- CloudWatch log group per function (JSON lines from the existing logger, 30 days staging / 90 days
  production), Logs Insights saved queries (sign-in failures, job failures, slow requests).
- Metric filters and alarms: Lambda errors and throttles, 5xx at CloudFront, sign-in service
  unavailable, DLQ depth > 0, queue age > 15 min, RDS CPU / free storage / connections (and, with RDS
  Proxy, pinned connections and borrow latency), NAT errors. All → one SNS topic → email (and Slack).
- One CloudWatch dashboard per environment; X-Ray tracing at 10% sampling.
- A CloudWatch Synthetics canary loading the sign-in page and `/api/readyz` every 5 minutes.

## 7. Integrations on the app's address

The app's address is `https://bizinsights.io` since 2026-10-16 (pages asked for on
`d2mr8m2p1qkh58.cloudfront.net` or on www are redirected there). Every OAuth callback is built from
`APP_URL`, so each provider must have exactly these registered; how each one stands is in
[aws-deployment.md](aws-deployment.md), "Owner-only steps".

| Integration | On bizinsights.io | Where |
| --- | --- | --- |
| Shopify (the main app and each other app: pixmagic, public, appstore) | `application_url`, `redirect_urls`, webhook `uri` → `https://bizinsights.io/api/...` (in every toml) | `shopify-app/shopify.app*.toml`, then `shopify app deploy` |
| Shopify web pixel extension | Posts to the `API_URL` it was given when it was made (the `after-move` action re-points older pixels) | `shopify-app/extensions/insights-pixel` |
| Meta (Ads login, WhatsApp) | Redirect URI `https://bizinsights.io/api/ads/meta/callback`; WhatsApp webhook callback `https://bizinsights.io/api/webhooks/whatsapp` and its verify token | Meta app dashboards |
| Google (Ads, AdSense) | Redirect URIs `https://bizinsights.io/api/ads/google/callback` and `.../adsense/callback`; domain verification for the consent screen (fixes "unverified app"): a Search Console **Domain** property for bizinsights.io, whose TXT record goes in Cloudflare DNS | Google Cloud console, Search Console |
| Google sign-in (Cognito) | Redirect URI `<the user pool's domain>/oauth2/idpresponse` | Google Cloud OAuth client ([cognito-setup.md](cognito-setup.md)) |
| Microsoft and Gmail (email integrations) | Redirect URIs `https://bizinsights.io/api/email/oauth/microsoft/callback` and `.../google/callback` | Microsoft Entra app registration, Google Cloud OAuth client |
| Cognito app client | Callback `https://bizinsights.io/auth/callback`, logout `…/login?signedOut=1` | `infra/aws/cognito.yaml` (`AppUrl`) |
| Slack alerts | none | — |

## 8. Environments, code and delivery

- **Accounts**: an AWS Organization with separate `production` and `staging` accounts (blast radius,
  billing per environment, cleaner IAM); a single account with separate stacks also works.
- **Infrastructure as code**: AWS CDK v2 app in `infra/cdk/` (TypeScript), stacks per concern so
  they change independently:

| Stack | Contents |
| --- | --- |
| `Network` | VPC, subnets, NAT, endpoints, security groups |
| `Data` | RDS (+ RDS Proxy later), DynamoDB, S3 buckets, KMS key, database secrets |
| `Auth` | Cognito (replaces `infra/aws/cognito.yaml`), SES identity |
| `Messaging` | SQS queues and DLQs, EventBridge schedules, SNS alarm topic |
| `App` | The Lambda functions, aliases, CodeDeploy, CloudFront, WAF, Route 53 records |
| `Observability` | Dashboards, alarms, canary, budgets |

- **Code in `apps/aws`** (alongside what Phase 1 built): handlers `api` (no static files any more),
  `consumer` (SQS → `consume()`), `scheduled` (EventBridge → `runScheduled()`), `migrate`; adapters
  `sqsQueues` (Producer → SendMessage, payloads over 1 MiB to S3 via the existing BlobStore),
  `originVerify` (the 403 check above),
  `s3Blobs`, `sesMailer` (SES v2), `nodeSmtpConnect` (net/tls), client IP from the viewer-request
  function's header.
- **Pipeline** (GitHub Actions, OIDC): checks as today → build → `cdk deploy` staging → `migrate` →
  Playwright smoke against staging → manual approval (GitHub environment) → production: `migrate`,
  then the new Lambda versions shift traffic 10% → 100% over 5 minutes, rolled back automatically if
  an alarm fires. The UI deploys to S3 with a CloudFront invalidation of HTML only.

## 9. Migration plan

Phase 1 (Cognito, isolated staging) and the AWS deployment itself are built. What is left is moving
production's data and traffic over: the final data copy in a short maintenance window
(`infra/cdk/scripts/migrate-data.mjs`: dump, restore to RDS, compare row counts per table),
re-pointing every integration (section 7), turning the schedules on, and after two quiet weeks
retiring the old deployment and Firebase Auth. The steps, their order and the rollback are in
[aws-deployment.md](aws-deployment.md) ("Cutover" and
[retiring the old deployment](aws-deployment.md#retiring-the-old-cloudflare-deployment)).

## 10. Cost (approximate, ap-southeast-2 on-demand, US$/month; confirm in the AWS Pricing Calculator)

| Item | Lean | High availability |
| --- | --- | --- |
| RDS PostgreSQL (db.t4g.small, 50 GB gp3, backups) | ~35 | ~70 (Multi-AZ) |
| RDS Proxy | — (later) | ~25 |
| NAT gateway (+ data) | ~45 | ~90 (one per AZ) |
| Lambda, SQS, DynamoDB, EventBridge, S3 | ~5-15 | ~5-15 |
| CloudFront + WAF | ~10-15 | ~10-15 |
| Secrets Manager, KMS, Route 53, CloudWatch, GuardDuty, canary | ~25-35 | ~25-35 |
| SES | $0.10 per 1,000 emails | same |
| **Total** | **~120-145** | **~225-260** |

Staging (approved separately) stays ~US$20-25. The domain itself is ~US$15/year. Biggest levers:
RDS Proxy only when needed (lean starts without it, as the Phase 1 staging does), and one NAT
instead of two.

## 11. Decisions for the owner

1. **The domain** (e.g. `app.<company domain>`): the app runs without one, but Google's OAuth app
   verification needs it ([ads-review-packs.md](ads-review-packs.md)).
2. **Lean or high availability** for production (the table above).
3. **One AWS account or an Organization** with production/staging accounts (recommended).
4. **Live updates**: AppSync Events now, or keep polling until the push-updates branch merges.
5. Whether to adopt **Shopify → EventBridge** webhook delivery after the move.

## 12. Risks

- **Shopify URL change** is visible to merchants only as a re-launch; webhooks pause for the minutes
  between `shopify app deploy` and traffic reaching AWS (Shopify retries for 48 hours).
- **Cold starts**: Prisma's client costs ~25 ms CPU per new instance; with arm64 at 1 GB a cold API
  call is ~0.5-1 s. Provisioned concurrency of 1-2 on the `api` alias removes it (~US$10-20/month).
- **Connection limits**: without RDS Proxy, a traffic spike beyond the reserved-concurrency caps is
  throttled (requests get 429s, queue work waits) rather than exhausting the database.
- **Data move**: depends on the PC's Postgres being up for the dump (it was down on 2026-10-15).
