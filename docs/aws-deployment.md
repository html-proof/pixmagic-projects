# Insights on AWS: deployment runbook

How the AWS copy of Insights is built, deployed, filled with data, tested, rolled back and, at
cutover, made the real production. The design and its reasoning are in
[aws-architecture.md](aws-architecture.md); sign-in in [cognito-setup.md](cognito-setup.md).

Account `605411278365`, region `ap-southeast-2` (Sydney); the WAF web ACL lives in `us-east-1`
(a CloudFront rule). Everything is AWS CDK (TypeScript) in `infra/cdk`.

## What runs where

| Piece | AWS | Code |
| --- | --- | --- |
| UI + API | Lambda `insights-production-api` (function URL, alias `live`) behind CloudFront + WAF | `apps/aws/src/index.ts` |
| Background jobs | SQS `insights-production-{sync,webhooks,aggregate,email}` + `-dlq` → Lambda `insights-production-jobs` | `apps/aws/src/consumer.ts`, `sqsQueues.ts` |
| Schedules | EventBridge Scheduler `*/15` and `03:15 UTC` → Lambda `insights-production-cron` (**off until cutover**) | `runScheduled()` in `apps/worker` |
| Database | RDS PostgreSQL 17 `insights-production` (db.t4g.small, single AZ, private, encrypted, 14-day PITR) | `infra/cdk/lib/data-stack.ts` |
| Coordinator | DynamoDB `insights-production-coord` | `apps/aws/src/dynamoCoord.ts` |
| Large webhook bodies | S3 `insights-production-payloads-605411278365` (7-day lifecycle) | `apps/aws/src/s3Blobs.ts` |
| Dumps, artifacts | S3 `insights-production-artifacts-605411278365` (30 days, versioned) | `infra/cdk/scripts/migrate-data.mjs` |
| Sign-in | Cognito pool `insights-production` (from `infra/aws/cognito.yaml`) | `apps/api/src/cognito.ts` |
| App email | SES (needs a verified sender, below) | `apps/aws/src/sesMailer.ts` |
| Secrets | Secrets Manager `insights/production/{app,db-owner,worker-cognito}`; settings in SSM `/insights/production/runtime` | `apps/aws/src/secrets.ts` |
| Logs, alarms | CloudWatch (90 days), dashboard `insights-production`, SNS `insights-production-alarms`, budget US$150/month | `infra/cdk/lib/app-stack.ts` |
| DB admin | EC2 `insights-production-admin` (t4g.nano, Systems Manager only, normally **stopped**) | `infra/cdk/lib/data-stack.ts` |

Redis/ElastiCache is not used: the app has no Redis; DynamoDB does its coordination. There are no
file uploads (exports are generated on request), so S3 holds only webhook bodies and dumps.

## Deploy (from a PC)

Windows PowerShell, from the repository root. Sign in first (temporary credentials, up to 12 h):

```powershell
aws login --region ap-southeast-2
```

```powershell
pnpm install
pnpm --filter @app/aws build
cd infra/cdk
npx cdk deploy --all --require-approval never
```

Then, after the first deploy or a change of secrets:

```powershell
node infra/cdk/scripts/put-secrets.mjs --from C:\Users\Seban\Videos\saas-project2.0\.env
```

It copies the values that must equal production's (TOKEN_ENCRYPTION_KEYS decrypts every stored
store and ad-platform token; OTP_PEPPER keys stored customer hashes; SHOPIFY_API_SECRET), generates
SESSION_SECRET and APP_RLS_PASSWORD, and prints key names only. A secret only its owner has
(META_APP_SECRET, GOOGLE_ADS_CLIENT_SECRET, WHATSAPP_APP_SECRET, ...): copy it to the clipboard and run

```powershell
node infra/cdk/scripts/put-secrets.mjs --set META_APP_SECRET
```

The functions read secrets at cold start; after changing one, force fresh instances with a deploy
(or `aws lambda update-function-configuration --function-name insights-production-api --description refresh`).

If Node's connections time out on this PC's network (IPv6-only hotspot with NAT64), set
`$env:NODE_OPTIONS = "--network-family-autoselection-attempt-timeout=5000"` first.

## Deploy (GitHub Actions)

`.github/workflows/aws-deploy.yml` runs after CI passes on `main` (or by hand): build → `cdk
deploy` → migrate → smoke tests → automatic rollback of the `live` aliases if anything fails. It
signs in with GitHub OIDC (role in the `InsightsCi-production` stack), no AWS keys in GitHub.
One-time setup in the repository's Settings → Environments → `production`: variable
`AWS_DEPLOY_ROLE_ARN` (the stack's `DeployRoleArn` output), optional `AWS_ALERT_EMAIL`,
`GOOGLE_SIGNIN_CLIENT_ID`, `AWS_SCHEDULES` (`on` after cutover), and required reviewers.

## Database

- Copy production's data in (read-only on the PC; refuses a non-empty target):
  `node infra/cdk/scripts/migrate-data.mjs`. It backs up to `C:\Users\Seban\insights-backups`,
  restores through the admin host, runs the migrate action, compares exact row counts per table
  and stops the host. `--replace` wipes the AWS copy first (the final copy at cutover).
- Migrations after a deploy: `aws lambda invoke --function-name insights-production-cron:live
  --cli-binary-format raw-in-base64-out --payload '{"action":"migrate"}' out.json`.
- psql: start the admin host, then `aws ssm start-session --target <instance id>` (needs the Session
  Manager plugin), credentials from the `insights/production/db-owner` secret. Stop it afterwards.
- Restore: RDS point-in-time restore (any second in the last 14 days) to a new instance, or a dump
  from the artifacts bucket through the admin host.

## Test

`node infra/cdk/scripts/smoke.mjs` checks, from outside: pages, 404, edge caching, security
headers, HTTPS redirect, `/api/readyz` (database as owner and tenant role, coordinator), 401 on
protected routes, the Cognito wiring (a password-reset request for an address that doesn't exist),
CSRF, CORS, Shopify HMAC refusal, that the function URL refuses requests that skip CloudFront, and
on the AWS side: database private and encrypted, buckets private, functions healthy, DLQ empty.
Sign-up and sign-in with a real address are the owner's to try (they need a mailbox).

## Roll back

`node infra/cdk/scripts/rollback.mjs` moves the `live` aliases of api, jobs and cron to the previous
version (UI included, it ships in the api package). The next deploy moves them forward again.
Infrastructure: `cdk deploy` of the previous commit. Data: point-in-time restore.

## Cutover (owner's go-ahead needed; not done yet)

0. **Customer hashes.** Production's OTP_PEPPER is a Cloudflare secret that can't be read back, and
   the copy on this PC is a placeholder, so the AWS copy runs with its own (`put-secrets.mjs
   --generate OTP_PEPPER`). Stored customer hashes (orders' `customer_key`, WhatsApp contacts'
   phone hash, which is how a STOP opt-out is found) were made with production's. Before cutover,
   either put production's value in as `CUSTOMER_HASH_KEY` (`put-secrets.mjs --set CUSTOMER_HASH_KEY`
   if the owner has it), or re-key the hashes from the stored (encrypted) values. Until then, repeat
   customers would be counted as new and an opted-out number would not be recognised.
1. Final copy: pause writes on Cloudflare (or accept a short gap), `migrate-data.mjs --replace`.
2. Turn the schedules on: `npx cdk deploy InsightsApp-production -c schedules=on`.
3. Point every integration at the AWS address (aws-architecture.md section 7): Shopify app URLs and
   webhooks (`shopify app deploy`), Meta and Google redirect URIs, WhatsApp webhook, Cognito's
   Google/Apple identity providers.
4. Watch the dashboard and alarms; keep Cloudflare as the rollback for two quiet weeks, then retire it.

## Owner-only steps

- **Alerts**: an email address for alarms and the budget (`-c alertEmail=...`; confirm the SNS email).
- **SES**: verify a sending domain (DKIM records at its DNS host, Cloudflare for ikorex.com.au) and
  request production access; until then SES only sends to verified addresses and app emails fail
  as they do on Cloudflare today (EMAIL_FROM is a placeholder).
- **Google sign-in**: add `https://insights-605411278365.auth.ap-southeast-2.amazoncognito.com/oauth2/idpresponse`
  to a Google OAuth client, put its secret with `put-secrets.mjs --set GOOGLE_SIGNIN_CLIENT_SECRET`,
  deploy with `-c googleClientId=<client id>`.
- **Apple sign-in**: needs an Apple Developer Program membership (Services ID, key).
- **Provider secrets** not on this PC: META_APP_SECRET, GOOGLE_ADS_CLIENT_SECRET, WHATSAPP_APP_SECRET,
  WHATSAPP_WEBHOOK_VERIFY_TOKEN, SHOPIFY_APP_SECRET_PIXMAGIC (`put-secrets.mjs --set`).
- **Custom domain** (optional): Route 53 or Cloudflare DNS + an ACM certificate in us-east-1.

## Cost (lean tier, US$/month, on-demand, approximate)

Prices from the AWS Price List API on 2026-10-15: NAT gateway $0.059/hour + $0.059/GB (~45 with
its public IPv4), RDS db.t4g.small $0.051/hour (~37) + 20 GB gp3 (~3), WAF (web ACL + 4 rules) ~10,
CloudWatch alarms/dashboard/logs/X-Ray ~6-10, Secrets Manager ~1.2, GuardDuty ~1-4 (free for the
first 30 days), admin host stopped ~1, Lambda/SQS/DynamoDB/S3/CloudFront/Cognito at today's traffic
~0-5 (free tiers): **~US$105-120**, within the approved US$120-145. Budget alarm at US$150 (80%
actual, 100% forecast, once an alert email is set). Biggest levers: the NAT gateway and the
database size. Cost allocation tags `app` and `environment` can be activated in Billing once AWS
has seen them (up to 24 hours after the first deploy).
