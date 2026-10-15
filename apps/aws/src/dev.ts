import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { logger } from "@app/core";
import { loadSettings, startLocal } from "./local.js";

/**
 * `pnpm --filter @app/aws dev [--port 8787] [--assets <UI build>] [--settings <file>]`: the local
 * server (local.ts). Paths are relative to apps/aws. Defaults: port 8787, the UI in apps/web/out,
 * settings from apps/aws/.env when it exists (copy .env.example).
 */
const pkg = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { values } = parseArgs({
  options: {
    port: { type: "string", default: "8787" },
    assets: { type: "string", default: "../web/out" },
    settings: { type: "string" },
  },
});
const envFile = values.settings ? resolve(pkg, values.settings) : resolve(pkg, ".env");
if (values.settings && !existsSync(envFile)) throw new Error(`No settings file at ${envFile}`);
loadSettings(existsSync(envFile) ? envFile : null);

const local = await startLocal({ port: Number(values.port), assets: resolve(pkg, values.assets) });
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    logger.info({ signal }, "local server stopping");
    void local.close().finally(() => process.exit(0));
  });
}
