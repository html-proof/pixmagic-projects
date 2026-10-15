import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseEnv } from "node:util";
import { defineConfig } from "vitest/config";

/**
 * One-off maintenance tasks (docs/RUNBOOK.md), run from the repo root:
 *   pnpm --filter @app/worker ops:recompute     (needs OPS_SHOP=<shop>.myshopify.com)
 *   pnpm --filter @app/worker ops:reencrypt
 *
 * They run under Vitest, which loads the workspace's TypeScript as the tests do. Configuration
 * comes from OPS_ENV_FILE (default: the repo-root .env). It must hold the owner-role DATABASE_URL
 * and the same TOKEN_ENCRYPTION_KEYS as the deployed app, or decrypting stored tokens fails.
 */
const envFile = resolve(process.env.OPS_ENV_FILE ?? resolve(__dirname, "../../../.env"));
if (!existsSync(envFile)) throw new Error(`No env file at ${envFile}: set OPS_ENV_FILE`);
const fileEnv = parseEnv(readFileSync(envFile, "utf8"));
if (!fileEnv.DATABASE_URL) throw new Error(`${envFile} has no DATABASE_URL`);

export default defineConfig({
  test: {
    env: { ...fileEnv, LOG_LEVEL: fileEnv.LOG_LEVEL ?? "warn" },
    include: ["ops/*.ops.ts"],
    fileParallelism: false,
    testTimeout: 30 * 60_000,
    // The default reporter drops a passing test's output, which is the whole point here.
    reporters: ["verbose"],
    silent: false,
  },
});
