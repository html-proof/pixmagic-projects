import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { pkceChallenge } from "@app/shared";
import {
  AD_SIGN_IN_TTL_S,
  AdLoginWaitingError,
  AdNoRefreshTokenError,
  AdPermissionMissingError,
  memoryCoord,
  readAdSignIn,
  resetEnvCache,
  startAdSignIn,
  takeAdSignInState,
  type AdSignInProgress,
  type FetchLike,
} from "../src/index.js";

/**
 * bizinsights' own sign-in with the ad platforms (adConnections/signIn.ts), without a database: the
 * single-use state and the consent screen's address, then the code coming back as tokens, the one
 * permission checked, who signed in, and the accounts listed. The API's tests take the whole round trip.
 */

const ENV = {
  SESSION_SECRET: "0123456789abcdef",
  TOKEN_ENCRYPTION_KEYS: "1:MDEyMzQ1Njc4OTAxMjM0NTY3ODkwMTIzNDU2Nzg5MDE=",
  OTP_PEPPER: "pepper-value",
  APP_URL: "https://app.example",
  META_APP_ID: "meta_app",
  META_APP_SECRET: "meta_secret",
  META_CONFIG_ID: "",
  GOOGLE_ADS_CLIENT_ID: "g_client",
  GOOGLE_ADS_CLIENT_SECRET: "g_secret",
  GOOGLE_ADS_ENABLED: "1",
};

beforeEach(() => {
  for (const [k, v] of Object.entries(ENV)) vi.stubEnv(k, v);
  resetEnvCache();
});
afterEach(() => {
  vi.unstubAllEnvs();
  resetEnvCache();
});

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const who = { userId: "u1", workspaceId: "w1", storeId: "s1" };
const NONCE = "n".repeat(32);
const progress = (): AdSignInProgress => ({ externalUserId: null, reusedRefreshToken: false });

/** Meta's token swap, permissions, /me and ad accounts. */
function meta(opts: { adsRead?: "granted" | "declined"; accounts?: Array<{ id: string; name: string }> } = {}): FetchLike {
  return async (input) => {
    const u = new URL(String(input));
    if (u.pathname.endsWith("/oauth/access_token")) {
      return u.searchParams.get("grant_type") === "fb_exchange_token" ? json({ access_token: "META_LONG", expires_in: 5_184_000 }) : json({ access_token: "META_SHORT", expires_in: 3600 });
    }
    if (u.pathname.endsWith("/me/permissions")) return json({ data: [{ permission: "ads_read", status: opts.adsRead ?? "granted" }] });
    if (u.pathname.endsWith("/me/adaccounts")) return json({ data: (opts.accounts ?? [{ id: "act_1", name: "Shop ads" }]).map((a) => ({ ...a, currency: "USD", timezone_name: "UTC", account_status: 1 })) });
    if (u.pathname.endsWith("/me")) return json(u.searchParams.get("fields") === "id,name" ? { id: "4242", name: "Pat Example" } : { id: "4242" });
    return json({ error: { message: `unexpected ${u.pathname}` } }, 400);
  };
}

describe("starting a sign-in", () => {
  it("Meta: the state waits in the coordinator under the nonce, which the consent screen sends back once", async () => {
    const coord = memoryCoord();
    const url = new URL((await startAdSignIn(coord, NONCE, { ...who, provider: "meta" }))!);
    expect(url.origin).toBe("https://www.facebook.com");
    expect(url.searchParams.get("state")).toBe(NONCE);
    expect(url.searchParams.get("redirect_uri")).toBe("https://app.example/api/ads/meta/callback");
    expect(url.searchParams.get("scope")).toBe("ads_read");
    expect(url.searchParams.get("auth_type")).toBe("rerequest");
    expect(await takeAdSignInState(coord, NONCE)).toEqual({ ...who, provider: "meta" });
    // Used up.
    expect(await takeAdSignInState(coord, NONCE)).toBeNull();
    expect(AD_SIGN_IN_TTL_S).toBe(600);
  });

  it("Google: PKCE, offline access, read-only reporting with openid; the verifier stays on the server", async () => {
    const coord = memoryCoord();
    for (const [provider, scope] of [
      ["google", "https://www.googleapis.com/auth/adwords openid"],
      ["adsense", "https://www.googleapis.com/auth/adsense.readonly openid"],
    ] as const) {
      const url = new URL((await startAdSignIn(coord, NONCE, { ...who, provider }, { consent: true }))!);
      expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
      expect(url.searchParams.get("scope")).toBe(scope);
      expect(url.searchParams.get("access_type")).toBe("offline");
      expect(url.searchParams.get("prompt")).toBe("select_account consent");
      expect(url.searchParams.get("redirect_uri")).toBe(`https://app.example/api/ads/${provider}/callback`);
      expect(url.searchParams.get("code_challenge_method")).toBe("S256");
      const state = (await takeAdSignInState(coord, NONCE))!;
      expect(state).toMatchObject({ ...who, provider });
      // The consent screen was shown: nothing says it was skipped.
      expect(state.consent).toBeUndefined();
      expect(pkceChallenge(state.codeVerifier!)).toBe(url.searchParams.get("code_challenge"));
      expect(url.toString()).not.toContain(state.codeVerifier!);
    }
  });

  it("a platform whose keys aren't set here starts nothing", async () => {
    vi.stubEnv("META_APP_SECRET", "");
    vi.stubEnv("GOOGLE_ADS_ENABLED", "");
    resetEnvCache();
    const coord = memoryCoord();
    expect(await startAdSignIn(coord, NONCE, { ...who, provider: "meta" })).toBeNull();
    expect(await startAdSignIn(coord, NONCE, { ...who, provider: "google" }, { consent: true })).toBeNull();
    expect(await takeAdSignInState(coord, NONCE)).toBeNull();
  });
});

describe("reading the sign-in that came back", () => {
  it("Meta: the code becomes the long-lived token, ads_read granted, who signed in, and the accounts", async () => {
    const p = progress();
    const accounts = await readAdSignIn({ ...who, provider: "meta" }, "CODE", p, { coord: memoryCoord(), fetchImpl: meta() });
    expect(accounts.map((a) => a.accountId)).toEqual(["act_1"]);
    expect(p.tokens).toMatchObject({ accessToken: "META_LONG", refreshToken: null, grantedScopes: ["ads_read"] });
    expect(p.tokens!.expiresAt!.getTime()).toBeGreaterThan(Date.now() + 59 * 86_400_000);
    expect(p.externalUserId).toBe("4242");
  });

  it("Meta: ads_read unticked is named, with the tokens kept so the grant can be given back", async () => {
    const p = progress();
    await expect(readAdSignIn({ ...who, provider: "meta" }, "CODE", p, { coord: memoryCoord(), fetchImpl: meta({ adsRead: "declined" }) })).rejects.toBeInstanceOf(AdPermissionMissingError);
    expect(p.tokens?.accessToken).toBe("META_LONG");
    expect(p.externalUserId).toBe("4242");
  });

  it("Meta: a login with no ad account yet is a login to keep, not a failure, saying who it is", async () => {
    const err = await readAdSignIn({ ...who, provider: "meta" }, "CODE", progress(), { coord: memoryCoord(), fetchImpl: meta({ accounts: [] }) }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AdLoginWaitingError);
    expect(err).toMatchObject({ reason: "no_ads_account", loginName: "Pat Example" });
  });

  it("Google: the code with the PKCE verifier; without a refresh token nothing would last past the hour", async () => {
    const forms: URLSearchParams[] = [];
    const google = (refresh: string | null): FetchLike => async (input, init) => {
      const u = new URL(String(input));
      if (u.host === "oauth2.googleapis.com" && u.pathname === "/token") {
        forms.push(new URLSearchParams(String(init?.body)));
        return json({ access_token: "G_ACCESS", expires_in: 3599, scope: "https://www.googleapis.com/auth/adsense.readonly openid", ...(refresh ? { refresh_token: refresh } : {}) });
      }
      if (u.host === "adsense.googleapis.com" && u.pathname === "/v2/accounts") return json({ accounts: [{ name: "accounts/pub-77", displayName: "Shop site", timeZone: { id: "UTC" }, state: "READY" }] });
      // Who signed in isn't said: the sign-in still goes on.
      return json({ error: "invalid_token" }, 400);
    };
    const p = progress();
    const accounts = await readAdSignIn({ ...who, provider: "adsense", codeVerifier: "VERIFIER" }, "4/code", p, { coord: memoryCoord(), fetchImpl: google("G_REFRESH") });
    expect(accounts.map((a) => a.accountId)).toEqual(["pub-77"]);
    expect(p.tokens).toMatchObject({ accessToken: "G_ACCESS", refreshToken: "G_REFRESH" });
    expect(p.externalUserId).toBeNull();
    expect(forms[0]!.get("code_verifier")).toBe("VERIFIER");
    expect(forms[0]!.get("redirect_uri")).toBe("https://app.example/api/ads/adsense/callback");
    expect(forms[0]!.get("grant_type")).toBe("authorization_code");

    // No refresh token, and none bizinsights could reuse (who signed in is unknown): asked with its consent screen already.
    await expect(readAdSignIn({ ...who, provider: "adsense", codeVerifier: "V2" }, "4/code", progress(), { coord: memoryCoord(), fetchImpl: google(null) })).rejects.toBeInstanceOf(AdNoRefreshTokenError);
  });
});
