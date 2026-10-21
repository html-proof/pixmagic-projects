import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

/**
 * Runs the Email integrations demo seed (email-demo.seed.ts) against the LOCAL demo database only:
 *   EMAIL_DEMO_EMAIL=owner@emaildemo.test npx vitest run --config demo/email.vitest.config.ts   (from apps/worker)
 * It uses the demo server's own test keys (apps/web/e2e/server.env), so the server can read what it writes.
 */
const workerEnv = Object.fromEntries(
  readFileSync(resolve(__dirname, "../../web/e2e/server.env"), "utf8")
    .split(/\r?\n/)
    .filter((l) => /^[A-Z_]+=/.test(l))
    .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
);
const db = process.env.EMAIL_DEMO_PG ?? "localhost:5443/email_demo";
if (!/email_demo$/.test(db)) throw new Error("The email demo seed only writes to a database named email_demo");

export default defineConfig({
  test: {
    env: {
      ...workerEnv,
      NODE_ENV: "development",
      APP_URL: "http://localhost:8797",
      API_URL: "http://localhost:8797/api",
      DATABASE_URL: `postgresql://app:app@${db}`,
      APP_DATABASE_URL: `postgresql://app_rls:app_rls@${db}`,
      EMAIL_GOOGLE_CLIENT_ID: "demo-google",
      EMAIL_GOOGLE_CLIENT_SECRET: "demo-google-secret",
      LOG_LEVEL: "warn",
    },
    include: ["demo/email-demo.seed.ts"],
    testTimeout: 300_000,
  },
});
