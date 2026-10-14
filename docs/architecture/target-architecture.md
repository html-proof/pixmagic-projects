# Target architecture

Where the structure of Insights is heading, how far it is, and what is left. The shape doesn't
change: a modular monolith in one pnpm workspace, deployed as one Cloudflare Worker
([ADR-001](architecture-decisions.md#adr-001-one-modular-monolith-on-one-cloudflare-worker)). What
the target adds is that every piece sits in the layer that owns it.

## Layers and ownership

```
apps/web          screens: render, interact, load/empty/error states.            @app/shared/<subpath> only
apps/api          HTTP: authenticate → authorize → validate → call core → respond  no SQL, no provider calls
apps/worker       queue jobs and cron sweeps: retry, backoff, failure records       calls core
apps/cloudflare   composition root: bindings → Deps, timeouts, log context          no logic
packages/core     use cases and data access: reports, persistence, integrations      no HTTP, no queue mechanics
  ├─ reports/        dashboard read side                                  ✔ done (2026-10-14)
  ├─ shopify, persist, normalize, tokens, scopes                          ✔ (normalize: `any` to remove)
  ├─ ads, adConnections                                                    ◐ one Meta transport to extract
  ├─ whatsapp/                                                             ◐ campaign/automation rules still in routes
  └─ staff/          (on its branch)                                       ✔ shaped this way already
packages/db       schema, migrations, RLS, request-scoped clients
packages/shared   pure rules: KPIs, health grading ✔, journey maths ✔, dates, roles, WhatsApp rules
```

Request path, as the target has it (and the dashboard now does):

```
request → requestContext (id, access log) → security headers → body limit → per-IP limit → CSRF
        → route: requireWorkspace(permission) → Zod parse → core function(tx) → JSON
        → errors: HttpError → { error, message }; anything else → logged with the request id → 500
```

## What is done

| Area | State |
| --- | --- |
| Observability | Request id on every response and log line (API, queue, cron); access log by route pattern; `/readyz` bounded, checks both DB roles, logs why |
| Resilience | Default timeout on every outbound call; best-effort audit; unsigned-webhook rate limit |
| Correctness of background work | Conditional billing writes; scope backfill survives retries; failed aggregates repaired by reconcile; no stale overwrite of orders/products/variants |
| Configuration | One validated schema; production refuses placeholder secrets and development settings; local tools default to `app_dev`; customer-hash key separate from the OTP pepper |
| Layering | Dashboard reports in core; WhatsApp lists on one paging helper; campaign metrics without N+1 |
| Frontend | Health rules and journey maths in `@app/shared` with tests; one set of narrative helpers; detail panels load on demand; dashboard files PascalCase |
| Tooling | ESLint (TypeScript + hooks) in CI; dependency audit; binding-types check; migration drift check; job timeouts |
| Operations | Verified backup script with retention; runbook for scheduling and restore |

## What is left, and what unblocks it

| Item | Blocked by | Then |
| --- | --- | --- |
| WhatsApp campaign/automation rules, cart eligibility and analytics into `core/whatsapp/` | WhatsApp branch (`elated-raman`) edits `routes/whatsapp.ts` and `core/whatsapp/*` | move them as `campaigns.ts`, `automations.ts`, `analytics.ts` functions of `tx` |
| One Meta Graph transport (timeouts already central; add `appsecret_proof`, Bearer auth, host check on paging, Retry-After) | Ads workstreams (`claude/ads-ws-*`) rewrite `core/ads.ts` | `core/metaGraph.ts` used by ads and WhatsApp |
| Provider text out of API messages | same files as above | map to fixed text + `errorCode`, log the detail |
| Typed provider payloads instead of `any` | `core/normalize.ts` edited on another branch | Zod schemas at the boundary |
| Split `worker/handlers.ts` (975 lines) by job | nothing (cold), but every worker change touches it | `sync.ts`, `webhooks.ts`, `billing.ts`, `sweeps.ts` behind a re-export |
| Rename `components/whatsapp/*`, `lineChart.tsx`, `primitives.tsx` | WhatsApp and staff branches import them | pure `git mv` commit |
| `noUncheckedIndexedAccess` in the web app | 437 findings in landing animations | a pass with visual checks |
| Retention sweeps (`webhook_events`, `pixel_events_seen`, `email_otps`, `funnel_visits`) | deletes production data on a schedule: owner decision | cron sweep behind a lease |
| Money precision for 3-decimal currencies | column type change on production money columns: owner decision | `DECIMAL(20,4)` migration + normalizers in minor units |
| Production database off the PC; non-superuser owner role; rotated passwords | infrastructure and credentials: owner | managed Postgres or a server; Hyperdrive repointed |

## Growing it

- **More organizations and users**: already multi-tenant (workspace on every row, RLS); roles are
  one matrix in `@app/shared/roles`.
- **More features**: one folder per area in each layer (`core/<area>/`, `routes/<area>*.ts`,
  `components/<area>/`, `app/(app)/<area>/`), as Staff Management does.
- **More integrations**: one module per provider in core, every call through the injected fetch
  ([../development/adding-a-feature.md](../development/adding-a-feature.md)).
- **Larger data**: reports are SQL aggregates over indexed `(store_id, local_day)`; daily totals
  are precomputed. The first limit is the database's location (one PC, a tunnel), not the code.
- **When to split a deployable**: only when a part needs its own scaling or release cadence (the
  pixel ingest at high volume is the likeliest first candidate).
