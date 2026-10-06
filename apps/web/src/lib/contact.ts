/**
 * The three facts a Shopify app review needs that cannot be derived from the code: who the
 * data controller is, how a merchant reaches support, and which law governs the policy.
 *
 * Shopify app store requirement 4.1 requires a reachable support contact, and the listing
 * requires a privacy policy URL. `/privacy` and `/support` render straight from this file, and
 * both show a visible "not set" marker while a value is still a placeholder, so an unfinished
 * policy cannot be published by accident.
 *
 * Set all four, then redeploy.
 */
export const CONTACT = {
  /** Legal entity that controls merchant data, as registered. Appears as the controller. */
  legalName: "",
  /** Support address merchants write to. Must be monitored - review tests it. */
  supportEmail: "",
  /** Country or state whose law governs, e.g. "Victoria, Australia". */
  jurisdiction: "",
  /** Postal address of the controller. Required by GDPR art. 13 where it applies. */
  postalAddress: "",
} as const;

/** True once every field above is filled in. */
export const contactReady = Object.values(CONTACT).every((v) => v.trim().length > 0);

/** Renders a value, or a visible marker while it is still unset. */
export const orUnset = (value: string) => (value.trim() ? value : "[not set - see apps/web/src/lib/contact.ts]");
