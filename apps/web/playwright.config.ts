import { resolve } from "node:path";
import { defineConfig } from "@playwright/test";

/**
 * E2E runs the real app on the local server (apps/aws/src/local.ts: static UI + API + jobs)
 * against its own Cognito emulator (started here, empty every run), a stand-in for the user pool's
 * managed login (e2e/fake-managed-login.mjs: "Continue with Google"), a stand-in for Meta's Graph API
 * (e2e/meta-graph-stub.mjs: WhatsApp Automation's Cloud API; the local server sends Meta's calls there),
 * a stand-in for Evolution API (e2e/evolution-stub.mjs: only what is left of QR linking, until release 2
 * removes it), Mailpit and a dedicated app_e2e database (docker compose up -d postgres mailpit first).
 *
 * Ports default to the docker compose stack. Override them to run e2e beside a local demo, which
 * uses the same server port and Mailpit: global setup wipes every Mailpit message.
 *   E2E_PORT (8789), E2E_COGNITO_PORT (9249), E2E_LOGIN_PORT (9259), E2E_EVOLUTION_PORT (9269),
 *   E2E_GRAPH_PORT (9279), E2E_MAILPIT_URL (http://localhost:8025)
 */
export const E2E_PORT = Number(process.env.E2E_PORT ?? 8789);
export const E2E_BASE_URL = `http://localhost:${E2E_PORT}`;
export const E2E_COGNITO_PORT = Number(process.env.E2E_COGNITO_PORT ?? 9249);
export const E2E_LOGIN_PORT = Number(process.env.E2E_LOGIN_PORT ?? 9259);
/** The Evolution API stand-in; e2e/whatsapp.spec.ts plays the phone and WhatsApp through its /__control. */
export const E2E_EVOLUTION_PORT = Number(process.env.E2E_EVOLUTION_PORT ?? 9269);
export const E2E_EVOLUTION_URL = `http://127.0.0.1:${E2E_EVOLUTION_PORT}`;
/** Meta's Graph API stand-in; e2e/whatsapp.spec.ts plays Meta's window and WhatsApp through its /__control. */
export const E2E_GRAPH_PORT = Number(process.env.E2E_GRAPH_PORT ?? 9279);
export const E2E_GRAPH_URL = `http://127.0.0.1:${E2E_GRAPH_PORT}`;
/** The emulator's working directory (its database: codes it "emails" are read from there). */
export const E2E_COGNITO_DATA = resolve(import.meta.dirname, ".e2e/cognito");
export const E2E_MAILPIT_URL = process.env.E2E_MAILPIT_URL ?? "http://localhost:8025";
const COGNITO_ENDPOINT = `http://127.0.0.1:${E2E_COGNITO_PORT}`;
const CLIENT = { id: "insightslocalwebclient00", secret: "insights-local-client-secret" };

// TEST_PG_PORT points e2e at another Postgres server (e.g. a throwaway container); default 5434.
const PG_PORT = process.env.TEST_PG_PORT ?? "5434";
// The superuser's password: "app" (docker compose), or the one a CI job on the PC gave its server.
const PG_PASSWORD = encodeURIComponent(process.env.TEST_PG_PASSWORD ?? "app");

export const E2E_ENV = {
  DATABASE_URL: `postgresql://app:${PG_PASSWORD}@127.0.0.1:${PG_PORT}/app_e2e`,
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
      // Evolution API, as far as the app can tell (its key is e2e/server.env's EVOLUTION_API_KEY).
      command: `node e2e/evolution-stub.mjs ${E2E_EVOLUTION_PORT} e2e-evolution-key`,
      port: E2E_EVOLUTION_PORT,
      reuseExistingServer: false,
      timeout: 30_000,
    },
    {
      // Meta's Graph API, as far as the app can tell (its app id and secret are e2e/server.env's WHATSAPP_APP_ID and WHATSAPP_APP_SECRET).
      command: `node e2e/meta-graph-stub.mjs ${E2E_GRAPH_PORT} e2e_meta_app e2e_meta_secret`,
      port: E2E_GRAPH_PORT,
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
        EVOLUTION_API_URL: E2E_EVOLUTION_URL,
        LOCAL_GRAPH_URL: E2E_GRAPH_URL,
      },
      reuseExistingServer: false,
      // The build and the server's start: ~45 s on the PC runner awake and plugged in, 190 s on
      // 2026-10-20 while it ran on battery and dipped into standby, against the 240 s this was.
      // A server that never comes up fails the whole run (no test retry covers that).
      timeout: 420_000,
    },
  ],
});
