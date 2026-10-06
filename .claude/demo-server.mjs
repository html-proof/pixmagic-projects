// Local demo: the real Worker (UI + API + queue consumers) on http://localhost:8789, using the
// Firebase Auth emulator, Mailpit and a separate `app_demo` database (never the production `app` DB).
// Build its UI first:
//   NEXT_EXPORT_DIR=out-demo NEXT_PUBLIC_FIREBASE_AUTH_EMULATOR=http://127.0.0.1:9099 //   NEXT_PUBLIC_FIREBASE_PROJECT_ID=demo-insights NEXT_PUBLIC_FIREBASE_API_KEY=demo-key pnpm --filter @app/web build
// then start it from the Browser pane's "demo" launch configuration ("demo-nomail" simulates a
// production without an email sending domain).
import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const env = {
  ...process.env,
  CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE: "postgresql://app:app@localhost:5434/app_demo",
  CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE_RLS: "postgresql://app_rls:app_rls@localhost:5434/app_demo",
};
const cwd = resolve(root, "apps/cloudflare");
const child = spawn(
  process.execPath,
  [
    resolve(cwd, "node_modules/wrangler/bin/wrangler.js"),
    "dev",
    "--port",
    "8789",
    "--env-file",
    resolve(root, "apps/web/e2e/worker.env"),
    "--persist-to",
    ".wrangler/demo",
    // The demo UI is built separately (NEXT_EXPORT_DIR=out-demo, emulator settings) so it never
    // fights a regular `wrangler dev` over apps/web/out.
    "--assets",
    resolve(root, "apps/web/out-demo"),
    // --no-mail: make email sending fail like production without a sending domain (tests the sign-in link fallback).
    ...(process.argv.includes("--no-mail") ? ["--var", "MAILPIT_URL:http://127.0.0.1:9"] : []),
  ],
  { cwd, env, stdio: "inherit" },
);
child.on("exit", (code) => process.exit(code ?? 0));
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => child.kill(sig));
