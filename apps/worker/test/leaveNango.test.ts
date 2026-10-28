import { createHmac } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { disconnectDb, systemDb, type AdConnection } from "@app/db";
import { resetDb } from "@app/db/testing";
import {
  adAccessToken,
  encryptAdTokens,
  encryptLoginToken,
  isNangoLogin,
  keyring,
  leaveNango,
  logger,
  memoryCoord,
  MOVE_RETRY_S,
  nangoCredential,
  reencryptAdLoginTokens,
  resetEnvCache,
  type FetchLike,
} from "@app/core";
import { decrypt } from "@app/shared";
import { testEnv } from "../../../test-support/env.js";
import { moveAdConnectionsOffNango } from "../src/handlers.js";

/**
 * Leaving Nango (packages/core/src/adConnections/leaveNango.ts): the connections made through Nango
 * between 2026-10-22 and 2026-10-28 (`source` "nango", and waiting logins naming a Nango connection)
 * get their tokens read from Nango once, tried without Nango, sealed on bizinsights' own rows
 * (`source` "direct"), and the connection is deleted at Nango, without the merchant doing anything.
 * Nango, Meta and Google are fakes shaped like their APIs.
 */

const NANGO_KEY = "nango-secret-0123456789abcdef0123456789";
const ENV = { META_APP_ID: "meta_app", META_APP_SECRET: "meta_secret", GOOGLE_ADS_CLIENT_ID: "g_client", GOOGLE_ADS_CLIENT_SECRET: "g_secret", GOOGLE_ADS_ENABLED: "1", NANGO_SECRET_KEY: NANGO_KEY };
const KEY = { meta: "bizinsights-meta-ads", google: "bizinsights-google-ads", adsense: "bizinsights-google-adsense" } as const;
type Provider = keyof typeof KEY;
const META_ENDS = "2026-12-20T00:00:00.000Z";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

interface HeldAtNango {
  key: string;
  token: string;
  refreshToken?: string | null;
  expiresAt?: string | null;
}

interface World {
  fetchImpl: FetchLike;
  /** The connections bizinsights' Nango environment holds. */
  nango: Map<string, HeldAtNango>;
  /** GET /connections/:id, with what was asked. */
  reads: Array<{ id: string; key: string | null; refreshToken: string | null }>;
  deleted: string[];
  /** Every Nango answer is this status instead (an outage, a refused key). */
  nangoStatus?: number;
  /** Runs while Nango answers a read (to change the rows meanwhile, as a reconnect would). */
  onRead?: () => Promise<void>;
  /** Google's token endpoint: the refresh tokens it was asked to renew, and whether it refuses them. */
  googleRefreshes: Array<{ token: string; clientId: string | null }>;
  googleRefuses?: boolean;
  /** The tokens Meta's /me was asked with (each signed with bizinsights' own app secret). */
  metaMe: string[];
  metaRefuses?: boolean;
}

function world(): World {
  const w: World = {
    nango: new Map(),
    reads: [],
    deleted: [],
    googleRefreshes: [],
    metaMe: [],
    fetchImpl: async (input, init) => {
      const u = new URL(String(input));
      const method = init?.method ?? "GET";
      if (u.host === "api.nango.dev") {
        expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${NANGO_KEY}`);
        if (w.nangoStatus) return json({ error: { code: w.nangoStatus === 401 ? "unauthorized" : "server_error", message: "nope" } }, w.nangoStatus);
        const one = /^\/connections\/([^/]+)$/.exec(u.pathname);
        const id = one ? decodeURIComponent(one[1]!) : "";
        const c = w.nango.get(id);
        if (!one || !c || c.key !== u.searchParams.get("provider_config_key")) return json({ error: { code: "not_found", message: "Connection not found" } }, 404);
        if (method === "DELETE") {
          w.deleted.push(id);
          w.nango.delete(id);
          return json({ success: true });
        }
        w.reads.push({ id, key: u.searchParams.get("provider_config_key"), refreshToken: u.searchParams.get("refresh_token") });
        await w.onRead?.();
        return json({
          connection_id: id,
          provider_config_key: c.key,
          credentials: { type: "OAUTH2", access_token: c.token, ...(c.refreshToken ? { refresh_token: c.refreshToken } : {}), ...(c.expiresAt ? { expires_at: c.expiresAt } : {}), raw: {} },
        });
      }
      if (u.host === "graph.facebook.com" && u.pathname.endsWith("/me")) {
        const token = new Headers(init?.headers).get("authorization")?.replace(/^Bearer /, "") ?? "";
        // Without Nango: signed with bizinsights' own app secret, as every Meta call is.
        expect(u.searchParams.get("appsecret_proof")).toBe(createHmac("sha256", ENV.META_APP_SECRET).update(token).digest("hex"));
        w.metaMe.push(token);
        if (w.metaRefuses) return json({ error: { message: "Error validating access token: The user has not authorized application", type: "OAuthException", code: 190 } }, 400);
        return json({ id: "4242" });
      }
      if (u.host === "oauth2.googleapis.com" && u.pathname === "/token") {
        const form = new URLSearchParams(String(init?.body));
        w.googleRefreshes.push({ token: form.get("refresh_token")!, clientId: form.get("client_id") });
        if (w.googleRefuses) return json({ error: "invalid_grant", error_description: "Token has been expired or revoked." }, 400);
        return json({ access_token: `FRESH_${form.get("refresh_token")}`, expires_in: 3599 });
      }
      return json({ error: { message: `unexpected ${u.host}${u.pathname}` } }, 400);
    },
  };
  return w;
}

let w: World;
const useEnv = (vars: Record<string, string>) => {
  Object.assign(process.env, vars);
  resetEnvCache();
};

beforeAll(() => useEnv(ENV));
afterAll(async () => disconnectDb());
beforeEach(async () => {
  await resetDb();
  useEnv(ENV);
  w = world();
});
afterEach(() => vi.restoreAllMocks());

let k = 0;
async function store() {
  const user = await systemDb.user.create({ data: { email: `owner${++k}@x.com` } });
  const ws = await systemDb.workspace.create({ data: { name: `W${k}` } });
  const s = await systemDb.store.create({ data: { workspaceId: ws.id, shopDomain: `n${k}.myshopify.com`, grantedScopes: ["read_orders"], status: "active", timezone: "UTC", pixelIngestKey: `pk-n${k}` } });
  return { ...s, userId: user.id };
}
type Store = Awaited<ReturnType<typeof store>>;

/**
 * One Nango sign-in's accounts as the Nango release stored them: every row holding the same sealed
 * reference to its Nango connection (`{n, k}`), never a token; and the connection at Nango.
 */
async function throughNango(provider: Provider, s: Store, connectionId: string, accounts: string[], held: Omit<HeldAtNango, "key">, over: Record<string, unknown> = {}) {
  w.nango.set(connectionId, { key: KEY[provider], ...held });
  const sealed = encryptAdTokens(s.id, provider, { accessToken: JSON.stringify({ n: connectionId, k: KEY[provider] }), refreshToken: null, expiresAt: held.expiresAt ? new Date(held.expiresAt) : null });
  const rows: AdConnection[] = [];
  for (const accountId of accounts) {
    rows.push(
      await systemDb.adConnection.create({
        data: { workspaceId: s.workspaceId, storeId: s.id, provider, accountId, accountName: accountId, currency: "USD", timezone: "UTC", connectedByUserId: s.userId, externalUserId: "4242", source: "nango", sourceLoginId: connectionId, ...sealed, ...over },
      }),
    );
  }
  return rows;
}

/** A Meta login with no ad account yet, made through Nango: it names its connection and holds no token. */
async function waitingThroughNango(s: Store, connectionId: string, held: Omit<HeldAtNango, "key">) {
  w.nango.set(connectionId, { key: KEY.meta, ...held });
  return systemDb.adLogin.create({
    data: { workspaceId: s.workspaceId, storeId: s.id, provider: "meta", reason: "no_ads_account", connectedByUserId: s.userId, externalUserId: "4242", loginName: "Pat", sourceLoginId: connectionId, nangoIntegrationKey: KEY.meta },
  });
}

const row = (id: string) => systemDb.adConnection.findUniqueOrThrow({ where: { id } });
const run = (coord = memoryCoord()) => leaveNango(coord, { fetchImpl: w.fetchImpl });

describe("moving the connections made through Nango off it", () => {
  it("Meta: the token Nango held is sealed on the rows, which read without Nango from then on; the Nango connection goes", async () => {
    const s = await store();
    const [a, shown] = await throughNango("meta", s, "conn-meta", ["act_1", "act_2"], { token: "META_LONG", expiresAt: META_ENDS });
    // A hidden account stays hidden.
    const b = await systemDb.adConnection.update({ where: { id: shown!.id }, data: { enabled: false } });
    await systemDb.adCampaignDaily.create({ data: { workspaceId: s.workspaceId, storeId: s.id, connectionId: a!.id, provider: "meta", accountId: "act_1", campaignId: "c", campaignName: "C", day: "2026-10-27", spend: 5 } });

    expect(await run()).toEqual({ moved: 2, failed: 0, waiting: 0, ended: 0, left: 0 });

    // Read once, refresh token asked for, from the platform's own integration.
    expect(w.reads).toEqual([{ id: "conn-meta", key: KEY.meta, refreshToken: "true" }]);
    // Tried without Nango first: Meta answered /me for that token, signed with bizinsights' app secret.
    expect(w.metaMe).toEqual(["META_LONG"]);
    for (const before of [a!, b]) {
      const after = await row(before.id);
      expect(after).toMatchObject({ source: "direct", sourceLoginId: null, refreshTokenEnc: null, externalUserId: "4242", accountId: before.accountId, enabled: before.enabled });
      expect(after.accessTokenExpiresAt?.toISOString()).toBe(META_ENDS);
      expect(after.accessTokenEnc).not.toBe(before.accessTokenEnc);
      expect(after.accessTokenEnc).not.toContain("META_LONG");
      // bizinsights' own token now: no Nango needed to read it.
      expect(await adAccessToken(after)).toBe("META_LONG");
    }
    // One sign-in, one sealed token for both (how a sign-in's rows are found together).
    expect((await row(a!.id)).accessTokenEnc).toBe((await row(b.id)).accessTokenEnc);
    expect(await systemDb.adCampaignDaily.count({ where: { connectionId: a!.id } })).toBe(1);
    // Nango's copy goes, never the grant.
    expect(w.deleted).toEqual(["conn-meta"]);
    const audit = await systemDb.auditLog.findFirstOrThrow({ where: { action: "ads.moved_off_nango" } });
    expect(audit).toMatchObject({ workspaceId: s.workspaceId, targetType: "store", targetId: s.id, metadata: { provider: "meta", accounts: 2, logins: 0 } });

    // Nothing left: the next tick asks Nango nothing.
    expect(await run()).toEqual({ moved: 0, failed: 0, waiting: 0, ended: 0, left: 0 });
    expect(w.reads).toHaveLength(1);
  });

  it("Google Ads and AdSense: the refresh token Nango returned is renewed with bizinsights' own client before the rows take it", async () => {
    const s = await store();
    const [g] = await throughNango("google", s, "conn-google", ["1112223333"], { token: "G_OLD", refreshToken: "1//G_REFRESH", expiresAt: "2026-10-28T10:00:00.000Z" });
    const [as] = await throughNango("adsense", s, "conn-adsense", ["pub-77"], { token: "AS_OLD", refreshToken: "1//AS_REFRESH" });

    expect(await run()).toMatchObject({ moved: 2, failed: 0, ended: 0, left: 0 });
    expect(w.reads.map((r) => [r.id, r.key, r.refreshToken])).toEqual(
      expect.arrayContaining([
        ["conn-google", KEY.google, "true"],
        ["conn-adsense", KEY.adsense, "true"],
      ]),
    );
    // Verified without Nango: Google renewed each refresh token for bizinsights' own client.
    expect(w.googleRefreshes).toEqual(
      expect.arrayContaining([
        { token: "1//G_REFRESH", clientId: "g_client" },
        { token: "1//AS_REFRESH", clientId: "g_client" },
      ]),
    );
    const google = await row(g!.id);
    expect(google).toMatchObject({ source: "direct", sourceLoginId: null });
    expect(google.refreshTokenEnc).toBeTruthy();
    expect(JSON.stringify(google)).not.toContain("1//G_REFRESH");
    // The fresh access token is the one held, and once it ends the row renews itself with the refresh token Nango had.
    expect(await adAccessToken(google)).toBe("FRESH_1//G_REFRESH");
    expect(google.accessTokenExpiresAt!.getTime()).toBeGreaterThan(Date.now() + 50 * 60_000);
    await systemDb.adConnection.update({ where: { id: g!.id }, data: { accessTokenExpiresAt: new Date(Date.now() - 60_000) } });
    w.googleRefreshes = [];
    expect(await adAccessToken(await row(g!.id), w.fetchImpl)).toBe("FRESH_1//G_REFRESH");
    expect(w.googleRefreshes).toEqual([{ token: "1//G_REFRESH", clientId: "g_client" }]);
    expect(await adAccessToken(await row(as!.id))).toBe("FRESH_1//AS_REFRESH");
    expect(w.deleted.sort()).toEqual(["conn-adsense", "conn-google"]);
  });

  it("a waiting login made through Nango gets its token sealed on it, and its Nango connection goes", async () => {
    const s = await store();
    const login = await waitingThroughNango(s, "conn-login", { token: "META_LOGIN", expiresAt: META_ENDS });
    expect(isNangoLogin(login)).toBe(true);

    expect(await run()).toEqual({ moved: 1, failed: 0, waiting: 0, ended: 0, left: 0 });
    const after = await systemDb.adLogin.findUniqueOrThrow({ where: { id: login.id } });
    expect(after).toMatchObject({ sourceLoginId: null, nangoIntegrationKey: null, externalUserId: "4242", loginName: "Pat", reason: "no_ads_account" });
    expect(isNangoLogin(after)).toBe(false);
    expect(after.accessTokenExpiresAt?.toISOString()).toBe(META_ENDS);
    // Sealed like a connection's token (same store and platform binding).
    expect(decrypt(after.accessTokenEnc, keyring(), `ads:meta:${s.id}:access`)).toBe("META_LOGIN");
    expect(w.metaMe).toEqual(["META_LOGIN"]);
    expect(w.deleted).toEqual(["conn-login"]);
    expect((await systemDb.auditLog.findFirstOrThrow({ where: { action: "ads.moved_off_nango" } })).metadata).toMatchObject({ provider: "meta", accounts: 0, logins: 1 });
  });

  it("a connection Nango no longer has can never be read again: its accounts wait for a reconnect, read without Nango, and its waiting login goes", async () => {
    const s = await store();
    const rows = await throughNango("meta", s, "conn-gone", ["act_1", "act_2"], { token: "X" });
    const login = await systemDb.adLogin.create({ data: { workspaceId: s.workspaceId, storeId: s.id, provider: "meta", reason: "no_ads_account", sourceLoginId: "conn-gone", nangoIntegrationKey: KEY.meta } });
    w.nango.delete("conn-gone");

    expect(await run()).toEqual({ moved: 0, failed: 0, waiting: 0, ended: 2, left: 0 });
    for (const r of rows) {
      expect(await row(r.id)).toMatchObject({ status: "reconnect", errorCode: "auth_expired", source: "direct", sourceLoginId: null, accessTokenEnc: "", refreshTokenEnc: null, accessTokenExpiresAt: null });
    }
    expect(await systemDb.adLogin.findUnique({ where: { id: login.id } })).toBeNull();
    // Nothing was tried with the platform.
    expect(w.metaMe).toEqual([]);
  });

  it("a grant the platform refuses without Nango ends the same way (Google won't renew it, Meta won't take the token)", async () => {
    const s = await store();
    const [g] = await throughNango("google", s, "conn-g", ["1112223333"], { token: "G_OLD", refreshToken: "1//DEAD" });
    const [m] = await throughNango("meta", s, "conn-m", ["act_1"], { token: "META_DEAD" });
    // Nango gave no refresh token for a Google connection: nothing would keep working past the hour.
    const [n] = await throughNango("adsense", s, "conn-no-refresh", ["pub-1"], { token: "AS_ONLY" });
    w.googleRefuses = true;
    w.metaRefuses = true;

    expect(await run()).toMatchObject({ moved: 0, ended: 3, left: 0 });
    for (const id of [g!.id, m!.id, n!.id]) expect(await row(id)).toMatchObject({ status: "reconnect", source: "direct", accessTokenEnc: "" });
    // The dead connections are deleted at Nango too.
    expect(w.deleted.sort()).toEqual(["conn-g", "conn-m", "conn-no-refresh"]);
  });

  it("Nango down: nothing changes, and the connection waits an hour before it is asked again", async () => {
    const s = await store();
    const [a] = await throughNango("meta", s, "conn-down", ["act_1"], { token: "META_LONG" });
    const coord = memoryCoord();
    w.nangoStatus = 503;

    expect(await run(coord)).toEqual({ moved: 0, failed: 1, waiting: 0, ended: 0, left: 1 });
    // Untouched: it reads through Nango still (its syncs wait for the move, never "reconnect").
    expect(await row(a!.id)).toMatchObject({ source: "nango", sourceLoginId: "conn-down", status: "active", accessTokenEnc: a!.accessTokenEnc });
    expect(await coord.peek("ads-nango-leave-wait:conn-down")).toBeTruthy();
    expect(MOVE_RETRY_S).toBe(3600);

    // The next tick leaves it waiting, without asking Nango.
    w.nangoStatus = undefined;
    const calls = w.reads.length;
    expect(await run(coord)).toEqual({ moved: 0, failed: 0, waiting: 1, ended: 0, left: 1 });
    expect(w.reads).toHaveLength(calls);
    // Once the wait is over, it moves.
    await coord.take("ads-nango-leave-wait:conn-down");
    expect(await run(coord)).toMatchObject({ moved: 1, left: 0 });
  });

  it("bizinsights' Nango key refused: the run stops at the first connection, and nothing is marked to wait", async () => {
    const s = await store();
    await throughNango("meta", s, "conn-1", ["act_1"], { token: "T1" });
    await throughNango("meta", await store(), "conn-2", ["act_2"], { token: "T2" });
    const coord = memoryCoord();
    w.nangoStatus = 401;
    const asked: string[] = [];
    const counting: FetchLike = async (input, init) => {
      if (new URL(String(input)).host === "api.nango.dev") asked.push(String(input));
      return w.fetchImpl(input, init);
    };

    expect(await leaveNango(coord, { fetchImpl: counting })).toEqual({ moved: 0, failed: 1, waiting: 0, ended: 0, left: 2 });
    expect(asked).toHaveLength(1);
    expect(await systemDb.adConnection.count({ where: { source: "nango" } })).toBe(2);
    expect(await coord.peek("ads-nango-leave-wait:conn-1")).toBeNull();
    expect(await coord.peek("ads-nango-leave-wait:conn-2")).toBeNull();
  });

  it("a row whose person left holds no credential: it reads without Nango from now on, and no token is written to it", async () => {
    const s = await store();
    const [left] = await throughNango("meta", s, "conn-left", ["act_1"], { token: "SHOULD_NOT_COME_BACK" }, { accessTokenEnc: "", status: "reconnect", errorCode: "connector_left", connectedByUserId: null });

    expect(await run()).toEqual({ moved: 0, failed: 0, waiting: 0, ended: 0, left: 0 });
    expect(await row(left!.id)).toMatchObject({ source: "direct", sourceLoginId: null, accessTokenEnc: "", refreshTokenEnc: null, status: "reconnect", errorCode: "connector_left" });
    expect(w.reads).toEqual([]);
    expect(w.metaMe).toEqual([]);
  });

  it("a reconnect while a connection is being read wins: its new sign-in is never overwritten", async () => {
    const s = await store();
    const [a] = await throughNango("meta", s, "conn-race", ["act_1"], { token: "META_FROM_NANGO" });
    const fresh = encryptAdTokens(s.id, "meta", { accessToken: "META_RECONNECTED", refreshToken: null, expiresAt: null });
    w.onRead = async () => {
      await systemDb.adConnection.update({ where: { id: a!.id }, data: { ...fresh, source: "direct", sourceLoginId: null } });
    };

    expect(await run()).toMatchObject({ moved: 0, left: 0 });
    expect(await adAccessToken(await row(a!.id))).toBe("META_RECONNECTED");
  });

  it("a few Nango connections a run, the rest on the next; `left` says when the Nango key can go", async () => {
    const s = await store();
    await throughNango("meta", s, "conn-a", ["act_1"], { token: "TA" });
    await throughNango("google", s, "conn-b", ["1112223333"], { token: "TB", refreshToken: "1//RB" });
    await waitingThroughNango(await store(), "conn-c", { token: "TC" });

    expect(await leaveNango(memoryCoord(), { fetchImpl: w.fetchImpl, limit: 2 })).toMatchObject({ moved: 2, left: 1 });
    expect(await leaveNango(memoryCoord(), { fetchImpl: w.fetchImpl, limit: 2 })).toMatchObject({ moved: 1, left: 0 });
    expect(w.deleted.sort()).toEqual(["conn-a", "conn-b", "conn-c"]);
  });

  it("the worker's cron step runs it", async () => {
    const s = await store();
    await throughNango("meta", s, "conn-cron", ["act_1"], { token: "TCRON" });
    expect(await moveAdConnectionsOffNango({ coord: memoryCoord(), fetchImpl: w.fetchImpl })).toMatchObject({ moved: 1, left: 0 });
  });

  it("without NANGO_SECRET_KEY nothing is moved, and it says so; with nothing to move it asks for no key at all", async () => {
    const s = await store();
    const [a] = await throughNango("meta", s, "conn-nokey", ["act_1"], { token: "META_LONG" });
    useEnv({ NANGO_SECRET_KEY: "" });
    const errors: unknown[][] = [];
    vi.spyOn(logger, "error").mockImplementation((...args: unknown[]) => void errors.push(args));

    expect(await run()).toEqual({ moved: 0, failed: 0, waiting: 0, ended: 0, left: 1 });
    expect(await row(a!.id)).toMatchObject({ source: "nango", accessTokenEnc: a!.accessTokenEnc });
    expect(w.reads).toEqual([]);
    expect(errors.find((e) => e[1] === "rows still read through Nango, but NANGO_SECRET_KEY isn't set: they can't be moved")?.[0]).toMatchObject({ left: 1 });
    // Still the Nango credential it was: a later run with the key moves it.
    expect(nangoCredential(await row(a!.id))).toEqual({ connectionId: "conn-nokey", integrationKey: KEY.meta });

    await systemDb.adConnection.deleteMany();
    errors.length = 0;
    expect(await run()).toEqual({ moved: 0, failed: 0, waiting: 0, ended: 0, left: 0 });
    expect(errors).toEqual([]);
  });
});

describe("a waiting login's own token under key rotation (reencryptAdLoginTokens)", () => {
  const OLD = "1:" + Buffer.alloc(32, 1).toString("base64");
  const NEW = "2:" + Buffer.alloc(32, 2).toString("base64");
  const GONE = "9:" + Buffer.alloc(32, 9).toString("base64");
  const useKeys = (spec: string) => useEnv({ TOKEN_ENCRYPTION_KEYS: spec });
  afterEach(() => useKeys(testEnv.TOKEN_ENCRYPTION_KEYS));
  const login = (s: Store, data: Record<string, unknown>) => systemDb.adLogin.create({ data: { workspaceId: s.workspaceId, storeId: s.id, provider: "meta", reason: "no_ads_account", ...data } });
  const tokenOf = async (id: string, storeId: string) => decrypt((await systemDb.adLogin.findUniqueOrThrow({ where: { id } })).accessTokenEnc, keyring(), `ads:meta:${storeId}:access`);

  it("re-seals each with the active key; one sealed with a removed key is let go; one still at Nango is left alone", async () => {
    const [a, b, c] = [await store(), await store(), await store()];
    useKeys(GONE);
    const stranded = await login(b, encryptLoginToken(b.id, "meta", "LOGIN_STRANDED"));
    useKeys(OLD);
    const own = await login(a, encryptLoginToken(a.id, "meta", "LOGIN_A"));
    expect(own.tokenKeyVersion).toBe(1);
    const atNango = await login(c, { sourceLoginId: "conn-c", nangoIntegrationKey: KEY.meta });

    useKeys(`${NEW},${OLD}`);
    // One rewritten, one let go.
    expect(await reencryptAdLoginTokens()).toBe(2);
    const after = await systemDb.adLogin.findUniqueOrThrow({ where: { id: own.id } });
    expect(after.accessTokenEnc.startsWith("v2.")).toBe(true);
    expect(after.tokenKeyVersion).toBe(2);
    expect(await systemDb.adLogin.findUnique({ where: { id: stranded.id } })).toBeNull();
    expect(await systemDb.adLogin.findUniqueOrThrow({ where: { id: atNango.id } })).toMatchObject({ accessTokenEnc: "", sourceLoginId: "conn-c" });
    expect(await reencryptAdLoginTokens()).toBe(0);
    // The old key can go: the new one alone opens it.
    useKeys(NEW);
    expect(await tokenOf(own.id, a.id)).toBe("LOGIN_A");
  });

  it("only over the ciphertext read: a new sign-in stored meanwhile is never overwritten with the old token", async () => {
    const s = await store();
    useKeys(OLD);
    const old = await login(s, encryptLoginToken(s.id, "meta", "LOGIN_OLD"));
    useKeys(`${NEW},${OLD}`);
    const logins = systemDb.adLogin as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>;
    const findMany = logins.findMany!;
    // The person signs in again between the read and the rewrite.
    logins.findMany = async (...args) => {
      const rows = await findMany(...args);
      await systemDb.adLogin.update({ where: { id: old.id }, data: encryptLoginToken(s.id, "meta", "LOGIN_NEW") });
      return rows;
    };
    try {
      expect(await reencryptAdLoginTokens()).toBe(0);
    } finally {
      logins.findMany = findMany;
    }
    expect(await tokenOf(old.id, s.id)).toBe("LOGIN_NEW");
  });
});
