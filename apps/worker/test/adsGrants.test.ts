import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { disconnectDb, systemDb } from "@app/db";
import { resetDb } from "@app/db/testing";
import {
  dropUnusedGrant,
  encryptAdTokens,
  fillAdPersons,
  holdPendingAdConnect,
  memoryCoord,
  reencryptAdTokens,
  releaseUserAdGrants,
  resetEnvCache,
  revokeAdAccessIfUnused,
  saveAdConnections,
  syncAdConnection,
  takePendingAdConnect,
  type FetchLike,
} from "@app/core";

/**
 * Giving access back to Google and Meta: a disconnect revokes unless something else relies on the
 * grant, rows whose person isn't known are looked up rather than blocking every revoke, a sign-in
 * that ended without a connection is dropped safely, and the grants of someone who leaves are
 * released. Plus reconnecting: what it clears.
 */

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

beforeAll(() => {
  Object.assign(process.env, { META_APP_ID: "a", META_APP_SECRET: "s", GOOGLE_ADS_CLIENT_ID: "c", GOOGLE_ADS_CLIENT_SECRET: "cs", GOOGLE_ADS_ENABLED: "1" });
  resetEnvCache();
});
afterAll(async () => disconnectDb());
beforeEach(async () => resetDb());

let n = 0;
async function store() {
  const ws = await systemDb.workspace.create({ data: { name: `W${++n}` } });
  return systemDb.store.create({ data: { workspaceId: ws.id, shopDomain: `g${n}.myshopify.com`, grantedScopes: ["read_orders"], status: "active", timezone: "UTC", pixelIngestKey: `pk-g${n}` } });
}

async function connection(
  provider: "meta" | "google" | "adsense",
  s: { id: string; workspaceId: string },
  t: { access: string; refresh?: string; expiresAt?: Date },
  over: Record<string, unknown> = {},
) {
  const enc = encryptAdTokens(s.id, provider, { accessToken: t.access, refreshToken: provider === "meta" ? null : (t.refresh ?? `R_${t.access}`), expiresAt: t.expiresAt ?? new Date(Date.now() + 3600_000) });
  return systemDb.adConnection.create({ data: { workspaceId: s.workspaceId, storeId: s.id, provider, accountId: `${provider}-${++n}`, currency: "USD", timezone: "UTC", ...enc, ...over } });
}

interface Seen {
  revoked: string[];
  metaRevoked: string[];
  lookups: string[];
}

/** Google's and Meta's endpoints: who each access token belongs to (`people`), revocations recorded. */
function platform(seen: Seen, people: Record<string, string | null | "down">, opts: { refreshFails?: boolean } = {}): FetchLike {
  return async (input, init) => {
    const u = new URL(String(input));
    if (u.host === "oauth2.googleapis.com" && u.pathname === "/tokeninfo") {
      const token = u.searchParams.get("access_token")!;
      seen.lookups.push(token);
      const who = people[token];
      if (who === "down") return json({ error: "backend_error" }, 503);
      return who ? json({ aud: "c", sub: who }) : json({ error: "invalid_token" }, 400);
    }
    if (u.host === "oauth2.googleapis.com" && u.pathname === "/revoke") {
      seen.revoked.push(new URLSearchParams(String(init?.body)).get("token")!);
      return json({});
    }
    if (u.host === "oauth2.googleapis.com" && u.pathname === "/token") {
      if (opts.refreshFails) return json({ error: "invalid_grant", error_description: "Token has been expired or revoked." }, 400);
      return json({ access_token: "FRESH", expires_in: 3599 });
    }
    const token = new Headers(init?.headers).get("authorization")?.replace(/^Bearer /, "") ?? "";
    if (u.pathname.endsWith("/me/permissions/ads_read") && init?.method === "DELETE") {
      seen.metaRevoked.push(token);
      return json({ success: true });
    }
    if (u.pathname.endsWith("/me")) {
      seen.lookups.push(token);
      const who = people[token];
      return who && who !== "down" ? json({ id: who }) : json({ error: { message: "Error validating access token", code: 190 } }, 400);
    }
    return json({ error: { message: `unexpected ${u.host}${u.pathname}` } }, 400);
  };
}

const fresh = (): Seen => ({ revoked: [], metaRevoked: [], lookups: [] });

describe("a disconnect gives the grant back unless something relies on it", () => {
  it("a connection elsewhere whose person isn't known is looked up instead of blocking every revoke", async () => {
    const mine = await connection("google", await store(), { access: "A", refresh: "RA" }, { externalUserId: "1001" });
    // Another merchant's AdSense, connected before bizinsights kept who granted access.
    const other = await connection("adsense", await store(), { access: "B" });
    await systemDb.adConnection.delete({ where: { id: mine.id } });
    const seen = fresh();
    expect(await revokeAdAccessIfUnused(mine, platform(seen, { B: "1002" }))).toBe("revoked");
    expect(seen.revoked).toEqual(["RA"]);
    // It learned its person on the way.
    expect((await systemDb.adConnection.findUniqueOrThrow({ where: { id: other.id } })).externalUserId).toBe("1002");
  });

  it("keeps the grant when the unknown person turns out to be the same one, or can't be looked up", async () => {
    const mine = await connection("google", await store(), { access: "A", refresh: "RA" }, { externalUserId: "1001" });
    const other = await connection("adsense", await store(), { access: "B" });
    await systemDb.adConnection.delete({ where: { id: mine.id } });
    const down = fresh();
    expect(await revokeAdAccessIfUnused(mine, platform(down, { B: "down" }))).toBe("still_used");
    expect(down.revoked).toEqual([]);
    const same = fresh();
    expect(await revokeAdAccessIfUnused(mine, platform(same, { B: "1001" }))).toBe("still_used");
    expect(same.revoked).toEqual([]);
    expect((await systemDb.adConnection.findUniqueOrThrow({ where: { id: other.id } })).externalUserId).toBe("1001");
  });

  it("a connection waiting for a reconnect holds no grant, and a dead token's row is marked so on the way", async () => {
    const mine = await connection("meta", await store(), { access: "MA" }, { externalUserId: "2001" });
    await connection("meta", await store(), { access: "MB" }, { status: "reconnect", errorCode: "auth_expired" });
    // Unknown person, and its token has run out: it can't be relying on anything.
    const expired = await connection("meta", await store(), { access: "MC", expiresAt: new Date(Date.now() - 1000) });
    await systemDb.adConnection.delete({ where: { id: mine.id } });
    const seen = fresh();
    expect(await revokeAdAccessIfUnused(mine, platform(seen, {}))).toBe("revoked");
    expect(seen.metaRevoked).toEqual(["MA"]);
    expect(seen.lookups).toEqual([]);
    expect(await systemDb.adConnection.findUniqueOrThrow({ where: { id: expired.id } })).toMatchObject({ status: "reconnect", errorCode: "auth_expired" });
  });
});

describe("a sign-in that ended without a connection", () => {
  const tokens = (refresh: string | null = "R_NEW") => ({ accessToken: "NEW", refreshToken: refresh, expiresAt: null });

  it("is revoked only when it's known whose it is and nothing else could rely on it", async () => {
    const seen = fresh();
    const f = platform(seen, {});
    expect(await dropUnusedGrant("google", tokens(), null, f)).toBe("unknown_person");
    // Google sent no refresh token: the person gave one before, which may be in use.
    expect(await dropUnusedGrant("google", tokens(null), "1005", f)).toBe("still_used");
    // The refresh token was the one their other connections use.
    expect(await dropUnusedGrant("google", tokens(), "1005", f, { reusedRefreshToken: true })).toBe("still_used");
    // A connection of theirs exists.
    await connection("adsense", await store(), { access: "X" }, { externalUserId: "1005" });
    expect(await dropUnusedGrant("google", tokens(), "1005", f)).toBe("still_used");
    expect(seen.revoked).toEqual([]);
    // Nobody's: revoked (the refresh token ends the access tokens too).
    expect(await dropUnusedGrant("google", tokens(), "1006", f)).toBe("revoked");
    expect(seen.revoked).toEqual(["R_NEW"]);
    expect(await dropUnusedGrant("meta", { accessToken: "META_NEW", refreshToken: null, expiresAt: null }, "2006", f)).toBe("revoked");
    expect(seen.metaRevoked).toEqual(["META_NEW"]);
  });

  it("leaves the grant while the same person has another account choice waiting", async () => {
    const coord = memoryCoord();
    const s = await store();
    const hold = (nonce: string) =>
      holdPendingAdConnect(coord, nonce, { userId: "u", workspaceId: s.workspaceId, storeId: s.id, provider: "google", accounts: [], tokens: tokens(), externalUserId: "1007" });
    await hold("first");
    await hold("second");
    const seen = fresh();
    // "Cancel" on the first: the second still needs the grant.
    await takePendingAdConnect(coord, "first");
    expect(await dropUnusedGrant("google", tokens(), "1007", platform(seen, {}), { coord, exceptPending: "first" })).toBe("still_used");
    // Once that one is gone too, nothing is waiting.
    await takePendingAdConnect(coord, "second");
    expect(await dropUnusedGrant("google", tokens(), "1007", platform(seen, {}), { coord, exceptPending: "second" })).toBe("revoked");
  });
});

describe("someone who leaves", () => {
  it("their connections stop using their grant: tokens deleted, waiting for a reconnect, days kept; the grant is revoked when unused", async () => {
    const s = await store();
    const enc = encryptAdTokens(s.id, "google", { accessToken: "UA", refreshToken: "URA", expiresAt: new Date(Date.now() + 3600_000) });
    const base = { workspaceId: s.workspaceId, storeId: s.id, provider: "google", currency: "USD", timezone: "UTC", connectedByUserId: "user-1", externalUserId: "1100", ...enc };
    const a = await systemDb.adConnection.create({ data: { ...base, accountId: "111" } });
    await systemDb.adConnection.create({ data: { ...base, accountId: "222" } });
    await systemDb.adCampaignDaily.create({ data: { workspaceId: s.workspaceId, storeId: s.id, connectionId: a.id, provider: "google", accountId: "111", campaignId: "1", campaignName: "C", day: "2026-10-01", spend: 5 } });
    // Their Meta connection in another workspace, and someone else's.
    const elsewhere = await connection("meta", await store(), { access: "UM" }, { connectedByUserId: "user-1", externalUserId: "2100" });
    const someoneElse = await connection("google", s, { access: "OA", refresh: "ORA" }, { connectedByUserId: "user-2", externalUserId: "1200" });

    const seen = fresh();
    expect(await releaseUserAdGrants("user-1", s.workspaceId, platform(seen, {}))).toEqual({ released: 2, outcomes: ["revoked"] });
    expect(seen.revoked).toEqual(["URA"]);
    const released = await systemDb.adConnection.findMany({ where: { storeId: s.id, connectedByUserId: null }, orderBy: { accountId: "asc" } });
    expect(released.map((r) => [r.accountId, r.status, r.errorCode, r.accessTokenEnc, r.refreshTokenEnc, r.externalUserId])).toEqual([
      ["111", "reconnect", "connector_left", "", null, null],
      ["222", "reconnect", "connector_left", "", null, null],
    ]);
    expect(await systemDb.adCampaignDaily.count({ where: { connectionId: a.id } })).toBe(1);
    expect((await systemDb.adConnection.findUniqueOrThrow({ where: { id: someoneElse.id } })).status).toBe("active");
    expect((await systemDb.adConnection.findUniqueOrThrow({ where: { id: elsewhere.id } })).accessTokenEnc).not.toBe("");
    // A sync queued before skips it; key rotation leaves it alone.
    expect(await syncAdConnection(a.id, "2026-10-01", "2026-10-02", platform(fresh(), {}))).toEqual({ skipped: true, reason: "no_token" });
    expect(await reencryptAdTokens()).toBe(0);

    // Their account is deleted: everywhere else too.
    const all = fresh();
    expect(await releaseUserAdGrants("user-1", undefined, platform(all, {}))).toEqual({ released: 1, outcomes: ["revoked"] });
    expect(all.metaRevoked).toEqual(["UM"]);
  });

  it("a grant another connection still relies on is kept", async () => {
    const s = await store();
    await connection("google", s, { access: "UA", refresh: "URA" }, { connectedByUserId: "user-1", externalUserId: "1100" });
    // The same Google account connected to another store by a colleague.
    await connection("adsense", await store(), { access: "CA" }, { connectedByUserId: "user-2", externalUserId: "1100" });
    const seen = fresh();
    expect(await releaseUserAdGrants("user-1", undefined, platform(seen, {}))).toEqual({ released: 1, outcomes: ["still_used"] });
    expect(seen.revoked).toEqual([]);
  });
});

describe("filling in who granted access (ops:ad-persons)", () => {
  it("looks each unknown sign-in up once, marks dead tokens for a reconnect, and finds nothing to do the second time", async () => {
    const meta = await connection("meta", await store(), { access: "MX" });
    const dead = await connection("google", await store(), { access: "GX", expiresAt: new Date(Date.now() - 1000) });
    const seen = fresh();
    expect(await fillAdPersons({ fetchImpl: platform(seen, { MX: "2042" }, { refreshFails: true }) })).toEqual({ learned: 1, ended: 1, unknown: 0, remaining: 0 });
    expect((await systemDb.adConnection.findUniqueOrThrow({ where: { id: meta.id } })).externalUserId).toBe("2042");
    expect(await systemDb.adConnection.findUniqueOrThrow({ where: { id: dead.id } })).toMatchObject({ status: "reconnect", errorCode: "auth_expired" });
    expect(await fillAdPersons({ fetchImpl: platform(fresh(), {}) })).toEqual({ learned: 0, ended: 0, unknown: 0, remaining: 0 });
  });
});

describe("connecting an account again", () => {
  it("clears what it waited for (status, code, failures) and closes its alerts", async () => {
    const s = await store();
    const conn = await connection("meta", s, { access: "OLD" }, { accountId: "act_9", status: "reconnect", errorCode: "auth_expired", lastError: "Session has expired", consecutiveFailures: 7 });
    await systemDb.alert.create({ data: { workspaceId: s.workspaceId, storeId: s.id, severity: "warning", code: `ads_reconnect:${conn.id}`, message: "m" } });
    const [saved] = await saveAdConnections({
      workspaceId: s.workspaceId,
      storeId: s.id,
      provider: "meta",
      accounts: [{ accountId: "act_9", name: "Shop ads", currency: "USD", timezone: "UTC", status: "payment_issue", statusDetail: "Because of a payment problem" }],
      tokens: { accessToken: "NEW", refreshToken: null, expiresAt: null },
      userId: "user-1",
      externalUserId: "2001",
    });
    expect(saved).toMatchObject({ id: conn.id, isNew: false, status: "active", errorCode: null, lastError: null, consecutiveFailures: 0, accountStatus: "payment_issue" });
    expect(await systemDb.alert.count({ where: { resolvedAt: null } })).toBe(0);
  });
});
