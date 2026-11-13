// Local demo: the real app (UI + API + jobs, on the local server) on http://localhost:8789, using
// the app's own sign-in, Mailpit and a
// separate `app_demo` database (never the production `app` DB).
// Build its UI first:
//   NEXT_EXPORT_DIR=out-demo pnpm --filter @app/web build   (the UI needs no sign-in settings)
// then start it from the Browser pane's "demo" launch configuration ("demo-nomail" simulates a
// production without an email sending domain).
import { startLocalServer } from "./local-server.mjs";

startLocalServer({
  port: 8789,
  // The demo UI is built separately (NEXT_EXPORT_DIR=out-demo) so it never fights a regular local
  // server over apps/web/out.
  assets: "apps/web/out-demo",
  db: "localhost:5434/app_demo",
  env: {
    // --no-mail: make email sending fail like production without a sending domain.
    ...(process.argv.includes("--no-mail") ? { MAILPIT_URL: "http://127.0.0.1:9" } : {}),
  },
});
