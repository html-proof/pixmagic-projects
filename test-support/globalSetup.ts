import { execSync } from "node:child_process";
import { resolve } from "node:path";
// By path, not "@app/db/testing": Vitest 4 resolves a global setup's imports from this folder,
// which sits outside every workspace package and so has no link to @app/db.
import { lockTestDatabase } from "../packages/db/src/testing.js";
import { testEnv } from "./env.js";

/** Create/migrate the *_test database and apply role grants before integration tests. */
export default async function setup() {
  const env = { ...process.env, ...testEnv, CI_OVERRIDE: "1" };
  if (process.env.CI_DATABASE_URL) env.DATABASE_URL = process.env.CI_DATABASE_URL;
  const run = (script: string) =>
    execSync(`pnpm --filter @app/db ${script}`, { stdio: "inherit", env, cwd: resolve(__dirname, "..") });

  // The suites truncate the whole database between tests, so they need it to themselves. Take the
  // lock before touching it at all: two runs migrating at once corrupt `_prisma_migrations`.
  const unlock = await lockTestDatabase(env.DATABASE_URL);
  try {
    // With TEST_DB pointing at a database that doesn't exist yet, this creates it.
    run("migrate:deploy");
    run("test:grants");
  } catch (err) {
    await unlock();
    throw err;
  }
  return unlock;
}
