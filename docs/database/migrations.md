# Migrations

Every schema change is a Prisma migration in `packages/db/prisma/migrations/<timestamp>_<name>/`,
committed with the code that needs it. Nobody edits a production schema by hand.

## Making one

1. Change `packages/db/prisma/schema.prisma`.
2. Generate the SQL against your development database (`app_dev`, never `app`; `migrate dev`
   refuses `app`):

   ```bash
   pnpm db:migrate:dev --name what_it_does
   ```

   Or, without touching any database, diff a migrated database against the schema and write the
   SQL yourself into a new folder:

   ```bash
   pnpm --filter @app/db exec prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --script
   ```

3. A new tenant table needs its RLS policy in the same migration (copy one from
   `20261010160159_whatsapp`); `apps/api/test/security.test.ts` fails without it.
4. Run the integration tests: their setup applies every migration to a fresh `*_test` database.
5. CI checks that the migrations produce exactly `schema.prisma` (no drift).

## Rules for a migration production can take

- **Additive first.** Add columns as nullable or with a default, add tables and indexes. The code
  that was live before the deploy must keep working on the new schema, because the migration is
  applied *before* the new code goes live and stays if the code is rolled back.
- **Removing or renaming** takes two releases: stop using it (deploy), then drop it (next migration).
- **Data changes** (backfills) go in the migration only when they are quick and idempotent;
  anything long is a maintenance task (`apps/worker/ops/`) run separately.
- **Never reset or drop** production data to make a migration apply.
- **Large tables**: `CREATE INDEX` locks writes to that table while it builds. Today's tables are
  small enough for that to take seconds; once `orders` is large, create the index
  `CONCURRENTLY` by hand first (it can't run inside a migration's transaction), then mark the
  migration applied.

## Applying to production

Production's database is `app` on the Docker Postgres behind the tunnel
([../deployment-cloudflare.md](../deployment-cloudflare.md)). Before uploading a version that
needs a migration:

1. Back up: `node infra/postgres/backup.mjs` (RUNBOOK, "Back up and restore the database").
2. See what is pending (from a checkout of the version being deployed, with `DATABASE_URL`
   pointing at `app`, the owner role):

   ```bash
   pnpm --filter @app/db exec prisma migrate status
   ```

3. Apply: `pnpm db:migrate` (that is `prisma migrate deploy`), or run each pending
   `migration.sql` in one transaction with `psql -1 -f` and then record it with
   `prisma migrate resolve --applied <folder name>` (the route used so far, which shows any error
   before anything is committed).
4. Deploy the code (staged version, smoke test, promote).
5. Point `DATABASE_URL` back at `app_dev`.

Applied to production on 2026-10-14: `20261014120000_staff_management` and
`20261014180000_hot_filter_indexes`. Still on an unmerged branch: `20261012000000_ads_completeness`
(apply it before the deploy that brings that code).
