// Local Staff Management preview: the real Worker (UI + API) with the Cognito emulator, a
// Mailpit-compatible inbox and its own `app_staffdemo` database (never the production `app` DB).
//
//   node .claude/staff-demo-server.mjs [--port 8795] [--pg 5434] [--auth http://127.0.0.1:9229] [--mail http://localhost:8025] [--assets apps/web/out-staffdemo]
//
// Defaults match docker compose. Without Docker, point --pg at a throwaway Postgres
// (docs/local-dev.md, TEST_PG_PORT) and --auth at `node infra/cognito-local/start.mjs`.
// Build the UI first (the UI needs no sign-in settings):
//   NEXT_EXPORT_DIR=out-staffdemo pnpm --filter @app/web build
// and apply migrations: DATABASE_URL=postgresql://app:app@localhost:<pg>/app_staffdemo pnpm --filter @app/db test:prepare
//
// Demo sign-in (emulator only, never a real account; sign up once with these, codes in the emulator's log): owner@staffdemo.test / Demo-Owner-Pass-2026;
// employees jamie@, priya@, alex@staffdemo.test / Demo-Staff-Pass-2026.
import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const port = arg("port", "8795");
const pg = arg("pg", "5434");
const auth = arg("auth", "http://127.0.0.1:9229");
const mail = arg("mail", "http://localhost:8025");
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const assets = resolve(root, arg("assets", "apps/web/out-staffdemo"));

const env = {
  ...process.env,
  CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE: `postgresql://app:app@localhost:${pg}/app_staffdemo`,
  CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE_RLS: `postgresql://app_rls:app_rls@localhost:${pg}/app_staffdemo`,
};
const cwd = resolve(root, "apps/cloudflare");
const child = spawn(
  process.execPath,
  [
    resolve(cwd, "node_modules/wrangler/bin/wrangler.js"),
    "dev",
    "--port",
    port,
    "--env-file",
    resolve(root, "apps/web/e2e/worker.env"),
    "--var",
    `APP_URL:http://localhost:${port}`,
    "--var",
    `API_URL:http://localhost:${port}/api`,
    "--var",
    `MAILPIT_URL:${mail}`,
    "--var",
    `COGNITO_ENDPOINT:${auth}`,
    "--persist-to",
    ".wrangler/staffdemo",
    "--assets",
    assets,
  ],
  { cwd, env, stdio: "inherit" },
);
child.on("exit", (code) => process.exit(code ?? 0));
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => child.kill(sig));
