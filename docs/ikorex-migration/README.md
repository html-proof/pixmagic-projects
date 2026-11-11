# Moving bizinsights from AWS to the iKorex server

The owner's brief of 2026-11-06: run bizinsights on the existing iKorex server (103.146.112.176)
instead of AWS, keeping every feature, record and integration, without disturbing the websites, n8n
and the CCTV tunnel already on that server.

**Status (2026-11-08):** discovery done on the AWS side (#347). **Stage A done and live on AWS**
(#348, release 167): the self-hosted runtime and the server's files, built and tested on this PC
([MIGRATION_TEST_REPORT.md](MIGRATION_TEST_REPORT.md)). **The owner's decisions are made**
([the list](IKOREX_INFRASTRUCTURE_ARCHITECTURE.md#decisions-2026-11-07)), and revised the same evening:
**leave AWS completely and close the account** after the 14-day rollback period, so Cognito and AWS's
SMS are replaced too; backups to R2, one server accepted, the cutover on a Sunday 20:00-21:00
Melbourne time, no logs profile. Since then, each live on AWS through Deploy to AWS:

- **The database copy and the security audit** (#350, #352, release 169).
- **The deploy workflow**, built and off (Deploy to iKorex, #351, release 171): it deploys `main` to
  staging, and from the cutover to production, once the deploy key is agreed with the administrator.
- **The app's own sign-in** (#353, release 171), replacing Cognito. Switched to `migrating` in
  production after it: each user moves over at their next password sign-in. Google moves once the
  owner adds the app's redirect address to the Google client.
- **Texts through Twilio** (#354, release 172), replacing AWS End User Messaging: built and off until
  the owner's Twilio account is ready ([docs/sms.md](../sms.md), "Switching to Twilio").
- **The copy back for a rollback** (2026-11-08): `copy-db-back.mjs` copies the server's databases
  back into RDS and proves them whole ([ROLLBACK_PLAN.md](ROLLBACK_PLAN.md#the-copy-back-de-after-writes-on-ikorex)),
  tested against PostgreSQL; with it, `AWS_WHATSAPP=off`, which keeps AWS's WhatsApp service from
  starting again against the server's through the rollback period.

The server is not inspected yet: this PC's SSH key (with its passphrase now) waits for the
administrator. Nothing has changed on the server, and AWS keeps running everything.

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
| 2026-11-08 brief: what still uses AWS | [AWS_DEPENDENCY_SCAN.md](AWS_DEPENDENCY_SCAN.md) | 90 files, each with the step that removes it; `scripts/aws-dependency-scan.mjs` keeps new AWS code out (`pnpm lint`) and is stage F's check |
| 2026-11-08 brief: its suggested providers | [PROVIDER_CHOICES.md](PROVIDER_CHOICES.md) | Hetzner, Supabase, Upstash, BullMQ, Better Auth… against what the move uses, and when each would become right; costs at 1,000 to 1,000,000 users in [AWS_COST_COMPARISON.md](AWS_COST_COMPARISON.md#at-scale-1000-to-1000000-users) |

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
and an external uptime check replace CloudWatch. Resend keeps sending email; the app's own sign-in
replaces Cognito (each user's password is checked by Cognito once, since Cognito can't export them)
and Twilio replaces AWS's SMS. The AWS bill falls from ~US$136 a month before GST to nothing once
the account closes, at the price of one server instead of a failover database, and of running it
ourselves.

## The 2026-11-11 brief

A fourth brief names an open-source component for each job (Traefik, Keycloak, Valkey, NATS,
RabbitMQ, Garage, Postal, OpenBao, Restic). [OPEN_SOURCE_STACK.md](OPEN_SOURCE_STACK.md) sets that
list beside what is built, with where each of its sections, tests and thirteen files stands;
[ENVIRONMENT_VARIABLES_MIGRATION.md](ENVIRONMENT_VARIABLES_MIGRATION.md) is the one page it asks for
that didn't exist.

## Waiting on

1. **SSH access**: the administrator adding this PC's key (guide steps 2-4), and their agreement to
   host bizinsights there. Then the read-only inspection, which also answers the audit's open
   questions (who is in the `docker` group, what runs as `deployer`, disk encryption).
2. The capacity test's result (go / tight / no go).
3. Stage B's timed round trip of the database copy, out and back (`copy-db.mjs --rehearsal --keep`,
   then `copy-db-back.mjs --rehearsal`): both built and tested on the PC, neither yet run against
   RDS and the server.
4. The owner: Google's redirect address for the app's own sign-in
   ([docs/cognito-setup.md](../cognito-setup.md#9-leaving-cognito-the-apps-own-sign-in)), and the
   Twilio account ([docs/sms.md](../sms.md), "Switching to Twilio"). Each then ships as a one-line
   settings change.
5. Stage F, after the rollback period: the checks in [ROLLBACK_PLAN.md](ROLLBACK_PLAN.md) ("Before
   stage F starts"), then the deletions and the owner closing the account.
