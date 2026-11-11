# The 2026-11-11 brief's open-source stack, and what the move uses

The owner's brief of 2026-11-11 ("complete AWS to self-hosted server migration") is the fourth on
this move. It names the same server (`deployer@103.146.112.176`) and a preferred component for each
job: Traefik, Keycloak, PostgreSQL, Valkey, NATS JetStream, RabbitMQ, Garage, Postal or an external
SMTP relay, Prometheus, Grafana, Loki, OpenBao, Restic, Let's Encrypt, all under Docker Compose. It
also says: inspect before changing, do not create unnecessary new services, do not rewrite working
business logic, do not assume the server has room.

Most of the move is already built and partly live (the 2026-11-06 brief, the owner's decisions of
2026-11-07 in
[IKOREX_INFRASTRUCTURE_ARCHITECTURE.md](IKOREX_INFRASTRUCTURE_ARCHITECTURE.md#decisions-2026-11-07)).
This page sets the brief's list beside it, so the work isn't started again, and says where each
thing the brief asks for stands. Nothing here changes the server or AWS.

## Where the move stands (2026-11-11)

| | State |
| --- | --- |
| AWS audit (brief §2) | Done: [AWS_INVENTORY.md](AWS_INVENTORY.md), every service with its code, settings, data and cost |
| Self-hosted runtime (queues, schedules, coordinator, files, metrics, Compose, deploy and backup scripts) | Built and tested, on `main` since release 167 |
| Sign-in without Cognito | **Live in production** since release 173 (`AUTH_MODE=migrating`): each user moves over at their next sign-in, under the same user id |
| SMS without AWS | Built (Twilio, release 172), off until the owner's Twilio account is ready |
| Database copy RDS → server, and its check | Built and tested on the PC; never run against RDS |
| Deploy workflow (GitHub Actions over SSH) | Built, off until the deploy key is agreed with the server's administrator |
| **The server** | First login and read-only inspection on 2026-11-08: **no go on memory** (3.9 GB in all, 2.5 GB available, twelve other containers already running). The administrator was asked for 8 GB and 4 vCPU. Nothing of bizinsights is installed there |
| AWS | Still runs everything. Nothing has been removed |

So the brief's phases 1, 5, 6, 8 and most of 9 are done in code; phase 2 has a result (no go);
phases 3, 4 and 10 to 13 wait for the server.

## Component by component

Licences and releases were read from each project's repository on 2026-11-11. Memory figures marked
"vendor" are from the project's own documentation; the others are estimates, not measurements on
this server.

| Job | Brief prefers | Licence, latest release | The move uses | Why, measured |
| --- | --- | --- | --- | --- |
| Deployment | Docker Compose | Apache-2.0, v5.7.1 | **Docker Compose** (the server has v5.6.0) | Same |
| Main database | PostgreSQL | PostgreSQL licence | **PostgreSQL 17.11** in a container, the version RDS runs | Same |
| Reverse proxy, TLS | Traefik + Let's Encrypt | MIT, v3.7.18 | **Cloudflare Tunnel** (`cloudflared`, Apache-2.0, 2026.10.7) | The server's ports 80 and 443 already belong to the other websites' nginx gateway (inspection, 2026-11-08): Traefik can't take them without changing those sites, which the administrator's condition rules out. The tunnel dials out, so bizinsights opens no port and needs no certificate on the server; Cloudflare, already in front of `bizinsights.io`, ends TLS |
| Sign-in | Keycloak | Apache-2.0, 26.8.2 | **The app's own sign-in** (`localAuth.ts`, `migratingAuth.ts`), live | Cognito never exports password hashes, whatever replaces it. The app's own checks each password with Cognito once and keeps the account under the same id, so nobody resets. Keycloak can only do that with a custom Java plugin against Cognito; without one, every password user resets. Keycloak needs 1,250 MB (vendor) on a server with 2.5 GB to spare, and users are already moving to the app's own sign-in in production: switching would be a second migration of the same people |
| Cache | Valkey | BSD-3-Clause, 9.1.3 | **Nothing** | There is no cache on AWS either (no ElastiCache). DynamoDB's twelve coordination items (rate limits, sign-in state, locks) are a PostgreSQL table (`pgCoord.ts`) |
| Events (SNS) | NATS JetStream | Apache-2.0, v2.15.3 | **Alertmanager** for alarms, **Twilio's signed webhooks** for SMS events | SNS carries only those two things. The app's own notifications (the bell, alerts, emails) never went through SNS: they are rows in the database and jobs in the queue |
| Queues (SQS) | RabbitMQ | MPL-2.0, v4.4.0 | **A PostgreSQL queue** (`pgQueues.ts`) with SQS's contract: delays, acknowledgements, retries, dead-letter after 10 deliveries, redrive, per-queue concurrency, any number of workers | 34,719 jobs a week (0.06 a second). A job and the rows it is about commit in one database and are backed up together, so a restore never leaves a queue ahead of or behind its data. RabbitMQ's production minimum is 4 GiB a node (vendor). Tested against PostgreSQL: 13 tests, a worker dying mid-job included |
| Scheduled tasks | (RabbitMQ) | | **Schedules in the worker** (`schedules.ts`): cron with time zones, each tick once across workers, catch-up after a restart | Replaces EventBridge Scheduler; RabbitMQ has no scheduler of its own |
| Object storage (S3) | Garage | AGPL-3.0, v2.5.0 | **A Docker volume** (`fsBlobs.ts`) for the 7-day files; **Cloudflare R2** for backups | S3 holds no customer uploads, product images, reports or exports: only webhook bodies and WhatsApp media waiting for their job, the built pages (served by the app now), and database dumps. An object store on the same disk as the database is not a backup, so backups have to leave the server either way |
| Email (SES) | Postal or an external SMTP relay | MIT, 3.3.7 (June 2026) | **Resend**, the external relay the brief allows | SES was never the sender: Resend sends every email today, and the domain's DKIM key (`resend._domainkey`), the sending subdomain's SPF and DMARC (`p=quarantine`) are published (checked 2026-11-11). Postal wants 4 GB, 2 cores, MariaDB and a server "running no other software" (vendor), outbound port 25, and a new IP address has no sending reputation: sign-in codes would start in spam |
| Workers (Lambda) | Docker workers | | **`web` and `worker` containers** from one image, plus `admin` for one-off commands | The same handlers as the Lambda functions, unchanged |
| Metrics, dashboards | Prometheus, Grafana | Apache-2.0, v3.16.0; AGPL-3.0, v13.3.1 | **Prometheus, Alertmanager, Grafana** (16 alert rules) and an external uptime check | Same, plus the outside check a monitor on the same server can't replace |
| Logs | Loki | AGPL-3.0, v3.7.9 | **Loki + Alloy as a profile, off** (decision 7) | The collector needs the Docker socket, which is root on a server shared with other people's workloads. Docker's rotated log files until the administrator agrees |
| Secrets | OpenBao | MPL-2.0, v2.7.2 | **`env/*.env` files**, mode 600, one per container; copies in the owner's password manager | OpenBao starts sealed after every restart. Unsealing by hand means the app stays down after a reboot until someone types keys; unsealing automatically on one server means the unseal key sits on the same disk as the vault, which protects no more than a mode-600 file does |
| Backups | Restic | BSD-2-Clause, v0.19.1 | **pgBackRest** (MIT, 2.60.0) to R2: WAL every 5 minutes, nightly backups, AES-256 before upload, weekly restore test | Everything that must survive is in PostgreSQL. Restic copies files and can't restore a running database to a point in time; pgBackRest can, to within 5 minutes, as RDS does |

Not in the brief's table but in the move: **Evolution API** (the WhatsApp service, same pinned
image as on AWS) and **Twilio** for SMS, since no software sends a text without a carrier.

### What the brief's full list would need

Three of its components state their own minimums: Keycloak 1.25 GB, RabbitMQ 4 GiB, Postal 4 GB
and a server to itself. Run lean instead (estimate), the nine added services would still take about
3 GB: Keycloak 1.25, Postal with MariaDB about 1, RabbitMQ about 0.3, and NATS, Valkey, Garage,
OpenBao and Traefik about 0.5 together. bizinsights itself needs 3.2 to 4.6 GB
([SERVER_CAPACITY_REPORT.md](SERVER_CAPACITY_REPORT.md)). The server had 2.5 GB available.

### Recommendation

Keep what is built. It meets every requirement in the brief's sections 4 to 9 (retries,
dead-letter queues, failed-job tracking, idempotent workers, schedules, sign-in with emailed codes
and Google, account migration without deleting anyone, tenant isolation) with components that are
tested and, for sign-in, already carrying production. Each of the brief's components becomes the
right choice at a point the app hasn't reached:

| Component | When it earns its place |
| --- | --- |
| RabbitMQ or NATS | Past ~100 jobs a second all day, or when a second system has to consume the app's events |
| Valkey | When rate-limit writes start to show in PostgreSQL's load |
| Garage | When a feature stores customer files and there are three or more servers to spread them over; `BlobStore` already hides the store |
| Keycloak | When merchants ask for company single sign-on (SAML/OIDC) |
| OpenBao | Several servers sharing secrets, with a separate machine to unseal from |
| Traefik | A server of bizinsights' own, where ports 80 and 443 are free |
| Postal | Not on a shared server; only with a dedicated machine and a warmed-up address |

This is the owner's call. If the owner wants the brief's list as written, it needs a server of its
own first (8 GB at the least, 16 GB to follow the vendors' minimums), and Keycloak would mean every
password user resetting once.

## The brief's sections, one by one

| § | Asks for | Where it stands |
| --- | --- | --- |
| 1 | Server facts before anything | Inspected read-only on 2026-11-08 ([inspect-server.sh](inspect-server.sh)): Ubuntu 24.04.5, 2 vCPU, 3.9 GB memory, 73 GB disk with 45 GB free, Docker 29.8.2, twelve containers of other workloads. Written up in PR #360, not yet on `main`. On 2026-11-11 the owner logged in again (the login banner: 43 % of memory in use, 34 updates and a restart pending); the second inspection, to see whether the server has been enlarged, has not run yet: it needs the owner to type the key's passphrase |
| 2 | AWS dependency inventory | [AWS_INVENTORY.md](AWS_INVENTORY.md). Not in use, so nothing to replace: API Gateway, ElastiCache, Step Functions, ECR, AWS Backup, Route 53 public zones |
| 3 | Open-source replacements installed | Chosen (above), configured in `infra/ikorex/`, **not installed**: no room on the server |
| 4 | SNS replaced | Done in code (above). Retries, dead-letter and failed-job tracking are the queue's; each text's delivery status is kept on its own record in the database |
| 5 | SQS replaced | Done in code, every producer and consumer: they use the `Queues` interface, and `pgQueues.ts` implements it |
| 6 | Cognito replaced, no account deleted, ids preserved | Live in production (`migrating`). Apple sign-in isn't implemented (removed in #21). Open: Google on the app's own client (the owner adds one redirect address) |
| 7 | S3 migrated | Nothing to copy: no object in S3 is kept for good. Buckets are deleted at stage F, after the final database dump is in R2 |
| 8 | SES replaced, real inbox delivery tested | Resend sends, as it does today. Its delivery from the server is tested at stage B (a sign-in code to a real inbox) |
| 9 | Lambda → workers | Done in code: health checks, graceful stop, time limits, retries, logs |
| 10 | Database migration, counts verified, nothing destructive without a backup | [DATABASE_MIGRATION_REPORT.md](DATABASE_MIGRATION_REPORT.md). No DynamoDB table holds records: its one table is the coordinator's twelve short-lived items. The copy back into RDS for a rollback is in PR #356, not yet on `main` |
| 11 | Compose architecture, private networks, dev/staging/production | `infra/ikorex/docker-compose.yml` and `docker-compose.monitoring.yml`: no published port, one internal network. Production is the project `bizinsights`, staging a second project `bizinsights-staging` with its own volumes and database, development is `pnpm --filter @app/aws dev` ([docs/local-dev.md](../local-dev.md)) |
| 12 | Every feature preserved | The API, the jobs and every module run unchanged; only the adapters under them are new. Verified per feature at stage B |
| 13 | Security | [SECURITY_AUDIT.md](SECURITY_AUDIT.md). The server's own SSH and firewall settings are the administrator's: `deployer` has no passwordless sudo, and the administrator's condition is to be asked before any change |
| 14 | CI/CD over SSH | `.github/workflows/ikorex-deploy.yml`, off (`IKOREX_STAGING` and `IKOREX_PRODUCTION` unset). Deploy to AWS is untouched |
| 15 | Phases in order, stopping on a critical failure | Phase 2 has one: the server's memory. Phases 3 onward on the server have not started |
| 16 | Tests with PASS, FAIL or BLOCKED | Below |
| 17 | AWS shutdown | [ROLLBACK_PLAN.md](ROLLBACK_PLAN.md): "Before stage F starts" and "Order of decommissioning". Nothing has been shut down |
| 18 | Thirteen files | Below |

## The brief's tests (§16)

"Code" is what has been run on the PC, in CI or in production on AWS; the runs are in
[MIGRATION_TEST_REPORT.md](MIGRATION_TEST_REPORT.md). "On the server" is blocked for every row by
the same thing: nothing can be installed until the server has room and its administrator agrees.

| Test | Code | On the server |
| --- | --- | --- |
| User registration | PASS (browser suite on the app's own sign-in, 28 of 28) | BLOCKED |
| Email OTP | PASS (same suite: sign-up and sign-in codes) | BLOCKED |
| Google authentication | PASS through Cognito; on the app's own client BLOCKED (the owner's redirect address at Google) | BLOCKED |
| Session refresh | PASS (the session survives a reload; sign-out everywhere) | BLOCKED |
| Shopify connection | BLOCKED (needs staging on a public address; the code is the one live on AWS) | BLOCKED |
| Shopify webhook processing | PASS for the queue under it (same handlers); a real webhook BLOCKED | BLOCKED |
| Product, order and customer synchronisation | BLOCKED (needs staging with a copy of the data) | BLOCKED |
| SNS replacement | Alert rules load (16); a test alert and a real text's delivery report BLOCKED (stage C; the owner's Twilio account) | BLOCKED |
| SQS replacement | PASS (13 tests against PostgreSQL: delay, retry, dead-letter, redrive, two workers, a worker dying) | BLOCKED |
| Background workers | PASS (the built bundle ran a schedule tick and a queued job against a migrated database) | BLOCKED |
| Email delivery | BLOCKED from the server (Resend delivers from AWS today; not re-tested for this move) | BLOCKED |
| File uploads and downloads | PASS for the file store (the app has no customer uploads) | BLOCKED |
| WhatsApp automation | BLOCKED (the service is configured, never started) | BLOCKED |
| Scheduled campaigns | PASS for the scheduler; a campaign end to end BLOCKED | BLOCKED |
| Dashboard analytics | BLOCKED (needs staging with a copy of the data) | BLOCKED |
| Tenant permissions | PASS for the copy (row-level security on 149 tables and 293 policies arrive unchanged) | BLOCKED |
| Database backups | BLOCKED (stage C: needs the R2 bucket) | BLOCKED |
| Database restoration | PASS for the copy's restore on the PC; the backup's restore BLOCKED | BLOCKED |
| Server restart recovery | BLOCKED | BLOCKED |
| Recovery after a container failure | PASS for a worker dying mid-job (the job is taken over); a container restart BLOCKED | BLOCKED |

No test has failed. None is claimed for the server.

## The brief's thirteen files

The earlier brief's pages cover twelve of them under the names they were given then. They stay
where they are (links, tests and three open pull requests point at them); this table is the map.

| Brief's file | Page |
| --- | --- |
| 1. AWS_SERVICE_INVENTORY.md | [AWS_INVENTORY.md](AWS_INVENTORY.md) |
| 2. SERVER_AUDIT.md | [SERVER_CAPACITY_REPORT.md](SERVER_CAPACITY_REPORT.md) (the 2026-11-08 inspection is in PR #360) |
| 3. MIGRATION_ARCHITECTURE.md | [IKOREX_INFRASTRUCTURE_ARCHITECTURE.md](IKOREX_INFRASTRUCTURE_ARCHITECTURE.md) |
| 4. AWS_TO_OPEN_SOURCE_MAPPING.md | [AWS_TO_IKOREX_MIGRATION_MATRIX.md](AWS_TO_IKOREX_MIGRATION_MATRIX.md), and this page |
| 5. DOCKER_COMPOSE_PRODUCTION.yml | [infra/ikorex/docker-compose.yml](../../infra/ikorex/docker-compose.yml), [docker-compose.monitoring.yml](../../infra/ikorex/docker-compose.monitoring.yml) |
| 6. ENVIRONMENT_VARIABLES_MIGRATION.md | [ENVIRONMENT_VARIABLES_MIGRATION.md](ENVIRONMENT_VARIABLES_MIGRATION.md) (new) |
| 7. DATABASE_MIGRATION.md | [DATABASE_MIGRATION_REPORT.md](DATABASE_MIGRATION_REPORT.md) |
| 8. SECURITY_CONFIGURATION.md | [SECURITY_AUDIT.md](SECURITY_AUDIT.md) |
| 9. DEPLOYMENT_GUIDE.md | [PRODUCTION_DEPLOYMENT_GUIDE.md](PRODUCTION_DEPLOYMENT_GUIDE.md) |
| 10. BACKUP_AND_RESTORE.md | [IKOREX_INFRASTRUCTURE_ARCHITECTURE.md](IKOREX_INFRASTRUCTURE_ARCHITECTURE.md#database-replaces-rds) (what is backed up, where, how it is tested) and [PRODUCTION_DEPLOYMENT_GUIDE.md](PRODUCTION_DEPLOYMENT_GUIDE.md#restoring-the-database) (the restore commands) |
| 11. TESTING_REPORT.md | [MIGRATION_TEST_REPORT.md](MIGRATION_TEST_REPORT.md), and the table above |
| 12. AWS_SHUTDOWN_CHECKLIST.md | [ROLLBACK_PLAN.md](ROLLBACK_PLAN.md#before-stage-f-starts) and its "Order of decommissioning" |
| 13. ROLLBACK_PLAN.md | [ROLLBACK_PLAN.md](ROLLBACK_PLAN.md) |

## What needs someone's yes

Nothing below has been done on anyone's behalf.

| # | What | Whose |
| --- | --- | --- |
| 1 | More memory on the server (asked 2026-11-08: 8 GB, 4 vCPU), or a server of bizinsights' own | The server's administrator; the owner |
| 2 | Agreement to install bizinsights on the server at all, and a separate Linux user for it | The administrator |
| 3 | The stack: keep what is built (recommended) or the brief's list | The owner |
| 4 | Google sign-in on the app's own client: add `https://bizinsights.io/auth/callback` to the Google client's redirect addresses | The owner |
| 5 | A Twilio account, then the one-line switch (`docs/sms.md`, "Switching to Twilio") | The owner |
| 6 | The Cloudflare Tunnel's token and the R2 bucket's token (stages B and C) | The owner, in Cloudflare |
| 7 | The deploy key: a key of its own on the server, limited to `ssh-gate.sh` | The administrator |
| 8 | The cutover date; later, stage F and closing the AWS account | The owner |
