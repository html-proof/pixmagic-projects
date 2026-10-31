import { resolve } from "node:path";
import { defineConfig } from "vitest/config";
import { testEnv } from "../../../test-support/env.js";

/**
 * Load and concurrency runs of the automation engines (docs/automations.md, "Capacity"), against a
 * *_test database like the integration tests: `pnpm --filter @app/worker load:automations`. Not
 * part of CI.
 */
export default defineConfig({
  test: {
    env: testEnv,
    globalSetup: [resolve(__dirname, "../../../test-support/globalSetup.ts")],
    root: resolve(__dirname, ".."),
    include: ["load/*.load.ts"],
    fileParallelism: false,
    reporters: ["verbose"],
    silent: false,
  },
});
