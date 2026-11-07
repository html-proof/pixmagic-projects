# Moving bizinsights from AWS to the iKorex server

The owner's brief of 2026-11-06: run bizinsights on the existing iKorex server (103.146.112.176)
instead of AWS, keeping every feature, record and integration, without disturbing the websites, n8n
and the CCTV tunnel already on that server.

**Status (2026-11-07):** discovery done on the AWS side (#347). **Stage A done and live on AWS**
(#348, release 167): the self-hosted runtime and the server's files, built and tested on this PC
([MIGRATION_TEST_REPORT.md](MIGRATION_TEST_REPORT.md)). **The owner's decisions are made**
([the list](IKOREX_INFRASTRUCTURE_ARCHITECTURE.md#decisions-2026-11-07)): Cognito and SMS stay on AWS,
backups to R2, one server accepted, the cutover on a Sunday 20:00-21:00 Melbourne time, no logs
profile. **The database copy and the security audit are built** (2026-11-07): the copy is tested
against PostgreSQL with the real schema, and six security findings in the server's files are fixed
with tests. **The deploy workflow is built and off** (Deploy to iKorex, 2026-11-07): it deploys
`main` to staging, and from the cutover to production, once the deploy key is agreed with the
administrator and set up. The server is not inspected yet: this PC's SSH key (with its passphrase now) waits for
the administrator. Nothing has changed on the server, and AWS keeps running everything (its only
changes: four empty tables the runtime uses, and the admin host may write dumps under one bucket
prefix).

## The pages

| Brief's deliverable | Page | State |
| --- | --- | --- |
| 1. AWS inventory | [AWS_INVENTORY.md](AWS_INVENTORY.md) | Done (from the read-only sweep of 2026-11-06) |
| 2. Migration matrix | [AWS_TO_IKOREX_MIGRATION_MATRIX.md](AWS_TO_IKOREX_MIGRATION_MATRIX.md) | Done: stages A-F, service by service, cutover steps |
| 3. Infrastructure architecture | [IKOREX_INFRASTRUCTURE_ARCHITECTURE.md](IKOREX_INFRASTRUCTURE_ARCHITECTURE.md) | Built (stage A); not deployed |
| 4. Server capacity | [SERVER_CAPACITY_REPORT.md](SERVER_CAPACITY_REPORT.md) | Demand measured; server side waits for SSH access. Script: [inspect-server.sh](inspect-server.sh) |
| 5. Database migration report | [DATABASE_MIGRATION_REPORT.md](DATABASE_MIGRATION_REPORT.md) | Method built and tested on the PC (`copy-db.mjs`, `copy-db.sh`); the rehearsal (stage B) and the real copy (stage D) are recorded there when they run |
| 6. Security audit | [SECURITY_AUDIT.md](SECURITY_AUDIT.md) | The files audited, six findings fixed with tests; eight questions only the server or its administrator can answer |
| 7. Migration test report | [MIGRATION_TEST_REPORT.md](MIGRATION_TEST_REPORT.md) | Stage A's runs; the 22 acceptance criteria and where each stands |
| 8. Cost comparison | [AWS_COST_COMPARISON.md](AWS_COST_COMPARISON.md) | Estimate; the real figure comes from the bill after cutover |
| 9. Rollback plan | [ROLLBACK_PLAN.md](ROLLBACK_PLAN.md) | Done |
| 10. Production deployment guide | [PRODUCTION_DEPLOYMENT_GUIDE.md](PRODUCTION_DEPLOYMENT_GUIDE.md) | Setup, deploy, everyday commands, rollback, restore; not yet run on the server |

The earlier cost audit of the same day, which this builds on, is in
[../aws-migration/](../aws-migration/AWS_MIGRATION_PLAN.md). Its conclusion still holds for staying
on AWS: rebuilding SQS/SNS/EventBridge inside AWS saves nothing. Leaving AWS is different: then the
database, the WhatsApp service, the WAF and the NAT instances go too, and those are the bill.

## In one paragraph

The code was already built for this: no AWS SDK, and every AWS service behind an interface
(`Queues`, `Coord`, `BlobStore`, `Mailer`, `SmsProvider`); stage A added the self-hosted
implementations (`apps/aws/src/selfhost.ts` and its parts, `infra/ikorex/`). On iKorex, bizinsights is one Docker
Compose project with no open port: Cloudflare (already in front) reaches it through a Cloudflare
Tunnel; PostgreSQL 17 replaces RDS with continuous encrypted backups off the server, and also holds
the job queue, the schedules and the coordinator (SQS, EventBridge and DynamoDB); Prometheus, Grafana, Loki
and an external uptime check replace CloudWatch. Resend keeps sending email; Cognito is best kept
(free, and it can't export passwords). The AWS bill would fall from ~US$136 to ~US$2 a month before
GST, at the price of one server instead of a failover database, and of running it ourselves.

## Waiting on

1. **SSH access**: the administrator adding this PC's key (guide steps 2-4), and their agreement to
   host bizinsights there. Then the read-only inspection, which also answers the audit's open
   questions (who is in the `docker` group, what runs as `deployer`, disk encryption).
2. The capacity test's result (go / tight / no go).
3. Before stage D: the reverse copy (iKorex back to RDS) for the rollback period, driven and timed
   like the forward one.
