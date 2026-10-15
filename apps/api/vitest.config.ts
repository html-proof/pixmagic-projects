import { defineConfig } from "vitest/config";
import { testEnv } from "../../test-support/env.js";

export default defineConfig({
  test: {
    env: testEnv,
    globalSetup: ["../../test-support/globalSetup.ts"],
    include: ["test/**/*.test.ts"],
    fileParallelism: false,
    testTimeout: 20_000,
    hookTimeout: 60_000,
  },
});
