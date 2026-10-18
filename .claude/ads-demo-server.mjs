// Local advertising demo: the real app (UI + API + jobs, on the local server) on http://localhost:8789,
// on its own database `ads_demo` in a throwaway Postgres (127.0.0.1:5451), never `app` or `app_demo`.
// Uses the Cognito emulator (docker compose up -d cognito) and Mailpit from docker compose. Build its UI first:
//   NEXT_EXPORT_DIR=out-adsdemo pnpm --filter @app/web build   (the UI needs no sign-in settings)
// Google Ads, AdSense and Meta Ads are switched on with bizinsights' real PUBLIC ids (the Google client
// "Insights web" and the Meta Ads app, as in apps/aws/src/settings.ts) and placeholder secrets, so the
// buttons open the real Google and Meta screens and no sign-in can complete here. Google answers with a
// redirect_uri_mismatch error: localhost is not registered on the production client, and must not be
// (Google wants a separate Cloud project per deployment tier). Getting past it needs a dev project's
// client with http://localhost:8789/api/ads/<provider>/callback (docs/ads-review-packs.md, step 5).
// Google retired Ads API developer tokens on 2026-09-09: nothing to set for one. Nothing secret is in this file.
import { startLocalServer } from "./local-server.mjs";

startLocalServer({
  port: process.env.PORT ?? "8789",
  assets: "apps/web/out-adsdemo",
  db: process.env.ADS_DEMO_PG ?? "localhost:5451/ads_demo",
  env: {
    COGNITO_ENDPOINT: "http://127.0.0.1:9229",
    GOOGLE_ADS_CLIENT_ID: "534794119904-9esdp8dhskcupf6ekbb0iej2dr10gomf.apps.googleusercontent.com",
    GOOGLE_ADS_CLIENT_SECRET: "placeholder-not-a-secret",
    // The Meta Ads app "Insights" (its Facebook Login for Business configuration, META_CONFIG_ID, is in
    // the shipped settings). The WhatsApp app (1799660384680551) is another app.
    META_APP_ID: "971575545351940",
    META_APP_SECRET: "placeholder-not-a-secret",
  },
});
