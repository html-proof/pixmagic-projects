/**
 * Connected email accounts: connecting (OAuth or SMTP), testing, settings, disabling and
 * disconnecting. Credentials go into the vault and never come back out through here: publicAccount
 * is everything the API may show.
 */
import { systemDb, withTenant, type EmailAccount, type EmailSenderIdentity } from "@app/db";
import { accountCanSend, normalizeEmail, PROVIDER_LIMITS, smtpPortProblem, type EmailProvider, type SmtpConnectionInput } from "@app/shared/email";
import { z } from "zod";
import { smtpUpdateSchema } from "@app/shared/email";
import { logger } from "../logger.js";
import { emailAudit, EmailError, isUniqueViolation, notFound, type EmailDeps } from "./common.js";
import { cancelPending } from "./delivery.js";
import type { OAuthIdentity, OAuthTokens } from "./oauth.js";
import { adapterFor, EmailSendError, vetSmtpHost } from "./providers.js";
import { authorizeByDomain, ensurePrimarySender, publicSender } from "./senders.js";
import { markReauthorizationRequired, sealTokens } from "./tokens.js";
import { AAD, seal, sealedKeyVersion } from "./vault.js";

type AccountWithParts = EmailAccount & {
  senders?: EmailSenderIdentity[];
  smtpCredential?: { host: string; port: number; encryptionMode: string; username: string } | null;
};

/** What the browser may know about an account: never a token, a password, or a ciphertext. */
export function publicAccount(a: AccountWithParts) {
  const limits = PROVIDER_LIMITS[a.provider as EmailProvider] ?? PROVIDER_LIMITS.smtp;
  return {
    id: a.id,
    provider: a.provider,
    connectionMethod: a.connectionMethod,
    email: a.emailAddress,
    displayName: a.displayName,
    replyTo: a.replyToAddress,
    status: a.status,
    statusReason: a.statusReason,
    canSend: accountCanSend(a.status),
    grantedScopes: a.grantedScopes,
    providerTenantId: a.provider === "google_workspace" ? a.providerTenantId : null,
    dailyLimit: a.dailyLimit ?? limits.perDay,
    providerDailyLimit: limits.perDay,
    perMinuteLimit: limits.perMinute,
    lastVerifiedAt: a.lastVerifiedAt,
    lastSuccessfulSendAt: a.lastSuccessfulSendAt,
    lastErrorCode: a.lastErrorCode,
    lastErrorAt: a.lastErrorAt,
    connectedAt: a.createdAt,
    smtp: a.smtpCredential ? { host: a.smtpCredential.host, port: a.smtpCredential.port, encryption: a.smtpCredential.encryptionMode, username: a.smtpCredential.username } : null,
    senders: (a.senders ?? []).filter((s) => s.authorizationStatus !== "revoked").map(publicSender),
    isDefault: (a.senders ?? []).some((s) => s.isDefault),
  };
}

const SMTP_PUBLIC = { select: { host: true, port: true, encryptionMode: true, username: true } } as const;

export async function listEmailAccounts(workspaceId: string) {
  return withTenant(workspaceId, (tx) =>
    tx.emailAccount.findMany({ where: { workspaceId, deletedAt: null }, include: { senders: true, smtpCredential: SMTP_PUBLIC }, orderBy: { createdAt: "asc" } }),
  );
}

export async function getEmailAccount(workspaceId: string, id: string) {
  const a = await withTenant(workspaceId, (tx) => tx.emailAccount.findFirst({ where: { id, workspaceId, deletedAt: null }, include: { senders: true, smtpCredential: SMTP_PUBLIC } }));
  if (!a) throw notFound();
  return a;
}

// ---------------------------------------------------------------------------
// OAuth
// ---------------------------------------------------------------------------

/**
 * Save a Google or Microsoft sign-in. The same mailbox (provider account id) connecting again
 * updates its row ("reconnect"); a reconnect of a specific account must sign in as that account.
 * A sign-in without a refresh token keeps the stored one for the same mailbox, and is refused for a
 * new one (it could never send in the background).
 */
export async function connectOAuthAccount(input: {
  workspaceId: string;
  userId: string;
  method: "oauth_google" | "oauth_microsoft";
  identity: OAuthIdentity;
  tokens: OAuthTokens;
  reauthorizeAccountId?: string | null;
  /** Internal: the second try after losing a race with a concurrent callback for the same mailbox. */
  retried?: boolean;
}): Promise<{ account: EmailAccount; created: boolean }> {
  const email = normalizeEmail(input.identity.email);
  if (!email) throw new EmailError("The provider returned an address bizinsights can't send from", 422, "account_failed");
  const live = await systemDb.emailAccount.findFirst({
    where: { workspaceId: input.workspaceId, connectionMethod: input.method, deletedAt: null, OR: [{ providerAccountId: input.identity.providerAccountId }, { emailAddress: email }] },
    include: { oauthCredential: true },
  });
  if (input.reauthorizeAccountId) {
    if (!live || live.id !== input.reauthorizeAccountId) {
      throw new EmailError(`You signed in as ${email}, which isn't the account you're reconnecting. Sign in with that account's address instead.`, 409, "different_account");
    }
  }
  if (live && live.providerAccountId && live.providerAccountId !== input.identity.providerAccountId) {
    throw new EmailError(`${email} is already connected as a different ${input.method === "oauth_google" ? "Google" : "Microsoft"} account. Disconnect it first.`, 409, "different_account");
  }
  if (!input.tokens.refreshToken && !live?.oauthCredential) {
    throw new EmailError(
      input.method === "oauth_google"
        ? "Google didn't grant offline access. Remove bizinsights at myaccount.google.com/permissions, then connect again."
        : "Microsoft didn't grant offline access (offline_access). Connect again and accept every permission.",
      422,
      "no_refresh_token",
    );
  }
  const now = new Date();
  const common = {
    provider: input.identity.provider,
    emailAddress: email,
    providerAccountId: input.identity.providerAccountId,
    providerTenantId: input.identity.providerTenantId,
    status: "connected",
    statusReason: null,
    grantedScopes: input.tokens.scopes.slice(0, 20),
    lastVerifiedAt: now,
    lastErrorCode: null,
    connectedByUserId: input.userId,
  };
  const result = await systemDb
    .$transaction(async (tx) => {
    const account = live
      ? await tx.emailAccount.update({ where: { id: live.id }, data: common })
      : await tx.emailAccount.create({ data: { workspaceId: input.workspaceId, connectionMethod: input.method, displayName: input.identity.displayName, ...common } });
    const sealed = sealTokens(account.id, input.tokens);
    const cred = await tx.emailOAuthCredential.findUnique({ where: { emailAccountId_workspaceId: { emailAccountId: account.id, workspaceId: account.workspaceId } } });
    if (cred) {
      await tx.emailOAuthCredential.update({
        where: { id: cred.id },
        data: {
          accessTokenEnc: sealed.accessTokenEnc,
          tokenExpiresAt: sealed.tokenExpiresAt,
          // Never replace a stored refresh token with nothing.
          ...(sealed.refreshTokenEnc ? { refreshTokenEnc: sealed.refreshTokenEnc } : {}),
          encryptionKeyVersion: sealed.encryptionKeyVersion,
          credentialVersion: { increment: 1 },
          lastRefreshedAt: now,
        },
      });
    } else {
      await tx.emailOAuthCredential.create({
        data: {
          workspaceId: account.workspaceId,
          emailAccountId: account.id,
          refreshTokenEnc: sealed.refreshTokenEnc!,
          accessTokenEnc: sealed.accessTokenEnc,
          tokenExpiresAt: sealed.tokenExpiresAt,
          encryptionKeyVersion: sealed.encryptionKeyVersion,
          lastRefreshedAt: now,
        },
      });
    }
    await ensurePrimarySender(tx, account);
    return { account, created: !live };
    })
    .catch((err: unknown) => {
      // Two callbacks for the same mailbox at once: the other created the row first. Running again
      // finds it and updates it instead.
      if (isUniqueViolation(err) && !input.retried) return null;
      throw err;
    });
  if (!result) return connectOAuthAccount({ ...input, retried: true });
  await emailAudit({
    workspaceId: input.workspaceId,
    actorUserId: input.userId,
    action: result.created ? "email.account.connected" : "email.account.reconnected",
    targetType: "email_account",
    targetId: result.account.id,
    metadata: { provider: input.identity.provider, method: input.method, scopes: input.tokens.scopes },
  });
  // Mail held while the account waited for reconnection goes out on the sweep's next pass.
  await systemDb.alert.updateMany({ where: { workspaceId: input.workspaceId, code: `email_account_reauth:${result.account.id}`, resolvedAt: null }, data: { resolvedAt: new Date() } });
  return result;
}

// ---------------------------------------------------------------------------
// SMTP
// ---------------------------------------------------------------------------

async function vetSmtp(host: string, port: number, encryption: "tls" | "starttls", deps: Pick<EmailDeps, "fetchImpl">) {
  const portProblem = smtpPortProblem(port, encryption);
  if (portProblem) throw new EmailError(portProblem, 400, "invalid_port");
  try {
    await vetSmtpHost(host, deps.fetchImpl);
  } catch (err) {
    if (err instanceof EmailSendError) throw new EmailError(err.message, err.kind === "transient" ? 503 : 400, err.code);
    throw err;
  }
}

/** Run the adapter's connection check and record the result on the account. */
export async function testEmailConnection(workspaceId: string, accountId: string, deps: EmailDeps, userId?: string | null) {
  const account = await getEmailAccount(workspaceId, accountId);
  if (account.status === "disabled") throw new EmailError("Enable the account before testing it", 409, "account_disabled");
  const adapter = adapterFor(account.connectionMethod);
  await systemDb.emailAccount.updateMany({ where: { id: account.id, workspaceId, status: { in: ["pending", "failed", "connected", "degraded"] } }, data: { status: "testing" } });
  let result: { ok: true } | { ok: false; code: string; message: string };
  try {
    await adapter.validateConnection(account, deps);
    result = { ok: true };
  } catch (err) {
    const e = adapter.normalizeProviderError(err);
    result = { ok: false, code: e.code, message: e.message };
    if (e.kind === "auth" && account.connectionMethod !== "smtp") await markReauthorizationRequired(account, e.code, deps);
  }
  const now = new Date();
  await systemDb.emailAccount.updateMany({
    where: { id: account.id, workspaceId, status: { notIn: ["reauthorization_required", "disabled", "revoked"] } },
    data: result.ok
      ? { status: "connected", statusReason: null, lastVerifiedAt: now, lastErrorCode: null }
      : { status: result.code === "provider_unavailable" ? "degraded" : "failed", statusReason: result.code, lastErrorCode: result.code, lastErrorAt: now },
  });
  if (result.ok) {
    const primary = await systemDb.emailSenderIdentity.findUnique({ where: { emailAccountId_senderEmail: { emailAccountId: account.id, senderEmail: account.emailAddress } } });
    if (primary) await authorizeByDomain(workspaceId, primary, { status: "connected", connectionMethod: account.connectionMethod });
  }
  await emailAudit({ workspaceId, actorUserId: userId ?? null, action: "email.account.tested", targetType: "email_account", targetId: account.id, metadata: result.ok ? { ok: true } : { ok: false, code: result.code } });
  return result;
}

export async function createSmtpAccount(workspaceId: string, userId: string, input: SmtpConnectionInput, deps: EmailDeps) {
  await vetSmtp(input.host, input.port, input.encryption, deps);
  let account: EmailAccount;
  try {
    account = await systemDb.$transaction(async (tx) => {
      const a = await tx.emailAccount.create({
        data: {
          workspaceId,
          provider: "smtp",
          connectionMethod: "smtp",
          emailAddress: input.emailAddress,
          displayName: input.displayName || null,
          replyToAddress: input.replyTo ?? null,
          status: "testing",
          connectedByUserId: userId,
        },
      });
      const secretEnc = seal(input.password, AAD.smtpPassword(a.id));
      await tx.emailSmtpCredential.create({
        data: { workspaceId, emailAccountId: a.id, host: input.host, port: input.port, encryptionMode: input.encryption, username: input.username, secretEnc, encryptionKeyVersion: sealedKeyVersion(secretEnc) },
      });
      await ensurePrimarySender(tx, a);
      return a;
    });
  } catch (err) {
    if (isUniqueViolation(err)) throw new EmailError(`${input.emailAddress} is already connected over SMTP.`, 409, "account_exists");
    throw err;
  }
  await emailAudit({ workspaceId, actorUserId: userId, action: "email.account.connected", targetType: "email_account", targetId: account.id, metadata: { provider: "smtp", host: input.host, port: input.port, encryption: input.encryption } });
  const test = await testEmailConnection(workspaceId, account.id, deps, userId);
  return { account: await getEmailAccount(workspaceId, account.id), test };
}

export async function updateSmtpAccount(workspaceId: string, accountId: string, userId: string, input: z.infer<typeof smtpUpdateSchema>, deps: EmailDeps) {
  const account = await getEmailAccount(workspaceId, accountId);
  if (account.connectionMethod !== "smtp") throw new EmailError("Only SMTP accounts have server settings", 400, "not_smtp");
  await vetSmtp(input.host, input.port, input.encryption, deps);
  await systemDb.$transaction(async (tx) => {
    await tx.emailSmtpCredential.update({
      where: { emailAccountId_workspaceId: { emailAccountId: account.id, workspaceId } },
      data: {
        host: input.host,
        port: input.port,
        encryptionMode: input.encryption,
        username: input.username,
        ...(input.password ? (() => {
          const secretEnc = seal(input.password!, AAD.smtpPassword(account.id));
          return { secretEnc, encryptionKeyVersion: sealedKeyVersion(secretEnc) };
        })() : {}),
      },
    });
    await tx.emailAccount.update({
      where: { id: account.id },
      data: { displayName: input.displayName || null, replyToAddress: input.replyTo ?? null, ...(account.status === "reauthorization_required" || account.status === "failed" ? { status: "pending" } : {}) },
    });
  });
  await emailAudit({ workspaceId, actorUserId: userId, action: "email.account.smtp_updated", targetType: "email_account", targetId: account.id, metadata: { host: input.host, port: input.port, passwordChanged: !!input.password } });
  return testEmailConnection(workspaceId, account.id, deps, userId);
}

// ---------------------------------------------------------------------------
// Settings, disable, disconnect
// ---------------------------------------------------------------------------

export async function updateEmailAccount(
  workspaceId: string,
  accountId: string,
  userId: string,
  patch: { displayName?: string; replyTo?: string | null; enabled?: boolean; isDefault?: true; dailyLimit?: number | null },
) {
  const account = await getEmailAccount(workspaceId, accountId);
  const data: Record<string, unknown> = {};
  if (patch.displayName !== undefined) data.displayName = patch.displayName || null;
  if (patch.replyTo !== undefined) data.replyToAddress = patch.replyTo;
  if (patch.dailyLimit !== undefined) {
    const max = (PROVIDER_LIMITS[account.provider as EmailProvider] ?? PROVIDER_LIMITS.smtp).perDay;
    if (patch.dailyLimit !== null && patch.dailyLimit > max) throw new EmailError(`This provider allows at most ${max} messages a day from one account.`, 400, "limit_too_high");
    data.dailyLimit = patch.dailyLimit;
  }
  if (patch.enabled === false && account.status !== "disabled") {
    data.status = "disabled";
    data.statusReason = "disabled_by_user";
  }
  if (patch.enabled === true && account.status === "disabled") {
    // Back to "pending": the next test or send says whether it works.
    data.status = "pending";
    data.statusReason = null;
  }
  if (Object.keys(data).length) await systemDb.emailAccount.update({ where: { id: account.id }, data });
  if (patch.isDefault) {
    const primary = account.senders.find((s) => s.senderEmail === account.emailAddress && s.authorizationStatus === "verified");
    if (!primary || !accountCanSend(account.status)) throw new EmailError("Only a connected account with a verified address can be the default sender.", 409, "sender_unavailable");
    await systemDb.$transaction([
      systemDb.emailSenderIdentity.updateMany({ where: { workspaceId, isDefault: true }, data: { isDefault: false } }),
      systemDb.emailSenderIdentity.update({ where: { id: primary.id }, data: { isDefault: true } }),
    ]);
  }
  const action = patch.enabled === false ? "email.account.disabled" : patch.enabled === true ? "email.account.enabled" : "email.account.updated";
  await emailAudit({ workspaceId, actorUserId: userId, action, targetType: "email_account", targetId: account.id, metadata: { fields: Object.keys(patch) } });
  return getEmailAccount(workspaceId, accountId);
}

/**
 * Disconnect: revoke what the provider allows, delete the stored credentials, retire the account's
 * senders, cancel its waiting mail and turn off the automations that sent from it. The row stays
 * (deleted_at) so the history still names the account.
 */
export async function disconnectEmailAccount(workspaceId: string, accountId: string, userId: string, deps: EmailDeps) {
  const account = await getEmailAccount(workspaceId, accountId);
  const revocation = await adapterFor(account.connectionMethod)
    .disconnect(account, deps)
    .catch((err: unknown) => {
      logger.warn({ err, accountId }, "provider revocation failed; credentials are deleted anyway");
      return "failed" as const;
    });
  const senderIds = account.senders.map((s) => s.id);
  const rules = await systemDb.emailAutomationRule.findMany({ where: { workspaceId, senderIdentityId: { in: senderIds }, deletedAt: null, enabled: true }, select: { id: true } });
  await systemDb.$transaction([
    systemDb.emailOAuthCredential.deleteMany({ where: { emailAccountId: account.id, workspaceId } }),
    systemDb.emailSmtpCredential.deleteMany({ where: { emailAccountId: account.id, workspaceId } }),
    systemDb.emailSenderIdentity.updateMany({ where: { emailAccountId: account.id, workspaceId }, data: { authorizationStatus: "revoked", isDefault: false, verificationCodeHash: null } }),
    systemDb.emailAutomationRule.updateMany({ where: { id: { in: rules.map((r) => r.id) } }, data: { enabled: false, updatedByUserId: userId } }),
    systemDb.emailAccount.update({ where: { id: account.id }, data: { status: "revoked", statusReason: "disconnected", deletedAt: new Date() } }),
  ]);
  const cancelled = await cancelPending({ workspaceId, emailAccountId: account.id }, "account_disconnected");
  await emailAudit({
    workspaceId,
    actorUserId: userId,
    action: "email.account.disconnected",
    targetType: "email_account",
    targetId: account.id,
    metadata: { provider: account.provider, revocation, rulesDisabled: rules.length, messagesCancelled: cancelled },
  });
  return { revocation, rulesDisabled: rules.length, messagesCancelled: cancelled };
}
