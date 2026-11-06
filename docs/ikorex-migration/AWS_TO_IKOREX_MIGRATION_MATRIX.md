# AWS → iKorex migration matrix

How each AWS piece moves, what data goes with it, how the move is checked, and in which stage.
Where things are today: [AWS_INVENTORY.md](AWS_INVENTORY.md). What they become:
[IKOREX_INFRASTRUCTURE_ARCHITECTURE.md](IKOREX_INFRASTRUCTURE_ARCHITECTURE.md).

## Stages

| Stage | What | Touches production? | Approval |
| --- | --- | --- | --- |
| A | Code: the self-hosted entry point and adapters (queue, schedules, coordinator, blobs, metrics), Dockerfile, Compose file, backup/restore/deploy scripts. Merged to `main`; AWS keeps running the same code | No | — |
| B | Server: `~/bizinsights-staging` on iKorex, a copy of production data, schedules off, no webhooks, mail to a sink, behind Cloudflare Access | No (reads a dump) | Server administrator's OK |
| C | Backups to R2, restore test, monitoring and alerts, external uptime check | No | — |
| D | Cutover in a maintenance window (below) | **Yes** | **Owner, for the date** |
| E | Rollback period, 14 days: AWS kept with schedules off | No | — |
| F | AWS decommissioned, one resource at a time | **Yes** | **Owner, separately** |

## Service by service

| AWS today | On iKorex | Code change (stage A) | Data moved at cutover | Check | Main risk |
| --- | --- | --- | --- | --- | --- |
| Lambda `api` | `app` container | New entry point beside `index.ts`/`local.ts`: Node HTTP server, client IP from `CF-Connecting-IP`, no origin secret | — | Smoke tests, e2e suite against staging | Behaviour that relied on Lambda (cold starts, 55 s timeout): a long request now holds the process, so the server sets its own timeout |
| SQS + Lambda `jobs` | `worker` + pg-boss | `pgBossQueues` (implements `Queues`), a consumer loop calling `consume()`, `dlq.mjs` inspect/redrive on the new dead-letter queue | Queues drained to empty before the window; nothing carried over | Integration tests: retry, backoff, dead-letter, worker killed mid-job, duplicate send | A handler that assumed SQS batch semantics; covered by running the worker suite against pg-boss |
| EventBridge Scheduler + `cron` | pg-boss schedules in `worker`; admin CLI | Schedule registration; `admin <action>` command | — | Ticks recorded; restart between ticks | A missed tick during the window: the 15-minute jobs catch up by design |
| SNS alarms | Alertmanager | Rules + email config | — | One test alert | — |
| SNS sms-events → SQS | SNS HTTPS subscription → app route → `smsEvents` queue (only if SMS stays on AWS) | Route with SNS signature check | — | Sandbox SMS shows "delivered" | Unsigned or replayed events: signature and timestamp checked |
| DynamoDB `coord` | `redis` | `redisCoord` (implements `Coord`) | The 12 items (signed-out sessions among them) copied by a script | `Coord` contract tests against Redis | — |
| S3 `payloads` | Volume + nightly prune | `fsBlobs` (implements `BlobStore`) | — (transient, drained) | Large webhook round trip | Disk fills: alert at 80 % |
| S3 `site` | Served by `app` | Production static handler (`staticSite.ts` exists) with cache headers | — | Pages, hashed files cached by Cloudflare | — |
| S3 `artifacts` | R2 bucket, encrypted | Backup scripts | Existing RDS snapshots stay in AWS until stage F | Restore test | — |
| RDS PostgreSQL | `postgres` container | Connection strings only | `pg_dump` of `app` and `evolution` from RDS, restore on iKorex, inside the window (~1.8 GB of data: minutes) | Row counts per table equal (`counts` action on both), `_prisma_migrations` equal, RLS policies present, smoke tests | **Single server, no failover** (the owner's decision); a restore is the recovery |
| Cognito | **Keep** (recommended) | Admin calls with an IAM user key (today: the function's role) | — | Password, email code, Google, reset, sign-out | Long-lived IAM key: limited to this pool, rotated |
| Cognito email Lambda + KMS | Keep with Cognito | — | — | Reset code arrives | — |
| SES | Nothing (Resend sends) | — | — | — | — |
| End User Messaging SMS | Keep (or another provider) | IAM user key | — | Sandbox send | — |
| Secrets Manager + SSM | `.env` on the server + encrypted copy | `loadSecrets` skipped when the values are present | Exported by a script that prints names only | `config` action shows every provider configured | A secret in a log: the script never prints values |
| CloudFront + WAF | Cloudflare proxy + Tunnel + Cloudflare rules | — | — | Client IP, geo, rate limit, outage behaviour | Cloudflare Free has less WAF than AWS's managed groups (see the cost audit, change 6) |
| EC2 NAT + admin host | — | — | — | Outbound calls work from the server | — |
| Fargate Evolution + Cloud Map + Route 53 | `evolution` container | `EVOLUTION_API_URL` = `http://evolution:8080`; webhook URL to `app` on the internal network | Its `evolution` database (sessions) with the app's | Linked numbers still connected after the window | Sessions tied to the old webhook URL: Evolution's instances re-pointed at start |
| CloudWatch | Prometheus, Alertmanager, Grafana, Loki + external uptime check | `/metrics` on `app` and `worker` | — | Each alert fired once | Monitoring on the same server: covered by the external check |
| GuardDuty, CloudTrail, Cost Explorer, Budgets | Stay while AWS has resources; GuardDuty off at stage F | — | — | — | — |
| CDK + Deploy to AWS | Compose + deploy over SSH | New workflow; CLAUDE.md rewritten at cutover | — | A deploy with a failing health check rolls back | The PC runner and its SSH key: restricted to the deploy command |

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
2. On AWS: schedules off; webhooks answered `503` (Shopify retries them for hours); queues drained
   to empty; final `counts`.
3. `pg_dump` both databases from RDS, restore on iKorex, `counts` compared table by table.
4. Copy the coordinator's items; start `app`, `worker`, `evolution` with production settings.
5. Cloudflare: `bizinsights.io` and `www` move from CloudFront to the tunnel (proxied, takes effect
   in seconds).
6. Smoke tests; sign in; a test webhook; WhatsApp numbers connected; schedules on.
7. Webhooks queued at Shopify arrive at iKorex.

The window is the only write freeze. The rollback for each step is in [ROLLBACK_PLAN.md](ROLLBACK_PLAN.md).

## Acceptance (the brief's 22 criteria)

Each criterion gets its evidence in `MIGRATION_TEST_REPORT.md` (written at stages B-D, not before):
the test run, the command output or the screenshot. None is claimed until it has that.
