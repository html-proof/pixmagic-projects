# Target architecture

Where the structure of bizinsights is heading, how far it is, and what is left. The shape doesn't
change: a modular monolith in one pnpm workspace, deployed as one package (three Lambda functions on
AWS; [ADR-001](architecture-decisions.md#adr-001-one-modular-monolith-one-deployable)). What
the target adds is that every piece sits in the layer that owns it.

## Layers and ownership

```
apps/web          screens: render, interact, load/empty/error states.            @app/shared/<subpath> only
apps/api          HTTP: authenticate → authorize → validate → call core → respond  no SQL, no provider calls
apps/worker       queue jobs and cron sweeps: retry, backoff, failure records       calls core
apps/aws          composition root: AWS services → Deps, secrets, timeouts, log context  no logic
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
| Tooling | ESLint (TypeScript + hooks) in CI; dependency audit; migration drift check; job timeouts |
| Operations | Verified backup script with retention; runbook for scheduling and restore |
| 2026-10-16 | WhatsApp campaign, automation and cart-reminder rules in `core/whatsapp/` (routes keep HTTP only); `AppError` for rule violations; provider text only through `providerDetail()`; remaining component renames; app-wide UI in `components/AppUi.tsx`; dead code removed |

## What is left, and what unblocks it

| Item | Blocked by | Then |
| --- | --- | --- |
| One Meta Graph transport (timeouts already central; add `appsecret_proof`, Bearer auth, host check on paging, Retry-After) | Ads workstreams (`claude/ads-ws-*`) rewrite `core/ads.ts` | `core/metaGraph.ts` used by ads and WhatsApp |
| Typed provider payloads instead of `any` | `core/normalize.ts` edited on another branch | Zod schemas at the boundary |
| Split `worker/handlers.ts` (975 lines) by job | nothing (cold), but every worker change touches it | `sync.ts`, `webhooks.ts`, `billing.ts`, `sweeps.ts` behind a re-export |
| `noUncheckedIndexedAccess` in the web app | 437 findings in landing animations | a pass with visual checks |
| Retention sweeps (`webhook_events`, `pixel_events_seen`, `email_otps`, `funnel_visits`) | deletes production data on a schedule: owner decision | cron sweep behind a lease |
| Money precision for 3-decimal currencies | column type change on production money columns: owner decision | `DECIMAL(20,4)` migration + normalizers in minor units |
| Production database off the PC | built: RDS on AWS ([../aws-deployment.md](../aws-deployment.md)); serves merchants from the cutover, the owner's go-ahead | cutover steps in the runbook |

## Growing it

- **More organizations and users**: already multi-tenant (workspace on every row, RLS); roles are
  one matrix in `@app/shared/roles`.
- **More features**: one folder per area in each layer (`core/<area>/`, `routes/<area>*.ts`,
  `components/<area>/`, `app/(app)/<area>/`), as Staff Management does.
- **More integrations**: one module per provider in core, every call through the injected fetch
  ([../development/adding-a-feature.md](../development/adding-a-feature.md)).
- **Larger data**: reports are SQL aggregates over indexed `(store_id, local_day)`; daily totals
  are precomputed. On AWS the database is RDS (size it up, add RDS Proxy and read replicas as
  traffic grows; [../aws-architecture.md](../aws-architecture.md)).
- **When to split a deployable**: only when a part needs its own scaling or release cadence (the
  pixel ingest at high volume is the likeliest first candidate).
