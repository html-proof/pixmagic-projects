/**
 * One interface over the three ways of sending (EmailProviderAdapter): Gmail API, Microsoft Graph
 * and SMTP. The rest of the module builds one MIME message and hands it over; each adapter turns
 * its provider's answers into the same EmailSendError kinds, so retries, account states and the
 * activity log never need to know which provider it was.
 *
 * None of the three reports delivery: send-only access can't read the mailbox where bounce notices
 * land (supportsDeliveryEvents is false everywhere). The one exception is an SMTP server refusing a
 * recipient outright during the conversation, which is a real bounce and is reported as one.
 */
import { blockedAddressReason, smtpHostProblem, type ConnectionMethod } from "@app/shared/email";
import { systemDb } from "@app/db";
import { safeErrorText, type EmailDeps } from "./common.js";
import { DnsLookupError, resolveAddresses } from "./dns.js";
import { base64Url } from "./mime.js";
import { OAuthError } from "./oauth.js";
import { SmtpError, smtpSend, type SmtpConfig } from "./smtp.js";
import { getValidAccessToken, revokeConnection, type AccountRef } from "./tokens.js";
import { AAD, open } from "./vault.js";

/**
 * - auth: the provider rejected the stored authorization or password (the account must be reconnected)
 * - sender_rejected: not allowed to send as this From address
 * - recipient_rejected: the recipient was refused (`bounce`: refused as nonexistent, a hard bounce)
 * - rate_limited / transient: try again later (`retryAfterSec` when the provider says)
 * - uncertain: the provider may have the message; don't retry on our own (no duplicates)
 * - invalid: the message itself was refused
 * - account_unusable: the account can't send at all (mailbox disabled, no TLS, no password sign-in)
 */
export type SendErrorKind = "auth" | "sender_rejected" | "recipient_rejected" | "rate_limited" | "transient" | "uncertain" | "invalid" | "account_unusable";

export class EmailSendError extends Error {
  constructor(
    message: string,
    public kind: SendErrorKind,
    /** ERROR_LABEL code. */
    public code: string,
    public opts: { retryAfterSec?: number; bounce?: boolean } = {},
  ) {
    super(message);
    this.name = "EmailSendError";
  }
}

export interface OutgoingEmail {
  /** Envelope sender: the verified From address. */
  from: string;
  to: string;
  /** The whole message (buildMime). */
  mime: string;
}

export interface SendResult {
  /** Gmail's message id or the SMTP server's queue id; null for Microsoft (sendMail returns none). */
  providerMessageId: string | null;
  /** The provider's acceptance, in a few words (sanitized). */
  detail: string;
}

type AdapterDeps = Pick<EmailDeps, "coord" | "fetchImpl" | "mailer" | "smtpConnect">;

export interface EmailProviderAdapter {
  readonly method: ConnectionMethod;
  /** Check the stored authorization works, without sending anything. */
  validateConnection(account: AccountRef, deps: AdapterDeps): Promise<void>;
  sendEmail(account: AccountRef, msg: OutgoingEmail, deps: AdapterDeps): Promise<SendResult>;
  normalizeProviderError(err: unknown): EmailSendError;
  /** Whether the provider tells us about delivery after acceptance. */
  supportsDeliveryEvents(): boolean;
  /** Take back access at the provider, as far as it allows. */
  disconnect(account: AccountRef, deps: AdapterDeps): Promise<"revoked" | "deleted_only" | "failed">;
}

const retryAfter = (res: Response): number | undefined => {
  const v = res.headers.get("retry-after");
  if (!v) return undefined;
  const n = Number(v);
  if (Number.isFinite(n)) return Math.max(1, Math.min(3600, Math.round(n)));
  const at = Date.parse(v);
  return Number.isFinite(at) ? Math.max(1, Math.min(3600, Math.round((at - Date.now()) / 1000))) : undefined;
};

function fromOAuth(err: unknown): EmailSendError | null {
  if (!(err instanceof OAuthError)) return null;
  return err.kind === "permanent" ? new EmailSendError(err.message, "auth", err.code) : new EmailSendError(err.message, "transient", err.code);
}

/**
 * A request that may have reached the provider and got no answer: whether the message went is
 * unknown. Retrying could send it twice, so it isn't retried on its own.
 */
const unanswered = (err: unknown) => new EmailSendError(`No answer from the provider: ${(err as Error).message}`, "uncertain", "send_interrupted");

/** Send with a token; on a 401 refresh once and try again (a token revoked or rotated elsewhere). */
async function withToken(account: AccountRef, deps: AdapterDeps, call: (token: string) => Promise<Response>): Promise<Response> {
  let token: string;
  try {
    token = await getValidAccessToken(account, deps);
  } catch (err) {
    throw fromOAuth(err) ?? err;
  }
  let res = await call(token);
  if (res.status !== 401) return res;
  try {
    token = await getValidAccessToken(account, deps, { forceRefresh: true });
  } catch (err) {
    throw fromOAuth(err) ?? err;
  }
  res = await call(token);
  return res;
}

// ---------------------------------------------------------------------------
// Gmail API (users.messages.send with the gmail.send scope)
// ---------------------------------------------------------------------------

function gmailError(status: number, body: { error?: { message?: string; status?: string; errors?: Array<{ reason?: string }> } }, res?: Response): EmailSendError {
  const reason = body.error?.errors?.[0]?.reason ?? body.error?.status ?? "";
  const msg = safeErrorText(body.error?.message) ?? `Gmail returned ${status}`;
  const after = res ? retryAfter(res) : undefined;
  if (status === 401) return new EmailSendError(msg, "auth", "auth_failed");
  if (/insufficientPermissions|ACCESS_TOKEN_SCOPE_INSUFFICIENT|PERMISSION_DENIED/i.test(reason)) return new EmailSendError(msg, "auth", "permission_missing");
  if (/dailyLimitExceeded|quotaExceeded/i.test(reason) || /limit exceeded for sending/i.test(msg)) return new EmailSendError(msg, "rate_limited", "quota_exceeded", { retryAfterSec: after ?? 3600 });
  if (status === 429 || /rateLimitExceeded|userRateLimitExceeded|RESOURCE_EXHAUSTED/i.test(reason)) return new EmailSendError(msg, "rate_limited", "rate_limited", { retryAfterSec: after });
  if (status >= 500) return new EmailSendError(msg, "transient", "provider_unavailable", { retryAfterSec: after });
  if (/failedPrecondition|Mail service not enabled|domainPolicy/i.test(`${reason} ${msg}`)) return new EmailSendError(msg, "account_unusable", "account_failed");
  if (/invalid to header|recipient address/i.test(msg)) return new EmailSendError(msg, "recipient_rejected", "invalid_recipient");
  return new EmailSendError(msg, "invalid", "invalid_message");
}

export const gmailAdapter: EmailProviderAdapter = {
  method: "oauth_google",
  async validateConnection(account, deps) {
    try {
      await getValidAccessToken(account, deps, { forceRefresh: true });
    } catch (err) {
      throw this.normalizeProviderError(err);
    }
  },
  async sendEmail(account, msg, deps) {
    let res: Response;
    try {
      res = await withToken(account, deps, (token) =>
        deps.fetchImpl("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
          method: "POST",
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          body: JSON.stringify({ raw: base64Url(msg.mime) }),
          signal: AbortSignal.timeout(60_000),
        }),
      );
    } catch (err) {
      if (err instanceof EmailSendError) throw err;
      throw unanswered(err);
    }
    const body = (await res.json().catch(() => ({}))) as { id?: string; error?: { message?: string; status?: string; errors?: Array<{ reason?: string }> } };
    if (!res.ok) throw gmailError(res.status, body, res);
    return { providerMessageId: typeof body.id === "string" ? body.id : null, detail: "Accepted by Gmail" };
  },
  normalizeProviderError(err) {
    if (err instanceof EmailSendError) return err;
    return fromOAuth(err) ?? new EmailSendError((err as Error).message, "transient", "provider_unavailable");
  },
  supportsDeliveryEvents: () => false,
  disconnect: (account, deps) => revokeConnection(account, deps),
};

// ---------------------------------------------------------------------------
// Microsoft Graph (POST /me/sendMail with a MIME body, delegated Mail.Send)
// ---------------------------------------------------------------------------

function graphError(status: number, body: { error?: { code?: string; message?: string } }, res?: Response): EmailSendError {
  const code = body.error?.code ?? "";
  const msg = safeErrorText(body.error?.message) ?? `Microsoft Graph returned ${status}`;
  const after = res ? retryAfter(res) : undefined;
  if (status === 401) return new EmailSendError(msg, "auth", "auth_failed");
  if (/ErrorSendAsDenied|SendAsDenied/i.test(code) || /send as|on behalf of/i.test(msg)) return new EmailSendError(msg, "sender_rejected", "sender_rejected");
  if (/MailboxNotEnabledForRESTAPI|MailboxNotFound|ResourceNotFound|ErrorAccountDisabled|ErrorMailboxStoreUnavailable/i.test(code)) return new EmailSendError(msg, "account_unusable", "account_failed");
  if (/ErrorQuotaExceeded|ErrorExceededMessageLimit|SubmissionQuotaExceeded|ErrorMessageSubmissionBlocked/i.test(code)) return new EmailSendError(msg, "rate_limited", "quota_exceeded", { retryAfterSec: after ?? 3600 });
  if (status === 403) return new EmailSendError(msg, "auth", "permission_missing");
  if (status === 429) return new EmailSendError(msg, "rate_limited", "rate_limited", { retryAfterSec: after });
  if (status >= 500) return new EmailSendError(msg, "transient", "provider_unavailable", { retryAfterSec: after });
  if (/ErrorInvalidRecipients|InvalidRecipients/i.test(code)) return new EmailSendError(msg, "recipient_rejected", "invalid_recipient");
  return new EmailSendError(msg, "invalid", "invalid_message");
}

export const graphAdapter: EmailProviderAdapter = {
  method: "oauth_microsoft",
  async validateConnection(account, deps) {
    let res: Response;
    try {
      res = await withToken(account, deps, (token) => deps.fetchImpl("https://graph.microsoft.com/v1.0/me?$select=id", { headers: { authorization: `Bearer ${token}` } }));
    } catch (err) {
      throw this.normalizeProviderError(err);
    }
    if (!res.ok) throw graphError(res.status, (await res.json().catch(() => ({}))) as { error?: { code?: string; message?: string } }, res);
  },
  async sendEmail(account, msg, deps) {
    let res: Response;
    try {
      res = await withToken(account, deps, (token) =>
        deps.fetchImpl("https://graph.microsoft.com/v1.0/me/sendMail", {
          method: "POST",
          headers: { authorization: `Bearer ${token}`, "content-type": "text/plain" },
          body: Buffer.from(msg.mime, "utf8").toString("base64"),
          signal: AbortSignal.timeout(60_000),
        }),
      );
    } catch (err) {
      if (err instanceof EmailSendError) throw err;
      throw unanswered(err);
    }
    // 202 Accepted: Exchange took it for delivery. That is all Graph ever says.
    if (res.status === 202 || res.ok) return { providerMessageId: null, detail: "Accepted by Microsoft (202)" };
    throw graphError(res.status, (await res.json().catch(() => ({}))) as { error?: { code?: string; message?: string } }, res);
  },
  normalizeProviderError(err) {
    if (err instanceof EmailSendError) return err;
    return fromOAuth(err) ?? new EmailSendError((err as Error).message, "transient", "provider_unavailable");
  },
  supportsDeliveryEvents: () => false,
  disconnect: (account, deps) => revokeConnection(account, deps),
};

// ---------------------------------------------------------------------------
// SMTP
// ---------------------------------------------------------------------------

/**
 * Whether bizinsights may connect to this SMTP host: a public name whose every address is a public
 * unicast address (no loopback, private, link-local, metadata or other special ranges). Checked
 * when the account is saved and again before every connection, since DNS can change in between.
 * Cloudflare's network adds its own egress boundary: Workers can't reach private networks at all.
 */
export async function vetSmtpHost(host: string, fetchImpl: EmailDeps["fetchImpl"]): Promise<void> {
  const problem = smtpHostProblem(host);
  if (problem) throw new EmailSendError(problem === "blocked_destination" ? "That SMTP server address isn't allowed" : "That SMTP host name isn't valid", "account_unusable", problem);
  if (blockedAddressReason(host) === null) return; // a public IP literal
  let addresses: string[];
  try {
    addresses = await resolveAddresses(host, fetchImpl);
  } catch (err) {
    if (err instanceof DnsLookupError) throw new EmailSendError("The SMTP host's DNS couldn't be checked right now", "transient", "provider_unavailable");
    throw err;
  }
  if (!addresses.length) throw new EmailSendError("That SMTP host name doesn't exist", "account_unusable", "invalid_host");
  if (addresses.some((a) => blockedAddressReason(a) !== null)) throw new EmailSendError("That SMTP server resolves to an address that isn't allowed", "account_unusable", "blocked_destination");
}

/** The account's SMTP settings, password opened. Only this module ever sees the password. */
export async function smtpConfigFor(account: AccountRef): Promise<SmtpConfig> {
  const c = await systemDb.emailSmtpCredential.findUnique({ where: { emailAccountId_workspaceId: { emailAccountId: account.id, workspaceId: account.workspaceId } } });
  if (!c) throw new EmailSendError("This account has no SMTP settings", "account_unusable", "account_failed");
  return { host: c.host, port: c.port, encryption: c.encryptionMode === "tls" ? "tls" : "starttls", username: c.username, password: open(c.secretEnc, AAD.smtpPassword(account.id)) };
}

/** Hard bounce: the server says the mailbox doesn't exist (5.1.1, 5.1.2, 5.1.10, or a 550/551 that says so). */
const isHardBounce = (e: SmtpError) =>
  !!e.reply && e.reply.code >= 550 && (/^5\.1\.(1|2|10)$/.test(e.reply.enhanced ?? "") || /user unknown|no such user|does not exist|mailbox unavailable|recipient not found/i.test(e.reply.text));

export function smtpSendError(err: unknown): EmailSendError {
  if (err instanceof EmailSendError) return err;
  if (!(err instanceof SmtpError)) return new EmailSendError((err as Error).message, "transient", "connect_failed");
  const msg = safeErrorText(err.message) ?? "SMTP error";
  switch (err.code) {
    case "auth_failed":
      return new EmailSendError(msg, "auth", "auth_failed");
    case "auth_unavailable":
    case "starttls_unavailable":
      return new EmailSendError(msg, "account_unusable", err.code);
    case "tls_failed":
      return new EmailSendError(msg, "transient", "tls_failed");
    case "connect_failed":
    case "protocol":
      return new EmailSendError(msg, "transient", "connect_failed");
    case "timeout":
      return new EmailSendError(msg, "transient", "timeout");
    case "sender_rejected":
      return new EmailSendError(msg, "sender_rejected", "sender_rejected");
    case "recipient_rejected":
      return new EmailSendError(msg, "recipient_rejected", "recipient_rejected", { bounce: isHardBounce(err) });
    case "message_rejected":
      return new EmailSendError(msg, "invalid", "invalid_message");
    case "uncertain":
      return new EmailSendError(msg, "uncertain", "send_interrupted");
    case "transient":
      return err.reply && (err.reply.code === 421 || err.reply.code === 452 || /rate|limit|too many/i.test(err.reply.text))
        ? new EmailSendError(msg, "rate_limited", "rate_limited", { retryAfterSec: 300 })
        : new EmailSendError(msg, "transient", "provider_unavailable");
  }
}

export const smtpAdapter: EmailProviderAdapter = {
  method: "smtp",
  async validateConnection(account, deps) {
    if (!deps.smtpConnect) throw new EmailSendError("Outbound SMTP isn't available on this server", "transient", "connect_failed");
    const cfg = await smtpConfigFor(account);
    await vetSmtpHost(cfg.host, deps.fetchImpl);
    try {
      await smtpSend(deps.smtpConnect, cfg);
    } catch (err) {
      throw smtpSendError(err);
    }
  },
  async sendEmail(account, msg, deps) {
    if (!deps.smtpConnect) throw new EmailSendError("Outbound SMTP isn't available on this server", "transient", "connect_failed");
    const cfg = await smtpConfigFor(account);
    await vetSmtpHost(cfg.host, deps.fetchImpl);
    try {
      const r = await smtpSend(deps.smtpConnect, cfg, { from: msg.from, to: msg.to, data: msg.mime });
      return { providerMessageId: r.queueId, detail: safeErrorText(`Accepted by the SMTP server: ${r.response}`, 200) ?? "Accepted by the SMTP server" };
    } catch (err) {
      throw smtpSendError(err);
    }
  },
  normalizeProviderError: smtpSendError,
  supportsDeliveryEvents: () => false,
  // Nothing to revoke at an SMTP server: the stored password is deleted by the caller.
  disconnect: async () => "deleted_only",
};

export function adapterFor(method: string): EmailProviderAdapter {
  if (method === "oauth_google") return gmailAdapter;
  if (method === "oauth_microsoft") return graphAdapter;
  if (method === "smtp") return smtpAdapter;
  throw new Error(`Unknown connection method ${method}`);
}
