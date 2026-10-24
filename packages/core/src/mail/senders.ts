import { env, type Env } from "../env.js";

/**
 * Who each of the app's emails comes from. A message says what it is for (MailOptions.purpose) and
 * the provider takes the From address from here, from the server's own configuration: nothing a
 * request carries can name a sender, so the only addresses mail ever leaves from are the three
 * below. Every one of them must be on a domain verified with the provider (bizinsights.io in
 * Resend; docs/aws-deployment.md, "App email"), or the provider refuses the send as not_allowed.
 *
 * - `support` (OTP_FROM_EMAIL / OTP_FROM_NAME): the verification codes, the temporary password.
 * - `link` (LINK_FROM_EMAIL / LINK_FROM_NAME): links that open something shared, the dashboard
 *   invitations and the employee portal's.
 * - `default` (EMAIL_FROM): everything else (alerts, notices, the daily cost report).
 *
 * An identity left unset sends from EMAIL_FROM, as all mail did before these settings existed.
 */
export const EMAIL_PURPOSES = {
  signup_code: "support",
  login_code: "support",
  verification_code: "support",
  password_reset_code: "support",
  temporary_password: "support",
  account_deletion_code: "support",
  team_invitation: "link",
  staff_invitation: "link",
  notice: "default",
} as const;
export type EmailPurpose = keyof typeof EMAIL_PURPOSES;
export type SenderIdentity = (typeof EMAIL_PURPOSES)[EmailPurpose];

/** The settings the senders come from: env() itself, or just these in a test. */
export type SenderSettings = Pick<Env, "EMAIL_FROM" | "OTP_FROM_EMAIL" | "OTP_FROM_NAME" | "LINK_FROM_EMAIL" | "LINK_FROM_NAME" | "SUPPORT_EMAIL">;

/** "Name <addr@x>" -> { name, email }; a bare address has no name. */
function split(from: string): { name: string | null; email: string } {
  const m = /^\s*(.*?)\s*<([^>]+)>\s*$/.exec(from);
  if (!m) return { name: null, email: from.trim() };
  return { name: m[1] ? m[1].replace(/^"|"$/g, "") : null, email: m[2]!.trim() };
}

/** The sender a purpose maps to. Not a purpose of ours (a caller's typo, a value from outside): the default sender. */
export function senderFor(purpose: EmailPurpose | undefined, e: SenderSettings = env()): { name: string | null; email: string } {
  const identity: SenderIdentity = purpose && Object.hasOwn(EMAIL_PURPOSES, purpose) ? EMAIL_PURPOSES[purpose] : "default";
  const fallback = split(e.EMAIL_FROM);
  if (identity === "support" && e.OTP_FROM_EMAIL) return { name: e.OTP_FROM_NAME || fallback.name, email: e.OTP_FROM_EMAIL };
  if (identity === "link" && e.LINK_FROM_EMAIL) return { name: e.LINK_FROM_NAME || fallback.name, email: e.LINK_FROM_EMAIL };
  return fallback;
}

/** The From header for a purpose: "BizInsights Support <support@bizinsights.io>". */
export function fromHeader(purpose: EmailPurpose | undefined, e: SenderSettings = env()): string {
  const s = senderFor(purpose, e);
  return s.name ? `${s.name} <${s.email}>` : s.email;
}

/** How an email signs off: the sender's name and address, and where to ask for help (null: no such line). */
export interface Signature {
  name: string;
  email: string | null;
  support: string | null;
}

/**
 * The sign-off for a purpose's emails, from the same settings as its From address. An identity
 * left unset signs as "bizinsights Team", as every email did before: EMAIL_FROM is a no-reply
 * address, not one to show people.
 */
export function signatureFor(purpose: EmailPurpose, e: SenderSettings = env()): Signature {
  const support = e.SUPPORT_EMAIL || null;
  const identity = EMAIL_PURPOSES[purpose];
  const own = identity === "support" ? e.OTP_FROM_EMAIL : identity === "link" ? e.LINK_FROM_EMAIL : "";
  if (!own) return { name: "bizinsights Team", email: null, support };
  const s = senderFor(purpose, e);
  return { name: s.name ?? "bizinsights", email: s.email, support };
}
