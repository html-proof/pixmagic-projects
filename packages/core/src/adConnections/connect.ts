/**
 * Connecting and disconnecting: the sign-in's tokens wait while the person picks accounts, the chosen
 * accounts become connections, and access is taken back only when no other connection relies on it.
 */
import { systemDb, type AdConnection } from "@app/db";
import { decrypt, type AdProvider } from "@app/shared";
import { googleRevoke, metaRevokeAdsRead, type AdAccount, type TokenSet } from "../ads.js";
import type { Coord } from "../coord.js";
import { logger } from "../logger.js";
import type { FetchLike } from "../shopify.js";
import { keyring } from "../tokens.js";
import { metaConfig } from "./config.js";
import { aad, encryptAdTokens } from "./credentials.js";

export const ADS_PENDING_TTL_S = 900;

export interface PendingAdConnect {
  userId: string;
  workspaceId: string;
  storeId: string;
  provider: AdProvider;
  accounts: AdAccount[];
  /** Encrypted exactly as a connection stores them (same AAD), so they can't move to another store. */
  accessTokenEnc: string;
  refreshTokenEnc: string | null;
  accessTokenExpiresAt: string | null;
  /** The permissions granted, and who granted them (both stored with the connection). */
  grantedScopes?: string[];
  externalUserId?: string | null;
  /** Epoch ms after which the choice is gone. */
  expiresAt: number;
}

const pendingKey = (nonce: string) => `ads-pending:${nonce}`;

export async function holdPendingAdConnect(
  coord: Coord,
  nonce: string,
  input: { userId: string; workspaceId: string; storeId: string; provider: AdProvider; accounts: AdAccount[]; tokens: TokenSet; externalUserId?: string | null },
) {
  const enc = encryptAdTokens(input.storeId, input.provider, input.tokens);
  const pending: PendingAdConnect = {
    userId: input.userId,
    workspaceId: input.workspaceId,
    storeId: input.storeId,
    provider: input.provider,
    accounts: input.accounts,
    accessTokenEnc: enc.accessTokenEnc,
    refreshTokenEnc: enc.refreshTokenEnc,
    accessTokenExpiresAt: input.tokens.expiresAt ? input.tokens.expiresAt.toISOString() : null,
    grantedScopes: input.tokens.grantedScopes,
    externalUserId: input.externalUserId ?? null,
    expiresAt: Date.now() + ADS_PENDING_TTL_S * 1000,
  };
  await coord.put(pendingKey(nonce), JSON.stringify(pending), ADS_PENDING_TTL_S);
}

/** Read a pending choice without using it up. */
export async function peekPendingAdConnect(coord: Coord, nonce: string): Promise<PendingAdConnect | null> {
  const raw = await coord.peek(pendingKey(nonce));
  if (!raw) return null;
  const p = JSON.parse(raw) as PendingAdConnect;
  return p.expiresAt > Date.now() ? p : null;
}

/** Use a pending choice up: it can be confirmed (or cancelled) once. */
export async function takePendingAdConnect(coord: Coord, nonce: string): Promise<PendingAdConnect | null> {
  const raw = await coord.take(pendingKey(nonce));
  if (!raw) return null;
  const p = JSON.parse(raw) as PendingAdConnect;
  return p.expiresAt > Date.now() ? p : null;
}

/** The sign-in's tokens back from a pending choice. */
export function pendingTokens(p: PendingAdConnect): TokenSet {
  const k = keyring();
  return {
    accessToken: decrypt(p.accessTokenEnc, k, aad(p.storeId, p.provider, "access")),
    refreshToken: p.refreshTokenEnc ? decrypt(p.refreshTokenEnc, k, aad(p.storeId, p.provider, "refresh")) : null,
    expiresAt: p.accessTokenExpiresAt ? new Date(p.accessTokenExpiresAt) : null,
    grantedScopes: p.grantedScopes,
  };
}

/**
 * Save the ad accounts someone just connected. New accounts start enabled; accounts connected
 * before get the new token and come back from "reconnect" / "error", keeping their on/off choice.
 */
export async function saveAdConnections(input: {
  workspaceId: string;
  storeId: string;
  provider: AdProvider;
  accounts: AdAccount[];
  tokens: TokenSet;
  userId: string | null;
  /** The platform's id for the person who signed in (see externalUserId on the model). */
  externalUserId?: string | null;
}): Promise<Array<AdConnection & { isNew: boolean }>> {
  const tokens = {
    ...encryptAdTokens(input.storeId, input.provider, input.tokens),
    // Who granted it belongs to the token stored next to it: an unknown signer never inherits the previous one
    // (a disconnect then answers "unknown_person" instead of revoking someone else's grant).
    externalUserId: input.externalUserId ?? null,
    grantedScopes: (input.tokens.grantedScopes ?? []).slice(0, 50),
  };
  const out: Array<AdConnection & { isNew: boolean }> = [];
  for (const a of input.accounts) {
    const where = { storeId_provider_accountId: { storeId: input.storeId, provider: input.provider, accountId: a.accountId } };
    const before = await systemDb.adConnection.findUnique({ where, select: { id: true } });
    const row = await systemDb.adConnection.upsert({
      where,
      create: {
        workspaceId: input.workspaceId,
        storeId: input.storeId,
        provider: input.provider,
        accountId: a.accountId,
        accountName: a.name,
        currency: a.currency,
        timezone: a.timezone,
        loginCustomerId: a.loginCustomerId ?? null,
        connectedByUserId: input.userId,
        ...tokens,
      },
      update: {
        accountName: a.name,
        // AdSense accounts don't say their currency when listed (the sync learns it): keep what's known.
        ...(a.currency ? { currency: a.currency } : {}),
        timezone: a.timezone,
        loginCustomerId: a.loginCustomerId ?? null,
        connectedByUserId: input.userId,
        status: "active",
        lastError: null,
        ...tokens,
      },
    });
    out.push({ ...row, isNew: !before });
  }
  return out;
}

/** Google Ads and AdSense sign in through one Google client, so one person's grant covers both. */
const grantFamily = (provider: string): AdProvider[] => (provider === "meta" ? ["meta"] : ["google", "adsense"]);

/**
 * A refresh token this person already gave bizinsights, for a sign-in where Google didn't send a new
 * one (it only does on first consent). Taken from another of their connections on the same platform.
 */
export async function reusableRefreshToken(provider: AdProvider, externalUserId: string | null): Promise<string | null> {
  if (provider === "meta" || !externalUserId) return null;
  const row = await systemDb.adConnection.findFirst({
    where: { provider, externalUserId, refreshTokenEnc: { not: null }, status: { not: "reconnect" } },
    orderBy: { updatedAt: "desc" },
  });
  if (!row?.refreshTokenEnc) return null;
  return decrypt(row.refreshTokenEnc, keyring(), aad(row.storeId, row.provider, "refresh"));
}

export type RevokeOutcome = "revoked" | "still_used" | "unknown_person" | "not_configured" | "failed";

/**
 * After a disconnect: take back the platform access too, unless another connection still relies
 * on the same person's grant (another store, or AdSense next to Google Ads). Google revokes the
 * person's whole grant to bizinsights' client; Meta drops only ads_read (WhatsApp keeps working).
 * Best effort: the connection is already gone whatever the platform answers.
 */
export async function revokeAdAccessIfUnused(conn: AdConnection, fetchImpl?: FetchLike): Promise<RevokeOutcome> {
  if (!conn.externalUserId) return "unknown_person";
  const k = keyring();
  try {
    // Any connection on the same grant (Google Ads and AdSense share one), anywhere, by this person, or by
    // a person bizinsights doesn't know yet (connected before identities were kept, or their lookup failed),
    // keeps it. Those unknown rows learn their person at their next token refresh.
    const others = await systemDb.adConnection.count({
      where: { provider: { in: grantFamily(conn.provider) }, NOT: { id: conn.id }, OR: [{ externalUserId: conn.externalUserId }, { externalUserId: null }] },
    });
    if (others > 0) return "still_used";
    if (conn.provider === "meta") {
      const cfg = metaConfig(fetchImpl);
      if (!cfg) return "not_configured";
      await metaRevokeAdsRead(cfg, decrypt(conn.accessTokenEnc, k, aad(conn.storeId, conn.provider, "access")));
    } else {
      // Revoking the refresh token ends its access tokens too.
      const token = conn.refreshTokenEnc ? decrypt(conn.refreshTokenEnc, k, aad(conn.storeId, conn.provider, "refresh")) : decrypt(conn.accessTokenEnc, k, aad(conn.storeId, conn.provider, "access"));
      await googleRevoke({ fetchImpl }, token);
    }
    return "revoked";
  } catch (err) {
    logger.warn({ err, connectionId: conn.id, provider: conn.provider }, "ad access revoke failed");
    return "failed";
  }
}
