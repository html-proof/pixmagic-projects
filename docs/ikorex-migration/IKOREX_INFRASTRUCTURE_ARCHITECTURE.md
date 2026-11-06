# bizinsights on the iKorex server: proposed architecture

**Status: proposal, not built.** It depends on the server having room (see
[SERVER_CAPACITY_REPORT.md](SERVER_CAPACITY_REPORT.md)) and on the decisions listed at the end.
What it replaces, service by service: [AWS_INVENTORY.md](AWS_INVENTORY.md).

## Principles

- **Nothing on the server changes for the existing workloads.** bizinsights is one Docker Compose
  project (`bizinsights`) in its own folder, its own network and volumes, with no port published on
  the host. The live websites, n8n and the CCTV tunnel, their web server and their firewall stay as
  they are.
- **Same code, new adapters.** The API, the jobs and every module run unchanged. Only the
  implementations behind `Queues`, `Coord`, `BlobStore` and the entry point are new.
- **Nothing important lives only on this server.** Backups leave it continuously; a lost server is
  rebuilt from them on any Linux host with Docker.
- **AWS stays running until the move is proven**, and after it for a rollback period.

## Traffic

```
visitor ──HTTPS──> Cloudflare (DNS, proxy, TLS, managed rules, rate limit)
                      │  Cloudflare Tunnel: outbound connection from the server, no open port
                      ▼
                 cloudflared ──> app (UI + API, port 8080 on the internal network only)
```

Cloudflare already proxies `bizinsights.io`. A Cloudflare Tunnel (free) lets the `cloudflared`
container dial out to Cloudflare, so the server needs **no inbound port, no TLS certificate and no
change to its existing web server**. Shopify webhooks, OAuth callbacks (Shopify, Meta, Google, Zapier)
and the Cognito domain all use `bizinsights.io` / `auth.bizinsights.io`, so they keep working when the
hostname's target moves from CloudFront to the tunnel: no app registration has to change.

The app trusts the client address only from Cloudflare's `CF-Connecting-IP` (and location from
Cloudflare's visitor-location headers). That is safe because the tunnel is the only way in: the
`app` container publishes no port.

What CloudFront does today and where it goes:

| CloudFront today | On iKorex |
| --- | --- |
| WAF in front of the API | Cloudflare's free managed rules + one rate-limiting rule; the app's own per-IP and per-route limits stay |
| Origin secret (`x-origin-verify`) | Not needed: no public origin to protect |
| Static files from S3 | Served by `app` from its image, long-cache headers on hashed files, cached by Cloudflare |
| Outage page when the origin fails | To confirm on Cloudflare's Free plan: custom error page, or a tiny Worker that serves the outage page when the tunnel is down |

## Containers

All on one internal Docker network (`bizinsights_internal`). Only `cloudflared` reaches out to
Cloudflare; every container can reach the internet for its own calls (Shopify, Meta, Google, Resend,
Cognito).

| Service | Image | Role | Data | Memory limit |
| --- | --- | --- | --- | --- |
| `cloudflared` | `cloudflare/cloudflared` (pinned) | The tunnel | — | 128 MB |
| `app` | bizinsights (built per commit) | UI + API: `buildApp` behind a Node HTTP server | — | 768 MB |
| `worker` | same image, other command | Queue consumers + schedules: `consume()` and `runScheduled()` as today | — | 1.5 GB |
| `postgres` | `postgres:17` (pinned digest) | Databases `app` and `evolution`; roles from `infra/postgres/init.sql` | volume `pgdata` | 2 GB |
| `redis` | `redis:7` (pinned) | The coordinator (`Coord`): rate limits, OAuth state, locks, signed-out sessions; append-only file on | volume `redisdata` | 128 MB |
| `evolution` | `evoapicloud/evolution-api:v2.3.7@sha256:1bd8…` (as today) | WhatsApp QR linking | its own database | 1 GB |
| `backup` | wal-g + PostgreSQL client | WAL archiving, nightly dumps, weekly restore test | — | 256 MB |
| monitoring (see below) | Prometheus, Alertmanager, Grafana, Loki, exporters | Metrics, logs, alerts | volumes | ~1.5 GB together |

Every service: `restart: unless-stopped`, a health check, a memory and CPU limit, logs rotated
(`json-file`, 3 × 10 MB), images pinned by digest.

### Queues (replaces SQS + the `jobs` function)

[pg-boss](https://github.com/timgit/pg-boss), a maintained job queue on PostgreSQL, in its own schema
in the `app` database. It gives what SQS gives today and what the brief asks for: durable storage,
claim with `SKIP LOCKED` (no job runs twice at once), retries with exponential backoff, a dead-letter
queue, timeouts (an expired claim comes back by itself), priorities, de-duplication keys, job state
and history. A `pgBossQueues` adapter implements the existing `Queues` interface, so producers don't
change.

Kept from today: the six queues (`sync`, `webhooks`, `aggregate`, `email`, `smsEvents`, `whatsapp`),
their concurrency (2, 2, 2, 2, 2, 3), at-least-once delivery with idempotent handlers, backoff from
5 s doubling to 15 minutes, 6 attempts, then the dead-letter queue. Every job carries its
`workspace_id` and its handler runs under row-level security, so tenant isolation is unchanged.
More workers can be added (`docker compose up --scale worker=2`) and they share the queues safely.

**Events (replaces SNS).** pg-boss's publish/subscribe fans one event out to every queue subscribed
to it, which is the "internal notification service" the brief describes. SNS today only carries
alarm emails and SMS delivery events; the app's own notifications (`packages/core/src/notify.ts`, the
bell, alerts) already run through the queues, the database and Resend.

### Schedules (replaces EventBridge Scheduler + the `cron` function)

pg-boss schedules: every 15 minutes, 03:15 UTC nightly, and 07:00 Melbourne (cost email). A tick is
a job, so it survives a restart, runs once however many workers there are, and its result is
recorded. `runScheduled()` is reused unchanged. The maintenance actions (`migrate`, `counts`,
`reread`, `verify`, `shopify-check`, ...) become a command: `docker compose run --rm app admin <action>`.

### Coordinator (replaces DynamoDB)

A `redisCoord` adapter: counters with expiry for rate limits, `SET NX PX` for locks and OAuth state.
Redis keeps it off PostgreSQL (every API request touches the rate limiter). Append-only file synced
every second, so a crash loses at most a second of counters.

### Blobs (replaces the `payloads` bucket)

A `fsBlobs` adapter writing to a volume, with a nightly prune of anything older than 7 days, as the
bucket's lifecycle rule does today. No MinIO: nothing stored is a customer file (see the inventory).

### Database (replaces RDS)

PostgreSQL 17 (RDS runs 17.11), one container, data on the server's disk. Settings sized to the
memory it gets (`shared_buffers` ~25 %, `effective_cache_size` ~60 %). The `app_rls` and `system`
roles and every row-level security policy come over unchanged (roles from `init.sql`, schema and
data from `pg_dump`). The app and worker use Prisma's connection pools (about 25 connections at the
most); PgBouncer is added only if a second worker host ever needs it.

**Backups**, all leaving the server, encrypted before upload:

- **Continuous**: wal-g archives the write-ahead log at least every 5 minutes, so point-in-time
  restore loses at most 5 minutes (RDS today: about 5 minutes too).
- **Nightly**: a full base backup and a `pg_dump` of each database.
- **Where**: Cloudflare R2 proposed (10 GB free, S3-compatible, same account as the DNS), or
  Backblaze B2. Kept 14 days, like RDS.
- **Tested**: every week a throwaway container restores the latest backup and compares per-table
  row counts with production; a failed test alerts.

### Monitoring (replaces CloudWatch)

Prometheus (metrics, 15 days), Alertmanager (email through Resend), Grafana (dashboards, behind
Cloudflare Access, never public), Loki (logs, 30 days), node-exporter, cAdvisor, postgres-exporter,
redis-exporter, and a `/metrics` endpoint on `app` and `worker` for request times, error rates, queue
depth, dead-letter count and job failures. The alarms worth keeping from CloudWatch become Prometheus
rules: 5xx rate, job failures, dead-letter queue not empty, schedule missed, disk > 80 %, database
memory and connections, backup older than 26 hours.

A monitor on the same server cannot report that the server is down, so **an external uptime check**
(a free one, such as UptimeRobot or healthchecks.io) watches `https://bizinsights.io/api/readyz` and
receives a "backup finished" ping.

If the server is short of memory, Loki and Grafana go first; Prometheus, Alertmanager and the external
check stay.

### Secrets (replaces Secrets Manager + SSM)

One env file, `~/bizinsights/.env`, mode 600, owned by `deployer`, read by Compose. Filled once by a
script that reads Secrets Manager and SSM and writes the file on the server without printing a
value. An encrypted copy (age) is kept off the server with the backups, so a rebuild doesn't depend
on AWS. Nothing secret ever goes to GitHub.

### What stays outside, and why

| Service | Why it stays |
| --- | --- |
| Cloudflare (DNS, proxy, Tunnel, R2) | Already the front door; free |
| Resend | Already sends every email; deliverability needs a reputable sender, not a server of our own |
| Cognito (recommended) | Free at this size; cannot export password hashes (see the matrix for the alternatives) |
| AWS End User Messaging SMS (owner's choice) | Per message; sending SMS needs a carrier-connected provider |
| Shopify, Meta, Google, Zapier | The integrations themselves |

## Deploys (replaces CDK + Deploy to AWS)

Same rule as today: everything reaches the server from GitHub `main`, never by hand.

1. CI as today (tests, typecheck, build).
2. The runner builds the image, tags it with the commit, and sends it over SSH (`docker save | ssh
   docker load`); no registry needed.
3. On the server: migrations run first in a one-off container (the `migrate-before-live` rule), then
   `app` and `worker` are recreated with the new tag.
4. Health checks and the smoke tests; if any fails, the previous tag comes back and the run fails.

The runner gets its own SSH key, added only after the server's administrator agrees, restricted to
the deploy command. Development and staging stay separate: staging is a second Compose project
(`bizinsights-staging`) with its own database, on `staging.bizinsights.io` behind Cloudflare Access.

## Isolation from the other workloads

- Own folder (`~/bizinsights`), Compose project, network and volumes; nothing named like the
  existing containers; no host ports; no edits to the existing web server, firewall, n8n or tunnel.
- Memory and CPU limits on every container, so bizinsights cannot starve the websites, n8n or CCTV.
- Disk: alert at 80 %; logs rotated; images pruned to the last three releases.
- Limits of this isolation, stated plainly: the `deployer` account runs everything on the server, and
  Docker access is root-equivalent. A compromise of any workload under `deployer` reaches all of them.
  A separate Linux user for bizinsights would be better, and is the server administrator's call.

## Decisions this design needs

1. The server administrator's agreement, and an SSH key for this PC (the guide's steps 2-4).
2. Cognito: keep (recommended) or leave (password resets or a lazy migration).
3. SMS: keep AWS End User Messaging or move to another provider.
4. Backup destination: Cloudflare R2 (recommended) or Backblaze B2.
5. Accepting one server instead of Multi-AZ: no automatic failover; recovery is a restore.
6. A maintenance window for the cutover (about 30 minutes).
