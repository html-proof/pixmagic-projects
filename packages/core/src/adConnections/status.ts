/**
 * What a failed sync or live report leaves on its connection: the status, the code the settings pages
 * word, and the platform's own reason, cleaned (classifyAdError in ads/common.ts). The one place both
 * write it, so a connection is marked the same way whichever found the problem.
 */
import { systemDb } from "@app/db";
import type { AdFailure } from "../ads.js";

/**
 * A sync's failure is always recorded, and counts toward failures in a row. A live report's only when it
 * says something lasting (access ended, lost, the account gone): a report that met a rate limit or an
 * outage says nothing about the stored days, so a working connection stays as it is.
 */
export async function recordAdFailure(connectionId: string, f: AdFailure, from: "sync" | "report"): Promise<void> {
  if (from === "report" && f.status === "error") return;
  await systemDb.adConnection.updateMany({
    where: { id: connectionId },
    data: { status: f.status, errorCode: f.code, lastError: f.detail, ...(from === "sync" ? { consecutiveFailures: { increment: 1 } } : {}) },
  });
}
