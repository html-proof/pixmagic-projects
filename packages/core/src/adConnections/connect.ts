/**
 * Connecting and disconnecting: the sign-in's tokens wait while the person picks accounts, the chosen
 * accounts become connections, and access is taken back only when no other connection relies on it.
 */
import { systemDb, type AdConnection } from "@app/db";
import { decrypt, type AdProvider } from "@app/shared";
import { AdsAuthError, classifyAdError, googleRevoke, metaRevokeAdsRead, type AdAccount, type AdAccountList, type TokenSet } from "../ads.js";
import type { Coord } from "../coord.js";
import { fetchUntil } from "../http.js";
import { logger } from "../logger.js";
import type { FetchLike } from "../shopify.js";
import { keyring } from "../tokens.js";
import { resolveAdAlerts } from "./alerts.js";
import { metaConfig } from "./config.js";
import { aad, accessTokenAndPerson, encryptAdTokens, learnAdPerson, sameSignIn } from "./credentials.js";
import { recordAdFailure } from "./status.js";

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
  /** The platform's list was cut short (an agency login reaching more than one sign-in can list): the picker says so. */
  truncated?: boolean;
  /**
   * The refresh token is one this person gave before, taken from their other connections (Google sent
   * none): cancelling the choice must not revoke it (dropUnusedGrant's `reusedRefreshToken`).
   */
  reusedRefreshToken?: boolean;
  /** Epoch ms after which the choice is gone. */
  expiresAt: number;
}

const pendingKey = (nonce: string) => `ads-pending:${nonce}`;
/** Google Ads and AdSense sign in through one Google client, so one person's grant covers both. */
const grantFamily = (provider: string): AdProvider[] => (provider === "meta" ? ["meta"] : ["google", "adsense"]);
/** The choices one person has waiting, so dropping one grant can't pull the tokens out from under another. */
const personPendingKey = (provider: string, externalUserId: string) => `ads-pending-person:${provider === "meta" ? "meta" : "google"}:${externalUserId}`;

/**
 * Hold a sign-in's accounts and tokens while the person picks. Each account keeps what the platform
 * said about it (status, statusDetail: shown in the picker, stored with the connection), and the list
 * whether it was cut short (`truncated`, from an AdAccountList, which JSON alone would drop).
 */
export async function holdPendingAdConnect(
  coord: Coord,
  nonce: string,
  input: {
    userId: string;
    workspaceId: string;
    storeId: string;
    provider: AdProvider;
    accounts: AdAccountList;
    tokens: TokenSet;
    externalUserId?: string | null;
    truncated?: boolean;
    reusedRefreshToken?: boolean;
  },
) {
  const enc = encryptAdTokens(input.storeId, input.provider, input.tokens);
  const pending: PendingAdConnect = {
    userId: input.userId,
    workspaceId: input.workspaceId,
    storeId: input.storeId,
    provider: input.provider,
    accounts: [...input.accounts],
    accessTokenEnc: enc.accessTokenEnc,
    refreshTokenEnc: enc.refreshTokenEnc,
    accessTokenExpiresAt: input.tokens.expiresAt ? input.tokens.expiresAt.toISOString() : null,
    grantedScopes: input.tokens.grantedScopes,
    externalUserId: input.externalUserId ?? null,
    truncated: !!(input.truncated ?? input.accounts.truncated),
    ...(input.reusedRefreshToken ? { reusedRefreshToken: true } : {}),
    expiresAt: Date.now() + ADS_PENDING_TTL_S * 1000,
  };
  await coord.put(pendingKey(nonce), JSON.stringify(pending), ADS_PENDING_TTL_S);
  if (input.externalUserId) {
    // Best effort: without it, dropUnusedGrant only sees the choice it is asked about.
    const key = personPendingKey(input.provider, input.externalUserId);
    const held = (await pendingOf(coord, key)).filter((p) => p.expiresAt > Date.now());
    await coord.put(key, JSON.stringify([...held, { nonce, expiresAt: pending.expiresAt }].slice(-20)), ADS_PENDING_TTL_S).catch(() => undefined);
  }
}

async function pendingOf(coord: Coord, key: string): Promise<Array<{ nonce: string; expiresAt: number }>> {
  try {
    const raw = await coord.peek(key);
    const list = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(list) ? list.filter((p): p is { nonce: string; expiresAt: number } => typeof p?.nonce === "string" && typeof p?.expiresAt === "number") : [];
  } catch {
    return [];
  }
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

/**
 * Use up, unanswered, every account choice one person (the platform's id for them) has waiting: their
 * access ended or they asked for their data to be deleted. Returns how many there were. Best effort.
 */
export async function dropPendingAdConnectsOf(coord: Coord, provider: AdProvider, externalUserId: string): Promise<number> {
  const key = personPendingKey(provider, externalUserId);
  let dropped = 0;
  for (const p of await pendingOf(coord, key)) if (await coord.take(pendingKey(p.nonce)).catch(() => null)) dropped++;
  await coord.take(key).catch(() => null);
  return dropped;
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
 * before get the new token and come back from "reconnect" / "permission" / "error", keeping their
 * on/off choice and their stored days. Their alerts are closed: connecting again is the fix.
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
    // The account's health at the platform, when the listing said it.
    const health = a.status ? { accountStatus: a.status, accountStatusDetail: a.statusDetail ?? null } : {};
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
        ...health,
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
        errorCode: null,
        lastError: null,
        consecutiveFailures: 0,
        // A sync asked for before can't be waiting on this sign-in: the catch-up connecting queues is sent
        // (enqueueAdCatchUp skips a connection whose earlier request still looks on its way).
        syncRequestedAt: null,
        ...health,
        ...tokens,
      },
    });
    if (before) await resolveAdAlerts(row).catch((err: unknown) => logger.warn({ err, connectionId: row.id }, "ad alerts not resolved"));
    out.push({ ...row, isNew: !before });
  }
  return out;
}

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

/** Rows that still hold a working grant: not waiting for a reconnect (whose grant is dead), and with a token. */
const holdsGrant = { status: { not: "reconnect" }, accessTokenEnc: { not: "" } };

/**
 * Whether this bizinsights user connected `provider` before with a Google login whose refresh token
 * bizinsights still holds and uses. Then Google's consent screen can be skipped on their next connect
 * (GoogleConsentOptions.forceConsent false): a consent hands out a new refresh token every time, and
 * Google silently ends a login's oldest past 100 for one client. Google then sends none, and theirs is
 * reused (reusableRefreshToken); if they pick a login bizinsights holds none for, the callback asks
 * again with the consent screen.
 */
export async function holdsReusableRefreshToken(provider: AdProvider, userId: string): Promise<boolean> {
  if (provider === "meta") return false;
  const n = await systemDb.adConnection.count({ where: { provider, connectedByUserId: userId, externalUserId: { not: null }, refreshTokenEnc: { not: null }, ...holdsGrant } });
  return n > 0;
}

export type RevokeOutcome = "revoked" | "still_used" | "unknown_person" | "not_configured" | "failed";

/** At most this many unknown persons are looked up while someone waits for a disconnect; past it the grant is kept. */
const PERSON_LOOKUPS = 10;

/** Rows grouped by sign-in (the accounts connected in one go share its token and its person), first row first. */
function bySignIn(rows: AdConnection[]): Array<[AdConnection, ...AdConnection[]]> {
  const groups = new Map<string, [AdConnection, ...AdConnection[]]>();
  for (const r of rows) {
    const key = signInKey(r);
    const g = groups.get(key);
    if (g) g.push(r);
    else groups.set(key, [r]);
  }
  return [...groups.values()];
}

const signInKey = (r: AdConnection) => `${r.storeId}|${r.provider}|${r.refreshTokenEnc ?? r.accessTokenEnc}`;

/**
 * Who granted this connection's access, asked of the platform with its own token (refreshed first for
 * Google), and stored on its sign-in's rows. "ended": the token no longer works, so the rows are marked
 * "reconnect" (their grant can't be relied on). Null: the platform didn't say, or didn't answer.
 */
async function resolvePerson(conn: AdConnection, fetchImpl?: FetchLike): Promise<string | "ended" | null> {
  try {
    const { token, person } = await accessTokenAndPerson(conn, fetchImpl);
    return person !== undefined ? person : await learnAdPerson(conn, token, fetchImpl);
  } catch (err) {
    if (err instanceof AdsAuthError) {
      const failure = classifyAdError(err);
      for (const r of await systemDb.adConnection.findMany({ where: { ...sameSignIn(conn), externalUserId: null }, select: { id: true } })) await recordAdFailure(r.id, failure, "sync");
      return "ended";
    }
    logger.info({ err, connectionId: conn.id }, "ad connection: who granted access couldn't be looked up");
    return null;
  }
}

/**
 * Whether anything else relies on this person's grant: a connection on the same grant (Google Ads and
 * AdSense share one), anywhere, by them, or by a person bizinsights doesn't know yet who turns out to
 * be them. Those are looked up now (a few at a time; the rest, and any that can't be looked up, keep
 * the grant, to be safe: revoking at Google ends every connection on it).
 */
async function grantStillUsed(provider: string, externalUserId: string, exceptId: string | null, fetchImpl?: FetchLike): Promise<boolean> {
  const family = { provider: { in: grantFamily(provider) }, ...(exceptId ? { NOT: { id: exceptId } } : {}), ...holdsGrant };
  if ((await systemDb.adConnection.count({ where: { ...family, externalUserId } })) > 0) return true;
  const unknown = await systemDb.adConnection.findMany({ where: { ...family, externalUserId: null }, orderBy: { updatedAt: "desc" }, take: 500 });
  const signIns = bySignIn(unknown);
  if (unknown.length >= 500 || signIns.length > PERSON_LOOKUPS) return true;
  let unsure = false;
  for (const [r] of signIns) {
    const person = await resolvePerson(r, fetchImpl);
    if (person === externalUserId) return true;
    if (person === null) unsure = true;
  }
  return unsure;
}

/**
 * Take back the grant: Google's whole grant to bizinsights' client; Meta's ads_read only (WhatsApp keeps
 * working). Meta's is taken back with the person's own token, or, once that has expired, with
 * bizinsights' app token for their app-scoped id (`externalUserId`).
 */
async function revokeGrant(provider: string, tokens: { accessToken: string; refreshToken: string | null }, externalUserId: string, fetchImpl?: FetchLike): Promise<RevokeOutcome> {
  if (provider === "meta") {
    const cfg = metaConfig(fetchImpl);
    if (!cfg) return "not_configured";
    // "not_granted": the person no longer grants ads_read (they removed it, or the app), so nothing of
    // it is left at Meta: what a revoke is for.
    const outcome = await metaRevokeAdsRead(cfg, tokens.accessToken, externalUserId);
    if (outcome === "not_granted") logger.info({ provider }, "meta ads_read was no longer granted; nothing left to revoke");
  } else {
    // Revoking the refresh token ends its access tokens too.
    await googleRevoke({ fetchImpl }, tokens.refreshToken ?? tokens.accessToken);
  }
  return "revoked";
}

/**
 * After a disconnect: take back the platform access too, unless another connection still relies
 * on the same person's grant (another store, or AdSense next to Google Ads). Google revokes the
 * person's whole grant to bizinsights' client; Meta drops only ads_read (WhatsApp keeps working).
 * The connection's alerts are closed: there is nothing left to fix.
 * Best effort: the connection is already gone whatever the platform answers.
 */
export async function revokeAdAccessIfUnused(conn: AdConnection, fetchImpl?: FetchLike): Promise<RevokeOutcome> {
  await resolveAdAlerts(conn).catch((err: unknown) => logger.warn({ err, connectionId: conn.id }, "ad alerts not resolved"));
  if (!conn.accessTokenEnc) return "unknown_person";
  // A connection that never learned who granted it asks the platform now, with its own token (what it
  // learns is kept on the rest of its sign-in; this row is gone). Access that ended has nothing to revoke.
  const person = conn.externalUserId ?? (await resolvePerson(conn, fetchImpl).catch(() => null));
  if (!person || person === "ended") return "unknown_person";
  const k = keyring();
  try {
    if (await grantStillUsed(conn.provider, person, conn.id, fetchImpl)) return "still_used";
    const tokens = {
      accessToken: decrypt(conn.accessTokenEnc, k, aad(conn.storeId, conn.provider, "access")),
      refreshToken: conn.refreshTokenEnc ? decrypt(conn.refreshTokenEnc, k, aad(conn.storeId, conn.provider, "refresh")) : null,
    };
    return await revokeGrant(conn.provider, tokens, person, fetchImpl);
  } catch (err) {
    logger.warn({ err, connectionId: conn.id, provider: conn.provider }, "ad access revoke failed");
    return "failed";
  }
}

/**
 * A sign-in that ended without a connection (the person cancelled the account choice, the platform
 * refused after the code exchange, nothing could be connected): take back the grant it made, so
 * nothing is left at Google or Meta that bizinsights doesn't use. Only when it is safe:
 *
 * - who signed in is known (`externalUserId`), and no connection on the same grant is theirs, or
 *   could be (unknown persons are looked up; any that can't be keep the grant);
 * - the refresh token is the sign-in's own: one taken from their other connections
 *   (`reusedRefreshToken`, see reusableRefreshToken), or a Google sign-in without one (they gave one
 *   before, which may be in use), is left alone;
 * - with `coord`: they have no other account choice waiting (`exceptPending` is the one being dropped).
 *
 * A choice left to expire is not revoked: nothing runs when it does. Best effort; never throws.
 */
export async function dropUnusedGrant(
  provider: AdProvider,
  tokens: TokenSet,
  externalUserId: string | null | undefined,
  fetchImpl?: FetchLike,
  opts: { coord?: Coord; exceptPending?: string; reusedRefreshToken?: boolean } = {},
): Promise<RevokeOutcome> {
  if (!externalUserId) return "unknown_person";
  if (opts.reusedRefreshToken || (provider !== "meta" && !tokens.refreshToken)) return "still_used";
  try {
    if (opts.coord) {
      for (const p of await pendingOf(opts.coord, personPendingKey(provider, externalUserId))) {
        if (p.nonce !== opts.exceptPending && p.expiresAt > Date.now() && (await peekPendingAdConnect(opts.coord, p.nonce))) return "still_used";
      }
    }
    if (await grantStillUsed(provider, externalUserId, null, fetchImpl)) return "still_used";
    return await revokeGrant(provider, tokens, externalUserId, fetchImpl);
  } catch (err) {
    logger.warn({ err, provider }, "unused ad grant not revoked");
    return "failed";
  }
}

/** How long taking back a leaving person's grants may take in all, while their request waits (it runs inside the API's time limit). */
export const AD_RELEASE_REVOKE_BUDGET_MS = 15_000;

/** One sign-in a leaving person powered, detached already, whose grant may still be taken back (revokeReleasedAdGrants). */
export interface ReleasedAdGrant {
  /** The sign-in's first row as it was before its tokens were deleted (who granted it is looked up with them). */
  first: AdConnection;
  /** Every row of the sign-in. */
  ids: string[];
  /** Its tokens, or null when they couldn't be read (nothing can be revoked then). */
  tokens: { accessToken: string; refreshToken: string | null } | null;
}

/**
 * Someone whose login powers ad connections leaves: their bizinsights account is deleted, or (with
 * `workspaceId`) they are removed from that workspace. Their connections stop using their grant at once,
 * in the database only (no platform call, so a slow platform can't hold up their leaving): the tokens
 * are deleted and the rows wait for a reconnect ("connector_left"), keeping the days already stored and
 * who granted them (externalUserId), so a Meta data deletion request from that person still finds them.
 * Returns each sign-in, for revokeReleasedAdGrants to take the grant back.
 */
export async function detachUserAdGrants(userId: string, workspaceId?: string): Promise<{ released: number; grants: ReleasedAdGrant[] }> {
  const rows = await systemDb.adConnection.findMany({ where: { connectedByUserId: userId, ...(workspaceId ? { workspaceId } : {}), accessTokenEnc: { not: "" } } });
  const k = keyring();
  let released = 0;
  const grants: ReleasedAdGrant[] = [];
  for (const group of bySignIn(rows)) {
    const first = group[0];
    let tokens: ReleasedAdGrant["tokens"] = null;
    try {
      tokens = {
        accessToken: decrypt(first.accessTokenEnc, k, aad(first.storeId, first.provider, "access")),
        refreshToken: first.refreshTokenEnc ? decrypt(first.refreshTokenEnc, k, aad(first.storeId, first.provider, "refresh")) : null,
      };
    } catch (err) {
      logger.warn({ err, connectionId: first.id }, "ad tokens of a leaving person couldn't be read; deleted without a revoke");
    }
    const ids = group.map((r) => r.id);
    const { count } = await systemDb.adConnection.updateMany({
      where: { id: { in: ids } },
      data: {
        status: "reconnect",
        errorCode: "connector_left",
        lastError: null,
        accessTokenEnc: "",
        refreshTokenEnc: null,
        accessTokenExpiresAt: null,
        connectedByUserId: null,
        syncRequestedAt: null,
      },
    });
    released += count;
    grants.push({ first, ids, tokens });
  }
  return { released, grants };
}

/**
 * Take back the grants detachUserAdGrants left, each unless another connection still relies on it, all
 * within `deadline` (epoch ms; by default AD_RELEASE_REVOKE_BUDGET_MS from now): a platform that doesn't
 * answer in time leaves its grant ("failed"; the person can still remove bizinsights at Google or
 * Meta). A sign-in that never learned who granted it is looked up now with its old token, and what is
 * learned is kept on its rows. Never throws.
 */
export async function revokeReleasedAdGrants(grants: ReleasedAdGrant[], fetchImpl?: FetchLike, opts: { deadline?: number } = {}): Promise<RevokeOutcome[]> {
  const f = fetchUntil(fetchImpl, opts.deadline ?? Date.now() + AD_RELEASE_REVOKE_BUDGET_MS);
  const outcomes: RevokeOutcome[] = [];
  // One person's grant is decided once, however many of their sign-ins were released.
  const decided = new Map<string, RevokeOutcome>();
  for (const { first, ids, tokens } of grants) {
    try {
      // Without a working token or a known person there is no telling whose grant it was.
      const person = first.externalUserId ?? (tokens ? await resolvePerson(first, f) : null);
      if (!tokens || !person || person === "ended") {
        outcomes.push("unknown_person");
        continue;
      }
      if (!first.externalUserId) await systemDb.adConnection.updateMany({ where: { id: { in: ids }, externalUserId: null }, data: { externalUserId: person } });
      const key = `${grantFamily(first.provider)[0]}:${person}`;
      const before = decided.get(key);
      if (before === "revoked" || before === "still_used") {
        outcomes.push(before);
        continue;
      }
      const outcome = (await grantStillUsed(first.provider, person, null, f)) ? "still_used" : await revokeGrant(first.provider, tokens, person, f);
      decided.set(key, outcome);
      outcomes.push(outcome);
    } catch (err) {
      logger.warn({ err, connectionId: first.id }, "ad access revoke failed");
      outcomes.push("failed");
    }
  }
  return outcomes;
}

/**
 * Both steps for someone who leaves (detachUserAdGrants, then revokeReleasedAdGrants within
 * `revokeDeadline`). The database step throws on failure; the platform step never does.
 */
export async function releaseUserAdGrants(
  userId: string,
  workspaceId?: string,
  fetchImpl?: FetchLike,
  opts: { revokeDeadline?: number } = {},
): Promise<{ released: number; outcomes: RevokeOutcome[] }> {
  const { released, grants } = await detachUserAdGrants(userId, workspaceId);
  const outcomes = await revokeReleasedAdGrants(grants, fetchImpl, { deadline: opts.revokeDeadline });
  if (released) logger.info({ userId, workspaceId: workspaceId ?? null, released, outcomes }, "ad connections released from a leaving person");
  return { released, outcomes };
}

/**
 * Fill in who granted access for connections that don't know it yet (made before bizinsights kept it,
 * or the look-up failed when they were made), so a disconnect can tell whether anyone else relies on
 * a grant (see grantStillUsed). A token that no longer works marks its rows "reconnect". One look-up per
 * sign-in, at most `limit` of them (200), so it is safe to run again: rows already known are skipped.
 * `remaining`: rows still unknown (the platform wouldn't say, or more than `limit` sign-ins were left).
 */
export async function fillAdPersons(opts: { fetchImpl?: FetchLike; limit?: number } = {}): Promise<{ learned: number; ended: number; unknown: number; remaining: number }> {
  const where = { provider: { in: ["meta", "google", "adsense"] }, externalUserId: null, ...holdsGrant };
  const out = { learned: 0, ended: 0, unknown: 0, remaining: 0 };
  const limit = opts.limit ?? 200;
  const tried = new Set<string>();
  let cursor: string | undefined;
  while (tried.size < limit) {
    const page = await systemDb.adConnection.findMany({ where: { ...where, ...(cursor ? { id: { gt: cursor } } : {}) }, orderBy: { id: "asc" }, take: 200 });
    if (!page.length) break;
    cursor = page[page.length - 1]!.id;
    for (const [r] of bySignIn(page)) {
      const key = signInKey(r);
      if (tried.has(key) || tried.size >= limit) continue;
      tried.add(key);
      const person = await resolvePerson(r, opts.fetchImpl);
      if (person === "ended") out.ended++;
      else if (person) out.learned++;
      else out.unknown++;
    }
  }
  out.remaining = await systemDb.adConnection.count({ where });
  logger.info(out, "ad connections: who granted access filled in");
  return out;
}
