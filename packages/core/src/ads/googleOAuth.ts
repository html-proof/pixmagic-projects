/**
 * Google's OAuth for both Google Ads and AdSense, which are authorized for the same Cloud OAuth client
 * ("Insights web") through Nango (docs/nango.md): who a token belongs to (and that it was issued to
 * bizinsights' client), taking a grant back, and renewing the tokens of a connection made before Nango
 * until it is moved there (adConnections/migrate.ts). The consent screen and the code exchange are
 * Nango's.
 */
import type { FetchLike } from "../shopify.js";
import { AdsApiError, AdsAuthError, AdsRateLimitedError, AdsRetryableError, tokenExpiry, type TokenSet } from "./common.js";

/** A Google Cloud OAuth client. Google Ads and AdSense both sign in through the same one. */
export interface GoogleOAuthClient {
  clientId: string;
  clientSecret: string;
  fetchImpl?: FetchLike;
}

/**
 * Asked for with every Google Ads and AdSense sign-in (the Nango integrations' scopes, nango-setup.mjs),
 * next to the reporting permission: only who the Google account is (its `sub`), nothing about it.
 * Without it Google's tokeninfo may not say whose a token is, and a disconnect then can't take the grant
 * back (it never revokes a grant whose person it doesn't know: Google ends the whole grant, which may be
 * someone else's connection too). Non-sensitive: no Google verification.
 */
export const GOOGLE_IDENTITY_SCOPE = "openid";

async function googleToken(c: GoogleOAuthClient, form: Record<string, string>): Promise<{ access_token: string; expires_in?: number; refresh_token?: string; scope?: string }> {
  const res = await (c.fetchImpl ?? fetch)("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: c.clientId, client_secret: c.clientSecret, ...form }).toString(),
  });
  const body = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; refresh_token?: string; scope?: string; error?: string; error_description?: string };
  if (res.ok && body.access_token) return body as { access_token: string; expires_in?: number; refresh_token?: string; scope?: string };
  const msg = body.error_description ?? body.error ?? `Google returned ${res.status}`;
  // RFC 6749 §5.2 error codes. invalid_grant: the refresh token (or code) expired or was revoked.
  if (body.error === "invalid_grant") throw new AdsAuthError(msg, "auth_expired");
  if (body.error === "invalid_scope") throw new AdsAuthError(msg, "scope_missing");
  // bizinsights' own OAuth client was refused (deleted, wrong secret, not allowed this grant): ours to
  // fix, and every connection would fail alike, so it never asks merchants to reconnect.
  if (body.error === "invalid_client" || body.error === "unauthorized_client") throw new AdsApiError(msg, res.status, undefined, "not_configured");
  if (res.status === 401) throw new AdsAuthError(msg);
  if (res.status === 429) throw new AdsRateLimitedError(msg);
  if (res.status >= 500) throw new AdsRetryableError(msg);
  throw new AdsApiError(msg, res.status);
}

/** Google lists what was granted, space-separated; with granular consent a scope can be left unticked. */
const scopesOf = (scope: string | undefined) => (scope ? scope.split(/\s+/).filter(Boolean) : undefined);

/**
 * A connection made before Nango (source "direct", until migrate.ts moves it): a fresh one-hour access
 * token from its stored refresh token. If Google hands back a new refresh token with it, that one
 * replaces the old (`rotated`), so the caller must store it.
 *
 * `requiredScope`: the permission the connection reads with. When Google lists the token's scopes
 * without it, the grant no longer covers reporting: AdsAuthError "scope_missing" (connect again with
 * it ticked), not a token that fails on every call.
 */
export async function googleRefresh(c: GoogleOAuthClient, refreshToken: string, opts: { requiredScope?: string } = {}): Promise<TokenSet & { rotated: boolean }> {
  const t = await googleToken(c, { refresh_token: refreshToken, grant_type: "refresh_token" });
  const grantedScopes = scopesOf(t.scope);
  if (opts.requiredScope && grantedScopes && !grantedScopes.includes(opts.requiredScope)) {
    throw new AdsAuthError(`Google's grant no longer includes ${opts.requiredScope}`, "scope_missing");
  }
  const next = t.refresh_token && t.refresh_token !== refreshToken ? t.refresh_token : refreshToken;
  return { accessToken: t.access_token, refreshToken: next, expiresAt: tokenExpiry(t.expires_in), grantedScopes, rotated: next !== refreshToken };
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
 *
 * A connection whose person is unknown holds back revoking anyone's grant on disconnect, so a
 * passing hiccup (no answer, a 5xx) is tried once more before giving up, and the id is read from
 * either name Google has used for it (`sub`, the older `user_id`). When tokeninfo doesn't name the
 * person but the token carries `openid` (GOOGLE_IDENTITY_SCOPE), Google's OpenID userinfo is asked.
 */
export async function googleUserId(c: GoogleOAuthClient, accessToken: string): Promise<string | null> {
  const url = `https://oauth2.googleapis.com/tokeninfo?${new URLSearchParams({ access_token: accessToken })}`;
  let res: Response | null = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    res = await (c.fetchImpl ?? fetch)(url, { method: "GET" }).catch(() => null);
    if (res && res.status < 500) break;
  }
  if (!res) throw new AdsRetryableError("Google's token information didn't answer");
  const body = (await res.json().catch(() => ({}))) as { sub?: unknown; user_id?: unknown; aud?: string; azp?: string; scope?: string; error?: string; error_description?: string };
  if (!res.ok) {
    if (res.status === 400 || res.status === 401) throw new AdsAuthError(body.error_description ?? "Google didn't recognise the access token");
    throw new AdsRetryableError(`Google returned ${res.status}`);
  }
  // aud is the client the token is for, azp the one that asked for it: for our own tokens both are ours.
  if (body.aud !== c.clientId && body.azp !== c.clientId) throw new AdsAuthError("The Google token was issued to another app");
  const id = (v: unknown) => (typeof v === "string" && /^\d{1,40}$/.test(v) ? v : null);
  const named = id(body.sub) ?? id(body.user_id);
  if (named || !scopesOf(body.scope)?.includes(GOOGLE_IDENTITY_SCOPE)) return named;
  // The token was issued to bizinsights (checked above) and may say who it is: Google's userinfo. Best effort.
  const info = await (c.fetchImpl ?? fetch)("https://openidconnect.googleapis.com/v1/userinfo", { method: "GET", headers: { authorization: `Bearer ${accessToken}` } }).catch(() => null);
  if (!info?.ok) return null;
  return id(((await info.json().catch(() => ({}))) as { sub?: unknown }).sub);
}
