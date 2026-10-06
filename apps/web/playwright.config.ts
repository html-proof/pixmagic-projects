import { defineConfig } from "@playwright/test";

/**
 * E2E runs the real Worker (`wrangler dev`: static UI + API + queue consumers)
 * against the Firebase Auth emulator, Mailpit and a dedicated app_e2e database
 * (docker compose up -d first).
 *
 * Ports default to the docker compose stack. Override them to run e2e beside a local demo, which
 * uses the same Worker port, emulator and Mailpit: global setup wipes every emulator account and
 * every Mailpit message, which signs the demo out from under whoever is using it.
 *   E2E_PORT (8789), E2E_AUTH_EMULATOR_HOST (127.0.0.1:9099), E2E_MAILPIT_URL (http://localhost:8025)
 */
export const E2E_PORT = Number(process.env.E2E_PORT ?? 8789);
export const E2E_BASE_URL = `http://localhost:${E2E_PORT}`;
export const E2E_AUTH_EMULATOR_HOST = process.env.E2E_AUTH_EMULATOR_HOST ?? "127.0.0.1:9099";
export const E2E_MAILPIT_URL = process.env.E2E_MAILPIT_URL ?? "http://localhost:8025";

// TEST_PG_PORT points e2e at another Postgres server (e.g. a throwaway container); default 5434.
const PG_PORT = process.env.TEST_PG_PORT ?? "5434";

export const E2E_ENV = {
  DATABASE_URL: `postgresql://app:app@localhost:${PG_PORT}/app_e2e`,
  APP_DATABASE_URL: `postgresql://app_rls:app_rls@localhost:${PG_PORT}/app_e2e`,
};

const env = {
  ...process.env,
  ...E2E_ENV,
  // Point the Worker's Hyperdrive bindings at the e2e database.
  CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE: E2E_ENV.DATABASE_URL,
  CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE_RLS: E2E_ENV.APP_DATABASE_URL,
  // Baked into the static UI at build time.
  NEXT_PUBLIC_FIREBASE_AUTH_EMULATOR: `http://${E2E_AUTH_EMULATOR_HOST}`,
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
      // The --var overrides follow the ports above (worker.env holds the defaults). The Worker's
      // local state starts empty each run: rate-limit windows kept from an earlier run within the
      // hour (10 sign-in codes per IP, and every test is 127.0.0.1) failed later runs' sign-ins.
      command:
        `node -e "require('fs').rmSync('../cloudflare/.wrangler/e2e',{recursive:true,force:true})" && ` +
        `pnpm --filter @app/web build && pnpm --filter @app/cloudflare exec wrangler dev --port ${E2E_PORT} --env-file ../web/e2e/worker.env ` +
        `--var APP_URL:${E2E_BASE_URL} --var API_URL:${E2E_BASE_URL}/api --var MAILPIT_URL:${E2E_MAILPIT_URL} --var FIREBASE_AUTH_EMULATOR_HOST:${E2E_AUTH_EMULATOR_HOST} ` +
        `--persist-to .wrangler/e2e --assets ../web/out-e2e`,
      url: `${E2E_BASE_URL}/api/healthz`,
      env,
      reuseExistingServer: false,
      timeout: 240_000,
    },
  ],
});
