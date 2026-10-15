/**
 * Ad accounts connected to a store: their encrypted tokens, keeping those tokens usable, and
 * storing what the platforms report (ad_campaign_daily, and adsense_daily for AdSense). The
 * platform calls themselves are in ads.ts; the HTTP routes are apps/api/src/routes/ads.ts; the
 * sync job is apps/worker.
 */
import { systemDb, type AdConnection } from "@app/db";
import { addDays, decrypt, encrypt, keyVersionOf, localDay, type AdDayRow, type AdProvider, type AdsenseDayRow, type GoogleReportLevel, type MetaReportView } from "@app/shared";
import {
  AdsApiError,
  AdsAuthError,
  adsenseSiteDays,
  googleCampaignDays,
  googleRefresh,
  googleReport,
  googleRevoke,
  googleUserId,
  isMetaPermissionError,
  metaCampaignDays,
  metaGrantedPermissions,
  metaReport,
  metaRevokeAdsRead,
  type AdAccount,
  type GoogleReport,
  type MetaReport,
  type AdsenseConfig,
  type GoogleConfig,
  type MetaConfig,
  type TokenSet,
} from "./ads.js";
import type { Coord } from "./coord.js";
import { env } from "./env.js";
import { logger } from "./logger.js";
import type { Producer, Queues } from "./queues.js";
import type { FetchLike } from "./shopify.js";
import { keyring } from "./tokens.js";

/** The platform's keys, or null while they aren't set (the Connect button says so). */
export function metaConfig(fetchImpl?: FetchLike): MetaConfig | null {
  const e = env();
  if (!e.META_APP_ID || !e.META_APP_SECRET) return null;
  return { appId: e.META_APP_ID, appSecret: e.META_APP_SECRET, version: e.META_API_VERSION, configId: e.META_CONFIG_ID || undefined, fetchImpl };
}

/** "1", "true", "yes" or "on". */
const switchedOn = (v: string) => /^(1|true|yes|on)$/i.test(v.trim());

/** Google Ads: the same Google OAuth client as AdSense, switched on once its Cloud project may reach real accounts. */
export function googleConfig(fetchImpl?: FetchLike): GoogleConfig | null {
  const e = env();
  if (!e.GOOGLE_ADS_CLIENT_ID || !e.GOOGLE_ADS_CLIENT_SECRET || !switchedOn(e.GOOGLE_ADS_ENABLED)) return null;
  return { clientId: e.GOOGLE_ADS_CLIENT_ID, clientSecret: e.GOOGLE_ADS_CLIENT_SECRET, version: e.GOOGLE_ADS_API_VERSION, fetchImpl };
}

/** AdSense signs in through the same Google OAuth client as Google Ads, and needs nothing else. */
export function adsenseConfig(fetchImpl?: FetchLike): AdsenseConfig | null {
  const e = env();
  if (!e.GOOGLE_ADS_CLIENT_ID || !e.GOOGLE_ADS_CLIENT_SECRET) return null;
  return { clientId: e.GOOGLE_ADS_CLIENT_ID, clientSecret: e.GOOGLE_ADS_CLIENT_SECRET, fetchImpl };
}

export const adsConfigured = (): Record<AdProvider, boolean> => ({ meta: metaConfig() !== null, google: googleConfig() !== null, adsense: adsenseConfig() !== null });

/**
 * Platforms whose sign-in only lets in the people added to bizinsights' own app: Meta, until ads_read
 * has Advanced Access (META_ADS_ADVANCED_ACCESS). Facebook turns everyone else away on its own page.
 */
export const adsRestricted = (): Record<AdProvider, boolean> => ({
  meta: metaConfig() !== null && !switchedOn(env().META_ADS_ADVANCED_ACCESS),
  google: false,
  adsense: false,
});

/** The platform's name in messages. */
export const AD_PROVIDER_NAME: Record<AdProvider, string> = { meta: "Meta", google: "Google Ads", adsense: "Google AdSense" };

/** Where the platform sends people back. Must be registered exactly like this in the Meta app and the Google OAuth client. */
export const adsRedirectUri = (provider: AdProvider) => `${env().APP_URL}/api/ads/${provider}/callback`;

/** Binds a ciphertext to its store and platform, so it can't be moved to another store's row. */
const aad = (storeId: string, provider: string, kind: "access" | "refresh") => `ads:${provider}:${storeId}:${kind}`;

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

// ---------------------------------------------------------------------------
// Choosing accounts after sign-in: the sign-in's tokens wait here (encrypted, a few minutes)
// while the person picks which of the accounts it can see to connect.
// ---------------------------------------------------------------------------

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

/** Replace what's stored for these days with what the platform reports now (campaigns can disappear). */
export async function storeAdDays(conn: AdConnection, since: string, until: string, rows: AdDayRow[]) {
  const inRange = rows.filter((r) => r.day >= since && r.day <= until);
  await systemDb.$transaction([
    systemDb.adCampaignDaily.deleteMany({ where: { connectionId: conn.id, day: { gte: since, lte: until } } }),
    systemDb.adCampaignDaily.createMany({
      data: inRange.map((r) => ({
        workspaceId: conn.workspaceId,
        storeId: conn.storeId,
        connectionId: conn.id,
        provider: conn.provider,
        accountId: conn.accountId,
        campaignId: r.campaignId,
        campaignName: r.campaignName.slice(0, 500),
        day: r.day,
        spend: r.spend,
        impressions: Math.min(r.impressions, 2_147_483_647),
        clicks: Math.min(r.clicks, 2_147_483_647),
        conversions: r.conversions,
        conversionValue: r.conversionValue,
        leads: r.leads,
        currency: conn.currency,
      })),
      skipDuplicates: true,
    }),
  ]);
  return inRange.length;
}

/**
 * Replace what's stored for these days with what AdSense reports now, and remember the account's
 * currency (AdSense only says it in reports).
 */
export async function storeAdsenseDays(conn: AdConnection, since: string, until: string, rows: AdsenseDayRow[], currency: string | null) {
  const inRange = rows.filter((r) => r.day >= since && r.day <= until);
  const cur = currency ?? conn.currency;
  await systemDb.$transaction([
    systemDb.adsenseDaily.deleteMany({ where: { connectionId: conn.id, day: { gte: since, lte: until } } }),
    systemDb.adsenseDaily.createMany({
      data: inRange.map((r) => ({
        workspaceId: conn.workspaceId,
        storeId: conn.storeId,
        connectionId: conn.id,
        accountId: conn.accountId,
        site: r.site.slice(0, 255),
        day: r.day,
        earnings: r.earnings,
        pageViews: Math.min(r.pageViews, 2_147_483_647),
        impressions: Math.min(r.impressions, 2_147_483_647),
        clicks: Math.min(r.clicks, 2_147_483_647),
        currency: cur,
      })),
      skipDuplicates: true,
    }),
    ...(currency && currency !== conn.currency ? [systemDb.adConnection.update({ where: { id: conn.id }, data: { currency } })] : []),
  ]);
  return inRange.length;
}

/** Fetch and store one ad account's days. Marks the connection with what happened. */
export async function syncAdConnection(connectionId: string, since: string, until: string, fetchImpl?: FetchLike) {
  const conn = await systemDb.adConnection.findUnique({ where: { id: connectionId } });
  if (!conn || !conn.enabled) return { skipped: true as const };
  try {
    const token = await adAccessToken(conn, fetchImpl);
    let stored: number;
    if (conn.provider === "meta") {
      const cfg = metaConfig(fetchImpl);
      if (!cfg) throw new AdsApiError("Meta isn't set up on this server", 503);
      let rows: AdDayRow[];
      try {
        rows = await metaCampaignDays(cfg, token, conn.accountId, since, until);
      } catch (err) {
        // A permission error means "connect again" only when ads_read itself was taken back.
        if (isMetaPermissionError(err)) {
          const granted = await metaGrantedPermissions(cfg, token).catch(() => null);
          if (granted && !granted.includes("ads_read")) throw new AdsAuthError("Meta's ads_read permission was taken back");
        }
        throw err;
      }
      stored = await storeAdDays(conn, since, until, rows);
    } else if (conn.provider === "google") {
      const cfg = googleConfig(fetchImpl);
      if (!cfg) throw new AdsApiError("Google Ads isn't set up on this server", 503);
      const rows: AdDayRow[] = await googleCampaignDays(cfg, token, conn, since, until);
      stored = await storeAdDays(conn, since, until, rows);
    } else if (conn.provider === "adsense") {
      const cfg = adsenseConfig(fetchImpl);
      if (!cfg) throw new AdsApiError("Google AdSense isn't set up on this server", 503);
      const report = await adsenseSiteDays(cfg, token, conn.accountId, since, until);
      stored = await storeAdsenseDays(conn, since, until, report.rows, report.currency);
    } else {
      throw new AdsApiError(`Unknown ad platform ${conn.provider}`, 400);
    }
    await systemDb.adConnection.update({ where: { id: conn.id }, data: { status: "active", lastError: null, lastSyncedAt: new Date() } });
    return { skipped: false as const, stored };
  } catch (err) {
    const message = (err instanceof Error ? err.message : String(err)).slice(0, 500);
    if (err instanceof AdsAuthError) {
      await systemDb.adConnection.update({ where: { id: conn.id }, data: { status: "reconnect", lastError: message } });
    } else if (err instanceof AdsApiError) {
      await systemDb.adConnection.update({ where: { id: conn.id }, data: { status: "error", lastError: message } });
    }
    throw err;
  }
}

/**
 * The Meta Ads report for one connected account and range, straight from Meta. Lost access
 * (expired, revoked, ads_read taken back) marks the connection "reconnect", as a sync would, so
 * the dashboard stops presenting its numbers as current.
 */
export async function metaReportForConnection(conn: AdConnection, level: MetaReportView, since: string, until: string, fetchImpl?: FetchLike): Promise<MetaReport> {
  const cfg = metaConfig(fetchImpl);
  if (!cfg) throw new AdsApiError("Meta isn't set up on this server", 503);
  try {
    const token = await adAccessToken(conn, fetchImpl);
    try {
      return await metaReport(cfg, token, conn.accountId, level, since, until);
    } catch (err) {
      if (isMetaPermissionError(err)) {
        const granted = await metaGrantedPermissions(cfg, token).catch(() => null);
        if (granted && !granted.includes("ads_read")) throw new AdsAuthError("Meta's ads_read permission was taken back");
      }
      throw err;
    }
  } catch (err) {
    if (err instanceof AdsAuthError) {
      await systemDb.adConnection.update({ where: { id: conn.id }, data: { status: "reconnect", lastError: err.message.slice(0, 500) } });
    }
    throw err;
  }
}

/**
 * The Google Ads report for one connected account and range, straight from Google. Lost access
 * (revoked, expired refresh token) marks the connection "reconnect", as a sync would.
 */
export async function googleReportForConnection(conn: AdConnection, level: GoogleReportLevel, since: string, until: string, fetchImpl?: FetchLike): Promise<GoogleReport> {
  const cfg = googleConfig(fetchImpl);
  if (!cfg) throw new AdsApiError("Google Ads isn't set up on this server", 503);
  try {
    const token = await adAccessToken(conn, fetchImpl);
    return await googleReport(cfg, token, conn, level, since, until);
  } catch (err) {
    if (err instanceof AdsAuthError) {
      await systemDb.adConnection.update({ where: { id: conn.id }, data: { status: "reconnect", lastError: err.message.slice(0, 500) } });
    }
    throw err;
  }
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

/** A sync of one ad account's days. Rides the sync queue (no sync_jobs row: it isn't part of the store's import). */
export interface AdsSyncData {
  kind: "ads";
  connectionId: string;
  since: string;
  until: string;
}

/** The sync queue, typed for ad jobs. Its declared type stays SyncJobData so the many store-sync call sites don't change. */
export const adsQueue = (queues: Queues) => queues.sync as unknown as Producer<AdsSyncData>;

/** How far back a first connection fetches, and the daily re-check (platforms revise recent conversions). */
export const ADS_BACKFILL_DAYS = 90;
export const ADS_RECHECK_DAYS = 30;
export const ADS_RECENT_DAYS = 3;

/** The ad account's own today, which is what its "days" are. */
export function adToday(conn: Pick<AdConnection, "timezone">, now = new Date()): string {
  try {
    return localDay(now, conn.timezone || "UTC");
  } catch {
    return localDay(now, "UTC");
  }
}

export async function enqueueAdSync(queues: Queues, conn: Pick<AdConnection, "id" | "timezone">, days: number, opts?: { delaySeconds?: number }) {
  const until = adToday(conn);
  await adsQueue(queues).send({ kind: "ads", connectionId: conn.id, since: addDays(until, -(days - 1)), until }, opts);
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
