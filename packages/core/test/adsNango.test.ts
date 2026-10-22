import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  AdsApiError,
  AdsAuthError,
  AdsRateLimitedError,
  AdsRetryableError,
  classifyAdError,
  isNangoConnectionId,
  NANGO_INTEGRATION,
  nangoAccessToken,
  nangoConnections,
  nangoCreateConnectSession,
  nangoDeleteConnection,
  nangoError,
  nangoProviderOf,
  parseNangoWebhook,
  verifyNangoSignature,
  type FetchLike,
} from "../src/index.js";

/**
 * The Nango client (packages/core/src/ads/nango.ts) against answers shaped like Nango's documented ones
 * (https://nango.dev/docs/reference/backend/http-api): connect sessions, connections with their tags and
 * credentials, deleting one, and the HMAC on its webhooks.
 */

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

type Call = { url: URL; init?: RequestInit; body: Record<string, unknown> | null };
function fake(route: (call: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fetchImpl: FetchLike = async (input, init) => {
    const url = new URL(String(input));
    const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : null;
    const call = { url, init, body };
    calls.push(call);
    return route(call);
  };
  return { fetchImpl, calls };
}

const KEY = "nango-secret-0123456789abcdef0123456789";
const cfg = (fetchImpl: FetchLike) => ({ secretKey: KEY, apiUrl: "https://api.nango.dev/", fetchImpl });
const tags = { end_user_id: "u1", organization_id: "ws1", bi_store: "s1", bi_provider: "meta" as const, bi_session: "n".repeat(32) };

describe("connect sessions", () => {
  it("asks for one integration, with the session's tags and the platform's authorize parameters, the key in the header only", async () => {
    const f = fake(() => json({ data: { token: "nango_connect_session_abc", expires_at: "2026-10-22T10:30:00Z", connect_link: "https://connect.nango.dev/?session_token=x" } }, 201));
    const s = await nangoCreateConnectSession(cfg(f.fetchImpl), { integrationKey: NANGO_INTEGRATION.meta, tags, authorizationParams: { config_id: "1521935306664882" } });
    expect(s).toEqual({ token: "nango_connect_session_abc", expiresAt: "2026-10-22T10:30:00Z" });
    const [call] = f.calls;
    expect(call!.url.href).toBe("https://api.nango.dev/connect/sessions");
    expect(call!.init?.method).toBe("POST");
    expect(new Headers(call!.init?.headers).get("authorization")).toBe(`Bearer ${KEY}`);
    expect(call!.body).toEqual({
      tags,
      allowed_integrations: ["bizinsights-meta-ads"],
      integrations_config_defaults: { "bizinsights-meta-ads": { authorization_params: { config_id: "1521935306664882" } } },
    });
    expect(call!.url.search).toBe("");
  });

  it("sends no defaults when there are no parameters, and refuses an answer without a token", async () => {
    const f = fake(() => json({ data: {} }, 201));
    await expect(nangoCreateConnectSession(cfg(f.fetchImpl), { integrationKey: "bizinsights-google-adsense", tags: { ...tags, bi_provider: "adsense" } })).rejects.toBeInstanceOf(AdsApiError);
    expect(f.calls[0]!.body).not.toHaveProperty("integrations_config_defaults");
  });
});

describe("connections", () => {
  it("lists a connection with its tags, by id", async () => {
    const f = fake(() =>
      json({
        connections: [
          { id: 1, connection_id: "c-1", provider: "facebook", provider_config_key: "bizinsights-meta-ads", created: "2026-10-22T00:00:00Z", tags: { ...tags, junk: 3 } },
          { id: 2, provider_config_key: "x" },
        ],
      }),
    );
    const list = await nangoConnections(cfg(f.fetchImpl), "c-1");
    expect(f.calls[0]!.url.pathname).toBe("/connections");
    expect(f.calls[0]!.url.searchParams.get("connectionId")).toBe("c-1");
    expect(list).toEqual([{ connectionId: "c-1", integrationKey: "bizinsights-meta-ads", provider: "facebook", tags, createdAt: "2026-10-22T00:00:00Z" }]);
  });

  it("gets a working access token, with its expiry and the scopes the platform granted", async () => {
    const f = fake(() =>
      json({
        connection_id: "c 1",
        credentials: { type: "OAUTH2", access_token: "ya29.token", expires_at: "2026-10-22T11:00:00.000Z", raw: { scope: "openid https://www.googleapis.com/auth/adsense.readonly" } },
      }),
    );
    const t = await nangoAccessToken(cfg(f.fetchImpl), "bizinsights-google-adsense", "c 1");
    expect(f.calls[0]!.url.pathname).toBe("/connections/c%201");
    expect(f.calls[0]!.url.searchParams.get("provider_config_key")).toBe("bizinsights-google-adsense");
    // Never the refresh token: only what a call needs.
    expect(f.calls[0]!.url.searchParams.has("refresh_token")).toBe(false);
    expect(t).toEqual({ accessToken: "ya29.token", expiresAt: new Date("2026-10-22T11:00:00.000Z"), grantedScopes: ["openid", "https://www.googleapis.com/auth/adsense.readonly"] });
  });

  it("turns a grant Nango can't renew, or a connection it doesn't have, into 'reconnect'", async () => {
    const refreshFailed = fake(() => json({ error: { code: "invalid_credentials", message: "refresh failed" } }, 424));
    await expect(nangoAccessToken(cfg(refreshFailed.fetchImpl), "k", "c")).rejects.toBeInstanceOf(AdsAuthError);
    const gone = fake(() => json({ error: { code: "not_found", message: "no connection" } }, 404));
    const err = await nangoAccessToken(cfg(gone.fetchImpl), "k", "c").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AdsAuthError);
    expect(classifyAdError(err)).toMatchObject({ status: "reconnect", code: "auth_expired" });
    const noToken = fake(() => json({ credentials: { type: "API_KEY", apiKey: "x" } }));
    await expect(nangoAccessToken(cfg(noToken.fetchImpl), "k", "c")).rejects.toBeInstanceOf(AdsAuthError);
  });

  it("deletes a connection, and calls one already gone 'gone'", async () => {
    const f = fake((c) => (c.url.pathname === "/connections/c-1" ? json({ success: true }) : json({ error: { code: "not_found" } }, 404)));
    expect(await nangoDeleteConnection(cfg(f.fetchImpl), "bizinsights-meta-ads", "c-1")).toBe("deleted");
    expect(f.calls[0]!.init?.method).toBe("DELETE");
    expect(f.calls[0]!.url.searchParams.get("provider_config_key")).toBe("bizinsights-meta-ads");
    expect(await nangoDeleteConnection(cfg(f.fetchImpl), "bizinsights-meta-ads", "c-2")).toBe("gone");
  });
});

describe("Nango's errors", () => {
  it("are sorted like a platform's", () => {
    expect(nangoError(429, { code: "too_many_requests" }, 30)).toBeInstanceOf(AdsRateLimitedError);
    expect((nangoError(429, null, 30) as AdsRateLimitedError).retryAfterS).toBe(30);
    expect(nangoError(503, null)).toBeInstanceOf(AdsRetryableError);
    // bizinsights' own key or integration: not the merchant's to fix.
    expect(classifyAdError(nangoError(401, { code: "unauthorized" })).code).toBe("not_configured");
    expect(classifyAdError(nangoError(400, { code: "unknown_provider_config" })).code).toBe("not_configured");
    expect(classifyAdError(nangoError(424, null)).code).toBe("auth_expired");
    // Nango backing off after a failed refresh, or the platform's token endpoint failing: retried, never "reconnect".
    expect(nangoError(424, { code: "connection_refresh_backoff", message: "A recent refresh attempt failed. Backing off before retrying" })).toBeInstanceOf(AdsRateLimitedError);
    expect((nangoError(424, { code: "connection_refresh_backoff" }) as AdsRateLimitedError).retryAfterS).toBe(60);
    const outage = nangoError(400, { code: "refresh_token_external_error", message: "The external API returned an error when trying to refresh the access token: 503" });
    expect(outage).toBeInstanceOf(AdsRetryableError);
    expect(outage).not.toBeInstanceOf(AdsAuthError);
    // ...unless the platform refused the grant.
    expect(nangoError(400, { code: "refresh_token_external_error", message: "invalid_grant: Token has been expired or revoked." })).toBeInstanceOf(AdsAuthError);
    expect(nangoError(424, { code: "refresh_exhausted", message: "The refresh limit has been reached" })).toBeInstanceOf(AdsAuthError);
  });

  it("a network failure is retried, and reads a Retry-After header", async () => {
    const down: FetchLike = async () => {
      throw new TypeError("fetch failed");
    };
    await expect(nangoAccessToken(cfg(down), "k", "c")).rejects.toBeInstanceOf(AdsRetryableError);
    const slow = fake(() => json({ error: { code: "too_many_requests" } }, 429, { "retry-after": "12" }));
    const err = (await nangoAccessToken(cfg(slow.fetchImpl), "k", "c").catch((e: unknown) => e)) as AdsRateLimitedError;
    expect(err.retryAfterS).toBe(12);
  });
});

describe("webhooks", () => {
  const body = JSON.stringify({ from: "nango", type: "auth", operation: "refresh", success: false, connectionId: "c-1", providerConfigKey: "bizinsights-meta-ads", environment: "prod", error: { type: "refresh_token_external_error", description: "x" } });
  const sign = (raw: string, key: string) => createHmac("sha256", key).update(raw).digest("hex");

  it("are Nango's only when signed with the environment's key over the raw body", () => {
    expect(verifyNangoSignature(body, sign(body, "whk_1"), ["whk_1"])).toBe(true);
    expect(verifyNangoSignature(body, sign(body, "whk_1").toUpperCase(), ["whk_1"])).toBe(true);
    // During a rotation either key will do.
    expect(verifyNangoSignature(body, sign(body, "whk_2"), ["whk_1", "whk_2"])).toBe(true);
    expect(verifyNangoSignature(body, sign(body, "other"), ["whk_1"])).toBe(false);
    expect(verifyNangoSignature(`${body} `, sign(body, "whk_1"), ["whk_1"])).toBe(false);
    expect(verifyNangoSignature(body, undefined, ["whk_1"])).toBe(false);
    expect(verifyNangoSignature(body, "not-hex", ["whk_1"])).toBe(false);
    expect(verifyNangoSignature(body, sign(body, ""), [""])).toBe(false);
  });

  it("are read as auth events; any other type is not", () => {
    expect(parseNangoWebhook(JSON.parse(body))).toEqual({
      type: "auth",
      operation: "refresh",
      success: false,
      connectionId: "c-1",
      integrationKey: "bizinsights-meta-ads",
      environment: "prod",
      tags: {},
      errorType: "refresh_token_external_error",
    });
    expect(parseNangoWebhook({ type: "sync", connectionId: "c-1", providerConfigKey: "k" })).toBeNull();
    expect(parseNangoWebhook({ type: "auth", connectionId: "../x?y", providerConfigKey: "k" })).toBeNull();
    expect(parseNangoWebhook("auth")).toBeNull();
  });
});

describe("integration keys", () => {
  it("name each platform, and only bizinsights' own", () => {
    expect(nangoProviderOf("bizinsights-google-adsense")).toBe("adsense");
    expect(nangoProviderOf("bizinsights-meta-ads")).toBe("meta");
    expect(nangoProviderOf("someone-else")).toBeNull();
    expect(isNangoConnectionId("4f1c2b6e-9d1a-4b8e-8a3e-0c5d7f2e1a90")).toBe(true);
    expect(isNangoConnectionId("a/b")).toBe(false);
    expect(isNangoConnectionId("")).toBe(false);
  });
});
