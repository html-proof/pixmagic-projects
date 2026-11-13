# The system database role

Design approved by the owner on 2026-10-29. Where the rollout stands is under [Rollout](#rollout).

Closes finding 5 of the [2026-10-10 audit](security-audit-2026-10-10.md) (follow-up B1) and the
roadmap's acceptance criterion "a user from tenant A cannot access tenant B's accounts, reports,
credentials or automation rules".

## The problem

`systemDb` connects as `app`. That role is the RDS master and owns every table, and a table's owner
skips row-level security unless the table FORCEs it (migration `20261002070200_rls` doesn't). So on
every `systemDb` call only the code's own where-clauses keep tenants apart: about 1,240 call sites
in `packages/core`, 184 in `apps/api` and 83 in `apps/worker`.

| Module | `systemDb` | `withTenant` |
| --- | --- | --- |
| whatsapp | 291 | 0 |
| sms (removed 2026-11-13) | 284 | 0 |
| email (the email module, removed 2026-11-13) | 181 | 35 |
| adConnections | 110 | 0 |
| inventory | 69 | 1 |

`app` can also alter or drop tables, switch row-level security off and create roles. A bug in a
webhook or a job can therefore reach far beyond one tenant's rows.

Moving 1,500 call sites into `withTenant` transactions is not realistic. Many of them would also be
wrong there: an ad sync waits on Meta or Google for seconds and must not hold a transaction open
that long. So the scope is set once, where each request, job or sweep starts, and every `systemDb`
call under it inherits it.

## Roles after the change

| Role | Used by | Row-level security | Rights |
| --- | --- | --- | --- |
| `app` (RDS master, owns everything) | the cron function's `migrate`, `counts` and `evolution-db` actions only | skipped (owner) | everything |
| `app_system` (new) | `systemDb`: webhooks, jobs, cron sweeps, sign-in, the integration code | **applies** | read and write rows; owns nothing, no BYPASSRLS, no CREATEROLE, no DDL |
| `app_rls` | `tenantDb` / `withTenant` | applies | unchanged |

## How system code says whose rows it means

`packages/db` has three wrappers. Like `withDb`, they keep their state in AsyncLocalStorage:

- **`forTenant(workspaceId, fn)`**: inside `fn`, `systemDb` sees one workspace. This uses the
  existing `tenant_isolation` policies, which read `app.workspace_id`.
- **`crossTenant(reason, fn)`**: inside `fn`, `systemDb` sees every workspace through one new
  policy per tenant table: `system_all … TO app_system USING (current_setting('app.scope', true) = 'all')`.
  `reason` is a key of `CROSS_TENANT_REASONS` (`packages/db/src/crossTenant.ts`), so TypeScript
  refuses any other. That list is the reviewed one: a new way of reading across workspaces starts
  as a new entry there.
- **`withoutTenant(fn)`**: no workspace's rows, only the tables that belong to none (below). For
  the health checks.
- **None of them**: during the rollout an unscoped query sees every workspace, as on the owner's
  login. Core logs it once per request, job or tick (`reportUnscopedSystemQueries`), with its log
  context and stack. At the last step it throws instead (see the rollout).

**Mechanism** (`SystemPool` in `packages/db/src/index.ts`):
- Each pooled connection carries the two settings at session level.
- When a connection is checked out with settings from another scope, one statement sets them
  (about 1 ms inside the VPC); otherwise nothing is sent.
- No new connections are opened, and the pools stay the same size.
- The scope is read when `connect()` is called, not when the connection arrives. pg-pool hands a
  released connection to the next waiting caller from inside the releasing caller's async context.
- Prisma's batched `findUnique` calls are queued per row scope as well, so a batch never mixes two
  scopes.
- A transaction keeps the scope it began in.

**Where policies and grants live:** `infra/postgres/init.sql`, which runs after migrations
everywhere (the migrate action, CI, test setup). One loop there gives every public table with a
`workspace_id` column its `system_all` policy. New tables get theirs on the next deploy without
anyone remembering it, and `apps/api/test/systemRole.test.ts` checks it.

**Tables that belong to no workspace**: the system role may read and write them in every scope.
They hold people and intake records, not a workspace's data, and sign-in reads them before any
workspace is known.
- `users`, `auth_identities`, `auth_events`, `user_sessions` and `pixel_events_seen`
  have row-level security, so each gets a `system_any` policy, named one by one in `init.sql`.
- `workspaces` shows the scope's own row under `forTenant` and every row under `crossTenant`.

## Where the scope is set

The scope is set at the entry points, not at the 1,500 call sites:

- **API** (`apps/api/src/rowScope.ts`, one middleware right after the request context):
  - **`/workspaces/:ws/*` and the staff portal's `/employee/:ws/*`** run in `forTenant(ws)`. That
    covers the integration settings, reports, automation rules and credential pages. Authorization
    is unchanged (`requireWorkspace` and `requireStaff` still decide); the scope only narrows what a
    forgotten where-clause could reach.
  - **The other paths** are listed by prefix, each with its reason:
    - `sign_in`: `/auth/*`, `/me`, `POST /workspaces`;
    - `invitations`: invitations and `/employee/workspaces`;
    - `shopify_install`: `/shopify/*`;
    - `webhooks`: webhooks, the pixel and the links customers follow;
    - `integrations_oauth`: OAuth returns and Zapier's API.
  - **The health checks** run in `withoutTenant`.
  - A test fails for a route that is in no list.
- **Worker**: `consume()` runs each job in `inJobScope` (`apps/worker/src/rowScope.ts`). It reads the
  job's workspace from the row the job is about (store, ad connection, message, delivery, campaign
  or event) in one `crossTenant("job")` query, then runs the job in `forTenant`.
  - Jobs carry only those ids (`packages/core/src/queues.ts`), so this covers messages already in
    the queues as well.
  - A job whose row names no workspace runs in `crossTenant("job")`: WhatsApp's raw events, a
    Shopify webhook for a shop with no store.
  - A failed lookup does the same, so a database outage stays `consume()`'s to notice.
- **Cron**: `runScheduled` runs the whole tick in `crossTenant("sweep")`. The sweeps are
  cross-tenant by nature: "every send that is due", "every token about to expire". The Lambda's
  maintenance actions (`after-move`, `reread`, `verify`, `shopify-check`, `product-check`) use
  `crossTenant("maintenance")`.

**Narrowing later.** Webhooks, Zapier's API and the per-store work inside a sweep can move from
their listed reason to `forTenant` once they have found their workspace, module by module. Each one
that does takes a widening off the list.

## Rollout

The order matters because Deploy runs `cdk deploy` (new function code) *before* `migrate` (which
would create the role). If one PR both created the role and switched to it, requests would fail
until migrate finished. So there are three PRs:

1. **Role and scopes, still running as `app`.** Live since 2026-10-30 (release 131: #287, landed
   with five other pull requests in #290).
   - CDK makes a generated secret `insights/<env>/db-system` that nobody sees.
   - The migrate action creates `app_system` (or resets its password) before `init.sql` runs, so in
     production the role never has a default password.
   - `init.sql` adds the grants and policies.
   - `packages/db` gets the scopes, and the entry points are wrapped. `systemRole.test.ts` runs on
     `app_system`; the rest of the suites move to it in step 2.
   - In production the settings change nothing yet, because `app` skips row-level security.
2. **Switch.**
   - `DATABASE_URL` is built from `db-system`.
   - The api and jobs functions lose read access to the `db-owner` secret. The cron keeps it
     (`OWNER_DATABASE_URL`) for its maintenance actions: `migrate`, `counts`, `evolution-db`.
   - `/readyz` also reports not ready in production if the system connection is a superuser,
     bypasses RLS or owns tables. The deploy's smoke test reads it.
   - The integration tests and e2e run `systemDb` on `app_system` too. Migrations, `resetDb` and
     e2e's seeding use `OWNER_DATABASE_URL`, which `prisma.config.ts` prefers when it is set.
   - Local development may keep the owner's login in `.env`; the scopes then change nothing there.
   - The paths the tests found reading across workspaces from inside one workspace's scope now say
     so. Connecting a store (is the shop live elsewhere, does it move, where does a member land)
     uses `shopify_install`. A WhatsApp number already connected to another store uses
     `already_connected`. Whether a person's Google or Meta grant still powers a connection in
     another workspace, before it is taken back, and the refresh token they gave before, use
     `ad_grants`. Deleting a workspace (packages/core/src/workspaceDeletion.ts) writes the record of
     it with no workspace once the workspace is gone, which the workspace's own scope refuses, and
     first asks whether another workspace sends from the same Google mailbox before taking its
     grant back (a count): `workspace_deleted`.
   - Rollback: Deploy's automatic rollback, or revert the PR.
3. **Fail closed** after seven days with no "system query in no row scope" warning in CloudWatch Logs
   (each warning is fixed by scoping its entry point).
   - An unscoped `systemDb` query throws instead of seeing everything.
   - The role's own default (`ALTER ROLE app_system SET app.scope = ''`) means a raw `pg` client on
     that login also sees no tenant rows.
   - It throws rather than returning nothing because a sweep that quietly found nothing to do would
     stop sending without anyone noticing.

## Tests

`apps/api/test/systemRole.test.ts` logs in as `app_system`:
1. **The role**: not a superuser, no BYPASSRLS, owns nothing, can't create in `public`, can't
   truncate, can't read `_prisma_migrations`. `ALTER TABLE … DISABLE ROW LEVEL SECURITY` and
   `DROP TABLE` are refused.
2. **Every table with a `workspace_id`**, with two workspaces:
   - `forTenant(A)` sees only A's rows, and a query naming B returns nothing;
   - `withoutTenant` sees none;
   - a plain login on the role, outside `@app/db`, sees no workspace's rows.
3. **Ad accounts (credentials), stores, members**: B's can't be read, updated or deleted from A's
   scope, and a row made for B is refused. `crossTenant` sees both.
4. **The policies**: `system_all` on every workspace table and nowhere else, opening only for
   `app.scope = 'all'`; `system_any` only on the six listed tables.
5. **Shared connections**: scopes taking turns on one pooled connection, more scopes at once than
   the pool has connections, Prisma's batched `findUnique`, and a transaction.
6. **The API**: every route has a scope, and only reasons on the list. A throwaway route under
   `/workspaces/:ws/` that forgets its where-clause gets only that workspace's ad accounts;
   production has no such route.
7. **Unscoped queries are reported** and scoped ones aren't.

`apps/worker/test/rowScope.test.ts` checks each job kind's workspace and the fallback when there is
none or the lookup fails. It also runs a job and both cron ticks with no unscoped system query.

After step 3: an unscoped `systemDb` query throws.

## What it does not cover

- **SQL injection.** Any role may change its own session settings, so injected SQL could widen its
  own scope. The same is true of `app_rls` today. Row-level security here guards against the
  realistic bug, a forgotten where-clause. Injection is guarded by Prisma's bound parameters
  (production code has no `$queryRawUnsafe`).
- The no-workspace tables stay readable by the system role in every scope.
- Cron sweeps stay cross-tenant by design, each one named on the list.

## Cost

- One generated secret: about US$0.40 a month, plus one `GetSecretValue` per cold start (under
  US$0.01).
- No other AWS resources. The connection count is the same: same pools, a different login.
- Latency: about 1 ms when a pooled connection switches workspace, nothing otherwise.

## Sequencing with open pull requests

- **#284 first.** The functions' environment was at Lambda's 4 KB limit, so every Deploy from `main`
  failed until #284 landed. Step 1 therefore gives its new variable to the cron alone, and step 2
  swaps `DB_SECRET_ARN` for the shorter `SYSTEM_DB_SECRET_ARN` in the shared environment.
- **Step 1 (#287) landed together with #279, #280, #282, #283 and #285** in one combined pull
  request and one Deploy. Step 2 is merged on top of that. Its conflicts were with #282's restored
  WhatsApp code (the number check moved, the shared-account release is gone) and #279's Nango
  removal (the grant check lost its source filter).
- Sessions adding routes, jobs or sweeps after step 1 wrap them in `forTenant` / `crossTenant`.
  `systemRole.test.ts` fails for a route with no scope.
