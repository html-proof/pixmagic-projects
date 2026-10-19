/**
 * Workspace alerts (the bell and the admins' email) for ad connections that need someone: access that
 * ended or was lost, Meta access about to run out, an account the platform closed or disabled, and
 * syncs that keep failing. One alert per kind and connection (`ads_<kind>:<connection id>`), so each
 * resolves on its own: when its sync works again, when it is connected again, when it is disconnected.
 *
 * Raised by a sweep from what the connections say (whoever marked them: a sync, a live report), which
 * also closes the alerts nothing calls for any more. Problems that are bizinsights' own (AD_ERROR_OURS:
 * not approved, not configured, the daily allowance, internal errors) are never put to merchants;
 * recordAdFailure logs them for the operator.
 */
import { systemDb, type AdConnection } from "@app/db";
import { AD_ERROR_OURS, adErrorMessage, isAdErrorCode, type AdErrorCode, type AdProvider } from "@app/shared";
import { logger } from "../logger.js";
import { raiseAlert, resolveAlerts, type Mailer } from "../notify.js";
import type { FetchLike } from "../shopify.js";

export const AD_ALERT_KINDS = ["ads_reconnect", "ads_expiring", "ads_failing", "ads_unavailable"] as const;
export type AdAlertKind = (typeof AD_ALERT_KINDS)[number];

export const adAlertCode = (kind: AdAlertKind, connectionId: string) => `${kind}:${connectionId}`;

/** Meta access is announced this long before it runs out. */
export const ADS_EXPIRY_WARNING_MS = 7 * 86_400_000;
/** A connection whose syncs keep failing is announced after this long without one that worked, or this many in a row. */
export const ADS_FAILING_AFTER_MS = 24 * 3_600_000;
export const ADS_FAILING_AFTER = 6;

/** Close a connection's open alerts (all its kinds, or those given): whatever they reported is over. */
export async function resolveAdAlerts(conn: Pick<AdConnection, "id" | "storeId">, kinds: readonly AdAlertKind[] = AD_ALERT_KINDS): Promise<number> {
  return resolveAlerts(conn.storeId, kinds.map((k) => adAlertCode(k, conn.id)));
}

type AlertConn = Pick<
  AdConnection,
  "id" | "provider" | "accountId" | "accountName" | "status" | "errorCode" | "accessTokenExpiresAt" | "consecutiveFailures" | "lastSyncedAt" | "createdAt" | "timezone"
>;

export interface AdAlert {
  kind: AdAlertKind;
  severity: "warning";
  /** Shown as is (describeAlert): the app's own wording and the account's name, never a platform's text. */
  message: string;
}

const NOUN: Record<AdProvider, string> = { meta: "Meta ad account", google: "Google Ads account", adsense: "AdSense account" };

/** A code for a status marked before codes were kept (or with one this version doesn't know). */
const CODE_FOR_STATUS: Record<string, AdErrorCode> = { reconnect: "auth_expired", permission: "no_access", unavailable: "account_not_ready", error: "provider_error" };

function day(d: Date, timeZone: string | null): string {
  const opts: Intl.DateTimeFormatOptions = { day: "numeric", month: "long", year: "numeric" };
  try {
    return new Intl.DateTimeFormat("en-GB", { ...opts, timeZone: timeZone || "UTC" }).format(d);
  } catch {
    return new Intl.DateTimeFormat("en-GB", { ...opts, timeZone: "UTC" }).format(d);
  }
}

/** The alerts a connection's state calls for now (none for a working one). */
export function adAlertsFor(c: AlertConn, now = new Date()): AdAlert[] {
  const provider = (c.provider in NOUN ? c.provider : "google") as AdProvider;
  const name = (c.accountName || c.accountId).slice(0, 120);
  const account = `${NOUN[provider]} "${name}"`;
  const code: AdErrorCode = isAdErrorCode(c.errorCode) ? c.errorCode : (CODE_FOR_STATUS[c.status] ?? "provider_error");
  const out: AdAlert[] = [];
  if (AD_ERROR_OURS.has(code) && c.status === "error") {
    // Ours to fix: nothing for the merchant to do.
  } else if (c.status === "reconnect" || c.status === "permission") {
    out.push({ kind: "ads_reconnect", severity: "warning", message: `${account}: ${adErrorMessage(code, provider)}` });
  } else if (c.status === "unavailable") {
    out.push({ kind: "ads_unavailable", severity: "warning", message: `${account}: ${adErrorMessage(code, provider)}` });
  } else if (c.status === "error") {
    const lastGood = c.lastSyncedAt ?? c.createdAt;
    if (c.consecutiveFailures >= ADS_FAILING_AFTER || lastGood.getTime() < now.getTime() - ADS_FAILING_AFTER_MS) {
      const since = c.lastSyncedAt ? `hasn't updated since ${day(c.lastSyncedAt, c.timezone)}` : "hasn't updated yet";
      out.push({ kind: "ads_failing", severity: "warning", message: `${account} ${since}. ${adErrorMessage(code, provider)}` });
    }
  }
  const ends = c.accessTokenExpiresAt?.getTime();
  if (provider === "meta" && (c.status === "active" || c.status === "error") && ends && ends > now.getTime() && ends <= now.getTime() + ADS_EXPIRY_WARNING_MS) {
    out.push({
      kind: "ads_expiring",
      severity: "warning",
      message: `bizinsights' access to the ${account} ends on ${day(c.accessTokenExpiresAt!, c.timezone)}: Meta asks people to sign in again every 60 days or so. Press Reconnect in Settings → Advertising and continue with Facebook to keep the numbers coming.`,
    });
  }
  return out;
}

/**
 * The sweep: raise the alerts connections call for and don't have yet, and close the ones nothing calls
 * for any more (the connection works again, was hidden or disconnected, or its store is gone). Each
 * alert is raised once (raiseAlert de-duplicates open ones), so this is cheap to run on every tick.
 */
export async function sweepAdAlerts(deps: { mailer: Mailer; fetchImpl?: FetchLike }, now = new Date()): Promise<{ raised: number; resolved: number }> {
  const conns = await systemDb.adConnection.findMany({
    where: {
      enabled: true,
      OR: [{ status: { not: "active" } }, { provider: "meta", accessTokenExpiresAt: { gt: now, lte: new Date(now.getTime() + ADS_EXPIRY_WARNING_MS) } }],
    },
    select: {
      id: true, workspaceId: true, storeId: true, provider: true, accountId: true, accountName: true, status: true, errorCode: true,
      accessTokenExpiresAt: true, consecutiveFailures: true, lastSyncedAt: true, createdAt: true, timezone: true,
    },
  });
  const live = new Set(
    (await systemDb.store.findMany({ where: { id: { in: [...new Set(conns.map((c) => c.storeId))] }, status: { not: "uninstalled" } }, select: { id: true } })).map((s) => s.id),
  );
  const wanted = new Map<string, { conn: (typeof conns)[number]; alert: AdAlert }>();
  for (const c of conns) {
    if (!live.has(c.storeId)) continue;
    for (const alert of adAlertsFor(c, now)) wanted.set(adAlertCode(alert.kind, c.id), { conn: c, alert });
  }
  const open = await systemDb.alert.findMany({ where: { resolvedAt: null, code: { startsWith: "ads_" } }, select: { id: true, code: true } });
  const stale = open.filter((a) => !wanted.has(a.code)).map((a) => a.id);
  if (stale.length) await systemDb.alert.updateMany({ where: { id: { in: stale } }, data: { resolvedAt: now } });
  const openCodes = new Set(open.map((a) => a.code));
  let raised = 0;
  for (const [code, { conn, alert }] of wanted) {
    if (openCodes.has(code)) continue;
    try {
      await raiseAlert({ workspaceId: conn.workspaceId, storeId: conn.storeId, severity: alert.severity, code, message: alert.message }, deps.mailer, deps.fetchImpl);
      raised++;
    } catch (err) {
      logger.error({ err, connectionId: conn.id, alertCode: code }, "ad connection alert could not be raised");
    }
  }
  if (raised || stale.length) logger.info({ raised, resolved: stale.length }, "ad connection alerts swept");
  return { raised, resolved: stale.length };
}
