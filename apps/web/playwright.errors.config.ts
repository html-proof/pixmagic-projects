import { defineConfig } from "@playwright/test";
/** Public error states run independently of the database and auth emulator. */
export default defineConfig({
  testDir: "./e2e",
  testMatch: "error-states.spec.ts",
  use: { baseURL: "http://localhost:3017" },
  webServer: {
    command: "node node_modules/next/dist/bin/next dev -p 3017",
    url: "http://localhost:3017/login",
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
