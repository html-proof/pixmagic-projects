import { createHash } from "node:crypto";
import { buildClient, CommitmentPolicy, KmsKeyringNode, type KeyringNode } from "@aws-crypto/client-node";
import { authEmail, env, isAuthEmailTrigger, logger, withLogContext, type Mailer, type SenderSettings } from "@app/core/mailer";
import { roleCredentials } from "./awsClient.js";
import { chooseMailer, logMailer } from "./mailers.js";
import { loadSecrets } from "./secrets.js";

/**
 * The user pool's Custom Email Sender trigger (infra/cdk auth-stack.ts): Cognito hands every email
 * it would send (sign-up and email-change codes, password resets, sign-in codes, temporary
 * passwords) to this function instead, with the code encrypted under the pool's KMS key, and the
 * function sends it through the app's mail provider (Resend; mailers.ts) from the support sender
 * (OTP_FROM_EMAIL, core/mail/senders.ts).
 *
 * Its own small bundle (cognito-email.mjs, scripts/build.mjs) in the same package as the app's
 * functions. Cognito invokes it asynchronously: a throw makes Lambda try twice more, and the same
 * event carries the same ciphertext, so the provider's idempotency key keeps a retry from sending
 * a second copy. Neither the code nor the address is ever logged.
 */
export interface CognitoEmailEvent {
  version?: string;
  triggerSource: string;
  region?: string;
  userPoolId: string;
  userName?: string;
  request: {
    type?: string;
    /** The code or temporary password, encrypted with the AWS Encryption SDK (base64). */
    code?: string | null;
    clientMetadata?: Record<string, string> | null;
    userAttributes?: Record<string, string> | null;
  };
}

const { decrypt } = buildClient(CommitmentPolicy.REQUIRE_ENCRYPT_ALLOW_DECRYPT);

/**
 * The plaintext of an event's code. Cognito encrypts it with the key in the pool's LambdaConfig and
 * names the pool in the encryption context, so a code meant for another pool is refused.
 */
export async function decryptCode(ciphertext: string, keyring: KeyringNode, userPoolId: string): Promise<string> {
  const { plaintext, messageHeader } = await decrypt(keyring, Buffer.from(ciphertext, "base64"));
  const pool = messageHeader.encryptionContext["userpool-id"];
  if (pool !== undefined && pool !== userPoolId) throw new Error("The code was encrypted for another user pool");
  return Buffer.from(plaintext).toString("utf8");
}

/**
 * Cognito HTML-escapes <, >, &, " and ' in temporary passwords before encrypting them (never in
 * codes), so a password containing them reads as typed only after this.
 */
export function unescapeTemporaryPassword(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0*39;|&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

export interface CognitoEmailDeps {
  decrypt(ciphertext: string, userPoolId: string): Promise<string>;
  mailer: Mailer;
  /** The app's address, for the sign-in link in a temporary-password email. */
  appUrl: string;
  /** Who the emails are signed by (env() here; the From address is the mailer's, from the same settings). */
  senders?: SenderSettings;
}

export type CognitoEmailResult = { sent: true; provider: string | null; messageId: string | null } | { sent: false; reason: "no_message" | "no_address" | "no_code" };

/** One Cognito event: decrypt its code, build the email for its trigger and send it. */
export async function sendCognitoEmail(event: CognitoEmailEvent, deps: CognitoEmailDeps): Promise<CognitoEmailResult> {
  const trigger = event.triggerSource;
  return withLogContext({ trigger }, async () => {
    // Nothing to send for a trigger this pool doesn't use (account-takeover notices need the Plus plan).
    if (!isAuthEmailTrigger(trigger)) {
      logger.warn({ trigger }, "cognito email: trigger not handled, nothing sent");
      return { sent: false, reason: "no_message" };
    }
    const email = event.request.userAttributes?.email?.trim();
    if (!email) {
      logger.warn({ trigger }, "cognito email: the user has no email address, nothing sent");
      return { sent: false, reason: "no_address" };
    }
    const ciphertext = event.request.code;
    if (!ciphertext) {
      logger.warn({ trigger }, "cognito email: the event carries no code, nothing sent");
      return { sent: false, reason: "no_code" };
    }
    const decrypted = await deps.decrypt(ciphertext, event.userPoolId);
    const code = trigger === "CustomEmailSender_AdminCreateUser" ? unescapeTemporaryPassword(decrypted) : decrypted;
    const message = authEmail({ trigger, code, name: event.request.userAttributes?.name, email, appUrl: deps.appUrl, senders: deps.senders })!;
    // A retried invocation brings the same ciphertext: the provider sends it once.
    const idempotencyKey = `cognito-${createHash("sha256").update(ciphertext).digest("hex").slice(0, 48)}`;
    const receipt = await deps.mailer.send(email, message.subject, message.text, message.html, { idempotencyKey, purpose: message.purpose });
    const provider = receipt ? receipt.provider : null;
    const messageId = receipt ? receipt.messageId : null;
    logger.info({ trigger, provider, messageId }, "cognito email sent");
    return { sent: true, provider, messageId };
  });
}

let ready: Promise<CognitoEmailDeps> | undefined;
/** Cold start: the app secret (RESEND_API_KEY) into process.env, the KMS keyring and the mailer, once per instance. */
function deps(): Promise<CognitoEmailDeps> {
  ready ??= (async (): Promise<CognitoEmailDeps> => {
    const { sources, fallbacks } = await loadSecrets();
    logger.info({ sources }, "secrets loaded");
    for (const [name, why] of Object.entries(fallbacks)) logger.warn({ name, why }, "this secret's copy in Parameter Store couldn't be read: read from Secrets Manager instead");
    const keyArn = process.env.COGNITO_EMAIL_KEY_ARN;
    if (!keyArn) throw new Error("COGNITO_EMAIL_KEY_ARN is not set");
    // Decrypt only, and only with this key (strict mode: data keys under any other key are ignored).
    const keyring = new KmsKeyringNode({ keyIds: [keyArn] });
    // Resend calls get their time limit there (mailers.ts).
    const mailer = chooseMailer(process.env, roleCredentials());
    // Without a provider the codes would only be logged as "not sent": fail, so the alarm says so.
    if (mailer === logMailer) throw new Error("No mail provider for Cognito's emails: RESEND_API_KEY is not in the app secret");
    return { decrypt: (ciphertext, userPoolId) => decryptCode(ciphertext, keyring, userPoolId), mailer, appUrl: env().APP_URL, senders: env() };
  })().catch((err: unknown) => {
    ready = undefined;
    throw err;
  });
  return ready;
}

export const handler = async (event: CognitoEmailEvent): Promise<CognitoEmailResult> => {
  try {
    return await sendCognitoEmail(event, await deps());
  } catch (err) {
    // Rethrown: Lambda retries, and the failure counts in the function's Errors metric (alarm).
    // MailError and the SDK's errors carry no address or code; the event isn't logged.
    logger.error({ err, trigger: event?.triggerSource }, "cognito email failed");
    throw err;
  }
};
