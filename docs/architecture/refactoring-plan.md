# Refactoring plan

> Historical record (2026-10-14): written when bizinsights ran on Cloudflare Workers. It now runs on
> AWS: see [aws-architecture.md](../aws-architecture.md).

What changes, in which order, and what deliberately does not. Built from
[current-state.md](current-state.md) (finding ids H*, M*, W*, T* refer to it). The outcome of each
stage is recorded in [refactoring-report.md](refactoring-report.md).

## Principles

1. **Behaviour stays the same** unless a stage says otherwise (a fix). API response shapes are
   kept; additions are additive (a header, an extra field).
2. **Small, verified stages.** Each stage is one or a few commits; after each: typecheck, unit and
   integration tests, and the web build or Worker bundle when the stage touches them.
3. **No production action.** Nothing here deploys, applies a migration to production, rotates a
   credential or changes live infrastructure. Where a fix needs one, the stage says so and leaves
   it to the owner.
4. **Respect work in progress.** Files that other unmerged branches edit (current-state §6) are
   not moved or rewritten; at most a few lines that those branches don't touch are changed.
   Renames are pure `git mv` commits (git carries other branches' edits across a pure rename).
5. **Modular monolith.** No new services, queues or infrastructure; the existing package layering
   (shared → db → core → api / worker → cloudflare) is the target, applied more consistently.

## Stages

| # | Stage | Findings | Main files | Verification |
| --- | --- | --- | --- | --- |
| 0 | Baseline and audit documents | — | `docs/architecture/*` | baseline recorded in current-state §4 |
| 1 | **Observability**: a request id on every API response (`x-request-id`, Cloudflare's `cf-ray` when present) and on every log line written while handling it (log context); one access-log line per request with the route pattern, status and duration; 5xx `HttpError`s logged; the logger keeps `cause` and error codes, truncates instead of leaking deep objects, never lets fields overwrite `msg`/`level`; `/readyz` bounded by a timeout, checks both database roles, logs why it failed | M1, M2, M3 | `core/logger.ts`, `api/requestContext.ts` (new), `api/app.ts` (middleware + readyz only), `db/index.ts` | new API + core tests |
| 2 | **Resilience**: every outbound call gets a timeout by default (the injected `fetchImpl` and the Firebase provider are wrapped once at the composition root); `audit()` becomes best-effort after the change it records; unsigned WhatsApp webhook calls are rate-limited before touching the database | H2, M7, M8 | `core/http.ts` (new), `cloudflare/index.ts`, `core/notify.ts` (`audit` only), `api/routes/whatsappPublic.ts` | new tests |
| 3 | **Job correctness**: conditional subscription updates (no stale overwrite); seed the scope follow-up sync before saving the new scopes; alert on a final aggregate failure; staleness guard inside the write for single order/product/variant upserts | H1, M9, M10, M11 | `worker/handlers.ts`, `worker/index.ts` (failure branch only), `core/persist.ts` | worker tests for each race / retry |
| 4 | **Configuration safety**: local tooling and `wrangler dev` default to an `app_dev` database, never production's `app`; production refuses an emulator host, a Mailpit relay or a localhost `APP_URL`; `MAILPIT_URL` joins the config schema; a separate `CUSTOMER_HASH_KEY` (falling back to `OTP_PEPPER`) keys customer and WhatsApp hashes so rotating the OTP pepper can't orphan opt-outs | H3, H4, M19 | `wrangler.jsonc` (local strings only), `.env.example`, `core/env.ts`, `core/persist.ts`, `core/whatsapp/store.ts` (one line), docs | env tests, existing suites |
| 5 | **Layering**: dashboard reporting moves from the route into `packages/core/src/reports/` (the route parses, authorizes, calls, responds); WhatsApp list endpoints get Zod query schemas and one cursor-pagination helper; campaign metrics without the per-campaign N+1; indexes for the hot filters | M4, M5, M15 (indexes) | `api/routes/dashboard.ts`, `core/reports/*` (new), `api/pagination.ts` (new), `api/routes/whatsappOps.ts`, a new migration | existing dashboard + WhatsApp tests unchanged, new pagination tests |
| 6 | **Frontend**: health grading rules move to `@app/shared/health` (unit-tested); one module for the repeated dashboard narrative helpers (keeping each call site's exact wording); detail panels load on demand; tile labels keep the figure for screen readers; dashboard component files renamed to PascalCase (pure renames) | W1, W2, W3, W4 | `shared/src/health.ts` (new), `web components/dashboard/*`, `app/(app)/dashboard/page.tsx` | shared unit tests, web build, bundle comparison |
| 7 | **Tooling**: ESLint (TypeScript + React hooks rules) with a `lint` script; CI adds lint, `pnpm audit`, a Prisma migration drift check, `wrangler types --check`, job timeouts | W5, T1, part of T2 | `eslint.config.mjs`, `package.json`, `.github/workflows/ci.yml` | `pnpm lint` clean; workflow syntax |
| 8 | **Operations and documentation**: a database backup script with retention and a restore check (owner schedules it); docs drift fixed; architecture decisions, target architecture, API overview, database and migration guides, docs index | H5, docs drift | `infra/postgres/backup.ps1`, `docs/**` | script dry run against the test database |
| 9 | Final regression and report | — | `docs/architecture/refactoring-report.md` | full suite, web build, Worker bundle, e2e |

## Not done here, and why

| Item | Why not now | What it needs |
| --- | --- | --- |
| Shopify API version bump (H6) | Silent behaviour changes in GraphQL; needs the Partner Dashboard's API health and a live store to test against | owner checks, then a tested bump |
| Moving production Postgres off the PC; superuser role; credential rotation (T4) | Live infrastructure and credentials | owner decision / action (`docs/security.md`) |
| Shared Meta Graph transport, Meta token in headers + `appsecret_proof`, async report polling (M13, M14, M16) | `core/ads.ts` and `core/whatsapp/graph.ts` are being rewritten on the ads and WhatsApp branches | do it on top of those branches (design in current-state M16 / dependency map) |
| Raw provider text in API messages (M6) | Mostly inside `routes/{ads,whatsapp,workspaces}.ts`, edited elsewhere | same pattern as `connectError`, after those merges |
| Typing untrusted payloads instead of `any` (M17) | `core/normalize.ts` is edited on another branch | Zod / typed GraphQL shapes after that merge |
| Caching Firebase revocation checks (M18) | `authProvider.ts` is edited on the staff branch; also a security trade-off (up to N seconds of a revoked session) | owner decision on the window |
| Money precision for 3-decimal currencies (M20) | A column type change on every money column of production tables | migration plan + owner decision; affects only stores in KWD/BHD/OMR/JOD/TND |
| Automatic retention deletes | Deletes production data on a schedule | owner decision; the manual monthly SQL stays in the runbook |
| `features/` folder layout, `/api/v1` prefix, a client store library, splitting deployables | Not justified for this codebase (see [architecture-decisions.md](architecture-decisions.md)) | — |
| Renaming `components/whatsapp/*`, splitting `core/ads.ts`, `adConnections.ts`, `normalize.ts`, `notify.ts` | Under active edit elsewhere | after those branches merge |
| Web `noUncheckedIndexedAccess` (W7) | 437 of 439 errors are in the landing animations (performance-tuned canvas code) | a dedicated pass with visual checks |
| Pinning CI actions to SHAs | Needs an update bot (Dependabot / Renovate) or it rots | owner picks the bot |

## Compatibility

- **API**: no route, method, status code or response field is removed or renamed. Additions: the
  `x-request-id` response header; `checks.tenantDb` in `/readyz`.
- **Database**: one additive migration (indexes only). No data is changed.
- **Config**: new optional `CUSTOMER_HASH_KEY` (defaults to `OTP_PEPPER`, so existing hashes stay
  valid) and `MAILPIT_URL` in the schema. Production values unchanged; the new production guards
  reject only values production doesn't use.
- **Local development**: `wrangler dev` and the root `.env.example` point at `app_dev`. An existing
  `.env` is not touched; `docs/local-dev.md` says how to create the database.

## Rollback

Every stage is its own commit on `claude/project-audit-restructure-ed93a6`; reverting a commit
restores the previous behaviour. Nothing is deployed by this work. When it is deployed, the usual
staged-version procedure applies, and the index migration is safe to leave in place on rollback.
