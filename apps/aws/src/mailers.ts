import { logger, resendMailer, withTimeout, type FetchLike, type Mailer } from "@app/core/mailer";

/** Without a mail provider configured (local runs): say what would have been sent, never the address. */
export const logMailer: Mailer = {
  async send(to, subject) {
    logger.info({ subject, to: to.replace(/^(.).*@/, "$1…@") }, "email not sent (no mailer in this environment)");
    return { provider: "log", messageId: null };
  },
};

/**
 * The app's email provider (core/mail): Resend, once its key is in the server's env file
 * (bizinsights.io is verified there, so it sends to anyone). Without the key nothing is sent: each
 * email is a line in the log. Read once at start.
 */
export function chooseMailer(e: NodeJS.ProcessEnv, fetchImpl: FetchLike = fetch): Mailer {
  const provider = e.EMAIL_PROVIDER || (e.RESEND_API_KEY ? "resend" : "");
  if (provider === "resend" && e.RESEND_API_KEY) return resendMailer({ apiKey: e.RESEND_API_KEY, fetchImpl: withTimeout(fetchImpl, 10_000) });
  if (provider === "resend") logger.error("EMAIL_PROVIDER is resend but RESEND_API_KEY is not set: no email will be sent");
  return logMailer;
}
