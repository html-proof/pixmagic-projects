# Dependency map

How the parts of bizinsights depend on each other: packages, runtime paths, external services, and
the high-risk joints. Companion to [current-state.md](current-state.md).

## 1. Package graph

Arrows point from a package to what it imports. Checked from every `package.json` and every import
statement (191 source files): there are **no cycles between packages**.

```
                       ┌──────────────────┐
                       │     apps/aws     │  the one deployable (Lambda entry, local server)
                       └──┬───────┬───────┘
                          │       │
              ┌───────────▼─┐   ┌─▼───────────┐
              │  apps/api   │   │ apps/worker │      apps/web ──► @app/shared/<subpath> only
              └──┬───┬───┬──┘   └──┬───┬───┬──┘      (over HTTP to apps/api; never core/db)
                 │   │   │         │   │   │
                 │   │   └───┬─────┘   │   │
                 │   │   ┌───▼──────────┐  │
                 │   │   │ packages/core│  │
                 │   │   └──┬────────┬──┘  │
                 │   └──────┼───┐    │     │
                 │      ┌───▼───▼─┐  │     │
                 │      │packages/│  │     │
                 │      │   db    │  │     │
                 │      └─────────┘  │     │
                 └──────────┬────────┴─────┘
                      ┌─────▼──────────┐
                      │packages/shared │  pure: no I/O, no env, no Prisma
                      └────────────────┘
```

| Package | Imports | Imported by |
| --- | --- | --- |
| `packages/shared` | `zod` | everything |
| `packages/db` | Prisma 7, `@prisma/adapter-pg`, `pg` | core, api, worker, aws |
| `packages/core` | db, shared, `zod` | api, worker, aws |
| `apps/api` | core, db, shared, `hono`, `jose`, `aws4fetch`, `zod` | aws |
| `apps/worker` | core, db, shared | aws |
| `apps/aws` | api, worker, core, db, `hono`, `pg`, `aws4fetch` | — (deployed as the Lambda functions `api`, `jobs`, `cron`) |
| `apps/web` | `@app/shared/*` subpaths, `next`, `react`, `motion`, `lenis`, `lucide-react` | — (static files: pages from the `api` function, `/_next/static/*` from S3) |

The UI must import `@app/shared` **by subpath** (`/roles`, `/dates`, `/ads`, `/sales`, `/journey`,
`/traffic`, `/whatsapp`, `/capabilities`): the root barrel re-exports `crypto.ts`, which needs
`node:crypto`.

Import cycles inside packages (file level): two are type-only (`app.ts` ↔ route files,
`handlers.ts` ↔ `bulkOrders.ts`; a third, `overview.tsx` ↔ `previews.tsx`, went away when the
health grades moved to `@app/shared/health`); another was real, hidden behind a dynamic import (`core/tokens.ts` → `adConnections.ts` / `whatsapp/store.ts` → `tokens.ts`), and
went away on 2026-10-18 when key rotation moved to `core/keyRotation.ts`. `pnpm lint` now fails on any cycle that exists
at run time (`scripts/check-import-cycles.mjs`: type-only imports are left out, dynamic `import()` counts).

## 2. Runtime paths

### HTTP request

```
browser / Shopify / Meta
   │
   ▼
CloudFront + WAF (per-IP rate rule on /api/*, managed rules)
   ├─ /_next/static/*  ──► S3 (hashed UI build files, cached for a year)
   └─ everything else  ──► Lambda "api" function URL (apps/aws/src/index.ts)
        ├─ path not /api/*, /webhooks/*, /pixel/*, /shopify/*, /healthz, /readyz  ──► static UI (the export in the package)
        └─ otherwise ──► origin secret checked, client IP from CloudFront ──► Hono app (apps/api/src/app.ts)
                       request id + access log → security headers → body limit → global per-IP limit → CSRF (Origin)
                       → route: requireUser / requireWorkspace(permission) → Zod parse
                       → core function (withTenant = RLS transaction, or systemDb); some routes still query inline
                       → JSON  |  HttpError → { error, message }  |  other → onError → 500
```

The local server (`apps/aws/src/local.ts`, `pnpm --filter @app/aws dev`) routes the same way in
one Node process, without CloudFront: the UI from `apps/web/out`, the rest to the same Hono app.

### Queue message

```
producer (API route, webhook intake, cron sweep, another job)
   ──► SQS queue (sync | webhooks | aggregate | email); a webhook body too big for a message goes to S3
   ──► Lambda "jobs" (event source mapping) ──► consume(name, msg, deps)  (apps/worker/src/index.ts)
          ├─ success → ack
          ├─ Postgres unreachable → retry later, no attempt spent (deferForDb)
          ├─ UnrecoverableError → record failure, alert, ack
          └─ other error → retry with exponential backoff (message visibility) up to MAX_ATTEMPTS (6),
                           then record failure + alert  (a message never settled reaches the dead-letter
                           queue after 10 receives; an alarm fires when it isn't empty)
```

Locally the queues run in-process (`apps/aws/src/localQueues.ts`).

### Cron

```
EventBridge Scheduler (*/15 and 03:15 UTC; off until the cutover) ──► Lambda "cron" ──► runScheduled()
   each sweep isolated (one failing doesn't stop the others): stale jobs, token refresh, reconcile
   scheduling, ads sync scheduling, WhatsApp scheduler (campaigns, sends, retention, health)
```

Locally nothing runs on a schedule: `POST /__scheduled?cron=<expression>` runs one sweep.

## 3. External services

| Service | Used for | Client | Auth | Called from |
| --- | --- | --- | --- | --- |
| Shopify Admin GraphQL + bulk | orders, products, inventory, billing, scopes | `core/shopify.ts` (`gql`), `worker/bulkOrders.ts` | offline token (AES-GCM at rest) | worker, api (contacts, scopes, billing) |
| Shopify OAuth | store connect | `apps/api/src/routes/shopify.ts` | client id/secret, HMAC, state | api |
| Shopify webhooks | data changes, GDPR, billing | `routes/webhooks.ts` | HMAC of raw body | inbound |
| Meta Marketing API | ad spend sync, reports | `core/ads/meta.ts` (`metaGet/metaSend`) on `core/metaGraph.ts` | user token (Authorization header) | worker, api |
| Google Ads API, Google OAuth | ad spend sync, reports | `core/ads/googleAds.ts`, `core/ads/googleOAuth.ts` | OAuth (PKCE), refresh token | worker, api |
| AdSense Management API | ad earnings | `core/ads/adsense.ts` | OAuth | worker, api |
| WhatsApp Cloud API (Meta Graph) | messages, templates, Embedded Signup | `core/whatsapp/graph.ts` on `core/metaGraph.ts` | Bearer system/business token, app token | worker, api |
| WhatsApp webhooks | message status, inbound | `routes/whatsappPublic.ts` | `X-Hub-Signature-256` | inbound |
| Amazon Cognito | sign-in, sign-up, emailed codes, Google federation, admin calls | `apps/api/src/cognito.ts` | app client secret; admin calls signed with the `api` function's role | api |
| Firebase (migration window only) | a first sign-in with a password Cognito doesn't know yet | `apps/api/src/legacyFirebase.ts` | public web API key | api |
| Amazon SES | invitations, alerts, staff emails (Mailpit locally) | `apps/aws/src/sesMailer.ts` (core's `Mailer`) | function role | api, worker |
| Slack (optional) | alerts | `core/notify.ts` | incoming webhook URL | worker |
| Shopify web pixel | storefront events | `routes/pixel.ts` | per-store ingest key | inbound |

Failure isolation: a provider failure becomes a typed error that the route maps to 502/503 or the
queue retries. Every call goes through the injected `fetchImpl`, which `apps/aws` wraps with a
time limit (`withTimeout`: 30 s, 10 s for Cognito), so a hung provider fails like an unreachable one.

## 4. Data ownership

| Data | Owner module | Tables |
| --- | --- | --- |
| Identity, workspaces, roles | api `routes/auth.ts`, `routes/workspaces.ts` | users, workspaces, memberships, invitations, api_keys, notification_preferences, audit_logs, alerts, subscriptions, email_otps |
| Store connection and sync | api `routes/shopify.ts`, `connectStore.ts`, `sync.ts`; worker | stores, sync_jobs, webhook_events |
| Commerce data | core `shopifyQueries.ts` (what is asked), `normalize.ts` + `persist.ts` | orders, order_line_items, refunds, products, product_variants |
| Aggregates | core `persist.ts` (`recomputeDays`) | daily_store_metrics |
| Storefront funnel | api `routes/pixel.ts` | funnel_visits, funnel_daily, pixel_events_seen |
| Advertising | core `ads/` (one client per platform), `adConnections/` (connections, tokens, sync, reports) | ad_connections, ad_campaign_daily, adsense_daily |
| WhatsApp | core `whatsapp/*` | whatsapp_* (9 tables), order_tracking(_events), abandoned_checkouts, customer_reviews |

Every store-scoped table carries `workspace_id`, and RLS restricts the `app_rls` role to
`current_setting('app.workspace_id')`.

## 5. High-risk joints

| Joint | Why it is risky | Mitigation in place / planned |
| --- | --- | --- |
| One RDS database | production stops while the database is down | Multi-AZ standby with automatic failover (`dbMultiAz`, `infra/cdk/lib/config.ts`); `/readyz` (bounded, logs why), `deferForDb`, 503s instead of 500s; 14-day point-in-time restore |
| The account's Lambda concurrency (10) | requests past it are throttled (429) | hashed UI files from S3, not the function; small per-queue concurrency for jobs; `api-throttles` alarm; raise the quota |
| `env()` validation | one bad var stops every request | Zod schema + placeholder-secret guard; the smoke tests after each deploy fail and the functions roll back |
| `TOKEN_ENCRYPTION_KEYS` / `OTP_PEPPER` / `CUSTOMER_HASH_KEY` | losing or rotating them makes stored tokens or hashes unreadable | versioned keyring + `ops:reencrypt`; customer hashes keyed by `CUSTOMER_HASH_KEY` (defaults to `OTP_PEPPER`), so the pepper can rotate alone (RUNBOOK) |
| Shopify API version | silently changes behaviour when it falls out of support | owner check (H6) |
| Every merge to `main` deploys | a broken change goes live on merge | CI must pass first; Deploy to AWS runs the migrations and smoke tests and moves the functions back to the previous versions if either fails ([../aws-deployment.md](../aws-deployment.md)) |
| Files under concurrent edit | moves cause merge conflicts | see current-state §6 |
