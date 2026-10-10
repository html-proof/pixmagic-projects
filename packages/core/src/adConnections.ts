/**
 * Ad accounts connected to a store: their encrypted tokens, keeping those tokens usable, and
 * storing what the platforms report (ad_campaign_daily). The platform calls themselves are in
 * ads.ts; the HTTP routes are apps/api/src/routes/ads.ts; the sync job is apps/worker.
 */
import { systemDb, type AdConnection } from "@app/db";
import { addDays, decrypt, encrypt, keyVersionOf, localDay, type AdDayRow, type AdProvider } from "@app/shared";
import {
  AdsApiError,
  AdsAuthError,
  googleCampaignDays,
  googleRefresh,
  metaCampaignDays,
  type AdAccount,
  type GoogleConfig,
  type MetaConfig,
  type TokenSet,
} from "./ads.js";
import { env } from "./env.js";
import { logger } from "./logger.js";
import type { Producer, Queues } from "./queues.js";
import type { FetchLike } from "./shopify.js";
import { keyring } from "./tokens.js";

/** The platform's keys, or null while they aren't set (the Connect button says so). */
export function metaConfig(fetchImpl?: FetchLike): MetaConfig | null {
  const e = env();
  if (!e.META_APP_ID || !e.META_APP_SECRET) return null;
  return { appId: e.META_APP_ID, appSecret: e.META_APP_SECRET, version: e.META_API_VERSION, fetchImpl };
}

export function googleConfig(fetchImpl?: FetchLike): GoogleConfig | null {
  const e = env();
  if (!e.GOOGLE_ADS_CLIENT_ID || !e.GOOGLE_ADS_CLIENT_SECRET || !e.GOOGLE_ADS_DEVELOPER_TOKEN) return null;
  return { clientId: e.GOOGLE_ADS_CLIENT_ID, clientSecret: e.GOOGLE_ADS_CLIENT_SECRET, developerToken: e.GOOGLE_ADS_DEVELOPER_TOKEN, version: e.GOOGLE_ADS_API_VERSION, fetchImpl };
}

export const adsConfigured = (): Record<AdProvider, boolean> => ({ meta: metaConfig() !== null, google: googleConfig() !== null });

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
}): Promise<Array<AdConnection & { isNew: boolean }>> {
  const tokens = encryptAdTokens(input.storeId, input.provider, input.tokens);
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
        currency: a.currency,
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
 * A usable access token for this ad account. Google's last an hour, so a fresh one is minted
 * from the stored refresh token when needed; Meta's last about 60 days and can't be renewed
 * without the person signing in again, so an expired one means "reconnect".
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
  const cfg = googleConfig(fetchImpl);
  if (!cfg) throw new AdsApiError("Google Ads isn't set up on this server", 503);
  if (!conn.refreshTokenEnc) throw new AdsAuthError("Google access has no refresh token");
  const fresh = await googleRefresh(cfg, decrypt(conn.refreshTokenEnc, k, aad(conn.storeId, conn.provider, "refresh")));
  const enc = encryptAdTokens(conn.storeId, "google", fresh);
  await systemDb.adConnection.update({ where: { id: conn.id }, data: { accessTokenEnc: enc.accessTokenEnc, accessTokenExpiresAt: enc.accessTokenExpiresAt, tokenKeyVersion: enc.tokenKeyVersion } });
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

/** Fetch and store one ad account's days. Marks the connection with what happened. */
export async function syncAdConnection(connectionId: string, since: string, until: string, fetchImpl?: FetchLike) {
  const conn = await systemDb.adConnection.findUnique({ where: { id: connectionId } });
  if (!conn || !conn.enabled) return { skipped: true as const };
  try {
    const token = await adAccessToken(conn, fetchImpl);
    let rows: AdDayRow[];
    if (conn.provider === "meta") {
      const cfg = metaConfig(fetchImpl);
      if (!cfg) throw new AdsApiError("Meta isn't set up on this server", 503);
      rows = await metaCampaignDays(cfg, token, conn.accountId, since, until);
    } else {
      const cfg = googleConfig(fetchImpl);
      if (!cfg) throw new AdsApiError("Google Ads isn't set up on this server", 503);
      rows = await googleCampaignDays(cfg, token, conn, since, until);
    }
    const stored = await storeAdDays(conn, since, until, rows);
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
