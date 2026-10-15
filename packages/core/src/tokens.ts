import { systemDb, type Store } from "@app/db";
import { decrypt, encrypt, keyVersionOf, parseKeyring, type Keyring } from "@app/shared";
import { env } from "./env.js";
import { shopifyApp } from "./apps.js";
import { refreshAccessToken, type FetchLike, type TokenResponse } from "./shopify.js";
import { logger } from "./logger.js";
import type { Coord } from "./coord.js";

let ring: { spec: string; keys: Keyring } | undefined;
export function keyring(): Keyring {
  // Parsed once per key list (env() is cached, so in a deployment that is once).
  const spec = env().TOKEN_ENCRYPTION_KEYS;
  if (ring?.spec !== spec) ring = { spec, keys: parseKeyring(spec) };
  return ring.keys;
}

/** AAD binds each ciphertext to its store, so ciphertexts can't be swapped between rows. */
const aad = (storeId: string, kind: "access" | "refresh") => `${storeId}:${kind}`;

export function encryptTokenFields(storeId: string, t: TokenResponse) {
  const k = keyring();
  const accessTokenEnc = encrypt(t.accessToken, k, aad(storeId, "access"));
  return {
    accessTokenEnc,
    refreshTokenEnc: t.refreshToken ? encrypt(t.refreshToken, k, aad(storeId, "refresh")) : null,
    accessTokenExpiresAt: t.accessTokenExpiresAt,
    refreshTokenExpiresAt: t.refreshTokenExpiresAt,
    tokenKeyVersion: keyVersionOf(accessTokenEnc),
    grantedScopes: t.scopes,
  };
}

export class StoreDisconnectedError extends Error {}

const REFRESH_SKEW_MS = 5 * 60 * 1000;

/**
 * Returns a valid access token for the store, rotating it first when it is
 * about to expire. A coordinator lock ensures only one process rotates at a time
 * (Shopify invalidates the old refresh token on use).
 */
export async function getAccessToken(
  store: Pick<Store, "id" | "shopDomain" | "status">,
  coord: Coord,
  fetchImpl: FetchLike = fetch,
  minValidityMs = REFRESH_SKEW_MS,
): Promise<string> {
  const fresh = await systemDb.store.findUniqueOrThrow({ where: { id: store.id } });
  if (fresh.status === "uninstalled" || !fresh.accessTokenEnc) {
    throw new StoreDisconnectedError(`Store ${fresh.shopDomain} is not connected`);
  }
  const k = keyring();
  const notExpiring =
    !fresh.accessTokenExpiresAt || fresh.accessTokenExpiresAt.getTime() - Date.now() > minValidityMs;
  if (notExpiring) return decrypt(fresh.accessTokenEnc, k, aad(fresh.id, "access"));

  const lockKey = `lock:token-refresh:${fresh.id}`;
  const got = await coord.acquire(lockKey, 30_000);
  if (!got) {
    // Another worker is rotating; wait briefly and re-read.
    await new Promise((r) => setTimeout(r, 1500));
    return getAccessToken(store, coord, fetchImpl, minValidityMs);
  }
  try {
    const again = await systemDb.store.findUniqueOrThrow({ where: { id: store.id } });
    if (again.accessTokenExpiresAt && again.accessTokenExpiresAt.getTime() - Date.now() > minValidityMs) {
      return decrypt(again.accessTokenEnc!, k, aad(again.id, "access"));
    }
    if (!again.refreshTokenEnc) throw new StoreDisconnectedError("No refresh token; merchant must reconnect");
    const refreshToken = decrypt(again.refreshTokenEnc, k, aad(again.id, "refresh"));
    // Tokens belong to the app the store connected through: refresh with that app's credentials.
    const app = shopifyApp(again.shopifyAppKey);
    const t = await refreshAccessToken(
      { apiKey: app.clientId, apiSecret: app.clientSecret },
      again.shopDomain,
      refreshToken,
      fetchImpl,
    );
    const fields = encryptTokenFields(again.id, t);
    await systemDb.store.update({
      where: { id: again.id },
      // Keep previously granted scopes if the refresh response omits them.
      data: { ...fields, grantedScopes: t.scopes.length ? t.scopes : again.grantedScopes },
    });
    logger.info({ storeId: again.id }, "rotated shopify access token");
    return t.accessToken;
  } finally {
    await coord.release(lockKey);
  }
}

/**
 * Re-encrypt everything stored under this keyring with the active key (run after adding a new
 * key, and before removing the old one): store tokens, ad tokens and WhatsApp data. Returns the
 * number of rows rewritten; 0 means nothing still needs an old key.
 */
export async function reencryptAllTokens(): Promise<number> {
  const k = keyring();
  const stores = await systemDb.store.findMany({
    where: { accessTokenEnc: { not: null }, NOT: { tokenKeyVersion: k.active } },
  });
  for (const s of stores) {
    const access = decrypt(s.accessTokenEnc!, k, aad(s.id, "access"));
    const refresh = s.refreshTokenEnc ? decrypt(s.refreshTokenEnc, k, aad(s.id, "refresh")) : null;
    await systemDb.store.update({
      where: { id: s.id },
      data: {
        accessTokenEnc: encrypt(access, k, aad(s.id, "access")),
        refreshTokenEnc: refresh ? encrypt(refresh, k, aad(s.id, "refresh")) : null,
        tokenKeyVersion: k.active,
      },
    });
  }
  // Ad platform tokens and WhatsApp data use the same keyring (loaded lazily: both modules import
  // this one).
  const { reencryptAdTokens } = await import("./adConnections.js");
  const { reencryptWhatsappData } = await import("./whatsapp/store.js");
  // Email credentials are envelope encrypted under EMAIL_CREDENTIAL_KEYS (TOKEN_ENCRYPTION_KEYS when
  // that is empty): their data keys are re-wrapped with its active key.
  const { reencryptEmailCredentials } = await import("./email/tokens.js");
  return stores.length + (await reencryptAdTokens()) + (await reencryptWhatsappData()) + (await reencryptEmailCredentials());
}
