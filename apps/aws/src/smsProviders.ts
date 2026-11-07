import { env, logger, type Coord, type FetchLike } from "@app/core";
import { noSmsProvider, twilioStatusUrl, type SmsProvider } from "@app/core/sms";
import type { AwsCredentials } from "./awsClient.js";
import { awsSmsProvider } from "./smsProvider.js";
import { twilioSmsProvider } from "./twilioSmsProvider.js";

/**
 * Customer Messaging's provider, by SMS_PROVIDER (docs/sms.md): AWS End User Messaging SMS with
 * the given AWS credentials (the default), or Twilio with TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN.
 * Twilio without both refuses every text (and says why in the logs) rather than falling back to
 * AWS: a half-made switch must not text through the provider being left.
 */
export function chooseSmsProvider(o: { credentials: AwsCredentials; coord: Coord; fetchImpl: FetchLike }): SmsProvider {
  // Read raw first, so building the AWS default needs no full configuration (scripts, tests).
  if ((process.env.SMS_PROVIDER ?? "").trim() !== "twilio") return awsSmsProvider({ credentials: o.credentials, fetchImpl: o.fetchImpl });
  const e = env();
  if (!e.TWILIO_ACCOUNT_SID.trim() || !e.TWILIO_AUTH_TOKEN.trim()) {
    logger.error({ accountSid: !!e.TWILIO_ACCOUNT_SID.trim(), authToken: !!e.TWILIO_AUTH_TOKEN.trim() }, "SMS_PROVIDER=twilio needs TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN: texts are refused until both are set");
    return noSmsProvider;
  }
  return twilioSmsProvider({
    accountSid: e.TWILIO_ACCOUNT_SID.trim(),
    authToken: e.TWILIO_AUTH_TOKEN.trim(),
    coord: o.coord,
    statusUrl: (context) => twilioStatusUrl(context),
    pepper: e.OTP_PEPPER,
    fallbackSender: () => env().SMS_SHARED_SENDER,
    fetchImpl: o.fetchImpl,
  });
}
