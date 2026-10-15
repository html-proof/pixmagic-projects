// Local advertising demo: the real app (UI + API + jobs, on the local server) on http://localhost:8789,
// on its own database `ads_demo` in a throwaway Postgres (127.0.0.1:5451), never `app` or `app_demo`.
// Uses the Cognito emulator (docker compose up -d cognito) and Mailpit from docker compose. Build its UI first:
//   NEXT_EXPORT_DIR=out-adsdemo pnpm --filter @app/web build   (the UI needs no sign-in settings)
// Google Ads and Meta Ads are switched on with Insights' real PUBLIC ids (so the buttons open the real
// Google and Meta screens; 8789 is a registered redirect on the Google client) and placeholder secrets,
// so no sign-in can complete here. Nothing secret is in this file.
import { startLocalServer } from "./local-server.mjs";

startLocalServer({
  port: process.env.PORT ?? "8789",
  assets: "apps/web/out-adsdemo",
  db: process.env.ADS_DEMO_PG ?? "localhost:5451/ads_demo",
  env: {
    COGNITO_ENDPOINT: "http://127.0.0.1:9229",
    GOOGLE_ADS_CLIENT_ID: "534794119904-9esdp8dhskcupf6ekbb0iej2dr10gomf.apps.googleusercontent.com",
    GOOGLE_ADS_CLIENT_SECRET: "placeholder-not-a-secret",
    GOOGLE_ADS_DEVELOPER_TOKEN: "placeholder-not-a-token",
    META_APP_ID: "1799660384680551",
    META_APP_SECRET: "placeholder-not-a-secret",
  },
});
