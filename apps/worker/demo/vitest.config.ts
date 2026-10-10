import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { defineConfig } from "vitest/config";
import { wasmModule } from "../../../test-support/wasmModule.js";

/**
 * Runs the WhatsApp demo seed (wa-demo.seed.ts) against the LOCAL demo database only:
 *   WA_DEMO_EMAIL=you@example.com npx vitest run --config demo/vitest.config.ts   (from apps/worker)
 * It uses the demo Worker's own test keys (apps/web/e2e/worker.env), so the Worker can read what it writes.
 */
const workerEnv = Object.fromEntries(
  readFileSync(resolve(__dirname, "../../web/e2e/worker.env"), "utf8")
    .split(/\r?\n/)
    .filter((l) => /^[A-Z_]+=/.test(l))
    .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
);
const db = process.env.WA_DEMO_PG ?? "localhost:5447/wa_demo";
if (!/wa_demo$/.test(db)) throw new Error("The WhatsApp demo seed only writes to a database named wa_demo");

export default defineConfig({
  plugins: [wasmModule()],
  test: {
    env: {
      ...workerEnv,
      NODE_ENV: "development",
      APP_URL: "http://localhost:8793",
      API_URL: "http://localhost:8793/api",
      DATABASE_URL: `postgresql://app:app@${db}`,
      APP_DATABASE_URL: `postgresql://app_rls:app_rls@${db}`,
      LOG_LEVEL: "warn",
    },
    include: ["demo/*.seed.ts"],
    testTimeout: 300_000,
  },
});
