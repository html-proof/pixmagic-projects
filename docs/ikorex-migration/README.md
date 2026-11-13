# Moving bizinsights from AWS to the iKorex server

The owner's brief of 2026-11-06: run bizinsights on the existing iKorex server (103.146.112.176)
instead of AWS, keeping every feature, record and integration, without disturbing the websites, n8n
and the CCTV tunnel already on that server.

## Where it stands (2026-11-13, 09:30 UTC)

**The move is done.** `bizinsights.io` has been served by the server since 2026-11-13 06:03 UTC,
and the same day the owner had AWS's side deleted, so there is no way back to AWS
([LEAVING_AWS.md](LEAVING_AWS.md)). What runs, and how each part was checked:

| Part | State | Checked |
| --- | --- | --- |
| The app | Six containers in `~/bizinsights` (web, worker, postgres, backup, evolution, cloudflared), about 450 MB in use, the server's other 12 containers untouched | Health 200, 0 restarts, no error lines, at each step of the day |
| The data | Copied from RDS at the switch and compared equal, table by table ([DATABASE_MIGRATION_REPORT.md](DATABASE_MIGRATION_REPORT.md)). RDS and its snapshots no longer exist, so it can't be compared again | At the cutover only |
| Deploys | A merge to `main` deploys itself when CI passes (Deploy to iKorex, a deploy-only key, a lock, never an older commit over a newer one) | Three merges deployed themselves; `/api/version` named each |
| Sign-in | The app's own (`AUTH_MODE=local`); nothing of Cognito or AWS in the server's settings | Settings read on the server. **Not checked: a person signing in with Google** |
| Shopify | Webhooks arrive (23 recorded in the first hour after the switch), scheduled runs refresh tokens | Deliveries counted in the database; an unsigned request refused with 401. **Not checked: a new install** |
| Jobs and schedules | In PostgreSQL, `SCHEDULES=on` | Worker healthy, the 07:45 UTC run clean |
| Backups | **On the server's own disk and nowhere else** (the owner's choice: lost with the server). Nightly, the log continuously, 14 days | `pgbackrest check`, 0 archiver failures, a restore test passed ([the guide](PRODUCTION_DEPLOYMENT_GUIDE.md#backups)) |
| Watching | The Cloudflare Worker `bizinsights-uptime`, every 10 minutes, emailing the owner; the Uptime check workflow on GitHub as a second check. No metrics or log stack: the server is too small for one | GitHub never started the workflow's schedule on 2026-11-13, hence the Worker (PRODUCTION_DEPLOYMENT_GUIDE.md, "The uptime check") |
| WhatsApp | The service runs. **No number is linked**: someone has to pair again in the app | Container healthy |
| HTTPS, the edge | Cloudflare and its tunnel; no port of bizinsights is open on the server | HSTS present, `www` redirects |
| AWS | Emptied on 2026-11-13 ([LEAVING_AWS.md](LEAVING_AWS.md), [AWS_ACCOUNT_AUDIT.md](AWS_ACCOUNT_AUDIT.md)) | Read-only reads of the account through the day |

**What was never tried:** a restart of the server itself. Docker starts at boot and every
container restarts by itself, but the machine has been up since before the move, and a reboot for
its pending updates is the administrator's.

**What is left, none of it a session's to do:**

1. The owner: sign in once with Google on `bizinsights.io`; pair the WhatsApp number again.
2. The owner: close the AWS account in its console, and before that look at the support plan,
   which [AWS_ACCOUNT_AUDIT.md](AWS_ACCOUNT_AUDIT.md) found to be most of what the account still
   costs.
3. The server's administrator: the reboot; the memory asked for on 2026-11-08 (bizinsights runs
   inside low limits instead); and to be told that `deployer` now has a second, deploy-only key
   ([the guide](PRODUCTION_DEPLOYMENT_GUIDE.md#deploy-to-ikorex-github-actions)).
4. Decisions the owner made that a later reader should not undo without them: one server and no
   failover; backups only on that server; no monitoring stack.

## How it got here

What follows is the record of the days before, as it was written then.

**Status (2026-11-08):** discovery done on the AWS side (#347). **Stage A done and live on AWS**
(#348, release 167): the self-hosted runtime and the server's files, built and tested on this PC
([MIGRATION_TEST_REPORT.md](MIGRATION_TEST_REPORT.md)). **The owner's decisions are made**
([the list](IKOREX_INFRASTRUCTURE_ARCHITECTURE.md#decisions-2026-11-07)), and revised the same evening:
**leave AWS completely and close the account** after the 14-day rollback period, so Cognito and AWS's
SMS are replaced too; backups to R2, one server accepted, the cutover on a Sunday 20:00-21:00
Melbourne time, no logs profile. Since then, each live on AWS through Deploy to AWS:

**Update, 2026-11-13.** Customer Messaging (SMS) and the email module were removed from the app at
the owner's request. Nothing of the move concerns SMS any more: no Twilio account, no `SMS_PROVIDER`
switch, no SMS events queue and no bridge to read it. Where these pages still name them, they
record what was true on their date.

- **The database copy and the security audit** (#350, #352, release 169).
- **The deploy workflow**, built and off (Deploy to iKorex, #351, release 171): it deploys `main` to
  staging, and from the cutover to production, once the deploy key is agreed with the administrator.
- **The app's own sign-in** (#353, release 171), replacing Cognito. Switched to `migrating` in
  production after it: each user moves over at their next password sign-in. Google moves once the
  owner adds the app's redirect address to the Google client.
- **Texts through Twilio** (#354, release 172), replacing AWS End User Messaging: built, never
  switched on, and removed with Customer Messaging (SMS) on 2026-11-13.
- **The copy back for a rollback** (2026-11-08): `copy-db-back.mjs` copies the server's databases
  back into RDS and proves them whole ([ROLLBACK_PLAN.md](ROLLBACK_PLAN.md#the-copy-back-de-after-writes-on-ikorex)),
  tested against PostgreSQL; with it, `AWS_WHATSAPP=off`, which keeps AWS's WhatsApp service from
  starting again against the server's through the rollback period.

**The server (2026-11-13): inspected three times, read-only, and no go on memory each time.** It has
3.9 GB in all with about 2.5 GB free beside what already runs there, and bizinsights needs 3.2 to
4.6 GB ([SERVER_CAPACITY_REPORT.md](SERVER_CAPACITY_REPORT.md)). The administrator has been asked
for at least 8 GB and 4 cores. **The owner decided on 2026-11-13 to run it there as it is, and
production moved the same day:** since 06:03 UTC `bizinsights.io` is served by the server
(`~/bizinsights`, the low-memory limits of `infra/ikorex/docker-compose.lean.yml`, about 600 MB
used; the server's other containers untouched), through the Cloudflare tunnel `bizinsights`
([MIGRATION_TEST_REPORT.md](MIGRATION_TEST_REPORT.md#2026-11-13-the-cutover-stage-d-from-the-owners-pc)).
For the first hour AWS was kept frozen as the way back and the backups went to an S3 bucket; both
ended the same day (above).

## The pages

| Brief's deliverable | Page | State |
| --- | --- | --- |
| 1. AWS inventory | [AWS_INVENTORY.md](AWS_INVENTORY.md) | Done (from the read-only sweep of 2026-11-06) |
| 2. Migration matrix | [AWS_TO_IKOREX_MIGRATION_MATRIX.md](AWS_TO_IKOREX_MIGRATION_MATRIX.md) | Done: stages A-F, service by service, cutover steps |
| 3. Infrastructure architecture | [IKOREX_INFRASTRUCTURE_ARCHITECTURE.md](IKOREX_INFRASTRUCTURE_ARCHITECTURE.md) | Running in production since 2026-11-13, with the low-memory limits and without the monitoring stack |
| 4. Server capacity | [SERVER_CAPACITY_REPORT.md](SERVER_CAPACITY_REPORT.md) | Inspected three times, never enlarged; the owner chose to run within about 2.5 GB. Script: [inspect-server.sh](inspect-server.sh) |
| 5. Database migration report | [DATABASE_MIGRATION_REPORT.md](DATABASE_MIGRATION_REPORT.md) | Rehearsed and then done on 2026-11-13 (`copy-db.mjs`, `copy-db.sh`), compared equal; its source no longer exists |
| 6. Security audit | [SECURITY_AUDIT.md](SECURITY_AUDIT.md) | The files audited, six findings fixed with tests; eight questions only the server or its administrator can answer |
| 7. Migration test report | [MIGRATION_TEST_REPORT.md](MIGRATION_TEST_REPORT.md) | Stage A's runs; the 22 acceptance criteria and where each stands |
| 8. Cost comparison | [AWS_COST_COMPARISON.md](AWS_COST_COMPARISON.md) | Estimate; the real figure comes from the bill after cutover |
| 9. Rollback plan | [ROLLBACK_PLAN.md](ROLLBACK_PLAN.md) | Written, and overtaken: AWS's side was deleted on 2026-11-13, so going back to it is no longer possible. Rolling back a release on the server is in the guide |
| 10. Production deployment guide | [PRODUCTION_DEPLOYMENT_GUIDE.md](PRODUCTION_DEPLOYMENT_GUIDE.md) | The server's runbook, in use: setup, the automatic deploy, backups, everyday commands, rolling back a release, restore |
| 2026-11-13 brief: the AWS account audited | [AWS_ACCOUNT_AUDIT.md](AWS_ACCOUNT_AUDIT.md) | What is in the account after the deletion, what it still costs, and what stands before a closed account |
| 2026-11-08 brief: what still uses AWS | [AWS_DEPENDENCY_SCAN.md](AWS_DEPENDENCY_SCAN.md) | 79 files (2026-11-13), each with the step that removes it; `scripts/aws-dependency-scan.mjs` keeps new AWS code out (`pnpm lint`) and is stage F's check |
| 2026-11-08 brief: its suggested providers | [PROVIDER_CHOICES.md](PROVIDER_CHOICES.md) | Hetzner, Supabase, Upstash, BullMQ, Better Auth… against what the move uses, and when each would become right; costs at 1,000 to 1,000,000 users in [AWS_COST_COMPARISON.md](AWS_COST_COMPARISON.md#at-scale-1000-to-1000000-users) |
| 2026-11-13: finish the move and delete AWS | [LEAVING_AWS.md](LEAVING_AWS.md) | What replaced each AWS service; **the AWS account emptied on 2026-11-13** (no way back to AWS since): what was deleted and when, how sign-in and the backups left it, and **the account closed the same day** (what is left: its last bill) |

The earlier cost audit of the same day, which this builds on, is in
[../aws-migration/](../aws-migration/AWS_MIGRATION_PLAN.md). Its conclusion still holds for staying
on AWS: rebuilding SQS/SNS/EventBridge inside AWS saves nothing. Leaving AWS is different: then the
database, the WhatsApp service, the WAF and the NAT instances go too, and those are the bill.

## In one paragraph

As it was designed. What runs differs in two places the owner chose on 2026-11-13: the backups
stay on the server's own disk, and there is no Prometheus, Grafana or Loki (the Uptime check
workflow is what watches).

The code was already built for this: no AWS SDK, and every AWS service behind an interface
(`Queues`, `Coord`, `BlobStore`, `Mailer`); stage A added the self-hosted
implementations (`apps/aws/src/selfhost.ts` and its parts, `infra/ikorex/`). On iKorex, bizinsights is one Docker
Compose project with no open port: Cloudflare (already in front) reaches it through a Cloudflare
Tunnel; PostgreSQL 17 replaces RDS with continuous encrypted backups off the server, and also holds
the job queue, the schedules and the coordinator (SQS, EventBridge and DynamoDB); Prometheus, Grafana, Loki
and an external uptime check replace CloudWatch. Resend keeps sending email; the app's own sign-in
replaces Cognito (each user's password is checked by Cognito once, since Cognito can't export them).
The AWS bill falls from ~US$136 a month before GST to nothing once
the account closes, at the price of one server instead of a failover database, and of running it
ourselves.

## The 2026-11-11 brief

A fourth brief names an open-source component for each job (Traefik, Keycloak, Valkey, NATS,
RabbitMQ, Garage, Postal, OpenBao, Restic). [OPEN_SOURCE_STACK.md](OPEN_SOURCE_STACK.md) sets that
list beside what is built, with where each of its sections, tests and thirteen files stands;
[ENVIRONMENT_VARIABLES_MIGRATION.md](ENVIRONMENT_VARIABLES_MIGRATION.md) is the one page it asks for
that didn't exist.

## Waiting on

Nothing that a coding session can do: see "What is left" at the top of this page.
