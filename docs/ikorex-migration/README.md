# Moving bizinsights from AWS to the iKorex server

The owner's brief of 2026-11-06: run bizinsights on the existing iKorex server (103.146.112.176)
instead of AWS, keeping every feature, record and integration, without disturbing the websites, n8n
and the CCTV tunnel already on that server.

**Status (2026-11-07):** discovery done on the AWS side (#347). **Stage A done and live on AWS**
(#348, release 167): the self-hosted runtime and the server's files, built and tested on this PC
([MIGRATION_TEST_REPORT.md](MIGRATION_TEST_REPORT.md)). **The owner's decisions are made**
([the list](IKOREX_INFRASTRUCTURE_ARCHITECTURE.md#decisions-2026-11-07)): Cognito and SMS stay on AWS,
backups to R2, one server accepted, the cutover on a Sunday 20:00-21:00 Melbourne time, no logs
profile. The server is not inspected yet: this PC's SSH key waits for the administrator. Nothing has
changed on the server, and AWS keeps running everything (its only change: four empty tables the
runtime uses).

## The pages

| Brief's deliverable | Page | State |
| --- | --- | --- |
| 1. AWS inventory | [AWS_INVENTORY.md](AWS_INVENTORY.md) | Done (from the read-only sweep of 2026-11-06) |
| 2. Migration matrix | [AWS_TO_IKOREX_MIGRATION_MATRIX.md](AWS_TO_IKOREX_MIGRATION_MATRIX.md) | Done: stages A-F, service by service, cutover steps |
| 3. Infrastructure architecture | [IKOREX_INFRASTRUCTURE_ARCHITECTURE.md](IKOREX_INFRASTRUCTURE_ARCHITECTURE.md) | Built (stage A); not deployed |
| 4. Server capacity | [SERVER_CAPACITY_REPORT.md](SERVER_CAPACITY_REPORT.md) | Demand measured; server side waits for SSH access. Script: [inspect-server.sh](inspect-server.sh) |
| 5. Database migration report | `DATABASE_MIGRATION_REPORT.md` | Written when the database is copied (stages B and D) |
| 6. Security audit | `SECURITY_AUDIT.md` | Written after the server inspection |
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

1. **SSH access**: a key for this PC, added by the server's administrator (guide steps 2-4), and
   their agreement to host bizinsights there.
2. The capacity test's result (go / tight / no go).
