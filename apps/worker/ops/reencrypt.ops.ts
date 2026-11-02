import { afterAll, it } from "vitest";
import { reencryptAllTokens } from "@app/core";
import { disconnectDb } from "@app/db";

/**
 * Re-encrypt everything stored under TOKEN_ENCRYPTION_KEYS (Shopify and ad-platform tokens,
 * WhatsApp Automation's customer data, the stock alerts' WhatsApp numbers, Customer Messaging's
 * numbers, recovery links and texts, the team invitations' kept links) with its active (first) key,
 * and re-wrap the email credentials' data keys under EMAIL_CREDENTIAL_KEYS (TOKEN_ENCRYPTION_KEYS when
 * that is empty). Step 2 of "Rotate the token encryption key" in docs/RUNBOOK.md: prints 0 once
 * nothing needs an older key.
 *   pnpm --filter @app/worker ops:reencrypt
 */
afterAll(async () => disconnectDb());

it("re-encrypts stored data with the active key", async () => {
  console.log(`re-encrypted ${await reencryptAllTokens()} rows`);
});
