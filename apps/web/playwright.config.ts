import { defineConfig } from "@playwright/test";

/**
 * E2E runs the real Worker (`wrangler dev`: static UI + API + queue consumers)
 * against the Firebase Auth emulator, Mailpit and a dedicated app_e2e database
 * (docker compose up -d first).
 */
export const E2E_PORT = 8789;
export const E2E_BASE_URL = `http://localhost:${E2E_PORT}`;

export const E2E_ENV = {
  DATABASE_URL: "postgresql://app:app@localhost:5434/app_e2e",
  APP_DATABASE_URL: "postgresql://app_rls:app_rls@localhost:5434/app_e2e",
};

const env = {
  ...process.env,
  ...E2E_ENV,
  // Point the Worker's Hyperdrive bindings at the e2e database.
  CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE: E2E_ENV.DATABASE_URL,
  CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE_RLS: E2E_ENV.APP_DATABASE_URL,
  // Baked into the static UI at build time.
  NEXT_PUBLIC_FIREBASE_AUTH_EMULATOR: "http://127.0.0.1:9099",
  NEXT_PUBLIC_FIREBASE_PROJECT_ID: "demo-insights",
  NEXT_PUBLIC_FIREBASE_API_KEY: "demo-key",
  /**
   * Build into our own folder, and serve that folder below.
   *
   * Without this the e2e build lands in `apps/web/out` — the directory `wrangler.jsonc` serves
   * and `wrangler deploy` ships — and silently replaces the real build with one wired to the
   * Firebase Auth emulator on 127.0.0.1:9099. Running the e2e suite then breaks `wrangler dev`
   * for everyone afterwards (sign-in fails with `auth/internal-error`, because the emulator
   * isn't there), and a deploy from that checkout would carry it to production. The demo server
   * already avoided this the same way (`NEXT_EXPORT_DIR=out-demo`); e2e did not.
   */
  NEXT_EXPORT_DIR: "out-e2e",
} as Record<string, string>;

export default defineConfig({
  testDir: "./e2e",
  globalSetup: "./e2e/global-setup.ts",
  timeout: 60_000,
  workers: 1,
  use: { baseURL: E2E_BASE_URL, trace: "retain-on-failure" },
  webServer: [
    {
      // --assets must match NEXT_EXPORT_DIR above; it overrides the `assets.directory` in
      // wrangler.jsonc, which points at the real build.
      command: `pnpm --filter @app/web build && pnpm --filter @app/cloudflare exec wrangler dev --port ${E2E_PORT} --env-file ../web/e2e/worker.env --persist-to .wrangler/e2e --assets ../web/out-e2e`,
      url: `${E2E_BASE_URL}/api/healthz`,
      env,
      reuseExistingServer: false,
      timeout: 240_000,
    },
  ],
});
