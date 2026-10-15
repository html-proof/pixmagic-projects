# Architecture decisions

Short records of decisions about the structure of bizinsights: what was decided, why, and what would
make us revisit it. Newest last. The restructuring brief of 2026-10-14 proposed a reference
architecture; where this codebase deliberately differs from it, the reason is here.

## ADR-001: One modular monolith on one Cloudflare Worker

**Decision.** Keep a single deployable (`apps/cloudflare`) that hosts the static UI, the API, the
queue consumers and the cron sweeps, built from workspace packages with enforced layering
(`shared → db → core → api / worker → cloudflare`).

**Why.** One team, one database, one release cadence; Workers bill per request, so splitting the
API from the jobs saves nothing; every split adds a deploy, a version skew and a network hop. The
packages already give the separation that matters: the API and the jobs share `core`, not each
other.

**Revisit when** a part needs its own scaling or release cadence (e.g. the pixel ingest at very
high volume), or a second team owns a part.

## ADR-002: `apps/web/src/components/<area>/` is the feature folder

**Decision.** Do not move the UI into `src/features/<feature>/{components,hooks,api,...}`. Feature
code lives in `components/<area>/` (`dashboard/`, `whatsapp/`, `landing/`, and `staff/` on its
branch), pages in `app/`, app-wide pieces at the top of `components/` and `lib/`.

**Why.** That is already one folder per feature with a clear owner; renaming the folder buys no
separation, and moving ~130 files while several branches edit them would turn their merges into
conflicts. The rules that `features/` folders are meant to enforce are written down in
`docs/architecture.md` (Frontend) instead: no business rules in components, data through
`useApi`, shared UI only when two unrelated areas need it.

**Revisit when** an area grows its own hooks, API module and types big enough that a sub-folder
per kind helps (do it inside that area's folder).

## ADR-003: No `/api/v1` prefix

**Decision.** Keep the API's paths unversioned (`/api/workspaces/...`).

**Why.** The only client of the JSON API is our own UI, shipped atomically in the same Worker
version, so there is never an old client to keep compatible. The paths outside callers know
(Shopify and Meta webhooks, OAuth callbacks, the pixel endpoint, tracking links) are registered
with those providers or printed in messages already sent; renaming them would break them.

**Revisit when** a third party is given API keys to build on the JSON API: introduce `/api/v1/`
for that public surface then, keeping the old paths.

## ADR-004: Keep the `{ error, message }` error shape; add a request id

**Decision.** Errors stay `{ "error": code, "message": text }` (machine endpoints `{ "error" }`).
Every response carries `x-request-id`; log lines carry the same id.

**Why.** The UI, the tests and the docs depend on the shape, and it already separates a stable
machine code from human text. Wrapping it (`{ success, error: { code, message, details }, requestId }`)
would be a breaking change for no capability gained: the request id travels in a header, which
also covers non-JSON responses (redirects, the pixel's 204).

**Revisit with** ADR-003 (a public API).

## ADR-005: No client store library

**Decision.** Server state through `useApi` / `useLiveApi` (`lib/api.ts`), the session and the
current workspace in one React context, the dashboard's view in the URL, preferences in
`localStorage` through `lib/storage.ts`.

**Why.** Almost every screen is "load, show, edit, save" against the API, the source of truth.
`useApi` already keeps each answer with the request it answers (no stale overwrite), retries
transient failures and exposes `reload` / `setData`. A query-cache or store library would add a
second copy of server data and a dependency without removing any code.

**Revisit when** several screens need to share and mutate the same cached server data (cache
invalidation across pages), or offline support is required.

## ADR-006: Business rules live in `@app/shared`, data access in `@app/core`

**Decision.** Calculations and rules used by both the API and the UI go to `packages/shared`
(pure, unit-tested); anything that reads or writes the database or calls a provider goes to
`packages/core`; routes parse, authorize, call and respond. The dashboard's reporting queries moved
from `routes/dashboard.ts` to `core/reports/`, and its health grading from components to
`@app/shared/health`, as part of this.

**Why.** One copy of each rule, testable without HTTP or a browser; a route stays readable.

## ADR-007: Configuration stays per consumer, not per environment file

**Decision.** No `.env.development` / `.env.test` / `.env.production` set. Configuration is split by
*who reads it*: the Worker (`wrangler.jsonc` vars + `wrangler secret`, locally `.dev.vars`), the
UI build (`apps/web/.env.local`, `NEXT_PUBLIC_*` only), and local tools (repo-root `.env`). The test
values live in `test-support/env.ts` and `apps/web/e2e/worker.env`. Everything the Worker reads is
validated by one Zod schema (`env()`), which refuses known placeholder secrets, emulators and
local URLs in production.

**Why.** Each consumer has a different loader; an environment file per stage would duplicate every
setting three times, and production secrets must never be in a file at all.

## ADR-008: Defaults that can only reach production on purpose

**Decision.** Local tools and `wrangler dev` default to the `app_dev` database; production's `app`
is reached only by setting `DATABASE_URL` to it explicitly (maintenance tasks, migrations before a
deploy).

**Why.** On the owner's machine the local Postgres *is* production's (through the tunnel), so a
default of `app` made every local run read and write production data.

**Revisit when** production Postgres moves off the PC (then the default can't reach it anyway).

## ADR-009: Refactor around work in progress, not through it

**Decision.** While other branches have unmerged work, files they edit are not moved or rewritten;
renames are pure `git mv` commits; shared files get edits only on lines those branches don't
touch.

**Why.** A move under someone's edits turns their merge into a conflict that has to be resolved by
hand, file by file; git carries edits across a pure rename on its own. The deferred items are
listed in [refactoring-plan.md](refactoring-plan.md) with what unblocks them.
