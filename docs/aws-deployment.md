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
| Database | RDS PostgreSQL 17 `insights-production` (db.t4g.micro, Multi-AZ: standby in the other AZ, private, encrypted, 14-day PITR) | `infra/cdk/lib/data-stack.ts` |
| Way out to the internet | EC2 NAT instances `insights-production-nat-a` / `-b` (t4g.nano, one per AZ, Systems Manager only) | `infra/cdk/lib/nat-instances.ts` |
| Coordinator | DynamoDB `insights-production-coord` | `apps/aws/src/dynamoCoord.ts` |
| Large webhook bodies | S3 `insights-production-payloads-605411278365` (7-day lifecycle) | `apps/aws/src/s3Blobs.ts` |
| Dumps, artifacts | S3 `insights-production-artifacts-605411278365` (30 days, versioned) | `infra/cdk/scripts/migrate-data.mjs` |
| Sign-in | Cognito pool `insights-production` (from `infra/aws/cognito.yaml`); its emails (codes) through Lambda `insights-production-cognito-email` and Resend, "Sign-in emails" below | `apps/api/src/cognito.ts`, `apps/aws/src/cognitoEmail.ts` |
| App email | Resend (bizinsights.io verified, live 2026-10-16); SES as fallback (sandbox: verified recipients only); "App email" below | `packages/core/src/mail/`, `apps/aws/src/mailers.ts`, `apps/aws/src/sesMailer.ts` |
| Secrets | Secrets Manager `insights/production/{app,db-owner,worker-cognito}`; settings in SSM `/insights/production/runtime` | `apps/aws/src/secrets.ts` |
| Logs, alarms | CloudWatch (90 days), dashboard `insights-production`, SNS `insights-production-alarms`, budget US$80/month (emails `budgetEmail`) | `infra/cdk/lib/app-stack.ts` |
| DB admin | EC2 `insights-production-admin` (t4g.nano, Systems Manager only, normally **stopped**) | `infra/cdk/lib/data-stack.ts` |
| Audit (whole account) | CloudTrail `insights-account` (every Region) → S3 `insights-account-trail-605411278365` (1 year); IAM Access Analyzer `insights-account` in all 18 enabled Regions (StackSet `insights-account-access-analyzer`); GuardDuty (turned on by hand) | `infra/cdk/lib/audit-stack.ts` |

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
`GOOGLE_SIGNIN_CLIENT_ID` and `AWS_SCHEDULES` (`on` after cutover). Required reviewers and branch
rules for an environment need a paid plan for a private repository; the role's trust does that job.

The role admits a token whose `aud` is `sts.amazonaws.com` and whose `sub` is exactly what this
repository sends: the immutable form
`repo:html-proof@68529971/pixmagic-projects@1413246051:environment:production` (`githubOidcSubject`
in `infra/cdk/lib/config.ts`; the repository's OIDC subject setting is left as it is). `sub` names
no branch, so any branch's workflow naming the `production` environment gets the role. AWS STS has
read GitHub's own claims since January 2026; the trust is to also require `job_workflow_ref` =
`html-proof/pixmagic-projects/.github/workflows/aws-deploy.yml@refs/heads/main` and `ref` =
`refs/heads/main` (`githubDeployClaims`), but only after a deploy has proven, on roles that grant
nothing, that IAM checks them: a wrong trust locks every later deploy out (each run signs in before
it deploys), and only the account's root can put it back.

The workflow checks from both ends. Before it signs in, "Token claims the deploy role requires"
compares its own token with `githubDeployClaims` (`infra/cdk/scripts/oidc-trust.ts claims`). After
the smoke tests, "The next deploy can still sign in" has STS exchange a fresh token for the role
(`oidc-trust.ts assume`; that 15-minute session is dropped unread). Both do nothing when the commit
being deployed predates the script (the workflow file is always the default branch's). "Not
authorized to perform sts:AssumeRoleWithWebIdentity" at sign-in means token and trust differ: the
first step prints the token's values.

If "The next deploy can still sign in" fails, the release is live (nothing is rolled back) but the
next deploy can't sign in. The owner, with the account's admin sign-in and no deploy running, puts
the trust back to `aud` and `sub` only; then fix the cause and merge it. CloudFormation sets the
trust again only when its template changes. Save this as `trust.json`:

```json
{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Federated":"arn:aws:iam::605411278365:oidc-provider/token.actions.githubusercontent.com"},"Action":"sts:AssumeRoleWithWebIdentity","Condition":{"StringEquals":{"token.actions.githubusercontent.com:aud":"sts.amazonaws.com","token.actions.githubusercontent.com:sub":"repo:html-proof@68529971/pixmagic-projects@1413246051:environment:production"}}}]}
```

```powershell
aws iam update-assume-role-policy --role-name insights-production-github-deploy --policy-document file://trust.json
```

Every action in the workflows is pinned to a commit SHA, with its version in a comment (a tag can
be moved to other code; a SHA can't). Dependabot (`.github/dependabot.yml`) proposes updates once a
month, all in one pull request.

### Keeping within GitHub's included minutes

GitHub Free includes 2,000 hosted minutes a month for private repositories; a pull request costs
about 13 (checks ~8, browser tests ~5, each job billed in whole minutes), its merge to `main` as
much again, and a deploy ~5. CI (`.github/workflows/ci.yml`) therefore runs only what a change can
affect:

- Only Markdown files or `docs/` changed: no CI run, and so no deploy (nothing to ship).
- A pull request runs the browser tests only when it changes `apps/web`, `apps/aws`,
  `packages/shared`, the e2e stand-ins (`infra/cognito-local`, `infra/postgres`,
  `docker-compose.yml`), the dependencies or `ci.yml`, or has the label `e2e` (labels are read per
  push: add it, then push). A push to `main` always needs them before Deploy to AWS.
- Each pull-request job that passes records the tree it tested (an artifact `passed-<job>-<tree>`,
  14 days). The push to `main` that merges it looks these up first (job "Already passed on a pull
  request?", about a minute) and skips each job that already passed on exactly its tree. That holds
  when `main` hasn't moved since the pull request's last run: of several pull requests merged back to
  back, only the first saves anything.
- The integration tests (`pnpm test:integration` and the migrations check, ~4 of the checks job's
  ~7.5 minutes) run only when something they read changed since a run where they passed. The checks
  job hashes the git ids of `apps/api`, `apps/worker`, `packages/`, `test-support/`,
  `infra/postgres/`, the root `package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`,
  `tsconfig.base.json`, `.gitattributes` and `ci.yml`, with the runner's OS and Node version, and
  looks for an artifact `passed-integration-<key>` (14 days) from a pull request's run or `main`'s.
  Unlike the tree check above, this also holds when `main` moved, as long as what moved is outside
  that list (the UI, the CDK app, docs). Tests that start reading a file outside the list need it
  added there (step "What the integration tests read").
- A newer push cancels the older run on the same pull request. On `main` it waits: the run in
  progress finishes and deploys, then the newest waiting push runs (older waiting ones are dropped).
  So merges minutes apart still deploy, at most one run behind. Before 2026-10-18 `main` cancelled
  too, and that day only 2 of 8 main runs reached Deploy. Re-run a failed job only when it is flaky,
  not to retry a real failure.

Minutes used so far this month: GitHub → Settings → Billing and licensing → Usage, or
`gh api users/html-proof/settings/billing/usage/summary` (after `gh auth refresh -s user` once).

### When GitHub-hosted jobs can't start: the PC's own runner

"The job was not started because recent account payments have failed or your spending limit needs
to be increased" (a job failing in seconds with no steps or log; read it with
`gh api repos/html-proof/pixmagic-projects/check-runs/<job id>/annotations`) means the account's
included minutes are used up (GitHub Free: 2,000 a month for private repositories, reset on the
1st at 00:00 UTC) or a payment failed. Self-hosted runners cost nothing, so CI and Deploy can run on
the owner's PC instead. Every CI job's `runs-on` reads the repository variable `SELF_HOSTED_RUNNER`;
while it is unset, everything runs on `ubuntu-latest` exactly as before. Pushes to `main` and
Deploy to AWS read `SELF_HOSTED_MAIN_RUNNER` first (the runner for main, below).

Set up once, in an elevated Windows PowerShell. `infra/runner/install-runner.ps1` does every step
below in one go (`powershell -ExecutionPolicy Bypass -File infra\runner\install-runner.ps1`, from
the repository folder) and asks only for the new account's password, then hardens the account
(`harden-runner.ps1`, "Hardening the runner" below); or run them one at a time.
The runner runs as its own local account (not the owner's, whose `aws login` session and Git
credentials stay out of reach) in a folder only administrators and the runner can change (config.cmd
gives its group `GITHUB_ActionsRunner_*` full control):

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
show bizinsights-pc as Idle. Then the account's hardening ("Hardening the runner" below). Finally
the switch (Settings → Secrets and variables → Actions → Variables): `SELF_HOSTED_RUNNER` =
`["self-hosted","bizinsights-pc"]`. The first job run on the PC also proves GitHub still starts
self-hosted jobs under the billing block.

#### The runner for main

Pull-request jobs run code nobody has reviewed yet (a new dependency's install script, say), and a
runner keeps state between jobs: its tool cache, its pnpm store, its account's profile and the
runner folder. On one shared runner, whatever such a job leaves there the next Deploy to AWS runs
with, while it holds the deploy role, which reaches AdministratorAccess through the CDK roles. And
one runner takes jobs oldest-queued first: main's e2e job queues only once main's checks are done,
so pull-request runs pushed meanwhile go first, and the deploy waits behind them all.

So `main` gets a second runner service on the same PC, for CI on pushes to `main` and for Deploy to
AWS: the code that already got into `main`, the same code the deploy runs. Account `ghmain`,
folder `C:\actions-runner-main`, name and only label `bizinsights-pc-main`, and its own e2e
browsers in `C:\ms-playwright-main` (`PW_BROWSERS` in the runner's `.env`; the first e2e run on
`main` downloads them). Neither account can change the other's folders or profile, and the folders
on the system `PATH` are administrators-only (checked 2026-10-18), so main's jobs run only programs
administrators installed and their own.

Labels alone wouldn't keep other jobs off it: any branch's workflow can ask for any label. Its job
hook (`infra/runner/main-only-hook.js`, which the runner runs with its own Node before every job;
a copy in `C:\ProgramData\bizinsights-runner`, administrators-only) fails every job before its first
step unless GitHub says it is `ci.yml` for a push to `main`, or `aws-deploy.yml` from `main` started
by a CI run or by hand. Those values come from the job's github context, which a workflow file can't
change. A refused job's "Set up runner" step says why.

In an elevated Windows PowerShell, from the repository folder (asks for a new password for ghmain,
twice):

```powershell
powershell -ExecutionPolicy Bypass -File infra\runner\install-runner.ps1 -Main
```

Then the variable `SELF_HOSTED_MAIN_RUNNER` = `["bizinsights-pc-main"]`. Until it is set, main's
jobs run on the shared runner and each deploy warns ("On the runner pull requests use"). Once set,
the next run's "Set up runner" steps should show "A job started hook has been configured by the
self-hosted runner administrator" and "allowed on this runner". (CI uses the runner for main only
while `SELF_HOSTED_RUNNER` is set too: its steps decide between the PC and GitHub's machines by that
variable.) Main and pull-request runs now go side by side and share the laptop's CPU.

#### Hardening the runner

Owner-run, in an elevated Windows PowerShell; install-runner.ps1 does this for the account it
creates. For a runner installed before 2026-10-18 (ghrunner), run once, from the repository folder:

```powershell
powershell -ExecutionPolicy Bypass -File infra\runner\harden-runner.ps1
```

It is safe to run again. For each runner account that exists (ghrunner, ghmain):

- A password is required. `New-LocalUser` leaves the account flagged "password not required"
  (PASSWD_NOTREQD), which lets it be given an empty one. By hand: `net user ghrunner /passwordreq:yes`.
- No logon but as its service: it is denied local logon, Remote Desktop and network logon. By
  hand: `secpol.msc` → Local Policies → User Rights Assignment → "Deny log on locally", "Deny log
  on through Remote Desktop Services" and "Deny access to this computer from the network": add the
  account to each. "Log on as a service", which config.cmd granted, stays. config.cmd checks the
  password with a network logon, so registering that account's runner again needs the network
  denial lifted first: install-runner.ps1 does that and puts it back.

And the e2e job's browsers: C:\ passes "Authenticated Users: Modify" down to new folders, so every
account on the PC could replace the `chrome.exe` a runner starts. The script leaves
`C:\ms-playwright` changeable by administrators, SYSTEM and ghrunner (which downloads new browser
builds into it), readable by users; and `C:\ms-playwright-main` the same with ghmain, not
readable by other accounts. By hand, for the first (the second: `ghmain`, without the last grant):

```powershell
icacls C:\ms-playwright /inheritance:r /grant:r "*S-1-5-18:(OI)(CI)F" "*S-1-5-32-544:(OI)(CI)F" "ghrunner:(OI)(CI)M" "*S-1-5-32-545:(OI)(CI)RX"
```

```powershell
icacls "C:\ms-playwright\*" /reset /T /C /Q
```

(The second makes everything inside inherit exactly that.)

On the PC there is no Docker: each job starts its own throwaway PostgreSQL 18 from
`C:\Program Files\PostgreSQL\18\bin` and the e2e job a Mailpit stand-in
(`apps/web/e2e/mailpit-stub.mjs`), all on free ports; the runner stops them with the job. The deploy
job signs in only with the OIDC deploy role and checks that it did.

- The e2e job's browsers live in `C:\ms-playwright` (on the runner for main, `C:\ms-playwright-main`:
  `PW_BROWSERS` in the job's environment points elsewhere), so "Browser for the tests" only checks
  them. The PC's network hands out IPv6
  addresses with no route behind them. Most tools fall back to IPv4, but Playwright's download
  tries IPv6 first and gives up on every attempt ("timed out after 30000ms" after 5 s). So that
  step preloads `apps/web/e2e/ipv4-only.mjs`, and a new browser build downloads into the folder by
  itself. If a download still fails, fill the folder by hand from an account that has the browsers,
  in an elevated Windows PowerShell (once hardened, only administrators and the runner's account
  may write there), then run harden-runner.ps1 again:
  `Copy-Item -Recurse -Force C:\Users\<account>\AppData\Local\ms-playwright\* C:\ms-playwright`.
  Never copy from `C:\ms-playwright` into `C:\ms-playwright-main`: pull-request jobs can change the first.
- The PC must be on and awake: queued jobs wait up to 24 hours for the runner, then are cancelled.
  It's a laptop with Modern Standby: it sleeps 3 minutes after the last input once the screen
  turns off (even on AC, even with "sleep: never"), and when the lid closes. Asleep, it drops the
  network, so a running job stalls or is lost (on 2026-10-18 it slept twice mid-pipeline). Keep it
  plugged in and awake: in an elevated PowerShell, `powercfg /change monitor-timeout-ac 0`, then
  `powercfg /setacvalueindex SCHEME_CURRENT SUB_BUTTONS LIDACTION 0` and
  `powercfg /setactive SCHEME_CURRENT` (lid closed on AC does nothing).
  A busy PC (demos, other test runs) makes the integration tests 2-3 times slower and can time one
  out: re-run the job.
- While the runner deploys, nobody deploys by hand: the two don't share a lock.
- Pass records (`passed-*` artifacts) can't be stored while the account's artifact storage quota is
  used up ("Artifact storage quota has been hit"). Then every push to `main` runs the checks again
  (about 40 minutes on the PC) instead of reusing a pull request's pass. It costs only time.
- Job code still runs on the owner's PC: it can reach anything listening on localhost there, and
  what one pull request's job leaves behind the next job on that runner runs with. With the runner
  for main that stops short of main's CI and the deploy; without it, they run with it too. Only
  collaborators can start jobs (fork pull requests are off); keep it that way, and never make the
  repository public while a runner is attached.
- Back to GitHub's runners: delete `SELF_HOSTED_MAIN_RUNNER` and `SELF_HOSTED_RUNNER` first. Then,
  for each runner (`C:\actions-runner-main` with account ghmain, `C:\actions-runner` with
  ghrunner), in an elevated PowerShell in its folder: `Stop-Service "actions.runner.*.<name>"`,
  `.\config.cmd remove` with the token from the runner's page in Settings → Actions → Runners, and
  `Remove-LocalUser <account>`. Last, `Remove-Item -Recurse C:\ProgramData\bizinsights-runner, C:\ms-playwright-main`.

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
on the AWS side: database private and encrypted, buckets private, functions healthy, DLQ empty,
and that the public address runs what was deployed: `https://bizinsights.io/api/version` must name
the commit checked out where smoke.mjs runs, and the api function's `live` alias version as its
`release`. Run it from the deployed commit (a checkout of another commit fails that one check).
Sign-up and sign-in with a real address are the owner's to try (they need a mailbox).

**Which release is live:** `curl https://bizinsights.io/api/version` answers
`{"app":"bizinsights","environment":"production","commit":"<full sha>","builtAt":"<ISO time>","release":"<Lambda version>"}`.
`commit` comes from `build.json`, which `apps/aws/scripts/build.mjs` writes into the package (with
`-dirty` if the checkout had uncommitted changes); `release` is the Lambda version serving the request,
which is what `rollback.mjs` moves the `live` alias between. Nothing in it is secret.

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

- **MFA on the root user** (Trusted Advisor "MFA on Root Account", red): sign in as root → account
  menu (top right) → **Security credentials** → **Multi-factor authentication (MFA)** → **Assign MFA
  device**, a passkey/security key or an authenticator app. It needs the owner's own device, so no
  deploy can do it. `aws login` keeps working after it (the browser sign-in asks for the code).
- **Alerts**: an email address for the alarms (`-c alertEmail=...`; confirm the SNS email). The
  budget already emails `budgetEmail` (config.ts) and needs no confirmation.
- **Support plan**: the account signed up with a paid plan (Business Support+, the greater of
  US$29/month or 9% of the bill). Basic support is free; switch in Support Center → Support plans →
  Basic Support → Review downgrade. AWS refuses until the 30-day minimum ends (tried 2026-10-18), so
  from 2026-11-14 ~04:43 UTC; a one-time reminder task (`aws-support-plan-to-basic`) fires that day.
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

The owner's ceiling is **US$50-80 a month** (2026-10-18), keeping everything above, Multi-AZ
included. Measured, priced and independently re-checked on 2026-10-18 (AWS Price List API, Sydney,
before the 10% GST that AWS Australia adds; usage from CloudWatch at that day's traffic):

| Item | US$/month |
| --- | --- |
| RDS db.t4g.micro Multi-AZ, on demand $0.051/hour (a 1-year No Upfront reservation is $0.0401: 29.27) | 37.23 |
| RDS 20 GiB gp3 Multi-AZ, $0.276/GB (gp3's minimum; ~3.2 GB used, most of it WAL) | 5.52 |
| Two NAT instances: t4g.nano $0.0053/hour + public IPv4 $0.005/hour + 8 GB gp3, each ~8.3 | 16.58 |
| GuardDuty after its trial (ends ~2026-11-14): RDS protection 2.26 + **Advanced RDS (`RDS_DATA_RISK`) 6.78** + CloudTrail events ~1.5 + S3/Lambda/DNS/flow logs ~0.2 | ~10.7 |
| WAF: web ACL $5 + 5 rules × $1 + requests | ~10.2 |
| CloudWatch: 25 alarms, 10 free; logs, metrics, dashboard in the free tier | ~1.5 |
| Secrets Manager (3 × $0.40 + calls), KMS (Cognito email key + ~60-90k requests, 20k free) | ~2.5 |
| Admin host's disk (stopped), EBS snapshots, X-Ray (~200k traces, 100k free), SQS (~1.3 M requests, 1 M free), S3, DynamoDB, SES | ~2.9 |
| CloudTrail: the trail's first copy of management events is free; its bucket's log files (PUT requests from 18 Regions, a few hundred MB a year), since 2026-10-18 and not yet in the totals below | ~0.5 |
| Lambda, CloudFront, Cognito, Scheduler, SNS, ACM (always-free tiers; the account has no 12-month free tier or credits) | 0 |
| **Total** | **~87** (~96 with GST) |

With the reservation it is ~79 (~87 with GST). Turning off GuardDuty's Advanced RDS add-on as well
brings it to ~72 (~79.65 with GST), the only combination under the US$80 budget. The admin host adds
~3.9 while it runs. Before GuardDuty's trial ends the total is ~76. A paid **support plan** comes on
top: the account is on Business Support+ (AWS's price list names its sign-up product
`AWSSupportEssential` "AWS Business Support+"), the greater of US$29/month or 9% of the bill
(Owner-only steps).

**Reserved instance:** none is active. Two orders on 2026-10-18 (`insights-production-t4g-micro-maz-2026-10`
at 10:52 UTC, and `...-2026-10-b` at 12:30 UTC after the card was updated) both ended `payment-failed`
about an hour later. AWS can't charge the card on file (GitHub reports failed payments too), and the
same card pays the monthly invoice. Once payments work, order it again (1 year, No Upfront,
db.t4g.micro PostgreSQL Multi-AZ, offering 0487c451-607c-446a-86af-f5d23305e90d). It is size-flexible:
on db.t4g.small Multi-AZ it still pays half. Check with `aws rds describe-reserved-db-instances`.

Biggest lever: the database size (`dbInstanceType`). Move to db.t4g.small when the database alarms
say so (`db-free-memory` below 100 MB, `db-connections` above 60 of ~80, `db-cpu`): that takes the
bill past US$100. On 2026-10-18 freeable memory touched 99 MiB for one 5-minute period (swap at
most ~52 MiB of 4 GiB). Connections are the nearer limit: the API has no concurrency cap and no
RDS Proxy. NAT instances replaced the NAT gateway ($0.059/hour + $0.059/GB, ~47 with its address)
on 2026-10-17: two of them cost a third of one gateway.

**Budget** `insights-production-monthly-<digest>`: US$80, tax included, emails `budgetEmail` when the
month passes 50/75/90/100% (US$40/60/72/80) and when AWS forecasts it above US$80. Nothing is
stopped at any threshold. Until Basic support, the reservation and the Advanced RDS decision are in
place, the 100% email is expected every month: it is accurate, not noise. The name carries a digest
of the alerts because CloudFormation replaces a budget whose alerts change. Cost Anomaly
Detection's default subscription alerts only at an impact of US$100 and 40%, so at this account's
size it is no safety net, and the alarm topic still has no subscriber.

Not costing anything yet, but watch: three manual RDS snapshots never expire, and backups may pass
the 20 GB free allowance once the 14-day chain fills; four log groups keep logs forever (the RDS
postgresql group and three CDK helper groups); storage autoscaling can grow the disk to 100 GB and
it never shrinks back.

Looked at on 2026-10-18 and not worth it: moving region (us-east-1 is ~US$18 cheaper, but every
request crosses the Pacific, Cognito users can't move with their passwords, and the data would
leave Australia; Singapore costs the same as Sydney; Melbourne the same, with no db.t4g.micro/small
reservations and no SES). The CloudFront flat-rate Free plan (US$0 instead of the WAF's ~10) would
mean dropping the custom 429 response and the Cloudflare per-client rate rule (both Pro and up),
moving the rate windows from 60 seconds to 5 minutes, and swapping the custom headers policy for a
managed one, with no SLA. Cost allocation tags `app` and `environment` can be activated in Billing.

## Fault tolerance

Trusted Advisor's three fault-tolerance checks ("Amazon RDS DB instances not using Multi-AZ
deployment", "NAT Gateway AZ Independence", "Single AZ Application Check") were one risk until
2026-10-17: the database and the only NAT gateway were both in ap-southeast-2a, so an outage there
stopped the app. Now nothing the app needs is in one AZ only:

- **Database**: Multi-AZ (`dbMultiAz`). RDS keeps a synchronous standby in the other AZ and fails
  over by itself (about a minute: the endpoint's DNS moves; the functions' pools reconnect, jobs wait
  it out with `deferForDb`). Instance class changes and patching go to the standby first, so they
  cost one failover instead of a reboot.
- **Way out to the internet**: a NAT instance per AZ (`nat-instances.ts`, `natGateways: 2`); each
  AZ's app subnet routes through its own, so an outage of one AZ leaves the other's functions able
  to reach Cognito, Shopify, Google, Meta and SMTP. Each instance is recovered onto new hardware if
  AWS's host fails (alarm `insights-production-nat-<a|b>-system-check`) and rebooted if it stops
  answering (`...-instance-check`); its id and addresses survive both, so the routes stay valid.
  While one is down (a few minutes), only the functions running in its AZ lose the internet, and
  their work is retried. A new Amazon Linux image replaces both on the next deploy (patched, no gap:
  CloudFormation moves the route only once the new one signals NAT is up). The public addresses
  are not fixed (nothing allowlists them); they change only when an instance is replaced.
- **Functions** run in both AZs and Lambda uses the one that works.

State on 2026-10-17 06:45Z (main 7379a95): RDS db.t4g.micro Multi-AZ (2a + standby 2b), NAT instances
`insights-production-nat-a` (2a) and `-b` (2b), no NAT gateway. Trusted Advisor cleared the RDS finding at
once; the two NAT checks can't be refreshed on demand (`UNREFRESHABLE_CHECK_ID_ERROR`), so they keep
their 2026-10-16 result until AWS re-runs them on its own schedule. Measured cost of the switch: the
class change was one failover, `/api/readyz` answered 503 for under a minute.

Reading a stale "NAT Gateway AZ Independence" export (check `c1dfptbg10`): it names
`nat-04330c606ef5bce9a` and its Last Updated Time is 2026-10-16. That gateway no longer exists:
`aws ec2 describe-nat-gateways` returns nothing, and `describe-route-tables` shows appSubnet1 (2a)
routing `0.0.0.0/0` to nat-a and appSubnet2 (2b) to nat-b. With no NAT gateway left, the check has
nothing to flag the next time AWS runs it.

AWS re-ran both network checks on 2026-10-17 at 10:31Z, four hours after CloudFormation deleted the
gateway (CloudTrail `DeleteNatGateway`, 06:22Z), and they still showed it: their data lags the
account by more than a day, and `aws support refresh-trusted-advisor-check` refuses them. To check
the real state instead: no NAT gateway (`describe-nat-gateways`), each app subnet's route to its own
AZ's instance (`describe-route-tables`), and traffic through both instances (`NetworkOut` of nat-a
and nat-b in CloudWatch; on 2026-10-18 about 10 MB and 25 MB a day). "Single AZ Application Check"
reads egress traffic patterns, so it clears once AWS reads traffic from after 06:22Z.

**Buckets** (Trusted Advisor "Amazon S3 Bucket Versioning"): all three are versioned. Earlier
versions expire by themselves: build files (`site`) after 30 days, database dumps (`artifacts`)
after 7, webhook bodies (`payloads`) after one day, since processed bodies hold customer data.
Together that is a few cents a month at most.

**Instance disks** (Trusted Advisor "Amazon EBS Snapshots", check `H7IgTzjTYb`, red on 2026-10-17
for the NAT instances' and the admin host's disks): Data Lifecycle Manager's default policy
(`EbsSnapshots` in data-stack.ts, production only, since one is allowed per Region) snapshots every
volume in the Region that has no recent snapshot, daily, and keeps each 7 days. Snapshots of a
replaced instance's disk expire too (`ExtendDeletion`). The disks hold nothing a deploy can't
rebuild, so restoring one is only the quicker way back. A default policy only takes on a volume
once it is 24 hours old, then snapshots it daily in a four-hour window it picks at random. So a new
disk (a NAT instance replaced by a new Amazon Linux image, or the admin host) had no snapshot for
its first one to two days, and the check went red in that time after every such deploy. Since
2026-10-17 each instance also gets a **launch snapshot** as soon as CloudFormation has created it (a
`LaunchSnapshot` custom resource per instance in data-stack.ts: EC2 `CreateSnapshots`, tagged
`insights-snapshot=launch`, named `<instance>-launch`). There is one per instance: when an instance
is replaced, the new one's is taken and then the old one's deleted (the custom resource may delete
only snapshots with that tag). To check:
`aws ec2 describe-snapshots --owner-ids self` (one `-launch` per instance, plus DLM's daily ones) and
`aws dlm get-lifecycle-policies --default-policy-type VOLUME` (State ENABLED). Trusted Advisor
re-reads this check on its own about daily, or on demand with
`aws support refresh-trusted-advisor-check --check-id H7IgTzjTYb --region us-east-1` (at most every
few hours).

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
  the dead-letter queue, database CPU/memory/storage/connections, the NAT instances' status checks
  and CPU, plus RDS's own events (availability, failure, failover, low storage, maintenance,
  recovery, restoration). **Nobody receives them until an alert email is set** (Owner-only steps).

## Security checks (Trusted Advisor)

The five red security checks on 2026-10-18 and what answers each:

- **Security Groups - Specific Ports Unrestricted** and **- Unrestricted Access**: both were one
  rule, SSH (22) from `0.0.0.0/0` on `launch-wizard-1` (`sg-08f68079a6d50843e`), a group the EC2
  console's launch wizard made on 2026-10-15 in the default VPC. Nothing used it (no instance, no
  network interface, no launch template), so it was deleted by hand on 2026-10-18. The app's own
  groups take nothing in from the internet (a CDK test checks it). Launching from the console makes
  such a group again unless "Select existing security group" is chosen.
- **AWS CloudTrail Management Events Logging** (every Region red): there was no trail. The audit
  stack's trail `insights-account` logs management events of every Region, global services
  included, to `insights-account-trail-605411278365` with log file validation (digest files), kept
  a year; versioning keeps a deleted file 30 days. No CloudWatch Logs copy and no data events, both
  billed. Read events with `aws cloudtrail lookup-events` (last 90 days, no trail needed) or the
  files in the bucket.
- **IAM Access Analyzer - external access** (17 of 18 Regions red): only Sydney had an analyzer,
  made by hand on 2026-10-15. The StackSet `insights-account-access-analyzer` makes the account
  analyzer `insights-account` (free) in each of the 18 enabled Regions (`ACCOUNT_REGIONS` in
  audit-stack.ts; a Region enabled later needs adding there). One account analyzer is allowed per
  Region, so the hand-made Sydney one was deleted just before the first deploy of this stack and
  the StackSet made it again. Its roles: `insights-account-stackset-admin` (only this account's
  StackSets may assume it) and `insights-account-stackset-exec` (stacks and analyzers only).
  Findings: IAM console → Access analyzer, per Region.
- **MFA on Root Account**: the owner's step (Owner-only steps above).

Trusted Advisor re-reads these on its own schedule (about daily); "Refresh" on a check, or
`aws support refresh-trusted-advisor-check --check-id <id> --region us-east-1`, asks sooner.
