// Local WhatsApp demo: the real Worker (UI + API + queue consumers) on http://localhost:8793, on its
// own database `wa_demo` in a throwaway Postgres (127.0.0.1:5447), never `app` or `app_demo`.
// Uses the Cognito emulator (docker compose up -d cognito) and Mailpit from docker compose. Build its UI first:
//   NEXT_EXPORT_DIR=out-wademo pnpm --filter @app/web build   (the UI needs no sign-in settings)
// Fill it with sample data: apps/worker/demo/README (vitest seed, test values only).
import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = process.env.PORT ?? "8793";
const PG = process.env.WA_DEMO_PG ?? "localhost:5447/wa_demo";
const env = {
  ...process.env,
  CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE: `postgresql://app:app@${PG}`,
  CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE_RLS: `postgresql://app_rls:app_rls@${PG}`,
};
const cwd = resolve(root, "apps/cloudflare");
const child = spawn(
  process.execPath,
  [
    resolve(cwd, "node_modules/wrangler/bin/wrangler.js"),
    "dev",
    "--port",
    PORT,
    "--env-file",
    resolve(root, "apps/web/e2e/worker.env"),
    "--var",
    `APP_URL:http://localhost:${PORT}`,
    "--var",
    `API_URL:http://localhost:${PORT}/api`,
    "--var",
    "COGNITO_ENDPOINT:http://127.0.0.1:9229",
    "--persist-to",
    ".wrangler/wademo",
    "--assets",
    resolve(root, "apps/web/out-wademo"),
  ],
  { cwd, env, stdio: "inherit" },
);
child.on("exit", (code) => process.exit(code ?? 0));
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => child.kill(sig));
