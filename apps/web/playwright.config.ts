import { resolve } from "node:path";
import { defineConfig } from "@playwright/test";

/**
 * E2E runs the real app on the local server (apps/aws/src/local.ts: static UI + API + jobs)
 * against its own Cognito emulator (started here, empty every run), a stand-in for the user pool's
 * managed login (e2e/fake-managed-login.mjs: "Continue with Google"), Mailpit and a dedicated
 * app_e2e database (docker compose up -d postgres mailpit first).
 *
 * Ports default to the docker compose stack. Override them to run e2e beside a local demo, which
 * uses the same server port and Mailpit: global setup wipes every Mailpit message.
 *   E2E_PORT (8789), E2E_COGNITO_PORT (9249), E2E_LOGIN_PORT (9259), E2E_MAILPIT_URL (http://localhost:8025)
 */
export const E2E_PORT = Number(process.env.E2E_PORT ?? 8789);
export const E2E_BASE_URL = `http://localhost:${E2E_PORT}`;
export const E2E_COGNITO_PORT = Number(process.env.E2E_COGNITO_PORT ?? 9249);
export const E2E_LOGIN_PORT = Number(process.env.E2E_LOGIN_PORT ?? 9259);
/** The emulator's working directory (its database: codes it "emails" are read from there). */
export const E2E_COGNITO_DATA = resolve(import.meta.dirname, ".e2e/cognito");
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
  // The local server's database (owner and app_rls roles).
  ...E2E_ENV,
  /**
   * Build into our own folder, and serve that folder below, so a test build never lands in
   * `apps/web/out`: the folder a local server serves by default.
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
      // Google, as far as the app can tell (the user pool's managed login domain).
      command: `node e2e/fake-managed-login.mjs ${E2E_LOGIN_PORT} ${COGNITO_ENDPOINT}/local_insights ${CLIENT.id} ${CLIENT.secret}`,
      port: E2E_LOGIN_PORT,
      reuseExistingServer: false,
      timeout: 30_000,
    },
    {
      // --assets must match NEXT_EXPORT_DIR above. e2e/server.env holds the settings; the
      // addresses follow the ports above (the environment wins over the env file). The server
      // keeps its state in memory, so each run starts empty: rate-limit windows kept from an
      // earlier run (10 sign-in codes per IP, and every test is 127.0.0.1) can't fail its sign-ins.
      command:
        `pnpm --filter @app/web build && ` +
        `pnpm --filter @app/aws exec tsx src/dev.ts --port ${E2E_PORT} --settings ../web/e2e/server.env --assets ../web/out-e2e`,
      url: `${E2E_BASE_URL}/api/healthz`,
      env: {
        ...env,
        APP_URL: E2E_BASE_URL,
        API_URL: `${E2E_BASE_URL}/api`,
        MAILPIT_URL: E2E_MAILPIT_URL,
        COGNITO_ENDPOINT,
        COGNITO_DOMAIN: `http://127.0.0.1:${E2E_LOGIN_PORT}`,
        COGNITO_IDENTITY_PROVIDERS: "Google",
      },
      reuseExistingServer: false,
      timeout: 240_000,
    },
  ],
});
