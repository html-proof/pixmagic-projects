import pg from "pg";

/**
 * Release 2 of removing Evolution API (docs/whatsapp.md, "Removing Evolution"): the service's own
 * database (`evolution`, on the app's RDS instance) and its login role go, once. The cron's
 * "evolution-db-drop" action runs this; the WhatsApp stack's one remaining resource invokes it
 * during the deploy that removes the service (infra/cdk/lib/whatsapp-stack.ts). Idempotent: what
 * is already gone is fine. FORCE ends the connections of the service's last task, which
 * CloudFormation stops later in that same update. Release 3 removes this file.
 */
const NAME = /^[a-z_][a-z0-9_]{0,30}$/;

export async function dropEvolutionDb(input: { databaseUrl: string; user?: string; database?: string }): Promise<{ database: "dropped" | "absent"; role: "dropped" | "absent" }> {
  const user = input.user ?? "evolution";
  const database = input.database ?? "evolution";
  if (!NAME.test(user) || !NAME.test(database)) throw new Error("Evolution's database or role name isn't a plain identifier");
  const client = new pg.Client({ connectionString: input.databaseUrl });
  await client.connect();
  try {
    const hadDb = (await client.query(`SELECT 1 FROM pg_database WHERE datname = $1`, [database])).rowCount! > 0;
    if (hadDb) await client.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`);
    const hadRole = (await client.query(`SELECT 1 FROM pg_roles WHERE rolname = $1`, [user])).rowCount! > 0;
    // The role owned only its database (it had no rights in the app's): nothing else to hand over.
    if (hadRole) await client.query(`DROP ROLE IF EXISTS "${user}"`);
    return { database: hadDb ? "dropped" : "absent", role: hadRole ? "dropped" : "absent" };
  } finally {
    await client.end();
  }
}
