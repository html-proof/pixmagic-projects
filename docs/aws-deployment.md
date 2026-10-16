# bizinsights on AWS: deployment runbook

How bizinsights on AWS is built, deployed, filled with data, tested, rolled back and, at cutover,
made the only production (the old Cloudflare deployment still serves merchants until then, see
[Retiring the old Cloudflare deployment](#retiring-the-old-cloudflare-deployment)). The design and its reasoning are in
[aws-architecture.md](aws-architecture.md); sign-in in [cognito-setup.md](cognito-setup.md).

Account `605411278365`, region `ap-southeast-2` (Sydney); the WAF web ACL lives in `us-east-1`
(a CloudFront rule). Everything is AWS CDK (TypeScript) in `infra/cdk`.

## What runs where

| Piece | AWS | Code |
| --- | --- | --- |
| Address | **https://bizinsights.io** (DNS at Cloudflare, below); CloudFront's own name `d2mr8m2p1qkh58.cloudfront.net` and `www` redirect pages there | `infra/cdk/lib/config.ts` `domain` |
| UI + API | Lambda `insights-production-api` (function URL, alias `live`) behind CloudFront + WAF | `apps/aws/src/index.ts` |
| UI build files | `/_next/static/*` from S3 `insights-production-site-605411278365` (CloudFront OAC, uploaded by `cdk deploy`, old builds kept) | `infra/cdk/lib/app-stack.ts` |
| Background jobs | SQS `insights-production-{sync,webhooks,aggregate,email}` + `-dlq` → Lambda `insights-production-jobs` | `apps/aws/src/consumer.ts`, `sqsQueues.ts` |
| Schedules | EventBridge Scheduler `*/15` and `03:15 UTC` → Lambda `insights-production-cron` (**off until cutover**) | `runScheduled()` in `apps/worker` |
| Database | RDS PostgreSQL 17 `insights-production` (db.t4g.small, Multi-AZ: a standby in a second AZ with automatic failover; private, encrypted, 14-day PITR) | `infra/cdk/lib/data-stack.ts` |
| Coordinator | DynamoDB `insights-production-coord` | `apps/aws/src/dynamoCoord.ts` |
| Large webhook bodies | S3 `insights-production-payloads-605411278365` (7-day lifecycle) | `apps/aws/src/s3Blobs.ts` |
| Dumps, artifacts | S3 `insights-production-artifacts-605411278365` (30 days, versioned) | `infra/cdk/scripts/migrate-data.mjs` |
| Sign-in | Cognito pool `insights-production` (from `infra/aws/cognito.yaml`) | `apps/api/src/cognito.ts` |
| App email | SES (needs a verified sender, below) | `apps/aws/src/sesMailer.ts` |
| Secrets | Secrets Manager `insights/production/{app,db-owner,worker-cognito}`; settings in SSM `/insights/production/runtime` | `apps/aws/src/secrets.ts` |
| Logs, alarms | CloudWatch (90 days), dashboard `insights-production`, SNS `insights-production-alarms`, budget US$235/month | `infra/cdk/lib/app-stack.ts` |
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

## Domain: bizinsights.io

Registered at **GoDaddy**; DNS is at **Cloudflare** (account Tangoenery2004@gmail.com, zone
`bizinsights.io`, Free plan, nameservers `noel.ns.cloudflare.com` + `rosalyn.ns.cloudflare.com`,
set at GoDaddy). Route 53 is not used: the account has no hosted zone and no registered domain, and
a hosted zone that isn't the registrar's nameservers would only be a second, ignored copy.

| Name | Type | Value | Proxy |
| --- | --- | --- | --- |
| `bizinsights.io` | CNAME (flattened) | `d2mr8m2p1qkh58.cloudfront.net` | Proxied |
| `www` | CNAME | `d2mr8m2p1qkh58.cloudfront.net` | Proxied |
| `_629bb4707c1bf383a6f9ecec0cb165bf` | CNAME | `_70137766a706c2c3a6f74580a42334a6.wzccmgtwzk.acm-validations.aws` | DNS only |
| `_66e52976e7c4c9a179bf51623272d845.www` | CNAME | `_4a5b10a140cad564c7f3420dc090c8dd.wzccmgtwzk.acm-validations.aws` | DNS only |
| `_dmarc` | TXT | `v=DMARC1; p=quarantine; adkim=r; aspf=r; rua=mailto:dmarc_rua@onsecureserver.net;` (from GoDaddy, kept) | DNS only |
| `_domainconnect` | CNAME | `_domainconnect.gd.domaincontrol.com` (from GoDaddy, kept) | as imported |

- **Certificate**: ACM in us-east-1 (CloudFront's region), `bizinsights.io` + `www.bizinsights.io`,
  `arn:aws:acm:us-east-1:605411278365:certificate/776966d7-d73c-4896-bd30-1568c9f7b3f7`, DNS-validated
  by the two `acm-validations.aws` records. ACM renews it by itself while they stay: never delete them.
- **Proxied through Cloudflare** (since 2026-10-16), in front of CloudFront, which still does TLS
  to the origin, caching, AWS WAF and the redirects. CloudFront then sees a Cloudflare edge address
  as the viewer, so the viewer-request function and the WAF's second rate rule take the client's
  address from `CF-Connecting-IP`, believed only from Cloudflare's published ranges
  (`infra/cdk/lib/cloudflare.ts`; add any range Cloudflare adds). The app's per-IP limits and audit
  get it through `x-insights-viewer-ip` as before. Zone settings this relies on:
  - SSL/TLS **Full (strict)** (CloudFront has a valid certificate for both names; Flexible would loop
    on CloudFront's HTTPS redirect), **Always Use HTTPS** on (the smoke test checks http → https),
    minimum TLS 1.2.
  - **Email Address Obfuscation** and **Rocket Loader** off: both rewrite the HTML, and the static
    pages (the contact address on /privacy, /terms, /support) must match what React hydrates.
  - Cache Rule **"API: bypass cache"**: URI path starts with `/api/` → bypass. Cloudflare caches by file
    extension, so an API path ending in `.csv` could otherwise be cached across accounts.
  - **Bot Fight Mode off.** On the Free plan it covers the whole zone and no rule can skip it, so it
    challenges Shopify's and Meta's webhooks and the deploy's smoke tests from GitHub (a failed smoke
    test rolls the deploy back). Bot traffic is handled by AWS WAF's rate limits and managed rules.
  - **AI Labyrinth** on; **Security.txt** set with the same lines as
    `apps/web/public/.well-known/security.txt` (Cloudflare answers that path at its edge). Both
    expire 2027-10-15: renew the `Expires` line in both before then.
  - Rollback: switch the two records back to **DNS only**. Nothing in AWS has to change: from
    anywhere but Cloudflare's ranges `CF-Connecting-IP` is ignored.
- **One origin**: the session cookie, the CSRF check and every OAuth callback use APP_URL
  (`https://bizinsights.io`, set on the functions by the App stack). CloudFront answers on
  `bizinsights.io`, `www` and its own name; the viewer-request function sends GET/HEAD on the other two
  to `https://bizinsights.io` with a 301 (same path and query parameters; their order may change) and
  serves other methods where they arrive (webhooks and pixel events don't follow redirects).
- **HSTS**: CloudFront's security headers send `max-age=31536000; includeSubDomains`, so every name
  under bizinsights.io must serve HTTPS.
- **Email**: the domain has no MX (no mailbox). SES sends from it (`no-reply@bizinsights.io`):
  identity `bizinsights.io` in ap-southeast-2 with Easy DKIM, its three `<token>._domainkey` CNAMEs
  → `<token>.dkim.amazonses.com` in this zone, DNS only (added 2026-10-16). The existing `_dmarc`
  record (p=quarantine, relaxed) passes on the DKIM signature. Replies go to a message's Reply-To.

Records before the switch (GoDaddy's parking page, imported by Cloudflare on 2026-10-15), for a
rollback: `A bizinsights.io 15.197.148.33` and `A bizinsights.io 3.33.130.190` (both proxied),
`CNAME www → bizinsights.io` (proxied). Putting them back (and `domain` out of config.ts) returns the
app to `d2mr8m2p1qkh58.cloudfront.net`.

## Roll back

`node infra/cdk/scripts/rollback.mjs` moves the `live` aliases of api, jobs and cron to the previous
version (UI included, it ships in the api package). The next deploy moves them forward again.
Infrastructure: `cdk deploy` of the previous commit. Data: point-in-time restore.

## Cutover (owner's go-ahead needed; not done yet)

> **Overtaken in part (2026-10-16).** Both Shopify apps already point at bizinsights.io (step 4), and
> stores now reconnect on AWS directly: PixMagic did at 09:32 UTC, with its pixel re-pointed and its
> orders re-imported. Step 2's `--replace` wipes the AWS database first, so it would now erase those
> stores and the accounts that claimed them. Don't run step 2 as written: decide first what to copy
> from the PC database (old pixel/funnel history, users who haven't come back) and merge it in.

Before the window: provider secrets the stores in use need (`GOOGLE_ADS_CLIENT_SECRET` for AdSense
refreshes; `SHOPIFY_APP_SECRET_PIXMAGIC` is set) with `put-secrets.mjs --set`, and the AWS redirect
URIs added at Google. A new secret reaches the functions only when they start, so run **Deploy to
AWS** (Actions → Run workflow) after setting one. The Cloudflare commands below run from
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
4. **Shopify:** done. Both apps are live on `https://bizinsights.io`: the main app since version
   `insights-13` (now `insights-14`), the PixMagic app since version `pixmagic-7` (2026-10-16, webhooks
   API 2026-10).
5. **Old address forwards:** the same stand-in with `--var MOVE_PHASE:forward --var
   MOVED_TO:https://bizinsights.io`, deployed at 100%:
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
- **SES**: the sending domain bizinsights.io is set up (above); **production access is still to be
  requested** (SES console → Account dashboard → Request production access, or
  `aws sesv2 put-account-details`). Until then SES sends only to addresses verified in SES: an
  invitation to anyone else fails to send and the inviter gets the link to pass on.
- **Google sign-in**: add `https://insights-605411278365.auth.ap-southeast-2.amazoncognito.com/oauth2/idpresponse`
  to a Google OAuth client, put its secret with `put-secrets.mjs --set GOOGLE_SIGNIN_CLIENT_SECRET`,
  deploy with `-c googleClientId=<client id>`.
- **Provider secrets** not on this PC: META_APP_SECRET, GOOGLE_ADS_CLIENT_SECRET, WHATSAPP_APP_SECRET,
  WHATSAPP_WEBHOOK_VERIFY_TOKEN (`put-secrets.mjs --set`, then a Deploy to AWS run).
- **Custom domain**: done, bizinsights.io (above). Provider consoles still list the old addresses:
  Google/Meta OAuth redirect URIs move to `https://bizinsights.io/api/...` with the cutover. Both
  Shopify apps are already there (main `insights-14`, PixMagic `pixmagic-7`). To go back to an
  earlier Shopify version, use the Dev Dashboard (the app → **Versions** → that version →
  **Release**): `shopify app release --version <tag>` answers "could not be found" for every version
  of both apps (CLI 3.94.3, 2026-10-16). Shipping still works: `shopify app deploy --version <new tag>`.

## Cost (US$/month, on-demand, approximate)

Prices from the AWS Price List API on 2026-10-15: NAT gateways $0.059/hour each + $0.059/GB (~90
for two with their public IPv4s), RDS db.t4g.small Multi-AZ 2 × $0.051/hour (~75) + 20 GB gp3
twice (~6), WAF (web ACL + 4 rules) ~10, CloudWatch alarms/dashboard/logs/X-Ray ~6-10, Secrets
Manager ~1.2, GuardDuty ~1-4 (free for the first 30 days), admin host stopped ~1,
Lambda/SQS/DynamoDB/S3/CloudFront/Cognito at today's traffic ~0-5 (free tiers): **~US$190-210**.
Budget alarm at US$235 (80% actual, 100% forecast, once an alert email is set). Biggest levers: the
NAT gateways and the database (size, Multi-AZ). Cost allocation tags `app` and `environment` can be
activated in Billing once AWS has seen them (up to 24 hours after the first deploy).

Both are the high-availability options, approved by the owner on 2026-10-16: the database has a
standby in the second AZ (`dbMultiAz`), and each AZ has its own NAT gateway (`natGateways: 2`, for
Trusted Advisor's "Single AZ Application Check"). With one NAT, both AZs' functions left through the
one in ap-southeast-2a, and an outage there cut them all off from the internet. Going back to one
saves ~US$47/month and brings the warning back.
