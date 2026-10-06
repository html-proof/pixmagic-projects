import pg from "pg";
import { systemDb } from "./index.js";

/** Truncate every application table (tests only). */
export async function resetDb() {
  if (!/_test\b/.test(process.env.DATABASE_URL ?? "")) {
    throw new Error("resetDb refused: DATABASE_URL must point at a *_test database");
  }
  const rows = await systemDb.$queryRaw<Array<{ tablename: string }>>`
    SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`;
  if (rows.length) {
    await systemDb.$executeRawUnsafe(`TRUNCATE ${rows.map((r) => `"${r.tablename}"`).join(", ")} CASCADE`);
  }
}

/**
 * Take the integration-test lock for the database `databaseUrl` points at, and hold it until the
 * returned function is called.
 *
 * The suites truncate every table between tests (`resetDb`), so two runs sharing one database
 * quietly destroy each other: an insert deadlocks against the other run's TRUNCATE, or rows
 * written a moment earlier are simply gone. The damage lands on whichever tests happen to be
 * running, so it moves between runs and reads as a flaky suite rather than a collision.
 *
 * Counting connections cannot detect this. Vitest starts a fresh worker per test file and Prisma
 * closes its pool when the file ends, so a run has no connections open about half the time — a
 * second run sampling one of those windows sees an idle database and starts anyway.
 *
 * A session-level advisory lock is held for the whole run instead, and Postgres drops it when the
 * connection goes away, so a killed run leaves nothing behind to clear up. The lock lives in the
 * maintenance database, which lets us take it before the test database exists (`migrate:deploy`
 * creates it, and two runs migrating at once corrupt `_prisma_migrations`).
 */
export async function lockTestDatabase(databaseUrl: string, waitMs = 60_000): Promise<() => Promise<void>> {
  const url = new URL(databaseUrl);
  const database = decodeURIComponent(url.pathname.replace(/^\//, ""));
  if (!/_test\b/.test(database)) throw new Error(`lockTestDatabase refused: "${database}" is not a *_test database`);
  const maintenance = new URL(url);
  maintenance.pathname = "/postgres";

  const key = `app-integration-tests:${database}`;
  const client = new pg.Client({ connectionString: maintenance.toString(), application_name: `integration-tests:${database}` });
  await client.connect();
  try {
    const deadline = Date.now() + waitMs;
    for (;;) {
      const got = await client.query<{ locked: boolean }>("SELECT pg_try_advisory_lock(hashtext($1)) AS locked", [key]);
      if (got.rows[0]?.locked) break;
      if (Date.now() >= deadline) throw new Error(`${await describeHolder(client, key)}\n${ADVICE}`);
      await new Promise((r) => setTimeout(r, 250));
    }
    // We hold the lock, so no other run can be starting. Anything still connected to the test
    // database is a worker orphaned by a killed run, which would truncate tables under this one;
    // give a run that is just finishing a moment to close its pool before giving up on it.
    const orphanDeadline = Date.now() + 10_000;
    for (;;) {
      const { rows } = await client.query<{ who: string }>(
        `SELECT format('%s (%s%s)', pid, usename, nullif(' ' || application_name, ' ')) AS who
           FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid() ORDER BY pid`,
        [database],
      );
      if (rows.length === 0) break;
      if (Date.now() >= orphanDeadline) {
        throw new Error(
          `test database "${database}" still has ${rows.length} connection(s) from an earlier run: ` +
            `${rows.map((r) => r.who).join(", ")}\n${ADVICE}`,
        );
      }
      await new Promise((r) => setTimeout(r, 250));
    }
  } catch (err) {
    await release(client, key);
    throw err;
  }
  return () => release(client, key);
}

/**
 * Closing the connection would drop the lock too, but not necessarily before the next caller
 * asks for it: `end()` resolves without waiting for the backend to go away, so `pnpm
 * test:integration` (api then worker, back to back) could find the lock still held. Release it
 * explicitly, then close.
 */
async function release(client: pg.Client, key: string) {
  await client.query("SELECT pg_advisory_unlock(hashtext($1))", [key]).catch(() => {});
  await client.end().catch(() => {});
}

const ADVICE =
  "Wait for that run to finish, kill the leftover vitest workers, " +
  "or give this run its own database with TEST_DB=<name>_test.";

/** Who is holding the lock, for an error message worth reading. */
async function describeHolder(client: pg.Client, key: string): Promise<string> {
  const { rows } = await client.query<{ who: string }>(
    `SELECT format('%s (%s%s, started %s)', a.pid, a.usename, nullif(' ' || a.application_name, ' '),
                   to_char(a.backend_start, 'HH24:MI:SS')) AS who
       FROM pg_locks l JOIN pg_stat_activity a USING (pid)
      WHERE l.locktype = 'advisory' AND l.granted AND l.objid = (SELECT hashtext($1)::oid)`,
    [key],
  );
  const who = rows.map((r) => r.who).join(", ");
  return `another integration run holds the test-database lock${who ? `: ${who}` : ""}`;
}
