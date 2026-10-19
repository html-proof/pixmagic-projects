/**
 * What a failed sync or live report leaves on its connection: the status, the code the settings pages
 * word, and the platform's own reason, cleaned (classifyAdError in ads/common.ts). The one place both
 * write it, so a connection is marked the same way whichever found the problem.
 */
import { systemDb } from "@app/db";
import { AD_ERROR_OURS } from "@app/shared";
import type { AdFailure } from "../ads.js";
import { logger } from "../logger.js";

/**
 * A sync's failure is always recorded, and counts toward failures in a row. A live report's only when it
 * says something lasting (access ended, lost, the account gone): a report that met a rate limit or an
 * outage says nothing about the stored days, so a working connection stays as it is.
 *
 * A passing problem ("error") never overwrites a lasting one: an account waiting for a reconnect stays
 * waiting, whatever a later attempt met. Nor does anything overwrite "connector_left": only connecting
 * again ends that. Google's daily allowance running out is bizinsights' own limit, not the account's,
 * so it isn't counted as one of its failures.
 */
export async function recordAdFailure(connectionId: string, f: AdFailure, from: "sync" | "report"): Promise<void> {
  if (from === "report" && f.status === "error") return;
  if (AD_ERROR_OURS.has(f.code)) {
    // Ours to fix, not the merchant's: the operator hears of it here (no merchant alert is raised for these).
    logger.error({ connectionId, errorCode: f.code, detail: f.detail, from }, "ad connection failing on our side");
  }
  const counts = from === "sync" && f.code !== "quota_exhausted";
  const { count } = await systemDb.adConnection.updateMany({
    where: {
      id: connectionId,
      OR: [{ errorCode: null }, { errorCode: { not: "connector_left" } }],
      ...(f.status === "error" ? { status: { in: ["active", "error"] } } : {}),
    },
    data: {
      status: f.status,
      errorCode: f.code,
      lastError: f.detail,
      ...(counts ? { consecutiveFailures: { increment: 1 } } : {}),
      // The sync someone asked for has ended, if not well: the card stops saying "Synchronizing".
      ...(from === "sync" ? { syncRequestedAt: null } : {}),
    },
  });
  // A sync that found nothing to mark (a lasting state already stands) still ends the wait for it.
  if (!count && from === "sync") await systemDb.adConnection.updateMany({ where: { id: connectionId, syncRequestedAt: { not: null } }, data: { syncRequestedAt: null } });
}
