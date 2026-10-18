# Adding a feature

The recipes below follow the layering in [../architecture.md](../architecture.md): pure rules in
`packages/shared`, data and providers in `packages/core`, HTTP in `apps/api`, background work in
`apps/worker`, screens in `apps/web`. Each step names an existing example to copy.

Before you push: `pnpm lint`, `pnpm typecheck`, `pnpm test`, and
`TEST_PG_PORT=<throwaway port> pnpm test:integration` ([../local-dev.md](../local-dev.md#tests)).
A bug fix comes with the test that would have caught it.

## A rule or calculation

Used by the API and the UI (a KPI, a grade, a label): a pure function in `packages/shared/src/`,
with unit tests in `packages/shared/test/`. If the UI needs it, export it as a subpath in
`packages/shared/package.json` and import it as `@app/shared/<name>`; never from the root
barrel in the UI. Example: `packages/shared/src/health.ts`.

## An endpoint

1. Data access goes in `packages/core` as a function taking a transaction or the ids it needs
   (example: `packages/core/src/reports/overview.ts`). It throws a named error for a domain
   failure (`class XxxError extends Error`, with `this.name` set).
2. The route goes in `apps/api/src/routes/<area>.ts` (example: `routes/dashboard.ts`):
   - `requireWorkspace(c, deps, ws, "<permission>")` first (or `requireUser` for user-level routes);
   - parse input with Zod: `z.object(...).parse(await body(c))`, the same for `c.req.query()`;
   - tenant reads inside `withTenant(ws, tx => ...)`;
   - map domain errors to `HttpError(status, text for people, code)`; never forward a provider's
     or the database's own message;
   - a user-visible change records `audit({ ... })` after it is committed;
   - an endpoint worth abusing gets a limit in `apps/api/src/rateLimit.ts` (`LIMITS`);
   - a list is capped or paged (`apps/api/src/pagination.ts`).
3. Register it in `apps/api/src/app.ts` if it is a new route file.
4. Integration test in `apps/api/test/` (real Postgres, faked Cognito and providers): the
   success path, the permission check (another workspace gets 404), and the failure you handle.
5. Add the row to [../api/api-overview.md](../api/api-overview.md).

## A database table or column

1. Edit `packages/db/prisma/schema.prisma`; a tenant table has `workspaceId` (and `storeId` if it
   belongs to a store) and an index on it.
2. Create the migration ([../database/migrations.md](../database/migrations.md)); a tenant
   table's migration also enables RLS with a `tenant_isolation` policy (copy one).
3. Additive only, so the code that is live keeps working on the new schema.

## Background work

Anything that may outlast a request, must retry, or runs on a schedule:

- **A job**: a message type in `packages/core/src/queues.ts`, a handler in
  `apps/worker/src/handlers.ts`, dispatched from `consume()` (`apps/worker/src/index.ts`). Make
  it idempotent (deliveries repeat) and guard writes against stale data (see
  `applySubscriptionUpdate`, `writeIfNotNewer`). Failures retry with backoff up to
  `MAX_ATTEMPTS`; record a final failure in `onFailure`.
- **A sweep**: a step in `runScheduled()` behind its own try/catch, so one failing sweep doesn't
  stop the others; take a lease in the Coordinator if two ticks could overlap.

## An integration (a new provider)

- One module in `packages/core/src/<provider>.ts` (or a folder): the client, its errors, its
  mapping to our types. Nothing about the provider outside it.
- Every HTTP call goes through the injected `fetchImpl` (`deps.fetchImpl`), which carries the
  default timeout; never call the global `fetch` directly in production code.
- Tokens are stored encrypted (`encrypt(..., keyring(), aad)`), never logged (add new credential
  field names to `REDACT` in `packages/core/src/logger.ts`), and sent in a header, never in a URL.
  Anything on Meta's Graph API uses `graphCall` (`packages/core/src/metaGraph.ts`) with its own
  `fail` mapping, as `core/ads/meta.ts` and `core/whatsapp/graph.ts` do. A new encrypted field joins
  key rotation in `packages/core/src/keyRotation.ts`.
- OAuth: single-use state in the Coordinator plus a cookie, PKCE where the provider supports it
  (`apps/api/src/routes/ads.ts`). Webhooks: verify the signature on the raw body before parsing.
- Settings go in the config schema (`packages/core/src/env.ts`), then `APP_SETTINGS` in
  `apps/aws/src/settings.ts` (public values) or Secrets Manager with
  `node infra/cdk/scripts/put-secrets.mjs --set NAME` (secrets), and `apps/aws/.env.example`.
- A provider failure must not break unrelated pages: map it to a typed error and to 502/503.

## A screen

- A page in `apps/web/src/app/` (signed-in pages under `(app)/`), its components in
  `apps/web/src/components/<area>/` (PascalCase file names for components). A page with tabs or
  independent sections keeps only their routing; each tab or section is a file in
  `components/<area>/<page>/` (example: `components/staff/employee/`).
- Load data with `useApi` / `useLiveApi`; show `Skeleton` while loading and `LoadError` when a load
  fails; report a failed action with `actionError`.
- No business rules in components: format and arrange what the API returns; a rule goes to
  `@app/shared`.
- Heavy parts that only open on a click are loaded with `next/dynamic` (example:
  `components/dashboard/TopicDetail.tsx`).
- An end-to-end test in `apps/web/e2e/` for a critical flow.

## Debugging a production error

1. Get the request id: every API response has `x-request-id` (the browser's network tab, or ask
   the merchant to copy it from an error).
2. Search CloudWatch Logs for that id (Logs Insights over the log groups
   `/aws/lambda/insights-production-api`, `-jobs` and `-cron`): every line written for the request
   carries it, with `userId` / `workspaceId` once known; queue jobs carry `queue` and `messageId`,
   cron runs `cron`.
3. `/api/readyz` says whether the database (both roles) and the Coordinator answer, and logs why
   not ([../RUNBOOK.md](../RUNBOOK.md)).
