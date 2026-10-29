import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { disconnectDb, systemDb } from "@app/db";
import { resetDb } from "@app/db/testing";
import { adConnectionHealth, encryptAdTokens, encryptLoginToken, resetEnvCache } from "@app/core";

/**
 * The operator's report on the ad connections (ops:ad-health, packages/core/src/adConnections/health.ts):
 * how many per platform and status, which stopped syncing or keep failing, the last day's syncs, which
 * platforms can be connected, and nothing a customer would mind being pasted into a ticket.
 */

const ENV = { META_APP_ID: "a", META_APP_SECRET: "s", GOOGLE_ADS_CLIENT_ID: "c", GOOGLE_ADS_CLIENT_SECRET: "cs", GOOGLE_ADS_ENABLED: "1" };
const HOUR = 3600_000;
const NOW = new Date("2026-10-24T12:00:00Z");
const ago = (h: number) => new Date(NOW.getTime() - h * HOUR);

beforeAll(() => {
  Object.assign(process.env, ENV);
  resetEnvCache();
});
afterAll(async () => disconnectDb());
beforeEach(async () => {
  await resetDb();
  Object.assign(process.env, ENV);
  resetEnvCache();
});

let k = 0;
async function store() {
  const user = await systemDb.user.create({ data: { email: `owner-health${++k}@example.com` } });
  const ws = await systemDb.workspace.create({ data: { name: `Health ${k}` } });
  const s = await systemDb.store.create({ data: { workspaceId: ws.id, shopDomain: `h${k}.myshopify.com`, grantedScopes: ["read_orders"], status: "active", timezone: "UTC", pixelIngestKey: `pk-h${k}` } });
  return { ...s, userId: user.id };
}

async function connection(provider: "meta" | "google" | "adsense", s: { id: string; workspaceId: string; userId: string }, accountId: string, over: Record<string, unknown> = {}) {
  const enc = encryptAdTokens(s.id, provider, { accessToken: `TOKEN_${accountId}`, refreshToken: provider === "meta" ? null : `REFRESH_${accountId}`, expiresAt: new Date(NOW.getTime() + HOUR) });
  return systemDb.adConnection.create({
    data: { workspaceId: s.workspaceId, storeId: s.id, provider, accountId, accountName: `Secret name ${accountId}`, currency: "USD", timezone: "UTC", connectedByUserId: s.userId, createdAt: ago(48), ...enc, ...over },
  });
}

async function run(connectionId: string, s: { id: string; workspaceId: string }, provider: string, outcome: string, startedAt: Date, reason: string | null = null) {
  await systemDb.adSyncRun.create({ data: { workspaceId: s.workspaceId, storeId: s.id, connectionId, provider, source: "direct", trigger: "schedule", outcome, reason, rows: 3, startedAt, finishedAt: startedAt } });
}

/** A Meta login waiting for its ad accounts, holding its own token. */
async function waitingLogin(s: { id: string; workspaceId: string; userId: string }) {
  return systemDb.adLogin.create({
    data: { workspaceId: s.workspaceId, storeId: s.id, provider: "meta", reason: "no_ads_account", connectedByUserId: s.userId, ...encryptLoginToken(s.id, "meta", "LOGIN_TOKEN") },
  });
}

describe("the ad connections' health report", () => {
  it("counts, lists what stopped syncing or keeps failing, and sums up the last day's syncs", async () => {
    const s = await store();
    const ok = await connection("meta", s, "act_1", { lastSyncedAt: ago(1), lastSyncAttemptAt: ago(1) });
    const stale = await connection("google", s, "111", { lastSyncedAt: ago(30), lastSyncAttemptAt: ago(2), consecutiveFailures: 1 });
    const failing = await connection("google", s, "222", { lastSyncedAt: ago(3), consecutiveFailures: 4, status: "error", errorCode: "temporarily_unavailable" });
    const neverSynced = await connection("adsense", s, "pub-1", { createdAt: ago(2) });
    // Not listed as stale: hidden, waiting for a reconnect, or connected a moment ago.
    await connection("google", s, "333", { enabled: false, lastSyncedAt: ago(100) });
    await connection("meta", s, "act_9", { status: "reconnect", errorCode: "auth_expired", lastSyncedAt: ago(100) });
    await connection("adsense", s, "pub-2", { createdAt: new Date(NOW.getTime() - 10 * 60_000) });
    // A person who left: no token, waiting for someone else to reconnect.
    await connection("meta", s, "act_8", { accessTokenEnc: "", status: "reconnect", errorCode: "connector_left" });
    await run(ok.id, s, "meta", "synced", ago(2));
    await run(stale.id, s, "google", "failed", ago(2), "rate_limited");
    await run(failing.id, s, "google", "failed", ago(3), "temporarily_unavailable");
    await run(failing.id, s, "google", "failed", ago(4), "temporarily_unavailable");
    await run(ok.id, s, "meta", "synced", ago(30));

    const r = await adConnectionHealth({ now: NOW });

    expect(r.connections).toEqual([
      { provider: "adsense", status: "active", count: 2 },
      { provider: "google", status: "active", count: 2 },
      { provider: "google", status: "error", count: 1 },
      { provider: "meta", status: "active", count: 1 },
      { provider: "meta", status: "reconnect", count: 2 },
    ]);
    expect(r.errorCodes).toEqual([
      { errorCode: "auth_expired", count: 1 },
      { errorCode: "connector_left", count: 1 },
      { errorCode: "temporarily_unavailable", count: 1 },
    ]);
    expect(r.waitingForReconnect).toBe(2);
    expect(r.stale.map((c) => c.id)).toEqual([neverSynced.id, stale.id]);
    expect(r.stale[1]).toEqual({
      id: stale.id,
      provider: "google",
      accountId: "111",
      workspaceId: s.workspaceId,
      storeId: s.id,
      status: "active",
      errorCode: null,
      lastSyncedAt: ago(30),
      lastSyncAttemptAt: ago(2),
      consecutiveFailures: 1,
    });
    expect(r.failing.map((c) => [c.id, c.consecutiveFailures, c.errorCode])).toEqual([[failing.id, 4, "temporarily_unavailable"]]);
    expect(r.syncs).toEqual({
      byOutcome: [
        { outcome: "failed", count: 3 },
        { outcome: "synced", count: 1 },
      ],
      byProvider: [
        { provider: "google", outcome: "failed", count: 3 },
        { provider: "meta", outcome: "synced", count: 1 },
      ],
      failureReasons: [
        { reason: "temporarily_unavailable", count: 2 },
        { reason: "rate_limited", count: 1 },
      ],
    });
    // What a card offers Connect for: each platform's own app is set up here.
    expect(r.configured).toEqual({ meta: true, google: true, adsense: true });
  });

  it("carries no token, ciphertext, email or account name", async () => {
    const s = await store();
    const google = await connection("google", s, "111", { lastSyncedAt: ago(30) });
    const meta = await connection("meta", s, "act_1", { consecutiveFailures: 5 });
    const login = await waitingLogin(await store());
    const text = JSON.stringify(await adConnectionHealth({ now: NOW }));
    for (const secret of [
      "TOKEN_111",
      "REFRESH_111",
      "TOKEN_act_1",
      "LOGIN_TOKEN",
      google.accessTokenEnc,
      google.refreshTokenEnc!,
      meta.accessTokenEnc,
      login.accessTokenEnc,
      "owner-health",
      "@example.com",
      "Secret name",
    ]) {
      expect(text, secret).not.toContain(secret);
    }
    // What it is for is there.
    expect(text).toContain(google.id);
    expect(text).toContain(meta.id);
    expect(text).not.toContain(login.id);
  });

  it("says which platforms can be connected here", async () => {
    Object.assign(process.env, { GOOGLE_ADS_ENABLED: "", META_APP_SECRET: "" });
    resetEnvCache();
    await connection("adsense", await store(), "pub-1");
    const r = await adConnectionHealth({ now: NOW });
    // Google Ads waits for its switch, Meta for its secret; AdSense needs only the Google client.
    expect(r.configured).toEqual({ meta: false, google: false, adsense: true });
  });
});
