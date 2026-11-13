import { defineConfig } from "@playwright/test";

/**
 * E2E runs the real app on the local server (apps/aws/src/local.ts: static UI + API + jobs)
 * with the app's own sign-in, a stand-in for Google (e2e/fake-google.mjs: "Continue with Google",
 * started here), a stand-in for Evolution API
 * (e2e/evolution-stub.mjs: WhatsApp Automation's provider), Mailpit and a dedicated app_e2e database
 * (docker compose up -d postgres mailpit first).
 *
 * Ports default to the docker compose stack. Override them to run e2e beside a local demo, which
 * uses the same server port and Mailpit: global setup wipes every Mailpit message.
 *   E2E_PORT (8789), E2E_LOGIN_PORT (9259), E2E_EVOLUTION_PORT (9269),
 *   E2E_MAILPIT_URL (http://localhost:8025)
 */
export const E2E_PORT = Number(process.env.E2E_PORT ?? 8789);
export const E2E_BASE_URL = `http://localhost:${E2E_PORT}`;
export const E2E_LOGIN_PORT = Number(process.env.E2E_LOGIN_PORT ?? 9259);
/** The Evolution API stand-in; e2e/whatsapp.spec.ts plays the phone and WhatsApp through its /__control. */
export const E2E_EVOLUTION_PORT = Number(process.env.E2E_EVOLUTION_PORT ?? 9269);
export const E2E_EVOLUTION_URL = `http://127.0.0.1:${E2E_EVOLUTION_PORT}`;
export const E2E_MAILPIT_URL = process.env.E2E_MAILPIT_URL ?? "http://localhost:8025";
/** The stand-in for Google, and the OAuth client the app's own sign-in uses with it (test-only secret). */
const GOOGLE_ENDPOINT = `http://127.0.0.1:${E2E_LOGIN_PORT}`;
const GOOGLE_CLIENT = { id: "e2e-google-client.apps.googleusercontent.com", secret: "e2e-google-client-secret" };

// TEST_PG_PORT points e2e at another Postgres server (e.g. a throwaway container); default 5434.
const PG_PORT = process.env.TEST_PG_PORT ?? "5434";
// The superuser's password: "app" (docker compose), or the one a CI job on the PC gave its server.
const PG_PASSWORD = encodeURIComponent(process.env.TEST_PG_PASSWORD ?? "app");

/**
 * The app logs in as production's roles: the system role (systemDb, row-level security applies;
 * docs/system-database-role.md) and app_rls. The specs seed and inspect rows, and global setup
 * migrates, on the owner's login.
 */
export const E2E_ENV = {
  DATABASE_URL: `postgresql://app_system:app_system@127.0.0.1:${PG_PORT}/app_e2e`,
  OWNER_DATABASE_URL: `postgresql://app:${PG_PASSWORD}@127.0.0.1:${PG_PORT}/app_e2e`,
  APP_DATABASE_URL: `postgresql://app_rls:app_rls@127.0.0.1:${PG_PORT}/app_e2e`,
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
  /** Settings → Billing is tested before paid plans launch (src/lib/features.ts). */
  NEXT_PUBLIC_E2E_BILLING: "1",
} as Record<string, string>;

export default defineConfig({
  testDir: "./e2e",
  globalSetup: "./e2e/global-setup.ts",
  timeout: 60_000,
  workers: 1,
  // One line per test with its duration, on CI too (there the default, dot, prints a dot per test):
  // a slow run names its slow tests in the job's log.
  reporter: "list",
  /**
   * On the self-hosted runner only, a test that fails runs once more (in a fresh worker) before the
   * run fails, and passes as "flaky". That PC (the owner's laptop) runs the suite 2-3 times slower
   * on battery or under the owner's other work, and on battery its screen-off timer puts it into
   * Modern Standby for minutes in the middle of a job (2026-10-20: 279 s asleep inside one test's
   * budget), so one test times out and the rest pass; which one depends on when the stall came
   * (docs/aws-deployment.md, "The PC must be on and awake"). A real failure fails twice and still
   * fails the run. GitHub's runners and local runs get no retry: a flake there should show.
   */
  retries: process.env.RUNNER_ENVIRONMENT === "self-hosted" ? 1 : 0,
  use: { baseURL: E2E_BASE_URL, trace: "retain-on-failure" },
  webServer: [
    {
      // Google, as far as the app can tell (GOOGLE_SIGNIN_ENDPOINT below).
      command: `node e2e/fake-google.mjs ${E2E_LOGIN_PORT} ${GOOGLE_CLIENT.id} ${GOOGLE_CLIENT.secret}`,
      port: E2E_LOGIN_PORT,
      reuseExistingServer: false,
      timeout: 30_000,
    },
    {
      // Evolution API, as far as the app can tell (its key is e2e/server.env's EVOLUTION_API_KEY).
      command: `node e2e/evolution-stub.mjs ${E2E_EVOLUTION_PORT} e2e-evolution-key`,
      port: E2E_EVOLUTION_PORT,
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
        GOOGLE_SIGNIN_CLIENT_ID: GOOGLE_CLIENT.id,
        GOOGLE_SIGNIN_CLIENT_SECRET: GOOGLE_CLIENT.secret,
        GOOGLE_SIGNIN_ENDPOINT: GOOGLE_ENDPOINT,
        EVOLUTION_API_URL: E2E_EVOLUTION_URL,
      },
      reuseExistingServer: false,
      // The build and the server's start: ~45 s on the PC runner awake and plugged in, 190 s on
      // 2026-10-20 while it ran on battery and dipped into standby, against the 240 s this was.
      // A server that never comes up fails the whole run (no test retry covers that).
      timeout: 420_000,
    },
  ],
});
