// Local advertising demo: the real Worker (UI + API + queue consumers) on http://localhost:8789, on its
// own database `ads_demo` in a throwaway Postgres (127.0.0.1:5451), never `app` or `app_demo`.
// Uses the Cognito emulator (docker compose up -d cognito) and Mailpit from docker compose. Build its UI first:
//   NEXT_EXPORT_DIR=out-adsdemo pnpm --filter @app/web build   (the UI needs no sign-in settings)
// Google Ads and Meta Ads are switched on with Insights' real PUBLIC ids (so the buttons open the real
// Google and Meta screens; 8789 is a registered redirect on the Google client) and placeholder secrets,
// so no sign-in can complete here. Nothing secret is in this file.
import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = process.env.PORT ?? "8789";
const PG = process.env.ADS_DEMO_PG ?? "localhost:5451/ads_demo";
const env = {
  ...process.env,
  CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE: `postgresql://app:app@${PG}`,
  CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE_RLS: `postgresql://app_rls:app_rls@${PG}`,
};
const vars = {
  APP_URL: `http://localhost:${PORT}`,
  API_URL: `http://localhost:${PORT}/api`,
  COGNITO_ENDPOINT: "http://127.0.0.1:9229",
  GOOGLE_ADS_CLIENT_ID: "534794119904-9esdp8dhskcupf6ekbb0iej2dr10gomf.apps.googleusercontent.com",
  GOOGLE_ADS_CLIENT_SECRET: "placeholder-not-a-secret",
  GOOGLE_ADS_DEVELOPER_TOKEN: "placeholder-not-a-token",
  META_APP_ID: "1799660384680551",
  META_APP_SECRET: "placeholder-not-a-secret",
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
    ...Object.entries(vars).flatMap(([k, v]) => ["--var", `${k}:${v}`]),
    "--persist-to",
    ".wrangler/adsdemo",
    "--assets",
    resolve(root, "apps/web/out-adsdemo"),
  ],
  { cwd, env, stdio: "inherit" },
);
child.on("exit", (code) => process.exit(code ?? 0));
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => child.kill(sig));
