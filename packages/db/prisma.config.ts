import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { defineConfig, env } from "prisma/config";

// Prisma CLI (migrate, db execute) runs in Node: load the repo-root .env in dev.
const rootEnv = resolve(import.meta.dirname, "../../.env");
if (!process.env.DATABASE_URL && !process.env.OWNER_DATABASE_URL && existsSync(rootEnv)) process.loadEnvFile(rootEnv);
// Migrations change tables, which only the owner may: its login when one is given apart from
// systemDb's (the tests, e2e; docs/system-database-role.md), else DATABASE_URL as before.
const URL_VAR = process.env.OWNER_DATABASE_URL ? "OWNER_DATABASE_URL" : "DATABASE_URL";

/**
 * Production's database is named `app` (and, on the machine that hosts it, sits on the same
 * server as the development ones). `migrate dev` and `migrate reset` may drop every row of the
 * database they run on, so they refuse it; `migrate deploy` (applying migrations) still runs.
 */
const PRODUCTION_DATABASE = "app";
const [command, sub] = process.argv.slice(2).filter((a) => !a.startsWith("-"));
if (command === "migrate" && (sub === "dev" || sub === "reset")) {
  let database = "";
  try {
    database = decodeURIComponent(new URL(process.env[URL_VAR] ?? "").pathname.slice(1));
  } catch {
    /* no URL: Prisma reports that itself */
  }
  if (database === PRODUCTION_DATABASE) {
    throw new Error(`Refusing \`prisma migrate ${sub}\` on the "${PRODUCTION_DATABASE}" database (production's): it can delete every row. Point DATABASE_URL at app_dev.`);
  }
}

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: { path: "prisma/migrations" },
  // `prisma generate` (this package's postinstall) needs no database, and a fresh clone or a CI
  // install has no DATABASE_URL yet: env() would throw and fail `pnpm install`. Commands that do
  // connect (migrate, db execute) still refuse to run without one.
  ...(process.env[URL_VAR] ? { datasource: { url: env(URL_VAR) } } : {}),
});
