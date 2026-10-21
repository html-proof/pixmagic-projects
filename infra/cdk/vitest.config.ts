import { defineConfig } from "vitest/config";

// Synthesizing the stacks takes seconds on a GitHub runner but 15-25 s on a busy PC (hand deploys,
// the self-hosted runner): past vitest's defaults of 10 s for hooks and 5 s for tests.
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    testTimeout: 60_000,
    hookTimeout: 180_000,
  },
});
