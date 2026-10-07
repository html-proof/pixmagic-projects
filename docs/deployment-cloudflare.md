# Deployment (Cloudflare Workers)

Everything runs as **one Worker** (`apps/cloudflare`, name `insights`):

| Piece | Cloudflare product | Replaces |
| --- | --- | --- |
| Web UI (static Next.js export, `apps/web/out`) | Workers Static Assets | Cloud Run `insights-web` |
| API under `/api/*` (Hono, `apps/api`) | Worker `fetch` handler | Fastify on Cloud Run |
| Shopify webhooks, pixel ingest, OAuth | same Worker; also served un-prefixed at `/webhooks/*`, `/pixel/*`, `/shopify/*` | `api.example.com` |
| Sync / webhook / aggregate jobs (`apps/worker`) | Cloudflare Queues consumers | BullMQ workers |
| Daily reconcile, token refresh | Cron Triggers | BullMQ job schedulers |
| Rate limits, OAuth state, refresh locks | Durable Object `Coordinator` + Rate Limiting binding | Redis |
| Postgres access | Hyperdrive (two configs: owner `app`, RLS `app_rls`) | direct connections |
| Large webhook payloads | R2 bucket | Redis (BullMQ payloads) |
| Email (OTP codes, invites, alerts) | Email Sending (`send_email` binding) | SMTP / nodemailer |
| Firebase Admin | Identity Toolkit REST + `jose` | `firebase-admin` |

Postgres stays where it is (your provider). Redis is no longer used.

Requirements: a **Workers Paid** plan (Queues, Durable Objects, higher CPU limits), a domain on Cloudflare for Email Sending, and a Postgres reachable from the internet with TLS.

## First deploy

All commands run from `apps/cloudflare`.

1. **Log in:** `npx wrangler login` (or set `CLOUDFLARE_API_TOKEN`).
2. **Database roles:** create users `app` (owner, used for migrations, system paths and jobs) and `app_rls` (strong password). Run migrations and grants from the repo root with `DATABASE_URL` pointing at the owner role:

```bash
pnpm db:migrate
```

```bash
pnpm --filter @app/db exec prisma db execute --file ../../infra/postgres/init.sql
```

   Change the `app_rls` password from the dev default.

3. **Hyperdrive** (one per role, query caching off: the app reads its own writes immediately), then paste each id into `wrangler.jsonc`:

```bash
npx wrangler hyperdrive create insights-db --caching-disabled --connection-string="postgresql://app:<pw>@<host>:5432/app?sslmode=require"
```

```bash
npx wrangler hyperdrive create insights-db-rls --caching-disabled --connection-string="postgresql://app_rls:<pw>@<host>:5432/app?sslmode=require"
```

   **Alternative: the Docker Postgres on your own machine** (no domain needed; the API is down whenever that machine or Docker is off). Hyperdrive reaches it through a Cloudflare Tunnel + Workers VPC service:

   - `npx wrangler tunnel create insights-db`, then put its run token in `.env` as `CLOUDFLARE_TUNNEL_TOKEN` (API: `GET /accounts/<id>/cfd_tunnel/<tunnel-id>/token`).
   - Hyperdrive requires TLS: generate `infra/postgres/certs/server.{crt,key}` (`openssl req -new -x509 -days 3650 -nodes -newkey rsa:2048 -subj "/CN=postgres" -keyout server.key -out server.crt`), then `docker compose up -d postgres` and `docker compose --profile tunnel up -d cloudflared`.
   - `npx wrangler vpc service create insights-postgres --type tcp --tcp-port 5432 --app-protocol postgresql --tunnel-id <tunnel-id> --hostname postgres --resolver-ips 127.0.0.11 --cert-verification-mode disabled` (self-signed cert; the hop is inside the tunnel).
   - `npx wrangler hyperdrive create insights-db --caching-disabled --service-id <vpc-service-id> --database app --user app --password <pw>`, and the same for `insights-db-rls` with `app_rls`.

4. **Queues and bucket:**

```bash
npx wrangler queues create insights-sync
```

```bash
npx wrangler queues create insights-webhooks
```

```bash
npx wrangler queues create insights-aggregate
```

```bash
npx wrangler queues create insights-dlq
```

```bash
npx wrangler r2 bucket create insights-webhook-payloads
```

   Optional: add an R2 lifecycle rule deleting `webhooks/` objects after 7 days (processed payloads are deleted immediately; this only catches abandoned ones).

5. **Email Sending:** onboard the domain used in `EMAIL_FROM`:

```bash
npx wrangler email sending enable example.com
```

6. **Config:** edit `vars` in `wrangler.jsonc` (`APP_URL`, `API_URL` = `APP_URL` + `/api`, `FIREBASE_PROJECT_ID`, `SHOPIFY_API_KEY`, `EMAIL_FROM`) and uncomment `routes` for your custom domain.
7. **Secrets** (each prompts for the value):

```bash
npx wrangler secret put SESSION_SECRET
```

   Repeat for `TOKEN_ENCRYPTION_KEYS` (`1:<openssl rand -base64 32>`), `OTP_PEPPER`, `SHOPIFY_API_SECRET`, `FIREBASE_SERVICE_ACCOUNT_B64` (base64 of the service-account JSON) and, optionally, `ALERT_SLACK_WEBHOOK_URL`.

8. **Web build variables:** `NEXT_PUBLIC_FIREBASE_*` are baked into the static UI at build time. Put them in `apps/web/.env.production` (or export them in CI) before deploying.
9. **Deploy** (builds the static UI, then uploads Worker + assets):

```bash
pnpm --filter @app/cloudflare run deploy
```

10. **Shopify:** in `shopify-app/shopify.app.toml` replace `app.example.com` with your domain (launch URL `/api/shopify/launch`, redirect `/api/shopify/callback`, webhooks `/api/webhooks/shopify`), then `shopify app deploy`.
11. **Firebase:** add your domain to Authentication > Settings > Authorized domains.

### Email

Sign-in codes, invitations and alerts are sent with Cloudflare Email Sending from `EMAIL_FROM`, which must be on a domain onboarded to your Cloudflare account. Until one is set up, "Email me a code" automatically falls back to a one-click sign-in link that Firebase emails from its own address (needs `FIREBASE_WEB_API_KEY`, the public web API key, in `vars`, and the Email link sign-in method enabled in Firebase, which it is by default with Email/Password).

### Deploying while `wrangler dev` is running

`wrangler dev` watches `apps/web/out`, which Windows then refuses to delete during `next build`. `pnpm --filter @app/cloudflare run deploy` (`apps/cloudflare/scripts/deploy.mjs`) therefore always builds into `apps/web/out-deploy` and deploys exactly that folder with `--assets`; by hand it is:

```bash
NEXT_EXPORT_DIR=out-deploy pnpm --filter @app/web build
```

```bash
cd apps/cloudflare && npx wrangler deploy --assets ../web/out-deploy
```

## Subsequent releases

1. CI green.
2. Run migrations first (`pnpm db:migrate` against the owner role). Keep them backward compatible with the running release (expand, then contract).
3. `pnpm --filter @app/cloudflare run deploy`. Workers switches versions atomically.
4. Rollback: `npx wrangler rollback` (pick the previous version). Do not roll back migrations; ship a forward fix.

## Operations

- **Logs and traces:** Workers Logs and Traces are enabled in `wrangler.jsonc` (`observability`). Live tail: `npx wrangler tail`.
- **Failed jobs:** after 6 attempts (backoff 5s, 10s, 20s, 40s, 80s) a job is marked `failed` in `sync_jobs` / `webhook_events`, an alert is raised, and the message is acked. A failure while Postgres is unreachable (a `SELECT 1` probe fails or takes over 3s) spends none of those attempts: the consumer re-sends the job as a new message, backing off from 30s to every 5 minutes, for up to 24 hours, and only then lets it run out of retries into `insights-dlq`. A final failure that cannot be recorded is retried rather than acked, so it also lands in `insights-dlq`, as do messages that crash the consumer outright. Nothing consumes `insights-dlq` yet: check it after a long outage.
- **Concurrency:** sync 4, webhooks 10, aggregate 4 concurrent consumers (`queues.consumers` in `wrangler.jsonc`). Shopify limits are per shop and the GraphQL client paces itself on query cost.
- **Large backfills:** orders/products sync processes one Shopify page per queue message and re-enqueues the next cursor, so no single invocation runs long.
- **Readiness:** `GET /api/readyz` checks Postgres (through Hyperdrive) and the Durable Object.

## Troubleshooting

### Cloudflare error 1102, "Worker exceeded resource limits"

The browser gets Cloudflare's 1102 page instead of ours, on any route - `/api/shopify/launch`
after an install is the one merchants notice, because it is the first thing Shopify opens.

It is the CPU limit, not a bug in the route. The **Free plan allows 10 ms of CPU per request**,
and a signed-in request here costs more than that: verifying the Firebase session cookie (RSA)
plus a few Prisma queries measures ~14-17 ms, and a single Prisma query alone is already ~14 ms.
Requests that fit survive; the rest are killed mid-flight, which is why it looks intermittent and
why it bites hardest right after a deploy, when every isolate is cold.

Confirm it before changing anything - the invocation analytics say so outright:

```bash
curl -s -X POST https://api.cloudflare.com/client/v4/graphql   -H "Authorization: Bearer $CF_API_TOKEN" -H "content-type: application/json"   -d '{"query":"query($acct:String!,$from:Time!){viewer{accounts(filter:{accountTag:$acct}){workersInvocationsAdaptive(limit:100,filter:{datetime_geq:$from,scriptName:\"insights\"}){sum{requests}quantiles{cpuTimeP50 cpuTimeP99}dimensions{datetimeMinute status}}}}}","variables":{"acct":"<account id>","from":"2026-10-04T00:00:00Z"}}'
```

A `status: "exceededResources"` row with `cpuTimeP50` at 10000 (microseconds) is the Free-plan
cap being hit. `status: "success"` rows show what normal requests cost.

**Fix:** move the account to **Workers Paid** ($5/month). The per-request CPU limit becomes 30 s,
and `limits.cpu_ms` in `wrangler.jsonc` can be uncommented for the long sync pages. Paid is what
this deployment assumes anyway (Queues and Durable Objects are listed under Requirements above).
Nothing in the app can be trimmed into a 10 ms budget while it uses Prisma on Workers.
