# Moving bizinsights from AWS to the iKorex server

The owner's brief of 2026-11-06: run bizinsights on the existing iKorex server (103.146.112.176)
instead of AWS, keeping every feature, record and integration, without disturbing the websites, n8n
and the CCTV tunnel already on that server.

**Status (2026-11-06): stage 1 (discovery) done on the AWS side; the server is not inspected yet**,
because this PC has no SSH key for it. Nothing has changed on AWS or on the server.

## The pages

| Brief's deliverable | Page | State |
| --- | --- | --- |
| 1. AWS inventory | [AWS_INVENTORY.md](AWS_INVENTORY.md) | Done (from the read-only sweep of 2026-11-06) |
| 2. Migration matrix | [AWS_TO_IKOREX_MIGRATION_MATRIX.md](AWS_TO_IKOREX_MIGRATION_MATRIX.md) | Done: stages A-F, service by service, cutover steps |
| 3. Infrastructure architecture | [IKOREX_INFRASTRUCTURE_ARCHITECTURE.md](IKOREX_INFRASTRUCTURE_ARCHITECTURE.md) | Proposal |
| 4. Server capacity | [SERVER_CAPACITY_REPORT.md](SERVER_CAPACITY_REPORT.md) | Demand measured; server side waits for SSH access. Script: [inspect-server.sh](inspect-server.sh) |
| 5. Database migration report | `DATABASE_MIGRATION_REPORT.md` | Written when the database is copied (stages B and D) |
| 6. Security audit | `SECURITY_AUDIT.md` | Written after the server inspection |
| 7. Migration test report | `MIGRATION_TEST_REPORT.md` | Written from real test runs (stages B-D); nothing is claimed before |
| 8. Cost comparison | [AWS_COST_COMPARISON.md](AWS_COST_COMPARISON.md) | Estimate; the real figure comes from the bill after cutover |
| 9. Rollback plan | [ROLLBACK_PLAN.md](ROLLBACK_PLAN.md) | Done |
| 10. Production deployment guide | `PRODUCTION_DEPLOYMENT_GUIDE.md` | Written with the deploy scripts (stage A) |

The earlier cost audit of the same day, which this builds on, is in
[../aws-migration/](../aws-migration/AWS_MIGRATION_PLAN.md). Its conclusion still holds for staying
on AWS: rebuilding SQS/SNS/EventBridge inside AWS saves nothing. Leaving AWS is different: then the
database, the WhatsApp service, the WAF and the NAT instances go too, and those are the bill.

## In one paragraph

The code is already built for this: no AWS SDK, and every AWS service behind an interface
(`Queues`, `Coord`, `BlobStore`, `Mailer`, `SmsProvider`). On iKorex, bizinsights would be one Docker
Compose project with no open port: Cloudflare (already in front) reaches it through a Cloudflare
Tunnel; PostgreSQL 17 replaces RDS with continuous encrypted backups off the server; a PostgreSQL job
queue (pg-boss) replaces SQS and the schedules; Redis replaces DynamoDB; Prometheus, Grafana, Loki
and an external uptime check replace CloudWatch. Resend keeps sending email; Cognito is best kept
(free, and it can't export passwords). The AWS bill would fall from ~US$136 to ~US$2 a month before
GST, at the price of one server instead of a failover database, and of running it ourselves.

## Waiting on

1. **SSH access**: a key for this PC, added by the server's administrator (guide steps 2-4), and
   their agreement to host bizinsights there.
2. The owner's decisions listed at the end of the architecture page (Cognito, SMS, backup
   destination, single server, cutover window).
3. The capacity test's result (go / tight / no go).
