/** A connection's tokens: encrypted at rest, refreshed when they expire, re-encrypted on key rotation. */
import { systemDb, type AdConnection } from "@app/db";
import { decrypt, encrypt, keyVersionOf, type AdProvider } from "@app/shared";
import { AdsApiError, AdsAuthError, googleRefresh, googleUserId, metaUserId, REQUIRED_AD_SCOPE, type TokenSet } from "../ads.js";
import { logger } from "../logger.js";
import type { FetchLike } from "../shopify.js";
import { keyring } from "../tokens.js";
import { AD_PROVIDER_NAME, adsenseConfig, googleClient, metaConfig } from "./config.js";

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
 * Whether the row holds bizinsights' own sign-in with the platform (`source` "direct"), as every row
 * has since 2026-10-28, when the last connections signed in through a broker were moved onto
 * bizinsights' own tokens. One that didn't would hold no token of bizinsights': it is never read, and
 * waits for a reconnect, which makes it one (saveAdConnections). The column stays: every connect
 * writes it and every sync records it (ad_sync_runs.source; docs/database/schema.md).
 */
export const holdsOwnSignIn = (conn: Pick<AdConnection, "source">): boolean => conn.source === "direct";

/** The Google OAuth client a Google Ads or AdSense connection refreshes through. */
const googleOAuthFor = (provider: string, fetchImpl?: FetchLike) => (provider === "adsense" ? adsenseConfig(fetchImpl) : googleClient(fetchImpl));

/**
 * The rows that share this connection's sign-in: every account connected in one go is stored with the
 * same ciphertexts (the refresh token's for Google, the access token's for Meta), in its store.
 */
export function sameSignIn(conn: Pick<AdConnection, "storeId" | "provider" | "accessTokenEnc" | "refreshTokenEnc">) {
  return conn.refreshTokenEnc
    ? { storeId: conn.storeId, provider: conn.provider, refreshTokenEnc: conn.refreshTokenEnc }
    : { storeId: conn.storeId, provider: conn.provider, accessTokenEnc: conn.accessTokenEnc };
}

/**
 * A usable access token for this ad account. Google's (Google Ads and AdSense) last an hour, so a
 * fresh one is minted from the stored refresh token when needed; Meta's last about 60 days and
 * can't be renewed without the person signing in again, so an expired one means "reconnect".
 */
export async function adAccessToken(conn: AdConnection, fetchImpl?: FetchLike): Promise<string> {
  return (await accessTokenAndPerson(conn, fetchImpl)).token;
}

/**
 * adAccessToken, saying who granted the access when a refresh looked it up (`person`: the id, or null
 * when Google wouldn't say; absent when nothing was looked up), so callers don't ask twice.
 */
export async function accessTokenAndPerson(conn: AdConnection, fetchImpl?: FetchLike): Promise<{ token: string; person?: string | null }> {
  const k = keyring();
  const soon = Date.now() + 5 * 60_000;
  const access = () => decrypt(conn.accessTokenEnc, k, aad(conn.storeId, conn.provider, "access"));
  // Not a sign-in of bizinsights' own (holdsOwnSignIn): never read, Reconnect.
  if (!holdsOwnSignIn(conn)) throw new AdsAuthError("This connection holds no sign-in of bizinsights' own");
  if (conn.provider === "meta") {
    if (conn.accessTokenExpiresAt && conn.accessTokenExpiresAt.getTime() < Date.now()) throw new AdsAuthError("Meta access has expired");
    return { token: access() };
  }
  if (!conn.accessTokenExpiresAt || conn.accessTokenExpiresAt.getTime() > soon) return { token: access() };
  const provider = conn.provider as AdProvider;
  const cfg = googleOAuthFor(provider, fetchImpl);
  if (!cfg) throw new AdsApiError(`${AD_PROVIDER_NAME[provider] ?? "Google"} isn't set up on this server`, 503, undefined, "not_configured");
  if (!conn.refreshTokenEnc) throw new AdsAuthError("Google access has no refresh token");
  // A grant that no longer covers the reporting permission says so here ("scope_missing": connect
  // again with it ticked), instead of handing out a token every report then fails with.
  const fresh = await googleRefresh(cfg, decrypt(conn.refreshTokenEnc, k, aad(conn.storeId, conn.provider, "refresh")), { requiredScope: REQUIRED_AD_SCOPE[provider] });
  const enc = encryptAdTokens(conn.storeId, provider, fresh);
  // Every account connected in the same sign-in shares the token: keep them all on the new one, both
  // tokens sealed with the active key. Re-sealing the refresh token each time (not only when Google
  // replaced it) keeps tokenKeyVersion true for both, so key rotation can't leave one on a key that
  // is about to be removed; and keeping the rows' ciphertexts equal is how they are found together.
  await systemDb.adConnection.updateMany({
    where: { storeId: conn.storeId, provider: conn.provider, refreshTokenEnc: conn.refreshTokenEnc },
    data: { accessTokenEnc: enc.accessTokenEnc, accessTokenExpiresAt: enc.accessTokenExpiresAt, refreshTokenEnc: enc.refreshTokenEnc, tokenKeyVersion: enc.tokenKeyVersion },
  });
  // Connected before bizinsights kept who granted access: learn it now, so a later disconnect can tell
  // whether this grant is shared. Never fails the refresh.
  if (!conn.externalUserId) {
    const sub = await googleUserId(cfg, fresh.accessToken).catch(() => null);
    if (sub) await rememberPerson({ ...conn, refreshTokenEnc: enc.refreshTokenEnc }, sub).catch(() => undefined);
    return { token: fresh.accessToken, person: sub };
  }
  return { token: fresh.accessToken };
}

/** Store who granted a sign-in on every row of it that doesn't know yet. */
async function rememberPerson(conn: Pick<AdConnection, "storeId" | "provider" | "accessTokenEnc" | "refreshTokenEnc">, person: string) {
  await systemDb.adConnection.updateMany({ where: { ...sameSignIn(conn), externalUserId: null }, data: { externalUserId: person } });
}

/**
 * Who granted this connection's access (Google's `sub`, Meta's app-scoped user id), looked up with a
 * working access token and stored on every row of the same sign-in. Null when the platform doesn't
 * say; an AdsAuthError when the token no longer works.
 */
export async function learnAdPerson(conn: AdConnection, accessToken: string, fetchImpl?: FetchLike): Promise<string | null> {
  if (conn.externalUserId) return conn.externalUserId;
  const person = await platformPerson(conn.provider, accessToken, fetchImpl);
  if (person) await rememberPerson(conn, person);
  return person;
}

/**
 * Who an access token of bizinsights' own app belongs to: Meta's app-scoped user id, Google's `sub`
 * (Google also checks the token was issued to bizinsights' client: AdsAuthError when it wasn't). Null
 * when the platform doesn't say, or isn't set up here.
 */
export async function platformPerson(provider: string, accessToken: string, fetchImpl?: FetchLike): Promise<string | null> {
  if (provider === "meta") {
    const cfg = metaConfig(fetchImpl);
    return cfg ? metaUserId(cfg, accessToken) : null;
  }
  const cfg = googleOAuthFor(provider, fetchImpl);
  return cfg ? googleUserId(cfg, accessToken) : null;
}

/**
 * Re-encrypt ad tokens with the active key (part of key rotation, see reencryptAllTokens). A row is
 * picked by its ciphertexts, not tokenKeyVersion: either token can be the one left on an older key.
 * Each sign-in's rows are rewritten together and only over the ciphertexts read (compare-and-swap):
 * a refresh in between already sealed them with the active key, and writing the old token back would
 * undo it. Returns the rows rewritten; 0 means none still needs an older key.
 *
 * A sign-in sealed with a key that has been removed already (an older version left refresh tokens
 * behind) can't be read by anyone again: its tokens are deleted and its accounts wait for a reconnect,
 * which the merchant is told about; the run goes on. Any other token that can't be decrypted fails the
 * run at the end, since that may be a wrong key rather than a lost one.
 */
export async function reencryptAdTokens(): Promise<number> {
  const k = keyring();
  const current = `v${k.active}.`;
  // Sealed with a key version the keyring no longer has. (A malformed one names none: decrypting it fails the run.)
  const removedKey = (ciphertext: string | null) => {
    const v = ciphertext ? /^v(\d+)\./.exec(ciphertext)?.[1] : undefined;
    return v !== undefined && !k.keys.has(Number(v));
  };
  const rows = await systemDb.adConnection.findMany({
    where: {
      // Rows whose person left keep no token (releaseUserAdGrants).
      accessTokenEnc: { not: "" },
      OR: [{ NOT: { accessTokenEnc: { startsWith: current } } }, { AND: [{ refreshTokenEnc: { not: null } }, { NOT: { refreshTokenEnc: { startsWith: current } } }] }],
    },
  });
  const groups = new Map<string, AdConnection[]>();
  for (const c of rows) {
    const key = `${c.storeId}|${c.provider}|${c.refreshTokenEnc ?? c.accessTokenEnc}`;
    groups.set(key, [...(groups.get(key) ?? []), c]);
  }
  let rewritten = 0;
  let failed = 0;
  for (const group of groups.values()) {
    const first = group[0]!;
    // Only over the ciphertexts read (see above).
    const asRead = {
      id: { in: group.map((c) => c.id) },
      ...(first.refreshTokenEnc ? { refreshTokenEnc: first.refreshTokenEnc } : { refreshTokenEnc: null }),
      accessTokenEnc: { in: [...new Set(group.map((c) => c.accessTokenEnc))] },
    };
    // Accounts of one sign-in may hold different access tokens (each refreshed on its own before):
    // they all get the one that lasts longest, of those still readable.
    const usable = group.filter((c) => !removedKey(c.accessTokenEnc));
    if (removedKey(first.refreshTokenEnc) || !usable.length) {
      const { count } = await systemDb.adConnection.updateMany({
        where: asRead,
        data: { status: "reconnect", errorCode: "auth_expired", lastError: null, accessTokenEnc: "", refreshTokenEnc: null, accessTokenExpiresAt: null, syncRequestedAt: null },
      });
      logger.error(
        { connectionIds: group.map((c) => c.id), storeId: first.storeId, provider: first.provider },
        "ad tokens sealed with a removed key: deleted, the accounts wait for a reconnect",
      );
      rewritten += count;
      continue;
    }
    const freshest = usable.reduce((a, b) => ((b.accessTokenExpiresAt?.getTime() ?? 0) > (a.accessTokenExpiresAt?.getTime() ?? 0) ? b : a));
    try {
      const access = decrypt(freshest.accessTokenEnc, k, aad(first.storeId, first.provider, "access"));
      const refresh = first.refreshTokenEnc ? decrypt(first.refreshTokenEnc, k, aad(first.storeId, first.provider, "refresh")) : null;
      const { count } = await systemDb.adConnection.updateMany({
        where: asRead,
        data: {
          accessTokenEnc: encrypt(access, k, aad(first.storeId, first.provider, "access")),
          accessTokenExpiresAt: freshest.accessTokenExpiresAt,
          refreshTokenEnc: refresh ? encrypt(refresh, k, aad(first.storeId, first.provider, "refresh")) : null,
          tokenKeyVersion: k.active,
        },
      });
      rewritten += count;
    } catch (err) {
      // One unreadable sign-in must not stop the rest, but the run must not end in a 0 that says "done".
      logger.error({ err, connectionIds: group.map((c) => c.id) }, "ad tokens could not be re-encrypted");
      failed++;
    }
  }
  if (rewritten) logger.info({ count: rewritten }, "ad tokens re-encrypted");
  if (failed) throw new Error(`${failed} ad sign-in(s) could not be re-encrypted; ${rewritten} rows were`);
  return rewritten;
}
