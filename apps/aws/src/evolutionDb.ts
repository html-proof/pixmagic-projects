import pg from "pg";

/**
 * bizinsights' Evolution API service (WhatsApp, docs/whatsapp.md) keeps its own data (its
 * instances and their WhatsApp sessions) in a database of its own on the same RDS instance as the
 * app: `evolution`, owned by a login role of its own that has no rights in the app's database. No
 * second database server: one more database on the one that is there.
 *
 * ensureEvolutionDb (the cron's "evolution-db" action) makes the role and the database, or sets the
 * role's password again from its secret (insights/<env>/evolution-db). CloudFormation runs it
 * before the Evolution service starts (infra/cdk/lib/whatsapp-stack.ts), and it is idempotent.
 */
const NAME = /^[a-z_][a-z0-9_]{0,30}$/;
const quoteLiteral = (s: string) => `'${s.replace(/'/g, "''")}'`;

export async function ensureEvolutionDb(input: { databaseUrl: string; user: string; password: string; database: string }): Promise<{ role: "created" | "updated"; database: "created" | "exists" }> {
  if (!NAME.test(input.user) || !NAME.test(input.database)) throw new Error("Evolution's database or role name isn't a plain identifier");
  if (input.password.length < 20) throw new Error("Evolution's database password is too short");
  const client = new pg.Client({ connectionString: input.databaseUrl });
  await client.connect();
  try {
    const hasRole = (await client.query(`SELECT 1 FROM pg_roles WHERE rolname = $1`, [input.user])).rowCount! > 0;
    // A literal in DDL (no bind parameters there), quoted the way Postgres does.
    if (hasRole) await client.query(`ALTER ROLE "${input.user}" WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD ${quoteLiteral(input.password)}`);
    else await client.query(`CREATE ROLE "${input.user}" WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD ${quoteLiteral(input.password)}`);
    const hasDb = (await client.query(`SELECT 1 FROM pg_database WHERE datname = $1`, [input.database])).rowCount! > 0;
    if (!hasDb) {
      // Making a database owned by another role needs membership of it (PostgreSQL 16+).
      await client.query(`GRANT "${input.user}" TO CURRENT_USER`);
      await client.query(`CREATE DATABASE "${input.database}" OWNER "${input.user}"`);
    }
    // Only its owner (and the master) may connect to it: not the app's tenant role.
    await client.query(`REVOKE ALL ON DATABASE "${input.database}" FROM PUBLIC`);
    return { role: hasRole ? "updated" : "created", database: hasDb ? "exists" : "created" };
  } finally {
    await client.end();
  }
}

/**
 * What Evolution keeps that bizinsights doesn't need kept: its Cloud API integration stores every
 * message it sends (whatever its settings say), and an instance's own message and status records.
 * Deleted after `days` (the nightly cron). bizinsights' own history (wapp_messages) has its own
 * retention. Returns how many rows went; 0 before Evolution has made its tables.
 */
export async function pruneEvolutionData(databaseUrl: string, days: number): Promise<number> {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    let n = 0;
    const cutoff = Math.floor(Date.now() / 1000) - days * 86_400;
    if ((await client.query(`SELECT to_regclass('public."MessageUpdate"') AS t`)).rows[0]?.t) {
      n += (await client.query(`DELETE FROM "MessageUpdate" WHERE "messageId" IN (SELECT id FROM "Message" WHERE "messageTimestamp" < $1)`, [cutoff])).rowCount ?? 0;
    }
    if ((await client.query(`SELECT to_regclass('public."Message"') AS t`)).rows[0]?.t) {
      n += (await client.query(`DELETE FROM "Message" WHERE "messageTimestamp" < $1`, [cutoff])).rowCount ?? 0;
    }
    return n;
  } finally {
    await client.end();
  }
}

/** The evolution database's address, from the app's database settings and Evolution's own role. */
export function evolutionDbUrl(env: NodeJS.ProcessEnv, as: "owner" | "master"): string | null {
  if (!env.DB_HOST || !env.EVOLUTION_DB_PASSWORD) return null;
  const port = env.DB_PORT ?? "5432";
  if (as === "master") return env.DATABASE_URL ?? null;
  const user = env.EVOLUTION_DB_USER || "evolution";
  return `postgresql://${encodeURIComponent(user)}:${encodeURIComponent(env.EVOLUTION_DB_PASSWORD)}@${env.DB_HOST}:${port}/evolution?sslmode=verify-full`;
}
