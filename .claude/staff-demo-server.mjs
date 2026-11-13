// Local Staff Management preview: the real app (UI + API + jobs, on the local server) with its own
// sign-in, a Mailpit-compatible inbox and its own `app_staffdemo` database (never the production `app` DB).
//
//   node .claude/staff-demo-server.mjs [--port 8795] [--pg 5434] [--mail http://localhost:8025] [--assets apps/web/out-staffdemo]
//
// Defaults match docker compose. Without Docker, point --pg at a throwaway Postgres
// (docs/local-dev.md, TEST_PG_PORT).
// Build the UI first (the UI needs no sign-in settings):
//   NEXT_EXPORT_DIR=out-staffdemo pnpm --filter @app/web build
// and apply migrations: DATABASE_URL=postgresql://app:app@localhost:<pg>/app_staffdemo pnpm --filter @app/db test:prepare
//
// Demo sign-in (emulator only, never a real account; sign up once with these, codes in the emulator's log): owner@staffdemo.test / Demo-Owner-Pass-2026;
// employees jamie@, priya@, alex@staffdemo.test / Demo-Staff-Pass-2026.
import { startLocalServer } from "./local-server.mjs";

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};

startLocalServer({
  port: arg("port", "8795"),
  assets: arg("assets", "apps/web/out-staffdemo"),
  db: `localhost:${arg("pg", "5434")}/app_staffdemo`,
  env: { MAILPIT_URL: arg("mail", "http://localhost:8025") },
});
