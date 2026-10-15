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
  that was live before the deploy must keep working on the new schema, because the migration stays
  if the code is rolled back; and the new code briefly runs on the old schema, between the deploy
  and the migration step (below).
- **Removing or renaming** takes two releases: stop using it (deploy), then drop it (next migration).
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

1. deploys the new code (`cdk deploy`);
2. invokes the cron function's `migrate` action (`apps/aws/src/migrate.ts`): every pending
   migration in order, each in its own transaction and recorded in `_prisma_migrations` exactly
   as `prisma migrate deploy` does, then the grants in `infra/postgres/init.sql`;
3. runs the smoke tests.

If step 2 or 3 fails, the functions go back to the previous versions; an applied migration stays.
To rerun the action (it is idempotent):

```bash
aws lambda invoke --function-name insights-production-cron:live --cli-binary-format raw-in-base64-out --payload '{"action":"migrate"}' out.json
```

RDS keeps 14 days of point-in-time restore, so there is no separate backup step.

Still on an unmerged branch: `20261012000000_ads_completeness`; it ships with the merge that
brings that code.
