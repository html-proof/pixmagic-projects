// Local Email integrations preview: the real Worker (UI + API) with the Firebase Auth emulator, a
// Mailpit-compatible inbox and its own `email_demo` database (never the production `app` DB).
//
//   node .claude/email-demo-server.mjs [--port 8797] [--pg 5434] [--auth 127.0.0.1:9099] [--mail http://localhost:8025] [--assets apps/web/out-emaildemo]
//
// Defaults match docker compose. Without Docker, point --pg at a throwaway Postgres
// (docs/local-dev.md, TEST_PG_PORT) and --auth at `firebase emulators:start --only auth`.
// Build the UI first with the same emulator host:
//   NEXT_EXPORT_DIR=out-emaildemo NEXT_PUBLIC_FIREBASE_AUTH_EMULATOR=http://<auth> NEXT_PUBLIC_FIREBASE_PROJECT_ID=demo-insights NEXT_PUBLIC_FIREBASE_API_KEY=demo-key pnpm --filter @app/web build
// and apply migrations: DATABASE_URL=postgresql://app:app@localhost:<pg>/email_demo pnpm --filter @app/db test:prepare
//
// Demo sign-in (Auth emulator only, never a real account): owner@emaildemo.test / Demo-Owner-Pass-2026,
// then seed sample data: (from apps/worker) npx vitest run --config demo/email.vitest.config.ts
import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const port = arg("port", "8797");
const pg = arg("pg", "5434");
const auth = arg("auth", "127.0.0.1:9099");
const mail = arg("mail", "http://localhost:8025");
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const assets = resolve(root, arg("assets", "apps/web/out-emaildemo"));

const env = {
  ...process.env,
  CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE: `postgresql://app:app@localhost:${pg}/email_demo`,
  CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE_RLS: `postgresql://app_rls:app_rls@localhost:${pg}/email_demo`,
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
    `FIREBASE_AUTH_EMULATOR_HOST:${auth}`,
    "--persist-to",
    ".wrangler/emaildemo",
    "--assets",
    assets,
  ],
  { cwd, env, stdio: "inherit" },
);
child.on("exit", (code) => process.exit(code ?? 0));
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => child.kill(sig));
