import { logger, resendMailer, withTimeout, type FetchLike, type Mailer } from "@app/core";
import type { AwsCredentials } from "./awsClient.js";
import { sesMailer } from "./sesMailer.js";

/** Without a mail provider configured (local runs): say what would have been sent, never the address. */
export const logMailer: Mailer = {
  async send(to, subject) {
    logger.info({ subject, to: to.replace(/^(.).*@/, "$1…@") }, "email not sent (no mailer in this environment)");
    return { provider: "log", messageId: null };
  },
};

/**
 * The app's email provider (core/mail): EMAIL_PROVIDER when set, else Resend when its key is in the
 * app secret, else SES. SES sends only to addresses verified in SES until AWS grants the account
 * production access; Resend sends to anyone once bizinsights.io is verified there. Read once per
 * cold start, after the secrets are in the environment.
 */
export function chooseMailer(e: NodeJS.ProcessEnv, credentials: AwsCredentials, fetchImpl: FetchLike = fetch): Mailer {
  const provider = e.EMAIL_PROVIDER || (e.RESEND_API_KEY ? "resend" : e.SES_REGION ? "ses" : "");
  if (provider === "resend" && e.RESEND_API_KEY) return resendMailer({ apiKey: e.RESEND_API_KEY, fetchImpl: withTimeout(fetchImpl, 10_000) });
  if (provider === "resend") logger.error("EMAIL_PROVIDER is resend but RESEND_API_KEY is not set: falling back to SES");
  if (e.SES_REGION) return sesMailer({ region: e.SES_REGION, credentials, configurationSet: e.SES_CONFIGURATION_SET, fetchImpl });
  return logMailer;
}
