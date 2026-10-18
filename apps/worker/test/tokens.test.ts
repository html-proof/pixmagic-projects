import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { disconnectDb, systemDb } from "@app/db";
import { resetDb } from "@app/db/testing";
import {
  encryptTokenFields,
  getAccessToken,
  memoryBlobs,
  memoryCoord,
  memoryMailer,
  memoryQueues,
  obtainStoreToken,
  ShopifyHttpError,
  StoreDisconnectedError,
  withAccessToken,
  type FetchLike,
  type TokenResponse,
} from "@app/core";
import { syncProblem } from "@app/core/reports";
import { refreshExpiringTokens, type WorkerDeps } from "../src/handlers.js";

/**
 * Shopify's expiring offline tokens (packages/core/src/tokens.ts): the sweep moves stores still on
 * a non-expiring token, a refresh never leaves a row on a refresh token Shopify has retired, and a
 * call whose token was swapped under it runs again instead of reading as lost access.
 */

const coord = memoryCoord();
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
let calls: Array<Record<string, string>>;
let answer: (body: Record<string, string>) => Response | Promise<Response>;
const fetchImpl: FetchLike = async (url, init) => {
  if (!String(url).endsWith("/admin/oauth/access_token")) throw new Error(`unexpected fetch ${String(url)}`);
  const body = JSON.parse(String(init?.body)) as Record<string, string>;
  calls.push(body);
  return answer(body);
};
const deps: WorkerDeps = { coord, queues: memoryQueues(), payloads: memoryBlobs(), mailer: memoryMailer(), fetchImpl };

/** What Shopify answers with an expiring offline token. */
const pair = (n: string) => ({ access_token: `shpat_${n}`, scope: "read_orders", expires_in: 3600, refresh_token: `shprt_${n}`, refresh_token_expires_in: 7_776_000 });
const nonExpiring = (access: string): TokenResponse => ({ accessToken: access, scopes: ["read_orders"], accessTokenExpiresAt: null, refreshToken: null, refreshTokenExpiresAt: null });
const expiring = (access: string, refresh: string, inMs: number): TokenResponse => ({
  accessToken: access,
  scopes: ["read_orders"],
  accessTokenExpiresAt: new Date(Date.now() + inMs),
  refreshToken: refresh,
  refreshTokenExpiresAt: new Date(Date.now() + 86_400_000),
});
const EXCHANGE = "urn:ietf:params:oauth:grant-type:token-exchange";

async function makeStore(t: TokenResponse) {
  const ws = await systemDb.workspace.create({ data: { name: "W" } });
  const store = await systemDb.store.create({
    data: { workspaceId: ws.id, shopDomain: "t.myshopify.com", grantedScopes: ["read_orders"], status: "active", timezone: "UTC", pixelIngestKey: "pk-t" },
  });
  await setTokens(store.id, t);
  return systemDb.store.findUniqueOrThrow({ where: { id: store.id } });
}
const setTokens = (id: string, t: TokenResponse) => systemDb.store.update({ where: { id }, data: encryptTokenFields(id, t) });

afterAll(async () => disconnectDb());
beforeEach(async () => {
  await resetDb();
  coord.clear();
  calls = [];
  answer = () => {
    throw new Error("no answer set");
  };
});

describe("moving stores to expiring tokens", () => {
  it("the sweep trades a non-expiring token once, and the store then rotates like any other", async () => {
    const store = await makeStore(nonExpiring("shpat_old"));
    answer = (b) => (b.grant_type === EXCHANGE && b.subject_token === "shpat_old" && b.expiring === "1" ? json(pair("new")) : json({ error: "invalid_request" }, 400));
    expect(await refreshExpiringTokens(deps)).toBe(1);
    const moved = await systemDb.store.findUniqueOrThrow({ where: { id: store.id } });
    expect(moved.accessTokenExpiresAt!.getTime()).toBeGreaterThan(Date.now() + 59 * 60_000);
    expect(moved.refreshTokenEnc).toBeTruthy();
    expect(await getAccessToken(store, coord, fetchImpl)).toBe("shpat_new");
    // The next tick has nothing to do: the new token is good for the hour.
    expect(await refreshExpiringTokens(deps)).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ client_id: "test_key", client_secret: "test_secret" });
  });

  it("a store Shopify won't move keeps its token and is asked again only after an hour", async () => {
    const store = await makeStore(nonExpiring("shpat_old"));
    answer = () => json({ error: "invalid_subject_token" }, 400);
    expect(await refreshExpiringTokens(deps)).toBe(0);
    expect(await refreshExpiringTokens(deps)).toBe(0);
    expect(calls).toHaveLength(1);
    expect(await getAccessToken(store, coord, fetchImpl)).toBe("shpat_old");
    coord.clear(); // the hour is up
    await refreshExpiringTokens(deps);
    expect(calls).toHaveLength(2);
  });
});

describe("rotating an expiring token", () => {
  it("rotates near expiry, and the sweep keeps every store a tick ahead", async () => {
    const store = await makeStore(expiring("shpat_1", "shprt_1", 10 * 60_000));
    answer = (b) => (b.grant_type === "refresh_token" && b.refresh_token === "shprt_1" ? json(pair("2")) : json({ error: "invalid_request" }, 401));
    // Ten minutes left is plenty for a request...
    expect(await getAccessToken(store, coord, fetchImpl)).toBe("shpat_1");
    expect(calls).toHaveLength(0);
    // ...but not for the sweep, which rotates it before the next tick could find it expired.
    expect(await refreshExpiringTokens(deps)).toBe(1);
    expect(await getAccessToken(store, coord, fetchImpl)).toBe("shpat_2");
    expect(calls).toHaveLength(1);
  });

  it("a refresh token Shopify refuses reads as lost access, so the dashboard offers Reconnect", async () => {
    const store = await makeStore(expiring("shpat_1", "shprt_1", -1000));
    answer = () => json({ error: "invalid_request" }, 401);
    const err = await getAccessToken(store, coord, fetchImpl).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StoreDisconnectedError);
    expect(syncProblem((err as Error).message)).toBe("access");
  });

  it("a refresh that fails for a passing reason keeps the token while it lasts, and the refresh token for next time", async () => {
    const store = await makeStore(expiring("shpat_1", "shprt_1", 2 * 60_000));
    answer = () => json({}, 503);
    expect(await getAccessToken(store, coord, fetchImpl)).toBe("shpat_1");
    // Expired, there is nothing to fall back on: the caller gets the error, and retries.
    await systemDb.store.update({ where: { id: store.id }, data: { accessTokenExpiresAt: new Date(Date.now() - 1000) } });
    await expect(getAccessToken(store, coord, fetchImpl)).rejects.toBeInstanceOf(ShopifyHttpError);
    answer = (b) => (b.refresh_token === "shprt_1" ? json(pair("2")) : json({ error: "invalid_request" }, 401));
    expect(await getAccessToken(store, coord, fetchImpl)).toBe("shpat_2");
  });

  it("a reconnect that lands while a refresh is under way keeps its token", async () => {
    const store = await makeStore(expiring("shpat_1", "shprt_1", -1000));
    // The reconnect writes its token while Shopify answers the refresh.
    answer = async () => {
      await setTokens(store.id, expiring("shpat_re", "shprt_re", 3600_000));
      return json(pair("2"));
    };
    // Fresh from Shopify, so good for this one call...
    expect(await getAccessToken(store, coord, fetchImpl)).toBe("shpat_2");
    // ...but the row keeps the reconnect's: that authorization retired shprt_2.
    expect(await getAccessToken(store, coord, fetchImpl)).toBe("shpat_re");
  });

  it("a refresh refused because the store was reconnected meanwhile takes the new token", async () => {
    const store = await makeStore(expiring("shpat_1", "shprt_1", -1000));
    answer = async () => {
      await setTokens(store.id, expiring("shpat_re", "shprt_re", 3600_000));
      return json({ error: "invalid_request" }, 401);
    };
    expect(await getAccessToken(store, coord, fetchImpl)).toBe("shpat_re");
  });
});

describe("a call whose token is swapped under it", () => {
  it("a 403 for a non-expiring token moves the store and runs the call again", async () => {
    const store = await makeStore(nonExpiring("shpat_old"));
    answer = () => json(pair("new"));
    const used: string[] = [];
    const result = await withAccessToken(store, coord, fetchImpl, async (token) => {
      used.push(token);
      if (token === "shpat_old") throw new ShopifyHttpError("Shopify auth error 403: Non-expiring access tokens are no longer accepted for the Admin API", 403);
      return "ok";
    });
    expect(result).toBe("ok");
    expect(used).toEqual(["shpat_old", "shpat_new"]);
  });

  it("a refusal with the same token still in place is the caller's to handle", async () => {
    const store = await makeStore(nonExpiring("shpat_old"));
    let n = 0;
    const call = async () => {
      n++;
      throw new ShopifyHttpError("Shopify auth error 401", 401);
    };
    await expect(withAccessToken(store, coord, fetchImpl, call)).rejects.toThrow("401");
    expect(n).toBe(1);
    expect(calls).toHaveLength(0);
  });
});

describe("a new authorization", () => {
  it("goes on the store's row at once when the row holds a token from the same app", async () => {
    const store = await makeStore(expiring("shpat_1", "shprt_1", 3600_000));
    const t = await obtainStoreToken("t.myshopify.com", "default", coord, async () => expiring("shpat_new", "shprt_new", 3600_000));
    expect(t.accessToken).toBe("shpat_new");
    expect(await getAccessToken(store, coord, fetchImpl)).toBe("shpat_new");
    // Another app's token for the shop leaves it alone: Shopify retired only that app's.
    await obtainStoreToken("t.myshopify.com", "client", coord, async () => nonExpiring("shpat_other"));
    expect(await getAccessToken(store, coord, fetchImpl)).toBe("shpat_new");
  });
});
