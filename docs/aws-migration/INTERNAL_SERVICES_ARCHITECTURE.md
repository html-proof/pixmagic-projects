# Internal services: what exists, what a replacement would take

The migration brief asks for in-app replacements of SNS, SQS, EventBridge, Step Functions, Lambda,
CloudWatch, SES and S3. This page records what the code already has for each, what a production
replacement would have to be, and when it would be worth building. The cost side is in
[AWS_COST_AUDIT.md](AWS_COST_AUDIT.md): together these services cost US$2.73 a month.

(Written 2026-11-06. Customer Messaging (SMS) and the email module were removed from the app on
2026-11-13: the `SmsProvider` interface, the SMS delivery events on SNS and the SMS and email
automations named below no longer exist.)

## The adapter layer already exists

The brief's "compatibility adapters" (stage 2) are already how the code is built. The API, the jobs
and the domain logic call interfaces; `apps/aws/src` supplies the AWS implementations;
`apps/aws/src/local.ts` runs the same app on one machine with others.

| Interface | Defined in | AWS implementation | Non-AWS implementation today | Fit for production off AWS? |
| --- | --- | --- | --- | --- |
| `Queues` / `Producer` | `packages/core/src/queues.ts` | `apps/aws/src/sqsQueues.ts` + `consumer.ts` (SQS) | `apps/aws/src/localQueues.ts`: in-process, `setTimeout` delays, lost on restart, no dead-letter queue | **No**: in memory |
| `Coord` (rate limits, OAuth state, locks) | `packages/core/src/coord.ts` | `dynamoCoord.ts` (DynamoDB) | `memoryCoord`; refused in production (`index.ts`) | **No**: in memory |
| `BlobStore` (large webhook bodies, WhatsApp attachments) | `packages/core/src/queues.ts` | `s3Blobs.ts` (S3) | `memoryBlobs` | **No**: in memory |
| `Mailer` | `packages/core/src/notify.ts` | `sesMailer.ts` (SES) | `resendMailer` (**in production use**), Mailpit, log | **Yes**: Resend already sends every app and sign-in email |
| `SmsProvider` | `packages/core/src/sms/provider.ts` | `smsProvider.ts` (End User Messaging) | fake / none | No other provider written |
| Schedules | `runScheduled(cron)` in `apps/worker/src/index.ts` | EventBridge Scheduler → `cron` function | `POST /__scheduled?cron=` by hand | **No**: nothing fires on a timer |
| Secrets | `loadSecrets` (`apps/aws/src/secrets.ts`) | Secrets Manager + SSM | an env file (`local.ts`) | Env file only |
| Sign-in | `CognitoAuth` (`apps/api/src/cognito.ts`) | Cognito | emulator and test fakes only | **No** |

What the brief lists as features is largely in the database already: job progress and history in
`sync_jobs`, per-message history and delivery status for email, SMS and WhatsApp, the notification
bell's feed, alerts, and the audit log. Job delivery is at-least-once with idempotent handlers,
exponential backoff (5 s doubling to 15 minutes, `backoffSeconds`), 6 attempts, then the dead-letter
queue. Tenant isolation is PostgreSQL row-level security on the `workspace_id`, which every job
carries.

## What a production replacement would have to be

Built only if the app leaves Lambda (see "When to build" below). Each keeps the interface above, so
nothing outside `apps/*` changes.

**Queue** (replaces SQS). A `jobs` table in PostgreSQL: queue, payload, workspace, priority,
`run_after`, attempts, last error, `locked_until`, and an idempotency key with a unique index.
Workers claim with `SELECT … FOR UPDATE SKIP LOCKED` ordered by priority and `run_after`; a claim
sets `locked_until` (the visibility timeout), so a crashed worker's job comes back by itself.
`retry({ delaySeconds })` moves `run_after`; after `MAX_ATTEMPTS` the row moves to a `dead_jobs`
table (the dead-letter queue) that `dlq.mjs`'s inspect/redrive maps onto. Concurrency per queue as
in `sources` in `infra/cdk/lib/app-stack.ts`. Graceful shutdown: stop claiming, finish or release
what is held. A maintained library (pg-boss, graphile-worker) does all of this and is the safer
choice than writing it.

**Scheduler** (replaces EventBridge Scheduler). One timer in the worker process per schedule, with a
`schedule_runs` row per (schedule, tick) inserted `ON CONFLICT DO NOTHING`, so two workers can't
both run a tick and a restart finds the ticks it missed. `runScheduled()` is reused as it is.

**Coordinator** (replaces DynamoDB). An `UNLOGGED` PostgreSQL table with an expiry column, or
`pg_advisory_lock` for the locks. It adds a database round trip to every rate-limited request,
which DynamoDB keeps off the micro instance today.

**Blobs** (replaces S3 for payloads). Files on the worker's disk if there is one host, otherwise an
object store. The `site` bucket stays wherever CloudFront (or its successor) serves from.

**Notifications** (replaces SNS). SNS only carries the alarm emails and the SMS delivery events.
The app already routes its own notifications (`packages/core/src/notify.ts`, the bell, alerts
worded from `@app/shared/alerts`) over email, SMS and WhatsApp. CloudWatch alarms can publish only
to SNS, so the alarm topic stays as long as the alarms do.

**Monitoring** (reduces CloudWatch). The alarms watch RDS, NAT, Lambda and queue metrics that only
CloudWatch has, at US$1.01 a month above the free ten. An in-app status page for the owner (job
backlog, failed jobs, recent errors from the database) is worth building for its own sake, but it
would read the same metrics, not replace them.

**Workflows** (Step Functions). Nothing to replace: none exist. Multi-step work (bulk order
backfill, SMS and email automations, WhatsApp campaigns) runs as jobs that re-enqueue their next
step, with their state in their own tables.

## The part that costs money: somewhere to run it

Everything above needs a process that is always running. On Lambda nothing runs between events,
which is why SQS and EventBridge cost nothing here. Where that process would live decides the cost:

| Host | Cost | Notes |
| --- | --- | --- |
| A t4g.nano in this VPC | ~8.24 a month measured (instance, disk, IPv4) | More than the 2.73 it would replace |
| Fargate beside the WhatsApp service | ~8.64 for 0.25 vCPU + 0.5 GB at list price | Same problem |
| The iKorex server (103.146.112.176) | Not AWS money | Its guide says the `deployer` account runs live websites, n8n and a CCTV tunnel, and asks to check with its owner before changing anything. Not ours to plan on without that conversation |
| A new VPS outside AWS | A few dollars a month | Moves the app off managed infrastructure: a full re-platform (below) |

## Leaving AWS altogether

The one route that cuts the bill to near zero is moving compute **and the database** to servers the
business runs. The code is ready for the compute half (the adapters above). The cost is the
operations: patching, PostgreSQL backups and point-in-time restore, failover, TLS, DDoS protection,
monitoring, and a second machine for high availability. The old deployment's database on a PC went
down when Docker Desktop stopped (aws-architecture.md); that is the risk to price in. Cognito's 72
users would all have to reset their passwords, because Cognito does not export them. This is a
project of its own and an owner's decision, not a cost tweak.

## When to build the internal queue and scheduler

Any of these makes it worth it:

- The app moves off Lambda (a VPS, containers, the re-platform above).
- Lambda or SQS leave the free tiers for good (today: ~32 % of Lambda's free compute and ~35 % of
  its free requests; SQS a few cents).
- A feature needs something SQS can't do well, such as job priorities across tenants or a job
  history the owner can browse.

Until then the AWS adapters stay, and the money is saved where the cost audit shows it is.
