/**
 * A platform sign-in that reaches no ad account yet, kept connected rather than refused (ad_logins).
 *
 * A Facebook login can authorize bizinsights and still list no ad account: it has none of its own, its
 * ads run in a business portfolio it isn't assigned to, nothing was ticked on Facebook's screen, or Meta
 * didn't answer in time. The person did connect, so the card says "Connected as …" and nothing reads as
 * an error. The cron tick asks the platform again (checkAdLogins), and as soon as it lists ad accounts
 * they are connected (a few at once; more wait for the person to choose), after which the row goes.
 *
 * The login holds a Nango connection and the person's grant to bizinsights' own app, like a connection
 * does: grantStillUsed and nangoConnectionUsers (connect.ts) count it, the orphan sweep leaves it, and
 * whatever ends a connection ends it too (its disconnect, the person removing bizinsights on Facebook or
 * asking for their data to be deleted, Nango deleting the connection, the store going, its connector
 * leaving), giving the grant back unless something else relies on it.
 */
import { systemDb, type AdLogin, type Prisma } from "@app/db";
import { AD_LOGIN_AUTO_CONNECT_MAX, allows, type AdLoginReason, type AdProvider, type Role } from "@app/shared";
import { AdsAuthError, AdsNoAccountsError, metaAdAccounts, type AdAccountList } from "../ads.js";
import type { Coord } from "../coord.js";
import { logger } from "../logger.js";
import { audit } from "../notify.js";
import type { Queues } from "../queues.js";
import type { FetchLike } from "../shopify.js";
import { memberState } from "../team/common.js";
import { metaConfig } from "./config.js";
import { releaseNangoConnectionIfUnused, saveAdConnections, type RevokeOutcome } from "./connect.js";
import { forgetNangoToken, nangoTokenFor, platformPerson } from "./credentials.js";
import { enqueueAdCatchUp } from "./sync.js";

/** How often a waiting login is asked again; one whose platform didn't answer, sooner. */
export const AD_LOGIN_CHECK_EVERY_MS = 55 * 60_000;
export const AD_LOGIN_RETRY_UNANSWERED_MS = 10 * 60_000;
/** Waiting logins asked per cron tick (each is a few Meta calls). */
export const AD_LOGINS_PER_TICK = 25;

/** The reason an empty account list gives (AdsNoAccountsError's), as a waiting login keeps it. */
export const loginReasonOf = (err: AdsNoAccountsError): AdLoginReason => (err.reason === "none_shared" ? "none_shared" : "no_ads_account");

/** A sign-in to keep waiting for its ad accounts. */
export interface HoldAdLoginInput {
  workspaceId: string;
  storeId: string;
  provider: AdProvider;
  /** The Nango connection that holds the token, and its integration. */
  connectionId: string;
  integrationKey: string;
  externalUserId: string | null;
  loginName: string | null;
  grantedScopes?: string[];
  expiresAt: Date | null;
  /** Who connected it (a member allowed to manage integrations, checked by the caller). */
  userId: string;
  reason: AdLoginReason;
}

/**
 * Keep a sign-in connected while it reaches no ad account: the store's one waiting login for the
 * platform, replacing an older one (whose Nango connection and grant go back unless something else
 * relies on them). Returns the row.
 */
export async function holdAdLogin(input: HoldAdLoginInput, fetchImpl?: FetchLike): Promise<AdLogin> {
  const where = { storeId_provider: { storeId: input.storeId, provider: input.provider } };
  const before = await systemDb.adLogin.findUnique({ where });
  const fields = {
    sourceLoginId: input.connectionId,
    nangoIntegrationKey: input.integrationKey,
    externalUserId: input.externalUserId,
    loginName: input.loginName?.trim().slice(0, 120) || null,
    grantedScopes: (input.grantedScopes ?? []).slice(0, 50),
    accessTokenExpiresAt: input.expiresAt,
    connectedByUserId: input.userId,
    reason: input.reason,
    checkedAt: new Date(),
  };
  const row = await systemDb.adLogin.upsert({ where, create: { workspaceId: input.workspaceId, storeId: input.storeId, provider: input.provider, ...fields }, update: fields });
  if (before && before.sourceLoginId !== input.connectionId) await releaseLoginGrant(before, fetchImpl);
  logger.info({ provider: input.provider, storeId: input.storeId, reason: input.reason, replaced: !!before }, "ads: a login with no ad account yet stays connected");
  return row;
}

/**
 * The Nango connection and grant a waiting login held, once its row is gone: deleted at Nango, the grant
 * taken back, each unless a connection (or another waiting login) still relies on it. Never throws.
 */
async function releaseLoginGrant(row: AdLogin, fetchImpl?: FetchLike): Promise<RevokeOutcome> {
  return releaseNangoConnectionIfUnused({ provider: row.provider as AdProvider, connectionId: row.sourceLoginId, integrationKey: row.nangoIntegrationKey, externalUserId: row.externalUserId }, fetchImpl);
}

/**
 * Let go of waiting logins: rows first, then each one's Nango connection and grant (`release` false:
 * the connection is gone at Nango already, so there is nothing to give back). Returns how many went.
 */
export async function releaseAdLoginsWhere(where: Prisma.AdLoginWhereInput, fetchImpl?: FetchLike, opts: { release?: boolean } = {}): Promise<number> {
  const rows = await systemDb.adLogin.findMany({ where });
  if (!rows.length) return 0;
  await systemDb.adLogin.deleteMany({ where: { id: { in: rows.map((r) => r.id) } } });
  if (opts.release !== false) for (const r of rows) await releaseLoginGrant(r, fetchImpl);
  for (const r of rows) forgetNangoToken(r.sourceLoginId);
  return rows.length;
}

/** Disconnect a waiting login: the row, then its Nango connection and grant (unless something else relies on them). */
export async function releaseAdLogin(row: AdLogin, fetchImpl?: FetchLike): Promise<RevokeOutcome> {
  const { count } = await systemDb.adLogin.deleteMany({ where: { id: row.id } });
  if (!count) return "still_used";
  forgetNangoToken(row.sourceLoginId);
  return releaseLoginGrant(row, fetchImpl);
}

/**
 * Accounts of the platform were just connected to the store: its waiting login is no longer needed. Its
 * Nango connection goes unless the new accounts read through it (connected from this very login).
 */
export async function dropAdLoginOf(storeId: string, provider: AdProvider, fetchImpl?: FetchLike): Promise<void> {
  await releaseAdLoginsWhere({ storeId, provider }, fetchImpl).catch((err: unknown) => logger.warn({ err, provider, storeId }, "ads: a waiting login wasn't let go after its store connected accounts"));
}

/** Whether the person who connected the login may still connect accounts to its store (as mayStillConnect asks of a sign-in). */
async function connectorMayConnect(row: AdLogin): Promise<boolean> {
  if (!row.connectedByUserId) return false;
  const [m, store] = await Promise.all([
    systemDb.membership.findUnique({ where: { workspaceId_userId: { workspaceId: row.workspaceId, userId: row.connectedByUserId } } }),
    systemDb.store.findFirst({ where: { id: row.storeId, workspaceId: row.workspaceId, status: { not: "uninstalled" } }, select: { id: true } }),
  ]);
  return !!m && !!store && memberState(m) === "active" && allows({ role: m.role as Role, permissions: m.permissions }, "integrations.manage");
}

/** What asking the platform again about a waiting login came to. */
export type AdLoginCheck =
  | { outcome: "connected"; connected: number }
  | { outcome: "waiting"; reason: AdLoginReason }
  /** The access ended (the token is gone or refused) or its connector can't connect any more: the login was let go. */
  | { outcome: "ended" }
  /** Another check of the same login is under way. */
  | { outcome: "busy" };

export interface AdLoginDeps {
  coord: Coord;
  queues: Queues;
  fetchImpl?: FetchLike;
}

/**
 * Ask the platform for a waiting login's ad accounts. Some, and not more than AD_LOGIN_AUTO_CONNECT_MAX:
 * connected (each one's catch-up queued) and the login goes. More, or a list cut short: it waits for the
 * person to choose ("choose"; the card's button signs in again for the picker). None: it keeps waiting,
 * with what Meta says now. A token that no longer works, or a connector who can't connect any more: let go.
 * Anything else (Meta busy, Nango not answering): asked again later. Never throws.
 */
export async function checkAdLogin(row: AdLogin, deps: AdLoginDeps, opts: { interactive?: boolean } = {}): Promise<AdLoginCheck> {
  const lock = `ad-login-check:${row.id}`;
  if (!(await deps.coord.acquire(lock, 120_000).catch(() => false))) return { outcome: "busy" };
  try {
    return await checkOnce(row, deps, opts);
  } catch (err) {
    logger.warn({ err, provider: row.provider, storeId: row.storeId }, "ads: a waiting login couldn't be checked; tried again later");
    await touch(row, row.reason as AdLoginReason);
    return { outcome: "waiting", reason: row.reason as AdLoginReason };
  } finally {
    await deps.coord.release(lock).catch(() => undefined);
  }
}

async function touch(row: AdLogin, reason: AdLoginReason, data: Prisma.AdLoginUpdateManyMutationInput = {}) {
  await systemDb.adLogin.updateMany({ where: { id: row.id }, data: { reason, checkedAt: new Date(), ...data } });
}

async function checkOnce(row: AdLogin, deps: AdLoginDeps, opts: { interactive?: boolean }): Promise<AdLoginCheck> {
  const provider = row.provider as AdProvider;
  // Only Meta's sign-ins wait today; any other is left as it is.
  const cfg = provider === "meta" ? metaConfig(deps.fetchImpl) : null;
  if (!cfg) return { outcome: "waiting", reason: row.reason as AdLoginReason };
  if (!(await connectorMayConnect(row))) {
    await releaseAdLogin(row, deps.fetchImpl);
    logger.info({ provider, storeId: row.storeId }, "ads: a waiting login's connector can't connect any more; let go");
    return { outcome: "ended" };
  }
  let accounts: AdAccountList;
  try {
    const { token, expiresAt } = await nangoTokenFor({ connectionId: row.sourceLoginId, integrationKey: row.nangoIntegrationKey }, deps.fetchImpl);
    // Who signed in, when it wasn't learned at the sign-in: their grant is then known to be relied on.
    if (!row.externalUserId) {
      const person = await platformPerson(provider, token, deps.fetchImpl).catch(() => null);
      if (person) await systemDb.adLogin.updateMany({ where: { id: row.id }, data: { externalUserId: person } });
      row = { ...row, externalUserId: person ?? null };
    }
    if (expiresAt) row = { ...row, accessTokenExpiresAt: expiresAt };
    accounts = await metaAdAccounts(cfg, token);
  } catch (err) {
    if (err instanceof AdsNoAccountsError) {
      const reason = loginReasonOf(err);
      await touch(row, reason, err.loginName ? { loginName: err.loginName } : {});
      return { outcome: "waiting", reason };
    }
    if (err instanceof AdsAuthError) {
      await releaseAdLogin(row, deps.fetchImpl);
      logger.info({ provider, storeId: row.storeId }, "ads: a waiting login's access ended; let go");
      return { outcome: "ended" };
    }
    throw err;
  }
  if (accounts.truncated || accounts.length > AD_LOGIN_AUTO_CONNECT_MAX) {
    await touch(row, "choose");
    return { outcome: "waiting", reason: "choose" };
  }
  const saved = await saveAdConnections({
    workspaceId: row.workspaceId,
    storeId: row.storeId,
    provider,
    accounts,
    tokens: { accessToken: row.sourceLoginId, refreshToken: null, expiresAt: row.accessTokenExpiresAt, grantedScopes: row.grantedScopes },
    userId: row.connectedByUserId,
    externalUserId: row.externalUserId,
    sourceLoginId: row.sourceLoginId,
    source: "nango",
    nangoIntegrationKey: row.nangoIntegrationKey,
    fetchImpl: deps.fetchImpl,
  });
  // The accounts read through the login's own connection now: the row goes, the connection and grant stay.
  await systemDb.adLogin.deleteMany({ where: { id: row.id } });
  for (const conn of saved) if (conn.enabled) await enqueueAdCatchUp(deps.queues, conn, { interactive: !!opts.interactive });
  await audit({
    workspaceId: row.workspaceId,
    actorUserId: row.connectedByUserId,
    action: "ads.connected",
    targetType: "store",
    targetId: row.storeId,
    metadata: { provider, accounts: saved.length, source: "nango", via: "waiting_login" },
  }).catch((err: unknown) => logger.warn({ err }, "audit failed"));
  logger.info({ provider, storeId: row.storeId, accounts: saved.length }, "ads: a waiting login's ad accounts appeared and were connected");
  return { outcome: "connected", connected: saved.length };
}

/**
 * The cron tick's pass over waiting logins: each one due (asked over AD_LOGIN_CHECK_EVERY_MS ago, or
 * AD_LOGIN_RETRY_UNANSWERED_MS when the platform didn't answer), oldest first, at most AD_LOGINS_PER_TICK.
 */
export async function checkAdLogins(deps: AdLoginDeps, opts: { now?: number; limit?: number } = {}): Promise<{ checked: number; connected: number; ended: number }> {
  const now = opts.now ?? Date.now();
  const due = await systemDb.adLogin.findMany({
    where: {
      OR: [
        { checkedAt: { lt: new Date(now - AD_LOGIN_CHECK_EVERY_MS) } },
        { reason: "unanswered", checkedAt: { lt: new Date(now - AD_LOGIN_RETRY_UNANSWERED_MS) } },
      ],
    },
    orderBy: { checkedAt: "asc" },
    take: opts.limit ?? AD_LOGINS_PER_TICK,
  });
  const out = { checked: 0, connected: 0, ended: 0 };
  for (const row of due) {
    const r = await checkAdLogin(row, deps);
    if (r.outcome === "busy") continue;
    out.checked++;
    if (r.outcome === "connected") out.connected++;
    if (r.outcome === "ended") out.ended++;
  }
  if (out.connected || out.ended) logger.info(out, "ads: waiting logins checked");
  return out;
}
