// Email integrations: the names, states and limits the API and the UI agree on (docs/email.md).
//
// Imported by the UI through `@app/shared/email`: relative imports stay extensionless.

/** Who carries the mail. Gmail and Google Workspace both connect with Google; Outlook.com and Microsoft 365 with Microsoft. */
export const EMAIL_PROVIDERS = ["gmail", "google_workspace", "outlook", "microsoft_365", "smtp"] as const;
export type EmailProvider = (typeof EMAIL_PROVIDERS)[number];

export const PROVIDER_LABEL: Record<EmailProvider, string> = {
  gmail: "Gmail",
  google_workspace: "Google Workspace",
  outlook: "Outlook.com",
  microsoft_365: "Microsoft 365",
  smtp: "Custom SMTP",
};

/** How an account was connected. OAuth accounts never hold a password; SMTP accounts never hold a token. */
export const CONNECTION_METHODS = ["oauth_google", "oauth_microsoft", "smtp"] as const;
export type ConnectionMethod = (typeof CONNECTION_METHODS)[number];

export const OAUTH_PROVIDERS = ["google", "microsoft"] as const;
export type OAuthProvider = (typeof OAUTH_PROVIDERS)[number];

/**
 * A connected account's state. Only `connected` and `degraded` accounts send; every other state
 * says why not, and none of them is ever shown as "connected".
 *  - pending: created, first check not finished
 *  - testing: a connection test is running
 *  - connected: last check or send worked
 *  - degraded: the provider failed temporarily (outage, rate limit); sending carries on and retries
 *  - reauthorization_required: the provider rejected the stored authorization (revoked, expired,
 *    password changed, consent withdrawn): someone must reconnect it
 *  - disabled: turned off in bizinsights; nothing is sent until it is turned back on
 *  - revoked: disconnected; credentials deleted
 *  - failed: the account can't send at all (wrong SMTP settings, mailbox not enabled)
 */
export const ACCOUNT_STATUSES = ["pending", "connected", "testing", "degraded", "reauthorization_required", "disabled", "revoked", "failed"] as const;
export type AccountStatus = (typeof ACCOUNT_STATUSES)[number];

export const ACCOUNT_STATUS_LABEL: Record<AccountStatus, string> = {
  pending: "Checking",
  connected: "Connected",
  testing: "Testing",
  degraded: "Temporarily failing",
  reauthorization_required: "Reconnect needed",
  disabled: "Disabled",
  revoked: "Disconnected",
  failed: "Not working",
};

export const accountCanSend = (status: string) => status === "connected" || status === "degraded";
export const accountNeedsAttention = (status: string) => status === "degraded" || status === "reauthorization_required" || status === "failed" || status === "pending";

/** A domain's ownership check. */
export const DOMAIN_STATUSES = ["unverified", "pending", "verified", "failed", "expired", "recheck_required"] as const;
export type DomainStatus = (typeof DOMAIN_STATUSES)[number];

export const DOMAIN_STATUS_LABEL: Record<DomainStatus, string> = {
  unverified: "Not checked yet",
  pending: "Waiting for the DNS record",
  verified: "Verified",
  failed: "Verification failed",
  expired: "Challenge expired",
  recheck_required: "Record missing: rechecking",
};

/** How long a domain's challenge stays valid before a new one must be generated. */
export const DOMAIN_CHALLENGE_DAYS = 7;
/** Consecutive failed rechecks of a verified domain before it stops counting as verified. */
export const DOMAIN_RECHECK_GRACE = 3;

/**
 * A message's state. Provider acceptance is not delivery: `accepted_by_provider` means Gmail,
 * Microsoft or the SMTP server took the message; `delivered` and `bounced` need evidence from the
 * recipient's side, which none of the three send-only connections provides (see
 * DELIVERY_REPORTING), except an SMTP server refusing the recipient outright (`bounced`).
 */
export const MESSAGE_STATUSES = ["queued", "processing", "accepted_by_provider", "delivered", "bounced", "deferred", "failed", "suppressed", "cancelled", "unknown"] as const;
export type MessageStatus = (typeof MESSAGE_STATUSES)[number];

export const MESSAGE_STATUS_LABEL: Record<MessageStatus, string> = {
  queued: "Queued",
  processing: "Sending",
  accepted_by_provider: "Accepted by provider",
  delivered: "Delivered",
  bounced: "Bounced",
  deferred: "Retrying",
  failed: "Failed",
  suppressed: "Suppressed",
  cancelled: "Cancelled",
  unknown: "Outcome unknown",
};

export const MESSAGE_STATUS_HELP: Record<MessageStatus, string> = {
  queued: "Waiting for its scheduled time or its turn to send.",
  processing: "Being handed to the email provider now.",
  accepted_by_provider: "The provider accepted the message for delivery. This is not proof it reached the inbox.",
  delivered: "The recipient's mail server confirmed delivery.",
  bounced: "The recipient's mail server refused the message.",
  deferred: "The provider failed temporarily or a sending limit was reached; it will be retried automatically.",
  failed: "The message could not be sent. The reason is shown with it.",
  suppressed: "Not sent: the recipient unsubscribed or is on the suppression list.",
  cancelled: "Not sent: the automation, account or message was stopped before it went out.",
  unknown: "Sending was interrupted after the provider may have received it. It was not retried automatically, to avoid a duplicate.",
};

/** What an automation's evaluation of one event ended in (the message carries the rest). */
export const EXECUTION_STATUSES = ["pending", "skipped", "scheduled", "suppressed", "failed", "cancelled"] as const;

/** Transactional mail answers something the recipient did; marketing mail needs their consent and an unsubscribe link. */
export const EMAIL_CATEGORIES = ["transactional", "marketing"] as const;

export const TEMPLATE_STATUSES = ["draft", "active", "archived"] as const;

/** A From address's authorization. Only `verified` identities can send. */
export const SENDER_STATUSES = ["pending", "verified", "revoked"] as const;

/**
 * How a From address was proven:
 *  - provider_oauth: it is the address Google or Microsoft signed in as
 *  - smtp_confirmation: a code sent through the SMTP account to that address was entered back
 *  - domain_ownership: the SMTP account authenticated and the address's domain is verified here
 */
export const SENDER_VERIFICATION_METHODS = ["provider_oauth", "smtp_confirmation", "domain_ownership"] as const;

/** SMTP transport security. There is no plaintext mode: implicit TLS (465) or STARTTLS (587, 2525). */
export const SMTP_ENCRYPTION_MODES = ["tls", "starttls"] as const;
export type SmtpEncryption = (typeof SMTP_ENCRYPTION_MODES)[number];

/** Ports an SMTP account may use, and the encryption each one speaks. Port 25 is blocked for outbound mail on AWS. */
export const SMTP_PORTS: Record<number, SmtpEncryption> = { 465: "tls", 587: "starttls", 2525: "starttls" };

export const SUPPRESSION_REASONS = ["unsubscribed", "bounced", "complained", "manual", "invalid"] as const;
export type SuppressionReason = (typeof SUPPRESSION_REASONS)[number];

/** `marketing`: no marketing mail (an unsubscribe). `all`: nothing at all (a bounce, a complaint, a manual block). */
export const SUPPRESSION_SCOPES = ["marketing", "all"] as const;
export type SuppressionScope = (typeof SUPPRESSION_SCOPES)[number];

export const SUPPRESSION_REASON_LABEL: Record<SuppressionReason, string> = {
  unsubscribed: "Unsubscribed",
  bounced: "Bounced",
  complained: "Marked as spam",
  manual: "Added by your team",
  invalid: "Invalid address",
};

/**
 * Sending limits per account, under each provider's own published limits so a busy shop is slowed
 * down by bizinsights rather than suspended by the provider. An account can be set lower; the
 * workspace has its own daily limit on top (EMAIL_DEFAULT_DAILY_LIMIT).
 */
export const PROVIDER_LIMITS: Record<EmailProvider, { perMinute: number; perDay: number; note: string }> = {
  gmail: { perMinute: 20, perDay: 400, note: "Gmail allows about 500 recipients a day from a personal account." },
  google_workspace: { perMinute: 30, perDay: 1800, note: "Google Workspace allows about 2,000 messages a day per user." },
  outlook: { perMinute: 15, perDay: 250, note: "Outlook.com allows about 300 recipients a day." },
  microsoft_365: { perMinute: 30, perDay: 9000, note: "Exchange Online allows 30 messages a minute and 10,000 recipients a day per mailbox." },
  smtp: { perMinute: 30, perDay: 1000, note: "Set your provider's own limit on the account if it is lower." },
};

/**
 * What each connection can tell us after a message is accepted. Send-only permissions can't read
 * the mailbox, so bounce notices that arrive there afterwards are invisible to bizinsights.
 */
export const DELIVERY_REPORTING: Record<EmailProvider, string> = {
  gmail: "Gmail confirms it accepted the message. Delivery and bounce reports go to the mailbox, which bizinsights can't read with send-only access.",
  google_workspace: "Google confirms it accepted the message. Delivery and bounce reports go to the mailbox, which bizinsights can't read with send-only access.",
  outlook: "Microsoft confirms it accepted the message (HTTP 202). Delivery and bounce reports go to the mailbox, which bizinsights can't read with send-only access.",
  microsoft_365: "Microsoft confirms it accepted the message (HTTP 202). Delivery and bounce reports go to the mailbox, which bizinsights can't read with send-only access.",
  smtp: "The SMTP server confirms it accepted the message, or refuses the recipient outright (shown as Bounced). Later bounces go to the mailbox.",
};

/** Failure codes on messages, executions and accounts, in words. */
export const ERROR_LABEL: Record<string, string> = {
  account_disconnected: "The sending account was disconnected.",
  account_disabled: "The sending account is disabled.",
  account_reauthorization_required: "The sending account must be reconnected.",
  account_failed: "The sending account isn't working.",
  auth_failed: "The provider rejected the sign-in or password.",
  permission_missing: "The account didn't grant permission to send email.",
  consent_required: "An administrator of the Microsoft organization must approve bizinsights first.",
  conditional_access: "The organization's sign-in policy blocked access. Reconnect to satisfy it.",
  account_disabled_by_provider: "The provider has disabled this account.",
  sender_rejected: "The provider refused to send from this address.",
  recipient_rejected: "The recipient's address was refused.",
  rate_limited: "A sending limit was reached; the message waits for the next window.",
  quota_exceeded: "The daily sending limit was reached.",
  provider_unavailable: "The provider was temporarily unavailable.",
  retries_exhausted: "Every retry failed.",
  send_interrupted: "Sending was interrupted after the provider may have received the message.",
  template_unavailable: "The template is no longer active.",
  sender_unavailable: "The sender address isn't verified or its account can't send.",
  missing_recipient: "The event had no recipient email address.",
  invalid_recipient: "The recipient's email address isn't valid.",
  rule_disabled: "The automation was turned off.",
  conditions_not_met: "The automation's conditions weren't met.",
  no_marketing_consent: "The customer hasn't agreed to marketing email.",
  frequency_limit: "The automation's frequency limit for this recipient was reached.",
  suppressed: "The recipient is on the suppression list.",
  invalid_message: "The provider rejected the message as invalid.",
  tls_failed: "A secure (TLS) connection couldn't be established.",
  connect_failed: "The SMTP server couldn't be reached.",
  timeout: "The SMTP server didn't answer in time.",
  blocked_destination: "That SMTP server address isn't allowed.",
  invalid_host: "That SMTP host name doesn't exist.",
  starttls_unavailable: "The SMTP server doesn't offer STARTTLS on this port.",
  auth_unavailable: "The SMTP server doesn't allow password sign-in on this connection.",
  workspace_paused: "Sending is paused for this workspace.",
  workspace_suspended: "Sending is suspended for this workspace.",
  cancelled_by_user: "Cancelled by your team.",
  render_failed: "The template couldn't be filled in for this event.",
};

export const errorLabel = (code: string | null | undefined) => (code ? (ERROR_LABEL[code] ?? code.replace(/_/g, " ")) : null);
