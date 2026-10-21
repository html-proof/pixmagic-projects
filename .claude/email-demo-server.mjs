// Local Email integrations preview: the real app (UI + API + jobs, on the local server) with the Cognito
// emulator, a Mailpit-compatible inbox and its own `email_demo` database (never the production `app` DB).
//
//   node .claude/email-demo-server.mjs [--port 8797] [--pg 5434] [--auth http://127.0.0.1:9229] [--mail http://localhost:8025] [--assets apps/web/out-emaildemo]
//
// Defaults match docker compose. Without Docker, point --pg at a throwaway Postgres
// (docs/local-dev.md, TEST_PG_PORT) and --auth at `node infra/cognito-local/start.mjs`.
// Build the UI first (the UI needs no sign-in settings):
//   NEXT_EXPORT_DIR=out-emaildemo pnpm --filter @app/web build
// and apply migrations: DATABASE_URL=postgresql://app:app@localhost:<pg>/email_demo pnpm --filter @app/db test:prepare
//
// Demo sign-in (emulator only, never a real account; sign up once with these, codes in the emulator's log): owner@emaildemo.test / Demo-Owner-Pass-2026,
// then seed sample data: (from apps/worker) npx vitest run --config demo/email.vitest.config.ts
import { startLocalServer } from "./local-server.mjs";

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};

startLocalServer({
  port: arg("port", "8797"),
  assets: arg("assets", "apps/web/out-emaildemo"),
  db: `localhost:${arg("pg", "5434")}/email_demo`,
  env: { MAILPIT_URL: arg("mail", "http://localhost:8025"), COGNITO_ENDPOINT: arg("auth", "http://127.0.0.1:9229") },
});
