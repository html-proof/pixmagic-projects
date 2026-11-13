/**
 * The app's own transactional email (Team & Access invitations, alerts, staff notices), whatever
 * provider sends it: Resend (resend.ts), Mailpit locally.
 * A provider is picked by configuration (EMAIL_PROVIDER), never in the code that sends, so swapping
 * it needs no change to invitations. Merchants' own connected accounts are core/email, not this.
 */

/** What became of one email (defined with the team page's types, which show it). */
export { DELIVERY_STATUSES, type DeliveryStatus } from "@app/shared/team";

/** What a provider answered for a message it accepted. */
export interface MailReceipt {
  provider: string;
  /** The provider's id for the message (what its delivery events refer to); null if it gave none. */
  messageId: string | null;
}

/**
 * Why a send failed, in the three ways the caller acts on:
 * - `transient`: try again later (rate limit, quota for the day, outage, no connection);
 * - `not_allowed`: the provider won't send to this recipient from this account as configured (SES's
 *   sandbox, an unverified sending domain, a test-mode key): no retry helps until that is fixed;
 * - `permanent`: this message will never go (a bad address, a suppressed recipient, a bad request).
 */
export type MailFailure = "transient" | "not_allowed" | "permanent";

export class MailError extends Error {
  constructor(
    message: string,
    public provider: string,
    public failure: MailFailure,
    /** The provider's own error name or code (e.g. "rate_limit_exceeded", "MessageRejected"). */
    public code: string | null = null,
    /** Seconds the provider asked us to wait (Retry-After), for a transient failure. */
    public retryAfterSec?: number,
  ) {
    super(message);
    this.name = "MailError";
  }
}

/** A provider's message without any email address in it: delivery records and logs keep no addresses. */
export function withoutAddresses(text: string): string {
  return text.replace(/[^\s<>"'(),;:]+@[^\s<>"'(),;:]+/g, "[address]").slice(0, 500);
}

/** How a failure that isn't a MailError (a provider that throws plain errors, a network failure) is treated. */
export function classifyMailError(err: unknown, provider = "unknown"): MailError {
  if (err instanceof MailError) return err;
  const message = err instanceof Error ? err.message : String(err);
  // SES while in its sandbox: "Email address is not verified. The following identities failed the check".
  if (/not verified|not authorized|sandbox|MessageRejected|AccessDenied/i.test(message)) return new MailError(withoutAddresses(message), provider, "not_allowed", "not_allowed");
  if (/\((4\d\d)\)/.test(message) && !/\((408|429)\)/.test(message)) return new MailError(withoutAddresses(message), provider, "permanent", "rejected");
  return new MailError(withoutAddresses(message), provider, "transient", "unavailable");
}
