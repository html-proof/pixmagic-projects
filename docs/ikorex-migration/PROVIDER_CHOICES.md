# The brief's suggested providers, and what the move uses

The owner's brief of 2026-11-08 ("complete AWS infrastructure migration") proposes a replacement
for each AWS service: Hetzner or DigitalOcean, Supabase or Neon, Upstash Redis with BullMQ, Better
Auth, Infisical, Better Stack, GitHub's container registry, and others. It also says not to follow
that list blindly: choose by the app's real needs, price, availability, security and scale, and add
no paid service or overlapping system that isn't needed.

The move to the iKorex server had already made those choices (the 2026-11-06 brief, the owner's
decisions of 2026-11-07 in
[IKOREX_INFRASTRUCTURE_ARCHITECTURE.md](IKOREX_INFRASTRUCTURE_ARCHITECTURE.md#decisions-2026-11-07)).
This page puts the two side by side, so a later brief doesn't start the work again. The last column
says when the brief's suggestion becomes the better choice. The user counts refer to
[AWS_COST_COMPARISON.md](AWS_COST_COMPARISON.md#at-scale-1000-to-1000000-users).

| AWS today | Brief suggests | The move uses | Why | Brief's choice becomes right |
| --- | --- | --- | --- | --- |
| Lambda, Fargate, EC2 (hosting) | Hetzner Cloud or DigitalOcean, Docker | **The iKorex server**, Docker Compose | No new bill if the capacity test passes. Hetzner has no Australian location (its nearest is Singapore, cloud servers only), and the merchants are Australian | The capacity test says "no go", or past ~1,000 users: a server of its own in Sydney or Melbourne (DigitalOcean, Vultr, BinaryLane), same Compose files |
| Function URL behind CloudFront (no API Gateway) | Cloudflare or the app's routing | **Cloudflare Tunnel** to the `web` container; the app routes `/api` itself | Cloudflare is already in front; the tunnel means no open port on the server | — |
| Cognito | Better Auth or Supabase Auth | **The app's own sign-in** (#353), live as `AUTH_MODE=migrating` since release 173 | Cognito never exports password hashes, so any replacement moves users one at a time, at their next sign-in. The app's own keeps each user's id (Cognito's `sub`), sessions, roles, email codes, two-step verification and Google sign-in. Better Auth (a library) would bring its own user and session tables to reconcile with the existing ones, a second migration. Supabase Auth is another hosted service holding the users | If the app ever needs passkeys or company single sign-on (SAML) ready-made |
| S3 | Cloudflare R2 | `payloads` → **a volume** (kept 7 days); `site` → **served by the app**; backups → **R2** | S3 keeps no customer files for good: webhook bodies and WhatsApp media waiting for their job (7 days), the built pages, and database exports. Only backups need object storage | If the app ever keeps customer files (`BlobStore` already hides the store) |
| CloudFront, WAF | Cloudflare CDN | **Cloudflare** (already in front), its free managed rules and a rate-limit rule | — | Cloudflare Pro or Business for more WAF rules, at ~100,000 users |
| RDS PostgreSQL | Supabase or Neon | **PostgreSQL 17 in a container** on the server, continuous backups to R2 (at most 5 minutes of writes lost) | 1.8 GB of data. A hosted database adds a monthly bill and a network hop on every query (a dashboard makes dozens). Supabase and Neon both run their databases on AWS (Neon on Azure too), which the brief also wants to leave | ~10,000 users: a managed PostgreSQL with a standby, in the same city as the app servers |
| DynamoDB (`coord`) | PostgreSQL | **PostgreSQL**, table `coord_entries` (`pgCoord.ts`) | 12 items: rate limits, sign-in state, locks | — |
| ElastiCache | Upstash Redis | **Nothing** (there was none) | The coordinator is in PostgreSQL; a Redis for a dozen keys would be a service and a network hop more. Upstash also runs on AWS and Google Cloud | ~100,000 users, if rate-limit writes start to load PostgreSQL: a Redis next to the app servers |
| SQS (5 queues and a dead-letter queue; 6 until the SMS events queue went on 2026-11-13) | BullMQ on Redis | **A PostgreSQL queue** (`pgQueues.ts`): delays, receive counts, holds, dead-letter after 10 deliveries, as SQS did | No Redis to run, back up and keep durable (BullMQ loses jobs on a Redis without persistence); a job and the data it is about live in one database, backed up together | Past ~100 jobs a second all day (~100,000 users): a queue of its own |
| SNS | An internal event bus and webhooks | **Alertmanager** for alarms | SNS only carried alarms (and SMS delivery events, until Customer Messaging (SMS) was removed on 2026-11-13) | — |
| SES | Resend or Brevo | **Resend**, which already sends every email; SES was an unused fallback | — | — |
| EventBridge Scheduler | BullMQ's scheduled jobs | **Schedules in the worker** (`schedules.ts`): cron with time zones, each tick run once across workers, catch-up after a gap | Same reason as the queue | With the queue |
| Step Functions | Internal workflows | **Nothing** (there were none) | — | — |
| CloudWatch | Grafana Cloud or Better Stack | **Prometheus, Alertmanager and Grafana** on the server (15 alert rules), and an **external uptime check** | Free. The external check covers what a monitor on the same server can't: the server being down | If the capacity test says "tight": Grafana Cloud's free tier instead of Grafana on the server |
| Secrets Manager, SSM | Infisical | **`env/*.env` files** on the server (mode 600, one per container), copies of the passwords in the owner's password manager | One server and one deploy key: another service holding every secret would be one more thing to secure | Several servers (~10,000 users): a secrets manager, Infisical self-hosted or encrypted files in the repository |
| Route 53 (one private zone) | Cloudflare DNS | **Cloudflare DNS** already serves `bizinsights.io`; the private zone goes with the WhatsApp service | — | — |
| ECR | GitHub's container registry | **No registry**: `ship.sh` sends the built bundle and the image is built on the server | One server; nothing else pulls the image | Several servers pulling the same image |
| ECS (WhatsApp service) | Docker on Hetzner | **The `evolution` container** in the same Compose project | — | — |
| AWS Backup, RDS snapshots | Automated backups | **pgBackRest to R2**, encrypted, with a weekly restore test (stage C) | — | — |
| End User Messaging SMS (not in the brief's list) | — | **Nothing**: Customer Messaging (SMS) was removed on 2026-11-13. Twilio (#354) was built and never switched on | — | — |

The brief's Apple sign-in ("if currently implemented") isn't: it was removed in #21.

## The brief's phases, and the stages

| Brief's phase | Stage | Where it stands |
| --- | --- | --- |
| 1. Infrastructure audit | — | Done: [AWS_INVENTORY.md](AWS_INVENTORY.md), and the repository scan [AWS_DEPENDENCY_SCAN.md](AWS_DEPENDENCY_SCAN.md) |
| 2. Provision the new infrastructure | B | Waits for SSH access to the server |
| 3. Provider-independent adapters | A | Done, live on AWS (release 167 on) |
| 4. Database schema and data | B (rehearsal), D (real) | Built and tested on the PC (`copy-db.mjs`; the copy back in PR #356) |
| 5. S3 objects to R2 | — | Nothing to move: no customer files in S3 |
| 6. Authentication and sessions | Before D | Live: `AUTH_MODE=migrating` (release 173); Google sign-in waits for the owner's redirect address |
| 7. Notifications | Before D | Email: Resend already. SMS: none, Customer Messaging (SMS) was removed on 2026-11-13 |
| 8. Queues, schedules, workers | A | Done |
| 9. API endpoints and configuration | B | Waits for the server |
| 10. Functional and security testing | B, C | [SECURITY_AUDIT.md](SECURITY_AUDIT.md) done on the files; the server's part waits |
| 11. Production traffic switch | D | A Sunday, 20:00-21:00 Melbourne |
| 12. Monitor and verify | E | 14 days, AWS kept with schedules off |
| 13. Decommission AWS | F | Then the account closed by the owner |

Its 14 acceptance criteria fall within the 22 tracked in
[MIGRATION_TEST_REPORT.md](MIGRATION_TEST_REPORT.md). The one the earlier brief didn't have as a
check, "no executable AWS dependency remains", is `node scripts/aws-dependency-scan.mjs --none-left`.
