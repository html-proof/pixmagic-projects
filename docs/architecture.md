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

Every API request and queue batch runs inside `withDb()` (packages/db): database clients live for
that one invocation, which Workers requires.

## Packages: what goes where

Each package may import only the ones above it in this table, never one below.

| Package | Holds | Must not |
| --- | --- | --- |
| `packages/shared` | Pure functions and constants: KPI formulas, dates, roles and permissions, HMAC/AES, WhatsApp template rules, Zod schemas shared by API and UI. Browser-safe subpath exports (`@app/shared/roles`, `/dates`, `/whatsapp`, ...). | Do I/O, read env, import Prisma. The UI imports subpaths only: the root barrel pulls `node:crypto` into the browser. |
| `packages/db` | Prisma schema, migrations (with RLS policies), `systemDb` / `tenantDb` / `withTenant` / `withDb`. | Contain business rules. |
| `packages/core` | Everything that talks to the database or an outside API on the app's behalf: Shopify client and sync, token encryption, normalizers, persistence and aggregates, alerts and audit, ad platforms, WhatsApp. The config schema (`env.ts`) and logger. | Know about HTTP requests or queues' delivery mechanics. |
| `apps/api` | HTTP: routing, auth, permission checks, input validation, response shapes. | Hold business logic that a job or another route could need: put it in core. |
| `apps/worker` | Queue consumers and cron sweeps: retries, backoff, failure bookkeeping, then a call into core. `ops/` holds one-off maintenance tasks (RUNBOOK.md). | |
| `apps/cloudflare` | The Worker entry: routes a request to the UI or the API, wires bindings (Hyperdrive, Queues, R2, Durable Object, Email) into `Deps`. | Contain logic beyond that wiring. |
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
`components/dashboard/contacts.tsx` and `app/(app)/whatsapp/messages/page.tsx`).

**Loading and errors.** While loading: `Skeleton`. When a load fails: `LoadError` (says what failed,
treats an outage calmly, offers Try again), including when a *second* load on the page fails. A
failed action (save, delete): `actionError(e, "what you tried")` in a toast or an `Alert`. A crash
while rendering is caught by `app/(app)/error.tsx` inside the shell, or `app/error.tsx` for public
pages. Unknown paths get `app/not-found.tsx`.

**Business logic.** Pages and components format and arrange what the API returns; rules and
calculations belong in `@app/shared` (shared with the API) or the API itself. Several dashboard
components still hold grading rules and derived figures (`overview.tsx`, `explain.tsx`,
`previews.tsx`); move them when those files are next reworked.

## Configuration

| Setting | Lives in | Read by |
| --- | --- | --- |
| Worker vars (public: URLs, app ids, API versions, scopes) | `apps/cloudflare/wrangler.jsonc` `vars`; locally overridden by `apps/cloudflare/.dev.vars` | `env()` in `packages/core/src/env.ts` |
| Worker secrets (session, encryption keys, client secrets) | `npx wrangler secret put NAME`; locally `.dev.vars` (from `.dev.vars.example`) | `env()` |
| Bindings (Hyperdrive, Queues, R2, Durable Object, Email) | `wrangler.jsonc` | `apps/cloudflare/src/index.ts`, passed as `Deps` |
| UI build-time values (`NEXT_PUBLIC_FIREBASE_*`) | `apps/web/.env.local` / `.env.production` / CI (from `apps/web/.env.example`) | `apps/web/src/lib/firebase.ts` |
| Local tooling (docker compose, Prisma CLI, `ops:*` tasks) | repo-root `.env` (from `.env.example`) | those tools only |

`env()` validates the whole Worker config with Zod on first use and, in production, refuses to
start with a secret still set to a value published in this repository. New settings go into its
schema with a default (or as required), then into `wrangler.jsonc` / `.dev.vars.example`. Code reads
settings through `env()`, not `process.env`. The exceptions are deliberate: the logger
(`LOG_LEVEL`), the database scope in Node (`DATABASE_URL` for tests and scripts) and per-app
Shopify secrets whose names are dynamic (`SHOPIFY_APP_SECRET_<KEY>`).

## Naming

- **Files**: React component files are PascalCase (`StoreHeader.tsx`, `LoadError.tsx`); modules of
  helpers, hooks or types are camelCase (`format.ts`, `storage.ts`). Most of `components/dashboard`
  and `components/whatsapp` predate this and use camelCase for component files; rename them when no
  other branch has work in progress on them (a rename under someone's edits turns their merge into
  a conflict).
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

A bug fix comes with the test that would have caught it.

## Known structural debt

Deliberately not moved yet, because the files are under active work elsewhere and a move would turn
that work into conflicts. Each is safe to do on its own.

- `apps/api/src/routes/dashboard.ts`: ~585 lines of reporting SQL and data shaping inside the route
  file. Target: `packages/core/src/reports/`, leaving the route to parse, authorize and call.
- `apps/api/src/routes/whatsappOps.ts` / `whatsapp.ts`: campaign and automation rules, cart
  eligibility and analytics grouping inline; four copies of cursor pagination. Target: core's
  `whatsapp/` modules and one pagination helper.
- Two Meta Graph clients (`core/ads.ts`, `core/whatsapp/graph.ts`) with different auth and error
  handling.
- Dashboard components: the camelCase file names above, and small helpers repeated across
  `overview.tsx`, `details.tsx` and `explain.tsx` (bold wrapper, change wording, drop-off maths).
