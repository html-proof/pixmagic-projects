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
| Database | RDS PostgreSQL 17 `insights-production` (db.t4g.small, single AZ, private, encrypted, 14-day PITR) | `infra/cdk/lib/data-stack.ts` |
| Coordinator | DynamoDB `insights-production-coord` | `apps/aws/src/dynamoCoord.ts` |
| Large webhook bodies | S3 `insights-production-payloads-605411278365` (7-day lifecycle) | `apps/aws/src/s3Blobs.ts` |
| Dumps, artifacts | S3 `insights-production-artifacts-605411278365` (30 days, versioned) | `infra/cdk/scripts/migrate-data.mjs` |
| Sign-in | Cognito pool `insights-production` (from `infra/aws/cognito.yaml`); its emails (codes) through Lambda `insights-production-cognito-email` and Resend, "Sign-in emails" below | `apps/api/src/cognito.ts`, `apps/aws/src/cognitoEmail.ts` |
| App email | Resend (bizinsights.io verified, live 2026-10-16); SES as fallback (sandbox: verified recipients only); "App email" below | `packages/core/src/mail/`, `apps/aws/src/mailers.ts`, `apps/aws/src/sesMailer.ts` |
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

The functions read secrets at cold start; after changing one, force fresh instances with a deploy,
or publish the same code as a new version and move the `live` alias ("App email" below shows how:
changing `$LATEST` alone restarts nothing live).

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

### When GitHub-hosted jobs can't start: the PC's own runner

"The job was not started because recent account payments have failed or your spending limit needs
to be increased" (a job failing in seconds with no steps or log; read it with
`gh api repos/html-proof/pixmagic-projects/check-runs/<job id>/annotations`) means the account's
included minutes are used up (GitHub Free: 2,000 a month for private repositories, reset on the
1st at 00:00 UTC) or a payment failed. Self-hosted runners cost nothing, so CI and Deploy can run on
the owner's PC instead. Every job's `runs-on` reads the repository variable `SELF_HOSTED_RUNNER`;
while it is unset, everything runs on `ubuntu-latest` exactly as before.

Set up once, in an elevated Windows PowerShell, one command at a time. The runner runs as its own
local account (not the owner's, whose `aws login` session and Git credentials stay out of reach) in
a folder only administrators can change:

```powershell
$ProgressPreference = 'SilentlyContinue'
```

(Without it, PowerShell 5.1 downloads the ~100 MB zip very slowly.)

```powershell
New-Item -ItemType Directory -Force C:\actions-runner
```

```powershell
icacls C:\actions-runner /inheritance:r /grant:r "*S-1-5-32-544:(OI)(CI)F" "*S-1-5-18:(OI)(CI)F"
```

```powershell
cd C:\actions-runner
```

```powershell
Invoke-WebRequest -Uri https://github.com/actions/runner/releases/download/v2.338.0/actions-runner-win-x64-2.338.0.zip -OutFile actions-runner.zip
```

```powershell
(Get-FileHash .\actions-runner.zip -Algorithm SHA256).Hash
```

It must print `F48E0750A21812BCA5F82DE5F7F5AEAE71ABEE647FAB5A582F1742D07EBA455F` (v2.338.0; a newer
release lists its own hash on github.com/actions/runner/releases).

```powershell
Expand-Archive .\actions-runner.zip -DestinationPath C:\actions-runner
```

The runner's account (pick a long password; nothing else uses it):

```powershell
$pw = Read-Host -AsSecureString "Password for ghrunner"
```

```powershell
New-LocalUser ghrunner -Password $pw -PasswordNeverExpires -UserMayNotChangePassword -Description "GitHub Actions runner"
```

Then GitHub → the repository → Settings → Actions → Runners → New self-hosted runner → Windows,
copy the token from the `config.cmd` line it shows (valid one hour) and run the line below. It
asks for the runner group (press Enter) and the ghrunner password:

```powershell
.\config.cmd --url https://github.com/html-proof/pixmagic-projects --token <TOKEN> --name bizinsights-pc --labels bizinsights-pc --work _work --runasservice --windowslogonaccount .\ghrunner
```

A service gets the right to impersonate other users, which local exploits turn into SYSTEM (and
SYSTEM reads every profile). Keep only the two privileges the runner needs:

```powershell
$svc = (Get-Service "actions.runner.*").Name
```

```powershell
sc.exe privs $svc SeChangeNotifyPrivilege/SeIncreaseWorkingSetPrivilege
```

```powershell
Restart-Service $svc
```

(`sc.exe`, not `sc`: in PowerShell `sc` is Set-Content.) Settings → Actions → Runners should now
show bizinsights-pc as Idle. Finally the switch (Settings → Secrets and variables → Actions →
Variables): `SELF_HOSTED_RUNNER` = `["self-hosted","bizinsights-pc"]`. The first job run on the
PC also proves GitHub still starts self-hosted jobs under the billing block.

On the PC there is no Docker: each job starts its own throwaway PostgreSQL 18 from
`C:\Program Files\PostgreSQL\18\bin` and the e2e job a Mailpit stand-in
(`apps/web/e2e/mailpit-stub.mjs`), all on free ports; the runner stops them with the job. The deploy
job signs in only with the OIDC deploy role and checks that it did.

- The PC must be on and awake: queued jobs wait up to 24 hours for the runner, then are cancelled.
  A busy PC (demos, other test runs) makes the integration tests 2-3 times slower and can time one
  out: re-run the job.
- While the runner deploys, nobody deploys by hand: the two don't share a lock.
- Job code still runs on the owner's PC: it can reach anything listening on localhost there, and
  what one job leaves in the runner folder the next one (a deploy, with the deploy role) runs with.
  Only collaborators can start jobs (fork pull requests are off); keep it that way, and never make
  the repository public while the runner is attached.
- Back to GitHub's runners: delete `SELF_HOSTED_RUNNER` first, then `Stop-Service "actions.runner.*"`
  and `.\config.cmd remove` with the token from the runner's page in Settings → Actions → Runners,
  then `Remove-LocalUser ghrunner`.

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
Infrastructure: `cdk deploy` of the previous commit. Data: point-in-time restore. Cognito's email
function has no alias (rollback.mjs leaves it): to have Cognito send its own emails again, deploy
the Auth stack with `-c cognitoEmail=off` ("Sign-in emails" below).

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

## App email (invitations, alerts)

The app's own email goes through a provider chosen by configuration, never in code
(`apps/aws/src/mailers.ts` `chooseMailer`): `EMAIL_PROVIDER` (`resend` or `ses`) when set, else
**Resend** when `RESEND_API_KEY` is in the app secret, else **SES**. Every invitation email is
recorded in `email_deliveries` (provider, its message id, status, attempts, the provider's error
without addresses); the team page shows that status. A transient failure (rate limit, outage) is
retried twice while the owner waits, then from the `email` queue after 1, 5 and 15 minutes (job
`team_invitation`), five attempts in all, each with the same `Idempotency-Key`.

- **SES**: identity `bizinsights.io` (Easy DKIM, above) works, but the account's request for
  production access was **DENIED** (2026-10-16, case 179215020600103), so SES sends only to the
  addresses verified in SES (sandbox, 200 a day). No code can get round that.
- **Resend** (resend.com; free tier 3,000 emails a month, 100 a day) sends to any address: **live
  since 2026-10-16**. Account: Resend login `tangoenery2004` (Google sign-in). Domain `bizinsights.io`,
  region Tokyo (`ap-northeast-1`), **Verified**, click/open tracking off. Its records in the Cloudflare
  zone, all **DNS only**: TXT `resend._domainkey` (DKIM public key), CNAME `rsend` →
  `rsend-apne1.forge.rmta.net` and CNAME `send` → `send.forge.rmta.net` (return path / SPF). They
  don't touch the apex, `www`, the SES DKIM CNAMEs or `_dmarc` (relaxed alignment passes on Resend's
  DKIM). API key "bizinsights production": *Sending access*, `bizinsights.io` only. Webhook
  `https://bizinsights.io/api/webhooks/email/resend` with `email.sent`, `email.delivered`,
  `email.delivery_delayed`, `email.bounced`, `email.complained`, `email.failed`, `email.suppressed`
  (no opens or clicks). Both values are in `insights/production/app` as `RESEND_API_KEY` and
  `RESEND_WEBHOOK_SECRET`.
  - **Replacing a value** (a key rotated in Resend): copy it with Resend's own copy button, run
    `node infra/cdk/scripts/put-secrets.mjs --env production --set RESEND_API_KEY` (or
    `RESEND_WEBHOOK_SECRET`) on the same PC: it reads the clipboard, refuses anything not shaped like
    `re_...` / `whsec_...`, and prints names only. Then restart the functions (below).
  - **Check**: invite an address you own; the team list says "Email sent", then "Email delivered"
    once Resend's event arrives (CloudWatch: `mail delivery event`). An unsigned POST to the webhook
    answers 401 `invalid_signature` (404 `not_configured` means the secret isn't loaded).
  To go back to SES, set `EMAIL_PROVIDER=ses` (settings) or remove the key.

**Restarting the functions after a secret changes.** They read secrets at a cold start, and the `live`
aliases point at published versions, so changing `$LATEST` alone restarts nothing live. Publish the
same code again and move the alias (what was done for v47 on 2026-10-16; the next CDK deploy publishes
its own version as usual):

```bash
for f in api jobs cron; do n=insights-production-$f; d=$(aws lambda get-function-configuration --function-name $n --query Description --output text); aws lambda update-function-configuration --function-name $n --description "$d · secrets reloaded" >/dev/null; aws lambda wait function-updated --function-name $n; v=$(aws lambda publish-version --function-name $n --query Version --output text); aws lambda update-alias --function-name $n --name live --function-version $v >/dev/null; done
```

Check first that `$LATEST` holds the live code (same `CodeSha256` as the alias's version), or this
would ship whatever `$LATEST` has.

## Sign-in emails (Cognito's codes)

Cognito doesn't send its own emails in production: sign-up and email-change codes, password-reset
codes, sign-in codes and temporary passwords go to the pool's **Custom Email Sender** trigger, the
Lambda `insights-production-cognito-email` (Auth stack; `apps/aws/src/cognitoEmail.ts`, its own
`cognito-email.mjs` in the same package). Cognito encrypts each code with the KMS key
`alias/insights-production-cognito-email`; the function decrypts it (AWS Encryption SDK), words the
email for its trigger (`packages/core/src/mail/authEmails.ts`) and sends it through the app's mail
provider (Resend, `RESEND_API_KEY` from `insights/production/app`) from `no-reply@bizinsights.io`.
So these emails aren't held to Cognito's own 50 a day from `no-reply@verificationemail.com`; they
share Resend's limits with the app's email (free tier: 100 a day, 3,000 a month).

- Cognito invokes the function asynchronously: a failure is retried twice by Lambda (same
  `Idempotency-Key`, so never two copies) and counted in the alarm `insights-production-cognito-email-errors`.
  The log (`/aws/lambda/insights-production-cognito-email`) has the trigger and Resend's message id,
  never the address or the code. Resend's own events for these messages are ignored (no delivery record).
- **Off switch**: `-c cognitoEmail=off` on a deploy of the Auth stack puts Cognito's own sender back
  (template parameter `CustomEmailSenderState`), for as long as the next deploy without it. Off in
  staging (`cognitoCustomEmail` in `infra/cdk/lib/config.ts`).
- **Cost**: the KMS key US$1/month (no rotation: nothing stays encrypted under it), the alarm
  US$0.10/month; the KMS requests and invocations fit the free tiers at this volume.
- Passwordless sign-in (`COGNITO_EMAIL_OTP`, `EMAIL_OTP` as a first factor) is unchanged, still off:
  Cognito's documentation lists SES email configuration as its requirement (not tried with the
  custom sender). The trigger already words the code (`CustomEmailSender_Authentication`).

## Owner-only steps

- **Alerts**: an email address for alarms and the budget (`-c alertEmail=...`; confirm the SNS email).
- **Sign-up codes and password resets** come from Cognito's own email (`COGNITO_DEFAULT`): any
  address, but at most 50 a day for the whole pool, from `no-reply@verificationemail.com`. Going past
  that needs Cognito on SES (production access, denied so far) or a Cognito custom email sender
  (a Lambda trigger + a KMS key, ~US$1/month) sending through Resend.
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

Prices from the AWS Price List API on 2026-10-15: NAT gateway $0.059/hour + $0.059/GB (~45 with
its public IPv4), RDS db.t4g.small $0.051/hour (~37) + 20 GB gp3 (~3), WAF (web ACL + 4 rules) ~10,
CloudWatch alarms/dashboard/logs/X-Ray ~6-10, Secrets Manager ~1.2, GuardDuty ~1-4 (free for the
first 30 days), admin host stopped ~1, KMS key for Cognito's emails 1 (+0.10 its alarm), Lambda/SQS/DynamoDB/S3/CloudFront/Cognito at today's traffic
~0-5 (free tiers): **~US$105-120**, within the approved US$120-145. Budget alarm at US$150 (80%
actual, 100% forecast, once an alert email is set). Biggest levers: the NAT gateway and the
database size. Cost allocation tags `app` and `environment` can be activated in Billing once AWS
has seen them (up to 24 hours after the first deploy).

## Fault tolerance

Production stays on the lean tier by the owner's choice (cost, 2026-10-16), so three Trusted
Advisor fault-tolerance findings are expected: "Amazon RDS DB instances not using Multi-AZ
deployment" and "Single AZ Application Check" (warnings), and "NAT Gateway AZ Independence"
(error: the app subnet in ap-southeast-2b goes out through the NAT in 2a).

They are one risk, an outage of ap-southeast-2a: the database and the only NAT gateway are both
there, so the app stops whichever of the two survives. Fixing it takes both changes together:
`dbMultiAz: true` (a standby in 2b with automatic failover, ~US$40/month) and `natGateways: 2`
(a NAT per AZ, ~US$47/month), about US$87/month in all. Either one alone buys little. An outage of
2b is already survivable: the functions run in both AZs and Lambda uses the one that works.

What production does have, at no extra cost:
- Functions in two AZs; queues with retries, backoff, a dead-letter queue (`insights-production-dlq`)
  and jobs that wait out a database outage instead of failing (apps/worker `deferForDb`).
- Database: 14 days of point-in-time restore, kept even if the instance is deleted
  (`DeleteAutomatedBackups: false`), deletion protection, a final snapshot on delete, storage
  autoscaling to 100 GB. DynamoDB with point-in-time recovery; versioned artifacts bucket.
- Scheduled runs: Scheduler retries a hand-over Lambda refuses (10 minutes), Lambda retries a failed
  run twice; a tick that still didn't run goes to `insights-production-cron-missed` (alarm
  `cron-missed-ticks`) and the next tick takes over.
- Alarms on the topic `insights-production-alarms`: function errors (Cognito's email function too), throttles and latency, queue age,
  the dead-letter queue, database CPU/memory/storage/connections, NAT gateway port allocation and
  dropped packets, plus RDS's own events (availability, failure, failover, low storage, maintenance,
  recovery, restoration). **Nobody receives them until an alert email is set** (Owner-only steps).
