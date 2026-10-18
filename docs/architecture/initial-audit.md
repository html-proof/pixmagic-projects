# Architecture audit, 2026-10-18

The fourth pass over the restructuring brief (the earlier ones: 2026-10-11, 2026-10-14 in
[current-state.md](current-state.md) and [refactoring-report.md](refactoring-report.md), and
2026-10-16). Most of what the brief asks for was already in place, so this pass checked the
repository as it is (main `bc910b9`), recorded a baseline, and changed only what the checks found.
Where the code deliberately differs from the brief's reference architecture, the reason is an ADR
in [architecture-decisions.md](architecture-decisions.md).

## Baseline

| Check | Result | Evidence |
| --- | --- | --- |
| Deployed version | `bc910b9` (= `origin/main`), Lambda release 62, built 2026-10-18 10:59Z | `curl https://bizinsights.io/api/version` |
| Working tree | clean; branch `claude/bizinsights-restructure-171b3a` from `bc910b9` | `git status` |
| Typecheck | pass | `pnpm typecheck` (5 min 21 s on this PC) |
| Lint | 0 findings | `pnpm lint` (1 min 43 s) |
| Unit tests | 542 pass (shared 273, core 230, aws 39) | `pnpm test` (2 min 8 s) |
| Integration tests (real Postgres 18) | API 458 pass, 3 skipped; worker 214 pass | `pnpm test:integration` against a throwaway server (13 min 23 s) |
| Dependency audit | no known vulnerabilities (high and critical) | `pnpm audit --audit-level high` |
| Web build | pass; exported JS 2,857,822 bytes | `pnpm --filter @app/web build` |
| Import cycles | none among static imports (395 modules); one through `await import()` (3 modules) | `scripts/check-import-cycles.mjs` (added in this pass) |
| `any` in hand-written source | none (six matches, all inside comments) | `grep ": any\|as any\|<any>"` |
| Settings read outside the config schema | only the documented exceptions (`LOG_LEVEL`, database URLs, per-app Shopify secrets) | `grep process.env` in `packages/*/src`, `apps/api`, `apps/worker` |
| CI on GitHub | not running at the start: hosted Actions jobs are refused for billing since 2026-10-16 (Free plan minutes used up; they reset 2026-11-01), so deploys were by hand from `main` | check-run annotations ([../aws-deployment.md](../aws-deployment.md)) |

## Stack (verified in the repository)

| Part | Technology |
| --- | --- |
| UI | Next.js 16 (static export), React 19, Tailwind 4, `motion`, `lucide-react`; `apps/web` |
| API | Hono 4 on Node, Zod 3 for input; `apps/api` |
| Background work | queue consumers and cron sweeps; `apps/worker` |
| Runtime | one Lambda package (Node.js 22) deployed as three functions: `api`, `jobs`, `cron`; `apps/aws` |
| Database | PostgreSQL 17 on RDS (Multi-AZ), Prisma 7.10, row-level security for tenant reads |
| Sign-in | Amazon Cognito (email and password, Google), codes mailed through Resend |
| Queues and schedules | SQS (sync, webhooks, aggregate, email) with a dead-letter queue; EventBridge Scheduler |
| Coordination, payloads, assets | DynamoDB (rate limits, OAuth state, locks), S3 (large webhook bodies, the static UI) |
| Edge | CloudFront with AWS WAF, Cloudflare in front of bizinsights.io |
| Infrastructure | AWS CDK (edge, data, app, auth, CI stacks), deploy/smoke/rollback scripts; `infra/cdk` |
| Integrations | Shopify Admin GraphQL + bulk operations, Meta Marketing API, Google Ads API, AdSense, WhatsApp Cloud API, Gmail/Microsoft mail |
| Tests | Vitest (unit, integration), Playwright (e2e), CDK synth tests |
| Tooling | pnpm workspaces, TypeScript strict, ESLint (TypeScript, React hooks), GitHub Actions |

## Findings

Severity: **High** can cost data, money or access; **Medium** makes a failure likely or hard to
see; **Low** slows work on the code. Status is as of this pass.

| # | Severity | Area | Finding | Evidence | Status |
| --- | --- | --- | --- | --- | --- |
| A1 | High | Operations | CI doesn't run (GitHub billing), so nothing checks a merge before it is deployed by hand | check-run annotation "job was not started because recent account payments have failed..." | The PC's own runner went live during this pass (2026-10-18 11:52Z, [pull request 87](https://github.com/html-proof/pixmagic-projects/pull/87), `vars.SELF_HOSTED_RUNNER`). Its first run on `main` failed at the e2e job's browser download (the PC's IPv6 resolves but doesn't connect); [pull request 90](https://github.com/html-proof/pixmagic-projects/pull/90) gives it browsers kept on the PC. This pass also replayed CI locally (below). |
| A2 | Medium | Security, integrations | The Meta Ads client sent the user's access token in the query string of every Graph API GET (and followed paging links that carried it): URLs end up in logs, traces and error reports | `core/ads.ts` `metaGet` (`access_token` in `params`) | **Fixed**: `core/metaGraph.ts` sends it as `Authorization: Bearer`, strips `access_token` from paging links and form bodies. Checked against graph.facebook.com: a bogus bearer token gets 190 "Invalid OAuth access token" on `/me`, `act_<id>/insights` (GET and POST), `debug_token` and `DELETE me/permissions/ads_read`, so the header is read everywhere the ads code calls. |
| A3 | Medium | Integrations | Two Meta Graph transports with different failure handling. On the ads side a network failure or timeout escaped as a raw `TypeError` (the API answered a generic 500 instead of "Meta is busy, try again") | `core/ads.ts` `metaCall`, `core/whatsapp/graph.ts` `graph` | **Fixed**: one `graphCall()` for both; each keeps its own classification (`AdsAuthError` / `AdsRetryableError` / `AdsApiError`; `WhatsappApiError` + `classifyGraphError`). An outage is now `AdsRetryableError`. |
| A4 | Low | Integrations | A 200 answer from Meta that isn't JSON (an error page) read as an empty result: "no ad accounts" on the ads side, a `TypeError` in `waSendTemplate` on the WhatsApp side | `res.json().catch(() => ({}))` / `json as T` | **Fixed** in `graphCall` (it's a failure with the page's first 300 characters). Test: `packages/core/test/metaGraph.test.ts`. |
| A5 | Low | Structure | A hidden import cycle: `tokens.ts` loaded `adConnections.ts` and `whatsapp/store.ts` with `await import()` because both import it; nothing checked for cycles | `core/tokens.ts` `reencryptAllTokens` | **Fixed**: `reencryptAllTokens` is in `core/keyRotation.ts`; `pnpm lint` runs `scripts/check-import-cycles.mjs` (dynamic imports included). |
| A6 | Medium | Structure | Files holding several jobs, hard to review and the usual place for merge conflicts | lines: staff employee page 1,548; staff timesheets page 1,184; staff settings page 971; `core/whatsapp/events.ts` 887; `core/ads.ts` 834; team page 815 | **Fixed**: split by platform, by event and by tab or section (table below). Code moved line for line. |
| A7 | Low | Frontend | `TimesheetList` (the timesheets API's page) defined twice, identically | staff employee and timesheets pages | **Fixed**: one type in `lib/staff.ts`. |
| A8 | Low | Testing | No browser test opened the employee page's tabs or the staff settings page | `apps/web/e2e/staff.spec.ts` | **Fixed**: the staff e2e now opens all seven tabs (and checks the approved shift and its audit entry) and the five settings sections. |
| A9 | Medium | Structure | `apps/worker/src/handlers.ts` (1,313 lines: every queue's handlers) and `core/normalize.ts` (807) | file sizes | **Fixed** in the follow-up, once the data accuracy work had merged: `apps/worker/src/handlers/` (common, shopifyRead, sync, webhooks, aggregate, sweeps, integrations; `handlers.ts` re-exports the same 26 names) and Shopify's GraphQL documents out of `normalize.ts` into `core/shopifyQueries.ts`. Moved line for line; worker integration 234/234. |
| A10 | Low | Frontend | Single very long components: `staff/payroll/period/page.tsx` (one 625-line component), `components/dashboard/SalesBreakdown.tsx` (679) | file sizes | **Fixed** in the follow-up: the pay run page's sections are components in `components/staff/payroll/` (the JSX moved verbatim, page state arrives as props), guarded by a new `e2e/payroll.spec.ts` that passed before and after; the sales chart is `components/dashboard/ColumnsWithTotal.tsx`. |
| A11 | Low | Structure | `core/adConnections.ts` (526 lines) mixes the OAuth hand-off, tokens, sync, reports and revocation | file | **Fixed** in the follow-up: `core/adConnections/` (config, credentials, connect, sync, reports); `adConnections.ts` re-exports the same names and keeps `aad` inside the folder. |
| A12 | Low | Security | No `appsecret_proof` on Meta calls (a leaked token works without the app secret) | `core/metaGraph.ts` | Owner decision: it needs "Require App Secret" decided per Meta app, and a merchant's own WhatsApp app has a secret bizinsights doesn't hold. One line in `graphCall` once decided. |
| A14 | Low | Product | An employee's Audit History never shows their hours being approved: approvals are audited once per batch for the workspace (`staff.hours_approved`, no `targetId`), and the history lists only rows targeted at the employee, although the UI has a label for it | `core/staff/attendance.ts` (approve), `core/staff/employees.ts` `employeeAudit` | Found by the new e2e check. **Fixed** in a follow-up: one `staff.hours_approved` row per employee, targeted at them, with their own shift count and ids; a removed scheduled shift (`staff.schedule_deleted`, which had no target either) now names the employee and when it was to start. Rows written before the fix stay workspace-only. Tests: `apps/api/test/staff.test.ts` ("an employee's audit history"), the staff e2e checks "Hours approved". |
| A13 | Info | Tooling | No Prettier or import sorting | repository | Not introduced: reformatting every file would conflict with every open branch, and ESLint with TypeScript strict already fails the build on what matters. Worth doing once, at a quiet moment, as a commit of its own. |

Areas the brief asks about that were checked and need nothing new now:

- **Tenant isolation**: every tenant read goes through `withTenant` (Postgres RLS as a second guard)
  and `requireWorkspace`; `apps/api/test/tenancy.test.ts` and isolation cases in 14 other test
  files (team, staff, email, WhatsApp, privacy, shopify...) cover another workspace's stores,
  metrics, shared links, staff and integration tokens.
- **Errors**: one shape (`{ error, message }`, request id in `x-request-id`), `AppError` for rule
  violations, provider text only through `providerDetail()` ([ADR-004](architecture-decisions.md#adr-004-keep-the--error-message--error-shape-add-a-request-id)).
- **Configuration**: one Zod schema (`core/env.ts`) that refuses published placeholder secrets,
  emulators and local URLs in production; secrets in Secrets Manager ([ADR-007](architecture-decisions.md#adr-007-configuration-stays-per-consumer-not-per-environment-file)).
- **Deployment verification**: `infra/cdk/scripts/smoke.mjs` fails unless `/api/version` reports
  the deployed checkout's commit and the `api` alias's Lambda version; failed deploys roll back
  to the recorded versions.
- **Shopify data accuracy** (metric definitions, reconciliation, idempotent ingestion): being
  worked on by its own session (branch `claude/bizinsights-data-accuracy-2f7189`), so not touched
  here.
- **API versioning, client store library, `features/` folders, a separate workers app**: decided
  against, with the conditions that would change that, in ADR-001, ADR-002, ADR-003 and ADR-005.

## What changed in this pass

| Before | After |
| --- | --- |
| `core/ads.ts` (834 lines, three platforms) | `core/ads/`: `common.ts` (errors, account and token types), `meta.ts`, `googleOAuth.ts`, `googleAds.ts`, `adsense.ts`; `ads.ts` re-exports them (the same 42 exports, plus 2 now shared between files) |
| Meta Graph calls in `core/ads.ts` and `core/whatsapp/graph.ts` | `core/metaGraph.ts` (`graphCall`): one transport, token in the header |
| `core/whatsapp/events.ts` (887 lines) | the webhooks' entry point (83 lines) and `core/whatsapp/events/`: `context.ts`, `timeline.ts`, `orders.ts`, `checkouts.ts`, `shipments.ts`, `redact.ts`; the same ten public names |
| `reencryptAllTokens` in `core/tokens.ts`, loading three modules lazily | `core/keyRotation.ts`, plain imports; `tokens.ts` keeps `reencryptStoreTokens` |
| `app/(app)/staff/employee/page.tsx` (1,548 lines) | the page (130) and `components/staff/employee/`: `EmployeeHeader`, `OverviewTab`, `AttendanceTab`, `TimesheetsTab`, `PayrollTab`, `PaymentsTab`, `ScheduleTab`, `AuditTab` |
| `app/(app)/staff/timesheets/page.tsx` (1,184 lines) | the page (86) and `components/staff/timesheets/`: `ShiftsTab`, `ShiftDetail`, `ShiftModals`, `RequestsTab`, `format.ts` |
| `app/(app)/staff/settings/page.tsx` (971 lines) | the page (34) and `components/staff/settings/`: one file per section, `SettingsUi.tsx` |
| `app/(app)/team/page.tsx` (815 lines) | the page (445), `components/team/MemberRow.tsx`, `components/team/TeamUi.tsx` |
| no cycle check | `scripts/check-import-cycles.mjs`, run by `pnpm lint` |

Moves were checked mechanically: the sorted code lines of each file before and after are the same
(only section-title comments, which the new file names carry, were dropped), every export of the
split modules is still exported, and the web build's JavaScript is the same size within 115 bytes
per route (module names and hashes).

## Final verification

On this branch, on the owner's PC (the same checks CI runs; GitHub's run on the pull request is the
record of the merged tree):

| Area | Result | Evidence |
| --- | --- | --- |
| Lint and import cycles | pass: 0 findings, no cycle in 429 modules | `pnpm lint` |
| Typecheck | pass | `pnpm typecheck` |
| Unit | 548 pass (shared 273, core 236, aws 39); 6 of them new (`metaGraph.test.ts`) | `pnpm test` |
| Integration (real Postgres 18) | API 458 pass, 3 skipped; worker 214 pass: the same as `main` | `pnpm test:integration` |
| End to end | 32 pass: 31 in the full run, plus the staff test after its new Audit History check was corrected (A14) | `pnpm e2e` (local server, Cognito emulator, Mailpit stand-in) |
| Dependency audit | no known vulnerabilities | `pnpm audit --audit-level high` |
| Production build | pass; exported JS 2,857,756 bytes (`main`: 2,857,822) | `pnpm --filter @app/web build` |
| Meta Graph header auth | a bogus bearer token is refused as a token (190) on every Marketing API call the ads code makes | `curl` against graph.facebook.com, no credentials |
| AWS deployment | through `main`: CI on the PC's runner, then Deploy to AWS (cdk deploy, migrations, smoke tests, rollback on failure) | the Deploy run for the merge commit |
