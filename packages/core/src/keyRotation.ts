import { reencryptAdTokens } from "./adConnections.js";
import { reencryptEmailCredentials } from "./email/tokens.js";
import { logger } from "./logger.js";
import { reencryptStoreTokens } from "./tokens.js";
import { reencryptWhatsappData } from "./whatsapp/store.js";
import { reencryptInventorySettings } from "./inventory/settings.js";

/**
 * Re-encrypt everything stored under the keyrings with their active key (run after adding a new
 * key, and before removing the old one; docs/RUNBOOK.md): store tokens, ad tokens and WhatsApp data
 * under TOKEN_ENCRYPTION_KEYS (and the inventory alerts' WhatsApp numbers), and the email
 * credentials' data keys, which are re-wrapped under
 * EMAIL_CREDENTIAL_KEYS (TOKEN_ENCRYPTION_KEYS when that is empty). Returns the number of rows
 * rewritten; 0 means nothing still needs an old key.
 *
 * Every part runs even when one before it fails, so one unreadable row can't keep the rest on the old
 * key; the run then fails at the end, naming the parts, and never ends in a 0 that says "done".
 *
 * Its own module because it needs every module that encrypts, and those all import tokens.ts.
 */
export async function reencryptAllTokens(): Promise<number> {
  const parts: Array<[string, () => Promise<number>]> = [
    ["store tokens", reencryptStoreTokens],
    ["ad tokens", reencryptAdTokens],
    ["WhatsApp data", reencryptWhatsappData],
    ["email credentials", reencryptEmailCredentials],
    ["inventory settings", reencryptInventorySettings],
  ];
  let rewritten = 0;
  const failed: Array<{ part: string; err: unknown }> = [];
  for (const [part, run] of parts) {
    try {
      rewritten += await run();
    } catch (err) {
      logger.error({ err, part }, "re-encryption failed for a part; the others go on");
      failed.push({ part, err });
    }
  }
  if (failed.length) {
    throw new AggregateError(
      failed.map((f) => f.err),
      `re-encrypted ${rewritten} rows, but ${failed.map((f) => f.part).join(", ")} failed: ${failed.map((f) => (f.err instanceof Error ? f.err.message : String(f.err))).join("; ")}`,
    );
  }
  return rewritten;
}
