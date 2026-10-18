/** A connection's tokens: encrypted at rest, refreshed when they expire, re-encrypted on key rotation. */
import { systemDb, type AdConnection } from "@app/db";
import { decrypt, encrypt, keyVersionOf, type AdProvider } from "@app/shared";
import { AdsApiError, AdsAuthError, googleRefresh, googleUserId, type TokenSet } from "../ads.js";
import { logger } from "../logger.js";
import type { FetchLike } from "../shopify.js";
import { keyring } from "../tokens.js";
import { AD_PROVIDER_NAME, adsenseConfig, googleConfig } from "./config.js";

/** Binds a ciphertext to its store and platform, so it can't be moved to another store's row. */
export const aad = (storeId: string, provider: string, kind: "access" | "refresh") => `ads:${provider}:${storeId}:${kind}`;

export function encryptAdTokens(storeId: string, provider: AdProvider, t: TokenSet) {
  const k = keyring();
  const accessTokenEnc = encrypt(t.accessToken, k, aad(storeId, provider, "access"));
  return {
    accessTokenEnc,
    refreshTokenEnc: t.refreshToken ? encrypt(t.refreshToken, k, aad(storeId, provider, "refresh")) : null,
    accessTokenExpiresAt: t.expiresAt,
    tokenKeyVersion: keyVersionOf(accessTokenEnc),
  };
}

/**
 * A usable access token for this ad account. Google's (Google Ads and AdSense) last an hour, so a
 * fresh one is minted from the stored refresh token when needed; Meta's last about 60 days and
 * can't be renewed without the person signing in again, so an expired one means "reconnect".
 */
export async function adAccessToken(conn: AdConnection, fetchImpl?: FetchLike): Promise<string> {
  const k = keyring();
  const soon = Date.now() + 5 * 60_000;
  const access = () => decrypt(conn.accessTokenEnc, k, aad(conn.storeId, conn.provider, "access"));
  if (conn.provider === "meta") {
    if (conn.accessTokenExpiresAt && conn.accessTokenExpiresAt.getTime() < Date.now()) throw new AdsAuthError("Meta access has expired");
    return access();
  }
  if (!conn.accessTokenExpiresAt || conn.accessTokenExpiresAt.getTime() > soon) return access();
  const provider = conn.provider as AdProvider;
  const cfg = provider === "adsense" ? adsenseConfig(fetchImpl) : googleConfig(fetchImpl);
  if (!cfg) throw new AdsApiError(`${AD_PROVIDER_NAME[provider] ?? "Google"} isn't set up on this server`, 503);
  if (!conn.refreshTokenEnc) throw new AdsAuthError("Google access has no refresh token");
  const fresh = await googleRefresh(cfg, decrypt(conn.refreshTokenEnc, k, aad(conn.storeId, conn.provider, "refresh")));
  const enc = encryptAdTokens(conn.storeId, provider, fresh);
  // Every account connected in the same sign-in shares the token: keep them all on the new one.
  // A refresh token Google replaced must be stored, or the next refresh fails.
  const data = {
    accessTokenEnc: enc.accessTokenEnc,
    accessTokenExpiresAt: enc.accessTokenExpiresAt,
    tokenKeyVersion: enc.tokenKeyVersion,
    ...(fresh.rotated ? { refreshTokenEnc: enc.refreshTokenEnc } : {}),
  };
  await systemDb.adConnection.updateMany({ where: fresh.rotated ? { storeId: conn.storeId, provider: conn.provider, refreshTokenEnc: conn.refreshTokenEnc } : { id: conn.id }, data });
  // Connected before bizinsights kept who granted access: learn it now, so a later disconnect can tell
  // whether this grant is shared. Never fails the refresh.
  if (!conn.externalUserId) {
    const sub = await googleUserId(cfg, fresh.accessToken).catch(() => null);
    if (sub) await systemDb.adConnection.update({ where: { id: conn.id }, data: { externalUserId: sub } }).catch(() => undefined);
  }
  return fresh.accessToken;
}

/** Re-encrypt ad tokens with the active key (part of key rotation, see reencryptAllTokens). */
export async function reencryptAdTokens(): Promise<number> {
  const k = keyring();
  const rows = await systemDb.adConnection.findMany({ where: { NOT: { tokenKeyVersion: k.active } } });
  for (const c of rows) {
    const access = decrypt(c.accessTokenEnc, k, aad(c.storeId, c.provider, "access"));
    const refresh = c.refreshTokenEnc ? decrypt(c.refreshTokenEnc, k, aad(c.storeId, c.provider, "refresh")) : null;
    await systemDb.adConnection.update({
      where: { id: c.id },
      data: {
        accessTokenEnc: encrypt(access, k, aad(c.storeId, c.provider, "access")),
        refreshTokenEnc: refresh ? encrypt(refresh, k, aad(c.storeId, c.provider, "refresh")) : null,
        tokenKeyVersion: k.active,
      },
    });
  }
  if (rows.length) logger.info({ count: rows.length }, "ad tokens re-encrypted");
  return rows.length;
}
