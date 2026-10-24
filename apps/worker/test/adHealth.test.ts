import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { disconnectDb, systemDb } from "@app/db";
import { resetDb } from "@app/db/testing";
import { adConnectionHealth, encryptAdTokens, memoryCoord, resetEnvCache, type FetchLike } from "@app/core";

/**
 * The operator's report on the ad connections (ops:ad-health, packages/core/src/adConnections/health.ts):
 * how many per platform, source and status, what is left to move to Nango, which stopped syncing or keep
 * failing, the last day's syncs, Nango's set-up, and nothing a customer would mind being pasted into a ticket.
 */

const NANGO_KEY = "nango-secret-0123456789abcdef0123456789";
const ENV = { META_APP_ID: "a", META_APP_SECRET: "s", GOOGLE_ADS_CLIENT_ID: "c", GOOGLE_ADS_CLIENT_SECRET: "cs", GOOGLE_ADS_ENABLED: "1", NANGO_SECRET_KEY: NANGO_KEY, NANGO_PROVIDERS: "meta,google,adsense" };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
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
  await systemDb.adSyncRun.create({ data: { workspaceId: s.workspaceId, storeId: s.id, connectionId, provider, source: "nango", trigger: "schedule", outcome, reason, rows: 3, startedAt, finishedAt: startedAt } });
}

/** Nango holding the Meta and AdSense integrations only. */
const nangoFetch: FetchLike = async (input) => {
  const u = new URL(String(input));
  if (u.host === "api.nango.dev" && u.pathname === "/integrations") {
    return json({ data: [{ unique_key: "bizinsights-meta-ads", provider: "facebook" }, { unique_key: "bizinsights-google-adsense", provider: "google" }] });
  }
  return json({ error: { code: "not_found" } }, 404);
};

describe("the ad connections' health report", () => {
  it("counts, lists what stopped syncing or keeps failing, sums up the last day's syncs, and says how Nango stands", async () => {
    const s = await store();
    const ok = await connection("meta", s, "act_1", { source: "nango", sourceLoginId: "NANGO-CONN-SECRET-ID", lastSyncedAt: ago(1), lastSyncAttemptAt: ago(1) });
    const stale = await connection("google", s, "111", { lastSyncedAt: ago(30), lastSyncAttemptAt: ago(2), consecutiveFailures: 1 });
    const failing = await connection("google", s, "222", { lastSyncedAt: ago(3), consecutiveFailures: 4, status: "error", errorCode: "temporarily_unavailable" });
    const neverSynced = await connection("adsense", s, "pub-1", { createdAt: ago(2) });
    // Not listed as stale: hidden, waiting for a reconnect, or connected a moment ago.
    await connection("google", s, "333", { enabled: false, lastSyncedAt: ago(100) });
    await connection("meta", s, "act_9", { status: "reconnect", errorCode: "auth_expired", lastSyncedAt: ago(100) });
    await connection("adsense", s, "pub-2", { createdAt: new Date(NOW.getTime() - 10 * 60_000) });
    // A person who left: no token, so nothing left to move.
    await connection("meta", s, "act_8", { accessTokenEnc: "", status: "reconnect", errorCode: "connector_left" });
    await run(ok.id, s, "meta", "synced", ago(2));
    await run(stale.id, s, "google", "failed", ago(2), "rate_limited");
    await run(failing.id, s, "google", "failed", ago(3), "temporarily_unavailable");
    await run(failing.id, s, "google", "failed", ago(4), "temporarily_unavailable");
    await run(ok.id, s, "meta", "synced", ago(30));

    const r = await adConnectionHealth({ coord: memoryCoord(), fetchImpl: nangoFetch, now: NOW });

    expect(r.connections).toEqual([
      { provider: "adsense", source: "direct", status: "active", count: 2 },
      { provider: "google", source: "direct", status: "active", count: 2 },
      { provider: "google", source: "direct", status: "error", count: 1 },
      { provider: "meta", source: "direct", status: "reconnect", count: 2 },
      { provider: "meta", source: "nango", status: "active", count: 1 },
    ]);
    expect(r.errorCodes).toEqual([
      { errorCode: "auth_expired", count: 1 },
      { errorCode: "connector_left", count: 1 },
      { errorCode: "temporarily_unavailable", count: 1 },
    ]);
    // Every direct row with a token: the two Google and two AdSense ones, the hidden one, and act_9 (its token is still held).
    expect(r.directLeft).toBe(6);
    expect(r.waitingForReconnect).toBe(2);
    expect(r.stale.map((c) => c.id)).toEqual([neverSynced.id, stale.id]);
    expect(r.stale[1]).toEqual({
      id: stale.id,
      provider: "google",
      accountId: "111",
      workspaceId: s.workspaceId,
      storeId: s.id,
      source: "direct",
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
    expect(r.nango).toEqual({ keySet: true, providers: { meta: true, google: true, adsense: true }, connectable: { meta: true, google: false, adsense: true } });
  });

  it("carries no token, ciphertext, Nango connection id, email or account name", async () => {
    const s = await store();
    const direct = await connection("google", s, "111", { lastSyncedAt: ago(30) });
    const nango = await connection("meta", s, "act_1", { source: "nango", sourceLoginId: "NANGO-CONN-SECRET-ID", consecutiveFailures: 5 });
    const text = JSON.stringify(await adConnectionHealth({ coord: memoryCoord(), fetchImpl: nangoFetch, now: NOW }));
    for (const secret of ["TOKEN_111", "REFRESH_111", "TOKEN_act_1", direct.accessTokenEnc, direct.refreshTokenEnc!, nango.accessTokenEnc, "NANGO-CONN-SECRET-ID", "owner-health", "@example.com", "Secret name", NANGO_KEY]) {
      expect(text, secret).not.toContain(secret);
    }
    // What it is for is there.
    expect(text).toContain(direct.id);
    expect(text).toContain(nango.id);
  });

  it("asks Nango only with a coordinator, and says what a card would offer when Nango doesn't answer or the key is missing", async () => {
    expect((await adConnectionHealth({ now: NOW })).nango.connectable).toBeNull();
    const down: FetchLike = async () => {
      throw new TypeError("fetch failed");
    };
    // Nango not answering offers the listed platforms (connectableAdProviders' own rule); a refused key offers none.
    expect((await adConnectionHealth({ coord: memoryCoord(), fetchImpl: down, now: NOW })).nango.connectable).toEqual({ meta: true, google: true, adsense: true });
    Object.assign(process.env, { NANGO_SECRET_KEY: "" });
    resetEnvCache();
    expect((await adConnectionHealth({ coord: memoryCoord(), fetchImpl: nangoFetch, now: NOW })).nango).toEqual({
      keySet: false,
      providers: { meta: false, google: false, adsense: false },
      connectable: { meta: false, google: false, adsense: false },
    });
  });
});
