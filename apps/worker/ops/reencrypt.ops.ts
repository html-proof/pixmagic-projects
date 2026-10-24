import { afterAll, it } from "vitest";
import { reencryptAllTokens } from "@app/core";
import { disconnectDb } from "@app/db";

/**
 * Re-encrypt everything stored under TOKEN_ENCRYPTION_KEYS (Shopify and ad-platform tokens,
 * WhatsApp Automation's customer data) with its active (first) key. Step 2 of "Rotate the token
 * encryption key" in docs/RUNBOOK.md: prints 0 once nothing needs an older key.
 *   pnpm --filter @app/worker ops:reencrypt
 */
afterAll(async () => disconnectDb());

it("re-encrypts stored data with the active key", async () => {
  console.log(`re-encrypted ${await reencryptAllTokens()} rows`);
});
