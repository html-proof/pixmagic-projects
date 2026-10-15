# Insights on AWS: deployment runbook

How Insights on AWS is built, deployed, filled with data, tested, rolled back and, at cutover,
made the only production (the old Cloudflare deployment still serves merchants until then, see
[Retiring the old Cloudflare deployment](#retiring-the-old-cloudflare-deployment)). The design and its reasoning are in
[aws-architecture.md](aws-architecture.md); sign-in in [cognito-setup.md](cognito-setup.md).

Account `605411278365`, region `ap-southeast-2` (Sydney); the WAF web ACL lives in `us-east-1`
(a CloudFront rule). Everything is AWS CDK (TypeScript) in `infra/cdk`.

## What runs where

| Piece | AWS | Code |
| --- | --- | --- |
| UI + API | Lambda `insights-production-api` (function URL, alias `live`) behind CloudFront + WAF | `apps/aws/src/index.ts` |
| UI build files | `/_next/static/*` from S3 `insights-production-site-605411278365` (CloudFront OAC, uploaded by `cdk deploy`, old builds kept) | `infra/cdk/lib/app-stack.ts` |
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
The role trusts the token's `sub` exactly as this repository sends it: the immutable form
`repo:html-proof@68529971/pixmagic-projects@1413246051:environment:production` (`githubOidcSubject`
in `infra/cdk/lib/config.ts`). "Not authorized to perform sts:AssumeRoleWithWebIdentity" in the
workflow means the two differ: compare with CloudTrail's AssumeRoleWithWebIdentity events.

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

Before the window: provider secrets the stores in use need (`SHOPIFY_APP_SECRET_PIXMAGIC` for the
PixMagic store's webhooks, `GOOGLE_ADS_CLIENT_SECRET` for AdSense refreshes) set with `put-secrets.mjs
--set`, and the AWS redirect URIs added at Google. The Cloudflare commands below run from
`apps/cloudflare` in a checkout of the old code ([below](#retiring-the-old-cloudflare-deployment)).

1. **Freeze the old site.** Remove its cron triggers (Cloudflare API `PUT
   /accounts/<account>/workers/scripts/insights/schedules` with `[]`; put back with
   `[{"cron":"15 3 * * *"},{"cron":"*/15 * * * *"}]`), let its queues drain, then deploy the stand-in
   Worker (`apps/cloudflare/moved/index.ts` in the old code) in maintenance: `npx wrangler versions
   upload --config moved/wrangler.jsonc --var MOVE_PHASE:maintenance`, then `npx wrangler versions
   deploy <that version>@100% -y`. Pages say "moving", the API answers 503 + Retry-After, so Shopify
   holds webhooks. From here the PC database no longer changes.
2. **Final copy:** `node infra/cdk/scripts/migrate-data.mjs --replace` (wipes the AWS copy first).
3. **Schedules on:** GitHub variable `AWS_SCHEDULES=on`, then the next Deploy to AWS (the merge of the
   Shopify URL change in step 4) turns them on.
4. **Shopify:** `application_url`, `redirect_urls` and webhook `uri` in `shopify-app/shopify.app.toml`
   and `shopify.app.pixmagic.toml` → the AWS address, merged, then `shopify app deploy` and
   `shopify app deploy --config pixmagic` (owner's Shopify login).
5. **Old address forwards:** the same stand-in with `--var MOVE_PHASE:forward`, deployed at 100%:
   pages and launches redirect to AWS; webhooks and pixel events are passed through unchanged.
6. **Repair:** `aws lambda invoke --function-name insights-production-cron:live --cli-binary-format
   raw-in-base64-out --payload '{"action":"after-move"}' out.json`. Every store's web pixel is pointed
   at the new address (its URL was fixed when it was made), and every store's orders are re-imported,
   which re-keys customer hashes with this deployment's CUSTOMER_HASH_KEY (the old deployment's
   OTP_PEPPER is a Cloudflare secret that can't be read back) and recomputes repeat customers. WhatsApp contacts'
   phone hashes are not re-keyed by this: with contacts present, carry production's value over as
   `CUSTOMER_HASH_KEY` instead.
7. Smoke tests, the owner signs in (a Cognito account links to the copied user by its verified
   email; Firebase password accounts move on first sign-in), stop the admin host. Other integrations
   (Meta, WhatsApp webhook, email providers, Cognito's Google) when they are in use
   (aws-architecture.md section 7).
8. Watch the dashboard and alarms; keep Cloudflare as the rollback for two quiet weeks, then retire it
   (below).

**Rollback:** from the old code, `npx wrangler versions deploy <the app's version>@100% -y`, put its
crons back, and `shopify app deploy` with the old URLs; copy back anything written on AWS in between.

## Retiring the old Cloudflare deployment

The repository no longer contains anything for Cloudflare: the Worker (`apps/cloudflare`), its
stand-in for the move (`apps/cloudflare/moved`), `wrangler`, the `cloudflared` service in
docker-compose.yml and the Cloudflare deployment guide were removed after commit **`a861bd9`**, the
last one that has them. Until it is retired, this is still running outside the repository:

- Cloudflare account `b45818e0a9b504baa7a9862d43827456`: the Worker `insights` at
  https://insights.imeseban.workers.dev (with its Durable Object `Coordinator` and its two cron
  triggers), the queues `insights-sync`, `insights-webhooks`, `insights-aggregate`, `insights-email`
  and `insights-dlq`, two Hyperdrive configurations (`eec0593e76144cbcb0c4bb653a0cb647`,
  `5646bc5ea5424144bf2f12167be10dec`) and the tunnel they reach the database through.
- On the owner's PC: Docker containers `saas-project20-postgres-1` (port 5434, database `app`: the
  old deployment's production data) and `saas-project20-cloudflared-1` (the tunnel). Both restart
  on their own; nothing in this repository starts or stops them. In that checkout, don't run
  `docker compose down` or `--remove-orphans`, and leave the postgres service's settings alone.

For the cutover steps and the rollback above, check out the old code beside this one:

```powershell
git worktree add ..\insights-cloudflare a861bd9
cd ..\insights-cloudflare
pnpm install
cd apps\cloudflare
```

Wrangler commands run from that `apps\cloudflare` folder (`npx wrangler login` first). Never deploy
that checkout's whole app to Cloudflare: its sign-in and settings are older than what runs there.

Retiring it, on the owner's go-ahead, once AWS has been production for two quiet weeks:

1. Last backup of the PC database: `node infra/postgres/backup.mjs` (it writes to
   `C:\Users\Seban\insights-backups`).
2. From the old checkout's `apps\cloudflare`: `npx wrangler delete insights` (the Worker, its Durable
   Object and crons), `npx wrangler queues delete <name>` for each queue above, `npx wrangler
   hyperdrive delete <id>` for both configurations. Delete the tunnel in the Cloudflare dashboard
   (Zero Trust → Networks → Tunnels).
3. On the PC: `docker rm -f saas-project20-cloudflared-1`; then stop `saas-project20-postgres-1`
   (keep its volume until the backup has been restored somewhere once, as a check).
4. In this repository: drop Cloudflare from the providers on the privacy page
   (`apps/web/src/app/privacy/page.tsx`) and the old-deployment notes in `docker-compose.yml`.
   Google Search Console verifies the workers.dev address through the tag in
   `apps/web/src/app/layout.tsx`: verify the new address before removing it.
5. `git worktree remove ..\insights-cloudflare`.

## Owner-only steps

- **Alerts**: an email address for alarms and the budget (`-c alertEmail=...`; confirm the SNS email).
- **SES**: verify a sending domain (DKIM records at its DNS host, Cloudflare DNS for ikorex.com.au)
  and request production access; until then SES only sends to verified addresses and app emails
  fail (EMAIL_FROM in `apps/aws/src/settings.ts` is a placeholder).
- **Google sign-in**: add `https://insights-605411278365.auth.ap-southeast-2.amazoncognito.com/oauth2/idpresponse`
  to a Google OAuth client, put its secret with `put-secrets.mjs --set GOOGLE_SIGNIN_CLIENT_SECRET`,
  deploy with `-c googleClientId=<client id>`.
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
