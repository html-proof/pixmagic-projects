# AWS → iKorex migration matrix

How each AWS piece moves, what data goes with it, how the move is checked, and in which stage.
Where things are today: [AWS_INVENTORY.md](AWS_INVENTORY.md). What they become:
[IKOREX_INFRASTRUCTURE_ARCHITECTURE.md](IKOREX_INFRASTRUCTURE_ARCHITECTURE.md).

## Stages

| Stage | What | Touches production? | Approval |
| --- | --- | --- | --- |
| A | Code: the self-hosted entry point and adapters (queue, schedules, coordinator, blobs, metrics), Dockerfile, Compose file, backup/restore/deploy scripts. Merged to `main`; AWS keeps running the same code. **Built and tested 2026-11-06, live on AWS 2026-11-07 (#348, release 167)**; the SMS events bridge followed on 2026-11-07 ([MIGRATION_TEST_REPORT.md](MIGRATION_TEST_REPORT.md)) | No | — |
| B | Server: `~/bizinsights-staging` on iKorex, a copy of production data, schedules off, no webhooks, mail to a sink, behind Cloudflare Access | No (reads a dump) | Server administrator's OK |
| C | Backups to R2, restore test, monitoring and alerts, external uptime check | No | — |
| D | Cutover in a maintenance window (below): a Sunday, 20:00-21:00 Melbourne time | **Yes** | **Owner, for the date** |
| E | Rollback period, 14 days: AWS kept with schedules off | No | — |
| F | AWS decommissioned, one resource at a time | **Yes** | **Owner, separately** |

## Service by service

| AWS today | On iKorex | Code change (stage A) | Data moved at cutover | Check | Main risk |
| --- | --- | --- | --- | --- | --- |
| Lambda `api` | `web` container | **Done**: `selfhost.ts` (`webHandler`, `startWeb`), `server.ts`; client IP from `CF-Connecting-IP`, no origin secret, 6 MB body limit | — | Smoke test of the bundle (UI, `/api/readyz`, `/api/version`, 401 without a session), e2e suite against staging | A long request now holds the process: the server's own 60 s limit |
| SQS + Lambda `jobs` | `worker` + PostgreSQL queue | **Done**: `pgQueues.ts` (implements `Queues`; SQS's contract: delays, receive counts, holds, dead-letter after 10), runner in `selfhost.ts`, `admin queues/dlq/redrive` | Queues drained to empty before the window; nothing carried over | Integration tests against PostgreSQL (retry, backoff, dead-letter, worker dying mid-job, two claimers, time limit) | A handler that assumed SQS batch semantics: none do (they get one message at a time on both) |
| EventBridge Scheduler + `cron` | Schedules in `worker` (`schedule_ticks`); admin command | **Done**: `schedules.ts` (cron with time zones, one run per tick across workers, catch-up, retries), `admin.ts` | — | Ticks recorded; two workers run a tick once; failed tick retried | A missed tick during the window: the 15-minute jobs catch up by design |
| SNS alarms | Alertmanager | Rules + email config | — | One test alert | — |
| SNS sms-events → SQS | **Stays on AWS** (SMS kept, 2026-11-07); the server's worker long-polls the `smsEvents` SQS queue into its own | **Done**: `sqsBridge.ts` (`SMS_EVENTS_QUEUE_URL`, only with `SCHEDULES=on`); deleted from SQS only once in PostgreSQL | — (events wait in SQS up to 4 days) | Sandbox SMS shows "delivered" on staging-turned-live | Two readers at once (the `jobs` function and the server): the function's `smsEvents` trigger is turned off in the window, before `SCHEDULES=on` |
| DynamoDB `coord` | PostgreSQL table `coord_entries` | **Done**: `pgCoord.ts` (implements `Coord`), `admin import-coord` | The 12 items (signed-out sessions among them) copied with `admin import-coord` | `Coord` contract tests against PostgreSQL | — |
| S3 `payloads` | Volume + nightly prune | **Done**: `fsBlobs.ts` (implements `BlobStore`) | — (transient, drained) | Unit tests incl. keys that would leave the folder | Disk fills: alert at 80 % |
| S3 `site` | Served by `app` | Production static handler (`staticSite.ts` exists) with cache headers | — | Pages, hashed files cached by Cloudflare | — |
| S3 `artifacts` | R2 bucket, encrypted | Backup scripts | Existing RDS snapshots stay in AWS until stage F | Restore test | — |
| RDS PostgreSQL | `postgres` container | Connection strings only. **Copy built** (`copy-db.mjs` + `copy-db.sh`, tested against PostgreSQL; [DATABASE_MIGRATION_REPORT.md](DATABASE_MIGRATION_REPORT.md)) | One snapshot per database dumped on the admin host, restored on iKorex inside the window (~1.8 GB of data: minutes) | Every table's row count equal to the snapshot's, row-level security and policies equal, then `migrate` and the counts again; smoke tests | **Single server, no failover** (the owner's decision); a restore is the recovery |
| Cognito | **Keep** (recommended) | Admin calls with an IAM user key (today: the function's role) | — | Password, email code, Google, reset, sign-out | Long-lived IAM key: limited to this pool, rotated |
| Cognito email Lambda + KMS | Keep with Cognito | — | — | Reset code arrives | — |
| SES | Nothing (Resend sends) | — | — | — | — |
| End User Messaging SMS | **Keep** (decided 2026-11-07) | IAM user key: `sms-voice:SendTextMessage`, and `sqs:ReceiveMessage`/`sqs:DeleteMessage` on the `smsEvents` queue | — | Sandbox send | — |
| Secrets Manager + SSM | `.env` on the server + encrypted copy | `loadSecrets` skipped when the values are present | Exported by a script that prints names only | `config` action shows every provider configured | A secret in a log: the script never prints values |
| CloudFront + WAF | Cloudflare proxy + Tunnel + Cloudflare rules | — | — | Client IP, geo, rate limit, outage behaviour | Cloudflare Free has less WAF than AWS's managed groups (see the cost audit, change 6) |
| EC2 NAT + admin host | — | — | — | Outbound calls work from the server | — |
| Fargate Evolution + Cloud Map + Route 53 | `evolution` container | `EVOLUTION_API_URL` = `http://evolution:8080`; webhook URL to `app` on the internal network | Its `evolution` database (sessions) with the app's | Linked numbers still connected after the window | Sessions tied to the old webhook URL: Evolution's instances re-pointed at start |
| CloudWatch | Prometheus, Alertmanager, Grafana + external uptime check (Loki: off, decision 7) | **Done**: `/metrics` on `web` and `worker` (`metrics.ts`), `infra/ikorex/docker-compose.monitoring.yml`, 16 alert rules, a dashboard | — | Each alert fired once (stage C) | Monitoring on the same server: covered by the external check |
| GuardDuty, CloudTrail, Cost Explorer, Budgets | Stay while AWS has resources; GuardDuty off at stage F | — | — | — | — |
| CDK + Deploy to AWS | `ship.sh` + `deploy.sh` over SSH; the workflow Deploy to iKorex | **Done**: the scripts, and `.github/workflows/ikorex-deploy.yml` (built 2026-11-07, off until stage B's setup: `IKOREX_STAGING`, then `IKOREX_PRODUCTION` at the cutover) | — | A deploy with a failing migration or health check rolls back (stage B) | The deploy key: its own, in GitHub's secret only, limited on the server to `ssh-gate.sh` (receive, deploy) |

## Cognito: the three ways

Cognito does not export password hashes. That is AWS's rule, not something the migration can work
around.

| Option | Users notice | Work | Cost |
| --- | --- | --- | --- |
| **1. Keep Cognito** (recommended) | Nothing | Small: an IAM user for the admin calls | ~US$1.15/month (the email key) |
| 2. Lazy migration to the app's own sign-in | Nothing for those who sign in within the window; a reset email for the rest | Large: password hashing (argon2id), Google sign-in on the app's own OAuth client, password reset, sessions; Cognito switched off after N weeks | 0 after |
| 3. Keycloak on the server | Every user resets their password | Large, plus ~1 GB of memory for Keycloak and another service to patch | 0, but server memory |

Users who only ever sign in with Google have no Cognito password, so the resets in options 2 and 3
only reach users with one.

## Cutover (stage D), in the window

1. Announce the window. Stage B's staging has passed every check.
2. On AWS: schedules off; webhooks answered `503` (Shopify retries them for hours); the `jobs`
   function's `smsEvents` trigger off (SMS events then wait in SQS for the server); the other queues
   drained to empty; final `counts`.
3. `node infra/ikorex/scripts/copy-db.mjs --cutover --replace`: both databases from one snapshot
   each, restored on iKorex, compared table by table, `admin migrate`, compared again.
4. Copy the coordinator's items; start `app`, `worker`, `evolution` with production settings.
5. Cloudflare: `bizinsights.io` and `www` move from CloudFront to the tunnel (proxied, takes effect
   in seconds).
6. Smoke tests; sign in; a test webhook; WhatsApp numbers connected; `SMS_EVENTS_QUEUE_URL` set
   and schedules on (`SCHEDULES=on` also starts reading the SMS events waiting in SQS).
7. Webhooks queued at Shopify arrive at iKorex.

The window is the only write freeze. The rollback for each step is in [ROLLBACK_PLAN.md](ROLLBACK_PLAN.md).

## Acceptance (the brief's 22 criteria)

Each criterion gets its evidence in `MIGRATION_TEST_REPORT.md` (written at stages B-D, not before):
the test run, the command output or the screenshot. None is claimed until it has that.
