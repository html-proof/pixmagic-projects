import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseEnv } from "node:util";
import { defineConfig } from "vitest/config";
import { wasmModule } from "../../../test-support/wasmModule.js";

/**
 * One-off maintenance tasks for sign-in (docs/cognito-setup.md), run from the repo root:
 *   pnpm --filter @app/api ops:cognito-plan      dry run: who moves how, plus a snapshot of who belongs where
 *   pnpm --filter @app/api ops:cognito-verify    after the cutover: nothing moved (OPS_SNAPSHOT=<the snapshot>)
 *
 * They run under Vitest because the Prisma client only loads in Node through the wasmModule()
 * plugin. Configuration comes from OPS_ENV_FILE (default: the repo-root .env): the owner-role
 * DATABASE_URL, and optionally FIREBASE_SERVICE_ACCOUNT_B64 (to list Firebase accounts) and the
 * COGNITO_* settings with admin credentials (to look up Cognito users). Both only read.
 */
const envFile = resolve(process.env.OPS_ENV_FILE ?? resolve(__dirname, "../../../.env"));
if (!existsSync(envFile)) throw new Error(`No env file at ${envFile}: set OPS_ENV_FILE`);
const fileEnv = parseEnv(readFileSync(envFile, "utf8"));
if (!fileEnv.DATABASE_URL) throw new Error(`${envFile} has no DATABASE_URL`);

export default defineConfig({
  plugins: [wasmModule()],
  test: {
    env: { SESSION_SECRET: "ops-task-unused-0123456789", TOKEN_ENCRYPTION_KEYS: "1:MDEyMzQ1Njc4OTAxMjM0NTY3ODkwMTIzNDU2Nzg5MDE=", OTP_PEPPER: "ops-unused", ...fileEnv, LOG_LEVEL: fileEnv.LOG_LEVEL ?? "warn" },
    include: ["ops/*.ops.ts"],
    fileParallelism: false,
    testTimeout: 30 * 60_000,
    reporters: ["verbose"],
    silent: false,
  },
});
