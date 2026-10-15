# bizinsights for Shopify

A multi-tenant SaaS that gives Shopify merchants plain-language analytics. Merchants sign up or log in with Google or an email and password (Amazon Cognito; existing Firebase accounts move over at their first sign-in), then connect their store from inside the app (**Settings → Shopify**, or the first-run connect page) through Shopify's own OAuth screen. bizinsights imports orders, products and inventory into the dashboard (public, unlisted app, authorization-code grant, permanent offline tokens kept encrypted on the server; see [docs/shopify-setup.md](docs/shopify-setup.md)).

Runs on **AWS** (https://d2mr8m2p1qkh58.cloudfront.net): CloudFront and WAF in front of one Lambda package deployed as three functions (the UI and the API, the queue jobs, the schedules), with RDS PostgreSQL, SQS, DynamoDB, S3 and SES. Every merge to `main` deploys it. Locally the same code runs as one Node process.

```
apps/aws       The host: Lambda entry, AWS adapters (SQS, DynamoDB, S3, SES), app settings, and the local server
apps/web       Next.js 16 (App Router) UI, statically exported and served beside the API
apps/api       Hono API: sessions, email OTP, Shopify OAuth, webhooks, pixel ingest, dashboard, settings
apps/worker    Queue consumers: initial sync, webhook processing, daily aggregates, reconcile, token rotation, alerts; ops/ maintenance tasks
packages/db    Prisma 7 schema + migrations (incl. Postgres RLS), shared clients, tenant helpers
packages/core  Shopify client, token encryption/rotation, queue contracts, normalizers, persistence, alerts
packages/shared Pure logic: HMAC, AES-GCM, OTP, capability registry, KPI formulas, dates, roles
shopify-app    shopify.app.toml (scopes, webhooks) + web pixel extension
infra          AWS infrastructure (cdk/), the Cognito stack (aws/), Postgres role init (postgres/), the local Cognito emulator (cognito-local/)
docs           Setup guides, KPI definitions, runbook
```

## Quick start

```bash
docker compose up -d postgres mailpit cognito
```

```bash
pnpm install && cp .env.example .env && cp apps/aws/.env.example apps/aws/.env && cp apps/web/.env.example apps/web/.env.local
```

Then follow [docs/local-dev.md](docs/local-dev.md). Progress and verification history: [IMPLEMENTATION_STATUS.md](IMPLEMENTATION_STATUS.md).

## Docs

| Topic | File |
| --- | --- |
| Architecture, where code goes, conventions | [docs/architecture.md](docs/architecture.md) |
| Local development | [docs/local-dev.md](docs/local-dev.md) |
| Sign-in setup (Cognito: email, Google; the Firebase move) | [docs/cognito-setup.md](docs/cognito-setup.md) |
| Shopify app configuration | [docs/shopify-setup.md](docs/shopify-setup.md) |
| Single test store, no publishing | [docs/test-store.md](docs/test-store.md) |
| Webhooks | [docs/webhooks.md](docs/webhooks.md) |
| WhatsApp (Cloud API): setup, flows, data | [docs/whatsapp.md](docs/whatsapp.md) |
| Staff Management, attendance and payroll | [docs/staff.md](docs/staff.md) |
| Email integrations and automation (Gmail, Microsoft 365, SMTP) | [docs/email.md](docs/email.md) · API: [docs/email-api.yaml](docs/email-api.yaml) |
| KPI formulas | [docs/kpis.md](docs/kpis.md) |
| Security model | [docs/security.md](docs/security.md) |
| Deployment (AWS: every merge to `main`) | [docs/aws-deployment.md](docs/aws-deployment.md) |
| The old Cloudflare deployment (still live until retired) | [docs/aws-deployment.md](docs/aws-deployment.md#retiring-the-old-cloudflare-deployment) |
| Runbook | [docs/RUNBOOK.md](docs/RUNBOOK.md) |
| Every doc by question (start here) | [docs/README.md](docs/README.md) |
| Adding a feature, endpoint, table, job or integration | [docs/development/adding-a-feature.md](docs/development/adding-a-feature.md) |
| API: every endpoint, auth, errors, request ids | [docs/api/api-overview.md](docs/api/api-overview.md) |
| Database schema and migrations | [docs/database/schema.md](docs/database/schema.md), [docs/database/migrations.md](docs/database/migrations.md) |
| Architecture audit, decisions, restructuring report | [docs/architecture/](docs/architecture/) |
| Ad accounts (Meta Ads, Google Ads, AdSense), review packs | [docs/ads-setup.md](docs/ads-setup.md), [docs/ads-review-packs.md](docs/ads-review-packs.md) |
| Security audit, 2026-10-10 | [docs/security-audit-2026-10-10.md](docs/security-audit-2026-10-10.md) |
