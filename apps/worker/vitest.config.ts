import { defineConfig } from "vitest/config";
import { testEnv } from "../../test-support/env.js";
import { wasmModule } from "../../test-support/wasmModule.js";

export default defineConfig({
  plugins: [wasmModule()],
  test: {
    env: testEnv,
    globalSetup: ["../../test-support/globalSetup.ts"],
    include: ["test/**/*.test.ts"],
    fileParallelism: false,
    testTimeout: 20_000,
    hookTimeout: 60_000,
  },
});
