# Insights for Shopify

A multi-tenant SaaS that gives Shopify merchants plain-language analytics. Merchants sign up or log in with Google, Apple, or an email and password (Firebase Auth; an emailed one-time code also works), then connect their store from inside the app (**Settings → Shopify**, or the first-run connect page) through Shopify's own OAuth screen. Insights imports orders, products and inventory into the dashboard (public, unlisted app, authorization-code grant, permanent offline tokens kept encrypted on the server; see [docs/shopify-setup.md](docs/shopify-setup.md)).

Runs on **Cloudflare Workers**: one Worker serves the UI (static assets), the API (`/api/*`), Queue consumers and Cron Triggers, with Postgres via Hyperdrive.

```
apps/cloudflare Worker entry + wrangler.jsonc: routing, Queue/Cron handlers, Coordinator Durable Object
apps/web       Next.js 16 (App Router) UI, statically exported and served by the Worker
apps/api       Hono API: sessions, email OTP, Shopify OAuth, webhooks, pixel ingest, dashboard, settings
apps/worker    Queue consumers: initial sync, webhook processing, daily aggregates, reconcile, token rotation, alerts
packages/db    Prisma 7 schema + migrations (incl. Postgres RLS), request-scoped clients, tenant helpers
packages/core  Shopify client, token encryption/rotation, queue contracts, normalizers, persistence, alerts
packages/shared Pure logic: HMAC, AES-GCM, OTP, capability registry, KPI formulas, dates, roles
shopify-app    shopify.app.toml (scopes, webhooks) + web pixel extension
infra          docker-compose dependencies, Postgres role init (Terraform/Dockerfile: legacy GCP setup)
docs           Setup guides, KPI definitions, runbook
```

## Quick start

```bash
docker compose up -d postgres mailpit firebase-emulator
```

```bash
pnpm install && cp .env.example .env && cp apps/cloudflare/.dev.vars.example apps/cloudflare/.dev.vars
```

Then follow [docs/local-dev.md](docs/local-dev.md). Progress and verification history: [IMPLEMENTATION_STATUS.md](IMPLEMENTATION_STATUS.md).

## Docs

| Topic | File |
| --- | --- |
| Local development | [docs/local-dev.md](docs/local-dev.md) |
| Firebase setup (Google, Apple, email, OTP) | [docs/firebase-setup.md](docs/firebase-setup.md) |
| Shopify app configuration | [docs/shopify-setup.md](docs/shopify-setup.md) |
| Single test store, no publishing | [docs/test-store.md](docs/test-store.md) |
| Webhooks | [docs/webhooks.md](docs/webhooks.md) |
| WhatsApp (Cloud API): setup, flows, data | [docs/whatsapp.md](docs/whatsapp.md) |
| KPI formulas | [docs/kpis.md](docs/kpis.md) |
| Security model | [docs/security.md](docs/security.md) |
| Deployment (Cloudflare) | [docs/deployment-cloudflare.md](docs/deployment-cloudflare.md) |
| Deployment (legacy GCP) | [docs/deployment.md](docs/deployment.md) |
| Runbook | [docs/RUNBOOK.md](docs/RUNBOOK.md) |
