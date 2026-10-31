import { afterAll, it } from "vitest";
import { AD_HEALTH_FAILING_FROM, adConnectionHealth, type AdHealthConnection } from "@app/core";
import { disconnectDb } from "@app/db";

/**
 * How the ad connections stand (packages/core/src/adConnections/health.ts): per platform and status,
 * the ones that stopped syncing or keep failing, the last day's syncs, and which platforms can be
 * connected. Reads only. Ids and counts, never a token, an email or an account's name.
 *   pnpm --filter @app/worker ops:ad-health
 */
afterAll(async () => disconnectDb());

const when = (d: Date | null) => (d ? d.toISOString() : "never");
const line = (c: AdHealthConnection) =>
  `  ${c.provider} ${c.accountId} (connection ${c.id}, workspace ${c.workspaceId}, store ${c.storeId}): ` +
  `last sync ${when(c.lastSyncedAt)}, last attempt ${when(c.lastSyncAttemptAt)}, ${c.consecutiveFailures} failures in a row${c.errorCode ? `, ${c.errorCode}` : ""}`;
const flags = (r: Record<string, boolean> | null) => (r ? Object.entries(r).map(([k, v]) => `${k} ${v ? "yes" : "no"}`).join(", ") : "not asked");

it("says how the ad connections stand", async () => {
  const r = await adConnectionHealth();
  console.log(`Ad connections at ${r.at.toISOString()}`);
  for (const g of r.connections) console.log(`  ${g.provider} · ${g.status}: ${g.count}`);
  if (!r.connections.length) console.log("  none");
  console.log(`Error codes: ${r.errorCodes.length ? r.errorCodes.map((g) => `${g.errorCode} ${g.count}`).join(", ") : "none"}`);
  console.log(`Waiting for a reconnect: ${r.waitingForReconnect}`);
  console.log(`No successful sync for a day (${r.stale.length}${r.stale.length === 50 ? "+" : ""}):`);
  for (const c of r.stale) console.log(line(c));
  console.log(`Failing ${AD_HEALTH_FAILING_FROM}+ syncs in a row (${r.failing.length}${r.failing.length === 50 ? "+" : ""}):`);
  for (const c of r.failing) console.log(line(c));
  console.log(`Syncs in the last 24 hours: ${r.syncs.byOutcome.map((g) => `${g.outcome} ${g.count}`).join(", ") || "none"}`);
  for (const g of r.syncs.byProvider) console.log(`  ${g.provider} ${g.outcome}: ${g.count}`);
  if (r.syncs.failureReasons.length) console.log(`  why they failed: ${r.syncs.failureReasons.map((g) => `${g.reason} ${g.count}`).join(", ")}`);
  console.log(`Offered here: ${flags(r.configured)}`);
});
