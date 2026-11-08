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
| Page while the server is down | A page request the function can't answer (connection failure, timeout, 429/5xx) fails over to the site's own "Service temporarily unavailable" page as a 503: a second distribution (stack output `FallbackDomain`) serves `_fallback/unavailable.html` from the same bucket for any path. The API's paths never fail over, so its own 502/503 messages reach the app. The smoke test fetches the page from the fallback. | `infra/cdk/lib/app-stack.ts`, `apps/web/src/app/unavailable`, `apps/aws/src/paths.ts` |
| Background jobs | SQS `insights-production-{sync,webhooks,aggregate,email,whatsapp}` + `-dlq` → Lambda `insights-production-jobs` | `apps/aws/src/consumer.ts`, `sqsQueues.ts` |
| Schedules | EventBridge Scheduler `*/15` and `03:15 UTC` → Lambda `insights-production-cron` (on since 2026-10-16: `schedulesEnabled` in `infra/cdk/lib/config.ts`) | `runScheduled()` in `apps/worker` |
| Migrations before the switch | Lambda `insights-production-migrate-before-live` (App stack, runs only during deploys, through the custom resource `MigrateBeforeLive`) runs a release's migrations on its new cron version before the `live` aliases move ("Migrations before the switch" below) | `infra/cdk/lib/migrate-before-live.ts`, `apps/aws/src/migrate.ts` |
| Database | RDS PostgreSQL 17 `insights-production` (db.t4g.micro, Multi-AZ: standby in the other AZ, private, encrypted, 14-day PITR) | `infra/cdk/lib/data-stack.ts` |
| Way out to the internet | EC2 NAT instances `insights-production-nat-a` / `-b` (t4g.nano, one per AZ, Systems Manager only) | `infra/cdk/lib/nat-instances.ts` |
| Coordinator | DynamoDB `insights-production-coord` | `apps/aws/src/dynamoCoord.ts` |
| Large webhook bodies | S3 `insights-production-payloads-605411278365` (7-day lifecycle) | `apps/aws/src/s3Blobs.ts` |
| Dumps, artifacts | S3 `insights-production-artifacts-605411278365` (30 days, versioned) | `infra/cdk/scripts/migrate-data.mjs` |
| Sign-in | Cognito pool `insights-production` (from `infra/aws/cognito.yaml`); its emails (codes) through Lambda `insights-production-cognito-email` and Resend, "Sign-in emails" below | `apps/api/src/cognito.ts`, `apps/aws/src/cognitoEmail.ts` |
| App email | Resend (bizinsights.io verified, live 2026-10-16); SES as fallback (sandbox: verified recipients only); "App email" below | `packages/core/src/mail/`, `apps/aws/src/mailers.ts`, `apps/aws/src/sesMailer.ts` |
| Secrets | Secrets Manager `insights/production/{app,db-owner,db-system,worker-cognito,evolution-api,evolution-db}` (`db-owner`: the cron and the admin host only; `db-system`: every function's database login, [system-database-role.md](system-database-role.md)); settings in SSM `/insights/production/runtime` | `apps/aws/src/secrets.ts` |
| WhatsApp service | Evolution API 2.3.7 on ECS Fargate: service `insights-production-evolution-a` in cluster `insights-production-whatsapp` (one task, private subnets, no public address), reached by the functions only at `http://evolution-a.whatsapp.production.insights.internal:8080` (Cloud Map); its own database `evolution` on the same RDS instance; logs `/ecs/insights-production-evolution-a` ([whatsapp.md](whatsapp.md)) | `infra/cdk/lib/whatsapp-stack.ts` (stack `InsightsWhatsapp-production`), `apps/aws/src/evolutionDb.ts` |
| Logs, alarms | CloudWatch (90 days), dashboard `insights-production`, SNS `insights-production-alarms`, budget US$80/month (emails `budgetEmail`) | `infra/cdk/lib/app-stack.ts` |
| DB admin | EC2 `insights-production-admin` (t4g.nano, Systems Manager only, normally **stopped**) | `infra/cdk/lib/data-stack.ts` |
| Audit (whole account) | CloudTrail `insights-account` (every Region) → S3 `insights-account-trail-605411278365` (1 year); IAM Access Analyzer `insights-account` in all 18 enabled Regions (StackSet `insights-account-access-analyzer`); GuardDuty (turned on by hand) | `infra/cdk/lib/audit-stack.ts` |

Redis/ElastiCache is not used: the app has no Redis; DynamoDB does its coordination (the WhatsApp
service keeps its sessions in its own memory and database). The only file uploads are WhatsApp
attachments, kept in the payloads bucket until they are sent (exports are generated on request), so
S3 holds only webhook bodies, those attachments and dumps.

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

Production's own settings are in `infra/cdk/lib/config.ts`, the schedules (`schedulesEnabled`), the
alarm email (`alertEmail`) and Google sign-in (`googleClientId`) among them, so this deploys the
same stacks as Deploy to AWS. A `-c` flag changes one for that deploy only: `-c schedules=off`,
`-c alertEmail=...`, `-c googleClientId=...` (an empty one keeps config.ts's).

The App stack runs the release's migrations on its new cron version before it moves `live`
("Migrations before the switch" below), so a hand deploy needs no migrate step of its own. Run the
migrate command ("Database" below) after `put-secrets.mjs` (it sets the roles' passwords), after a
deploy with `-c migrate=off`, and once the Auth stack exists after a new environment's first deploy
(the gate skips while there is nothing live or no runtime parameter yet).

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

`--set` refuses a value that hasn't that secret's shape (a Meta app secret is 32 letters and digits,
a Google one starts with `GOCSPX-`, ...) or that is one of the app's public settings, such as the App
ID copied instead of the secret: it then asks for the value instead, and saves nothing if that is
wrong too.

**Which provider secrets are there.** `node infra/cdk/scripts/put-secrets.mjs --dry-run` changes
nothing and ends with `keys now:`, the names (never the values) of everything in
`insights/production/app`. Each provider whose public id is in `apps/aws/src/settings.ts` needs its
secret among them:

| Public id in settings.ts | Secret | Without it |
| --- | --- | --- |
| `META_APP_ID` | `META_APP_SECRET` | Meta Ads says "Coming soon"; Meta connections stop syncing |
| `GOOGLE_ADS_CLIENT_ID` | `GOOGLE_ADS_CLIENT_SECRET` (the "Insights web" client's) | Google Ads and AdSense say "Coming soon"; their connections stop syncing |
| `WHATSAPP_CONFIG_ID` (set 2026-10-25), on the app `WHATSAPP_APP_ID` (empty, so `META_APP_ID`: WhatsApp's Cloud API option runs on the Meta Ads app "Insights") | `META_APP_SECRET` while WhatsApp is on the Meta Ads app, as now (the check names it so); `WHATSAPP_APP_SECRET` only on an app of its own; `WHATSAPP_WEBHOOK_VERIFY_TOKEN` too | WhatsApp's Cloud API option (Embedded Signup) can't be offered; linking a phone with a QR code still works (docs/whatsapp.md) |
| `SHOPIFY_API_KEY`, each app in `SHOPIFY_EXTRA_APPS` | `SHOPIFY_API_SECRET`, `SHOPIFY_APP_SECRET_<KEY>` | That Shopify app's stores can't install or refresh their access |
| `EMAIL_GOOGLE_CLIENT_ID`, `EMAIL_MICROSOFT_CLIENT_ID` (empty today) | `EMAIL_GOOGLE_CLIENT_SECRET`, `EMAIL_MICROSOFT_CLIENT_SECRET` | Connect Gmail / Outlook says it isn't set up |

WhatsApp's Cloud API option is off while `WHATSAPP_CONFIG_ID` is empty, and then nothing warns
about WhatsApp's Meta secret: the check's line on the Deploy run names what it still needs instead
("WhatsApp service on, Cloud API off (needs …)"). The WhatsApp service itself needs
`EVOLUTION_API_URL` and `EVOLUTION_API_KEY`, which the App stack and the secret
`insights/<env>/evolution-api` give every function: nothing to set by hand. With the configuration
id set (2026-10-25) the line should read "WhatsApp service on, Cloud API on"; Meta's own Tech
Provider steps (docs/whatsapp.md, "Owner's steps (Cloud API)") are not something it can see.

Every deploy also checks this from the cron function itself (smoke tests, "app configuration read
from the cron function"): each provider in that state is a warning on the Deploy run's summary
("Meta Ads isn't set up"), with the `put-secrets.mjs --env <env> --set <NAME>` command to run, and
the functions log `public id set but secret missing` once per cold start. Neither fails the deploy.
If the function gives no answer (throttled, timed out, the runner's network), the run says
"Provider secrets weren't checked" instead, and passes; only an error from the function itself, twice,
fails the smoke tests (and rolls back). To check by hand at any time, ask the cron function (booleans
and setting names only, never a value):

```powershell
aws lambda invoke --function-name insights-production-cron:live --cli-binary-format raw-in-base64-out --payload '{\"action\":\"config\"}' config.json
```

`config.json` then says which ad platforms, email integrations and sign-in options are on, what
the WhatsApp service and its Cloud API option still need (`whatsapp.evolutionNeeds`,
`whatsapp.embeddedSignupNeeds`), and lists under
`halfConfigured` each provider whose secret is missing. After adding one with `--set`, run
**Deploy to AWS** (Actions → Run workflow, on `main`) so new instances read it. For another
environment, pass `--env <name>` to `put-secrets.mjs` and use `insights-<name>-cron:live`, then
deploy that environment again by hand (`cdk deploy --all -c env=<name>`).

The functions read secrets at cold start; after changing one, force fresh instances with a deploy,
or publish the same code as a new version and move the `live` alias ("App email" below shows how:
changing `$LATEST` alone restarts nothing live).

If Node's connections time out on this PC's network (IPv6-only hotspot with NAT64), set
`$env:NODE_OPTIONS = "--network-family-autoselection-attempt-timeout=5000"` first.

## Deploy (GitHub Actions)

`.github/workflows/aws-deploy.yml` runs after CI passes on `main` (or by hand): build → `cdk
deploy` (the App stack runs the release's migrations on its new cron version, then moves `live`) →
`live` checked against the App stack's versions (below) → migrate again (normally nothing new:
grants, passwords) → smoke tests → automatic rollback of the `live` aliases if anything fails. It
signs in with GitHub OIDC (role in the `InsightsCi-production` stack), no AWS keys in GitHub.

The rollback moves the aliases with `rollback.mjs`, behind CloudFormation's back: the App stack
still records the new versions. Running that Deploy again for the same commit then finds "no
changes", and before 2026-11-03 nothing moved `live` forward again (Deploy 41661760406 failed its
smoke tests on the release before). So the step after `cdk deploy`, "The live aliases run what the
App stack deployed", runs `rollback.mjs --to stack`: each alias goes to the version in the stack's
`LiveVersions` output unless it already runs that code. After a normal deploy it is that version;
after a restart for runtime settings it runs the same code as a newer version and stays. Re-running
a rolled-back Deploy (`gh run rerun <id> --failed`) now puts its release live.

It is two jobs, so the app's dependencies never run where the deploy role is reachable:

- `build` installs everything, runs the AWS and CDK unit tests and builds the Lambda package
  (`apps/aws/dist/function`, API + UI). It has no `id-token` permission: nothing in it can ask
  GitHub for the token the deploy role trusts. The package goes to the Actions cache under a key
  made of the run id and the commit (artifact storage is full on this plan; caches made on `main`
  can't be written by pull requests).
- `deploy` (environment `production`, `id-token: write`) installs only `infra/cdk`'s tools
  (aws-cdk-lib, the CDK CLI, tsx) with `--ignore-scripts`, restores the package
  (`fail-on-cache-miss`), and does the rest. A re-run of only `deploy` finds the same package.

When the PC's connection drops calls, CDK can't reach STS: the log says its bootstrap roles
"could not be used to assume ... Proceeding anyway". It then falls back to the deploy role, which
is refused what only those roles may do (`ssm:GetParameter` on `/cdk-bootstrap/hnb659fds/version`),
or a socket "did not establish a connection". When the CLI's very first call, the account lookup,
doesn't get through, all it says is "Need to perform AWS calls for account ..., but no credentials
have been configured" (the job always has them). Either way nothing in AWS changed. So "Deploy (CDK)"
tries `cdk deploy` again a minute later when its output reads like the network, three attempts in
all; any other failure goes straight to the rollback. Three network failures in a row: put the PC
on a steadier connection, then re-run the `deploy` job. CloudTrail tells the two apart: a real
refusal shows `AssumeRole` events with `AccessDenied`, while a dropped connection shows none.

How much one run survives (aws-cdk 2.1143.0, from its source): every AWS call gets 10 s to connect;
S3 and CloudFormation calls get 7 tries (about 90 s), the account lookup 3. Assuming CDK's roles
gets the SDK's default of 3 tries (about 30 s), the one figure `AWS_MAX_ATTEMPTS` changes: the step
sets it to 10 (about 2 minutes), so a drop of a minute there no longer fails the run. The step also
sets the `NODE_OPTIONS` above: Node gives each of a host's addresses 250 ms before trying the next,
less than the hotspot's ~300 ms round trip, and S3 names 16 of them, so most connects came down to
the last address alone (6 of 15 to CDK's us-east-1 bucket got through within 10 s on 2026-10-23,
10 of 15 at 5000 ms). A hand deploy from this PC on the hotspot does well to set both
(`$env:AWS_MAX_ATTEMPTS = "10"`).

A connection that goes quiet mid-call is a different failure: nothing ever times it out. The CLI
gives each call 5 minutes (`requestTimeout`), but its HTTP handler only logs a warning when that
passes, and it sets no socket timeout. On 2026-10-23 (Deploy 40032504218, attempt 1) the PC was in
Modern Standby: CloudFormation finished `InsightsEdge-production` in 10 s, and the CLI waited 57
minutes on that stack's status until the job hit its 60-minute limit. A job cancelled at its limit
skips every later step, the rollback included. So the step also preloads
`infra/cdk/scripts/stall-guard.cjs` (`--require` in its `NODE_OPTIONS`): a request that goes 2
minutes without a byte either way ends with `ETIMEDOUT`, which the SDK retries like a dropped
connection, and the `network` pattern catches it if every try fails. And the step stops itself at
45 minutes, so a hang the guard misses fails the step and the rollback runs. A hand deploy can load
it too: add `--require <repo>\infra\cdk\scripts\stall-guard.cjs` to `NODE_OPTIONS`.

Dependency install scripts run, anywhere this repository is installed (CI, the deploy, a
developer's machine), only for the packages `pnpm.onlyBuiltDependencies` in the root
`package.json` names (esbuild, prisma, @prisma/engines). A new dependency that needs its install
script is added there on purpose, after a look at what the script does.
One-time setup in the repository's Settings → Environments → `production`: variable
`AWS_DEPLOY_ROLE_ARN` (the stack's `DeployRoleArn` output). The workflow also passes
`AWS_SCHEDULES` (`on` since 2026-10-16), `AWS_ALERT_EMAIL` and `GOOGLE_SIGNIN_CLIENT_ID` to
`cdk deploy`. They hold the same values as production's in config.ts, so they change nothing; a different
value overrides config.ts's for that deploy. Unset, each reaches the deploy empty, which keeps
config.ts's (production's schedules stay on); `AWS_SCHEDULES=off` still switches the schedules off
for every Deploy run while it is set. `AWS_WHATSAPP` (unset until the move to the iKorex server)
works the same way: `off` leaves the WhatsApp service with no task, from the cutover to stage F
(docs/ikorex-migration/AWS_TO_IKOREX_MIGRATION_MATRIX.md, cutover step 2); any other value keeps
config.ts's one task. Required reviewers and branch
rules for an environment need a paid plan for a private repository; the role's trust does that job.

The role admits a token only when all of these claims match exactly (`githubDeployClaims` in
`infra/cdk/lib/config.ts`; AWS STS has read GitHub's own claims since January 2026):

- `aud` = `sts.amazonaws.com`.
- `sub` exactly as this repository sends it, the immutable form
  `repo:html-proof@68529971/pixmagic-projects@1413246051:environment:production`
  (`githubOidcSubject`; the repository's OIDC subject setting is left as it is).
- `job_workflow_ref` = `html-proof/pixmagic-projects/.github/workflows/aws-deploy.yml@refs/heads/main`
  and `ref` = `refs/heads/main`: this one workflow file, run from `main`. `sub` names no branch, so
  with it alone (until 2026-10-18) any branch's workflow naming the `production` environment got
  the role.

A wrong trust locks every later deploy out (each run signs in before it deploys), and only the
account's root can put it back. So a deploy gives the role this trust only after proving, on
roles that grant nothing, that IAM checks the last two and this workflow meets them: "The trust
this commit deploys is proven", after sign-in and before `cdk deploy`, which stops the run
(nothing deployed, the live trust unchanged) if not. Every deploy repeats that proof.

The proof: three roles in the same stack (`githubTrustChecks`) that grant nothing (no policy at all).
`insights-production-github-trust-check` trusts exactly `githubDeployClaims`;
`…-trust-check-wrong-workflow` and `…-trust-check-wrong-ref` each swap one of the two claims for a ref
git can't name (`never..matches`), so no token ever carries it.

The workflow checks from both ends (`infra/cdk/scripts/oidc-trust.ts`, logic in
`infra/cdk/lib/oidc-trust.ts`):

- Before it signs in, "Token claims the deploy role requires" compares its own token with
  `githubDeployClaims`.
- Signed in, before `cdk deploy`, "The trust this commit deploys is proven" runs the trust-check
  part below (`oidc-trust.ts prove`) and stops the run unless it says "Proven".
- After the smoke tests, "The next deploy can still sign in" reads each trust-check role's live
  trust (`iam:GetRole`; STS also refuses a role that doesn't exist, so a refusal counts only from a
  role that's there). STS must then admit the workflow to the first and refuse it the other two
  ("Proven: IAM checks job_workflow_ref and ref…" in the log and the run's summary). Anything else
  is a warning: deploys still work, but IAM may no longer be checking those two claims, so the
  deploy role may admit more than this workflow; find out why (AWS changed something, or a
  trust-check role was changed). Last, STS must exchange a fresh token for the deploy role itself:
  if not, the step fails. Every session these create lasts 15 minutes, and its credentials are
  dropped unread.

Both steps do nothing when the commit being deployed predates the script: the workflow file is
always the default branch's, while the checkout may be an older commit's (a CI run that ended after
a merge). "Not authorized to perform sts:AssumeRoleWithWebIdentity" at sign-in means token and
trust differ: the first step prints the token's values.

Renaming `aws-deploy.yml` or deploying from another branch changes the token's claims, and a run
signs in with the trust as it was before it deploys. So it takes two pull requests. The first
makes the trust accept the old and the new value (IAM's `StringEquals` takes a list) and deploys
from the old workflow. The second switches the workflow and drops the old value.

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

### Migrations before the switch

A release's migrations ship in its own package, so only its new code can run them. Until
2026-10-31 the workflow ran them after `cdk deploy` had moved `live`: in release 141 the API's
alias moved at 06:13:11Z and the migrations ran at 06:14:18Z, about 67 s of new code reading
`stores.customers_from` before it existed (Prisma reads every column, so every read of a store
failed). Now the App stack's custom resource `MigrateBeforeLive` invokes the NEW cron version
(`insights-production-cron:<n>`) with `{"action":"migrate"}`, and the three `live` aliases wait
for it. The S3 uploads run alongside; Live-api also waits for them.

Its handler (`insights-production-migrate-before-live`, `infra/cdk/lib/migrate-before-live.ts`)
decides in this order, and its log line and the stack output `MigratedBeforeLive` say which:

1. Delete: nothing to do (`-c migrate=off`, or a commit from before the gate).
2. `skipped: rollback or nothing newer`: the version isn't newer than the one it last ran. A
   CloudFormation rollback sends exactly that, so a rollback never calls anything (and never runs
   an older init.sql, whose blanket GRANT would give app_rls back tables a newer one revokes). A
   hand `cdk deploy` of an older commit is different: it publishes that code as a NEWER version,
   which the gate runs, so deploy an older commit with `-c migrate=off` ("Roll back" below).
3. `skipped: stack <status>`: a new environment's first creation; nothing is live yet.
4. `skipped: no /insights/<env>/runtime yet`: App exists without Auth, whose parameter the new
   cron needs; Auth deploys after App, so the gate would otherwise never let it.
5. Runs the migrations and answers `applied <names> (<n> in all)`.

It runs once per new package (every new commit), never on a re-run of the same one. When the gate
fails, the App stack fails before any alias moves: CloudFormation rolls the stack back (2-5
runner minutes), the main distribution never starts updating (it waits for the Function URL,
which waits for the API's alias), "Deploy (CDK)" prints `::error::` and doesn't try again (a
database's `connect ETIMEDOUT` is no dropped connection), and "Roll back on failure" finds every
alias already where it was. The reason, after `migrate-before-live failed (nothing moved to the
new release):`, tells the two kinds apart. The cron's own error (`errorMessage`, `Migration <name>
failed: ...`) is a failed migration: fix it in a new commit. An AWS error name (AccessDenied,
TooManyRequestsException, ServiceException, ...) means it couldn't check the stack or reach the
cron, and no migration ran: run Deploy again; `AWS_MIGRATE_BEFORE_LIVE=off` is not the answer to it. A migration gets 14 minutes through the gate: split a longer one. A
migrate can arrive twice (CDK's provider framework calls the handler again when its call fails);
`migrate.ts` takes a Postgres advisory lock before it reads what has run, so the second waits and
then applies nothing.

The contract it brings: the release before keeps running on the new schema for up to a minute of
every deploy (between the migration and the alias move), and after any rollback. A migration adds;
it never drops or renames what the previous release reads, and a new NOT NULL column has a default
([database/migrations.md](database/migrations.md)).

Where to read it: the cdk line `Custom::MigrateBeforeLive`, the output
`InsightsApp-production.MigratedBeforeLive`, the log group
`/aws/lambda/insights-production-migrate-before-live`, and the cron's `migrations applied`. When
the deploy that creates the gate fails (its first deploy, or the first after turning it back on),
CloudFormation's rollback deletes the gate's two log groups with it: read the reason on the
`Custom::MigrateBeforeLive` line of the cdk output (the handler's error and its trace) and the
cron's log `/aws/lambda/insights-production-cron`. A `::warning::` from "Database migrations"
("Migrations applied only after the new code went live") means the gate didn't run them: find out
why in its log.

**A broken gate.** Set the repository variable `AWS_MIGRATE_BEFORE_LIVE=off` (Settings → Secrets and
variables → Actions → Variables) and run Deploy to AWS again: the gate is deleted, `live` moves as
before and "Database migrations" migrates after it, with 10 minutes for it (a longer migration
fails that step and rolls the aliases back while it still commits; running Deploy again then
applies nothing). By hand: `-c migrate=off`. Delete the variable
to turn it back on (its re-creation runs migrate once, nothing new). Should the App stack ever stop
in `UPDATE_ROLLBACK_FAILED` on `MigrateBeforeLive` (it shouldn't: the handler answers a rollback
without a call), the owner, after `aws login`, runs `aws cloudformation continue-update-rollback
--stack-name InsightsApp-production --resources-to-skip MigrateBeforeLive`; the deploy role can't.

### Keeping within GitHub's included minutes

GitHub Free includes 2,000 hosted minutes a month for private repositories; a pull request costs
about 13 (checks ~8, browser tests ~5, each job billed in whole minutes), its merge to `main` as
much again, and a deploy ~5. CI (`.github/workflows/ci.yml`) therefore runs only what a change can
affect:

- Only Markdown files or `docs/` changed: a push to `main` starts no CI run, and so no deploy
  (nothing to ship). A pull request still starts one: its first job finds nothing to test and the
  other two skip (about a minute), so the checks main's merge block waits for report.
- A pull request runs the browser tests only when it changes `apps/web`, `apps/aws`,
  `packages/shared`, the e2e stand-ins (`infra/cognito-local`, `infra/postgres`,
  `docker-compose.yml`), the dependencies or `ci.yml`, or has the label `e2e` (labels are read per
  push: add it, then push). A push to `main` always needs them before Deploy to AWS.
- Each pull-request job that passes records the code it tested: a commit status `ci/passed-<job>`
  ("code <key>") on the pull request's head, where the key hashes the tested commit's files less
  Markdown and `docs/` (`infra/runner/code-key.mjs`). Every run looks these up first (job "Already
  passed on this code?", about a minute) and skips each job that already passed on the same code:
  a pull request's run on its newest 30 commits, so a push that changed only Markdown or `docs/`
  costs a minute; a push to `main` on the commits it was made from and the head of the pull request
  it merged. That holds for `main` when its code hasn't moved since the pull request's last run: of
  several pull requests merged back to back, only the first saves anything. Records made before
  2026-10-29 name the exact tree ("tree <tree>") and still count. If that job fails (the PC can't
  reach GitHub, say), everything runs and the run's result is the other jobs' own: its red mark
  alone no longer stops Deploy to AWS. Until 2026-11-01 it failed the whole run, so `main` for #317
  could not deploy whatever its tests said.
- The integration tests (`pnpm test:integration` and the migrations check, ~4 of the checks job's
  ~7.5 minutes) run only when something they read changed since a run where they passed. The checks
  job hashes the git ids of `apps/api`, `apps/worker`, `packages/`, `test-support/`,
  `infra/postgres/`, the root `package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`,
  `tsconfig.base.json`, `.gitattributes` and `ci.yml`, with the runner's OS and Node version, and
  looks for a commit status `ci/passed-integration` ("key <key>") on the pull request's newest 30
  commits, on the `main` commit it starts from, that commit's parents and the head of the pull
  request it merged. Every pass records it again on its own commit, so records move forward.
  Unlike the tree check above, this also holds when `main` moved, as long as what moved is outside
  that list (the UI, the CDK app, docs). Tests that start reading a file outside the list need it
  added there (step "What the integration tests read").
- The records are commit statuses because they take no storage. Until 2026-10-19 they were
  artifacts, which count against the account's Actions storage (GitHub Free: 500 MB for all its
  private repositories together, artifacts and Packages). Once that was used up, every upload
  failed with "Artifact storage quota has been hit", no pass was recorded, and every push to `main`
  ran the whole ~45-minute suite. CI uploads no artifacts at all since 2026-10-30: a failed e2e
  test's page snapshot (Playwright's error-context.md) is printed in the "Run pnpm e2e" log
  instead, under "Page when it failed".
- A newer push waits for the run in progress on the same branch; then the newest waiting push runs
  (GitHub drops older waiting ones, "Canceling since a higher priority waiting request ... exists":
  those never started). On `main` the run in progress finishes and deploys, so merges minutes apart
  still deploy, at most one run behind. Before 2026-10-18 `main` cancelled, and that day only 2 of 8
  main runs reached Deploy. Making a pull request a draft is the one event that cancels its run in
  progress (holding it, below).
- On a pull request, the checks and e2e jobs start `infra/runner/stop-when-superseded.mjs`, which
  asks GitHub every minute for the pull request's head. Once a newer push arrives it compares the
  code the run tests (the pull request merged into `main`) with GitHub's merge of the newer head
  into `main`, Markdown and `docs/` aside. The same code (a push of only docs, or `main` merged into
  the branch by hand) lets the run finish, and the run for that push then skips what it passed.
  Other code, or a push that conflicts with `main`, cancels the run within a minute; the job's last
  step, "Newer pushes while this job ran", prints why, and the run's Annotations show it. Comparing
  the two heads instead would stop a run whenever `main` is merged into the branch: that lists
  every file `main` changed since the branch's last merge. Until 2026-10-29 every push
  cancelled the pull request's run in progress: a merge of a docs-only `main` into #290 cancelled
  its run 27 minutes into the checks, and the PC had to start over.
- Re-run a failed job only when it is flaky, not to retry a real failure.

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
on the system `PATH` are administrators-only (checked 2026-10-18). Node also looks in
`C:\node_modules` for any package a project lacks (vite asks for `fsevents`, which Windows never
gets), and any account may create folders at C:\, so the scripts keep that folder administrators'
too ("Hardening the runner"). Each job's PostgreSQL superuser has a password of its own: the two
runners' jobs can run at the same time, and a superuser can run programs as the account that
started the server. Server and clients use 127.0.0.1 only (with `localhost`, a job holding the
port on ::1 first could ask the tests for that password in clear), and psql and createdb accept
SCRAM only (`PGREQUIREAUTH`).

What the two runners still share: anything listening on localhost while a job runs. During main's
e2e job that is the app under test, the sign-in stand-ins and the Mailpit stand-in, on free ports.
A pull-request job could reach them as a client, and could log in to main's test database as the
tenant role `app_rls` (fixed password, no superuser) and change test data. That can make main's
tests fail or pass wrongly; it gives no way to run code as ghmain.

Labels alone wouldn't keep other jobs off it: any branch's workflow can ask for any label. Its job
hook (`infra/runner/main-only-hook.js`, which the runner runs with its own Node before every job;
a copy in `C:\ProgramData\bizinsights-runner`, administrators-only) fails every job before its first
step unless GitHub says it is `ci.yml` for a push to `main`, or `aws-deploy.yml` (or
`ikorex-deploy.yml`, docs/ikorex-migration) from `main` started by a CI run or by hand. Those values come from the job's github context, which a workflow file can't
change. A refused job's "Set up runner" step says why. The script writes the hook into the runner's
`.env` before it registers the runner, so a job already queued for the label meets the hook too.
It refuses a runner, hook or browsers folder that already exists and isn't an administrator's
(someone else may have planted files there for it to run elevated, or for ghmain to run).

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

It is safe to run again. First the folders jobs run code from, owned by Administrators
(`infra/runner/runner-folders.ps1`). A standard account can create folders at C:\ and in
C:\ProgramData, and a folder's owner can always rewrite its permissions, so the script stops at a
folder that someone other than an administrator, you or the runner it belongs to made first. Look
at what's inside, delete it in an elevated Command Prompt (`rmdir /s /q <folder>`), then run it
again.

- `C:\node_modules`: read-only to users (it creates it). Today any account could make it, and a
  `fsevents` folder planted there would run inside every test and deploy job.
- The e2e browsers (below), and the runner for main's hook folder.

Then, for each runner account that exists (ghrunner, ghmain):

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
readable by other accounts. Both are owned by Administrators from then on. By hand, for the first
(the second: `ghmain`, without the last grant; `C:\node_modules`: no `ghrunner` grant):

```powershell
icacls C:\ms-playwright /setowner "*S-1-5-32-544" /T /C /Q
```

```powershell
icacls C:\ms-playwright /inheritance:r /grant:r "*S-1-5-18:(OI)(CI)F" "*S-1-5-32-544:(OI)(CI)F" "ghrunner:(OI)(CI)M" "*S-1-5-32-545:(OI)(CI)RX"
```

```powershell
icacls "C:\ms-playwright\*" /reset /T /C /Q
```

(The last makes everything inside inherit exactly that.)

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
- The PC must be on, awake and plugged in: queued jobs wait up to 24 hours for the runner, then are
  cancelled. It's a laptop with Modern Standby, where the screen going off is the way into standby.
  Its screen goes off 2 minutes after the last input on AC and 3 on battery (as of 2026-10-20). On
  AC it then never sleeps (`standby-timeout-ac` is 0) and a job usually runs on at full speed with
  the screen off, but it still enters Modern Standby (Kernel-Power 506, `Reason` 12, on AC), and
  connections can stall there: on 2026-10-23 that took the runner offline for more than 12 minutes (15:06Z)
  and hung a deploy's `cdk deploy` (21:46Z, see "Deploy (GitHub Actions)"). Keeping the screen on
  while jobs run ends both: `powercfg /change monitor-timeout-ac 0` (the owner's, elevated). On
  battery it sleeps right after (DRIPS: the CPU runs nothing) while a test's clock
  keeps running, and it sleeps when the lid closes. On battery it also runs a job 2-3 times slower
  (the 5-minute e2e suite took 10-14). What that did: on 2026-10-18 it slept twice mid-pipeline;
  on 2026-10-19 a 78 s sleep (unplugged with the lid closed) failed `pnpm test:integration` with
  "Hook timed out in 60000ms" in a `beforeEach`; and the e2e job failed on 2026-10-19 at 21:50Z and
  twice on 2026-10-20 (05:51Z and 06:07Z, pull request #162) on a different test each time with the
  other 58 passing. Each of those ran on battery and 2-3 times slower, and in two of the three the
  PC entered standby in the middle of the suite (06:16-06:21Z: 279 s in DRIPS, inside one test's
  180 s budget). The test that fails is whichever has the least slack when the stall comes: the
  longest ones (the team spec's shared-link test, 150 s; the console spec), not the first after a
  wake (they were the 25th and the 55th of 59). The third attempt, plugged in, passed in 5 minutes.
  Every job on the PC holds a power request from its first steps to its end
  (`infra/runner/keep-awake.ps1`, step "Keep the PC awake for this job"), and the job logs show it
  held until each job ended, but from the runner's service session it evidently doesn't reset the
  screen-off timer: the screen went off 120 s after the owner's last input with the request held.
  So, two things in the repository and one for the owner:
  - On the PC runner a failed e2e test runs once more before the run fails (`retries: 1` in
    `apps/web/playwright.config.ts`, only while `RUNNER_ENVIRONMENT` is `self-hosted`) and the run
    passes with that test marked flaky; a real failure fails twice. The reporter lists each test
    with its duration, so a slow run names its slow tests. The build's budget is 7 minutes (190 s
    was seen on battery).
  - The last step of each job on the PC, "Did the PC sleep during this job?"
    (`infra/runner/power-report.ps1`), prints the standbys that overlapped the job (from the
    System log's Kernel-Power events 506 and 507: when, how long, how much of it in DRIPS, idle
    timer or lid, battery or AC) as a warning annotation, and whether the job ran on battery as a
    notice. Read it before re-running a job that timed out.
  - The owner's power settings, in an elevated PowerShell, keep the PC awake on battery while jobs
    run: `powercfg /change monitor-timeout-dc 0` (the screen stays on; off is the way into standby)
    and `powercfg /change standby-timeout-dc 0`. A closed lid still sleeps it unless the lid action
    is "do nothing" on battery as well as on AC: `powercfg /setacvalueindex SCHEME_CURRENT SUB_BUTTONS LIDACTION 0`,
    `powercfg /setdcvalueindex SCHEME_CURRENT SUB_BUTTONS LIDACTION 0`, then
    `powercfg /setactive SCHEME_CURRENT`. Or keep it plugged in while jobs run.
  Which sleep a failure was, by hand: the System log's Kernel-Power events 506 (entering standby,
  with `Reason`, 12 = the idle timer, and `LidOpenState`), 507 (leaving, `DurationInUs` and
  `DripsResidencyInUs`) and 105 (plugged in or out, `AcOnline`). The PC's clock is UTC+5:30, and so
  is vitest's "Start at". A busy PC (demos, other test runs, other sessions' builds) makes the
  integration tests and the e2e suite 2-3 times slower too and can time a test out even plugged in
  and awake (2026-10-19 20:28Z): re-run the job once the PC is quiet.
- While the runner deploys, nobody deploys by hand: the two don't share a lock.
- With one runner a pull request sometimes has to wait: another needs the runner first, or it has to
  land after another. Hold it by making it a draft (`gh pr ready <n> --undo`), never by cancelling
  its run. A cancelled run shows as failing checks, and held pull requests read as broken: on
  2026-10-28 five were closed as failed with their work unmerged, and #293 looked failed on
  2026-10-29. On a draft, CI cancels the queued or running run and skips every job (ci.yml), so the
  checks are grey and GitHub won't merge it until it's marked ready: `gh pr ready <n>` runs
  everything.
- "Artifact storage quota has been hit": the account's 500 MB of Actions storage is used up (see
  the CI list above). CI no longer uploads any artifact, so only a run of an older `ci.yml` shows
  it (its Playwright report step; that run's red comes from the failed test, named in the "Run pnpm
  e2e" log). On 2026-10-30 the whole account held ~1.3 MB of artifacts and uploads were still
  refused; GitHub's meter needs `gh auth refresh -s user` to read. Storage per private repository:
  `gh api repos/html-proof/<repo>/actions/artifacts --paginate --jq '.artifacts[].size_in_bytes'`.
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
- Migrations run inside every `cdk deploy`, before `live` moves ("Migrations before the switch"),
  unless it was deployed with `-c migrate=off`. Again by hand: after a `-c migrate=off` deploy this
  applies the release's migrations; otherwise it applies nothing new and re-applies init.sql's
  grants and the roles' passwords. In Windows PowerShell (in Git Bash, without the backslashes):

  ```powershell
  aws lambda invoke --function-name insights-production-cron:live --cli-binary-format raw-in-base64-out --cli-read-timeout 960 --payload '{\"action\":\"migrate\"}' migrate.json
  ```
- The WhatsApp service's own database `evolution` and its role (secret `insights/production/evolution-db`)
  are made by the cron's `evolution-db` action, which the WhatsApp stack runs when it is first
  deployed. Again by hand (idempotent): the same command with `{"action":"evolution-db"}`.
- psql: start the admin host, then `aws ssm start-session --target <instance id>` (needs the Session
  Manager plugin), credentials from the `insights/production/db-owner` secret. Stop it afterwards.
- Restore: RDS point-in-time restore (any second in the last 14 days) to a new instance, or a dump
  from the artifacts bucket through the admin host.

## Test

`node infra/cdk/scripts/smoke.mjs` checks, from outside: pages, 404, edge caching, security
headers, HTTPS redirect, `/api/readyz` (database as owner and tenant role, coordinator), 401 on
protected routes, the Cognito wiring (a password-reset request for an address that doesn't exist),
CSRF, CORS, Shopify HMAC refusal, that the function URL refuses requests that skip CloudFront, and
on the AWS side: database private and encrypted, buckets private, functions healthy, what the app
has set up (the cron action `config`; a provider whose secret is missing is a `::warning::`, not a
failure, and so is no answer from the function; only an error from the function fails it: "Which
provider secrets are there" above), DLQ empty, and that the public address runs
what was deployed: `https://bizinsights.io/api/version` must name the commit checked out where
smoke.mjs runs, and the api function's `live` alias version as its
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
| `_eab665a4a171b7418b4d9e90cb9d56bd.auth` | CNAME | `_442b2e17b5d149c6ab91d07e32ce1239.wzccmgtwzk.acm-validations.aws` | DNS only |
| `auth` | CNAME | `db11p1sm9fnn5.cloudfront.net` (the Auth stack's output `CustomDomainTarget`: Cognito's CloudFront distribution for the own sign-in domain; added 2026-10-20) | DNS only |
| `_dmarc` | TXT | `v=DMARC1; p=quarantine; adkim=r; aspf=r; rua=mailto:dmarc_rua@onsecureserver.net;` (from GoDaddy, kept) | DNS only |
| `_domainconnect` | CNAME | `_domainconnect.gd.domaincontrol.com` (from GoDaddy, kept) | as imported |

- **Certificate**: ACM in us-east-1 (CloudFront's region), `bizinsights.io` + `www.bizinsights.io`,
  `arn:aws:acm:us-east-1:605411278365:certificate/776966d7-d73c-4896-bd30-1568c9f7b3f7`, DNS-validated
  by the two `acm-validations.aws` records. ACM renews it by itself while they stay: never delete them.
- **Sign-in certificate**: `auth.bizinsights.io` (the Cognito own domain, cognito-setup.md section 7)
  has its own, `arn:aws:acm:us-east-1:605411278365:certificate/b0849d46-9714-4de4-b893-a9ab1171761d`
  (requested 2026-10-20 in the ACM console; the app's certificate has no wildcard), validated by the
  `_eab665…auth` record above, which likewise stays for renewals.
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
  - **Where a device signed in from** (Settings → Security's device list and sign-in activity): the
    viewer-request function passes Cloudflare's `CF-IPCountry` on as `x-insights-viewer-geo`, and
    `CF-Region` / `CF-IPCity` too once the zone sends them: Rules → Transform Rules → Managed
    Transforms → **Add visitor location headers** (any plan). Without it the list shows the country
    only. Requests that don't come through Cloudflare get CloudFront's own `CloudFront-Viewer-*`.
  - **AI Labyrinth** on. Cloudflare's own **Security.txt** (Security → Settings) is **off** since
    2026-10-23: while on, Cloudflare answered `/.well-known/security.txt` at its edge and hid the
    site's `apps/web/public/.well-known/security.txt` (it still gave the old contact address after
    the site's file changed). The site's file is the one to edit; it expires 2027-10-15, so renew its
    `Expires` line before then. Cloudflare's copy is kept, switched off: don't switch it back on.
  - Rollback: switch the two records back to **DNS only**. Nothing in AWS has to change: from
    anywhere but Cloudflare's ranges `CF-Connecting-IP` is ignored.
- **One origin**: the session cookie, the CSRF check and every OAuth callback use APP_URL
  (`https://bizinsights.io`, set on the functions by the App stack). CloudFront answers on
  `bizinsights.io`, `www` and its own name; the viewer-request function sends GET/HEAD on the other two
  to `https://bizinsights.io` with a 301 (same path and query parameters; their order may change) and
  serves other methods where they arrive (webhooks and pixel events don't follow redirects).
- **HSTS**: CloudFront's security headers send `max-age=31536000; includeSubDomains`, so every name
  under bizinsights.io must serve HTTPS.
- **Email**: Cloudflare Email Routing receives for the domain (MX `route1/2/3.mx.cloudflare.net`) and
  forwards support@ and link@ to the owner's inbox ("App email", "Who each email comes from").
  SES sends from it (`no-reply@`, `support@`, `link@`):
  identity `bizinsights.io` in ap-southeast-2 with Easy DKIM, its three `<token>._domainkey` CNAMEs
  → `<token>.dkim.amazonses.com` in this zone, DNS only (added 2026-10-16). The existing `_dmarc`
  record (p=quarantine, relaxed) passes on the DKIM signature. Replies go to a message's Reply-To.

Records before the switch (GoDaddy's parking page, imported by Cloudflare on 2026-10-15), for a
rollback: `A bizinsights.io 15.197.148.33` and `A bizinsights.io 3.33.130.190` (both proxied),
`CNAME www → bizinsights.io` (proxied). Putting them back (and `domain` out of config.ts) returns the
app to `d2mr8m2p1qkh58.cloudfront.net`.

## Roll back

`node infra/cdk/scripts/rollback.mjs` moves the `live` aliases of api, jobs and cron to the previous
version (UI included, it ships in the api package). The next deploy moves them forward again: a
new commit's, or the same commit's run again, whose `rollback.mjs --to stack` step moves each alias
to the App stack's `LiveVersions`. By hand, after `aws login`: `node infra/cdk/scripts/rollback.mjs
--env production --to stack` (add `--dry-run` to see the moves first).
Migrations are not undone, and neither a CloudFormation rollback nor rollback.mjs re-runs one.
Infrastructure: `cdk deploy --all -c migrate=off` of the previous commit. Without `-c migrate=off`
the gate runs that commit's migrate on its newly published cron version, and its older init.sql's
blanket GRANT gives app_rls back any table a newer init.sql revokes, until the next forward deploy;
don't run the migrate command after it either. A commit from before production's schedules, alarm
email and Google sign-in were put in config.ts (its `infra/cdk/lib/config.ts` has no `googleClientId`)
had them from the workflow's GitHub variables only: give them on the command line, or that deploy
switches the schedules, the alarm emails and Continue with Google off:

```powershell
npx cdk deploy --all --require-approval never -c migrate=off -c schedules=on -c alertEmail=bizinsightsaus@yahoo.com -c googleClientId=567753266621-ltq5j5kij5s3em8gr0err3tbrh5fqciq.apps.googleusercontent.com
```

Data: point-in-time restore. Cognito's email
function has no alias (rollback.mjs leaves it): to have Cognito send its own emails again, deploy
the Auth stack with `-c cognitoEmail=off` ("Sign-in emails" below).

## Cutover (owner's go-ahead needed; not done yet)

> **Overtaken in part (2026-10-16).** Both Shopify apps already point at bizinsights.io (step 4), and
> stores now reconnect on AWS directly: PixMagic did at 09:32 UTC, with its pixel re-pointed and its
> orders re-imported. Step 2's `--replace` wipes the AWS database first, so it would now erase those
> stores and the accounts that claimed them. Don't run step 2 as written: decide first what to copy
> from the PC database (old pixel/funnel history, users who haven't come back) and merge it in.

Before the window: provider secrets the stores in use need (`GOOGLE_ADS_CLIENT_SECRET` for AdSense
refreshes; `SHOPIFY_APP_SECRET_PIXMAGIC` is set) with `put-secrets.mjs --set`, and the bizinsights.io
redirect URIs registered at Google and Meta (needed already, whatever the cutover: "Owner-only steps"
below). A new secret reaches the functions only when they start, so run **Deploy to
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
3. **Schedules on:** done 2026-10-16 (then by the GitHub variable `AWS_SCHEDULES=on`). Production's
   `schedulesEnabled` in config.ts keeps them on in every deploy, by hand too.
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
   email; an account merged in from the old database gets back in by signing up again with the same address, its old password no longer works: [cognito-setup.md](cognito-setup.md), section 4), stop the admin host. Other integrations
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

- Cloudflare account `b45818e0a9b504baa7a9862d43827456`: the Worker `insights` on its workers.dev
  address (with its Durable Object `Coordinator` and its two cron triggers; the app's address is
  https://bizinsights.io/), the queues `insights-sync`, `insights-webhooks`, `insights-aggregate`, `insights-email`
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
   Google Search Console verifies the old Worker's address through the tag in
   `apps/web/src/app/layout.tsx`; https://bizinsights.io/ is verified on its own as a Domain property
   (DNS TXT record, 2026-10-19), so the tag can go with the Worker.
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

**Who each email comes from** (`packages/core/src/mail/senders.ts`, settings in
`apps/aws/src/settings.ts`). A message names its purpose (`MailOptions.purpose`), and the provider
takes the From address from the settings for that purpose; nothing a request carries can name a
sender.

| Purpose | From | Settings |
| --- | --- | --- |
| Sign-up, sign-in, email verification and password-reset codes; the temporary password | `BizInsights Support <support@bizinsights.io>` | `OTP_FROM_EMAIL`, `OTP_FROM_NAME` |
| Dashboard invitations (shared links) | `BizInsights <link@bizinsights.io>` | `LINK_FROM_EMAIL`, `LINK_FROM_NAME` |
| Staff Management: employee portal invitations | `BizInsights <staff@bizinsights.io>` | `STAFF_FROM_EMAIL`, `STAFF_FROM_NAME` |
| Everything else (alerts, stock alerts, sign-in method notices, the daily cost report) | `bizinsights <no-reply@bizinsights.io>` | `EMAIL_FROM` |

The codes sign off with the support address and the invitations add "Need help with bizinsights?
Contact support@bizinsights.io" (`SUPPORT_EMAIL`); invitations still send replies to the person who
sent them. An empty `OTP_FROM_EMAIL`, `LINK_FROM_EMAIL` or `STAFF_FROM_EMAIL` sends those emails from
`EMAIL_FROM` again.

- **Sending** from any `@bizinsights.io` address needs nothing more: Resend and SES both verify the
  domain, not single addresses (checked 2026-10-23: `resend._domainkey` DKIM, SPF on `send.`, DMARC
  `p=quarantine` with relaxed alignment, which Resend's DKIM passes). A sender on another domain
  would be refused (`not_allowed`).
- **Receiving**: Cloudflare **Email Routing**, on since 2026-10-24 (Cloudflare dashboard → Email
  Service → **Email Routing** → bizinsights.io). It added three MX records (`route1/2/3.mx.cloudflare.net`),
  the apex SPF `v=spf1 include:_spf.mx.cloudflare.net ~all` and its own DKIM key
  `cf2024-1._domainkey`, all shown as *Locked* there; Resend's records on `send.` and
  `resend._domainkey`, SES's DKIM CNAMEs and `_dmarc` are untouched. Destination
  `bizinsightsaus@yahoo.com` (verified); rules `support@bizinsights.io`, `link@bizinsights.io` and
  (since 2026-10-25) `staff@bizinsights.io` → that destination, all *Active*. The catch-all is off
  (Drop), so mail to any other address is dropped: a new sender address needs its own rule. A new
  destination must be verified (Cloudflare emails it a link) before a rule can use it. Check: send to support@bizinsights.io and see it in the Yahoo inbox, or its "Forwarded" line
  in Email Routing → Activity log.

**Restarting the functions after a secret changes.** They read secrets at a cold start, and the `live`
aliases point at published versions, so changing `$LATEST` alone restarts nothing live. Publish the
same code again and move the alias (what was done for v47 on 2026-10-16; the next CDK deploy publishes
its own version as usual):

```bash
for f in api jobs cron; do n=insights-production-$f; d=$(aws lambda get-function-configuration --function-name $n --query Description --output text); aws lambda update-function-configuration --function-name $n --description "$d · secrets reloaded" >/dev/null; aws lambda wait function-updated --function-name $n; v=$(aws lambda publish-version --function-name $n --query Version --output text); aws lambda update-alias --function-name $n --name live --function-version $v >/dev/null; done
```

Check first that `$LATEST` holds the live code (same `CodeSha256` as the alias's version), or this
would ship whatever `$LATEST` has.

A Deploy to AWS run does this by itself when the deploy changed `/insights/production/runtime` (its
step "Restart the functions on changed runtime settings", with the run's id in the description): a
secret changed in Secrets Manager alone still needs the loop above. Its log says "Runtime settings
unchanged: nothing to restart." on most runs. "Couldn't read the runtime settings" means it restarted
nothing, and the AWS CLI's error just above it says why. Until 2026-11-01 every run said that: on the
PC's runner, Git Bash rewrote `--name /insights/production/runtime` into a Windows path
(`C:/Program Files/Git/insights/...`), a parameter the deploy role can't read. Both steps now run with
`MSYS_NO_PATHCONV=1`. The same applies to any AWS CLI command you type in Git Bash with an argument
that starts with `/` (`aws logs tail /aws/lambda/...`): put `MSYS_NO_PATHCONV=1 ` in front of it, or
run it in PowerShell.

## Sign-in emails (Cognito's codes)

Cognito doesn't send its own emails in production: sign-up and email-change codes, password-reset
codes, sign-in codes and temporary passwords go to the pool's **Custom Email Sender** trigger, the
Lambda `insights-production-cognito-email` (Auth stack; `apps/aws/src/cognitoEmail.ts`, its own
`cognito-email.mjs` in the same package). Cognito encrypts each code with the KMS key
`alias/insights-production-cognito-email`; the function decrypts it (AWS Encryption SDK), words the
email for its trigger (`packages/core/src/mail/authEmails.ts`) and sends it through the app's mail
provider (Resend, `RESEND_API_KEY` from `insights/production/app`) from `support@bizinsights.io`
(the support sender, "Who each email comes from" above; the Auth stack gives the function
`OTP_FROM_EMAIL`, `OTP_FROM_NAME` and `SUPPORT_EMAIL`).
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
  Cognito's documentation lists SES email configuration as its requirement (checked again on
  2026-10-21: "Requires Essentials feature plan or higher and Amazon SES email configuration", also
  for email as a second factor), which a custom sender doesn't replace.
- **The code after the password** (`AUTH_LOGIN_EMAIL_CODE=1` in `apps/aws/src/settings.ts`, since
  2026-10-21) is the API's own, sent by the API function through Resend, not by this trigger:
  [cognito-setup.md](cognito-setup.md) section 8. Its failures are in the API function's log
  ("could not email a sign-in code"), not in this alarm. Sign-up codes still come through here, and
  the API accepts them for 60 seconds only (the email says so), whatever Cognito's 24 hours.

## Owner-only steps

- **Mail to support@ and link@**: **done 2026-10-24**, Cloudflare Email Routing forwards both to
  `bizinsightsaus@yahoo.com` ("Who each email comes from", above).
- **MFA on the root user** (Trusted Advisor "MFA on Root Account"): **done 2026-10-22**, a
  passkey/security key (`aws iam list-mfa-devices` as root lists it; `aws iam get-account-summary`
  says `AccountMFAEnabled` 1). To add or replace one: sign in as root → account menu (top right) →
  **Security credentials** → **Multi-factor authentication (MFA)** → **Assign MFA device**. Root
  can hold up to eight, so a second one kept elsewhere means a lost key doesn't lock the account.
  It needs the owner's own device, so no deploy can do it. `aws login` keeps working (the browser
  sign-in asks for the key).
- **Alerts**: the alarms email `alertEmail` (config.ts: bizinsightsaus@yahoo.com), an SNS
  subscription that works only once confirmed from AWS's first email to that address. The budget
  already emails `budgetEmail` (config.ts) and needs no confirmation.
- **WhatsApp's Cloud API option**: Meta's Tech Provider steps (business verification, App Review,
  the app's WhatsApp webhook), in Meta's consoles only: [whatsapp.md](whatsapp.md), "Owner's steps
  (Cloud API)". Linking a phone with a QR code needs nothing from the owner.
- **Support plan**: the account signed up with a paid plan (Business Support+, the greater of
  US$29/month or 9% of the bill). Basic support is free; switch in Support Center → Support plans →
  Basic Support → Review downgrade. AWS refuses until the 30-day minimum ends (tried 2026-10-18), so
  from 2026-11-14 ~04:43 UTC; a one-time reminder task (`aws-support-plan-to-basic`) fires that day.
- **Google sign-in**: the steps are in [cognito-setup.md](cognito-setup.md), section 2: an OAuth
  client in a Google Cloud project of its own (only `openid`, `email`, `profile`; not
  `insights-511119`) with the redirect URI
  `https://insights-605411278365.auth.ap-southeast-2.amazoncognito.com/oauth2/idpresponse`, its secret
  through `put-secrets.mjs --set GOOGLE_SIGNIN_CLIENT_SECRET`, its client id as production's
  `googleClientId` in config.ts (the GitHub `production` environment variable
  `GOOGLE_SIGNIN_CLIENT_ID` holds the same id and overrides it when different), then a Deploy to AWS
  run (no hand deploy), which restarts the functions when the runtime settings change. A run that
  can't read the settings (every run before
  2026-11-01, through Git Bash's path rewriting) only warns: if such a run switched Google on, restart
  them by hand once ("Restarting the functions", above).
  Sign-in codes already go out through Resend
  ("Sign-in emails" above).
- **Provider secrets**: nothing records that META_APP_SECRET (Meta app 971575545351940, App settings →
  Basic) and GOOGLE_ADS_CLIENT_SECRET (Google Cloud client "Insights web") were put in
  `insights/production/app` after the move from Cloudflare (the old Worker's values didn't move by
  themselves). WHATSAPP_WEBHOOK_VERIFY_TOKEN is set (2026-10-25); WHATSAPP_APP_SECRET isn't needed
  while WhatsApp runs on the Meta Ads app (META_APP_SECRET serves). Check with
  `put-secrets.mjs --dry-run` ("Which provider secrets are there" above; the Deploy run's warnings
  say the same), add each missing one with `put-secrets.mjs --set <NAME>`, then run Deploy to AWS.
  Until then Meta Ads, Google Ads and AdSense say "Coming soon" and their connections don't sync.
- **Custom domain**: done, bizinsights.io (above). The app has sent only bizinsights.io callbacks since
  2026-10-16, so Google and Meta need these redirect URIs registered now (exactly, and nothing on the old
  hosts once nothing uses them): `https://bizinsights.io/api/ads/google/callback` and
  `https://bizinsights.io/api/ads/adsense/callback` on the Google client "Insights web", and
  `https://bizinsights.io/api/ads/meta/callback` in Facebook Login for Business of Meta app 971575545351940
  (bizinsights' own sign-in: [ads-setup.md](ads-setup.md#how-connecting-works); steps in
  [ads-review-packs.md](ads-review-packs.md)). Nango's old `…/api/ads/nango/oauth-callback` was removed from both on
  2026-11-02 ([ads-setup.md](ads-setup.md#leaving-nango), step (d));
  and, once their clients
  exist, `https://bizinsights.io/api/email/oauth/google/callback` and `.../microsoft/callback`. Both
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
| CloudWatch: 33 alarms (26 of the App stack's 27, its `whatsapp-service-unreachable` being in the WhatsApp row; 6 for the NAT instances; Cognito's email), 10 free, US$0.10 each (three added 2026-10-29: `sync-jobs-failed-for-good`, `ad-connections-need-merchants`, `ad-figures-differ`, +0.30; recounted the same day, the 25 before were 30); logs, dashboard and the 10 custom metrics the log filters count (10 free; an 11th would be US$0.30) in the free tier | ~2.3 |
| Secrets Manager (3 × $0.40 + calls), KMS (Cognito email key + ~60-90k requests, 20k free) | ~2.5 |
| Admin host's disk (stopped), EBS snapshots, SQS (~1.3 M requests, 1 M free), S3, DynamoDB, SES (X-Ray tracing is off since 2026-11-06: nothing read the traces) | ~2.4 |
| Audit stack (since 2026-10-18): the trail's first copy of management events is free, and so are the 18 external-access analyzers; its bucket's log and digest files (S3 PUTs from 18 Regions every ~5 minutes, ~200-270 bytes per event compressed, ~1-3 GB a year kept for 395 days) | ~0.35 (≤1) |
| Lambda, CloudFront, Cognito, Scheduler, SNS, ACM (always-free tiers; the account has no 12-month free tier or credits) | 0 |
| WhatsApp's Evolution API service (priced 2026-10-25): Fargate task 0.5 vCPU + 1 GB on Graviton, 17.29 on demand, **on Fargate Spot since 2026-11-06** (AWS states up to 70 % off; the bill gives the figure); Cloud Map's private zone ~0.60; its two secrets 0.80; its three alarms 0.30 ([whatsapp.md](whatsapp.md), "Cost") | ~19 on demand |
| **Total** | **~107.3** (~118 with GST) |

The figures in this paragraph were worked out with CloudWatch at ~1.5, before the recount and the
three alarms of 2026-10-29: add 0.80 (0.88 with GST) to each. They leave out the WhatsApp service, which adds ~19 (~21 with GST) to each
(on Fargate Spot, `whatsapp.spot` in config.ts, its task would be about 5). With the reservation it is ~79.5 (~87.5 with GST). Turning off GuardDuty's Advanced RDS add-on as well
brings it to ~72.8 (~80 with GST): that was the only combination under the US$80 budget before the
audit stack. The owner chose to keep Advanced RDS (2026-10-18). The admin host adds
~3.9 while it runs. Before GuardDuty's trial ends the total is ~76. A paid **support plan** comes on
top: the account is on Business Support+ (AWS's price list names its sign-up product
`AWSSupportEssential` "AWS Business Support+"), the greater of US$29/month or 9% of the bill
(Owner-only steps).

**What the bill shows** (Bills page and Cost Explorer, read 2026-10-18 ~15:10 UTC): October so far
US$26.46 = US$24.06 of charges + US$2.40 GST. **US$15.72 of the 24.06 is Business Support+**
("Recurring monthly charge (2026-10-15 to 2026-10-31)", US$29 prorated). The app's own resources were
~8.3: RDS 3.71, EC2 2.93 (the NAT gateway's last day included), WAF 0.87, public IPv4 0.45, Cost
Explorer API 0.15 (US$0.01 a call, so a cost audit costs ~0.15), the rest a few cents each. Cost
Explorer starts on 2026-10-16, too little history for AWS's forecast. Usage per day fell from 3.30
(2026-10-16: NAT gateway + single-AZ db.t4g.small) to 2.85 (2026-10-17, the switch) and runs at ~2.5,
the table above without GuardDuty; traffic was flat or falling (API invocations 11.7k → 8.0k → 4.1k
a day). Every charge is in Sydney except the WAF (global) and the Cost Explorer API (us-east-1); a
sweep of all 18 enabled Regions found nothing else: no load balancer, NAT gateway, Elastic IP,
cache, container, Backup plan or trial service (Inspector, Security Hub, Config, Macie all off).
Expected: October ~US$63 with GST (support 15.72 + ~41 usage), November ~US$105-120 (support for the
month, GuardDuty billing from ~14 November), then ~96, or ~87.5 with the reservation. So the budget
emails at 50% (US$40, ~23 October) and 75% (US$60, ~30 October) come from the support plan, not a leak.

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
of the alerts because CloudFormation replaces a budget whose alerts change. The alarm topic still
has no subscriber.

**Cost Anomaly Detection**: AWS's `Default-Services-Subscription` (on its `Default-Services-Monitor`)
emails `budgetEmail` daily about any anomaly with a total impact of **US$5** or more (set by hand
2026-10-18; AWS's default, US$100 and 40%, never fires at this account's size). AWS made the
monitor, so it is not in CDK. Detection needs about 10 days of history (from ~26 October). Back to
AWS's default: `aws ce update-anomaly-subscription --region us-east-1 --subscription-arn
arn:aws:ce::605411278365:anomalysubscription/b4c7c83e-dfb5-4310-b5c3-83da07099523
--threshold-expression` with `{"And":[...]}` of `ANOMALY_TOTAL_IMPACT_ABSOLUTE` ≥ 100 and
`ANOMALY_TOTAL_IMPACT_PERCENTAGE` ≥ 40. Its subscriber is set by hand too, so a new `budgetEmail` needs
the same command with `--subscribers Address=<address>,Type=EMAIL` (done 2026-10-22 for
bizinsightsaus@yahoo.com).

**Daily cost email** (`costReport` in config.ts, on in production only): every morning at 07:00
Melbourne time the `CostReport` schedule runs the cron function's `{"action":"cost-report"}`
(apps/aws/src/costReport.ts). It makes one Cost Explorer `GetCostAndUsage` call (us-east-1, DAILY,
UnblendedCost grouped by SERVICE, from the 1st of the month to the end of yesterday in UTC) and
emails `budgetEmail` through Resend (not SES) the cost of yesterday (UTC) by service, the month so far,
and a reminder that Cost Explorer runs about a day behind the Bills page and leaves out the support
plan and GST until the invoice. Each call costs US$0.01, so ~US$0.30 a month. The cron role has
`ce:GetCostAndUsage` and nothing else of Cost Explorer. It runs whatever `schedules` says, since it
touches no store. A failure is retried twice, then lands in the missed-ticks queue (alarm). Send one
now: `aws lambda invoke --region ap-southeast-2 --function-name insights-production-cron:live
--cli-binary-format raw-in-base64-out --payload '{"action":"cost-report"}' out.json`. The answer and
the log line `cost report sent` carry Resend's message id, never the address. Turn it off with
`costReport: false` (or `-c costReport=off` for one deploy).

Not costing anything yet, but watch: three manual RDS snapshots never expire, and backups may pass
the 20 GB free allowance once the 14-day chain fills; four log groups keep logs forever (the RDS
postgresql group and three CDK helper groups; 1.1 MB together on 2026-10-18, under a cent a month,
not worth a deploy yet); storage autoscaling can grow the disk to 100 GB and it never shrinks back.

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
- **WhatsApp service**: one Fargate task (a WhatsApp session can't be open in two places), placed in
  either AZ's private subnet. A task that stops is replaced, and sessions resume from its database
  without a new QR code; meanwhile messages wait (docs/whatsapp.md, "Scaling"). Since 2026-11-06 the
  task runs on Fargate Spot, so AWS can also reclaim it; the same replacement follows
  (docs/whatsapp.md, "Cost").

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

**Buckets** (Trusted Advisor "Amazon S3 Bucket Versioning"): all are versioned. Earlier versions
expire by themselves: build files (`site`) after 30 days, database dumps (`artifacts`) after 7,
webhook bodies (`payloads`) after one day, since processed bodies hold customer data. Together that
is a few cents a month at most.

**Access logs** (Trusted Advisor "Amazon S3 Server Access Logs Enabled"; infra/cdk/lib/s3-access-logs.ts):
every bucket writes a line per request (who, what, when, from where, the result) to its Region's
log bucket, under `<bucket name>/`. `insights-production-s3-logs-605411278365` (Data stack) takes
the five in Sydney: `payloads`, `artifacts`, `site`, the trail bucket, and
`cdk-hnb659fds-assets-605411278365-ap-southeast-2`, the bucket `cdk bootstrap` made, which no stack
owns, so the audit stack sets its logging by a call (a custom resource; removing it turns the
logging off). `insights-production-s3-logs-us-east-1-605411278365` (Edge stack) takes CDK's bucket
in us-east-1 the same way, since S3 delivers within a Region only. Files are kept 90 days;
delivery is free and the storage cents. S3's logging service may write only from this account's
buckets (`aws:SourceAccount`). Files arrive within a few hours, best effort. The log buckets log
nothing themselves (S3: a destination bucket should not have logging on, or its own deliveries
would log each other without end), so Trusted Advisor lists those two rows, excluded. Staging gets
its own Sydney log bucket; CDK's two buckets are logged by production alone.

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
  and CPU, the WhatsApp service (`whatsapp-service-down`, `-memory`, `-unreachable`), plus RDS's own events (availability, failure, failover, low storage, maintenance,
  recovery, restoration). **Nobody receives them until an alert email is set** (Owner-only steps).
- Alarms on what the logs say (log metric filters in `infra/cdk/lib/app-stack.ts`): bursts of error
  lines per function, texts on hold, automated messages refused, WhatsApp's service not answering;
  and, each counted over an hour (what to do: [RUNBOOK.md](RUNBOOK.md)):
  - `sync-jobs-failed-for-good`: 10 or more sync-queue jobs ran out of attempts in an hour (the
    jobs function's `"sync job failed"` line with `"final":true` and `"attempts"` 6 or more, core's
    `MAX_ATTEMPTS`). A failure no retry helps is final on its first attempt and isn't counted: a
    paused or closed shop, refused access and the like come back with every daily reconcile, which
    starts all stores in the same tick, so a few such stores would set it off every day. Each
    failure already reaches its merchant (an alert, or the ad account's card); one store's jobs make
    a handful at most, so ten is more than one store's.
  - `ad-connections-need-merchants`: 10 or more ad connections turned to Reconnect or permission in
    an hour (`"ad connection needs the merchant"`, logged once per connection when it turns, from
    any of the three functions). One merchant's sign-in ending turns the accounts connected with it,
    one to a few per store, and each sign-in ends at a time of its own; ten in an hour is a break at
    the platform or in bizinsights' app. A store that connected ten or more ad accounts with one
    sign-in can set it off alone: the lines' `storeId` tells.
  - `ad-figures-differ`: the cron's daily check of stored ad figures against the platform found one
    outside its tolerance (`"ad figures differ from the platform"`; [ads-setup.md](ads-setup.md),
    "Checked against the platform"). It clears the hour after and fires again with the next day's
    check while the difference stays.
  - Cost: US$0.10 a month each (the cost table); the three metrics they count are within CloudWatch's
    ten free custom metrics.

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
  files in the bucket. The bucket policy lets CloudTrail in only for this trail (`aws:SourceArn`
  = the trail's Sydney ARN, which every Region sends), so no other account's trail can write there;
  a second trail into this bucket needs its ARN added in audit-stack.ts.
- **IAM Access Analyzer - external access** (17 of 18 Regions red): only Sydney had an analyzer,
  made by hand on 2026-10-15. The StackSet `insights-account-access-analyzer` makes the account
  analyzer `insights-account` (free) in each of the 18 enabled Regions (`ACCOUNT_REGIONS` in
  audit-stack.ts; a Region enabled later needs adding there). One account analyzer is allowed per
  Region, so the hand-made Sydney one was deleted just before the first deploy of this stack and
  the StackSet made it again. Its roles: `insights-account-stackset-admin` (only this account's
  StackSets may assume it) and `insights-account-stackset-exec` (stacks and analyzers only).
  Findings: IAM console → Access analyzer, per Region.
- **MFA on Root Account**: the owner's step (Owner-only steps above), done 2026-10-22.

Trusted Advisor re-reads these on its own schedule (about daily); "Refresh" on a check, or
`aws support refresh-trusted-advisor-check --check-id <id> --region us-east-1`, asks sooner.

### The checks left on 2026-10-21

One red and six yellow that day (the dashboard said "1 action, 5 investigation"; the sixth appeared
the same morning), and what answers each:

- **MFA on Root Account** (red): the owner's step; nothing in this repository can do it. The owner
  added a passkey/security key on 2026-10-22 13:49Z and the check read green at 13:50Z, which left
  every Trusted Advisor check green (the excluded rows aside).
- **AWS Lambda Functions Using Deprecated Runtimes** (yellow, the four functions): they ran Node
  22, which Lambda retires on 2027-04-30, and the check lists a runtime from 180 days out. They run
  Node 24 since 2026-10-21 (`NODEJS_24_X` in app-stack.ts and auth-stack.ts, `target: "node24"` in
  apps/aws/scripts/build.mjs; a CDK test keeps every function, CDK's helpers included, on it).
  Refresh with check `L4dfs2Q4C5`.
- **Amazon S3 Server Access Logs Enabled** (yellow, all six buckets): every bucket now logs its
  requests (Fault tolerance, "Access logs"). The two log buckets can't log themselves, so their
  rows are excluded and the check is green with them so. Refresh with check `c1fd6b96l4`.
- **CloudFront Alternate Domain Names** (yellow, `bizinsights.io` and `www`): the check resolves
  each alternate name and expects the distribution; both resolve to Cloudflare's proxy (Domain:
  bizinsights.io), which forwards to it, and the check's own text says names whose DNS is outside
  the account can be listed that way. Working as designed, so both rows are excluded (2026-10-21).
- **IAM SAML 2.0 Identity Provider** (yellow): the account has no SAML provider and no IAM Identity
  Center; the one person signs in as root, and deploys use GitHub's OIDC role. Its row is excluded
  (2026-10-21) as a choice, not a fix: if the owner wants sign-in through Google Workspace or another
  identity provider, that is IAM Identity Center, and the row should be included again.
- **Low Utilization Amazon EC2 Instances** (yellow, the two NAT instances): t4g.nano is the
  smallest type there is, under 1% CPU and a few MB a day is what a small app's NAT looks like, and
  one per AZ is what Fault tolerance (above) needs. Both rows excluded (2026-10-21). A deploy that
  replaces the instances (a new Amazon Linux image) gives them new ids, so the rows return about
  four days later and need excluding again. The admin host is not listed only while it is stopped:
  it was started on 2026-10-18 for database work and left running, and stopped by hand on
  2026-10-21 (`aws ec2 stop-instances --region ap-southeast-2 --instance-ids <id>`). Its user data
  stops it on a fresh image's first boot only, so after any start, stop it.
- **Single AZ Application Check** (yellow, the VPC): current, not stale: AWS re-reads it daily
  about 12:52Z and the row's Last Updated Time moves. The facts say otherwise, checked again on
  2026-10-22: six subnets over 2a and 2b, the functions' network interfaces in both app subnets,
  the database Multi-AZ (primary 2b, standby 2a), only gateway endpoints (no AZ), no NAT gateway,
  and egress through both NAT instances every day since 2026-10-17 (NetworkOut 2026-10-18..21:
  nat-a 34, 47, 47 and 18 MB a day, nat-b 41, 63, 42 and 22). What AWS infers from "egress network
  patterns", and over what window, is not documented, and the check can't be refreshed; the one-AZ
  NAT gateway went on 2026-10-17 06:22Z, five days before. On the owner's "fix it" the VPC's row was
  excluded on 2026-10-22 (fault tolerance all green). An excluded row keeps being evaluated and
  shows its live status (`list-recommendation-resources ... --exclusion-status excluded`): once it
  reads ok, include it again, so a real single-AZ regression counts once more. If it is still yellow
  in November, ask AWS Support what the check sees (Business Support until 2026-11-14).

Exclusions are per row, in the Trusted Advisor API (a console "Exclude" does the same). To list
them, and to undo one:

```
aws trustedadvisor list-recommendation-resources --region us-east-1 --exclusion-status excluded --recommendation-identifier arn:aws:trustedadvisor::605411278365:recommendation/<id>
aws trustedadvisor batch-update-recommendation-resource-exclusion --region us-east-1 --recommendation-resource-exclusions arn=<row arn>,isExcluded=false
```

Recommendation ids: CloudFront Alternate Domain Names `d5fec7b3-ce62-4f9a-8b52-8ddaf15ebe61`, IAM
SAML 2.0 Identity Provider `dcc32e48-00e8-11ef-9055-da5f9b677d4d`, Low Utilization Amazon EC2
Instances `b8fd5938-4576-428f-8f65-cccf23441f4b`, Amazon S3 Server Access Logs Enabled
`df160a32-d80d-487f-9a69-f4403afe83b4`, NAT Gateway AZ Independence
`34a38636-05cc-41bc-b246-71e606cdb3ff` (one stale row excluded on 2026-10-18).

## Capacity: what binds first (checked 2026-10-20)

The design (Cognito, Lambda, Postgres, DynamoDB, CloudFront) holds a million accounts; the
configuration is sized for a small merchant base and the US$80 budget. In the order they bind:

| Limit | Today | Lifts with |
| --- | --- | --- |
| Google sign-ups a day | 10,000 new token grants a day per Google project (the Overview page of `bizinsights-sign-in` shows the figure) | "Raise daily token limit" on that page: a Google form. (Owner, or Claude in the owner's Chrome on their word) |
| Email sign-ups a day | About 100 a day: Resend's free tier for the emailed codes, shared with the app's own email; SES is still in the sandbox (production access denied 2026-10-16) | A paid Resend plan (owner's billing), or SES production access |
| Simultaneous requests | The account's Lambda "Concurrent executions" quota in ap-southeast-2 is already 1,000 (Service Quotas, checked 2026-10-20; the new-account value of 10 that older notes mention is gone). The functions reserve none of it, and each concurrent API invocation holds a database connection, so the database binds first (next row). The jobs queues still take 2 invocations each (`sources` in `app-stack.ts`, sized when the quota was 10) | Reserved concurrency per function (`app-stack.ts`) once the database class is chosen, so the API never opens more connections than the instance allows; the queues' concurrency can rise with it |
| Database | db.t4g.micro (1 GB memory, about 80 connections), storage 20 GB growing to 100 | t4g.small or medium when the `db-*` alarms say so (one failover, about a minute); RDS Proxy later (aws-architecture.md: the pinning check first) |
| Cognito cost | Essentials plan: the first 10,000 monthly active users free, then about US$0.015 each a month | Nothing to configure. A million active users is about US$15,000 a month for sign-in alone, so `monthlyBudgetUsd` (config.ts) moves first |
| Per-address limits | WAF and the app: 1,500 API requests a minute per address; sign-ups 60 an hour per address; Google sign-ins 100 per five minutes per address (`apps/api/src/rateLimit.ts`) | Raised 2026-10-20 for shared addresses (offices, mobile carriers). Accounts are protected by the per-address-of-email, per-account and Cognito limits, which did not move |

What does not bind: Google's 100-user cap (the sign-in project is in production, brand-verified, and
asks only for name and email), DynamoDB (on-demand), CloudFront and S3.

## CI bootstrap troubleshooting

The CI and deployment workflows set `core.longpaths=true` through Git's environment configuration
on the checkout step itself. This lets its initial clean/reset remove the long paths in a previous
pnpm dependency tree on Windows, without changing the runner account's global Git configuration.

Node 24 is set up before `infra/runner/setup-pnpm.mjs` installs the exact `packageManager` version
from package.json. The CLI is cached under `RUNNER_TOOL_CACHE/project-pnpm/<version>` outside the
checkout; warm jobs verify and reuse it. Cold jobs use npm's normal package integrity checks with
bounded download retries, without a second pnpm version-switch bootstrap. Hosted jobs still restore
the pnpm store through the following setup-node step.

For `Couldn't list the changed files`, the browser-test scope lookup tries three times, then runs
the tests if the API is still unavailable. It never treats a failed lookup as permission to skip tests.
Bootstrap regression checks run with `node --test infra/runner/setup-pnpm.test.mjs` and require no
project dependency installation.
