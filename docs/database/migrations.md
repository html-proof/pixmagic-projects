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
  that was live before the deploy must keep working on the new schema: the deploy migrates before
  the new code goes live, so the old code runs on the new schema for up to a minute of every
  deploy, and again whenever the code is rolled back (the migration stays).
- **Removing or renaming** takes two releases: stop using it (deploy), then drop it (a migration in a later
  release). Stopping means taking the column out of the Prisma client (`@ignore` in `schema.prisma`) with every read
  and write of it: Prisma selects every column a model has, so a column no code names is still read while it is in
  the client. Drop it only once the release that stopped is the one a deploy would roll back to: the migration runs
  before the new code goes live, and the code it replaces must never meet a database without a column it selects.
  The Firebase columns went this way: `@ignore` in 2b2fdd49 (PR #163, live as release 82), then the DROP in
  e65a21a8 (PR #170, migration `20261020120000_drop_firebase_columns`). Three of the columns that named Nango
  connections wait for the same two steps ([schema.md](schema.md), Advertising).
- **Data changes** (backfills) go in the migration only when they are quick and idempotent;
  anything long is a maintenance task (`apps/worker/ops/`) run separately.
- **Never reset or drop** production data to make a migration apply.
- **Large tables**: `CREATE INDEX` locks writes to that table while it builds. Today's tables are
  small enough for that to take seconds; once `orders` is large, create the index
  `CONCURRENTLY` by hand first (psql through the admin host, [../aws-deployment.md](../aws-deployment.md#database);
  it can't run inside a migration's transaction), then mark the migration applied.

## Applying to production

Production's database is `app` on RDS PostgreSQL ([../aws-deployment.md](../aws-deployment.md)).
The deploy applies migrations, not a person: merging to `main` runs Deploy to AWS
(`.github/workflows/aws-deploy.yml`), which

1. `cdk deploy` publishes the new code, and before the `live` aliases move, the App stack invokes
   the NEW cron version's `migrate` action (`apps/aws/src/migrate.ts`): every pending migration in
   order, each in its own transaction and recorded in `_prisma_migrations` exactly as `prisma
   migrate deploy` does, then the grants in `infra/postgres/init.sql`. One run at a time: it holds
   a Postgres advisory lock while it works ([../aws-deployment.md](../aws-deployment.md#migrations-before-the-switch));
2. invokes `migrate` again on `live` (normally applies nothing; a warning names anything it did);
3. runs the smoke tests.

If the migration fails, nothing moves to the new code. If step 2 or 3 fails, the functions go back
to the previous versions; an applied migration stays. To rerun the action (it is idempotent):

```bash
aws lambda invoke --function-name insights-production-cron:live --cli-binary-format raw-in-base64-out --cli-read-timeout 960 --payload '{"action":"migrate"}' out.json
```

RDS keeps 14 days of point-in-time restore, so there is no separate backup step.

Still on an unmerged branch: `20261012000000_ads_completeness`; it ships with the merge that
brings that code.
