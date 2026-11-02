import { reencryptAdLoginTokens, reencryptAdTokens } from "./adConnections.js";
import { reencryptEmailCredentials } from "./email/tokens.js";
import { logger } from "./logger.js";
import { reencryptSmsData } from "./sms/keys.js";
import { reencryptInvitationLinks } from "./team/invitations.js";
import { reencryptStoreTokens } from "./tokens.js";
import { reencryptWhatsappData } from "./whatsapp/privacy.js";
import { reencryptInventorySettings } from "./inventory/settings.js";

/**
 * Re-encrypt everything stored under the keyrings with their active key (run after adding a new
 * key, and before removing the old one; docs/RUNBOOK.md): store tokens, ad tokens (waiting logins too),
 * WhatsApp Automation's data, Customer Messaging's numbers, links and texts, and the team invitations'
 * kept links under TOKEN_ENCRYPTION_KEYS (and the inventory alerts' WhatsApp numbers; the
 * earlier WhatsApp feature's tables, read by nothing, are left as they are), and the email
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
    ["waiting ad logins", reencryptAdLoginTokens],
    ["WhatsApp data", reencryptWhatsappData],
    ["email credentials", reencryptEmailCredentials],
    ["inventory settings", reencryptInventorySettings],
    ["Customer Messaging data", reencryptSmsData],
    ["invitation links", reencryptInvitationLinks],
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
