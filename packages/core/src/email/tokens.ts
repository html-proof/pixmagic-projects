/**
 * TokenManager: a usable access token for an OAuth account, refreshed shortly before it expires.
 *
 *  - One refresh at a time per account: a Coordinator lock, then a re-read (someone may have just
 *    refreshed), then the refresh, then a compare-and-set on credential_version so two writers can
 *    never overwrite each other's rotated refresh token.
 *  - A refresh response without a refresh token keeps the stored one (Google usually sends none;
 *    an empty value never replaces a good one).
 *  - Microsoft rotates refresh tokens on every refresh: the new one is stored in the same write.
 *  - A permanent failure (revoked, expired, consent withdrawn, blocked by policy) marks the account
 *    reauthorization_required once, records a sanitized audit entry and alerts the workspace's
 *    admins; nothing retries a dead grant. A transient one marks it degraded and is retried later.
 */
import { systemDb, type EmailAccount } from "@app/db";
import { logger } from "../logger.js";
import { raiseAlert } from "../notify.js";
import { emailAudit, type EmailDeps } from "./common.js";
import { googleEmailConfig, googleEmailRefresh, googleEmailRevoke, microsoftEmailConfig, microsoftEmailRefresh, OAuthError, type OAuthTokens } from "./oauth.js";
import { AAD, credentialKeyring, open, seal, sealedKeyVersion } from "./vault.js";

export type AccountRef = Pick<EmailAccount, "id" | "workspaceId" | "connectionMethod" | "emailAddress" | "provider">;

/** Refresh this long before the access token expires. */
const REFRESH_SKEW_MS = 5 * 60_000;
const LOCK_TTL_MS = 30_000;
const LOCK_WAIT_MS = 750;
const LOCK_WAITS = 12;

const lockKey = (accountId: string) => `lock:email-token:${accountId}`;

/** Seal a token set for an account: what goes into email_oauth_credentials. */
export function sealTokens(accountId: string, t: Pick<OAuthTokens, "accessToken" | "refreshToken" | "expiresAt">) {
  const accessTokenEnc = seal(t.accessToken, AAD.oauthAccess(accountId));
  return {
    accessTokenEnc,
    refreshTokenEnc: t.refreshToken ? seal(t.refreshToken, AAD.oauthRefresh(accountId)) : null,
    tokenExpiresAt: t.expiresAt,
    encryptionKeyVersion: sealedKeyVersion(accessTokenEnc),
  };
}

async function loadCredential(account: Pick<AccountRef, "id" | "workspaceId">) {
  // Scoped by workspace as well as account: a job can't be pointed at another workspace's tokens.
  return systemDb.emailOAuthCredential.findUnique({ where: { emailAccountId_workspaceId: { emailAccountId: account.id, workspaceId: account.workspaceId } } });
}

const fresh = (expiresAt: Date | null) => !!expiresAt && expiresAt.getTime() - Date.now() > REFRESH_SKEW_MS;

/**
 * A valid access token for the account (getValidAccessToken). `forceRefresh` after the provider
 * rejected the current one (a 401 before its expiry: revoked or rotated elsewhere).
 */
export async function getValidAccessToken(account: AccountRef, deps: Pick<EmailDeps, "coord" | "fetchImpl" | "mailer">, opts: { forceRefresh?: boolean } = {}): Promise<string> {
  let cred = await loadCredential(account);
  if (!cred) throw new OAuthError("This account has no stored authorization", "permanent", "account_reauthorization_required");
  if (!opts.forceRefresh && cred.accessTokenEnc && fresh(cred.tokenExpiresAt)) return open(cred.accessTokenEnc, AAD.oauthAccess(account.id));
  const seenVersion = cred.credentialVersion;
  for (let i = 0; i <= LOCK_WAITS; i++) {
    if (await deps.coord.acquire(lockKey(account.id), LOCK_TTL_MS)) {
      try {
        // Someone else may have refreshed while we waited for the lock.
        cred = await loadCredential(account);
        if (!cred) throw new OAuthError("This account has no stored authorization", "permanent", "account_reauthorization_required");
        if (cred.credentialVersion !== seenVersion && cred.accessTokenEnc && fresh(cred.tokenExpiresAt)) return open(cred.accessTokenEnc, AAD.oauthAccess(account.id));
        return await refreshLocked(account, cred, deps);
      } finally {
        await deps.coord.release(lockKey(account.id)).catch(() => undefined);
      }
    }
    await new Promise((r) => setTimeout(r, LOCK_WAIT_MS));
    const again = await loadCredential(account);
    if (again && again.credentialVersion !== seenVersion && again.accessTokenEnc && fresh(again.tokenExpiresAt)) return open(again.accessTokenEnc, AAD.oauthAccess(account.id));
  }
  throw new OAuthError("Another process is refreshing this account's access; try again shortly", "transient", "provider_unavailable");
}

/** Refresh now (refreshToken in the TokenManager's terms), waiting for any refresh in progress. */
export const refreshEmailAccessToken = (account: AccountRef, deps: Pick<EmailDeps, "coord" | "fetchImpl" | "mailer">) => getValidAccessToken(account, deps, { forceRefresh: true });

async function refreshLocked(account: AccountRef, cred: NonNullable<Awaited<ReturnType<typeof loadCredential>>>, deps: Pick<EmailDeps, "coord" | "fetchImpl" | "mailer">): Promise<string> {
  const refreshToken = open(cred.refreshTokenEnc, AAD.oauthRefresh(account.id));
  let t: OAuthTokens;
  try {
    if (account.connectionMethod === "oauth_google") {
      const cfg = googleEmailConfig(deps.fetchImpl);
      if (!cfg) throw new OAuthError("Google sign-in isn't set up on this server", "transient", "provider_unavailable");
      t = await googleEmailRefresh(cfg, refreshToken);
    } else if (account.connectionMethod === "oauth_microsoft") {
      const cfg = microsoftEmailConfig(deps.fetchImpl);
      if (!cfg) throw new OAuthError("Microsoft sign-in isn't set up on this server", "transient", "provider_unavailable");
      t = await microsoftEmailRefresh(cfg, refreshToken);
    } else {
      throw new OAuthError("Not an OAuth account", "permanent", "account_failed");
    }
  } catch (err) {
    if (err instanceof OAuthError) {
      if (err.kind === "permanent") await markReauthorizationRequired(account, err.code, deps);
      else await markDegraded(account, err.code);
    }
    throw err;
  }
  const sealed = sealTokens(account.id, t);
  const { count } = await systemDb.emailOAuthCredential.updateMany({
    where: { id: cred.id, workspaceId: account.workspaceId, credentialVersion: cred.credentialVersion },
    data: {
      accessTokenEnc: sealed.accessTokenEnc,
      tokenExpiresAt: sealed.tokenExpiresAt,
      // Rotated: store the new one. Absent: keep the one we have.
      ...(sealed.refreshTokenEnc ? { refreshTokenEnc: sealed.refreshTokenEnc } : {}),
      encryptionKeyVersion: sealed.encryptionKeyVersion,
      credentialVersion: { increment: 1 },
      lastRefreshedAt: new Date(),
    },
  });
  if (count === 0) {
    // Lost a race we shouldn't be able to lose while holding the lock (it expired mid-refresh).
    // Our token still works for this send; the stored credentials belong to whoever won.
    logger.warn({ accountId: account.id }, "email token refresh lost a compare-and-set; keeping the stored credentials");
  }
  await systemDb.emailAccount.updateMany({
    where: { id: account.id, workspaceId: account.workspaceId, status: { in: ["degraded", "pending", "testing"] } },
    data: { status: "connected", statusReason: null },
  });
  return t.accessToken;
}

/** The account's grant is dead: say so once, tell the admins, and stop using it. */
export async function markReauthorizationRequired(account: AccountRef, reason: string, deps: Pick<EmailDeps, "mailer" | "fetchImpl">) {
  const { count } = await systemDb.emailAccount.updateMany({
    where: { id: account.id, workspaceId: account.workspaceId, status: { notIn: ["reauthorization_required", "revoked", "disabled"] }, deletedAt: null },
    data: { status: "reauthorization_required", statusReason: reason, lastErrorCode: reason, lastErrorAt: new Date() },
  });
  if (!count) return;
  logger.warn({ accountId: account.id, reason }, "email account needs reauthorization");
  await emailAudit({ workspaceId: account.workspaceId, action: "email.account.reauthorization_required", targetType: "email_account", targetId: account.id, metadata: { reason } });
  // The app shows this message as is (@app/shared/alerts): keep error text out of it.
  await raiseAlert(
    {
      workspaceId: account.workspaceId,
      severity: "warning",
      code: `email_account_reauth:${account.id}`,
      message: `The email account ${account.emailAddress} must be reconnected before it can send again (Settings → Email → Accounts).`,
    },
    deps.mailer,
    deps.fetchImpl,
  ).catch((err: unknown) => logger.warn({ err, accountId: account.id }, "couldn't raise the reconnect alert"));
}

export async function markDegraded(account: AccountRef, reason: string) {
  await systemDb.emailAccount.updateMany({
    where: { id: account.id, workspaceId: account.workspaceId, status: { in: ["connected", "pending", "testing"] } },
    data: { status: "degraded", statusReason: reason, lastErrorCode: reason, lastErrorAt: new Date() },
  });
}

/**
 * Take back the access bizinsights was given, as far as the provider allows: Google revokes the grant;
 * Microsoft has no endpoint for one app's delegated grant (the person removes it at
 * myaccount.microsoft.com → Apps), so the tokens are only deleted here. Never throws: the caller
 * deletes the stored credentials either way.
 */
export async function revokeConnection(account: AccountRef, deps: Pick<EmailDeps, "fetchImpl">): Promise<"revoked" | "deleted_only" | "failed"> {
  if (account.connectionMethod !== "oauth_google") return "deleted_only";
  const cred = await loadCredential(account);
  const cfg = googleEmailConfig(deps.fetchImpl);
  if (!cred || !cfg) return "deleted_only";
  try {
    await googleEmailRevoke(cfg, open(cred.refreshTokenEnc, AAD.oauthRefresh(account.id)));
    return "revoked";
  } catch (err) {
    logger.warn({ err, accountId: account.id }, "google revoke failed; the stored tokens are deleted anyway");
    return "failed";
  }
}

/** What Settings shows about an account's connection (getConnectionHealth). Never a token. */
export async function getConnectionHealth(account: Pick<EmailAccount, "id" | "workspaceId" | "status" | "statusReason" | "lastVerifiedAt" | "lastSuccessfulSendAt" | "lastErrorCode" | "lastErrorAt" | "connectionMethod">) {
  const cred = account.connectionMethod === "smtp" ? null : await loadCredential(account);
  return {
    status: account.status,
    reason: account.statusReason,
    lastVerifiedAt: account.lastVerifiedAt,
    lastSuccessfulSendAt: account.lastSuccessfulSendAt,
    lastErrorCode: account.lastErrorCode,
    lastErrorAt: account.lastErrorAt,
    accessTokenExpiresAt: cred?.tokenExpiresAt ?? null,
    lastRefreshedAt: cred?.lastRefreshedAt ?? null,
  };
}

/** Re-wrap every email credential under the active key (after adding a KEK). Returns rows rewritten. */
export async function reencryptEmailCredentials(): Promise<number> {
  const { rewrap, needsRewrap } = await import("./vault.js");
  const active = credentialKeyring().active;
  let n = 0;
  for (const c of await systemDb.emailOAuthCredential.findMany({ where: { NOT: { encryptionKeyVersion: active } } })) {
    await systemDb.emailOAuthCredential.update({
      where: { id: c.id },
      data: {
        refreshTokenEnc: needsRewrap(c.refreshTokenEnc) ? rewrap(c.refreshTokenEnc, AAD.oauthRefresh(c.emailAccountId)) : c.refreshTokenEnc,
        accessTokenEnc: c.accessTokenEnc && needsRewrap(c.accessTokenEnc) ? rewrap(c.accessTokenEnc, AAD.oauthAccess(c.emailAccountId)) : c.accessTokenEnc,
        encryptionKeyVersion: active,
      },
    });
    n++;
  }
  for (const c of await systemDb.emailSmtpCredential.findMany({ where: { NOT: { encryptionKeyVersion: active } } })) {
    await systemDb.emailSmtpCredential.update({ where: { id: c.id }, data: { secretEnc: rewrap(c.secretEnc, AAD.smtpPassword(c.emailAccountId)), encryptionKeyVersion: active } });
    n++;
  }
  // Sealed values without a key-version column: found by their `env1.<version>.` prefix.
  const current = `env1.${active}.`;
  for (const d of await systemDb.emailDomain.findMany({ where: { NOT: { verificationTokenEnc: { startsWith: current } } } })) {
    await systemDb.emailDomain.update({ where: { id: d.id }, data: { verificationTokenEnc: rewrap(d.verificationTokenEnc, AAD.domainToken(d.workspaceId, d.domain)) } });
    n++;
  }
  for (;;) {
    const rows = await systemDb.emailBusinessEvent.findMany({ where: { payloadEnc: { not: null }, NOT: { payloadEnc: { startsWith: current } } }, take: 500 });
    if (!rows.length) break;
    for (const e of rows) {
      await systemDb.emailBusinessEvent.update({ where: { id: e.id }, data: { payloadEnc: rewrap(e.payloadEnc!, AAD.eventPayload(e.workspaceId, e.source, e.externalId)) } });
      n++;
    }
  }
  for (;;) {
    const rows = await systemDb.emailMessage.findMany({ where: { NOT: { recipientEnc: { startsWith: current } } }, select: { id: true, workspaceId: true, recipientEnc: true }, take: 500 });
    if (!rows.length) break;
    for (const m of rows) {
      await systemDb.emailMessage.update({ where: { id: m.id }, data: { recipientEnc: rewrap(m.recipientEnc, AAD.recipient(m.workspaceId)) } });
      n++;
    }
  }
  return n;
}
