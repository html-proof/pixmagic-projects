import { reencryptAdTokens } from "./adConnections.js";
import { reencryptEmailCredentials } from "./email/tokens.js";
import { reencryptStoreTokens } from "./tokens.js";
import { reencryptWhatsappData } from "./whatsapp/store.js";

/**
 * Re-encrypt everything stored under the keyrings with their active key (run after adding a new
 * key, and before removing the old one; docs/RUNBOOK.md): store tokens, ad tokens and WhatsApp data
 * under TOKEN_ENCRYPTION_KEYS, and the email credentials' data keys, which are re-wrapped under
 * EMAIL_CREDENTIAL_KEYS (TOKEN_ENCRYPTION_KEYS when that is empty). Returns the number of rows
 * rewritten; 0 means nothing still needs an old key.
 *
 * Its own module because it needs every module that encrypts, and those all import tokens.ts.
 */
export async function reencryptAllTokens(): Promise<number> {
  return (await reencryptStoreTokens()) + (await reencryptAdTokens()) + (await reencryptWhatsappData()) + (await reencryptEmailCredentials());
}
