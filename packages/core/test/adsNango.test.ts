import { describe, expect, it } from "vitest";
import {
  AdsApiError,
  AdsAuthError,
  AdsRateLimitedError,
  AdsRetryableError,
  classifyAdError,
  isNangoConnectionId,
  NANGO_INTEGRATION,
  nangoConnectionCredentials,
  nangoDeleteConnection,
  type FetchLike,
} from "../src/index.js";

/**
 * What is left of the Nango client (packages/core/src/ads/nango.ts), kept only to move the connections
 * made through Nango off it (adConnections/leaveNango.ts): reading a connection's tokens once, and
 * deleting it at Nango. Answers shaped like Nango's documented ones
 * (https://nango.dev/docs/reference/backend/http-api).
 */

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

type Call = { url: URL; init?: RequestInit };
function fake(route: (call: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fetchImpl: FetchLike = async (input, init) => {
    const call = { url: new URL(String(input)), init };
    calls.push(call);
    return route(call);
  };
  return { fetchImpl, calls };
}

const KEY = "nango-secret-0123456789abcdef0123456789";
const cfg = (fetchImpl: FetchLike) => ({ secretKey: KEY, apiUrl: "https://api.nango.dev/", fetchImpl });

describe("a connection's tokens, read to move it off Nango", () => {
  it("asks for the refresh token too, for the platform's integration, the key in the header only", async () => {
    const f = fake(() =>
      json({
        connection_id: "c 1",
        credentials: { type: "OAUTH2", access_token: "ya29.token", refresh_token: "1//google-refresh", expires_at: "2026-10-28T11:00:00.000Z", raw: { scope: "openid" } },
      }),
    );
    const held = await nangoConnectionCredentials(cfg(f.fetchImpl), NANGO_INTEGRATION.adsense, "c 1");
    expect(held).toEqual({ accessToken: "ya29.token", refreshToken: "1//google-refresh", expiresAt: new Date("2026-10-28T11:00:00.000Z") });
    const [call] = f.calls;
    expect(call!.url.origin + call!.url.pathname).toBe("https://api.nango.dev/connections/c%201");
    expect(call!.init?.method).toBe("GET");
    // Nango leaves the refresh token out unless asked.
    expect(call!.url.searchParams.get("refresh_token")).toBe("true");
    expect(call!.url.searchParams.get("provider_config_key")).toBe("bizinsights-google-adsense");
    expect(new Headers(call!.init?.headers).get("authorization")).toBe(`Bearer ${KEY}`);
    expect(call!.url.toString()).not.toContain(KEY);
  });

  it("Meta's long-lived token has no refresh token; an expiry Nango doesn't give, or can't be read, is none", async () => {
    const meta = fake(() => json({ credentials: { type: "OAUTH2", access_token: "META_LONG" } }));
    expect(await nangoConnectionCredentials(cfg(meta.fetchImpl), NANGO_INTEGRATION.meta, "c-2")).toEqual({ accessToken: "META_LONG", refreshToken: null, expiresAt: null });
    const odd = fake(() => json({ credentials: { type: "OAUTH2", access_token: "AT", refresh_token: "", expires_at: "not a date" } }));
    expect(await nangoConnectionCredentials(cfg(odd.fetchImpl), NANGO_INTEGRATION.google, "c-3")).toEqual({ accessToken: "AT", refreshToken: null, expiresAt: null });
  });

  it("a connection Nango no longer has, a grant it can't renew, or one holding no OAuth token: nothing to move ('reconnect')", async () => {
    const gone = fake(() => json({ error: { code: "not_found", message: "Connection not found" } }, 404));
    const err = await nangoConnectionCredentials(cfg(gone.fetchImpl), "k", "c").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AdsAuthError);
    expect(classifyAdError(err)).toMatchObject({ status: "reconnect", code: "auth_expired" });
    const refused = fake(() => json({ error: { code: "invalid_credentials", message: "refresh failed" } }, 424));
    await expect(nangoConnectionCredentials(cfg(refused.fetchImpl), "k", "c")).rejects.toBeInstanceOf(AdsAuthError);
    const exhausted = fake(() => json({ error: { code: "refresh_exhausted", message: "The refresh limit has been reached" } }, 400));
    await expect(nangoConnectionCredentials(cfg(exhausted.fetchImpl), "k", "c")).rejects.toBeInstanceOf(AdsAuthError);
    const apiKey = fake(() => json({ credentials: { type: "API_KEY", apiKey: "x" } }));
    await expect(nangoConnectionCredentials(cfg(apiKey.fetchImpl), "k", "c")).rejects.toBeInstanceOf(AdsAuthError);
  });

  it("Nango down or busy is tried again later, never 'reconnect'; bizinsights' own key refused is ours to fix", async () => {
    const outage = await nangoConnectionCredentials(cfg(fake(() => json({ error: { code: "server_error" } }, 503)).fetchImpl), "k", "c").catch((e: unknown) => e);
    expect(outage).toBeInstanceOf(AdsRetryableError);
    expect(outage).not.toBeInstanceOf(AdsAuthError);
    const down: FetchLike = async () => {
      throw new TypeError("fetch failed");
    };
    await expect(nangoConnectionCredentials(cfg(down), "k", "c")).rejects.toBeInstanceOf(AdsRetryableError);
    // The platform's token endpoint failing behind Nango: retried too, unless the platform refused the grant.
    const platformDown = fake(() => json({ error: { code: "refresh_token_external_error", message: "The external API returned an error: 503" } }, 400));
    await expect(nangoConnectionCredentials(cfg(platformDown.fetchImpl), "k", "c")).rejects.toBeInstanceOf(AdsRetryableError);
    const slow = await nangoConnectionCredentials(cfg(fake(() => json({ error: { code: "too_many_requests" } }, 429)).fetchImpl), "k", "c").catch((e: unknown) => e);
    expect(slow).toBeInstanceOf(AdsRateLimitedError);
    const key = await nangoConnectionCredentials(cfg(fake(() => json({ error: { code: "unauthorized", message: "Invalid secret key" } }, 401)).fetchImpl), "k", "c").catch((e: unknown) => e);
    expect(key).toBeInstanceOf(AdsApiError);
    expect(key).not.toBeInstanceOf(AdsRetryableError);
    expect(classifyAdError(key).code).toBe("not_configured");
  });
});

describe("deleting a connection at Nango", () => {
  it("deletes it for its integration, and calls one already gone 'gone'", async () => {
    const f = fake((c) => (c.url.pathname === "/connections/c-1" ? json({ success: true }) : json({ error: { code: "not_found" } }, 404)));
    expect(await nangoDeleteConnection(cfg(f.fetchImpl), "bizinsights-meta-ads", "c-1")).toBe("deleted");
    expect(f.calls[0]!.init?.method).toBe("DELETE");
    expect(f.calls[0]!.url.searchParams.get("provider_config_key")).toBe("bizinsights-meta-ads");
    // Only the copy at Nango: never the refresh token asked for.
    expect(f.calls[0]!.url.searchParams.has("refresh_token")).toBe(false);
    expect(await nangoDeleteConnection(cfg(f.fetchImpl), "bizinsights-meta-ads", "c-2")).toBe("gone");
  });

  it("a failure other than 'not there' is thrown, so the move logs it", async () => {
    await expect(nangoDeleteConnection(cfg(fake(() => json({}, 500)).fetchImpl), "k", "c")).rejects.toBeInstanceOf(AdsRetryableError);
  });
});

describe("integration keys and connection ids", () => {
  it("name each platform's integration; a connection id is Nango's, never a path or a query", () => {
    expect(NANGO_INTEGRATION).toEqual({ meta: "bizinsights-meta-ads", google: "bizinsights-google-ads", adsense: "bizinsights-google-adsense" });
    expect(isNangoConnectionId("4f1c2b6e-9d1a-4b8e-8a3e-0c5d7f2e1a90")).toBe(true);
    expect(isNangoConnectionId("a/b")).toBe(false);
    expect(isNangoConnectionId("a?b=c")).toBe(false);
    expect(isNangoConnectionId("")).toBe(false);
    expect(isNangoConnectionId(42)).toBe(false);
  });
});
