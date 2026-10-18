import { systemDb, type Store } from "@app/db";
import { decrypt, encrypt, keyVersionOf, parseKeyring, type Keyring } from "@app/shared";
import { env } from "./env.js";
import { shopifyApp } from "./apps.js";
import { exchangeForExpiringToken, refreshAccessToken, ShopifyHttpError, type FetchLike, type TokenResponse } from "./shopify.js";
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
 * One process at a time gets, rotates or trades a store's token. Shopify retires the refresh token
 * before each new one it hands out, so two at once leave the row holding a dead one.
 */
const tokenLock = (storeId: string) => `lock:token-refresh:${storeId}`;
const LOCK_TTL_MS = 30_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** True when the row's access token is good for at least `ms` more; a non-expiring one always is. */
const validFor = (row: Pick<Store, "accessTokenExpiresAt">, ms: number) =>
  !row.accessTokenExpiresAt || row.accessTokenExpiresAt.getTime() - Date.now() > ms;

/** Worded so the dashboard reads it as lost access (syncProblem) and offers Reconnect. */
const refused = (shop: string, why: string) =>
  new StoreDisconnectedError(`Shopify rejected our access to ${shop} (${why}); merchant must reconnect`);

/** The store's row, or StoreDisconnectedError when it holds no token. */
async function connectedRow(storeId: string) {
  const row = await systemDb.store.findUniqueOrThrow({ where: { id: storeId } });
  if (row.status === "uninstalled" || !row.accessTokenEnc) {
    throw new StoreDisconnectedError(`Store ${row.shopDomain} is not connected`);
  }
  return { ...row, accessTokenEnc: row.accessTokenEnc };
}
type ConnectedRow = Awaited<ReturnType<typeof connectedRow>>;

const accessOf = (row: ConnectedRow) => decrypt(row.accessTokenEnc, keyring(), aad(row.id, "access"));
const credentialsOf = (row: Pick<Store, "shopifyAppKey">) => {
  // Tokens belong to the app the store connected through: refresh and trade with that app's credentials.
  const app = shopifyApp(row.shopifyAppKey);
  return { apiKey: app.clientId, apiSecret: app.clientSecret };
};

/**
 * Returns a valid access token for the store, rotating it first when it is about to expire (an
 * expiring offline token lives an hour). A store still on a non-expiring token gets that token:
 * `migrateToExpiringToken` moves it, from the worker's sweep.
 */
export async function getAccessToken(
  store: Pick<Store, "id" | "shopDomain" | "status">,
  coord: Coord,
  fetchImpl: FetchLike = fetch,
  minValidityMs = REFRESH_SKEW_MS,
): Promise<string> {
  const fresh = await connectedRow(store.id);
  if (validFor(fresh, minValidityMs)) return accessOf(fresh);

  const lockKey = tokenLock(fresh.id);
  const got = await coord.acquire(lockKey, LOCK_TTL_MS);
  if (!got) {
    // Another worker is rotating; wait briefly and re-read.
    await sleep(1500);
    return getAccessToken(store, coord, fetchImpl, minValidityMs);
  }
  try {
    return await rotate(store.id, fetchImpl, minValidityMs);
  } finally {
    await coord.release(lockKey);
  }
}

/** The refresh itself, under the store's token lock. */
async function rotate(storeId: string, fetchImpl: FetchLike, minValidityMs: number): Promise<string> {
  let row = await connectedRow(storeId);
  for (let attempt = 0; ; attempt++) {
    if (validFor(row, minValidityMs)) return accessOf(row);
    if (!row.refreshTokenEnc) throw refused(row.shopDomain, "no refresh token");
    const presented = row.refreshTokenEnc;
    let t: TokenResponse;
    try {
      t = await refreshAccessToken(credentialsOf(row), row.shopDomain, decrypt(presented, keyring(), aad(row.id, "refresh")), fetchImpl);
    } catch (err) {
      // The row got another token meanwhile (a reconnect, or key rotation sealing it again):
      // that one is what Shopify honours now.
      const now = await connectedRow(storeId);
      if (now.refreshTokenEnc !== presented && attempt < 2) {
        row = now;
        continue;
      }
      if (err instanceof ShopifyHttpError && err.status === 401) throw refused(row.shopDomain, "refresh token refused");
      // Shopify or the network having a moment: the token held still works until it expires, and
      // Shopify takes the same refresh token again next time.
      if (validFor(row, 0)) {
        logger.warn({ err, storeId }, "shopify token refresh failed; using the current token until it expires");
        return accessOf(row);
      }
      throw err;
    }
    // Only over the token this refresh replaced: a row that took a newer one meanwhile keeps it.
    const { count } = await systemDb.store.updateMany({
      where: { id: row.id, refreshTokenEnc: presented },
      // Keep previously granted scopes if the refresh response omits them.
      data: { ...encryptTokenFields(row.id, t), grantedScopes: t.scopes.length ? t.scopes : row.grantedScopes },
    });
    if (count) logger.info({ storeId }, "rotated shopify access token");
    else logger.warn({ storeId }, "store's token was replaced while it was refreshed; the replacement stays");
    // Fresh from Shopify either way, so good for this call.
    return t.accessToken;
  }
}

/**
 * Move a store still on a non-expiring offline token to an expiring one. Shopify flags every use
 * of a non-expiring token ("Deprecated offline token" in the Dev Dashboard's API health) and stops
 * accepting them on 2027-01-01. No merchant is involved: Shopify trades the old token for the new
 * pair. Returns true when the store moved, false when there was nothing to move (already expiring,
 * not connected) or another process holds its token; throws when Shopify refused, and the store
 * then keeps its old token, which works until Shopify's deadline.
 */
export async function migrateToExpiringToken(store: Pick<Store, "id">, coord: Coord, fetchImpl: FetchLike = fetch): Promise<boolean> {
  const lockKey = tokenLock(store.id);
  if (!(await coord.acquire(lockKey, LOCK_TTL_MS))) return false;
  try {
    const row = await connectedRow(store.id);
    if (row.accessTokenExpiresAt) return false;
    const t = await exchangeForExpiringToken(credentialsOf(row), row.shopDomain, accessOf(row), fetchImpl);
    if (!t.accessTokenExpiresAt || !t.refreshToken) throw new Error("Shopify answered the token exchange without an expiring token");
    // The old token no longer works for GraphQL, so this write is what keeps the store connected. One
    // that misses (the row changed meanwhile) leaves the old token in place, and asking again within
    // 7 days gets the same pair back.
    const { count } = await systemDb.store.updateMany({
      where: { id: row.id, accessTokenEnc: row.accessTokenEnc },
      data: { ...encryptTokenFields(row.id, t), grantedScopes: t.scopes.length ? t.scopes : row.grantedScopes },
    });
    if (count) logger.info({ storeId: row.id, shop: row.shopDomain }, "moved store to an expiring shopify token");
    return count > 0;
  } finally {
    await coord.release(lockKey);
  }
}

/** Shopify's 403 for a non-expiring token once it no longer takes them. */
const NON_EXPIRING_REFUSED = /non-expiring access tokens/i;

/**
 * Run `call` with the store's access token. A 401/403 may only mean the token was swapped under
 * the caller (moved to an expiring one, which retires the old at once, or reconnected), so `call`
 * runs once more when the store holds a different token by then. A refusal of a non-expiring token
 * as such moves the store to an expiring one first.
 */
export async function withAccessToken<T>(
  store: Pick<Store, "id" | "shopDomain" | "status">,
  coord: Coord,
  fetchImpl: FetchLike,
  call: (accessToken: string) => Promise<T>,
): Promise<T> {
  const token = await getAccessToken(store, coord, fetchImpl);
  try {
    return await call(token);
  } catch (err) {
    if (!(err instanceof ShopifyHttpError) || (err.status !== 401 && err.status !== 403)) throw err;
    if (NON_EXPIRING_REFUSED.test(err.message)) {
      await migrateToExpiringToken(store, coord, fetchImpl).catch((e: unknown) => logger.warn({ err: e, storeId: store.id }, "store not moved to an expiring shopify token"));
    }
    const now = await getAccessToken(store, coord, fetchImpl);
    if (now === token) throw err;
    return call(now);
  }
}

/** Wait (a little) for the store's token lock; false when it never came free. */
async function waitForLock(coord: Coord, key: string): Promise<boolean> {
  for (let i = 0; i < 20; i++) {
    if (await coord.acquire(key, LOCK_TTL_MS)) return true;
    await sleep(500);
  }
  return false;
}

/**
 * Get a new token for `shop` through app `appKey` (`obtain`: the authorization-code exchange) and,
 * when the shop's row holds a token from that app, put the new one on the row at once. Shopify
 * retires every refresh token it gave the app for the shop as soon as it hands out a new token, so
 * the row's own is dead from then on: a flow that ends without attaching the new one (scopes
 * missing, store connected elsewhere, a blip) must not leave the store on it. The row's token lock
 * is held throughout, so no refresh or trade lands in between to undo the swap.
 */
export async function obtainStoreToken(
  shop: string,
  appKey: string,
  coord: Coord,
  obtain: () => Promise<TokenResponse>,
): Promise<TokenResponse> {
  const row = await systemDb.store.findUnique({ where: { shopDomain: shop } });
  if (!row?.accessTokenEnc || row.status === "uninstalled" || shopifyApp(row.shopifyAppKey).key !== appKey) return obtain();
  const lockKey = tokenLock(row.id);
  const locked = await waitForLock(coord, lockKey);
  try {
    const t = await obtain();
    await systemDb.store.update({ where: { id: row.id }, data: encryptTokenFields(row.id, t) });
    return t;
  } finally {
    if (locked) await coord.release(lockKey);
  }
}

/**
 * Re-encrypt the stores' Shopify tokens with the active key; part of key rotation
 * (reencryptAllTokens in keyRotation.ts). Returns the number of stores rewritten.
 */
export async function reencryptStoreTokens(): Promise<number> {
  const k = keyring();
  const stores = await systemDb.store.findMany({
    where: { accessTokenEnc: { not: null }, NOT: { tokenKeyVersion: k.active } },
  });
  let rewritten = 0;
  for (const s of stores) {
    const access = decrypt(s.accessTokenEnc!, k, aad(s.id, "access"));
    const refresh = s.refreshTokenEnc ? decrypt(s.refreshTokenEnc, k, aad(s.id, "refresh")) : null;
    // Only over the ciphertexts read: a token rotated meanwhile is already sealed with the active
    // key, and writing the old one back would put the store on a retired refresh token.
    const { count } = await systemDb.store.updateMany({
      where: { id: s.id, accessTokenEnc: s.accessTokenEnc, refreshTokenEnc: s.refreshTokenEnc },
      data: {
        accessTokenEnc: encrypt(access, k, aad(s.id, "access")),
        refreshTokenEnc: refresh ? encrypt(refresh, k, aad(s.id, "refresh")) : null,
        tokenKeyVersion: k.active,
      },
    });
    rewritten += count;
  }
  return rewritten;
}
