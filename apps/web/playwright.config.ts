import { resolve } from "node:path";
import { defineConfig } from "@playwright/test";

/**
 * E2E runs the real Worker (`wrangler dev`: static UI + API + queue consumers) against its own
 * Cognito emulator (started here, empty every run), a stand-in for the user pool's managed login
 * (e2e/fake-managed-login.mjs: "Continue with Google / Apple"), Mailpit and a dedicated app_e2e
 * database (docker compose up -d postgres mailpit first).
 *
 * Ports default to the docker compose stack. Override them to run e2e beside a local demo, which
 * uses the same Worker port and Mailpit: global setup wipes every Mailpit message.
 *   E2E_PORT (8789), E2E_COGNITO_PORT (9249), E2E_LOGIN_PORT (9259), E2E_MAILPIT_URL (http://localhost:8025)
 */
export const E2E_PORT = Number(process.env.E2E_PORT ?? 8789);
export const E2E_BASE_URL = `http://localhost:${E2E_PORT}`;
export const E2E_COGNITO_PORT = Number(process.env.E2E_COGNITO_PORT ?? 9249);
export const E2E_LOGIN_PORT = Number(process.env.E2E_LOGIN_PORT ?? 9259);
/** The emulator's working directory (its database: codes it "emails" are read from there). */
export const E2E_COGNITO_DATA = resolve(import.meta.dirname, "../cloudflare/.wrangler/cognito-e2e");
export const E2E_MAILPIT_URL = process.env.E2E_MAILPIT_URL ?? "http://localhost:8025";
const COGNITO_ENDPOINT = `http://127.0.0.1:${E2E_COGNITO_PORT}`;
const CLIENT = { id: "insightslocalwebclient00", secret: "insights-local-client-secret" };

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
  /**
   * Build into our own folder, and serve that folder below, so a test build never lands in
   * `apps/web/out`: the directory `wrangler.jsonc` serves and `wrangler deploy` ships.
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
      // The Cognito emulator, from the seed (no users) every run.
      command: `node ../../infra/cognito-local/start.mjs --port ${E2E_COGNITO_PORT} --data "${E2E_COGNITO_DATA}" --fresh`,
      port: E2E_COGNITO_PORT,
      reuseExistingServer: false,
      timeout: 180_000,
    },
    {
      // Google and Apple, as far as the app can tell (the user pool's managed login domain).
      command: `node e2e/fake-managed-login.mjs ${E2E_LOGIN_PORT} ${COGNITO_ENDPOINT}/local_insights ${CLIENT.id} ${CLIENT.secret}`,
      port: E2E_LOGIN_PORT,
      reuseExistingServer: false,
      timeout: 30_000,
    },
    {
      // --assets must match NEXT_EXPORT_DIR above; it overrides the `assets.directory` in
      // wrangler.jsonc, which points at the real build.
      // The --var overrides follow the ports above (worker.env holds the defaults). The Worker's
      // local state starts empty each run: rate-limit windows kept from an earlier run within the
      // hour (10 sign-in codes per IP, and every test is 127.0.0.1) failed later runs' sign-ins.
      command:
        `node -e "require('fs').rmSync('../cloudflare/.wrangler/e2e',{recursive:true,force:true})" && ` +
        `pnpm --filter @app/web build && pnpm --filter @app/cloudflare exec wrangler dev --port ${E2E_PORT} --env-file ../web/e2e/worker.env ` +
        `--var APP_URL:${E2E_BASE_URL} --var API_URL:${E2E_BASE_URL}/api --var MAILPIT_URL:${E2E_MAILPIT_URL} --var COGNITO_ENDPOINT:${COGNITO_ENDPOINT} ` +
        `--var COGNITO_DOMAIN:http://127.0.0.1:${E2E_LOGIN_PORT} --var COGNITO_IDENTITY_PROVIDERS:Google,SignInWithApple ` +
        `--persist-to .wrangler/e2e --assets ../web/out-e2e`,
      url: `${E2E_BASE_URL}/api/healthz`,
      env,
      reuseExistingServer: false,
      timeout: 240_000,
    },
  ],
});
