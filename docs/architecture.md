# Architecture and conventions

How the code is organised, where new code goes, and the conventions it follows. For running it see
[local-dev.md](local-dev.md); for production see [deployment-cloudflare.md](deployment-cloudflare.md)
and [RUNBOOK.md](RUNBOOK.md).

## The shape of the system

One Cloudflare Worker (`apps/cloudflare`) serves everything:

```
browser ──► Worker fetch ──┬─ /api/*, /webhooks/*, /pixel/*, /shopify/* ──► Hono app (apps/api)
                           └─ everything else ──► static UI (apps/web, Next.js static export)

Queues (sync, webhooks, aggregate) ──► Worker queue  ──► consume() (apps/worker)
Cron (*/15, 03:15)                 ──► Worker scheduled ──► runScheduled() (apps/worker)

apps/api and apps/worker ──► packages/core (Shopify, Meta, Google, WhatsApp, persistence)
                         ──► packages/db   (Prisma; Postgres via Hyperdrive)
everything               ──► packages/shared (pure logic, no I/O)
```

Every API request and queue batch runs inside `withDb()` (packages/db): database connections live
for that one invocation, which Workers requires. The two Prisma clients do not: they are built once
per isolate (building one costs ~25 ms of CPU, more than the Free plan's whole request budget) and
run each statement on the current invocation's connections, batching queries only within one
invocation (`scopedAdapter`, `scopedQueues`).

## Packages: what goes where

Each package may import only the ones above it in this table, never one below.

| Package | Holds | Must not |
| --- | --- | --- |
| `packages/shared` | Pure functions and constants: KPI formulas, dates, roles and permissions, HMAC/AES, WhatsApp template rules, Zod schemas shared by API and UI, the staff pay/time engine (`@app/shared/staff`), the email rule and template engine (`@app/shared/email`). Browser-safe subpath exports (`@app/shared/roles`, `/dates`, `/whatsapp`, `/staff`, `/email`, ...). | Do I/O, read env, import Prisma. The UI imports subpaths only: the root barrel pulls `node:crypto` into the browser. |
| `packages/db` | Prisma schema, migrations (with RLS policies), `systemDb` / `tenantDb` / `withTenant` / `withDb`. | Contain business rules. |
| `packages/core` | Everything that talks to the database or an outside API on the app's behalf: Shopify client and sync, token encryption, normalizers, persistence and aggregates, alerts and audit, ad platforms, WhatsApp, email integrations (`email/`: OAuth, SMTP, delivery, rules; docs/email.md). The config schema (`env.ts`) and logger. | Know about HTTP requests or queues' delivery mechanics. |
| `apps/api` | HTTP: routing, auth, permission checks, input validation, response shapes. | Hold business logic that a job or another route could need: put it in core. |
| `apps/worker` | Queue consumers and cron sweeps: retries, backoff, failure bookkeeping, then a call into core. `ops/` holds one-off maintenance tasks (RUNBOOK.md). | |
| `apps/cloudflare` | The Worker entry: routes a request to the UI or the API, wires bindings (Hyperdrive, Queues, Durable Object, Email; R2 when bound) into `Deps`, gives every outbound call its timeout (`withTimeout`) and every queue message and cron run its log context. | Contain logic beyond that wiring. |
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
  ws, permission)` for anything in a workspace. Permissions come from `@app/shared/roles`; the UI
  asks `can(role, permission)` for the same permission to decide what to show.
- **Reads** go through `withTenant(workspaceId, tx => ...)` (Postgres RLS as a second guard);
  `systemDb` bypasses RLS and is for auth bootstrap, webhooks, jobs and writes that already scoped
  by workspace and store.
- **Input**: `z.object(...).parse(await body(c))` for JSON, the same for `c.req.query()`. A Zod
  failure becomes a 400 `validation` response automatically.
- **Errors**: throw `HttpError(status, message, code)` for anything the client should be told; the
  response is always `{ "error": code, "message": text }`. Anything else reaches `onError`, which
  logs it and answers a generic 500. Map known domain errors (e.g. `NotRetryableError`,
  `StoreDisconnectedError`) to an `HttpError` explicitly; never forward a raw `err.message`: it can
  carry database or provider internals. Machine endpoints (Shopify/Meta webhooks, the pixel) may
  answer `{ "error": code }` only.
- **Rate limits**: `limit(deps.coord, key, LIMITS.x)` from `rateLimit.ts`; a global per-IP limit
  runs as middleware.
- **Audit**: user-visible changes to a workspace call `audit()` (core) after the change.

## Worker conventions (`apps/worker`)

- A queue message is processed by `consume()`; a job that throws is retried with backoff up to
  `MAX_ATTEMPTS` (which must equal `max_retries + 1` in `wrangler.jsonc`), then recorded as failed
  and alerted. A failure while Postgres is unreachable spends no attempts (`deferForDb`).
- Handlers must be idempotent: Shopify and Queues both deliver at least once.
- Each cron sweep runs on its own: one that throws is logged and the rest of the tick still runs.
- `UnrecoverableError` ends retries at once (revoked access, a store that is gone).

## Frontend (`apps/web`)

```
src/app/            routes (App Router). (app)/ is the signed-in shell: AppProvider + top bar.
                    portal/ (employee self-service) and join/ (employee invitations) sit outside it:
                    employees aren't workspace members. Staff Management: docs/staff.md.
src/components/     UI. dashboard/, whatsapp/, landing/ per area; app-wide pieces at the top.
src/hooks/          animation hooks for the landing page.
src/lib/            non-UI modules: the API client and hooks, Firebase/session, storage, types of
                    API responses shared by several pages.
```

**Data and state.** There is no global store library, and none is needed: the server is the source
of truth and almost every screen is "load, show, edit, save".

| State | Where it lives |
| --- | --- |
| Server data | `useApi(path)` (`lib/api.ts`): each answer is kept with the request it answers, transient failures retry by themselves, `reload()` and `setData()` for edits. `useLiveApi(path, ms)` for data that must stay live (the dashboard). |
| Session, workspaces, current workspace and store | `AppContext` (`useApp()`), signed-in pages only. |
| The dashboard's date range and open detail | The URL (`?from=&to=`, `?view=`), so a link reproduces the view. |
| Per-device preferences | `lib/storage.ts` (`readLocal` / `writeLocal`): never throws, so blocked storage only loses the preference. |
| Form drafts | Component state. |

Write a hand-made `api()` call in an effect only when `useApi` can't express it (paging with
"load more", a request fired by a button), and then guard against late answers: keep the answer
with the request it belongs to, or ignore any response that isn't the latest (see
`components/dashboard/Contacts.tsx` and `app/(app)/whatsapp/messages/page.tsx`).

**Loading and errors.** While loading: `Skeleton`. When a load fails: `LoadError` (says what failed,
treats an outage calmly, offers Try again), including when a *second* load on the page fails. A
failed action (save, delete): `actionError(e, "what you tried")` in a toast or an `Alert`. A crash
while rendering is caught by `app/(app)/error.tsx` inside the shell, or `app/error.tsx` for public
pages. Unknown paths get `app/not-found.tsx`.

**Business logic.** Pages and components format and arrange what the API returns; rules and
calculations belong in `@app/shared` (shared with the API) or the API itself. The dashboard's
health grading lives in `@app/shared/health` and its drop-off and landing-page maths in
`@app/shared/journey`; the repeated sentence pieces are in `components/dashboard/narrative.tsx`.
Detail panels load on demand (`components/dashboard/TopicDetail.tsx`): keep code that only a click
needs out of the page's first load.

**Landing page motion.** On integrated graphics the page drops frames on GPU work, not JavaScript,
so every effect has to be cheap for the GPU process:

- Anything whose transform or opacity follows the scroll gets its own layer (`lp-layer`), so the
  GPU moves it instead of the browser repainting the area around it. Avoid animating `filter`,
  `backdrop-filter`, `mask-image`, `border-radius`, `clip-path` or colours on large elements:
  each frame of those is a repaint.
- Particles go through `components/landing/shared/particles.ts`: one batched WebGL draw per frame
  (2D fallback included), set up in idle time after the intro. Don't stamp hundreds of shapes with
  the 2D canvas API.
- Ambient loops are composited CSS animations (`lp-loop`, paused off screen by `usePauseWhenHidden`);
  no SVG `stroke-dashoffset`/SMIL loops and no motion `repeat: Infinity` on unpromoted elements.
- Wheel scrolling is eased by `hooks/useSmoothScroll.ts` (Lenis), so scroll-driven scenes follow the
  scroll directly: don't add `useSpring` on top of scroll progress.

## Configuration

| Setting | Lives in | Read by |
| --- | --- | --- |
| Worker vars (public: URLs, app ids, API versions, scopes) | `apps/cloudflare/wrangler.jsonc` `vars`; locally overridden by `apps/cloudflare/.dev.vars` | `env()` in `packages/core/src/env.ts` |
| Worker secrets (session, encryption keys, client secrets) | `npx wrangler secret put NAME`; locally `.dev.vars` (from `.dev.vars.example`) | `env()` |
| Bindings (Hyperdrive, Queues, Durable Object, Email; R2 is optional and not bound today) | `wrangler.jsonc` | `apps/cloudflare/src/index.ts`, passed as `Deps` |
| UI build-time values (`NEXT_PUBLIC_FIREBASE_*`) | `apps/web/.env.local` / `.env.production` / CI (from `apps/web/.env.example`) | `apps/web/src/lib/firebase.ts` |
| Local tooling (docker compose, Prisma CLI, `ops:*` tasks) | repo-root `.env` (from `.env.example`) | those tools only |

`env()` validates the whole Worker config with Zod on first use and, in production, refuses to
start with a secret still set to a value published in this repository, or with a development
setting that turns a safeguard off (the Auth emulator, a Mailpit relay, a local `APP_URL`). New
settings go into its schema with a default (or as required), then into `wrangler.jsonc` /
`.dev.vars.example`. Code reads settings through `env()`, not `process.env`. The exceptions are
deliberate: the logger (`LOG_LEVEL`), the database scope in Node (`DATABASE_URL` /
`APP_DATABASE_URL` for tests and scripts) and per-app Shopify secrets whose names are dynamic
(`SHOPIFY_APP_SECRET_<KEY>`).

Local tools and `wrangler dev` use the `app_dev` database; production's `app` is only ever reached
by pointing `DATABASE_URL` at it on purpose ([ADR-008](architecture/architecture-decisions.md#adr-008-defaults-that-can-only-reach-production-on-purpose)).

## Naming

- **Files**: React component files are PascalCase (`StoreHeader.tsx`, `LoadError.tsx`); modules of
  helpers, hooks or types are camelCase (`format.ts`, `storage.ts`). `components/whatsapp`, and
  `lineChart.tsx` / `primitives.tsx` in `components/dashboard`, predate this; rename them when no
  other branch has work in progress on them, as a commit of pure `git mv` renames (git carries
  other branches' edits across a pure rename; a rename mixed with edits turns them into conflicts).
- **Exports**: components and helpers are named exports; only Next.js pages, layouts and boundaries
  use default exports.
- **Errors**: `XxxError extends Error` and sets `this.name`, so logs say which.
- **API**: route files by area (`routes/whatsappOps.ts`), registration functions `<area>Routes`.
- **Relative imports inside packages** use the `.js` extension (`./dates.js`), except in the
  `packages/shared` modules the UI imports by subpath (`ads.ts`, `sales.ts`): Next's bundler does
  not map `./dates.js` to `dates.ts` in a workspace package, so those stay extensionless.

## Tests

| Kind | Where | Runs with |
| --- | --- | --- |
| Unit (pure logic, config files) | `packages/shared/test`, `packages/core/test` | `pnpm test` |
| Integration (real Postgres, faked Firebase/Shopify/Meta) | `apps/api/test`, `apps/worker/test` | `pnpm test:integration` (database `*_test`; `TEST_PG_PORT` points it at a throwaway server) |
| End to end (Playwright against `wrangler dev`) | `apps/web/e2e` | `pnpm e2e` |
| Lint (TypeScript, React hooks) | everywhere | `pnpm lint` (CI fails on any finding) |

A bug fix comes with the test that would have caught it. CI also checks the dependency audit, that
the committed Worker binding types match `wrangler.jsonc`, and that the migrations produce exactly
`schema.prisma`.

## Known structural debt

Deliberately not moved yet, because the files are under active work elsewhere and a move would turn
that work into conflicts. Each is safe to do on its own. (Done in the 2026-10-14 restructuring:
dashboard reporting moved to `packages/core/src/reports/`, one cursor-paging helper, dashboard
helpers and grading rules de-duplicated, dashboard component files renamed;
[architecture/refactoring-report.md](architecture/refactoring-report.md).)

- `apps/api/src/routes/whatsappOps.ts` / `whatsapp.ts`: campaign and automation rules, cart
  eligibility and analytics grouping inline. Target: core's `whatsapp/` modules.
- Two Meta Graph clients (`core/ads.ts`, `core/whatsapp/graph.ts`) with different auth, error
  handling and network-failure handling. Target: one transport (design in
  [architecture/current-state.md](architecture/current-state.md), M16).
- Raw provider error text in a few API messages (`routes/ads.ts`, `whatsapp.ts`), and `any` in the
  parsing of Shopify / Meta payloads (`core/normalize.ts`).
- Large files that do several jobs: `core/ads.ts`, `core/adConnections.ts`, `core/normalize.ts`,
  `core/notify.ts`, `worker/handlers.ts`, `core/whatsapp/events.ts`.
