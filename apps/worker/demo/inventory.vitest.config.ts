import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

/**
 * Runs the Inventory demo seed (inventory-demo.seed.ts) against the LOCAL demo database only:
 *   INVENTORY_DEMO_EMAIL=you@example.com INVENTORY_DEMO_PG=localhost:5452/inventory_demo npx vitest run --config demo/inventory.vitest.config.ts   (from apps/worker)
 * It uses the demo server's own test keys (apps/web/e2e/server.env), so the server can read what it writes.
 */
const workerEnv = Object.fromEntries(
  readFileSync(resolve(__dirname, "../../web/e2e/server.env"), "utf8")
    .split(/\r?\n/)
    .filter((l) => /^[A-Z_]+=/.test(l))
    .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
);
const db = process.env.INVENTORY_DEMO_PG ?? "localhost:5434/inventory_demo";
if (!/inventory_demo$/.test(db)) throw new Error("The Inventory demo seed only writes to a database named inventory_demo");

export default defineConfig({
  test: {
    env: {
      ...workerEnv,
      NODE_ENV: "development",
      DATABASE_URL: `postgresql://app:app@${db}`,
      APP_DATABASE_URL: `postgresql://app_rls:app_rls@${db}`,
      LOG_LEVEL: "warn",
    },
    include: ["demo/inventory-demo.seed.ts"],
    testTimeout: 300_000,
  },
});
