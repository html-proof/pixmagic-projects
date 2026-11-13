# AWS → iKorex migration matrix

How each AWS piece moves, what data goes with it, how the move is checked, and in which stage.
Where things are today: [AWS_INVENTORY.md](AWS_INVENTORY.md). What they become:
[IKOREX_INFRASTRUCTURE_ARCHITECTURE.md](IKOREX_INFRASTRUCTURE_ARCHITECTURE.md).

## Stages

| Stage | What | Touches production? | Approval |
| --- | --- | --- | --- |
| A | Code: the self-hosted entry point and adapters (queue, schedules, coordinator, blobs, metrics), Dockerfile, Compose file, backup/restore/deploy scripts. Merged to `main`; AWS keeps running the same code. **Built and tested 2026-11-06, live on AWS 2026-11-07 (#348, release 167)**; the SMS events bridge followed on 2026-11-07 and went with Customer Messaging (SMS) on 2026-11-13 ([MIGRATION_TEST_REPORT.md](MIGRATION_TEST_REPORT.md)) | No | — |
| B | Server: `~/bizinsights-staging` on iKorex, a copy of production data, schedules off, no webhooks, mail to a sink, behind Cloudflare Access | No (reads a dump) | Server administrator's OK |
| C | Backups to R2, restore test, monitoring and alerts, external uptime check | No | — |
| D | Cutover in a maintenance window (below): a Sunday, 20:00-21:00 Melbourne time | **Yes** | **Owner, for the date** |
| E | Rollback period, 14 days: AWS kept with schedules off | No | — |
| F | AWS decommissioned, one resource at a time, then the account closed (decision 4b) | **Yes** | **Owner, separately** |

Alongside, on AWS before the cutover (live through Deploy to AWS like any change): the app's own
sign-in, moving users over (`AUTH_MODE=migrating`), so the server doesn't start with Cognito's
sign-in to carry. (Customer Messaging (SMS) was removed on 2026-11-13: there are no texts to move.)

## Service by service

| AWS today | On iKorex | Code change (stage A) | Data moved at cutover | Check | Main risk |
| --- | --- | --- | --- | --- | --- |
| Lambda `api` | `web` container | **Done**: `selfhost.ts` (`webHandler`, `startWeb`), `server.ts`; client IP from `CF-Connecting-IP`, no origin secret, 6 MB body limit | — | Smoke test of the bundle (UI, `/api/readyz`, `/api/version`, 401 without a session), e2e suite against staging | A long request now holds the process: the server's own 60 s limit |
| SQS + Lambda `jobs` | `worker` + PostgreSQL queue | **Done**: `pgQueues.ts` (implements `Queues`; SQS's contract: delays, receive counts, holds, dead-letter after 10), runner in `selfhost.ts`, `admin queues/dlq/redrive` | Queues drained to empty before the window; nothing carried over | Integration tests against PostgreSQL (retry, backoff, dead-letter, worker dying mid-job, two claimers, time limit) | A handler that assumed SQS batch semantics: none do (they get one message at a time on both) |
| EventBridge Scheduler + `cron` | Schedules in `worker` (`schedule_ticks`); admin command | **Done**: `schedules.ts` (cron with time zones, one run per tick across workers, catch-up, retries), `admin.ts` | — | Ticks recorded; two workers run a tick once; failed tick retried | A missed tick during the window: the 15-minute jobs catch up by design |
| SNS alarms | Alertmanager | Rules + email config | — | One test alert | — |
| SNS sms-events → SQS | Nothing: Customer Messaging (SMS) was removed from the app on 2026-11-13 | Twilio's webhooks (#354) and the bridge that read AWS's queue (`sqsBridge.ts`) were built and went with it; the topic, the queue and its trigger are gone from the App stack | — | — | — |
| DynamoDB `coord` | PostgreSQL table `coord_entries` | **Done**: `pgCoord.ts` (implements `Coord`), `admin import-coord` | The 12 items (signed-out sessions among them) copied with `admin import-coord` | `Coord` contract tests against PostgreSQL | — |
| S3 `payloads` | Volume + nightly prune | **Done**: `fsBlobs.ts` (implements `BlobStore`) | — (transient, drained) | Unit tests incl. keys that would leave the folder | Disk fills: alert at 80 % |
| S3 `site` | Served by `app` | Production static handler (`staticSite.ts` exists) with cache headers | — | Pages, hashed files cached by Cloudflare | — |
| S3 `artifacts` | R2 bucket, encrypted | Backup scripts | Existing RDS snapshots stay in AWS until stage F | Restore test | — |
| RDS PostgreSQL | `postgres` container | Connection strings only. **Copy built** (`copy-db.mjs` + `copy-db.sh`, tested against PostgreSQL; [DATABASE_MIGRATION_REPORT.md](DATABASE_MIGRATION_REPORT.md)) | One snapshot per database dumped on the admin host, restored on iKorex inside the window (~1.8 GB of data: minutes) | Every table's row count equal to the snapshot's, row-level security and policies equal, then `migrate` and the counts again; smoke tests | **Single server, no failover** (the owner's decision); a restore is the recovery |
| Cognito | **The app's own sign-in** (decision 2 revised): `AUTH_MODE=migrating` on AWS first, `local` at stage F | **Done**: `localAuth.ts`, `migratingAuth.ts`, `authStore.ts` (#353); Cognito's password check and admin delete with an IAM user key until stage F | The accounts that moved over are rows of `auth_accounts`, copied with the database | Password, email code, Google, reset, sign-out, two-step verification | Users who never sign in before stage F: a reset email each (ROLLBACK_PLAN.md, "Before stage F starts") |
| Cognito email Lambda + KMS | The app's own code emails (Resend) | Done with the sign-in above | — | Sign-up and reset codes arrive | — |
| SES | Nothing (Resend sends) | — | — | — | — |
| End User Messaging SMS | Nothing: Customer Messaging (SMS) was removed from the app on 2026-11-13 | The Twilio provider (#354) was built, never switched on, and went with it. The configuration set and the `sms-voice:*` permissions are gone from the App stack | Nothing: no real text was sent on AWS (sandbox) | — | — |
| Secrets Manager + SSM | `.env` on the server + encrypted copy | `loadSecrets` skipped when the values are present | Exported by a script that prints names only | `config` action shows every provider configured | A secret in a log: the script never prints values |
| CloudFront + WAF | Cloudflare proxy + Tunnel + Cloudflare rules | — | — | Client IP, geo, rate limit, outage behaviour | Cloudflare Free has less WAF than AWS's managed groups (see the cost audit, change 6) |
| EC2 NAT + admin host | — | — | — | Outbound calls work from the server | — |
| Fargate Evolution + Cloud Map + Route 53 | `evolution` container | `EVOLUTION_API_URL` = `http://evolution:8080`; webhook URL to `app` on the internal network | Its `evolution` database (sessions) with the app's | Linked numbers still connected after the window | Sessions tied to the old webhook URL: Evolution's instances re-pointed at start. Two services on one WhatsApp session push each other off it, and AWS's would keep writing its database after the copy's snapshot: AWS's has no task from cutover step 2 (`AWS_WHATSAPP=off`, so no Deploy to AWS starts it again) until stage F, unless the copy back hands the sessions back |
| CloudWatch | Prometheus, Alertmanager, Grafana + external uptime check (Loki: off, decision 7) | **Done**: `/metrics` on `web` and `worker` (`metrics.ts`), `infra/ikorex/docker-compose.monitoring.yml`, 15 alert rules, a dashboard | — | Each alert fired once (stage C) | Monitoring on the same server: covered by the external check |
| GuardDuty, CloudTrail, Cost Explorer, Budgets | Deleted at stage F; the server never sends the cost email | **Done**: the server's cost-email schedule removed | — | — | — |
| CDK + Deploy to AWS | `ship.sh` + `deploy.sh` over SSH; the workflow Deploy to iKorex | **Done**: the scripts, and `.github/workflows/ikorex-deploy.yml` (built 2026-11-07, off until stage B's setup: `IKOREX_STAGING`, then `IKOREX_PRODUCTION` at the cutover) | — | A deploy with a failing migration or health check rolls back (stage B) | The deploy key: its own, in GitHub's secret only, limited on the server to `ssh-gate.sh` (receive, deploy) |

## Cognito: the three ways

Cognito does not export password hashes. That is AWS's rule, not something the migration can work
around. **Chosen: option 2** (owner, 2026-11-07, "own sign-in, gradual move"), built in #353.

| Option | Users notice | Work | Cost |
| --- | --- | --- | --- |
| 1. Keep Cognito (first recommendation) | Nothing | Small: an IAM user for the admin calls | ~US$1.15/month (the email key) |
| **2. Lazy migration to the app's own sign-in** (chosen) | Nothing for those who sign in within the window; a reset email for the rest | Large: password hashing (argon2id), Google sign-in on the app's own OAuth client, password reset, sessions; Cognito switched off after N weeks | 0 after |
| 3. Keycloak on the server | Every user resets their password | Large, plus ~1 GB of memory for Keycloak and another service to patch | 0, but server memory |

Users who only ever sign in with Google have no Cognito password, so the resets in options 2 and 3
only reach users with one.

## Cutover (stage D), in the window

1. Announce the window. Stage B's staging has passed every check.
2. On AWS: schedules off; webhooks answered `503` (Shopify retries them for hours); the
   queues drained to empty; final `counts`. AWS's WhatsApp service stopped: GitHub variables
   `AWS_SCHEDULES=off` and `AWS_WHATSAPP=off` (every Deploy to AWS in the rollback period keeps
   both off), and at once `aws ecs update-service --cluster insights-production-whatsapp --service
   insights-production-evolution-a --desired-count 0`, waited on until no task runs.
3. `node infra/ikorex/scripts/copy-db.mjs --cutover --replace`: both databases from one snapshot
   each, restored on iKorex, compared table by table, `admin migrate`, compared again. It refuses
   while an AWS queue holds work or AWS's WhatsApp service has a task.
4. Copy the coordinator's items; start `app`, `worker`, `evolution` with production settings.
5. Cloudflare: `bizinsights.io` and `www` move from CloudFront to the tunnel (proxied, takes effect
   in seconds).
6. Smoke tests; sign in; a test webhook; WhatsApp numbers connected; schedules on
   (`SCHEDULES=on`).
7. Webhooks queued at Shopify arrive at iKorex.

The window is the only write freeze. The rollback for each step is in [ROLLBACK_PLAN.md](ROLLBACK_PLAN.md).

## Acceptance (the brief's 22 criteria)

Each criterion gets its evidence in `MIGRATION_TEST_REPORT.md` (written at stages B-D, not before):
the test run, the command output or the screenshot. None is claimed until it has that.
