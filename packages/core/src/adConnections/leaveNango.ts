/**
 * Leaving Nango (docs/ads-setup.md, "Leaving Nango"). From 2026-10-22 to 2026-10-28 the ad platforms'
 * sign-ins went through Nango, which kept the tokens; bizinsights signs in itself again, and the
 * connections made through Nango (`source` "nango", and waiting logins naming a Nango connection) are
 * moved off it without the merchant doing anything.
 *
 * The grant never changes: it was always to bizinsights' own Meta app or Google client, which Nango
 * signed in with. Each Nango connection (every row and waiting login reading through it) is moved in
 * one go:
 *  1. its tokens are read from Nango (the refresh token too, for Google);
 *  2. they are tried without Nango: Google renews the access token with bizinsights' own client, and
 *     Meta answers /me with the token (signed with bizinsights' app secret);
 *  3. the rows are rewritten over what was read (compare-and-swap): the tokens sealed on them as
 *     bizinsights' own sign-in seals them, `source` "direct", no Nango connection id;
 *  4. the connection is deleted at Nango, with its copy of the tokens (never the grant).
 *
 * A connection that can't be moved this time (Nango or the platform not answering) stays as it is, and
 * its rows wait for the move rather than syncing (credentials.ts AdsMovingOffNangoError); it is tried
 * again after MOVE_RETRY_S. One Nango no longer has, or whose grant the platform refused, can never be
 * read again: its accounts are put on Reconnect, as a sync would have. Bizinsights' Nango key refused,
 * or Nango rate limiting, ends the run. A rollback of the code needs nothing: older releases read
 * `source` "direct" rows as they always did.
 */
import { systemDb, type AdConnection, type AdLogin } from "@app/db";
import type { AdProvider } from "@app/shared";
import {
  AdsApiError,
  AdsAuthError,
  AdsRateLimitedError,
  AdsRetryableError,
  classifyAdError,
  googleRefresh,
  metaUserId,
  NANGO_INTEGRATION,
  nangoConnectionCredentials,
  nangoDeleteConnection,
  REQUIRED_AD_SCOPE,
  type TokenSet,
} from "../ads.js";
import type { Coord } from "../coord.js";
import { logger } from "../logger.js";
import { audit } from "../notify.js";
import type { FetchLike } from "../shopify.js";
import { adsenseConfig, googleClient, metaConfig, nangoConfig } from "./config.js";
import { encryptAdTokens, nangoCredential } from "./credentials.js";
import { encryptLoginToken } from "./logins.js";
import { recordAdFailure } from "./status.js";

/** At most this many Nango connections are moved per run (the cron tick, every 15 minutes), so one run stays short. */
export const MOVE_OFF_NANGO_PER_RUN = 25;
/** How long a connection that couldn't be moved waits before it is tried again. */
export const MOVE_RETRY_S = 3600;

const LOCK_KEY = "ads-nango-leave";
const waitKey = (connectionId: string) => `ads-nango-leave-wait:${connectionId}`;

export interface LeaveNangoResult {
  /** Rows and waiting logins now holding bizinsights' own tokens. */
  moved: number;
  /** Nango connections that couldn't be moved this time (they wait MOVE_RETRY_S). */
  failed: number;
  /** Nango connections still waiting from an earlier failure. */
  waiting: number;
  /** Accounts whose access had ended at Nango: put on Reconnect. */
  ended: number;
  /** Rows and waiting logins still reading through Nango after this run (0: Nango can be switched off). */
  left: number;
}

/** One Nango connection and everything reading through it: one store and platform (a Nango sign-in was made for one). */
interface NangoGroup {
  connectionId: string;
  integrationKey: string;
  storeId: string;
  provider: AdProvider;
  rows: AdConnection[];
  logins: AdLogin[];
}

/** The Nango connection a row reads through: its sealed credential, or (credential unreadable) its connection id and the platform's integration. */
function credentialOf(row: AdConnection): { connectionId: string; integrationKey: string } | null {
  try {
    if (row.accessTokenEnc) return nangoCredential(row);
  } catch (err) {
    logger.warn({ err, connectionId: row.id }, "a Nango row's credential couldn't be read; its connection id is used");
  }
  return row.sourceLoginId ? { connectionId: row.sourceLoginId, integrationKey: NANGO_INTEGRATION[row.provider as AdProvider] } : null;
}

const leftCount = async () => {
  const [rows, logins] = await Promise.all([
    systemDb.adConnection.count({ where: { source: "nango" } }),
    systemDb.adLogin.count({ where: { sourceLoginId: { not: null }, accessTokenEnc: "" } }),
  ]);
  return rows + logins;
};

type Outcome = "moved" | "failed" | "ended" | "stop";

/** The tokens, tried without Nango (see the module's comment). Throws the platform's errors. */
async function tryWithoutNango(provider: AdProvider, held: { accessToken: string; refreshToken: string | null; expiresAt: Date | null }, fetchImpl?: FetchLike): Promise<TokenSet> {
  if (provider === "meta") {
    const cfg = metaConfig(fetchImpl);
    if (!cfg) throw new AdsApiError("Meta isn't set up on this server", 503, undefined, "not_configured");
    await metaUserId(cfg, held.accessToken);
    return { accessToken: held.accessToken, refreshToken: null, expiresAt: held.expiresAt };
  }
  const cfg = provider === "adsense" ? adsenseConfig(fetchImpl) : googleClient(fetchImpl);
  if (!cfg) throw new AdsApiError("Google isn't set up on this server", 503, undefined, "not_configured");
  if (!held.refreshToken) throw new AdsAuthError("Nango gave no refresh token for a Google connection");
  const fresh = await googleRefresh(cfg, held.refreshToken, { requiredScope: REQUIRED_AD_SCOPE[provider] });
  return { accessToken: fresh.accessToken, refreshToken: fresh.refreshToken, expiresAt: fresh.expiresAt, grantedScopes: fresh.grantedScopes };
}

async function moveGroup(g: NangoGroup, fetchImpl?: FetchLike): Promise<{ outcome: Outcome; count: number }> {
  const cfg = nangoConfig(fetchImpl);
  if (!cfg) return { outcome: "stop", count: 0 };
  const { provider, storeId, connectionId } = g;
  const rowIds = g.rows.map((r) => r.id);
  let tokens: TokenSet;
  try {
    tokens = await tryWithoutNango(provider, await nangoConnectionCredentials(cfg, g.integrationKey, connectionId), fetchImpl);
  } catch (err) {
    // Ours to fix for every connection alike (the key, the plan, the platform's keys here), or Nango slowing us down: the run stops.
    if ((err instanceof AdsApiError && err.errorCode === "not_configured") || err instanceof AdsRateLimitedError) {
      logger.error({ err, provider }, "connections can't be moved off Nango now; the next tick tries again");
      return { outcome: "stop", count: 0 };
    }
    if (err instanceof AdsAuthError) {
      // Nothing left to read, at Nango or with the platform: Reconnect, as the next sync would have said.
      const failure = classifyAdError(err);
      for (const id of rowIds) await recordAdFailure(id, failure, "sync");
      await systemDb.adConnection.updateMany({ where: { id: { in: rowIds }, source: "nango" }, data: { source: "direct", sourceLoginId: null, accessTokenEnc: "", refreshTokenEnc: null, accessTokenExpiresAt: null } });
      if (g.logins.length) await systemDb.adLogin.deleteMany({ where: { id: { in: g.logins.map((l) => l.id) }, accessTokenEnc: "" } });
      await nangoDeleteConnection(cfg, g.integrationKey, connectionId).catch((e: unknown) => logger.warn({ err: e, provider }, "an ended Nango connection wasn't deleted at Nango"));
      logger.warn({ err, provider, storeId, accounts: rowIds.length, logins: g.logins.length }, "a Nango connection's access had ended; its accounts wait for a reconnect");
      return { outcome: "ended", count: rowIds.length };
    }
    logger.warn({ err, provider, storeId, retryable: err instanceof AdsRetryableError }, "a Nango connection couldn't be moved off Nango; tried again later");
    return { outcome: "failed", count: 0 };
  }
  // Only over what was read: a disconnect or a reconnect meanwhile wins.
  const { count: rows } = await systemDb.adConnection.updateMany({
    where: { id: { in: rowIds }, source: "nango", accessTokenEnc: { in: [...new Set(g.rows.map((r) => r.accessTokenEnc))] } },
    data: { ...encryptAdTokens(storeId, provider, tokens), source: "direct", sourceLoginId: null },
  });
  let logins = 0;
  for (const l of g.logins) {
    const { count } = await systemDb.adLogin.updateMany({
      where: { id: l.id, sourceLoginId: connectionId, accessTokenEnc: "" },
      data: { ...encryptLoginToken(storeId, provider, tokens.accessToken), accessTokenExpiresAt: tokens.expiresAt ?? l.accessTokenExpiresAt, sourceLoginId: null, nangoIntegrationKey: null },
    });
    logins += count;
  }
  // Nothing at Nango is needed any more: its copy of the tokens goes (the grant stays, now held here).
  await nangoDeleteConnection(cfg, g.integrationKey, connectionId).catch((err: unknown) => logger.warn({ err, provider }, "a moved Nango connection wasn't deleted at Nango; delete it in Nango's dashboard"));
  for (const workspaceId of new Set([...g.rows, ...g.logins].map((r) => r.workspaceId))) {
    await audit({ workspaceId, action: "ads.moved_off_nango", targetType: "store", targetId: storeId, metadata: { provider, accounts: rows, logins } }).catch((err: unknown) => logger.warn({ err }, "audit failed"));
  }
  logger.info({ provider, storeId, accounts: rows, logins }, "a Nango ad connection now holds bizinsights' own tokens");
  return { outcome: "moved", count: rows + logins };
}

/**
 * Move up to `limit` Nango connections (MOVE_OFF_NANGO_PER_RUN) off Nango. One run at a time. Logs how
 * many rows still read through Nango, which says when NANGO_SECRET_KEY can go (0). Never throws for one
 * connection.
 */
export async function leaveNango(coord: Coord, opts: { fetchImpl?: FetchLike; limit?: number } = {}): Promise<LeaveNangoResult> {
  const out: LeaveNangoResult = { moved: 0, failed: 0, waiting: 0, ended: 0, left: 0 };
  if (!(await leftCount())) return out;
  if (!nangoConfig(opts.fetchImpl)) {
    out.left = await leftCount();
    logger.error(out, "rows still read through Nango, but NANGO_SECRET_KEY isn't set: they can't be moved");
    return out;
  }
  if (!(await coord.acquire(LOCK_KEY, 10 * 60_000))) return { ...out, left: await leftCount() };
  try {
    const [rows, logins] = await Promise.all([
      systemDb.adConnection.findMany({ where: { source: "nango" }, orderBy: { id: "asc" }, take: 1000 }),
      systemDb.adLogin.findMany({ where: { sourceLoginId: { not: null }, accessTokenEnc: "" }, orderBy: { id: "asc" }, take: 200 }),
    ]);
    const groups = new Map<string, NangoGroup>();
    const groupOf = (connectionId: string, integrationKey: string, storeId: string, provider: AdProvider) => {
      const key = `${connectionId}|${storeId}|${provider}`;
      const g = groups.get(key) ?? { connectionId, integrationKey, storeId, provider, rows: [], logins: [] };
      groups.set(key, g);
      return g;
    };
    for (const r of rows) {
      // A row whose credential was let go (its person left) holds nothing to move, and must not get tokens back: it waits for a reconnect.
      const cred = r.accessTokenEnc ? credentialOf(r) : null;
      if (cred) groupOf(cred.connectionId, cred.integrationKey, r.storeId, r.provider as AdProvider).rows.push(r);
      else await systemDb.adConnection.updateMany({ where: { id: r.id, source: "nango", accessTokenEnc: r.accessTokenEnc }, data: { source: "direct", sourceLoginId: null, accessTokenEnc: "", refreshTokenEnc: null } });
    }
    for (const l of logins) groupOf(l.sourceLoginId!, l.nangoIntegrationKey || NANGO_INTEGRATION[l.provider as AdProvider], l.storeId, l.provider as AdProvider).logins.push(l);
    let tried = 0;
    for (const g of groups.values()) {
      if (tried >= (opts.limit ?? MOVE_OFF_NANGO_PER_RUN)) break;
      if (await coord.peek(waitKey(g.connectionId)).catch(() => null)) {
        out.waiting++;
        continue;
      }
      tried++;
      const { outcome, count } = await moveGroup(g, opts.fetchImpl);
      if (outcome === "moved") out.moved += count;
      else if (outcome === "ended") out.ended += count;
      else {
        out.failed++;
        if (outcome === "stop") break;
        await coord.put(waitKey(g.connectionId), "1", MOVE_RETRY_S).catch(() => undefined);
      }
    }
  } finally {
    await coord.release(LOCK_KEY).catch(() => undefined);
  }
  out.left = await leftCount();
  logger.info(out, "ad connections moved off Nango");
  return out;
}
