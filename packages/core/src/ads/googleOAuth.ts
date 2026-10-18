/**
 * Google's OAuth for both Google Ads and AdSense, which sign in through the same Cloud OAuth
 * client: the consent screen (PKCE), code exchange, refresh, revoke and who the token belongs to.
 */
import type { FetchLike } from "../shopify.js";
import { AdsApiError, AdsAuthError, AdsRetryableError, tokenExpiry, type TokenSet } from "./common.js";

/** A Google Cloud OAuth client. Google Ads and AdSense both sign in through the same one. */
export interface GoogleOAuthClient {
  clientId: string;
  clientSecret: string;
  fetchImpl?: FetchLike;
}

/**
 * Google's consent screen. `codeChallenge` is the PKCE S256 challenge: its verifier stays on the
 * server and goes with the code exchange.
 */
export function googleConsentUrl(c: GoogleOAuthClient, scope: string, redirectUri: string, state: string, codeChallenge?: string): string {
  const q = new URLSearchParams({
    client_id: c.clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope,
    // A refresh token, every time: the access token lasts an hour and syncs run for months.
    access_type: "offline",
    // Google's account chooser, every time: otherwise a browser signed in to one Google account goes
    // straight through with it, and someone whose ads live under another login can never pick that one.
    prompt: "select_account consent",
    state,
  });
  if (codeChallenge) {
    q.set("code_challenge", codeChallenge);
    q.set("code_challenge_method", "S256");
  }
  return `https://accounts.google.com/o/oauth2/v2/auth?${q}`;
}

async function googleToken(c: GoogleOAuthClient, form: Record<string, string>): Promise<{ access_token: string; expires_in?: number; refresh_token?: string; scope?: string }> {
  const res = await (c.fetchImpl ?? fetch)("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: c.clientId, client_secret: c.clientSecret, ...form }).toString(),
  });
  const body = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; refresh_token?: string; scope?: string; error?: string; error_description?: string };
  if (res.ok && body.access_token) return body as { access_token: string; expires_in?: number; refresh_token?: string; scope?: string };
  const msg = body.error_description ?? body.error ?? `Google returned ${res.status}`;
  if (body.error === "invalid_grant" || res.status === 401) throw new AdsAuthError(msg);
  if (res.status === 429 || res.status >= 500) throw new AdsRetryableError(msg);
  throw new AdsApiError(msg, res.status);
}

export async function googleExchangeCode(c: GoogleOAuthClient, code: string, redirectUri: string, codeVerifier?: string): Promise<TokenSet> {
  const t = await googleToken(c, { code, redirect_uri: redirectUri, grant_type: "authorization_code", ...(codeVerifier ? { code_verifier: codeVerifier } : {}) });
  // Google lists what was granted, space-separated; with granular consent a scope can be left unticked.
  return { accessToken: t.access_token, refreshToken: t.refresh_token ?? null, expiresAt: tokenExpiry(t.expires_in), grantedScopes: t.scope ? t.scope.split(/\s+/).filter(Boolean) : undefined };
}

/**
 * A fresh one-hour access token from the stored refresh token. If Google hands back a new refresh
 * token with it, that one replaces the old (`rotated`), so the caller must store it.
 */
export async function googleRefresh(c: GoogleOAuthClient, refreshToken: string): Promise<TokenSet & { rotated: boolean }> {
  const t = await googleToken(c, { refresh_token: refreshToken, grant_type: "refresh_token" });
  const next = t.refresh_token && t.refresh_token !== refreshToken ? t.refresh_token : refreshToken;
  return { accessToken: t.access_token, refreshToken: next, expiresAt: tokenExpiry(t.expires_in), rotated: next !== refreshToken };
}

/**
 * Take back the access a person gave bizinsights' Google client. Google ends that person's whole grant
 * to the client (Google Ads and AdSense alike), so callers only do this when nothing else relies on it.
 * A token Google already considers dead counts as revoked.
 */
export async function googleRevoke(c: Pick<GoogleOAuthClient, "fetchImpl">, token: string): Promise<void> {
  const res = await (c.fetchImpl ?? fetch)("https://oauth2.googleapis.com/revoke", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ token }).toString(),
  });
  if (res.ok) return;
  const body = (await res.json().catch(() => ({}))) as { error?: string; error_description?: string };
  if (body.error === "invalid_token") return;
  const msg = body.error_description ?? body.error ?? `Google returned ${res.status}`;
  if (res.status === 429 || res.status >= 500) throw new AdsRetryableError(msg);
  throw new AdsApiError(msg, res.status);
}

/**
 * The Google account behind an access token (`sub`), checked to be a token issued to bizinsights'
 * own client. Null when Google doesn't say: the connection still works, it just can't share a grant.
 */
export async function googleUserId(c: GoogleOAuthClient, accessToken: string): Promise<string | null> {
  const res = await (c.fetchImpl ?? fetch)(`https://oauth2.googleapis.com/tokeninfo?${new URLSearchParams({ access_token: accessToken })}`, { method: "GET" });
  const body = (await res.json().catch(() => ({}))) as { sub?: string; aud?: string; azp?: string; error?: string; error_description?: string };
  if (!res.ok) {
    if (res.status === 400 || res.status === 401) throw new AdsAuthError(body.error_description ?? "Google didn't recognise the access token");
    throw new AdsRetryableError(`Google returned ${res.status}`);
  }
  if ((body.aud ?? body.azp) !== c.clientId) throw new AdsAuthError("The Google token was issued to another app");
  return body.sub && /^\d{1,40}$/.test(body.sub) ? body.sub : null;
}
