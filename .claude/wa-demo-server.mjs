// Local WhatsApp demo: the real app (UI + API + jobs, on the local server) on http://localhost:8793, on
// its own database `wa_demo` in a throwaway Postgres (127.0.0.1:5447), never `app` or `app_demo`.
// Uses the Cognito emulator (docker compose up -d cognito) and Mailpit from docker compose. Build its UI first:
//   NEXT_EXPORT_DIR=out-wademo pnpm --filter @app/web build   (the UI needs no sign-in settings)
// Fill it with sample data: apps/worker/demo/README (vitest seed, test values only).
import { startLocalServer } from "./local-server.mjs";

startLocalServer({
  port: process.env.PORT ?? "8793",
  assets: "apps/web/out-wademo",
  db: process.env.WA_DEMO_PG ?? "localhost:5447/wa_demo",
  env: { COGNITO_ENDPOINT: "http://127.0.0.1:9229" },
});
