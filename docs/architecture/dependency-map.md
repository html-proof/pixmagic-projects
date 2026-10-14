# Dependency map

How the parts of Insights depend on each other: packages, runtime paths, external services, and
the high-risk joints. Companion to [current-state.md](current-state.md).

## 1. Package graph

Arrows point from a package to what it imports. Checked from every `package.json` and every import
statement (191 source files): there are **no cycles between packages**.

```
                       ┌──────────────────┐
                       │ apps/cloudflare  │  the one deployable (Worker entry, Durable Object)
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
| `packages/db` | Prisma 7, `@prisma/adapter-pg`, `pg` | core, api, worker, cloudflare |
| `packages/core` | db, shared, `zod` | api, worker, cloudflare |
| `apps/api` | core, db, shared, `hono`, `jose`, `zod` | cloudflare |
| `apps/worker` | core, db, shared | cloudflare |
| `apps/cloudflare` | api, worker, core, db (+ Workers runtime) | — (deployed) |
| `apps/web` | `@app/shared/*` subpaths, `next`, `react`, `firebase`, `motion`, `lucide-react` | — (built to static files the Worker serves) |

The UI must import `@app/shared` **by subpath** (`/roles`, `/dates`, `/ads`, `/sales`, `/journey`,
`/traffic`, `/whatsapp`, `/capabilities`): the root barrel re-exports `crypto.ts`, which needs
`node:crypto`.

Import cycles inside packages (file level): two are type-only (`app.ts` ↔ route files,
`handlers.ts` ↔ `bulkOrders.ts`; a third, `overview.tsx` ↔ `previews.tsx`, went away when the
health grades moved to `@app/shared/health`); one is real and broken at runtime by a dynamic import: `core/tokens.ts` → `adConnections.ts` / `whatsapp/store.ts` →
`tokens.ts` (`tokens.ts:116-117`).

## 2. Runtime paths

### HTTP request

```
browser / Shopify / Meta
   │
   ▼
Worker fetch (apps/cloudflare/src/index.ts)
   ├─ path not /api/*, /webhooks/*, /pixel/*, /shopify/*, /healthz, /readyz  ──► ASSETS (static UI from apps/web/out)
   └─ otherwise ──► withDb(Hyperdrive URLs) ──► Hono app (apps/api/src/app.ts)
                       request id + access log → security headers → body limit → global per-IP limit → CSRF (Origin)
                       → route: requireUser / requireWorkspace(permission) → Zod parse
                       → core function (withTenant = RLS transaction, or systemDb); some routes still query inline
                       → JSON  |  HttpError → { error, message }  |  other → onError → 500
```

### Queue message

```
producer (API route, webhook intake, cron sweep, another job)
   ──► Cloudflare Queue (insights-sync | insights-webhooks | insights-aggregate)
   ──► Worker queue() ──► withDb ──► consume(name, msg, deps)  (apps/worker/src/index.ts)
          ├─ success → ack
          ├─ Postgres unreachable → retry later, no attempt spent (deferForDb)
          ├─ UnrecoverableError → record failure, alert, ack
          └─ other error → retry with exponential backoff up to MAX_ATTEMPTS (6 = max_retries 5 + 1),
                           then record failure + alert  (dead-letter queue insights-dlq: no consumer)
```

### Cron

```
*/15 * * * *  and  15 3 * * *  ──► Worker scheduled() ──► runScheduled()
   each sweep isolated (one failing doesn't stop the others): stale jobs, token refresh, reconcile
   scheduling, ads sync scheduling, WhatsApp scheduler (campaigns, sends, retention, health)
```

## 3. External services

| Service | Used for | Client | Auth | Called from |
| --- | --- | --- | --- | --- |
| Shopify Admin GraphQL + bulk | orders, products, inventory, billing, scopes | `core/shopify.ts` (`gql`), `worker/bulkOrders.ts` | offline token (AES-GCM at rest) | worker, api (contacts, scopes, billing) |
| Shopify OAuth | store connect | `apps/api/src/routes/shopify.ts` | client id/secret, HMAC, state | api |
| Shopify webhooks | data changes, GDPR, billing | `routes/webhooks.ts` | HMAC of raw body | inbound |
| Meta Marketing API | ad spend sync, reports | `core/ads.ts` (`metaGet/metaSend`) | user token (query/form) | worker, api |
| Google Ads API, Google OAuth | ad spend sync, reports | `core/ads.ts` | OAuth (PKCE), refresh token | worker, api |
| AdSense Management API | ad earnings | `core/ads.ts` | OAuth | worker, api |
| WhatsApp Cloud API (Meta Graph) | messages, templates, Embedded Signup | `core/whatsapp/graph.ts` | Bearer system/business token, app token | worker, api |
| WhatsApp webhooks | message status, inbound | `routes/whatsappPublic.ts` | `X-Hub-Signature-256` | inbound |
| Firebase Identity Toolkit | ID tokens, session cookies, custom tokens, email links | `apps/api/src/authProvider.ts` | service account (JWT), web API key | api |
| Cloudflare Email Sending | OTP codes, invitations, alerts | `core/notify.ts` | binding | api, worker |
| Slack (optional) | alerts | `core/notify.ts` | incoming webhook URL | worker |
| Shopify web pixel | storefront events | `routes/pixel.ts` | per-store ingest key | inbound |

Failure isolation: a provider failure becomes a typed error that the route maps to 502/503 or the
queue retries. Every call goes through the injected `fetchImpl`, which the Worker wraps with a
time limit (`withTimeout`: 30 s, 10 s for Firebase), so a hung provider fails like an unreachable one.

## 4. Data ownership

| Data | Owner module | Tables |
| --- | --- | --- |
| Identity, workspaces, roles | api `routes/auth.ts`, `routes/workspaces.ts` | users, workspaces, memberships, invitations, api_keys, notification_preferences, audit_logs, alerts, subscriptions, email_otps |
| Store connection and sync | api `routes/shopify.ts`, `connectStore.ts`, `sync.ts`; worker | stores, sync_jobs, webhook_events |
| Commerce data | core `normalize.ts` + `persist.ts` | orders, order_line_items, refunds, products, product_variants |
| Aggregates | core `persist.ts` (`recomputeDays`) | daily_store_metrics |
| Storefront funnel | api `routes/pixel.ts` | funnel_visits, funnel_daily, pixel_events_seen |
| Advertising | core `ads.ts`, `adConnections.ts` | ad_connections, ad_campaign_daily, adsense_daily |
| WhatsApp | core `whatsapp/*` | whatsapp_* (9 tables), order_tracking(_events), abandoned_checkouts, customer_reviews |

Every store-scoped table carries `workspace_id`, and RLS restricts the `app_rls` role to
`current_setting('app.workspace_id')`.

## 5. High-risk joints

| Joint | Why it is risky | Mitigation in place / planned |
| --- | --- | --- |
| Postgres on the owner's PC through a tunnel | production stops when the PC, Docker or the network stops | `/readyz` (bounded, logs why), `deferForDb`, 503s instead of 500s; `infra/postgres/backup.mjs` (owner schedules it); moving off the PC (owner decision) |
| `env()` validation | one bad var stops every request | Zod schema + placeholder-secret guard; build at isolate start logs instead of crashing |
| `TOKEN_ENCRYPTION_KEYS` / `OTP_PEPPER` / `CUSTOMER_HASH_KEY` | losing or rotating them makes stored tokens or hashes unreadable | versioned keyring + `ops:reencrypt`; customer hashes keyed by `CUSTOMER_HASH_KEY` (defaults to `OTP_PEPPER`), so the pepper can rotate alone (RUNBOOK) |
| Shopify API version | silently changes behaviour when it falls out of support | owner check (H6) |
| Shared Worker deploys | several branches deploy to the same Worker | staged versions + smoke tests (`docs/deployment-cloudflare.md`) |
| Files under concurrent edit | moves cause merge conflicts | see current-state §6 |
