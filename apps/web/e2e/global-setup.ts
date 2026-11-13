import { execSync } from "node:child_process";
import { resolve } from "node:path";
import { E2E_ENV, E2E_MAILPIT_URL } from "../playwright.config";

export default async function globalSetup() {
  const root = resolve(import.meta.dirname, "../../..");
  const env = { ...process.env, ...E2E_ENV };
  execSync("pnpm --filter @app/db test:prepare", { cwd: root, env, stdio: "inherit" });
  execSync("pnpm --filter @app/db exec prisma db execute --stdin", {
    cwd: root,
    env,
    input: `DO $$ DECLARE r record; BEGIN FOR r IN SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename <> '_prisma_migrations' LOOP EXECUTE 'TRUNCATE "' || r.tablename || '" CASCADE'; END LOOP; END $$;`,
  });
  // Empty the Mailpit inbox.
  await fetch(`${E2E_MAILPIT_URL}/api/v1/messages`, { method: "DELETE" });
}
