import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { defineConfig, env } from "prisma/config";

// Prisma CLI (migrate, db execute) runs in Node: load the repo-root .env in dev.
const rootEnv = resolve(import.meta.dirname, "../../.env");
if (!process.env.DATABASE_URL && existsSync(rootEnv)) process.loadEnvFile(rootEnv);

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: { path: "prisma/migrations" },
  // `prisma generate` (this package's postinstall) needs no database, and a fresh clone or a CI
  // install has no DATABASE_URL yet: env() would throw and fail `pnpm install`. Commands that do
  // connect (migrate, db execute) still refuse to run without one.
  ...(process.env.DATABASE_URL ? { datasource: { url: env("DATABASE_URL") } } : {}),
});
