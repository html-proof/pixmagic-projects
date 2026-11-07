# bizinsights on the iKorex server: architecture

**Status (2026-11-06): stage A built and tested on this PC, not deployed.** The runtime code
(`apps/aws/src/selfhost.ts` and its parts) and the server's files (`infra/ikorex/`) exist; nothing
runs on the server yet. Deploying depends on the server having room
([SERVER_CAPACITY_REPORT.md](SERVER_CAPACITY_REPORT.md)) and on the decisions listed at the end.
What it replaces, service by service: [AWS_INVENTORY.md](AWS_INVENTORY.md). How to run it:
[PRODUCTION_DEPLOYMENT_GUIDE.md](PRODUCTION_DEPLOYMENT_GUIDE.md).

## Principles

- **Nothing on the server changes for the existing workloads.** bizinsights is one Docker Compose
  project (`bizinsights`) in its own folder, with its own network and volumes, and no port published
  on the host. The live websites, n8n and the CCTV tunnel, their web server and their firewall stay as
  they are.
- **Same code, new adapters.** The API, the jobs and every module run unchanged. Only the
  implementations behind `Queues`, `Coord`, `BlobStore` and the entry point are new.
- **No new moving parts where an existing one does the job.** PostgreSQL already runs: it holds the
  queue, the schedule ticks and the coordinator too, so there is no Redis, pg-boss or MinIO to run,
  patch and back up.
- **Nothing important lives only on this server.** Backups leave it continuously; a lost server is
  rebuilt from them on any Linux host with Docker.
- **AWS stays running until the move is proven**, and after it for a rollback period.

## Traffic

```
visitor ──HTTPS──> Cloudflare (DNS, proxy, TLS, managed rules, rate limit)
                      │  Cloudflare Tunnel: outbound connection from the server, no open port
                      ▼
                 cloudflared ──> web (UI + API, port 8080 on the internal network only)
```

Cloudflare already proxies `bizinsights.io`. A Cloudflare Tunnel (free) lets the `cloudflared`
container dial out to Cloudflare, so the server needs **no inbound port, no TLS certificate and no
change to its existing web server**. Shopify webhooks, OAuth callbacks (Shopify, Meta, Google, Zapier)
and the Cognito domain all use `bizinsights.io` / `auth.bizinsights.io`, so they keep working when the
hostname's target moves from CloudFront to the tunnel: no app registration has to change.

The app trusts the client address only from Cloudflare's `CF-Connecting-IP` (and location from
Cloudflare's visitor-location headers), and only when it is a valid address. That is safe because the
tunnel is the only way in: the `web` container publishes no port (`TRUSTED_IP_HEADER`, `webHandler` in
`selfhost.ts`).

What CloudFront does today and where it goes:

| CloudFront today | On iKorex |
| --- | --- |
| WAF in front of the API | Cloudflare's free managed rules + one rate-limiting rule; the app's own per-IP and per-route limits stay |
| Origin secret (`x-origin-verify`) | Not needed: no public origin to protect; the header is dropped if a client sends it |
| Static files from S3 | Served by `web` from its image, cached by Cloudflare |
| Outage page when the origin fails | To set up at Cloudflare: the build keeps the page in `fallback/unavailable.html` |
| Request bodies up to 6 MB (function URL) | The same limit in `webHandler` |

## Containers

`infra/ikorex/docker-compose.yml`, all on the project's own network (`bizinsights_internal`). Only
`cloudflared` takes traffic in (through Cloudflare); every container can reach the internet for its
own calls (Shopify, Meta, Google, Resend, Cognito).

| Service | Image | Role | Data | Limits |
| --- | --- | --- | --- | --- |
| `cloudflared` | `cloudflare/cloudflared:2026.10.7` | The tunnel | — | 128 MB, 0.5 CPU |
| `web` | `bizinsights:<commit>` (built on the server from the bundle) | `node server.mjs web`: UI + API | blobs volume | 768 MB, 1 CPU |
| `worker` | same image | `node server.mjs worker`: the queues' jobs and, with `SCHEDULES=on`, the schedules | blobs volume | 1.5 GB, 2 CPU |
| `admin` | same image, profile `admin` | `node admin.mjs <command>`: migrations and maintenance; the only one given the owner's login | — | one-off |
| `postgres` | `postgres:17.11-bookworm` + pgBackRest | Databases `app` and `evolution`; roles from `infra/postgres/init.sql` | `pgdata` | 2 GB, 2 CPU |
| `backup` | the same PostgreSQL image | Nightly backup off the server, weekly restore test | shares `pgdata` | 768 MB, 1 CPU |
| `evolution` | `evoapicloud/evolution-api:v2.3.7@sha256:1bd8…` (as on AWS) | WhatsApp QR linking | its own database | 1 GB, 1 CPU |

Every app container: `restart: unless-stopped`, a health check, a read-only root filesystem, no Linux
capabilities, `no-new-privileges`, logs rotated (3 × 10 MB). Monitoring is a second Compose project
(below).

### Queue (replaces SQS + the `jobs` function): `apps/aws/src/pgQueues.ts`

Two tables in the `app` database, `job_queue` and `job_dead` (migration
`20261106120000_selfhost_runtime`), with **SQS's exact contract**, so no job handler changes:

| SQS | Here |
| --- | --- |
| `SendMessage` with a delay | a row due at `run_after` (no 15-minute cap, so no re-send hops) |
| `ApproximateReceiveCount` | `receives`, raised by each claim; it is `attempts` in the handler |
| visibility timeout | the claim's hold, `locked_until` (15 minutes + 1: the jobs function's limit); a worker that dies loses its hold and the job comes back by itself |
| delete on success | `ack()` deletes the row |
| `ChangeMessageVisibility` on retry | `retry({ delaySeconds })` moves `run_after` |
| a job that throws or neither acks nor retries | due again after 60 s, logged |
| redrive to the dead-letter queue after 10 receives | moved to `job_dead`; `admin dlq` lists it, `admin redrive` puts it back; pruned after 14 days |

Claims take rows `FOR UPDATE SKIP LOCKED`, so any number of worker processes share the queues and no
job is held twice; every hold has its own token, so a worker whose hold lapsed can't delete a job
another worker took over. Concurrency per queue is AWS's (sync 2, webhooks 2, aggregate 2, email 2,
smsEvents 2, whatsapp 3), changeable with `QUEUE_CONCURRENCY`; more worker containers can run side by
side. A job has 15 minutes; past that it is retried. Every job carries its `workspace_id` and its
handler runs under row-level security as on AWS, so tenant isolation is unchanged. The tables hold no
tenant data, have no row-level security, and the tenant role (`app_rls`) has no rights on them.

This replaces the earlier plan of pg-boss: the tables above give per-message delays and SQS's receive
counting exactly, which pg-boss's retry policies don't, with no extra dependency or schema to manage.

**Events (SNS).** SNS only carries the alarm emails and the SMS delivery events today; the app's own
notifications (`packages/core/src/notify.ts`, the bell, alerts) already run through the queues, the
database and Resend. Alarms move to Alertmanager. SMS stays on AWS End User Messaging (decided
2026-11-07), and so do its delivery events' topic and queue: the configuration set → SNS topic →
`smsEvents` SQS queue path is unchanged, and the server's worker long-polls that queue and moves each
event into its own `smsEvents` queue (`apps/aws/src/sqsBridge.ts`, with `SMS_EVENTS_QUEUE_URL`, only
when `SCHEDULES=on`). This replaced the plan of an SNS HTTPS subscription to the app: SQS keeps an
event 4 days, so a server down for hours loses none (SNS gives up on an HTTPS endpoint after an
hour), and no new public endpoint is needed. Polling costs nothing (~130,000 requests a month, in
SQS's free tier).

### Schedules (replaces EventBridge Scheduler + the `cron` function): `apps/aws/src/schedules.ts`

Every 15 minutes, 03:15 UTC nightly, and 07:00 Melbourne for the cost email (only with
`COST_REPORT_TO`). Each worker checks every 20 s which tick is due; a tick runs once however many
workers there are (the first to insert its `schedule_ticks` row runs it), a restart runs a tick it
missed (within 14 minutes for the 15-minute run, 12 hours for the nightly), and a failed or abandoned
tick is tried again after 20 minutes, three times at most. `runScheduled()` is reused unchanged. The
nightly run also does what AWS did by itself: expired coordinator rows (DynamoDB's TTL), blobs older
than 7 days (the bucket's rule), dead jobs older than 14 days (SQS's retention), the WhatsApp
service's old data. **Off unless `SCHEDULES=on`**: a staging copy must never refresh tokens or
reconcile stores, and before the cutover AWS runs them.

### Coordinator (replaces DynamoDB): `apps/aws/src/pgCoord.ts`

Table `coord_entries`: one atomic upsert per operation (fixed-window counters, one-time values,
expiring locks), the same semantics as DynamoDB's and the in-memory test version. A logged table, so
a signed-out session isn't forgotten after a crash. The rate limiter's one write per API request is
nothing for a local PostgreSQL at this traffic (~0.08 requests a second on average). `admin
import-coord` copies DynamoDB's live items at the cutover.

### Blobs (replaces the `payloads` bucket): `apps/aws/src/fsBlobs.ts`

Files on the `blobs` volume, shared by `web` (which writes large webhook bodies) and `worker` (which
reads them). Keys that could leave the folder are refused; writes are atomic. No MinIO: nothing
stored is a customer file (see the inventory).

### Database (replaces RDS)

PostgreSQL 17.11 (RDS runs 17.11), sized for 2 GB (`infra/ikorex/postgres/postgresql.conf`:
`shared_buffers` 512 MB, which is more than the whole RDS micro instance had free). The `app_rls`,
`app_system` and owner roles and every row-level security policy come over unchanged (roles from
`init.sql`, schema and data from `pg_dump`). Connections: Prisma's pools (`DB_POOL_MAX`: 8 web, 16
worker) plus the runtime's small pools; 80 allowed.

**Backups** with pgBackRest, all leaving the server, encrypted (AES-256) before upload:

- **Continuous**: the write-ahead log is archived as it fills and at least every 5 minutes
  (`archive_timeout`), so point-in-time restore loses at most 5 minutes, like RDS.
- **Nightly** at 02:30 UTC: a full backup on Sundays, a differential one otherwise. Kept 14 days,
  like RDS.
- **Where**: an S3-compatible bucket; Cloudflare R2 proposed (10 GB free, same account as the DNS).
- **Tested**: after each Sunday's full backup, `restore-test.sh` restores it into a scratch folder,
  starts it, and compares tables, applied migrations and row counts with the live database.
- **Watched**: each night ends with a ping to an external check (`BACKUP_PING_URL`); no ping in a
  day, or a "fail" ping, alerts. WAL archiving failures alert in Prometheus.

### Monitoring (replaces CloudWatch): `infra/ikorex/docker-compose.monitoring.yml`

Prometheus (15 days), Alertmanager (email through Resend's SMTP), Grafana (one provisioned
dashboard; reached through the tunnel behind Cloudflare Access, never public), node-exporter (the
host), postgres-exporter (a `pg_monitor` login, no table data), and the app's own `/metrics` on port
9464 of `web` and `worker`: request counts and times, job outcomes and times, queue depth by state,
the oldest waiting job, schedule successes, SMS events moved. Sixteen alert rules (`monitoring/alerts.yml`) cover what
the CloudWatch alarms did: app down, 5xx rate, slow API, dead jobs, queue backlog, failing jobs,
missed schedules, database down or out of connections, WAL archiving failing, disk, memory, load,
tunnel down, SMS events unread. Loki and Grafana Alloy (logs, 30 days) are a separate profile, because
Alloy needs the Docker socket (root-equivalent): **off** (decision 7), unless the server administrator
agrees to it.

A monitor on the same server can't report that the server is down, so **an external uptime check**
watches `https://bizinsights.io/api/readyz`, and the backup's ping is external too.

If the server is short of memory, Grafana and the logs profile go first; Prometheus, Alertmanager and
the external checks stay.

### Secrets (replaces Secrets Manager + SSM)

`env/*.env` files in the project folder, mode 600, one per concern so each container gets only what
it needs: `app.env` (web, worker, admin), `owner.env` (admin only: the owner's login and the roles'
passwords), `postgres.env` (database and backups: the bucket keys and the backup passphrase),
`evolution.env`, `cloudflared.env`, and the monitoring ones. `env/*.example` list every name; the real
files are git-ignored. `infra/ikorex/scripts/export-env.mjs` copies the values from AWS straight into
a file on the server and refuses to print to a terminal. The database gets new passwords; the app's
own secrets (session, token encryption, OTP pepper) are copied, never regenerated, or every stored
token and session stops matching. Copies of the passwords and the backup passphrase are kept off the
server (the owner's password manager).

### What stays outside, and why

| Service | Why it stays |
| --- | --- |
| Cloudflare (DNS, proxy, Tunnel, R2) | Already the front door; free |
| Resend | Already sends every email; deliverability needs a reputable sender, not a server of our own |
| Cognito (recommended) | Free at this size; cannot export password hashes (see the matrix for the alternatives) |
| AWS End User Messaging SMS (owner's choice) | Per message; sending SMS needs a carrier-connected provider |
| Shopify, Meta, Google, Zapier | The integrations themselves |

The AWS calls that remain (Cognito's admin calls, SMS, the cost email) use one IAM user's keys,
limited to those actions, where AWS used the functions' role.

## Deploys (replaces CDK + Deploy to AWS)

Same rule as today: everything reaches the server from GitHub `main`, never by hand.

1. CI as today (tests, typecheck, build).
2. `infra/ikorex/scripts/ship.sh` builds this commit's bundle (`apps/aws/scripts/build-server.mjs`:
   two self-contained files, `server.mjs` and `admin.mjs`, with the UI, migrations and `build.json`),
   sends it and `infra/ikorex` over SSH, and builds the image **on the server** (a copy onto the Node
   base image, for the server's own CPU; no registry, no Docker on the runner).
3. `scripts/deploy.sh` on the server: migrations first in a one-off `admin` container (if they fail,
   nothing switches), then `web` and `worker` on the new image, then health checks, `/api/readyz` and
   `/api/version` naming the commit. Any failure brings the previous image back and fails the run.
4. The newest three releases are kept for rollback.

The runner's SSH key is added only after the server's administrator agrees, restricted to this. The
GitHub workflow that calls `ship.sh` from `main` comes with stage B, once there is a server to reach.
Staging is a second Compose project (`bizinsights-staging`, its own volumes and database) on
`staging.bizinsights.io` behind Cloudflare Access.

## Isolation from the other workloads

- Own folder (`~/bizinsights`), Compose project, network and volumes; nothing named like the
  existing containers; no host ports; no edits to the existing web server, firewall, n8n or tunnel.
- Memory and CPU limits on every container (about 7.3 GB of limits in all, ~3–4.5 GB expected in
  use), so bizinsights cannot starve the websites, n8n or CCTV.
- Disk: an alert at 80 %; logs rotated; old releases removed.
- Limits of this isolation, stated plainly: the `deployer` account runs everything on the server, and
  Docker access is root-equivalent. A compromise of any workload under `deployer` reaches all of them.
  A separate Linux user for bizinsights would be better, and is the server administrator's call.

## Decisions (2026-11-07)

The owner asked for these to be made for them ("do it for me", 2026-11-07); each is recorded with
its reason, and any can be revisited before the cutover.

| # | Decision | Made | Why, and what it means |
| --- | --- | --- | --- |
| 1 | The server administrator's agreement and an SSH key for this PC | **Waiting on the administrator** | The key is made on this PC (the guide's step 2, with a passphrase only the owner knows); steps 3-4 (sending the public key, reading its fingerprint by phone) and the agreement are between the owner and the administrator |
| 2 | Cognito | ~~Keep~~ → **Replaced by the app's own sign-in, moved over gradually** (owner, 2026-11-07, later the same day: "every AWS service replaced, the account closed") | `AUTH_MODE` (`apps/api/src/localAuth.ts`, `migratingAuth.ts`, [docs/cognito-setup.md](../cognito-setup.md#9-leaving-cognito-the-apps-own-sign-in)): argon2id passwords, the app's own Google client, emailed codes through Resend. "migrating" moves each Cognito user at their next sign-in under the same sub; whoever hasn't signed in before AWS closes resets once by email. Two-step verification has to be set up again (Cognito never gives out the secret) |
| 3 | SMS | ~~Keep AWS End User Messaging~~ → **An SMS company's API** (owner, 2026-11-07, later the same day) | Open-source software can't send texts without a carrier, so a provider's API replaces AWS's; sender names and opt-outs are set up again there. Nothing real has been sent yet (AWS's SMS sandbox), so nothing carries over but settings. The provider and the work: [AWS_TO_IKOREX_MIGRATION_MATRIX.md](AWS_TO_IKOREX_MIGRATION_MATRIX.md) |
| 4b | The AWS account | **Closed** after the 14-day rollback period (owner, 2026-11-07) | Every resource deleted (stage F), a final database dump kept encrypted in R2 (snapshots can't leave AWS); closing the account itself is the owner's step in the AWS console |
| 4 | Backup destination | **Cloudflare R2** | The domain is already on Cloudflare; no egress fees for a restore; a ~2 GB database's compressed backups and 14 days of WAL should fit in R2's free 10 GB. The bucket and its token are made in stage C |
| 5 | One server instead of Multi-AZ | **Accepted** | It is what moving to one server means. Loss of the server loses at most the last 5 minutes of writes (WAL archived every 300 s to R2); recovery is a restore on another host: AWS during the 14-day rollback period, any Docker host after it (a few hours, rehearsed weekly by the restore test) |
| 6 | The cutover window | **A Sunday, 20:00-21:00 Melbourne time (09:00-10:00 UTC while daylight saving lasts)**, the first Sunday after stages B and C pass and the administrator agrees | The work takes ~30 minutes; the hour leaves room. Sunday evening is outside Australian business hours, the middle of the night in the Americas and before noon in Europe, and away from the 07:00 cost email; the owner can be there for the checks only they can do (signing in, WhatsApp numbers, Cloudflare). Shopify retries webhooks for hours, so orders in the window arrive afterwards. Before it is fixed, CloudWatch's hourly request counts (at the next `aws login`) confirm it is among the quietest hours |
| 7 | The logs profile (Loki + Alloy) | **Off** | Alloy needs the Docker socket, which is root on a server shared with the websites, n8n and CCTV. Logs stay in Docker's rotated files (`docker compose logs`); the profile can be turned on later if the administrator agrees |
