import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { defineConfig, env } from "prisma/config";

// Prisma CLI (migrate, db execute) runs in Node: load the repo-root .env in dev.
const rootEnv = resolve(import.meta.dirname, "../../.env");
if (!process.env.DATABASE_URL && existsSync(rootEnv)) process.loadEnvFile(rootEnv);

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
    database = decodeURIComponent(new URL(process.env.DATABASE_URL ?? "").pathname.slice(1));
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
  ...(process.env.DATABASE_URL ? { datasource: { url: env("DATABASE_URL") } } : {}),
});
