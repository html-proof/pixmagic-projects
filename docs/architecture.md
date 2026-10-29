# Architecture and conventions

How the code is organised, where new code goes, and the conventions it follows. For running it see
[local-dev.md](local-dev.md); for production see [aws-deployment.md](aws-deployment.md) (AWS, where
every merge to `main` deploys) and [RUNBOOK.md](RUNBOOK.md).

## The shape of the system

The application code runs on AWS (`apps/aws`, `infra/cdk`) and, for development, the demos and
e2e, as one local Node process (`apps/aws/src/local.ts`). Only the thin entry that wires it to its
surroundings differs.

```
                        AWS                                   local server
browser ──► CloudFront + WAF ──► Lambda "api"           or  Node HTTP server
              /api/*, /webhooks/*, /pixel/*, /shopify/*  ──► Hono app (apps/api)
              everything else                            ──► static UI (apps/web, Next.js static export)
                                                             (if the function can't answer: apps/web's /unavailable page, from S3)

jobs   SQS (sync, webhooks, aggregate, email, smsEvents, whatsapp) ──► Lambda "jobs"   or  in-process queues ──► consume()       (apps/worker)
cron   EventBridge Scheduler (*/15, 03:15)    ──► Lambda "cron"   or  POST /__scheduled ──► runScheduled()  (apps/worker)

apps/api and apps/worker ──► packages/core (Shopify, Meta, Google, WhatsApp, email, staff, persistence)
                         ──► packages/db   (Prisma; RDS PostgreSQL on AWS, a local Postgres in development)
everything               ──► packages/shared (pure logic, no I/O)
```

Platform services sit behind interfaces in `Deps`, so the code never names a vendor: the
coordinator (`Coord`: rate limits, OAuth state, locks) is DynamoDB on AWS and memory locally; large
webhook bodies (`Blobs`) are S3 or memory; mail (`Mailer`) is SES or Mailpit; queues (`Queues`) are
SQS or in-process.

Database connections are process-wide pools (`DATABASE_URL`, `APP_DATABASE_URL`); `withDb()`
(packages/db) runs a call on connections of its own, which tests use to simulate an outage. The two
Prisma clients are built once per process (building one costs ~25 ms of CPU) and run each statement
on the current scope's connections, batching queries only within one scope (`scopedAdapter`,
`scopedQueues`).

## Packages: what goes where

Each package may import only the ones above it in this table, never one below.

| Package | Holds | Must not |
| --- | --- | --- |
| `packages/shared` | Pure functions and constants: KPI formulas, dates, roles and permissions, HMAC/AES, WhatsApp template rules, Zod schemas shared by API and UI, the staff pay/time engine (`@app/shared/staff`), the email rule and template engine (`@app/shared/email`), Customer Messaging's SMS rules (`@app/shared/sms`: parts and encoding, variables, consent, delivery statuses), the Automations hub's trigger catalog and status scale (`@app/shared/automations`), the Google Ads demo's generator and the Google Ads analytics figures (`adsDemo.ts`, `adsAnalytics.ts`). Browser-safe subpath exports (`@app/shared/roles`, `/dates`, `/whatsapp`, `/staff`, `/email`, ...). | Do I/O, read env, import Prisma. The UI imports subpaths only: the root barrel pulls `node:crypto` into the browser. |
| `packages/db` | Prisma schema, migrations (with RLS policies), `systemDb` / `tenantDb` / `withTenant` / `withDb`. | Contain business rules. |
| `packages/core` | Everything that talks to the database or an outside API on the app's behalf: Shopify client and sync (the GraphQL documents in `shopifyQueries.ts`), token encryption and key rotation (`keyRotation.ts`), normalizers, persistence and aggregates, alerts and audit, ad platforms (`ads/`: one client per platform, and `googleAdsSource.ts`, the source a Google Ads connection reads from: Google's API, or the generator behind the Google Ads demo, [ads-demo.md](ads-demo.md); `adConnections/`: connected accounts, their tokens, sync and reports, `demo.ts` the demo connection), WhatsApp, email integrations (`email/`: OAuth, SMTP, delivery, rules; docs/email.md), the Inventory module (`inventory/`: stock levels and locations, alerts, stock changes, its reports; docs/inventory.md), Customer Messaging (`sms/`, imported as `@app/core/sms`: SMS through AWS End User Messaging behind an `SmsProvider`; docs/sms.md), the Automations hub (`automations/`, imported as `@app/core/automations`: one adapter per channel over the SMS and email engines, the merged history; docs/automations.md), Zapier (`zapier/`, imported as `@app/core/zapier`: bizinsights as the OAuth provider of its Zapier app, the event outbox and its deliveries; [zapier.md](zapier.md)). Every Meta Graph API call, ads and WhatsApp alike, goes through `metaGraph.ts` (token in the Authorization header, paging links only to graph.facebook.com). The config schema (`env.ts`) and logger. | Know about HTTP requests or queues' delivery mechanics. |
| `apps/api` | HTTP: routing, auth, permission checks, input validation, response shapes. | Hold business logic that a job or another route could need: put it in core. |
| `apps/worker` | Queue consumers and cron sweeps (`src/handlers/`: one module per job, re-exported by `handlers.ts`): retries, backoff, failure bookkeeping, then a call into core. `ops/` holds one-off maintenance tasks (RUNBOOK.md). | |
| `apps/aws` | The Lambda entry (one build, three functions: api, jobs, cron; plus `cognitoEmail.ts`, its own small entry in the same package for the Cognito pool's email trigger): loads secrets at cold start, wires DynamoDB, SQS, S3 and SES into `Deps`, serves the UI and the API on one origin, gives every outbound call its timeout (`withTimeout`), runs migrations on request. The app's shared settings (`settings.ts`) and the local server (`local.ts`, `dev.ts`, `localQueues.ts`), which wires the same app to in-process stand-ins. | Contain logic beyond that wiring. |
| `infra/cdk` | The AWS infrastructure as code (edge, data, app, auth, WhatsApp and CI stacks) and the deploy, data-copy, smoke-test and rollback scripts. | Hold application code. |
| `apps/web` | The UI (see [Frontend](#frontend-appsweb)). Depends on `@app/shared` only; talks to the API over HTTP. | Import core/db, or compute KPIs the API already returns. |

Where a new piece of code goes:

- A calculation, rule or label used by both the API and the UI → `packages/shared`.
- Anything that reads or writes the database or calls Shopify/Meta/Google → `packages/core`, as a
  function the route or job calls.
- A new endpoint → a route in `apps/api/src/routes/` that validates, authorizes and calls core.
- Work that may take longer than a request, must retry, or runs on a schedule → a queue job or a
  sweep in `apps/worker`, calling core.
- A screen → a page in `apps/web/src/app/`, built from components in `apps/web/src/components/`.

## API conventions (`apps/api`)

- **Routes** are grouped by area in `src/routes/<area>.ts`, each exporting `<area>Routes(app, deps)`,
  registered in `src/app.ts`. `deps` (`context.ts`) carries everything with side effects (auth
  provider, queues, coordinator, mailer, fetch), so tests substitute fakes.
- **Auth and tenancy**: `requireUser(c, deps)` for the signed-in user; `requireWorkspace(c, deps,
  ws, need)` for anything in a workspace. `need` is a workspace permission (`@app/shared/roles`) or
  one or more Team & Access permissions (`@app/shared/access`); owners and admins hold all of the
  latter, other members only what was granted to them ([team-access.md](team-access.md)). The UI asks
  `allowed(need)` (`useApp()`) for the same thing to decide what to show; `can(role, …)` is for owner
  and admin rights only and is false for every other role.
- **Reads** go through `withTenant(workspaceId, tx => ...)` (Postgres RLS as a second guard);
  `systemDb` bypasses RLS and is for auth bootstrap, webhooks, jobs and writes that already scoped
  by workspace and store.
- **Input**: `z.object(...).parse(await body(c))` for JSON, the same for `c.req.query()`. A Zod
  failure becomes a 400 `validation` response automatically.
- **Errors**: throw `HttpError(status, message, code)` for anything the client should be told; the
  response is always `{ "error": code, "message": text }`. Core signals a rule the person broke, or
  a step they must take first, with a subclass of `AppError` (`StaffError`, `EmailError`,
  `WhatsappError`, ...): it carries its status and code, and `onError` answers it as is, so a route
  doesn't catch and re-throw it. Anything else reaches `onError`, which logs it and answers a
  generic 500. Map other known errors (e.g. `StoreDisconnectedError`, `AdsAuthError`) to an
  `HttpError` explicitly; never forward a raw `err.message`: it can carry database or provider
  internals. A provider's own reason (Meta, Google) may be shown only through `providerDetail()`.
  Machine endpoints (Shopify/Meta webhooks, the pixel) may answer `{ "error": code }` only.
- **Rate limits**: `limit(deps.coord, key, LIMITS.x)` from `rateLimit.ts`; a global per-IP limit
  runs as middleware.
- **Audit**: user-visible changes to a workspace call `audit()` (core) after the change.
- **Alerts**: `raiseAlert()` (core) for something a person must fix, resolved by whatever fixes it
  (`resolveAlerts`). Its message goes to the logs only: the bell in the top bar
  (`GET /workspaces/:ws/alerts`) and the admins' alert email (`alertEmail`) word each alert from its
  code and link to the page that fixes it (`describeAlert`, `ALERT_PATH` in `@app/shared/alerts`), so
  a new code needs its wording there. The Slack post carries the code and the alert's id, which
  finds the "alert raised" log line with the message.

## Worker conventions (`apps/worker`)

- A queue message is processed by `consume()`; a job that throws is retried with backoff up to
  `MAX_ATTEMPTS` (the SQS queues' `maxReceiveCount` in infra/cdk stays above it), then recorded as failed
  and alerted. A failure while Postgres is unreachable spends no attempts (`deferForDb`).
- Handlers must be idempotent: Shopify and SQS both deliver at least once.
- What Shopify and Meta send (webhook payloads, GraphQL pages, bulk JSONL, the WhatsApp webhooks)
  is checked once where it enters, against Zod schemas: `core/shopifyPayloads.ts` (`parseShopify`,
  `parseShopifyList` for a page), `core/whatsapp/cloud.ts` (Meta's WhatsApp webhook) and
  `core/whatsapp/cloudApi.ts` (Meta's answers to WhatsApp's calls); until release 2 removes it,
  `core/whatsapp/webhook.ts` for what a QR-linked phone's Evolution API instance still posts.
  What doesn't fit is logged (field paths, never values) and skipped, not thrown: a retry would only
  meet the same payload again. The WhatsApp and email automations read an order or checkout only
  once they are about to act on it, so a store that doesn't use them logs nothing about it. The
  exception is the GDPR topics: a `customers/redact` or `customers/data_request` that can't be read
  fails at once (`UnrecoverableError`: recorded as failed and alerted), never marked as done.
- Each cron sweep runs on its own: one that throws is logged and the rest of the tick still runs.
- `UnrecoverableError` ends retries at once (revoked access, a store that is gone).

## Frontend (`apps/web`)

```
src/app/            routes (App Router). (app)/ is the signed-in shell: AppProvider + AppShell (top bar, sidebar).
                    portal/ (employee self-service) and join/ (employee invitations) sit outside it:
                    employees aren't workspace members. Staff Management: docs/staff.md.
src/components/     UI. dashboard/, funnel/, whatsapp/, email/, staff/, team/, landing/ per area; app-wide pieces at
                    the top (AppUi.tsx: page header, skeleton, toasts, useAction, confirm dialog; ui.tsx:
                    Alert, EmptyState, AuthShell). A page with several tabs or sections keeps only
                    their routing and state; the tabs and sections are components in
                    components/<area>/<page>/, a file each (staff/employee/, staff/timesheets/,
                    staff/settings/) or one file for small read-only ones (staff/payroll/).
src/hooks/          animation hooks for the landing page.
src/lib/            non-UI modules: the API client and hooks, sign-in (auth.ts: every call to /api/auth), storage, types of
                    API responses shared by several pages.
```

**Data and state.** There is no global store library, and none is needed: the server is the source
of truth and almost every screen is "load, show, edit, save".

| State | Where it lives |
| --- | --- |
| Server data | `useApi(path)` (`lib/api.ts`): each answer is kept with the request it answers, transient failures retry by themselves, `reload()` and `setData()` for edits. `useLiveApi(path, ms)` for data that must stay live (the dashboard). |
| Session, workspaces, current workspace and store | `AppContext` (`useApp()`), signed-in pages only. |
| The dashboard's date range, its comparison and open detail | The URL (`?preset=&from=&to=`, `?compare=&cfrom=&cto=`, `?view=`), so a link reproduces the view. The Advertising area (/advertising, [advertising.md](advertising.md)) reads the same dates and adds `?platform=&account=`; the Shopping Funnel (/funnel, [kpis.md](kpis.md) "Shopping Funnel page") adds `?device=&visitor=&landing=&country=`. |
| Per-device preferences | `lib/storage.ts` (`readLocal` / `writeLocal`): never throws, so blocked storage only loses the preference. |
| Form drafts | Component state. |

Write a hand-made `api()` call in an effect only when `useApi` can't express it (paging with
"load more", a request fired by a button), and then guard against late answers: keep the answer
with the request it belongs to, or ignore any response that isn't the latest (see
`components/dashboard/Contacts.tsx` and the audience count in `components/whatsapp/Campaigns.tsx`).

The API response reader (`lib/apiResponse.ts`) owns `ApiError`, body parsing and error-envelope
normalization. It has no React dependency, so response failures can be tested independently.
`lib/api.ts` re-exports the same error class and retains session, access-change and retry behavior.

**Loading and errors.** While loading: `Skeleton`. When a load fails: `LoadError` (says what failed,
treats an outage calmly, offers Try again), including when a *second* load on the page fails. A
failed action (save, delete): `actionError(e, "what you tried")` in a toast or an `Alert`. A crash
while rendering is caught by `app/(app)/error.tsx` inside the shell, or `app/error.tsx` for public
pages. Unknown paths get `app/not-found.tsx`.

**Fonts and prefetch.** Only the landing page, the split-card auth pages (`AuthSplitShell`) and the
legal pages (`LegalPage`: /support, /privacy, /terms, /data-deletion) are in Geist. Prefetching one of
those routes makes the current page preload Geist and its stylesheet, and Chrome then warns that they
were "preloaded but not used", and warns again a few seconds after every later request while they
stay unused. So a link from any other page to one of them is `<Link prefetch={false}>`. Geist Mono is
the landing page's alone: each font has its own CSS chunk (`cssChunking` in next.config.ts), so the
sign-in and legal pages' links to `/` (header and footer) are `prefetch={false}` too. The build fails
if a page preloads a font its markup doesn't use (scripts/check-font-preloads.mjs), and
e2e/console.spec.ts fails on any unused preload, CSP report or console error on the signed-in,
sign-in and legal pages.

**A clean console.** Chrome logs every response of 400 or more as a console error, so a state the
page expects is not an error response. Who is signed in comes from `getMe()` (lib/apiClient.ts):
GET /auth/whoami answers a visitor with `user: null` and a 200, where /me would answer 401 on every
app page a signed-out visitor opens. A refusal (a wrong code, a cancelled sign-in, an expired link)
stays a 4xx.

**Business logic.** Pages and components format and arrange what the API returns; rules and
calculations belong in `@app/shared` (shared with the API) or the API itself. The dashboard's
health grading lives in `@app/shared/health` and its drop-off and landing-page maths in
`@app/shared/journey` (the Shopping Funnel page's transitions, segments, tests and observations in
`@app/shared/funnel`); the repeated sentence pieces are in `components/dashboard/Narrative.tsx`.
When a page needs to know what the API will allow (what a template draft breaks), it asks the same
function the API uses (`waTemplateIssues` in `@app/shared/whatsapp`) rather than writing the rule
out again.
Detail panels load on demand (`components/dashboard/TopicDetail.tsx`): keep code that only a click
needs out of the page's first load.

**Landing page motion.** On integrated graphics the page drops frames on GPU work, not JavaScript,
so every effect has to be cheap for the GPU process. Many laptops also refresh at 120–144 Hz, which
leaves 7–8 ms per frame:

- Nothing may make the browser scroll on the main thread: no `background-attachment: fixed` (the
  app-wide washes sit on a fixed `body::before` layer instead) and no non-passive wheel or touch
  listeners. A fixed background made every scroll frame repaint the whole window.
- Anything whose transform or opacity follows the scroll gets its own layer (`lp-layer`), so the
  GPU moves it instead of the browser repainting the area around it. Avoid animating `filter`,
  `backdrop-filter`, `mask-image`, `border-radius`, `clip-path` or colours on large elements:
  each frame of those is a repaint. No `backdrop-filter` on the fixed nav: what scrolls under it
  changes on every frame, so it was re-blurred on every frame.
- Particles go through `components/landing/shared/particles.ts`: one batched WebGL draw per frame
  (2D fallback included), set up in idle time after the intro. Don't stamp hundreds of shapes with
  the 2D canvas API. `hooks/useCanvasLoop.ts` draws at most every 9.5 ms (every other frame on a
  120–144 Hz screen); hide a canvas layer while it has nothing on it.
- Ambient loops are composited CSS animations (`lp-loop`, paused off screen by `usePauseWhenHidden`),
  one animation per moving element: while the page draws frames for anything else, Chrome updates
  the style of every running animation on each of them. No SVG `stroke-dashoffset`/SMIL loops, no
  `offset-path` (it runs on the main thread: sample the path into transform keyframes, as
  `HeroFlows` does) and no motion `repeat: Infinity` (it runs in JavaScript on every frame).
- Wheel scrolling is eased by `hooks/useSmoothScroll.ts` (Lenis) on 60 Hz-class screens only; faster
  screens keep the browser's own smooth scrolling, which doesn't wait for the main thread. Either
  way scroll-driven scenes follow the scroll directly: don't add `useSpring` on top of scroll progress.

## Configuration

| Setting | Lives in | Read by |
| --- | --- | --- |
| App settings (public: app ids, API versions, scopes, flags) | `apps/aws/src/settings.ts` (shipped in the functions' package, put in `process.env` at cold start by `apps/aws/src/index.ts`; not in the 4 KB environment); locally overridden by `apps/aws/.env` | `env()` in `packages/core/src/env.ts` |
| Secrets (session, encryption keys, client secrets) | Secrets Manager `insights/production/*`, set with `infra/cdk/scripts/put-secrets.mjs` ([aws-deployment.md](aws-deployment.md)); locally `apps/aws/.env` (from `.env.example`) | `apps/aws/src/secrets.ts` at cold start, into `process.env`, then `env()` |
| Services (queues, coordinator, payload store, mail) | infra/cdk (queue URLs, table, bucket, SES region in the functions' environment) | `apps/aws/src/index.ts` (AWS) or `local.ts` (local), passed as `Deps` |
| Sign-in (Amazon Cognito: pool, client, domain; the client secret) | the Auth stack (`infra/aws/cognito.yaml` via infra/cdk), into the runtime parameter and a secret ([cognito-setup.md](cognito-setup.md)) | `cognitoConfig()` in `apps/api/src/cognito.ts` |
| AWS settings (URLs, ids, flags) and infrastructure choices | SSM parameter `/insights/production/runtime`; CDK context (`infra/cdk/lib/config.ts`, `cdk.json`, the deploy workflow's `-c` flags) | `apps/aws` at cold start; `infra/cdk` at deploy |
| Feature flags for unfinished work | `apps/web/src/lib/features.ts` | the UI |
| Local tooling (docker compose, Prisma CLI, `ops:*` tasks) | repo-root `.env` (from `.env.example`) | those tools only |

`env()` validates the whole app config with Zod on first use and, in production, refuses to
start with a secret still set to a value published in this repository, or with a development
setting that turns a safeguard off (the Auth emulator, a Mailpit relay, a local `APP_URL`). New
settings go into its schema with a default (or as required), then into `apps/aws/src/settings.ts`
(or, for a secret, `put-secrets.mjs`) and `apps/aws/.env.example`. A new provider with a public id
and a secret also adds that pair to `providerCredentials` in `packages/core/src/configReport.ts`,
so the deploy's config check warns when the id is set and the secret isn't (and a shape for the
secret to `put-secrets.mjs`, if it has a recognisable one). Code reads settings through
`env()`, not `process.env`. The exceptions are deliberate: the logger (`LOG_LEVEL`), the database
connections (`DATABASE_URL` / `APP_DATABASE_URL`), per-app Shopify secrets whose names are dynamic
(`SHOPIFY_APP_SECRET_<KEY>`), and `apps/aws`, which puts the secrets into `process.env` at cold start
and reads the Lambda's own settings (queue URLs, bucket, table, region) before `env()` can run.

Local tools and the local server use the `app_dev` database; production's `app` is only ever reached
by pointing `DATABASE_URL` at it on purpose ([ADR-008](architecture/architecture-decisions.md#adr-008-defaults-that-can-only-reach-production-on-purpose)).

## Naming

- **Files**: React component files are PascalCase (`StoreHeader.tsx`, `LoadError.tsx`, and modules of
  several components such as `WaUi.tsx`, `Primitives.tsx`); modules of helpers, hooks,
  constants or types are camelCase (`format.ts`, `storage.ts`, `heroLayout.ts`). `ui.tsx` (app-wide
  and in `components/staff`, `components/landing/shared`) is the one fixed name. Rename a file as a
  commit of pure `git mv` renames, imports in the next commit: git carries other branches' edits
  across a pure rename; a rename mixed with edits turns them into conflicts.
- **Exports**: components and helpers are named exports; only Next.js pages, layouts and boundaries
  use default exports.
- **Errors**: `XxxError extends Error` (or `AppError`, for a rule the person broke) and sets
  `this.name`, so logs say which.
- **API**: route files by area (`routes/smsAutomations.ts`), registration functions `<area>Routes`.
- **Relative imports inside packages** use the `.js` extension (`./dates.js`), except in the
  `packages/shared` modules the UI imports by subpath (`ads.ts`, `sales.ts`): Next's bundler does
  not map `./dates.js` to `dates.ts` in a workspace package, so those stay extensionless.

## Tests

| Kind | Where | Runs with |
| --- | --- | --- |
| Unit (pure logic, config files, AWS adapters, the local server) | `packages/shared/test`, `packages/core/test`, `apps/aws/test` | `pnpm test` |
| Infrastructure (synthesized stacks) | `infra/cdk/test` | `pnpm --filter @infra/cdk test` |
| Integration (real Postgres, faked Cognito/Shopify/Meta) | `apps/api/test`, `apps/worker/test` | `pnpm test:integration` (database `*_test`; `TEST_PG_PORT` points it at a throwaway server) |
| End to end (Playwright against the local server) | `apps/web/e2e` | `pnpm e2e` |
| Lint (TypeScript, React hooks) and import cycles | everywhere | `pnpm lint` (CI fails on any finding; `scripts/check-import-cycles.mjs` fails on any module that imports itself through others, `import()` included) |

A bug fix comes with the test that would have caught it. CI also checks the dependency audit, that
the migrations produce exactly `schema.prisma`, and that the Lambda package builds.

## Known structural debt

### Frontend transport and recovery

`lib/api.ts` remains the compatibility entry point. HTTP transport, shared-tab session selection,
permission signals and `ApiError` now live in `lib/apiClient.ts`; React data hooks and polling live
in `hooks/useApi.ts`; number formatting lives in `lib/format.ts`. Both entry points use the same
error class. Transport changes must retain auth challenge data, access-fingerprint notifications,
and suppression of late shared-session sign-outs. Public customer links omit credentials and
never change merchant permissions or session state.

`ErrorState`, `ErrorNotice` and `PublicLinkError` provide recovery views; the last keeps customers
on the store's public link. Every error card (the 404 page, crashes, failed loads, customer links) is
`ErrorPanel` in `components/ErrorState.tsx`: the status code in the logo's green, or an illustration
for a failure without one, and a `fullPage` one sits in the site's frame (`ErrorPage`), so a new error
screen uses it rather than a design of its own. The access screens (access revoked or ended, a shared
dashboard closed: `components/team/AccessStates.tsx`) use it too, with a word in place of a code.
`app/unavailable` is the page CloudFront shows at any page's address while the server can't answer;
the AWS build moves it to the site bucket, so it must work without the API (no API calls; support is
a mail link). Retry-After hints disable manual retries and delay automatic retries.
Use `pnpm --filter @app/web test` for transport and recovery tests and
`pnpm --filter @app/web test:errors-ui` for browser checks independent of Postgres and Cognito.

`pnpm check:boundaries` enforces package dependencies in the seven source trees, including the
current AWS entry point. It checks static imports, re-exports and literal dynamic imports or
require calls; computed imports are outside its scope. Frontend code must use browser-safe
shared subpaths rather than the server barrel. Existing state ownership and the shared health
grading API remain unchanged.

The planned moves are all done (below, by date); what is left needs a decision or a pass of its own,
for the reason given on each item. (Done in the 2026-10-14 restructuring:
dashboard reporting moved to `packages/core/src/reports/`, one cursor-paging helper, dashboard
helpers and grading rules de-duplicated, dashboard component files renamed;
[architecture/refactoring-report.md](architecture/refactoring-report.md). Done 2026-10-16: the
WhatsApp campaign, automation and cart-reminder rules moved from `routes/whatsappOps.ts` into core,
`AppError` for rule violations, provider text only through `providerDetail()`, the remaining file
renames, app-wide UI out of `components/whatsapp`, dead code removed, and Zod schemas at the
Shopify and Meta boundaries (`core/shopifyPayloads.ts`, `core/whatsapp/metaPayloads.ts`) instead
of `any` in every payload reader: the normalizers, the WhatsApp and email automations, Meta's
WhatsApp webhooks, the app and GDPR topics, and the worker's order detail pages and bulk JSONL;
no `any` is left in the hand-written source. Done 2026-10-18
([architecture/initial-audit.md](architecture/initial-audit.md)): one Meta Graph transport,
`core/ads.ts` and `core/whatsapp/events.ts` split by platform and by event, the import-cycle
check, and the staff employee, timesheets and settings pages and the Team page split into
components; then `worker/handlers.ts` (one module per job in `worker/src/handlers/`),
`core/adConnections.ts` (`core/adConnections/`), Shopify's GraphQL documents out of
`core/normalize.ts` (`core/shopifyQueries.ts`), the pay run page's sections
(`components/staff/payroll/`) and the sales chart (`components/dashboard/ColumnsWithTotal.tsx`).)

What is left is not a move:

- `noUncheckedIndexedAccess` in `apps/web` (437 findings, nearly all in landing animations): a pass
  with visual checks.
- No formatter (Prettier) or import sorting: one repository-wide reformat, at a moment when no
  branch is open, as a commit of its own.
