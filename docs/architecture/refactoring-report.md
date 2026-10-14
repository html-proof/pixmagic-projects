# Refactoring report (2026-10-14)

The outcome of the restructuring planned in [refactoring-plan.md](refactoring-plan.md), on branch
`claude/project-audit-restructure-ed93a6`, starting from `4320f54` (GitHub `main`, the code live in
production). Each stage is one or a few commits that can be reverted on their own.

**Deployed 2026-10-14** (on the owner's request), rebased onto `main` `1935427` (which had merged Staff
Management), pushed as `main` `3f95d10`: Worker version `c9922ab9-bec6-43cc-bb7f-c03df08cf167` at 100%
(rollback: `1d132e71-0099-455e-ad9f-2d89f8740901`, the previous version, which runs fine on the new
schema). Before it: backup `C:UsersSebaninsights-backupsapp-auto-20261014-160531Z.dump` (verified),
then migrations `20261014120000_staff_management` and `20261014180000_hot_filter_indexes` applied with
`psql -1` + `prisma migrate resolve`. The combined tree passed lint, typecheck, unit (313) and
integration (398) tests first; the staged version passed smoke tests through the version-override header
before promotion. Its first `/readyz` answered `db:false` (a cold first connection through the tunnel
outlasting the probe's 3 s), every later one `ok`. No credential was changed.

## Summary

The codebase was already a layered modular monolith with strong tenant isolation and a good test
suite ([current-state.md](current-state.md)), so this was targeted work, not a rewrite:

- **Fixed (high):** a billing race that could drop a paying merchant to the free plan; no timeout on
  any outbound call; `OTP_PEPPER` rotation orphaning WhatsApp opt-outs; local tools defaulting to
  production's database; no backups (a verified script, which the owner schedules).
- **Fixed (medium):** request correlation and access logs; `/readyz`; logger gaps; lost scope
  backfills on retry; silently wrong daily totals after a failed aggregate; stale overwrites of
  orders/products/variants; audit failures turning successes into 500s; unsigned webhook
  lookups without a limit; a per-campaign N+1; two missing indexes; development settings accepted
  in production; no linter; CI gaps.
- **Restructured:** dashboard reporting moved out of the route into `packages/core/src/reports/`;
  one paging helper; dashboard grading rules into `@app/shared/health`; one set of dashboard
  narrative helpers; dashboard component files renamed to PascalCase; detail panels load on demand.
- **Documented:** audit, dependency map, decisions, target architecture, API overview (all 97
  endpoints), database schema and migration procedure, a feature guide, a docs index; doc drift
  fixed.

## Structure: before and after

| | Before | After |
| --- | --- | --- |
| `apps/api/src/routes/dashboard.ts` | 932 lines: 18 raw SQL statements and all shaping | 107 lines: parse, authorize, call, respond |
| `packages/core/src/reports/` | — | `sales`, `orders`, `catalog`, `ads`, `funnel`, `overview` (+ `common`, `index`); `@app/core/reports` |
| WhatsApp list paging | 4 copies in `whatsappOps.ts` | `apps/api/src/pagination.ts` |
| Request plumbing | — | `apps/api/src/requestContext.ts`; log context in `core/logger.ts`; `core/http.ts` (`withTimeout`) |
| Dashboard rules (UI) | inline in `overview/modules/explain.tsx`, some twice | `packages/shared/src/health.ts` (+ tests), `journey.ts` additions (+ tests) |
| Dashboard helpers (UI) | 2–4 copies each across 5 files | `narrative.tsx`, `adsCommon.tsx`, `chartUtils.ts`, `format.ts` (`weekdayName`) |
| Dashboard files | 16 camelCase component files | PascalCase (pure `git mv` commit); `TopicDetail.tsx` (frame) + `Details.tsx` (lazy contents) |
| Tooling | no linter | `eslint.config.mjs`, `pnpm lint`; CI: audit, lint, binding-types check, migration drift, timeouts |
| Operations | manual backups | `infra/postgres/backup.mjs` |
| Docs | 14 guides | + `docs/README.md`, `architecture/` (6), `api/`, `database/` (2), `development/` |

Files removed: none (the moved code's old homes now hold only what stays there). Dependencies
removed: `@app/shared` from `packages/db` and `apps/cloudflare` (never imported). Dependencies
added: `eslint`, `@eslint/js`, `typescript-eslint`, `eslint-plugin-react-hooks` (root, dev only).

## Commits

| Commit | Stage |
| --- | --- |
| `ec318df` | Audit documents (current state, dependency map, plan) |
| `1944234` | Request ids, access log, logger fixes, bounded `/readyz` |
| `27ef533` | Outbound timeouts, best-effort audit, unsigned-webhook limit |
| `4866b37` | Job correctness: billing race, scope backfill, failed aggregates, stale overwrites |
| `3b8c5e6` | Configuration safety: `app_dev` default, production guards, `CUSTOMER_HASH_KEY` |
| `99532c4` `0b2049f` `ee8b58b` `7deabdb` `883e0c0` `8654515` | Frontend: health rules, helpers, lazy panels, accessibility, renames |
| `ec919b6` | Reports into core, paging helper, campaign query, indexes |
| `fd48484` | ESLint and CI |
| `20c1351` | Docs and backup script |
| (this file) | Report |

## Test results

All runs on a throwaway Postgres 17 (port 5447), never the server that hosts production.

| Suite | Before | After |
| --- | --- | --- |
| Typecheck (7 workspaces) | pass | pass |
| Lint | (no linter) | pass, 0 findings |
| Unit: `packages/shared` | 115 | 171 |
| Unit: `packages/core` | 95 | 109 |
| Integration: `apps/api` | 235 | 247 |
| Integration: `apps/worker` | 130 | 135 |
| Web build | pass (38 routes) | pass (38 routes) |
| Worker bundle (dry run) | pass | pass |
| `pnpm audit` | 0 advisories | 0 advisories |
| Migration drift (schema vs migrations) | (not checked) | none |
| E2E (Playwright: real Worker under `wrangler dev`, Auth emulator, Mailpit, on their own ports) | not run at baseline | 24 tests: 23 passed, 1 flaky (Apple sign-in through the emulator's popup failed once, passed on retry; not run at baseline, so unknown whether it was flaky before) |

Checked against the running Worker (`wrangler dev`, the e2e server): `/api/readyz` answers
`{"ok":true,"checks":{"db":true,"coord":true,"tenantDb":true}}`, every response carries
`x-request-id`, a `cf-ray` header is used as the id, and the Worker's own log lines for queue
jobs carry `queue` and `messageId` (the log context works in workerd, not only in Node tests).

New tests reproduce what they fix. The billing race and the product write race **failed on the
old code** and pass now. The order write race did not happen to occur in the test's 8 rounds on
the old code, so that test is a guard, not a reproduction. The scope backfill and failed-aggregate
tests fail on the old code by construction (the behaviour didn't exist). The WhatsApp list tests
were written first and passed on the old code, then on the new.

## Performance

| Measure | Before | After |
| --- | --- | --- |
| `/dashboard` initial JS (script tags, raw / gzip) | 843,130 B / 243,735 B | 723,808 B / 217,306 B (−14.2 % / −10.8 %) |
| Detail panels | in the first load | own chunk, 125,113 B (31,164 B gzip), fetched on first open |
| `/whatsapp/analytics` JS | 748,822 B | 726,186 B (no longer pulls the sales cards) |
| All web JS chunks | 1,911,423 B | 1,896,342 B |
| Worker bundle | 5,080.67 KiB / 1,515.38 KiB gzip | 5,091.83 KiB / 1,518.85 KiB gzip (+3.5 KiB gzip: log context, timeouts, guards) |
| Campaign list | 1 + N transactions (N ≤ 100 campaigns with codes) | 2 transactions |
| Returning-customer count per order write, stale-job sweep | sequential scans as tables grow | indexed |

Not measured: API latency (no load test environment; production's latency is dominated by the
tunnel to the database).

## Before deploying this branch

1. Merge order: it merges cleanly with the Staff Management branch (59dbdac) and with the ads
   foundation commit (2897042), checked with `git merge-tree`; the WhatsApp branch's uncommitted
   diff and the ads workstreams' diffs apply on top (the ads-ws-a diff needs 2897042 first, as it
   always did). One exception: the live-updates worktree (`push-updates-live-view-refresh-2aeb7f`,
   uncommitted, started on 59dbdac while this work was under way) overlaps in 8 small hunks across
   `app.ts`, `context.ts`, `apps/cloudflare/src/index.ts`, `worker/handlers.ts` and
   `docs/architecture.md`; a simulated 3-way apply shows each is "both sides added a line" (an
   import, a constant, a doc table cell) and resolves by keeping both.
2. `npx wrangler secret list` (from `apps/cloudflare`) must not show `FIREBASE_AUTH_EMULATOR_HOST`
   or `MAILPIT_URL`: production now refuses to start with them. Production's `vars` pass the new
   guard (`APP_URL` / `API_URL` are https).
3. Back up (`node infra/postgres/backup.mjs`), then apply `20261014180000_hot_filter_indexes`
   (indexes only) per [../database/migrations.md](../database/migrations.md).
4. The usual staged upload, smoke test (now also check `x-request-id` on a response and
   `checks.tenantDb` in `/readyz`), promote.
5. No new secret is required. `CUSTOMER_HASH_KEY` is optional and defaults to `OTP_PEPPER`.

## Known issues and risks left

- **Production database on one PC** behind a tunnel: availability, backups and the superuser role
  are owner decisions ([target-architecture.md](target-architecture.md)). The backup script must be
  scheduled by the owner (RUNBOOK) and pointed at a folder that leaves the PC.
- **Shopify API version 2025-10** is at or past support; check the Partner Dashboard, then bump and
  test against a store.
- **Deferred because other branches edit the files** (details and what unblocks each:
  [target-architecture.md](target-architecture.md#what-is-left-and-what-unblocks-it)): WhatsApp
  rules still in routes, two Meta Graph transports, provider text in some messages, `any` in
  payload parsing, renames under `components/whatsapp`.
- **`apps/api/src/app.ts`** imports `@app/db` on two lines (the original line is left as is so the
  staff branch's edit of the next line merges without a conflict); fold them after that merge.
- **Case-only renames on Windows**: worktrees with uncommitted edits to the old file names
  (`page-redesign`, `zealous-wilson`) should commit before merging; git's rename detection then
  carries their edits over.
- **Not verified here**: the deployed Worker (nothing was deployed), live Shopify / Meta / Google /
  Firebase calls (tests fake them), the lazy detail panel in a real browser beyond the e2e suite.
