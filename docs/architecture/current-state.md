# Current state (audit, 2026-10-14)

> Historical record (2026-10-14): written when bizinsights ran on one Cloudflare Worker
> (`apps/cloudflare`, removed after commit `a861bd9`). It now runs on AWS: see
> [aws-architecture.md](../aws-architecture.md), and [dependency-map.md](dependency-map.md) for how
> the parts fit together today.

An audit of the repository as of commit `4320f54` (GitHub `main`, the code live in production).
Nothing here was changed to produce it. The changes that followed are in
[refactoring-report.md](refactoring-report.md); the plan is in
[refactoring-plan.md](refactoring-plan.md); how the parts depend on each other is in
[dependency-map.md](dependency-map.md).

**Bottom line.** This is not a codebase that needs restructuring from scratch. It is already a
layered modular monolith in a pnpm workspace (`apps/*` on top of `packages/*`) with documented
layering rules, tenant isolation enforced twice (query filters plus Postgres row-level security),
validated configuration, redacted structured logs and 575 automated tests that pass. The problems
are local: a few routes that still own SQL, missing timeouts and request correlation, a handful of
races in background jobs, duplicated helpers in the dashboard UI, no linter, and operational risks
that come from production's database living on a single PC.

No critical findings. 6 high, about 40 medium, many low (below).

## 1. Technology stack (read from the files, not assumed)

| Concern | What is used | Where |
| --- | --- | --- |
| Language | TypeScript 5.9, `strict` (+ `noUncheckedIndexedAccess` except in `apps/web`) | `tsconfig.base.json` |
| Package manager | pnpm 9.15 workspaces, Node 24 (`.nvmrc`; `engines` says ≥22) | `package.json`, `pnpm-workspace.yaml` |
| Runtime / hosting | One Cloudflare Worker (`nodejs_compat`) serving the static UI, the API, Queue consumers, Cron Triggers and a Durable Object | `apps/cloudflare` |
| Frontend | Next.js 16.3 App Router, **static export** (no server rendering), React 19.3 | `apps/web` |
| UI components | Own components (no component library); Tailwind CSS 4.3; `lucide-react` icons; `motion` for animation; `geist` font | `apps/web/src/components` |
| State management | No store library. `useApi`/`useLiveApi` hooks for server state, one React context (`AppContext`) for session and workspace, the URL for the dashboard's range and open panel, `localStorage` wrapper for preferences | `apps/web/src/lib/api.ts`, `components/AppContext.tsx` |
| Backend framework | Hono 4.13 | `apps/api` |
| Validation | Zod 3.25 (API input, config) | everywhere |
| Database | PostgreSQL 17 (Docker on the owner's PC, reached through Cloudflare Tunnel + Workers VPC + Hyperdrive) | `docker-compose.yml`, `wrangler.jsonc` |
| ORM | Prisma 7.10 (`prisma-client` generator, `workerd` runtime, `@prisma/adapter-pg`), raw tagged-template SQL for reports | `packages/db` |
| Tenancy | Two DB roles: owner (`systemDb`) and `app_rls` (`tenantDb`, RLS on `app.workspace_id`) | `packages/db/src/index.ts`, `migrations/*_rls` |
| Authentication | Firebase Auth (Google, Apple, email + password) verified server-side over the Identity Toolkit REST API + `jose`; emailed one-time codes; session cookies (httpOnly, SameSite=Lax) | `apps/api/src/authProvider.ts`, `routes/auth.ts` |
| Authorization | Role matrix owner / admin / analyst / viewer; read-only API keys | `packages/shared/src/roles.ts`, `apps/api/src/context.ts` |
| Background work | Cloudflare Queues (`insights-sync`, `insights-webhooks`, `insights-aggregate`, DLQ `insights-dlq`), Cron (`*/15`, `03:15`) | `apps/worker`, `wrangler.jsonc` |
| Coordination / cache | One Durable Object (`Coordinator`): rate-limit counters, leases, OAuth state, signed-out sessions, large webhook payloads (R2 is not bound) | `apps/cloudflare/src/coordinator.ts` |
| Payments | Shopify Billing API (`appSubscriptionCreate`), subscription webhooks | `routes/workspaces.ts`, `apps/worker/src/handlers.ts` |
| Third-party APIs | Shopify Admin GraphQL + bulk operations, Meta Marketing API, Google Ads API, AdSense Management API, WhatsApp Cloud API (Meta Graph), Firebase Identity Toolkit | `packages/core/src/{shopify,ads,adConnections}.ts`, `core/src/whatsapp/*` |
| Webhooks in | Shopify (HMAC), WhatsApp (`X-Hub-Signature-256`) | `routes/webhooks.ts`, `routes/whatsappPublic.ts` |
| Storefront data | Shopify web pixel extension → `/pixel/:key` | `shopify-app/extensions/insights-pixel`, `routes/pixel.ts` |
| Email | Cloudflare Email Sending (production), Mailpit (local) | `packages/core/src/notify.ts` |
| Logging / monitoring | Own JSON logger with key redaction and text scrubbing → Workers Logs; alerts table + email + optional Slack | `packages/core/src/logger.ts`, `notify.ts` |
| Configuration | One Zod schema (`env()`) for the Worker; `wrangler.jsonc` vars + `wrangler secret`; `.dev.vars` locally; `NEXT_PUBLIC_FIREBASE_*` at UI build time | `packages/core/src/env.ts` |
| Testing | Vitest 4 (unit + integration against real Postgres), Playwright 1.63 (e2e against `wrangler dev`) | `*/test`, `apps/web/e2e` |
| Lint / format | **None** (no ESLint, Prettier or Biome) | — |
| CI | GitHub Actions: typecheck, unit, integration (Postgres service), web build, Worker dry-run bundle, e2e | `.github/workflows/ci.yml` |
| Deployment | Manual, from the owner's PC: `wrangler versions upload` → 0 % stage → smoke test → promote | `docs/deployment-cloudflare.md` |

## 2. Repository structure (actual)

```
apps/cloudflare   276 lines   Worker entry: routes a request to UI or API, wires bindings into Deps, queue + cron dispatch, Coordinator DO
apps/api        6,086 lines   Hono app: 12 route files (auth, shopify, webhooks, pixel, dashboard, workspaces, scopes, contacts, ads, whatsapp x4)
apps/worker     1,590 lines   Queue consumers and cron sweeps (handlers.ts, bulkOrders.ts, index.ts); ops/ maintenance tasks; demo/ seed
apps/web       26,304 lines   38 static routes; components/{dashboard,whatsapp,landing}; lib/ (API client, session, storage)
packages/core   7,081 lines   Shopify client, token encryption, normalizers, persistence, aggregates, alerts/audit, ads, WhatsApp
packages/db       271 lines   Prisma schema (35 models), 13 migrations incl. RLS, request-scoped clients, test helpers
packages/shared 3,083 lines   Pure logic: KPI formulas, dates, roles, crypto, OTP, capabilities, ads/sales/journey/traffic/WhatsApp rules
shopify-app                   shopify.app.toml (+ a second app config), web pixel extension, listing assets
infra/                        Postgres role init, Firebase emulator config
docs/                         14 guides (setup, KPIs, security, deployment, runbook, webhooks, WhatsApp, ads)
test-support/                 Shared test env and global setup (throwaway DB per run, advisory lock)
```

The reference layout in the restructuring brief (`apps/web`, `apps/api`, `apps/worker`, `packages/*`)
is already the layout here, with one addition (`apps/cloudflare`, the single deployable that hosts
the other three). See [architecture-decisions.md](architecture-decisions.md) for what is
deliberately not adopted from the brief (API versioning, `features/` folders, a store library,
separate deployables).

## 3. Existing functionality (must keep working)

- **Accounts**: sign-up / sign-in with Google, Apple, email + password, emailed 6-digit code,
  email-link fallback; verify email; password reset; per-device sign-out; `/auth/whoami`.
- **Workspaces**: create, rename, members and roles, invitations, API keys (read-only), audit log,
  alerts, notification preferences, billing (Shopify subscription).
- **Shopify**: OAuth connect from Settings or first-run onboarding, `/start` forwarder (Shopify
  reviewers use it), optional-scope request/refresh/revoke, initial bulk import, webhooks
  (orders, products, inventory, refunds, uninstall, scopes, GDPR, billing), nightly reconcile,
  token refresh/rotation, web pixel ingest.
- **Dashboard**: one `/overview` call per store with capability-gated modules (sales, refunds,
  customers, top products, funnel, channels and traffic sources, order timing, fulfillment,
  discount codes, recent orders, inventory, catalog, ads, AdSense), detail panels, custom date
  ranges, live refresh, customers to follow up (read live from Shopify).
- **Advertising**: Meta Ads, Google Ads and AdSense OAuth connect, daily sync, live reports.
- **WhatsApp**: Embedded Signup and manual connect, templates, order/delivery updates, abandoned
  carts, reviews, campaigns, automations, consent, analytics, public tracking and review pages.
- **Operations**: `/healthz`, `/readyz`, alerts by email/Slack, maintenance tasks
  (`ops:recompute`, `ops:reencrypt`), key rotation.

Not in this branch: the Staff Management (staff, attendance, payroll, employee portal) module is
committed on `claude/staff-management-payroll-d95d29` (59dbdac) but not merged or deployed. It was
audited only for how it interacts with this work (see §6).

## 4. Baseline (before any change)

| Check | Result |
| --- | --- |
| `pnpm typecheck` (all 7 workspaces) | pass |
| `pnpm test` (unit) | shared 115, core 95 — all pass |
| `pnpm test:integration` (throwaway Postgres 17 on port 5447) | api 235, worker 130 — all pass |
| `pnpm --filter @app/web build` | pass, 38 static routes, 1.91 MB of JS chunks in total |
| Worker bundle (`wrangler deploy --dry-run`) | pass, 5,080.67 KiB / gzip 1,515.38 KiB (Prisma's WASM query compiler is 3.4 MB of it) |
| `pnpm audit` | 0 advisories |
| Secrets in tracked files / git history | none (60 commits scanned; the only key-shaped value is the public Firebase web API key) |

## 5. Findings

Severity: **High** = can lose or corrupt data, take production down, or expose data; **Medium** =
a real defect or risk with limited blast radius, or a rule of the architecture being broken;
**Low** = consistency, clarity, small inefficiency.

### High

| # | Area | Finding | Evidence |
| --- | --- | --- | --- |
| H1 | Worker / billing | Race in `applySubscriptionUpdate`: it reads the subscription row and then writes unconditionally. "Charge B active" and "charge A cancelled" arrive together; processed concurrently, the stale read lets the second write set the plan back to `free` after B was applied | `apps/worker/src/handlers.ts:639-660` |
| H2 | Integrations | No outbound HTTP call has a timeout (no `AbortSignal` anywhere). A hung Shopify, Meta, Google, Firebase or Slack call stalls a whole queue batch (messages run one after another) until the wall-clock limit, then every message is redelivered | `packages/core/src/shopify.ts:180`, `ads.ts:171`, `whatsapp/graph.ts:64`, `notify.ts:108`, `apps/api/src/authProvider.ts:166` |
| H3 | Config / privacy | `OTP_PEPPER` also keys the customer hash and the WhatsApp phone hash used to find opted-out contacts. The runbook's "rotate the OTP pepper" would orphan every STOP opt-out: the next message creates a fresh, opted-in contact | `packages/core/src/persist.ts:13`, `whatsapp/store.ts:38,109`, `docs/RUNBOOK.md` |
| H4 | Operations | Local development defaults to the production database: `wrangler.jsonc` `localConnectionString` and `.env.example` both point at `localhost:5434/app`, which on this machine *is* production | `apps/cloudflare/wrangler.jsonc:90,95`, `.env.example:12` |
| H5 | Operations | No automated backups of production Postgres (one Docker volume on one PC); backups so far were taken by hand before migrations | `docs/RUNBOOK.md` |
| H6 | Integrations | `SHOPIFY_API_VERSION = 2025-10` is at or past Shopify's 12-month support window; Shopify silently serves a newer version to unsupported requests. Needs a check in the Partner Dashboard and a tested bump (not a blind change) | `wrangler.jsonc:40`, `shopify-app/shopify.app.toml:36` |

### Medium — backend

| # | Finding | Evidence |
| --- | --- | --- |
| M1 | No request correlation: no request id, no access log, `onError` logs `{err, path}` only; 5xx `HttpError`s are never logged | `apps/api/src/app.ts:96-103` |
| M2 | The logger drops `cause` and error codes, redacts every key named `code` (so Meta / Firebase error codes and `alert.code` read `[redacted]`), logs objects deeper than 5 levels unredacted, and lets fields overwrite `msg`/`level` | `packages/core/src/logger.ts:22,81,84,95` |
| M3 | `/readyz` has no timeout (a stalled tunnel hangs the probe), never checks the `app_rls` connection every tenant read uses, and throws the reason away | `apps/api/src/app.ts:108-123` |
| M4 | Reporting SQL in a route: `routes/dashboard.ts` is 932 lines, ~790 of them queries and data shaping (18 raw SQL statements) | `apps/api/src/routes/dashboard.ts:93-733,862-924` |
| M5 | WhatsApp ops: list endpoints read `c.req.query()` without Zod; cursor pagination is copied 4 times (5 with audit logs); campaign metrics run one transaction per campaign (N+1, up to 100) | `apps/api/src/routes/whatsappOps.ts:112-438,484-492` |
| M6 | Provider / database error text reaches users: `err.message` of Meta / Google / Shopify errors in API messages; raw worker `err.message` (can be a Prisma error) stored in `sync_jobs.error`, `lastError`, alerts and emails | `routes/ads.ts:492,539`, `routes/whatsapp.ts:72`, `apps/worker/src/index.ts:147-204` |
| M7 | `audit()` runs after the change is committed and throws on failure; most routes don't catch it, so a successful change can answer 500 and a retry duplicates it | `packages/core/src/notify.ts:143`, e.g. `routes/workspaces.ts:38` |
| M8 | Unsigned WhatsApp webhook POSTs reach the database (`findMany` on ids from the payload) and `/webhooks/*` is exempt from the global rate limit | `routes/whatsappPublic.ts:116-118` |
| M9 | `upsertOrder` / `upsertProduct` / `upsertVariant` check staleness outside the write's transaction: two deliveries of one order can let the older win (`writeOrderBatch` does it right) | `packages/core/src/persist.ts:24-34,311,336` |
| M10 | `app/scopes_update` saves the new scopes before seeding the follow-up sync; if seeding throws, the retry sees nothing newly granted and the backfill never runs | `apps/worker/src/handlers.ts:569-577` |
| M11 | A final aggregate-job failure is only logged; reconcile only repairs days with no metrics row, so a stale row stays wrong silently | `apps/worker/src/index.ts:146-211` |
| M12 | `insights-dlq` has no consumer; dead-lettered messages expire unseen | `wrangler.jsonc`, `docs/deployment-cloudflare.md` |
| M13 | Meta's async insights job polls up to ~8 minutes inside a sync-queue consumer (shared with Shopify imports and WhatsApp sends) | `packages/core/src/ads.ts:288-295` |
| M14 | Meta Ads sends the user token in query strings and follows `paging.next` without checking its host; no `appsecret_proof` | `packages/core/src/ads.ts:207,243` |
| M15 | Missing indexes for hot filters: `orders(store_id, customer_key)`, `sync_jobs(status, last_activity_at)`, `whatsapp_messages(store_id, sent_at)`; cleanup of `webhook_events` / `pixel_events_seen` / `email_otps` / `funnel_visits` is a manual monthly SQL step | `schema.prisma`, `docs/RUNBOOK.md:116-121` |
| M16 | Two Meta Graph transports (ads, WhatsApp) with different auth, error and network-failure handling | `core/ads.ts:157-185`, `core/whatsapp/graph.ts:64-115` |
| M17 | Untrusted Shopify / Meta payload parsing is typed `any` (27 places, 5 file-wide `no-explicit-any` disables) | `core/normalize.ts`, `worker/handlers.ts:172`, `bulkOrders.ts:74`, `whatsapp/events.ts:38`, `whatsapp/webhook.ts:18` |
| M18 | Firebase revocation is checked on every session verification (every dashboard poll), adding latency and tying availability to Google | `apps/api/src/authProvider.ts:240-276` |
| M19 | `SESSION_SECRET` is required and checked for placeholders but nothing reads it; `MAILPIT_URL` (reroutes every email, OTP codes included) is read outside the config schema with no production guard; nothing rejects a localhost `APP_URL` or an emulator host in production | `core/env.ts:14`, `apps/cloudflare/src/index.ts:84` |
| M20 | Money in currencies with three decimals (KWD, BHD, OMR...) is cut to 2 by `Decimal(18,2)`; normalizers add `parseFloat` values before storage | `schema.prisma`, `core/normalize.ts:96-98` |

### Medium — frontend

| # | Finding | Evidence |
| --- | --- | --- |
| W1 | Health grading thresholds (trend −10 %, refund 5 / 10 %, shipping > 3 days, stock cover) live only in components, some in 2–3 copies; they can't be unit-tested and can drift from `docs/kpis.md` | `components/dashboard/overview.tsx:43-87`, `modules.tsx:164,313`, `explain.tsx:147-154` |
| W2 | Helpers copied across dashboard components, several with subtly different output (`changeWords` at zero, `upDown`, ROAS formatting, AOV "—" vs "$0.00") | `overview.tsx`, `details.tsx`, `explain.tsx`, `adsPanel.tsx`, `adsensePanel.tsx` |
| W3 | `/dashboard` loads every detail panel (≈196 KB of source) up front although they open only on click | `app/(app)/dashboard/page.tsx:8` |
| W4 | Metric tiles' `aria-label` replaces the visible figure for screen readers | `app/(app)/dashboard/page.tsx:139-145` |
| W5 | No linter: 12 `react-hooks/exhaustive-deps` disables suppress nothing and the hooks rules are never checked | repo-wide |
| W6 | Some loads report failure with `actionError` or a raw message and no retry / loading state (settings ads, integrations, API keys, members, the two ad reports) | `settings/*`, `googleReport.tsx:98-116`, `metaReport.tsx:107-125` |
| W7 | `apps/web/tsconfig.json` doesn't extend the base config, so the UI runs without `noUncheckedIndexedAccess` (439 errors if enabled, 437 in landing animations) | `apps/web/tsconfig.json` |

### Medium — tooling, CI, operations

| # | Finding | Evidence |
| --- | --- | --- |
| T1 | CI has no lint, no `pnpm audit`, no secret scan, no migration drift check, and `typecheck` regenerates the tracked `worker-configuration.d.ts` instead of checking it | `.github/workflows/ci.yml` |
| T2 | CI actions pinned by tag, not SHA; no job timeouts; no Dependabot/Renovate | `.github/workflows/ci.yml` |
| T3 | `cloudflared:latest` on the production path with `restart: unless-stopped` | `docker-compose.yml` |
| T4 | The production database role is the Postgres superuser; dev passwords (`app`/`app_rls`) are defaults in tracked files (rotation pending since the 2026-10-10 audit) | `docs/security.md:59`, `infra/postgres/init.sql:7` |

### Low (selection; full lists in the audit transcripts summarised in the refactoring report)

- Error classes without `this.name` (`HttpError`, `AdsApiError`, `ShopifyHttpError`, ...).
- Inconsistent codes: `not_connected` is 404 in some routes, 409 in others; 429 uses `rate_limited` and `too_soon`.
- `/shopify/launch` doesn't check its HMAC timestamp's freshness (the comment says it does).
- Dead or test-only exports (`MEDIUM_LABEL`, `previousRange`, ~30 exports used only in their own file).
- Duplicated helpers in core (Google error mapping ×5, Meta paging ×4, `sleep` ×2, lease pattern ×3).
- A real import cycle `tokens.ts ↔ adConnections.ts / whatsapp/store.ts` broken by `await import()`.
- `@app/shared` declared but unused in `packages/db` and `apps/cloudflare`.
- Docs drift: R2 described as bound (it isn't), Firebase "Admin SDK" and Terraform (both removed),
  incomplete secrets list, `dashboard.ts` size; `IMPLEMENTATION_STATUS.md` is a 54 KB changelog
  with stale test counts.
- Personal email addresses in tracked comments (`wrangler.jsonc`, `app/layout.tsx`, `docs/ads-setup.md`).
- `EMAIL_FROM` in production is `no-reply@bizinsights.io` (2026-10-16); SES production access is still pending.

### Checked and found sound

Tenant isolation (every tenant route calls `requireWorkspace`; client-supplied store ids are always
checked against the workspace; RLS policy on every tenant table, with a test that fails a new
table without one); webhook signatures (raw body, constant-time compare, before parsing); OAuth
(single-use state in the Durable Object + cookie, PKCE for Google); CSRF (Origin check on every
cookie-authenticated mutation and on cookie-less sign-in); no SQL injection (tagged templates
only); no stack traces to clients; secrets only server-side; money stored as `Decimal(18,2)` and
summed in SQL; at-most-once WhatsApp sends; database outages don't spend queue attempts.

## 6. Constraint: work in progress elsewhere

About ten other worktrees hold unmerged work against this code. Moving or rewriting the files they
edit would turn their merges into conflicts, so this restructuring leaves these files alone or
touches only lines they don't:

| Work | State | Files it changes that this work avoids |
| --- | --- | --- |
| Staff Management (`claude/staff-management-payroll-d95d29`) | committed 59dbdac, not merged | `apps/api/src/{app,authProvider,rateLimit}.ts` (in places), `routes/{auth,workspaces}.ts`, `core/src/{index,notify}.ts`, `shared/package.json`, `schema.prisma`, web `AppContext.tsx`, `lib/api.ts`, `(app)/layout.tsx`, `settings/members`, `verify-email`, `components/whatsapp/common.tsx`, `worker/src/index.ts`, `docs/architecture.md` |
| WhatsApp on the Ads app (`elated-raman`) | uncommitted | `routes/whatsapp.ts`, `core/whatsapp/{connect,graph,scheduler,store}.ts`, `shared/whatsapp.ts`, web WhatsApp pages and components, `wrangler.jsonc` (vars) |
| Ads completeness (`claude/ads-ws-*`, foundation 2897042) | paused | `core/{ads,adConnections}.ts`, `shared/{ads,dates}.ts`, `routes/ads.ts`, `schema.prisma`, `web lib/adConnections.ts` |
| Traffic sources (`meta-integrations-browser-automation`) | uncommitted | `core/normalize.ts` |
| Page redesign, conversion diagnosis (`page-redesign`, `zealous-wilson`) | uncommitted, based on a week-old commit, already 5,000 lines behind in these files | `routes/dashboard.ts`, `components/dashboard/*` |

This is why some findings above are documented but fixed only where the fix doesn't sit inside
those files (see the plan).
