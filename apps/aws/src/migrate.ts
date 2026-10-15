import { createHash, randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import pg from "pg";

/**
 * Bring the database up to date: run the Prisma migrations that haven't run yet, in order, and
 * record each in `_prisma_migrations` exactly as `prisma migrate deploy` does (same table, same
 * checksum), so either tool can take over from the other. Then the tenant role's grants
 * (infra/postgres/init.sql) and its password from the app secret.
 *
 * Runs inside the function (a direct invocation: `{ "action": "migrate" }`), so the database's
 * master password never leaves AWS. Idempotent: run it after every deploy.
 */
export async function migrate(input: { databaseUrl: string; migrationsDir: string; initSql: string; appRlsPassword?: string }) {
  const client = new pg.Client({ connectionString: input.databaseUrl });
  await client.connect();
  const applied: string[] = [];
  try {
    await client.query(`CREATE TABLE IF NOT EXISTS "_prisma_migrations" (
      "id" VARCHAR(36) PRIMARY KEY NOT NULL,
      "checksum" VARCHAR(64) NOT NULL,
      "finished_at" TIMESTAMPTZ,
      "migration_name" VARCHAR(255) NOT NULL,
      "logs" TEXT,
      "rolled_back_at" TIMESTAMPTZ,
      "started_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
      "applied_steps_count" INTEGER NOT NULL DEFAULT 0
    )`);
    const done = new Set(
      (await client.query<{ migration_name: string }>(`SELECT migration_name FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL`)).rows.map(
        (r) => r.migration_name,
      ),
    );
    const names = readdirSync(input.migrationsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();
    for (const name of names) {
      if (done.has(name)) continue;
      const sql = readFileSync(join(input.migrationsDir, name, "migration.sql"), "utf8");
      const id = randomUUID();
      await client.query(`INSERT INTO "_prisma_migrations" (id, checksum, migration_name, started_at) VALUES ($1, $2, $3, now())`, [
        id,
        createHash("sha256").update(sql).digest("hex"),
        name,
      ]);
      // Each migration in one transaction: a failure leaves it unapplied and unrecorded as finished.
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query(`UPDATE "_prisma_migrations" SET finished_at = now(), applied_steps_count = 1 WHERE id = $1`, [id]);
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK");
        await client.query(`UPDATE "_prisma_migrations" SET logs = $2 WHERE id = $1`, [id, String((err as Error).message).slice(0, 2000)]);
        throw new Error(`Migration ${name} failed: ${(err as Error).message}`);
      }
      applied.push(name);
    }
    await client.query(input.initSql);
    if (input.appRlsPassword) {
      // A literal in DDL (no bind parameters there); quote it the way Postgres does.
      await client.query(`ALTER ROLE app_rls PASSWORD '${input.appRlsPassword.replace(/'/g, "''")}'`);
    }
    return { applied, total: names.length };
  } finally {
    await client.end();
  }
}

/**
 * Exact row counts of every table in the public schema, for checking a data move (the same query
 * runs against the old database, and the two results are compared table by table). Read-only.
 */
export async function tableCounts(databaseUrl: string): Promise<Record<string, number>> {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const tables = (await client.query<{ name: string }>(`SELECT tablename AS name FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename`)).rows;
    const counts: Record<string, number> = {};
    for (const { name } of tables) {
      const r = await client.query<{ n: string }>(`SELECT count(*)::text AS n FROM public."${name.replace(/"/g, '""')}"`);
      counts[name] = Number(r.rows[0]!.n);
    }
    return counts;
  } finally {
    await client.end();
  }
}
